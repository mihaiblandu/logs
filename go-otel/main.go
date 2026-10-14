package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const scope = "app.go-otel"

var (
	tracer = otel.Tracer(scope)
	log    *slog.Logger

	echoRequests  metric.Int64Counter
	messageLength metric.Int64Histogram
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	shutdown, err := setupOTel(ctx)
	if err != nil {
		panic(err)
	}
	defer shutdown(context.Background())

	log = newLogger()
	meter := otel.Meter(scope)
	echoRequests, _ = meter.Int64Counter("echo.requests", metric.WithUnit("{request}"), metric.WithDescription("Echo requests by outcome"))
	messageLength, _ = meter.Int64Histogram("echo.message.length", metric.WithUnit("{char}"), metric.WithDescription("Length of echoed messages"))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/echo", handleEcho)
	mux.HandleFunc("GET /api/chain", handleChain)
	mux.HandleFunc("POST /api/cascade", handleCascade)

	// otelhttp creates the server span (extracting traceparent + baggage); withContext runs inside it
	handler := otelhttp.NewHandler(withContext(mux), "http.server",
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return r.Method + " " + r.URL.Path }))

	addr := ":" + env("PORT", "4250")
	srv := &http.Server{Addr: addr, Handler: handler}
	go func() {
		<-ctx.Done()
		srv.Shutdown(context.Background())
	}()
	log.InfoContext(ctx, "server starting", "server.address", addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.ErrorContext(ctx, "server failed", "error", err)
	}
}

// withContext attaches per-request context to the server span, every log record (contextHandler
// reads baggage) and OTel baggage (propagated downstream via the W3C "baggage" header).
func withContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// user: valid JWT sub first, then X-User-Id, then baggage from an upstream service
		upstream := baggage.FromContext(ctx)
		requestID := firstNonEmpty(r.Header.Get("X-Request-Id"), upstream.Member("request.id").Value(), uuid.NewString())
		var jwtUser string
		if _, claims, err := verifyBearer(r.Header.Get("Authorization")); err == nil {
			jwtUser, _ = claims.GetSubject()
		}
		userID := firstNonEmpty(jwtUser, r.Header.Get("X-User-Id"), upstream.Member("user.id").Value(), "anonymous")

		span := trace.SpanFromContext(ctx)
		span.SetAttributes(
			attribute.String("request.id", requestID),
			attribute.String("user.id", userID),
			attribute.String("client.address", r.RemoteAddr),
		)

		b := baggage.FromContext(ctx)
		for k, v := range map[string]string{"request.id": requestID, "user.id": userID} {
			if m, err := baggage.NewMember(k, v); err == nil {
				b, _ = b.SetMember(m)
			}
		}
		ctx = baggage.ContextWithBaggage(ctx, b)

		w.Header().Set("X-Request-Id", requestID)
		w.Header().Set("X-Trace-Id", span.SpanContext().TraceID().String())
		var requestBody []byte
		if r.ContentLength > 0 && r.ContentLength <= maxBody {
			requestBody, _ = io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(requestBody))
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		req := r.WithContext(ctx)
		next.ServeHTTP(rec, req) // the mux sets req.Pattern
		_, claims, err := verifyBearer(r.Header.Get("Authorization"))
		if err != nil {
			claims = nil
		}
		logRequestCompleted(ctx, req, rec, claims, requestBody)
	})
}

