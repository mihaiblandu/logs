<?php

namespace Tests\Feature;

use App\Auth\JwtService;
use App\Cascade\CascadePlan;
use App\Jobs\RunTodoCascade;
use App\Models\Todo;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

class TodoCascadeTest extends TestCase
{
    use RefreshDatabase;

    public function test_creating_a_todo_dispatches_the_cascade_job(): void
    {
        Queue::fake();
        $user = User::factory()->create();

        $this->withToken(app(JwtService::class)->issue($user))
            ->postJson('/api/todos', ['title' => 'buy milk'])
            ->assertCreated()
            ->assertJsonPath('cascade_status', 'queued')
            ->assertJsonPath('scenario', 'all-ok');

        Queue::assertPushed(RunTodoCascade::class, fn ($job) => $job->todoId === Todo::first()->id);
    }

    public function test_users_only_see_their_own_todos(): void
    {
        Queue::fake();
        [$alice, $bob] = User::factory()->count(2)->create();
        $todo = $alice->todos()->create(['title' => 'private']);

        $this->withToken(app(JwtService::class)->issue($bob))->getJson("/api/todos/{$todo->id}")->assertNotFound();
        $this->withToken(app(JwtService::class)->issue($bob))->getJson('/api/todos')->assertExactJson([]);
    }

    public function test_plan_reaches_every_service(): void
    {
        $services = [];
        $walk = function (array $node) use (&$walk, &$services) {
            $services[] = $node['service'];
            array_map($walk, $node['children']);
        };
        $walk(CascadePlan::build('all-ok'));

        $this->assertEqualsCanonicalizing(['laravel', 'node', 'go', 'django', 'spring', 'dotnet', 'spring'], $services);
        $this->assertTrue(CascadePlan::build('fail-django')['children'][0]['children'][1]['fail']);
    }

    public function test_job_runs_the_cascade_with_the_owners_token(): void
    {
        $user = User::factory()->create();
        $todo = $user->todos()->create(['title' => 'ship it']);
        Http::fake(fn (Request $request) => Http::response($this->childResult($request->data())));

        (new RunTodoCascade($todo->id, 'req-1'))->handle(app(JwtService::class), app(\App\Cascade\CascadeRunner::class));

        $todo->refresh();
        $this->assertSame('ok', $todo->cascade_status);
        $this->assertSame(['node', 'dotnet'], array_column($todo->cascade['children'], 'id'));

        // Laravel calls only its direct children; each gets its own subtree and the owner's JWT
        Http::assertSentCount(2);
        Http::assertSent(function (Request $request) use ($user) {
            $claims = app(JwtService::class)->decode(str_replace('Bearer ', '', $request->header('Authorization')[0]));

            return str_ends_with($request->url(), '/api/cascade')
                && $claims['sub'] === (string) $user->id
                && in_array($request['id'], ['node', 'dotnet'], true)
                && ! empty($request['children']);
        });
    }

    public function test_a_failing_node_marks_the_todo_as_error(): void
    {
        $user = User::factory()->create();
        $todo = $user->todos()->create(['title' => 'break it', 'scenario' => 'fail-django']);
        Http::fake(fn (Request $request) => Http::response($this->childResult($request->data())));

        (new RunTodoCascade($todo->id, 'req-2'))->handle(app(JwtService::class), app(\App\Cascade\CascadeRunner::class));

        $this->assertSame('error', $todo->refresh()->cascade_status);
    }

    public function test_an_unreachable_child_becomes_an_error_node(): void
    {
        $user = User::factory()->create();
        $todo = $user->todos()->create(['title' => 'down']);
        Http::fake(['*' => Http::response('Unauthorized', 401)]);

        (new RunTodoCascade($todo->id, 'req-3'))->handle(app(JwtService::class), app(\App\Cascade\CascadeRunner::class));

        $todo->refresh();
        $this->assertSame('error', $todo->cascade_status);
        $this->assertSame('HTTP 401', $todo->cascade['children'][0]['error']);
    }

    /** What a well-behaved child service answers: itself + its children, honouring "fail". */
    private function childResult(array $spec): array
    {
        return [
            'id' => $spec['id'],
            'service' => $spec['service'],
            'status' => $spec['fail'] ? 'error' : 'ok',
            'children' => array_map(fn ($c) => $this->childResult($c), $spec['children']),
        ];
    }
}
