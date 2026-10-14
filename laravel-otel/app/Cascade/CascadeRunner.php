<?php

namespace App\Cascade;

use App\Telemetry\Telemetry;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use OpenTelemetry\API\Trace\SpanKind;
use OpenTelemetry\API\Trace\StatusCode;
use Throwable;

/**
 * Runs one cascade node: a "cascade <id>" span with simulated work, then POSTs each child spec to
 * <child url>/api/cascade with the caller's JWT. traceparent/baggage come from the global HTTP
 * middleware (AppServiceProvider). Same contract as the other services' /api/cascade.
 */
class CascadeRunner
{
    /** @param array<string, mixed> $spec @return array<string, mixed> node result */
    public function run(array $spec, string $token, string $userId): array
    {
        $span = Telemetry::tracer()->spanBuilder("cascade {$spec['id']}")
            ->setSpanKind(SpanKind::KIND_INTERNAL)
            ->setAttribute('cascade.node', $spec['id'])
            ->setAttribute('cascade.service', 'laravel')
            ->setAttribute('user.id', $userId)
            ->startSpan();
        $scope = $span->activate();
        $started = microtime(true);

        try {
            usleep(((int) $spec['work_ms']) * 1000); // simulated work
            $error = null;
            if ($spec['fail']) {
                $error = "injected failure at {$spec['id']}";
                $span->recordException(new \RuntimeException($error));
                $span->setStatus(StatusCode::STATUS_ERROR, $error);
                Log::error('cascade step failed', ['cascade.node' => $spec['id']]);
            }

            $children = $error ? [] : array_map(fn ($child) => $this->callChild($child, $token), $spec['children']);
            if (! $error) {
                Log::info('cascade step ok', ['cascade.node' => $spec['id'], 'cascade.children' => count($children)]);
            }

            return [
                'id' => $spec['id'],
                'service' => 'laravel',
                'status' => $error ? 'error' : 'ok',
                'error' => $error,
                'user_id' => $userId,
                'trace_id' => $span->getContext()->getTraceId(),
                'span_id' => $span->getContext()->getSpanId(),
                'duration_ms' => (int) round((microtime(true) - $started) * 1000),
                'children' => $children,
            ];
        } finally {
            $scope->detach();
            $span->end();
        }
    }

    /** @param array<string, mixed> $child @return array<string, mixed> */
    private function callChild(array $child, string $token): array
    {
        $started = microtime(true);
        try {
            $response = Http::withToken($token)->acceptJson()->timeout(15)
                ->post(rtrim($child['url'], '/').'/api/cascade', $child);
            if (is_array($json = $response->json()) && isset($json['id'])) {
                return $json; // ok, or the child's own error result
            }

            return self::failed($child, "HTTP {$response->status()}", $started);
        } catch (Throwable $e) {
            Log::error('cascade child unreachable', ['cascade.node' => $child['id'], 'error' => $e->getMessage()]);

            return self::failed($child, $e->getMessage(), $started);
        }
    }

    /** Result for a child that never answered with a cascade result (down, 401, timeout). */
    public static function failed(array $child, string $error, float $started): array
    {
        return [
            'id' => $child['id'],
            'service' => $child['service'],
            'status' => 'error',
            'error' => $error,
            'duration_ms' => (int) round((microtime(true) - $started) * 1000),
            'children' => [],
        ];
    }

    /** True when any node in the tree failed. */
    public static function hasError(array $result): bool
    {
        if (($result['status'] ?? 'error') !== 'ok') {
            return true;
        }
        foreach ($result['children'] ?? [] as $child) {
            if (self::hasError($child)) {
                return true;
            }
        }

        return false;
    }
}
