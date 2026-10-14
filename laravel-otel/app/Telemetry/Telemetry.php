<?php

namespace App\Telemetry;

use OpenTelemetry\API\Globals;
use OpenTelemetry\API\Metrics\CounterInterface;
use OpenTelemetry\API\Metrics\HistogramInterface;
use OpenTelemetry\API\Trace\TracerInterface;

/** Tracer and instruments for manual instrumentation (auto-instrumentation covers HTTP, DB, cache, logs). */
class Telemetry
{
    private const SCOPE = 'app.laravel-otel';

    public static function tracer(): TracerInterface
    {
        return Globals::tracerProvider()->getTracer(self::SCOPE);
    }

    public static function echoRequests(): CounterInterface
    {
        return Globals::meterProvider()->getMeter(self::SCOPE)
            ->createCounter('echo.requests', '{request}', 'Echo requests by outcome');
    }

    public static function messageLength(): HistogramInterface
    {
        return Globals::meterProvider()->getMeter(self::SCOPE)
            ->createHistogram('echo.message.length', '{char}', 'Length of echoed messages');
    }
}
