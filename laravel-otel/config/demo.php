<?php

/*
 * Settings shared with the other demo services (Spring, .NET, Django, Go, Node).
 * The JWT secret must be the same everywhere: every service validates the token Laravel issues.
 */
return [
    'jwt' => [
        'secret' => env('JWT_SECRET', 'dev-only-shared-secret-change-me-0123456789abcdef'),
        'issuer' => 'laravel-otel',
        'audience' => 'otel-demo',
        'ttl' => (int) env('JWT_TTL', 3600),
    ],

    // Base URLs of the services, as seen from where the caller runs. Laravel runs in Docker,
    // everything else on the host, so Laravel uses host.docker.internal and the others localhost.
    'services' => [
        'from_laravel' => [
            'node' => env('NODE_URL', 'http://host.docker.internal:3005'),
            'dotnet' => env('DOTNET_URL', 'http://host.docker.internal:5050'),
        ],
        'from_host' => [
            'go' => 'http://localhost:4250',
            'django' => 'http://localhost:8001',
            'spring' => 'http://localhost:4242',
        ],
    ],

    'kibana_url' => env('KIBANA_URL', 'http://localhost:5601'),
    'jaeger_url' => env('JAEGER_URL', 'http://localhost:16686'),
];
