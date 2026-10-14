<?php

namespace Tests\Feature;

use App\Auth\JwtService;
use App\Models\User;
use Firebase\JWT\JWT;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    public function test_login_issues_a_jwt_for_the_user(): void
    {
        $user = User::factory()->create(['password' => 'secret123']);

        $response = $this->postJson('/api/login', ['email' => $user->email, 'password' => 'secret123'])->assertOk();

        $claims = app(JwtService::class)->decode($response->json('token'));
        $this->assertSame((string) $user->id, $claims['sub']);
        $this->assertSame('laravel-otel', $claims['iss']);
        $this->assertSame('otel-demo', $claims['aud']);
    }

    public function test_login_rejects_a_wrong_password(): void
    {
        $user = User::factory()->create(['password' => 'secret123']);

        $this->postJson('/api/login', ['email' => $user->email, 'password' => 'nope'])->assertUnauthorized();
    }

    public function test_protected_routes_require_a_valid_token(): void
    {
        $user = User::factory()->create();
        $valid = app(JwtService::class)->issue($user);
        $forged = JWT::encode(['sub' => (string) $user->id, 'iss' => 'laravel-otel', 'aud' => 'otel-demo', 'exp' => time() + 60],
            'some-other-secret-that-is-long-enough-0123456789', 'HS256');
        $expired = JWT::encode(['sub' => (string) $user->id, 'iss' => 'laravel-otel', 'aud' => 'otel-demo', 'exp' => time() - 3600],
            config('demo.jwt.secret'), 'HS256');

        $this->getJson('/api/todos')->assertUnauthorized();
        $this->withToken($forged)->getJson('/api/todos')->assertUnauthorized();
        $this->withToken($expired)->getJson('/api/todos')->assertUnauthorized();
        $this->withToken($valid)->getJson('/api/todos')->assertOk();
    }
}
