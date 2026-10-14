using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using OpenTelemetry;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

// Endpoint/protocol come from OTEL_EXPORTER_OTLP_* env vars (see appsettings / launch command);
// default: http://localhost:4318 (LGTM) over http/protobuf.
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r
        .AddService(serviceName: "dotnet-otel-api", serviceVersion: "1.0.0")
        .AddAttributes(new Dictionary<string, object>
        {
            // DEPLOYMENT_ENVIRONMENT, not the ASP.NET environment: that defaults to "Production" when unset
            ["deployment.environment.name"] = builder.Configuration["DEPLOYMENT_ENVIRONMENT"] ?? "local",
            ["service.namespace"] = "demo",
            ["team"] = "observability",
        }))
    .WithTracing(t => t
        .AddSource(Telemetry.Source.Name)
        .AddAspNetCoreInstrumentation(o => o.RecordException = true)
        .AddHttpClientInstrumentation()
        .AddOtlpExporter())
    .WithMetrics(m => m
        .AddMeter(Telemetry.Meter.Name)
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddOtlpExporter())
    .WithLogging(l => l.AddOtlpExporter(), o =>
    {
        o.IncludeScopes = true;            // BeginScope values (request.id, user.id) -> log attributes
        o.IncludeFormattedMessage = true;
    });

// Validates the HS256 tokens issued by the Laravel app (shared secret, issuer, audience, expiry).
var jwtSecret = builder.Configuration["JWT_SECRET"] ?? "dev-only-shared-secret-change-me-0123456789abcdef";
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.MapInboundClaims = false; // keep "sub" as "sub"
        o.TokenValidationParameters = new TokenValidationParameters
        {
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret)),
            ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
            ValidIssuer = "laravel-otel",
            ValidAudience = "otel-demo",
            ClockSkew = TimeSpan.FromSeconds(30),
        };
        o.Events = new JwtBearerEvents
        {
            OnAuthenticationFailed = c =>
            {
                Activity.Current?.AddEvent(new ActivityEvent("auth.failed",
                    tags: new() { ["auth.error"] = c.Exception.GetType().Name }));
                return Task.CompletedTask;
            },
            OnChallenge = async c =>
            {
                c.HandleResponse();
                c.Response.StatusCode = 401;
                await c.Response.WriteAsJsonAsync(new { error = "unauthorized", reason = c.ErrorDescription ?? c.Error ?? "missing token" });
            },
        };
    });
builder.Services.AddAuthorization();

builder.Services.AddTransient<ContextForwardingHandler>();
builder.Services.AddHttpClient("cascade", c => c.Timeout = TimeSpan.FromSeconds(15));
builder.Services.AddHttpClient("downstream", c =>
    {
        c.BaseAddress = new Uri(builder.Configuration["DOWNSTREAM_URL"] ?? "http://localhost:8000");
        c.Timeout = TimeSpan.FromSeconds(5);
    })
    .AddHttpMessageHandler<ContextForwardingHandler>();

var app = builder.Build();
app.UseAuthentication(); // before the context middleware, so it can take the user from the JWT
app.UseMiddleware<TelemetryContextMiddleware>();
app.UseAuthorization();

app.MapPost("/api/cascade", Cascade.Handle).RequireAuthorization();

/// Port of the Go/Spring/Laravel /echo: fails ~10% of the time.
app.MapGet("/api/echo", async (string? message, ILogger<Program> log) =>
{
    message ??= "";
    var span = Activity.Current; // server span from the ASP.NET Core instrumentation
    span?.SetTag("echo.message", message);
    span?.SetTag("echo.message_length", message.Length);

    if (Random.Shared.Next(100) > 90)
    {
        var error = new InvalidOperationException($"random failure while echoing '{message}'");
        span?.AddException(error); // span event "exception" with type, message, stacktrace
        span?.SetStatus(ActivityStatusCode.Error, error.Message);
        Telemetry.EchoRequests.Add(1, new("outcome", "error"), new("error.type", error.GetType().Name));
        log.LogError(error, "echo failed {echo.message} {http.response.status_code}", message, 500);
        return Results.Json(new { error = "internal error" }, statusCode: 500);
    }

    var result = await Process(message, log);
    Telemetry.EchoRequests.Add(1, new KeyValuePair<string, object?>("outcome", "ok"));
    Telemetry.MessageLength.Record(message.Length);
    log.LogInformation("echo ok {echo.message} {http.response.status_code}", message, 200);
    return Results.Ok(new { message = result });
});

/// .NET -> Laravel (/api/chain) -> Spring (/echo): one trace across three services.
app.MapGet("/api/chain", async (string? message, IHttpClientFactory http, ILogger<Program> log) =>
{
    var client = http.CreateClient("downstream");
    var response = await client.GetAsync($"/api/chain?message={Uri.EscapeDataString(message ?? "from-dotnet")}");
    var body = await response.Content.ReadAsStringAsync();
    log.LogInformation("downstream call finished {downstream.status}", (int)response.StatusCode);
    return Results.Json(new { downstream_status = (int)response.StatusCode, downstream_body = body },
        statusCode: response.IsSuccessStatusCode ? 200 : 502);
});

app.Run();

static async Task<string> Process(string message, ILogger log)
{
    using var span = Telemetry.Source.StartActivity("echo.process"); // child of the server span
    var delay = Random.Shared.Next(5, 50);
    span?.AddEvent(new ActivityEvent("work.started", tags: new() { ["work.planned_ms"] = delay }));
    await Task.Delay(delay); // simulated work, visible as span duration
    span?.AddEvent(new ActivityEvent("work.finished"));
    span?.SetTag("work.duration_ms", delay);
    log.LogDebug("processed message {work.duration_ms}", delay);
    return message;
}

