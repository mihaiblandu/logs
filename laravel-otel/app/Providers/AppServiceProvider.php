<?php

namespace App\Providers;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\ServiceProvider;
use OpenTelemetry\API\Baggage\Baggage;
use OpenTelemetry\API\Globals;
use Psr\Http\Message\RequestInterface;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Outgoing HTTP calls carry the current trace (traceparent) and baggage, plus
        // X-Request-Id / X-User-Id for services that read context from plain headers.
        Http::globalRequestMiddleware(function (RequestInterface $request): RequestInterface {
            $headers = [];
            Globals::propagator()->inject($headers);

            $baggage = Baggage::getCurrent();
            foreach (['X-Request-Id' => 'request.id', 'X-User-Id' => 'user.id'] as $header => $key) {
                if (($value = $baggage->getValue($key)) !== null && ! $request->hasHeader($header)) {
                    $headers[$header] = $value;
                }
            }

            foreach ($headers as $name => $value) {
                $request = $request->withHeader($name, $value);
            }

            return $request;
        });
    }
}
