<?php

namespace App\Http\Middleware;

use App\Auth\JwtService;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use OpenTelemetry\API\Baggage\Baggage;
use OpenTelemetry\API\Trace\Span;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * Attaches per-request context to the server span, every log record (Log::withContext)
 * and OTel baggage (propagated to downstream services via the W3C "baggage" header).
 * The user comes from a valid JWT `sub` first, then X-User-Id, then upstream baggage.
 * Writes one "request completed" log record per request (same fields in every service).
 */
class TelemetryContext
{
    public function __construct(private JwtService $jwt) {}

    public function handle(Request $request, Closure $next): Response
    {
        $requestId = $request->header('X-Request-Id') ?: (string) Str::uuid();
        $userId = $this->userFromJwt($request)
            ?? ($request->header('X-User-Id') ?: (Baggage::getCurrent()->getValue('user.id') ?? 'anonymous'));

        $span = Span::getCurrent(); // server span created by the Laravel auto-instrumentation
        $span->setAttribute('request.id', $requestId);
        $span->setAttribute('user.id', $userId);
        $span->setAttribute('client.address', $request->ip());

        // log.logger names the logger (the OTel scope is the Laravel instrumentation's name)
        Log::withContext(['log.logger' => 'app.laravel-otel', 'request.id' => $requestId, 'user.id' => $userId]);

        $scope = Baggage::getCurrent()->toBuilder()
            ->set('request.id', $requestId)
            ->set('user.id', $userId)
            ->build()
            ->activate();

        try {
            $response = $next($request);
            $this->logRequestCompleted($request, $response);
        } finally {
            $scope->detach();
        }

        $response->headers->set('X-Request-Id', $requestId);
        $response->headers->set('X-Trace-Id', $span->getContext()->getTraceId());

        return $response;
    }

    /** request.id / user.id come from Log::withContext. */
    private function logRequestCompleted(Request $request, Response $response): void
    {
        $status = $response->getStatusCode();
        $claims = $this->claims($request);
        $path = '/'.ltrim($request->path(), '/');
        $route = $request->route()?->uri();
        Log::log($status >= 500 ? 'error' : ($status >= 400 ? 'warning' : 'info'), 'request completed', array_filter([
            'http.request.method' => $request->method(),
            'http.route' => $route === null ? $path : '/'.ltrim($route, '/'),
            'url.path' => $path,
            'http.response.status_code' => $status,
            'client.address' => $request->ip(),
            'user.name' => $claims['name'] ?? null,
            // OAuth2 JWT access token (RFC 9068: client_id, scope/scp): its subject
            'user.sub' => isset($claims['client_id']) || isset($claims['scope']) || isset($claims['scp']) ? (string) $claims['sub'] : null,
            'http.request.body' => self::jsonBody($request->header('Content-Type'), $request->getContent()),
            'http.response.body' => self::jsonBody($response->headers->get('Content-Type'), $response->getContent()),
        ], fn ($v) => $v !== null && $v !== ''));
    }

    /** JSON bodies up to 4 KB; secrets are masked by the collector. */
    private static function jsonBody(?string $contentType, string|false $body): ?string
    {
        return $contentType !== null && str_contains($contentType, 'json') && is_string($body) && $body !== '' && strlen($body) <= 4096
            ? $body : null;
    }

    private function claims(Request $request): array
    {
        try {
            return ($token = $request->bearerToken()) ? $this->jwt->decode($token) : [];
        } catch (Throwable) {
            return [];
        }
    }

    private function userFromJwt(Request $request): ?string
    {
        if (! $token = $request->bearerToken()) {
            return null;
        }
        try {
            return (string) $this->jwt->decode($token)['sub'];
        } catch (Throwable) {
            return null; // RequireJwt rejects it where auth is required
        }
    }
}
