package com.example.otel;

import com.nimbusds.jwt.JWTClaimsSet;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;

/**
 * POST /api/cascade: same contract in every demo service. Runs a "cascade <id>" span with simulated
 * work, then calls each child's /api/cascade with the caller's JWT (traceparent + baggage are
 * injected by the instrumented RestClient).
 */
@RestController
public class CascadeController {

    private static final Logger log = LoggerFactory.getLogger(CascadeController.class);
    private static final String SERVICE = "spring";

    private final JwtVerifier jwt;
    private final Tracer tracer;
    private final RestClient http;

    public CascadeController(JwtVerifier jwt, OpenTelemetry openTelemetry, RestClient.Builder builder) {
        this.jwt = jwt;
        this.tracer = openTelemetry.getTracer("com.example.otel");
        var timeouts = new SimpleClientHttpRequestFactory();
        timeouts.setConnectTimeout(Duration.ofSeconds(5));
        timeouts.setReadTimeout(Duration.ofSeconds(15));
        this.http = builder.requestFactory(timeouts).build();
    }

    @PostMapping("/api/cascade")
    public ResponseEntity<Map<String, Object>> cascade(@RequestHeader(value = "Authorization", required = false) String authorization,
                                                       @RequestBody Map<String, Object> spec) {
        JWTClaimsSet claims;
        try {
            claims = jwt.verify(authorization);
        } catch (IllegalArgumentException e) {
            Span.current().addEvent("auth.failed", Attributes.of(AttributeKey.stringKey("auth.error"), e.getMessage()));
            log.atWarn().addKeyValue("auth.error", e.getMessage()).log("cascade rejected: invalid token");
            return ResponseEntity.status(401).body(Map.of("error", "unauthorized", "reason", e.getMessage()));
        }

        String id = String.valueOf(spec.get("id"));
        String userId = claims.getSubject();
        Span span = tracer.spanBuilder("cascade " + id)
                .setAttribute("cascade.node", id)
                .setAttribute("cascade.service", SERVICE)
                .setAttribute("user.id", userId)
                .startSpan();
        long started = System.nanoTime();
        Map<String, Object> result = new LinkedHashMap<>();
        try (Scope ignored = span.makeCurrent()) {
            sleep(((Number) spec.getOrDefault("work_ms", 0)).longValue()); // simulated work
            List<Map<String, Object>> children = new ArrayList<>();
            String error = null;
            if (Boolean.TRUE.equals(spec.get("fail"))) {
                error = "injected failure at " + id;
                span.recordException(new IllegalStateException(error));
                span.setStatus(StatusCode.ERROR, error);
                log.atError().addKeyValue("cascade.node", id).log("cascade step failed");
            } else {
                @SuppressWarnings("unchecked")
                var specs = (List<Map<String, Object>>) spec.getOrDefault("children", List.of());
                for (var child : specs) {
                    children.add(callChild(child, authorization));
                }
                log.atInfo().addKeyValue("cascade.node", id).addKeyValue("cascade.children", children.size()).log("cascade step ok");
            }
            result.put("id", id);
            result.put("service", SERVICE);
            result.put("status", error == null ? "ok" : "error");
            result.put("error", error);
            result.put("user_id", userId);
            result.put("trace_id", span.getSpanContext().getTraceId());
            result.put("span_id", span.getSpanContext().getSpanId());
            result.put("duration_ms", (System.nanoTime() - started) / 1_000_000);
            result.put("children", children);
        } finally {
            span.end();
        }
        return ResponseEntity.status("ok".equals(result.get("status")) ? 200 : 500).body(result);
    }

    private Map<String, Object> callChild(Map<String, Object> child, String authorization) {
        long started = System.nanoTime();
        try {
            ResponseEntity<Map> response = http.post()
                    .uri(String.valueOf(child.get("url")).replaceAll("/$", "") + "/api/cascade")
                    .header("Authorization", authorization)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(child)
                    .retrieve()
                    .onStatus(status -> true, (req, res) -> { }) // read the body for 4xx/5xx too
                    .toEntity(Map.class);
            @SuppressWarnings("unchecked")
            Map<String, Object> body = response.getBody();
            if (body != null && body.get("id") != null) {
                return body; // ok, or the child's own error result
            }
            return failed(child, "HTTP " + response.getStatusCode().value(), started);
        } catch (Exception e) {
            log.atError().addKeyValue("cascade.node", child.get("id")).setCause(e).log("cascade child unreachable");
            return failed(child, e.getMessage(), started);
        }
    }

    private static Map<String, Object> failed(Map<String, Object> child, String error, long started) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", child.get("id"));
        result.put("service", child.get("service"));
        result.put("status", "error");
        result.put("error", error);
        result.put("duration_ms", (System.nanoTime() - started) / 1_000_000);
        result.put("children", List.of());
        return result;
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