// logRequestCompleted writes one "request completed" log record per request (same fields in every
// service); request.id / user.id come from baggage (contextHandler).
func logRequestCompleted(ctx context.Context, r *http.Request, rec *statusRecorder, claims jwt.MapClaims, requestBody []byte) {
	status := rec.status
	route := r.URL.Path
	if _, pattern, ok := strings.Cut(r.Pattern, " "); ok { // "GET /api/echo" -> "/api/echo"
		route = pattern
	} else if r.Pattern != "" {
		route = r.Pattern
	}
	level := slog.LevelInfo
	if status >= 500 {
		level = slog.LevelError
	} else if status >= 400 {
		level = slog.LevelWarn
	}
	args := []any{
		"http.request.method", r.Method,
		"http.route", route,
		"url.path", r.URL.Path,
		"http.response.status_code", status,
		"client.address", clientIP(r),
	}
	userName, _ := claims["name"].(string)
	var sub string
	// OAuth2 JWT access token (RFC 9068: client_id, scope/scp): its subject
	if claims["client_id"] != nil || claims["scope"] != nil || claims["scp"] != nil {
		sub, _ = claims.GetSubject()
	}
	for key, value := range map[string]string{
		"user.name":          userName,
		"user.sub":           sub,
		"http.request.body":  jsonBody(r.Header.Get("Content-Type"), requestBody),
		"http.response.body": jsonBody(rec.Header().Get("Content-Type"), rec.body.Bytes()),
	} {
		if value != "" {
			args = append(args, key, value)
		}
	}
	log.Log(ctx, level, "request completed", args...)
}

const maxBody = 4096

// jsonBody returns JSON bodies up to maxBody bytes; secrets are masked by the collector.
func jsonBody(contentType string, body []byte) string {
	if !strings.Contains(contentType, "json") || len(body) == 0 || len(body) > maxBody {
		return ""
	}
	return string(body)
}

// clientIP is RemoteAddr without the port, like the other services report it.
func clientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer // first maxBody+1 bytes, for the request log
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if room := maxBody + 1 - s.body.Len(); room > 0 {
		s.body.Write(b[:min(len(b), room)])
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Port of utils/main.go /echo: fails ~10% of the time.
func handleEcho(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	message := r.URL.Query().Get("message")
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(attribute.String("echo.message", message), attribute.Int("echo.message_length", len(message)))

	if rand.IntN(100) > 90 {
		err := fmt.Errorf("random failure while echoing %q", message)
		span.RecordError(err, trace.WithStackTrace(true)) // span event "exception"
		span.SetStatus(codes.Error, err.Error())
		echoRequests.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", "error"), attribute.String("error.type", "random")))
		log.ErrorContext(ctx, "echo failed", "echo.message", message, "http.response.status_code", 500)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	result := process(ctx, message)
	echoRequests.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", "ok")))
	messageLength.Record(ctx, int64(len(message)))
	log.InfoContext(ctx, "echo ok", "echo.message", message, "http.response.status_code", 200)
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"message":%q}`, result)
}

// Go -> Django -> .NET -> Laravel -> Spring: one trace across five services.
var client = &http.Client{Timeout: 10 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport,
	otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return r.Method }))}

func handleChain(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	downstream := env("DOWNSTREAM_URL", "http://localhost:8001")
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, downstream+"/api/chain?message=from-go", nil)
	// traceparent + baggage are injected by otelhttp.Transport; plain headers for services that read them
	b := baggage.FromContext(ctx)
	req.Header.Set("X-Request-Id", b.Member("request.id").Value())
	req.Header.Set("X-User-Id", b.Member("user.id").Value())

	resp, err := client.Do(req)
	if err != nil {
		log.ErrorContext(ctx, "downstream call failed", "error", err)
		http.Error(w, `{"error":"downstream unavailable"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	log.InfoContext(ctx, "downstream call finished", "downstream.url", downstream, "downstream.status", resp.StatusCode)

	status := http.StatusOK
	if resp.StatusCode >= 300 {
		status = http.StatusBadGateway
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"downstream_status":%d,"downstream_body":%q}`, resp.StatusCode, body)
}

func process(ctx context.Context, message string) string {
	ctx, span := tracer.Start(ctx, "echo.process") // child of the server span
	defer span.End()
	delay := 5 + rand.IntN(45)
	span.AddEvent("work.started", trace.WithAttributes(attribute.Int("work.planned_ms", delay)))
	time.Sleep(time.Duration(delay) * time.Millisecond) // simulated work, visible as span duration
	span.AddEvent("work.finished")
	span.SetAttributes(attribute.Int("work.duration_ms", delay))
	log.DebugContext(ctx, "processed message", "work.duration_ms", delay)
	return message
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
