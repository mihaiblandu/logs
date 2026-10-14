package com.example.otel;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import java.util.concurrent.ThreadLocalRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Spring port of utils/main.go: /echo fails ~10% of the time. */
@RestController
public class EchoController {

    private static final Logger log = LoggerFactory.getLogger(EchoController.class);
    private static final AttributeKey<String> OUTCOME = AttributeKey.stringKey("outcome");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");

    private final EchoService echoService;
    private final LongCounter echoCounter;
    private final DoubleHistogram messageLength;

    public EchoController(EchoService echoService, OpenTelemetry openTelemetry) {
        this.echoService = echoService;
        var meter = openTelemetry.getMeter("com.example.otel");
        this.echoCounter = meter.counterBuilder("echo.requests")
                .setDescription("Echo requests by outcome")
                .build();
        this.messageLength = meter.histogramBuilder("echo.message.length")
                .setDescription("Length of echoed messages")
                .setUnit("{char}")
                .build();
    }

    @GetMapping("/echo")
    public ResponseEntity<String> echo(@RequestParam(defaultValue = "") String message) {
        Span span = Span.current(); // server span created by the Spring MVC instrumentation
        span.setAttribute("echo.message", message);
        span.setAttribute("echo.message_length", message.length());

        if (ThreadLocalRandom.current().nextInt(100) > 90) {
            var error = new IllegalStateException("random failure while echoing '" + message + "'");
            span.recordException(error); // span event "exception" with type, message, stacktrace
            span.setStatus(StatusCode.ERROR, error.getMessage());
            echoCounter.add(1, Attributes.of(OUTCOME, "error", ERROR_TYPE, error.getClass().getSimpleName()));
            log.atError()
                    .setCause(error)
                    .addKeyValue("echo.message", message)
                    .addKeyValue("http.response.status_code", 500)
                    .log("echo failed");
            return ResponseEntity.internalServerError().build();
        }

        String result = echoService.process(message);
        echoCounter.add(1, Attributes.of(OUTCOME, "ok"));
        messageLength.record(message.length());
        log.atInfo()
                .addKeyValue("echo.message", message)
                .addKeyValue("echo.message_length", message.length())
                .addKeyValue("http.response.status_code", 200)
                .log("echo ok");
        return ResponseEntity.ok(result);
    }
}
