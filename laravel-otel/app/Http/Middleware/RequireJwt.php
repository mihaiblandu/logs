<?php

namespace App\Http\Middleware;

use App\Auth\JwtService;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use OpenTelemetry\API\Trace\Span;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/** Rejects requests without a valid bearer token; puts the user on the request. */
class RequireJwt
{
    public function __construct(private JwtService $jwt) {}

    public function handle(Request $request, Closure $next): Response
    {
        $token = $request->bearerToken();
        try {
            $claims = $token ? $this->jwt->decode($token) : throw new \UnexpectedValueException('missing token');
            $user = User::findOrFail($claims['sub']);
        } catch (Throwable $e) {
            Span::getCurrent()->addEvent('auth.failed', ['auth.error' => $e->getMessage()]);

            return response()->json(['error' => 'unauthorized', 'reason' => $e->getMessage()], 401);
        }

        $request->setUserResolver(fn () => $user);
        $request->attributes->set('jwt', $token);

        return $next($request);
    }
}
