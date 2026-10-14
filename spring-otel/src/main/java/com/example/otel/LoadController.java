package com.example.otel;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.logs.Logger;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Generates synthetic log volume (e.g. 1M records) for backend load tests.
 * Logs go straight to the OTel Logs API (not SLF4J), so the console is not flooded.
 * Every {@link #LOGS_PER_TRACE} logs share one trace, so log -> trace correlation still works.
 */
@RestController
@RequestMapping("/load")
public class LoadController {

    private static final int LOGS_PER_TRACE = 5;
    private static final String[] ROUTES = {"/echo", "/orders", "/payments", "/users", "/search"};
    private static final String[] MESSAGES = {
            "request received", "cache lookup", "db query executed", "downstream call finished", "response sent"};

    private static final AttributeKey<String> USER_ID = AttributeKey.stringKey("user.id");
    private static final AttributeKey<String> REQUEST_ID = AttributeKey.stringKey("request.id");
    private static final AttributeKey<String> ROUTE = AttributeKey.stringKey("http.route");
    private static final AttributeKey<Long> STATUS = AttributeKey.longKey("http.response.status_code");
    private static final AttributeKey<Long> LATENCY = AttributeKey.longKey("latency_ms");
    private static final AttributeKey<String> RUN_ID = AttributeKey.stringKey("load.run_id");

    private final Logger otelLogger;
    private final Tracer tracer;
    private final AtomicReference<Run> current = new AtomicReference<>();

    public LoadController(OpenTelemetry openTelemetry) {
        this.otelLogger = openTelemetry.getLogsBridge().get("com.example.otel.load");
        this.tracer = openTelemetry.getTracer("com.example.otel.load");
    }

    /** Starts a background run: POST /load/logs?count=1000000&rate=20000 (logs per second). */
    @PostMapping("/logs")
    public ResponseEntity<Map<String, Object>> start(@RequestParam(defaultValue = "1000000") long count,
                                                     @RequestParam(defaultValue = "20000") long rate) {
        Run run = new Run(UUID.randomUUID().toString().substring(0, 8), count, rate, Instant.now());
        Run previous = current.get();
        if (previous != null && !previous.done() || !current.compareAndSet(previous, run)) {
            return ResponseEntity.status(409).body(Map.of("error", "a run is already in progress"));
        }
        Thread.ofVirtual().name("load-" + run.id).start(() -> generate(run));
        return ResponseEntity.accepted().body(run.toMap());
    }

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        Run run = current.get();
        return run == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(run.toMap());
    }

    private void generate(Run run) {
        long nanosPerLog = 1_000_000_000L / Math.max(1, run.rate);
        long start = System.nanoTime();
        ThreadLocalRandom rnd = ThreadLocalRandom.current();

        while (run.emitted.get() < run.count) {
            String route = ROUTES[rnd.nextInt(ROUTES.length)];
            boolean failed = rnd.nextInt(100) >= 95;
            Span span = tracer.spanBuilder("load " + route)
                    .setAttribute(RUN_ID, run.id)
                    .setAttribute(ROUTE, route)
                    .startSpan();
            try (Scope ignored = span.makeCurrent()) {
                String userId = "user" + rnd.nextInt(50);
                String requestId = UUID.randomUUID().toString();
                for (int i = 0; i < LOGS_PER_TRACE && run.emitted.get() < run.count; i++) {
                    boolean last = i == LOGS_PER_TRACE - 1;
                    Severity severity = last && failed ? Severity.ERROR : rnd.nextInt(100) < 10 ? Severity.DEBUG : Severity.INFO;
                    otelLogger.logRecordBuilder()
                            .setSeverity(severity)
                            .setSeverityText(severity.name())
                            .setBody(last && failed ? "request failed" : MESSAGES[i])
                            .setAttribute(RUN_ID, run.id)
                            .setAttribute(USER_ID, userId)
                            .setAttribute(REQUEST_ID, requestId)
                            .setAttribute(ROUTE, route)
                            .setAttribute(STATUS, failed ? 500L : 200L)
                            .setAttribute(LATENCY, (long) rnd.nextInt(1, 300))
                            .emit(); // trace_id/span_id taken from the current span
                    long n = run.emitted.incrementAndGet();
                    // pace to the requested rate so the SDK queue doesn't overflow and drop records
                    long ahead = start + n * nanosPerLog - System.nanoTime();
                    if (ahead > 0 && n % 100 == 0) {
                        LockSupport.parkNanos(ahead);
                    }
                }
            } finally {
                if (failed) {
                    span.setStatus(StatusCode.ERROR);
                }
                span.end();
            }
        }
        run.finished = Instant.now();
    }

    private static final class Run {
        final String id;
        final long count;
        final long rate;
        final Instant started;
        final AtomicLong emitted = new AtomicLong();
        volatile Instant finished;

        Run(String id, long count, long rate, Instant started) {
            this.id = id;
            this.count = count;
            this.rate = rate;
            this.started = started;
        }

        boolean done() {
            return finished != null;
        }

        Map<String, Object> toMap() {
            Instant end = finished != null ? finished : Instant.now();
            return Map.of(
                    "run_id", id,
                    "count", count,
                    "rate_per_sec", rate,
                    "emitted", emitted.get(),
                    "elapsed_sec", Duration.between(started, end).toSeconds(),
                    "done", done());
        }
    }
}
