<?php

namespace App\Http\Controllers;

use App\Auth\JwtService;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use OpenTelemetry\API\Trace\Span;

class AuthController extends Controller
{
    public function login(Request $request, JwtService $jwt): JsonResponse
    {
        $data = $request->validate(['email' => 'required|email', 'password' => 'required|string']);
        $user = User::where('email', $data['email'])->first();

        if (! $user || ! Hash::check($data['password'], $user->password)) {
            Span::getCurrent()->addEvent('auth.login_failed', ['user.email' => $data['email']]);
            Log::warning('login failed', ['user.email' => $data['email']]);

            return response()->json(['error' => 'invalid credentials'], 401);
        }

        Log::info('login ok', ['user.email' => $user->email]);

        return response()->json([
            'token' => $jwt->issue($user),
            'token_type' => 'Bearer',
            'expires_in' => config('demo.jwt.ttl'),
            'user' => $user->only('id', 'name', 'email'),
        ]);
    }

    public function me(Request $request): JsonResponse
    {
        return response()->json($request->user()->only('id', 'name', 'email'));
    }
}
