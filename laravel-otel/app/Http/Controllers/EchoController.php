<?php

namespace App\Http\Controllers;

use App\Telemetry\Telemetry;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use OpenTelemetry\API\Trace\Span;
use OpenTelemetry\API\Trace\StatusCode;
use RuntimeException;

class EchoController extends Controller
{
    /** Port of the Go/Spring /echo: fails ~10% of the time. */
    public function echo(Request $request): JsonResponse
    {
        $message = (string) $request->query('message', '');
        $span = Span::getCurrent();
        $span->setAttribute('echo.message', $message);
        $span->setAttribute('echo.message_length', strlen($message));

        if (random_int(0, 99) > 90) {
            $error = new RuntimeException("random failure while echoing '{$message}'");
            $span->recordException($error); // span event "exception" with type, message, stacktrace
            $span->setStatus(StatusCode::STATUS_ERROR, $error->getMessage());
            Telemetry::echoRequests()->add(1, ['outcome' => 'error', 'error.type' => 'RuntimeException']);
            Log::error('echo failed', ['echo.message' => $message, 'http.response.status_code' => 500]);

            return response()->json(['error' => 'internal error'], 500);
        }

        $result = $this->process($message);
        Telemetry::echoRequests()->add(1, ['outcome' => 'ok']);
        Telemetry::messageLength()->record(strlen($message));
        Log::info('echo ok', ['echo.message' => $message, 'http.response.status_code' => 200]);

        return response()->json(['message' => $result]);
    }

    /** DB + cache spans come from auto-instrumentation. */
    public function order(int $id): JsonResponse
    {
        $order = Cache::remember("order:{$id}", 30, fn () => DB::selectOne(
            'select ? as id, ? as total, ? as status',
            [$id, random_int(10, 500), 'paid'],
        ));
        Log::info('order loaded', ['order.id' => $id]);

        return response()->json($order);
    }

    /** Calls the Spring app: one distributed trace across both services (traceparent + baggage headers). */
    public function chain(Request $request): JsonResponse
    {
        $message = (string) $request->query('message', 'from-laravel');
        $downstream = rtrim(env('DOWNSTREAM_URL', 'http://host.docker.internal:4242'), '/');

        // traceparent, baggage, X-Request-Id and X-User-Id are added by the global
        // HTTP middleware in AppServiceProvider
        $response = Http::timeout(5)->get("{$downstream}/echo", ['message' => $message]);

        Log::info('downstream call finished', [
            'downstream.url' => $downstream,
            'downstream.status' => $response->status(),
        ]);

        return response()->json([
            'downstream_status' => $response->status(),
            'downstream_body' => $response->body(),
        ], $response->successful() ? 200 : 502);
    }

    private function process(string $message): string
    {
        $span = Telemetry::tracer()->spanBuilder('echo.process')->startSpan();
        $scope = $span->activate();
        try {
            $delay = random_int(5, 50);
            $span->addEvent('work.started', ['work.planned_ms' => $delay]);
            usleep($delay * 1000); // simulated work, visible as span duration
            $span->addEvent('work.finished');
            $span->setAttribute('work.duration_ms', $delay);
            Log::debug('processed message', ['work.duration_ms' => $delay]);

            return $message;
        } finally {
            $scope->detach();
            $span->end();
        }
    }
}
