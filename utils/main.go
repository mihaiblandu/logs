package main

import (
	"fmt"
	"math/rand"
	"net/http"
	"time"

	"charm.land/log/v2"
)

func handleEcho(w http.ResponseWriter, r *http.Request) {
	message := r.URL.Query().Get("message")
	if rand.Intn(100) > 90 {
		log.Error("echo failed", "message", message, "status", http.StatusInternalServerError)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	log.Info("echo ok", "message", message)
	fmt.Fprintf(w, message)
}

func main() {
	rand.Seed(time.Now().UnixNano())
	http.HandleFunc("/echo", handleEcho)
	log.Info("server starting", "addr", ":4242")
	log.Fatal(http.ListenAndServe(":4242", nil))
}
