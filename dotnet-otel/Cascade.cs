using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

/// POST /api/cascade: same contract in every demo service. Runs a "cascade <id>" span with simulated
/// work, then calls each child's /api/cascade (in parallel) with the caller's JWT; traceparent +
/// baggage are injected by the HttpClient instrumentation.
static class Cascade
{
    const string Service = "dotnet";

    public static async Task<IResult> Handle(HttpContext ctx, JsonObject spec, IHttpClientFactory http, ILogger<CascadeLog> log)
    {
        var id = spec["id"]?.GetValue<string>() ?? "?";
        var userId = ctx.User.FindFirst("sub")?.Value ?? "anonymous";
        var token = ctx.Request.Headers.Authorization.ToString();

        using var span = Telemetry.Source.StartActivity($"cascade {id}");
        span?.SetTag("cascade.node", id);
        span?.SetTag("cascade.service", Service);
        span?.SetTag("user.id", userId);
        var started = Stopwatch.StartNew();

        await Task.Delay(spec["work_ms"]?.GetValue<int>() ?? 0); // simulated work
        string? error = null;
        var children = new JsonArray();
        if (spec["fail"]?.GetValue<bool>() == true)
        {
            error = $"injected failure at {id}";
            span?.AddException(new InvalidOperationException(error));
            span?.SetStatus(ActivityStatusCode.Error, error);
            log.LogError("cascade step failed {cascade.node}", id);
        }
        else
        {
            var client = http.CreateClient("cascade");
            var specs = spec["children"]?.AsArray().Select(c => c!.AsObject()) ?? [];
            foreach (var child in await Task.WhenAll(specs.Select(c => CallChild(client, c, token, log))))
                children.Add(child);
            log.LogInformation("cascade step ok {cascade.node} {cascade.children}", id, children.Count);
        }

        var result = new JsonObject
        {
            ["id"] = id,
            ["service"] = Service,
            ["status"] = error is null ? "ok" : "error",
            ["error"] = error,
            ["user_id"] = userId,
            ["trace_id"] = span?.TraceId.ToString(),
            ["span_id"] = span?.SpanId.ToString(),
            ["duration_ms"] = started.ElapsedMilliseconds,
            ["children"] = children,
        };
        return Results.Json(result, statusCode: error is null ? 200 : 500);
    }

    static async Task<JsonNode> CallChild(HttpClient client, JsonObject child, string token, ILogger log)
    {
        var started = Stopwatch.StartNew();
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{child["url"]!.GetValue<string>().TrimEnd('/')}/api/cascade")
            {
                Content = JsonContent.Create(child.DeepClone()),
            };
            request.Headers.TryAddWithoutValidation("Authorization", token);
            using var response = await client.SendAsync(request);
            JsonNode? body = null;
            try { body = await response.Content.ReadFromJsonAsync<JsonNode>(); } catch { /* not JSON */ }
            if (body?["id"] is not null) return body; // ok, or the child's own error result
            return Failed(child, $"HTTP {(int)response.StatusCode}", started);
        }
        catch (Exception e)
        {
            log.LogError(e, "cascade child unreachable {cascade.node}", child["id"]?.GetValue<string>());
            return Failed(child, e.Message, started);
        }
    }

    static JsonObject Failed(JsonObject child, string error, Stopwatch started) => new()
    {
        ["id"] = child["id"]?.DeepClone(),
        ["service"] = child["service"]?.DeepClone(),
        ["status"] = "error",
        ["error"] = error,
        ["duration_ms"] = started.ElapsedMilliseconds,
        ["children"] = new JsonArray(),
    };
}

/// Logger category for the cascade endpoint.
class CascadeLog;
