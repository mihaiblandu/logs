<?php

namespace App\Cascade;

use InvalidArgumentException;

/**
 * The cascade tree started by Laravel. Every node is handled by one service's POST /api/cascade,
 * which does its work and then calls its children. Three shapes:
 *
 *   tree (default)                          chain (all six in one line)
 *   laravel ─┬─ node ─┬─ go                 laravel ── node ── go ── django ── dotnet ── spring
 *            │        └─ django ── spring
 *            └─ dotnet ── spring            wide: laravel calls the five others directly
 *
 * On top of a shape, a scenario injects failures ("fail": the node errors, its subtree is never
 * called) and slow work ("work_ms").
 */
class CascadePlan
{
    /** scenario => what it shows (the UI lists these) */
    public const DESCRIPTIONS = [
        'all-ok' => 'every node succeeds',
        'slow' => 'every node works 400 ms',
        'chain' => 'all six services in one line: laravel → node → go → django → dotnet → spring',
        'wide' => 'Laravel calls the five other services directly, in parallel',
        'fail-laravel' => 'the job itself fails: no service is called',
        'fail-node' => 'Node fails: Go, Django and spring-a are never called',
        'fail-go' => 'Go (a leaf) fails, everything else runs',
        'fail-django' => 'Django fails: spring-a is never called',
        'fail-dotnet' => '.NET fails: spring-b is never called',
        'fail-spring' => 'both Spring nodes (spring-a, spring-b) fail',
        'fail-spring-a' => 'only spring-a fails, spring-b succeeds',
        'slow-node' => 'Node works 1.5 s (its whole subtree waits)',
        'slow-django' => 'Django works 1.5 s',
        'slow-spring' => 'both Spring nodes work 1.5 s',
        'mixed' => 'Go fails and .NET works 1.2 s',
        'chain-fail-django' => 'the chain breaks at Django: .NET and Spring are never called',
        'wide-fail-go' => 'wide, Go fails, the four others succeed',
        'chaos' => 'every node below Laravel fails with a 25% chance (a new draw on every run)',
    ];

    public const SCENARIOS = [
        'all-ok', 'slow', 'chain', 'wide',
        'fail-laravel', 'fail-node', 'fail-go', 'fail-django', 'fail-dotnet', 'fail-spring', 'fail-spring-a',
        'slow-node', 'slow-django', 'slow-spring', 'mixed', 'chain-fail-django', 'wide-fail-go', 'chaos',
    ];

    private const WORK_MS = 30;

    /**
     * @param  bool  $preview  for the planned graph: no random failures (chaos draws them per run)
     * @return array<string, mixed> root node spec (Laravel itself)
     */
    public static function build(string $scenario, bool $preview = false): array
    {
        if (! in_array($scenario, self::SCENARIOS, true)) {
            throw new InvalidArgumentException("unknown scenario {$scenario}");
        }
        $urls = config('demo.services');

        // $fromLaravel: the caller is the Laravel container (host.docker.internal) or a host service (localhost)
        $node = function (string $id, string $service, array $children = [], bool $fromLaravel = false) use ($scenario, $preview, $urls) {
            return [
                'id' => $id,
                'service' => $service,
                'url' => $service === 'laravel' ? '' : $urls[$fromLaravel ? 'from_laravel' : 'from_host'][$service],
                'work_ms' => self::workMs($scenario, $service),
                'fail' => self::fails($scenario, $id, $service, $preview),
                'children' => $children,
            ];
        };

        return match (self::shape($scenario)) {
            'chain' => $node('laravel', 'laravel', [
                $node('node', 'node', [
                    $node('go', 'go', [
                        $node('django', 'django', [
                            $node('dotnet', 'dotnet', [
                                $node('spring', 'spring'),
                            ]),
                        ]),
                    ]),
                ], fromLaravel: true),
            ]),
            'wide' => $node('laravel', 'laravel', array_map(
                fn (string $service) => $node($service, $service, fromLaravel: true),
                ['node', 'go', 'django', 'dotnet', 'spring'],
            )),
            default => $node('laravel', 'laravel', [
                $node('node', 'node', [
                    $node('go', 'go'),
                    $node('django', 'django', [
                        $node('spring-a', 'spring'),
                    ]),
                ], fromLaravel: true),
                $node('dotnet', 'dotnet', [
                    $node('spring-b', 'spring'),
                ], fromLaravel: true),
            ]),
        };
    }

    private static function shape(string $scenario): string
    {
        return str_starts_with($scenario, 'chain') ? 'chain' : (str_starts_with($scenario, 'wide') ? 'wide' : 'tree');
    }

    private static function workMs(string $scenario, string $service): int
    {
        return match (true) {
            $scenario === 'slow' => 400,
            $scenario === "slow-{$service}" => 1500,
            $scenario === 'mixed' && $service === 'dotnet' => 1200,
            default => self::WORK_MS,
        };
    }

    private static function fails(string $scenario, string $id, string $service, bool $preview): bool
    {
        // the scenario name minus its shape prefix: "chain-fail-django" -> "fail-django"
        $injected = preg_replace('/^(chain|wide)-/', '', $scenario);

        return match (true) {
            $injected === "fail-{$service}", $injected === "fail-{$id}" => true,
            $scenario === 'mixed' => $service === 'go',
            $scenario === 'chaos' => ! $preview && $service !== 'laravel' && random_int(1, 100) <= 25,
            default => false,
        };
    }
}
