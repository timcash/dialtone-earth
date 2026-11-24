package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDialtoneEarthRegistryCLI(t *testing.T) {
	const secret = "test-registry-bearer-token"
	var storedPlugin map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/code":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"repos":[{"name":"dialtone-earth","default_branch":"main","head_sha":"abcdef123456","head_subject":"cloudflare vcs","tags":["v0.6.0"]}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/releases/dialtone-earth":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"repo":"dialtone-earth","releases":[{"tag":"v0.6.0","sha":"abcdef123456","notes":"cf release","download_base":"https://dialtone.earth/releases/dialtone-earth/download/v0.6.0","assets":{"dialtone-earth-linux-amd64":{}}}]}`))
		case r.Method == http.MethodPut && r.URL.Path == "/api/plugins/dialtone-shell":
			if r.Header.Get("Authorization") != "Bearer "+secret {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &storedPlugin)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/plugins":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"plugins":[{"name":"dialtone-shell","version":"0.5.5","description":"Persistent Iroh remote shell","protocols":["dialtone/shell/1"],"iroh_ticket":"blob-ticket-123","bytes":455168}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	var stdout, stderr bytes.Buffer
	if code := Run([]string{"code", "list", "--url", srv.URL}, &stdout, &stderr); code != 0 {
		t.Fatalf("code list failed (%d): %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "dialtone-earth") || !strings.Contains(stdout.String(), "tags=1") {
		t.Fatalf("unexpected code list output:\n%s", stdout.String())
	}

	stdout.Reset()
	stderr.Reset()
	if code := Run([]string{"release", "list", "--repo", "dialtone-earth", "--url", srv.URL}, &stdout, &stderr); code != 0 {
		t.Fatalf("release list failed (%d): %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "v0.6.0") {
		t.Fatalf("unexpected release list output:\n%s", stdout.String())
	}

	t.Setenv("DIALTONE_LIVE_TOKEN", secret)
	stdout.Reset()
	stderr.Reset()
	if code := Run([]string{"plugins", "publish", "dialtone-shell", "--version", "0.5.5", "--protocols", "dialtone/shell/1", "--description", "Persistent Iroh remote shell", "--ticket", "blob-ticket-123", "--url", srv.URL}, &stdout, &stderr); code != 0 {
		t.Fatalf("plugins publish failed (%d): %s", code, stderr.String())
	}
	if storedPlugin["version"] != "0.5.5" || storedPlugin["iroh_ticket"] != "blob-ticket-123" {
		t.Fatalf("unexpected stored plugin payload: %+v", storedPlugin)
	}

	stdout.Reset()
	stderr.Reset()
	if code := Run([]string{"plugins", "list", "--url", srv.URL}, &stdout, &stderr); code != 0 {
		t.Fatalf("plugins list failed (%d): %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "dialtone-shell") || !strings.Contains(stdout.String(), "dialtone/shell/1") {
		t.Fatalf("unexpected plugins list output:\n%s", stdout.String())
	}
}
