package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// POST /api/cascade: same contract in every demo service. Runs a "cascade <id>" span with simulated
// work, then calls each child's /api/cascade (in parallel) with the caller's JWT; traceparent +
// baggage are injected by otelhttp.Transport.

const cascadeService = "go"

type cascadeSpec struct {
	ID       string        `json:"id"`
	Service  string        `json:"service"`
	URL      string        `json:"url"`
	WorkMS   int           `json:"work_ms"`
	Fail     bool          `json:"fail"`
	Children []cascadeSpec `json:"children"`
}

type cascadeResult struct {
	ID         string          `json:"id"`
	Service    string          `json:"service"`
	Status     string          `json:"status"`
	Error      *string         `json:"error"`
	UserID     string          `json:"user_id,omitempty"`
	TraceID    string          `json:"trace_id,omitempty"`
	SpanID     string          `json:"span_id,omitempty"`
	DurationMS int64           `json:"duration_ms"`
	Children   []cascadeResult `json:"children"`
}

var jwtSecret = []byte(env("JWT_SECRET", "dev-only-shared-secret-change-me-0123456789abcdef"))

// verifyBearer validates the HS256 token issued by the Laravel app (signature, exp, iss, aud).
func verifyBearer(header string) (token string, claims jwt.MapClaims, err error) {
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || token == "" {
		return "", nil, errors.New("missing token")
	}
	claims = jwt.MapClaims{}
	_, err = jwt.ParseWithClaims(token, claims, func(*jwt.Token) (any, error) { return jwtSecret, nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("laravel-otel"), jwt.WithAudience("otel-demo"),
		jwt.WithLeeway(30*time.Second), jwt.WithExpirationRequired())
	return token, claims, err
}

func handleCascade(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token, claims, err := verifyBearer(r.Header.Get("Authorization"))
	if err != nil {
		trace.SpanFromContext(ctx).AddEvent("auth.failed", trace.WithAttributes(attribute.String("auth.error", err.Error())))
		log.WarnContext(ctx, "cascade rejected: invalid token", "auth.error", err.Error())
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized", "reason": err.Error()})
		return
	}
	var spec cascadeSpec
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	userID, _ := claims.GetSubject()

	ctx, span := tracer.Start(ctx, "cascade "+spec.ID, trace.WithAttributes(
		attribute.String("cascade.node", spec.ID), attribute.String("cascade.service", cascadeService), attribute.String("user.id", userID)))
	started := time.Now()
	result := cascadeResult{ID: spec.ID, Service: cascadeService, Status: "ok", UserID: userID,
		TraceID: span.SpanContext().TraceID().String(), SpanID: span.SpanContext().SpanID().String(), Children: []cascadeResult{}}

	time.Sleep(time.Duration(spec.WorkMS) * time.Millisecond) // simulated work
	if spec.Fail {
		msg := "injected failure at " + spec.ID
		span.RecordError(errors.New(msg))
		span.SetStatus(codes.Error, msg)
		log.ErrorContext(ctx, "cascade step failed", "cascade.node", spec.ID)
		result.Status, result.Error = "error", &msg
	} else {
		result.Children = make([]cascadeResult, len(spec.Children))
		var wg sync.WaitGroup
		for i, child := range spec.Children {
			wg.Add(1)
			go func() {
				defer wg.Done()
				result.Children[i] = callChild(ctx, child, token)
			}()
		}
		wg.Wait()
		log.InfoContext(ctx, "cascade step ok", "cascade.node", spec.ID, "cascade.children", len(spec.Children))
	}
	result.DurationMS = time.Since(started).Milliseconds()
	span.End()

	status := http.StatusOK
	if result.Status != "ok" {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, result)
}

func callChild(ctx context.Context, child cascadeSpec, token string) cascadeResult {
	started := time.Now()
	failed := func(msg string) cascadeResult {
		return cascadeResult{ID: child.ID, Service: child.Service, Status: "error", Error: &msg,
			DurationMS: time.Since(started).Milliseconds(), Children: []cascadeResult{}}
	}
	body, _ := json.Marshal(child)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(child.URL, "/")+"/api/cascade", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := client.Do(req)
	if err != nil {
		log.ErrorContext(ctx, "cascade child unreachable", "cascade.node", child.ID, "error", err.Error())
		return failed(err.Error())
	}
	defer resp.Body.Close()
	var result cascadeResult
	if json.NewDecoder(resp.Body).Decode(&result) == nil && result.ID != "" {
		return result // ok, or the child's own error result
	}
	return failed(fmt.Sprintf("HTTP %d", resp.StatusCode))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
