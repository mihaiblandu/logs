<?php

namespace App\Cascade;

use InvalidArgumentException;

/**
 * The cascade tree started by Laravel. Every node is handled by one service's POST /api/cascade,
 * which does its work and then calls its children:
 *
 *   laravel ─┬─ node ─┬─ go
 *            │        └─ django ── spring
 *            └─ dotnet ── spring
 */
class CascadePlan
{
    public const SCENARIOS = ['all-ok', 'fail-django', 'fail-dotnet', 'slow'];

    /** @return array<string, mixed> root node spec (Laravel itself) */
    public static function build(string $scenario): array
    {
        if (! in_array($scenario, self::SCENARIOS, true)) {
            throw new InvalidArgumentException("unknown scenario {$scenario}");
        }
        $fromLaravel = config('demo.services.from_laravel');
        $fromHost = config('demo.services.from_host');
        $work = $scenario === 'slow' ? 400 : 30;

        $node = fn (string $id, string $service, string $url, array $children = []) => [
            'id' => $id,
            'service' => $service,
            'url' => $url,
            'work_ms' => $work,
            'fail' => $scenario === "fail-{$service}",
            'children' => $children,
        ];

        return $node('laravel', 'laravel', '', [
            $node('node', 'node', $fromLaravel['node'], [
                $node('go', 'go', $fromHost['go']),
                $node('django', 'django', $fromHost['django'], [
                    $node('spring-a', 'spring', $fromHost['spring']),
                ]),
            ]),
            $node('dotnet', 'dotnet', $fromLaravel['dotnet'], [
                $node('spring-b', 'spring', $fromHost['spring']),
            ]),
        ]);
    }
}
