package com.example.otel;

import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Scope;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import com.nimbusds.jwt.JWTClaimsSet;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.slf4j.event.Level;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.util.ContentCachingRequestWrapper;
import org.springframework.web.util.ContentCachingResponseWrapper;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Attaches per-request context to the server span, the logging MDC and OTel baggage
 * (baggage propagates to downstream services via the W3C "baggage" header), and writes one
 * "request completed" log record per request (same fields in every service).
 */
@Component
public class TelemetryContextFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(TelemetryContextFilter.class);

    private final JwtVerifier jwt;

    public TelemetryContextFilter(JwtVerifier jwt) {
        this.jwt = jwt;
    }

    static final String REQUEST_ID_HEADER = "X-Request-Id";
    static final String USER_ID_HEADER = "X-User-Id";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        // bodies are buffered for the request log (JSON only, see body())
        ContentCachingRequestWrapper cachedRequest = new ContentCachingRequestWrapper(request, MAX_BODY);
        ContentCachingResponseWrapper cachedResponse = new ContentCachingResponseWrapper(response);

        // user: valid JWT sub first, then X-User-Id, then baggage from an upstream service
        Baggage upstream = Baggage.current();
        JWTClaimsSet claims = claimsOf(request.getHeader("Authorization"));
        String requestId = Optional.ofNullable(request.getHeader(REQUEST_ID_HEADER))
                .or(() -> Optional.ofNullable(upstream.getEntryValue("request.id")))
                .orElseGet(() -> UUID.randomUUID().toString());
        String userId = Optional.ofNullable(claims == null ? null : claims.getSubject())
                .or(() -> Optional.ofNullable(request.getHeader(USER_ID_HEADER)))
                .or(() -> Optional.ofNullable(upstream.getEntryValue("user.id")))
                .orElse("anonymous");

        Span span = Span.current();
        span.setAttribute("request.id", requestId);
        span.setAttribute("user.id", userId);
        span.setAttribute("client.address", request.getRemoteAddr());

        response.setHeader(REQUEST_ID_HEADER, requestId);
        response.setHeader("X-Trace-Id", span.getSpanContext().getTraceId());

        Baggage baggage = Baggage.current().toBuilder()
                .put("request.id", requestId)
                .put("user.id", userId)
                .build();

        MDC.put("request.id", requestId);
        MDC.put("user.id", userId);
        int status = 500; // an exception escaping the chain becomes a 500
        try (Scope ignored = baggage.makeCurrent()) {
            chain.doFilter(cachedRequest, cachedResponse);
            status = cachedResponse.getStatus();
        } finally {
            logRequestCompleted(cachedRequest, cachedResponse, status, claims);
            cachedResponse.copyBodyToResponse();
            MDC.remove("request.id");
            MDC.remove("user.id");
        }
    }

    static final int MAX_BODY = 4096;

    /** One log record per request; request.id / user.id come from the MDC. */
    private static void logRequestCompleted(ContentCachingRequestWrapper request, ContentCachingResponseWrapper response,
            int status, JWTClaimsSet claims) {
        Level level = status >= 500 ? Level.ERROR : status >= 400 ? Level.WARN : Level.INFO;
        Object route = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        var event = log.atLevel(level)
                .addKeyValue("http.request.method", request.getMethod())
                .addKeyValue("http.route", route != null ? route : request.getRequestURI())
                .addKeyValue("url.path", request.getRequestURI())
                .addKeyValue("http.response.status_code", status)
                .addKeyValue("client.address", request.getRemoteAddr());
        if (claims != null && claims.getClaim("name") != null) event = event.addKeyValue("user.name", claims.getClaim("name"));
        // OAuth2 JWT access token (RFC 9068: client_id, scope/scp): its subject
        if (claims != null && (claims.getClaim("client_id") != null || claims.getClaim("scope") != null || claims.getClaim("scp") != null)) {
            event = event.addKeyValue("user.sub", claims.getSubject());
        }
        String requestBody = body(request.getContentType(), request.getContentAsByteArray());
        if (requestBody != null) event = event.addKeyValue("http.request.body", requestBody);
        String responseBody = body(response.getContentType(), response.getContentAsByteArray());
        if (responseBody != null) event = event.addKeyValue("http.response.body", responseBody);
        event.log("request completed");
    }

    /** JSON bodies up to MAX_BODY bytes; secrets are masked by the collector. */
    private static String body(String contentType, byte[] bytes) {
        if (contentType == null || !contentType.contains("json") || bytes.length == 0 || bytes.length > MAX_BODY) {
            return null;
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private JWTClaimsSet claimsOf(String authorization) {
        if (authorization == null) {
            return null;
        }
        try {
            return jwt.verify(authorization);
        } catch (IllegalArgumentException e) {
            return null; // CascadeController rejects it where auth is required
        }
    }
}