static class Telemetry
{
    public static readonly ActivitySource Source = new("app.dotnet-otel");
    public static readonly Meter Meter = new("app.dotnet-otel");
    public static readonly Counter<long> EchoRequests =
        Meter.CreateCounter<long>("echo.requests", "{request}", "Echo requests by outcome");
    public static readonly Histogram<int> MessageLength =
        Meter.CreateHistogram<int>("echo.message.length", "{char}", "Length of echoed messages");
}

/// Attaches per-request context to the server span, every log record (logger scope)
/// and OTel baggage (propagated downstream via the W3C "baggage" header by HttpClient), and writes one
/// "request completed" log record per request (same fields in every service).
class TelemetryContextMiddleware(RequestDelegate next, ILogger<TelemetryContextMiddleware> log)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        // user: valid JWT sub first, then X-User-Id, then baggage from an upstream service
        var requestId = Header(ctx, "X-Request-Id") ?? Baggage.GetBaggage("request.id") ?? Guid.NewGuid().ToString();
        var userId = ctx.User.FindFirst("sub")?.Value ?? Header(ctx, "X-User-Id") ?? Baggage.GetBaggage("user.id") ?? "anonymous";

        var span = Activity.Current;
        span?.SetTag("request.id", requestId);
        span?.SetTag("user.id", userId);
        span?.SetTag("client.address", ctx.Connection.RemoteIpAddress?.ToString());

        Baggage.SetBaggage("request.id", requestId);
        Baggage.SetBaggage("user.id", userId);

        ctx.Response.OnStarting(() =>
        {
            ctx.Response.Headers["X-Request-Id"] = requestId;
            ctx.Response.Headers["X-Trace-Id"] = span?.TraceId.ToString();
            return Task.CompletedTask;
        });

        using (log.BeginScope(new Dictionary<string, object> { ["request.id"] = requestId, ["user.id"] = userId }))
        {
            var status = 500; // an exception escaping the pipeline becomes a 500
            // bodies are buffered for the request log (JSON only, see JsonBody)
            ctx.Request.EnableBuffering();
            var originalBody = ctx.Response.Body;
            using var responseBuffer = new MemoryStream();
            ctx.Response.Body = responseBuffer;
            try
            {
                await next(ctx);
                status = ctx.Response.StatusCode;
            }
            finally
            {
                var requestBody = await ReadRequestBody(ctx.Request);
                var responseBody = JsonBody(ctx.Response.ContentType, responseBuffer.ToArray());
                responseBuffer.Position = 0;
                await responseBuffer.CopyToAsync(originalBody);
                ctx.Response.Body = originalBody;
                LogRequestCompleted(ctx, status, requestBody, responseBody);
            }
        }
    }

    // fields as a scope (-> log attributes), so the body stays "request completed" like in every service
    const int MaxBody = 4096;

    /// JSON bodies up to MaxBody bytes; secrets are masked by the collector.
    static string? JsonBody(string? contentType, byte[] body) =>
        contentType?.Contains("json") == true && body.Length is > 0 and <= MaxBody ? Encoding.UTF8.GetString(body) : null;

    static async Task<string?> ReadRequestBody(HttpRequest request)
    {
        if (request.ContentLength is null or 0 or > MaxBody) return null;
        request.Body.Position = 0;
        using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(buffer);
        return JsonBody(request.ContentType, buffer.ToArray());
    }

    void LogRequestCompleted(HttpContext ctx, int status, string? requestBody, string? responseBody)
    {
        var path = ctx.Request.Path.Value ?? "/";
        var fields = new Dictionary<string, object>
        {
            ["http.request.method"] = ctx.Request.Method,
            ["http.route"] = (ctx.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? path,
            ["url.path"] = path,
            ["http.response.status_code"] = status,
            ["client.address"] = ctx.Connection.RemoteIpAddress?.ToString() ?? "",
        };
        void Add(string key, string? value) { if (!string.IsNullOrEmpty(value)) fields[key] = value; }
        Add("user.name", ctx.User.FindFirst("name")?.Value);
        // OAuth2 JWT access token (RFC 9068: client_id, scope/scp): its subject
        if (ctx.User.HasClaim(c => c.Type is "client_id" or "scope" or "scp")) Add("user.sub", ctx.User.FindFirst("sub")?.Value);
        Add("http.request.body", requestBody);
        Add("http.response.body", responseBody);
        var level = status >= 500 ? LogLevel.Error : status >= 400 ? LogLevel.Warning : LogLevel.Information;
        using (log.BeginScope(fields))
        {
            log.Log(level, "request completed");
        }
    }

    static string? Header(HttpContext ctx, string name) =>
        ctx.Request.Headers.TryGetValue(name, out var v) && !string.IsNullOrEmpty(v) ? v.ToString() : null;
}

/// traceparent + baggage are injected by the HttpClient instrumentation; this adds the plain
/// X-Request-Id / X-User-Id headers for services that read context from them (Spring, Laravel).
class ContextForwardingHandler : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        foreach (var (header, key) in new[] { ("X-Request-Id", "request.id"), ("X-User-Id", "user.id") })
        {
            if (Baggage.GetBaggage(key) is { } value && !request.Headers.Contains(header))
                request.Headers.Add(header, value);
        }
        return base.SendAsync(request, ct);
    }
}
