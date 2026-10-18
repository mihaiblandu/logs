<?php

namespace App\Http\Controllers;

use App\Cascade\CascadePlan;
use App\Jobs\RunTodoCascade;
use App\Models\Todo;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use OpenTelemetry\API\Baggage\Baggage;
use OpenTelemetry\API\Trace\Span;

class TodoController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        return response()->json($request->user()->todos()->latest('id')->get()->map($this->present(...)));
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'title' => 'required|string|max:200',
            'scenario' => 'sometimes|in:'.implode(',', CascadePlan::SCENARIOS),
        ]);
        $todo = $request->user()->todos()->create($data + ['scenario' => 'all-ok']);
        $this->dispatchCascade($todo);
        Log::info('todo created', ['todo.id' => $todo->id, 'todo.scenario' => $todo->scenario]);

        return response()->json($this->present($todo->refresh()), 201);
    }

    public function show(Request $request, Todo $todo): JsonResponse
    {
        $this->authorizeOwner($request, $todo);

        return response()->json($this->present($todo));
    }

    public function update(Request $request, Todo $todo): JsonResponse
    {
        $this->authorizeOwner($request, $todo);
        $todo->update($request->validate(['title' => 'sometimes|string|max:200', 'done' => 'sometimes|boolean']));
        Log::info('todo updated', ['todo.id' => $todo->id, 'todo.done' => $todo->done]);

        return response()->json($this->present($todo));
    }

    public function destroy(Request $request, Todo $todo): JsonResponse
    {
        $this->authorizeOwner($request, $todo);
        $todo->delete();
        Log::info('todo deleted', ['todo.id' => $todo->id]);

        return response()->json(null, 204);
    }

    /** Re-run the cascade, optionally with another scenario. */
    public function run(Request $request, Todo $todo): JsonResponse
    {
        $this->authorizeOwner($request, $todo);
        $data = $request->validate(['scenario' => 'sometimes|in:'.implode(',', CascadePlan::SCENARIOS)]);
        $todo->update($data + ['cascade_status' => 'queued', 'cascade' => null]);
        $this->dispatchCascade($todo);

        return response()->json($this->present($todo->refresh()), 202);
    }

    /** The planned tree (no results yet), so the UI can draw the graph before the job finishes. */
    public function plan(Request $request): JsonResponse
    {
        $scenario = $request->validate(['scenario' => 'sometimes|in:'.implode(',', CascadePlan::SCENARIOS)])['scenario'] ?? 'all-ok';
        $strip = function (array $node) use (&$strip) {
            return ['id' => $node['id'], 'service' => $node['service'], 'fail' => $node['fail'],
                'children' => array_map($strip, $node['children'])];
        };

        return response()->json([
            'scenarios' => CascadePlan::SCENARIOS,
            'descriptions' => CascadePlan::DESCRIPTIONS,
            'plan' => $strip(CascadePlan::build($scenario, preview: true)),
        ]);
    }

    private function dispatchCascade(Todo $todo): void
    {
        $span = Span::getCurrent();
        $span->setAttribute('todo.id', $todo->id);
        $span->addEvent('cascade.dispatched', ['todo.scenario' => $todo->scenario]);
        RunTodoCascade::dispatch($todo->id, Baggage::getCurrent()->getValue('request.id') ?? '');
    }

    private function authorizeOwner(Request $request, Todo $todo): void
    {
        abort_unless($todo->user_id === $request->user()->id, 404);
    }

    private function present(Todo $todo): array
    {
        $jaeger = rtrim(config('demo.jaeger_url'), '/');

        return $todo->only('id', 'title', 'done', 'scenario', 'cascade_status', 'trace_id', 'cascade', 'created_at') + [
            // Jaeger shows span events too (Elasticsearch stores the spans without them)
            'trace_url' => $todo->trace_id ? "{$jaeger}/trace/{$todo->trace_id}" : null,
        ];
    }
}
