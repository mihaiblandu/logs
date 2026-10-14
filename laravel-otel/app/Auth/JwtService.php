<?php

namespace App\Auth;

use App\Models\User;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use UnexpectedValueException;

/** Issues and validates the HS256 tokens shared by all demo services. */
class JwtService
{
    public function issue(User $user): string
    {
        $now = time();

        return JWT::encode([
            'iss' => config('demo.jwt.issuer'),
            'aud' => config('demo.jwt.audience'),
            'sub' => (string) $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'iat' => $now,
            'exp' => $now + config('demo.jwt.ttl'),
        ], config('demo.jwt.secret'), 'HS256');
    }

    /** @return array<string, mixed> claims; throws on bad signature, expiry, issuer or audience */
    public function decode(string $token): array
    {
        JWT::$leeway = 30;
        $claims = (array) JWT::decode($token, new Key(config('demo.jwt.secret'), 'HS256'));

        if (($claims['iss'] ?? null) !== config('demo.jwt.issuer')) {
            throw new UnexpectedValueException('invalid issuer');
        }
        if (! in_array(config('demo.jwt.audience'), (array) ($claims['aud'] ?? []), true)) {
            throw new UnexpectedValueException('invalid audience');
        }

        return $claims;
    }
}
