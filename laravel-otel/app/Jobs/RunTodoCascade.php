<?php

namespace App\Jobs;

use App\Auth\JwtService;
use App\Cascade\CascadePlan;
use App\Cascade\CascadeRunner;
use App\Models\Todo;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use OpenTelemetry\API\Baggage\Baggage;
use OpenTelemetry\API\Trace\Span;

/**
 * Started when a todo is created (or re-run): runs the cascade through all services as the todo's
 * owner. The queue instrumentation links this job to the HTTP request that dispatched it.
 */
class RunTodoCascade implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(public int $todoId, public string $requestId) {}

    public function handle(JwtService $jwt, CascadeRunner $runner): void
    {
        $todo = Todo::with('user')->findOrFail($this->todoId);
        $userId = (string) $todo->user_id;

        // the job runs in a worker process: re-establish the request context there
        $span = Span::getCurrent();
        $span->setAttribute('todo.id', $todo->id);
        $span->setAttribute('user.id', $userId);
        $span->setAttribute('request.id', $this->requestId);
        Log::withContext(['log.logger' => 'app.laravel-otel.cascade', 'request.id' => $this->requestId, 'user.id' => $userId, 'todo.id' => $todo->id]);
        $scope = Baggage::getCurrent()->toBuilder()
            ->set('request.id', $this->requestId)
            ->set('user.id', $userId)
            ->build()
            ->activate();

        try {
            $todo->update(['cascade_status' => 'running', 'trace_id' => $span->getContext()->getTraceId(), 'cascade' => null]);
            Log::info('cascade started', ['todo.scenario' => $todo->scenario]);

            // a fresh short-lived token for the todo's owner: the user's own token isn't kept
            $result = $runner->run(CascadePlan::build($todo->scenario), $jwt->issue($todo->user), $userId);
            $status = CascadeRunner::hasError($result) ? 'error' : 'ok';

            $todo->update(['cascade_status' => $status, 'trace_id' => $result['trace_id'], 'cascade' => $result]);
            Log::log($status === 'ok' ? 'info' : 'warning', 'cascade finished', ['cascade.status' => $status]);
        } finally {
            $scope->detach();
        }
    }
}
