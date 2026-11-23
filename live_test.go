package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDialtoneEarthLiveControlCLI(t *testing.T) {
	const testToken = "test-live-bearer-token-999"
	rev := 0
	current := liveSiteState{Revision: 0}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/live" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(current)
		case http.MethodPatch:
			if r.Header.Get("Authorization") != "Bearer "+testToken {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
				return
			}
			var patch map[string]any
			if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			rev++
			current.Revision = rev
			if v, ok := patch["banner"].(string); ok {
				if v == "" {
					current.Banner = nil
				} else {
					current.Banner = &v
				}
			}
			if v, ok := patch["theme"].(string); ok {
				if v == "" {
					current.Theme = nil
				} else {
					current.Theme = &v
				}
			}
			if v, ok := patch["network"].(string); ok {
				current.Network = &v
			}
			if v, ok := patch["tour_playing"].(bool); ok {
				current.TourPlaying = &v
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "state": current})
		case http.MethodDelete:
			if r.Header.Get("Authorization") != "Bearer "+testToken {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			rev++
			current = liveSiteState{Revision: rev}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "state": current})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer srv.Close()

	tokenPath := filepath.Join(t.TempDir(), "live-control-token.txt")
	if err := os.WriteFile(tokenPath, []byte(testToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. status before mutation
	var out, errBuf bytes.Buffer
	if code := Run([]string{"live", "status", "--url", srv.URL}, &out, &errBuf); code != 0 {
		t.Fatalf("live status failed: code=%d stderr=%s", code, errBuf.String())
	}
	if !strings.Contains(out.String(), "rev #0") {
		t.Fatalf("expected rev #0, got: %s", out.String())
	}

	// 2. set live banner, theme, network, and pause tour
	out.Reset()
	errBuf.Reset()
	if code := Run([]string{
		"live", "set",
		"--url", srv.URL,
		"--token-file", tokenPath,
		"--banner", "Hello Live World",
		"--theme", "light",
		"--network", "sim-orbit",
		"--tour", "pause",
	}, &out, &errBuf); code != 0 {
		t.Fatalf("live set failed: code=%d stderr=%s", code, errBuf.String())
	}
	if strings.Contains(out.String(), testToken) || strings.Contains(errBuf.String(), testToken) {
		t.Fatalf("live set leaked bearer token in output")
	}
	if !strings.Contains(out.String(), "Hello Live World") || !strings.Contains(out.String(), "rev #1") {
		t.Fatalf("unexpected live set output: %s", out.String())
	}

	// 3. status reflects live change
	out.Reset()
	errBuf.Reset()
	if code := Run([]string{"live", "status", "--url", srv.URL, "--json"}, &out, &errBuf); code != 0 {
		t.Fatalf("live status --json failed: code=%d stderr=%s", code, errBuf.String())
	}
	var got liveSiteState
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v (%s)", err, out.String())
	}
	if got.Revision != 1 || got.Banner == nil || *got.Banner != "Hello Live World" || got.Theme == nil || *got.Theme != "light" {
		t.Fatalf("unexpected live status state: %+v", got)
	}

	// 4. reset clears overrides and bumps revision
	out.Reset()
	errBuf.Reset()
	if code := Run([]string{"live", "reset", "--url", srv.URL, "--token-file", tokenPath}, &out, &errBuf); code != 0 {
		t.Fatalf("live reset failed: code=%d stderr=%s", code, errBuf.String())
	}
	if !strings.Contains(out.String(), "rev #2") {
		t.Fatalf("expected rev #2 on reset, got: %s", out.String())
	}
}
