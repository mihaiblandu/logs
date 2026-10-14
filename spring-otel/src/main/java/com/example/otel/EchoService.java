package com.example.otel;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.instrumentation.annotations.SpanAttribute;
import io.opentelemetry.instrumentation.annotations.WithSpan;
import java.util.concurrent.ThreadLocalRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class EchoService {

    private static final Logger log = LoggerFactory.getLogger(EchoService.class);

    /** Creates a child span under the HTTP server span. */
    @WithSpan("echo.process")
    public String process(@SpanAttribute("echo.message") String message) {
        Span span = Span.current();
        long delay = ThreadLocalRandom.current().nextInt(5, 50);
        span.addEvent("work.started", Attributes.of(AttributeKey.longKey("work.planned_ms"), delay));
        sleep(delay); // simulated work, visible as span duration
        span.addEvent("work.finished");
        span.setAttribute("work.duration_ms", delay);
        log.atDebug().addKeyValue("work.duration_ms", delay).log("processed message");
        return message;
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
