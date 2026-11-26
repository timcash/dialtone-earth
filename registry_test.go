package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDialtoneEarthRegistryCLI(t *testing.T) {
	const secret = "test-registry-bearer-token"
	var storedPlugin map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/code":
			if r.Header.Get("Authorization") != "Bearer "+secret {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
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

	t.Setenv("DIALTONE_LIVE_TOKEN", secret)
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

func TestDialtoneEarthLiveOwnerAccessOnCloudflare(t *testing.T) {
	if os.Getenv("DIALTONE_LIVE_CLOUDFLARE_E2E") != "1" {
		t.Skip("set DIALTONE_LIVE_CLOUDFLARE_E2E=1 (or run `dialtone-earth test --browser`) to verify live owner-only security on https://dialtone.earth/")
	}
	base := "https://dialtone.earth"
	client := &http.Client{Timeout: 15 * time.Second}

	// 1. Anonymous & forged credentials must be rejected (401) across private git repo and all write endpoints.
	deniedChecks := []struct {
		method string
		path   string
		auth   string
		body   string
	}{
		{http.MethodGet, "/api/code", "", ""},
		{http.MethodGet, "/api/code/dialtone-earth", "", ""},
		{http.MethodGet, "/api/code/dialtone-earth/bundle", "", ""},
		{http.MethodGet, "/api/code/dialtone-earth/archive/main.tar.gz", "", ""},
		{http.MethodGet, "/api/code", "Bearer invalid-attacker-token", ""},
		{http.MethodPut, "/api/code/dialtone-earth/push", "Bearer invalid-attacker-token", "hijack"},
		{http.MethodPatch, "/api/live", "", `{"banner":"hijack"}`},
		{http.MethodPatch, "/api/live", "Bearer invalid-attacker-token", `{"banner":"hijack"}`},
		{http.MethodPost, "/api/releases/dialtone-earth/v9.9.9", "", `{"sha":"deadbeef1234"}`},
		{http.MethodPut, "/api/plugins/unauthorized-probe", "", `{"version":"1.0.0"}`},
	}
	for _, chk := range deniedChecks {
		var bodyReader io.Reader
		if chk.body != "" {
			bodyReader = strings.NewReader(chk.body)
		}
		req, err := http.NewRequest(chk.method, base+chk.path, bodyReader)
		if err != nil {
			t.Fatal(err)
		}
		if chk.auth != "" {
			req.Header.Set("Authorization", chk.auth)
		}
		if chk.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s request failed: %v", chk.method, chk.path, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("LIVE SECURITY FAILURE: %s %s (auth=%q) returned HTTP %d, want 401", chk.method, chk.path, chk.auth, resp.StatusCode)
		}
	}

	// 2. Apex /login must be enabled for timcash@gmail.com magic-link login.
	loginResp, err := client.Get(base + "/login")
	if err != nil {
		t.Fatalf("GET /login failed: %v", err)
	}
	loginHTML, _ := io.ReadAll(io.LimitReader(loginResp.Body, 1<<20))
	_ = loginResp.Body.Close()
	if loginResp.StatusCode != http.StatusOK || !strings.Contains(string(loginHTML), `name="email"`) {
		t.Fatalf("GET /login unexpected status=%d (magic-link login form not enabled on dialtone.earth)", loginResp.StatusCode)
	}

	// 3. Owner token (timcash@gmail.com) CAN read the private git repo and bundle on https://dialtone.earth/.
	token, err := loadLiveControlToken("")
	if err != nil {
		t.Fatalf("local owner token required for positive live verification: %v", err)
	}
	reqList, _ := http.NewRequest(http.MethodGet, base+"/api/code", nil)
	reqList.Header.Set("Authorization", "Bearer "+token)
	respList, err := client.Do(reqList)
	if err != nil {
		t.Fatalf("owner GET /api/code failed: %v", err)
	}
	rawList, _ := io.ReadAll(io.LimitReader(respList.Body, 1<<20))
	_ = respList.Body.Close()
	if respList.StatusCode != http.StatusOK || !strings.Contains(string(rawList), `"dialtone-earth"`) {
		t.Fatalf("owner GET /api/code failed: HTTP %d\n%s", respList.StatusCode, string(rawList))
	}

	reqHead, _ := http.NewRequest(http.MethodGet, base+"/api/code/dialtone-earth", nil)
	reqHead.Header.Set("Authorization", "Bearer "+token)
	respHead, err := client.Do(reqHead)
	if err != nil {
		t.Fatalf("owner GET /api/code/dialtone-earth failed: %v", err)
	}
	_ = respHead.Body.Close()
	if respHead.StatusCode != http.StatusOK {
		t.Fatalf("owner GET /api/code/dialtone-earth returned HTTP %d, want 200", respHead.StatusCode)
	}

	// 4. Live test.dialtone.earth: anonymous / , /code , /logs must redirect 302 -> /login;
	//    anonymous /api/code and /api/tests must return 401; /login must load the spinning H3 globe.
	stagingBase := "https://test.dialtone.earth"
	noRedirectClient := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	for _, pagePath := range []string{"/", "/code", "/logs"} {
		resp, err := noRedirectClient.Get(stagingBase + pagePath)
		if err != nil {
			t.Fatalf("anon GET %s%s failed: %v", stagingBase, pagePath, err)
		}
		_ = resp.Body.Close()
		loc := resp.Header.Get("Location")
		if resp.StatusCode != http.StatusFound || loc != "/login" {
			t.Fatalf("LIVE STAGING SECURITY FAILURE: anon GET %s%s returned HTTP %d Location=%q, want 302 /login", stagingBase, pagePath, resp.StatusCode, loc)
		}
	}
	for _, apiPath := range []string{"/api/code", "/api/tests"} {
		resp, err := noRedirectClient.Get(stagingBase + apiPath)
		if err != nil {
			t.Fatalf("anon GET %s%s failed: %v", stagingBase, apiPath, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("LIVE STAGING SECURITY FAILURE: anon GET %s%s returned HTTP %d, want 401", stagingBase, apiPath, resp.StatusCode)
		}
	}

	stagingLoginResp, err := client.Get(stagingBase + "/login")
	if err != nil {
		t.Fatalf("GET %s/login failed: %v", stagingBase, err)
	}
	stagingLoginHTML, _ := io.ReadAll(io.LimitReader(stagingLoginResp.Body, 1<<20))
	_ = stagingLoginResp.Body.Close()
	if stagingLoginResp.StatusCode != http.StatusOK ||
		!strings.Contains(string(stagingLoginHTML), `id="auth-globe-stage"`) ||
		!strings.Contains(string(stagingLoginHTML), `src="/auth-globe.js"`) {
		t.Fatalf("GET %s/login missing spinning H3 globe markup (HTTP %d)", stagingBase, stagingLoginResp.StatusCode)
	}
	globeResp, err := client.Get(stagingBase + "/auth-globe.js")
	if err != nil {
		t.Fatalf("GET %s/auth-globe.js failed: %v", stagingBase, err)
	}
	_ = globeResp.Body.Close()
	if globeResp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s/auth-globe.js returned HTTP %d, want 200", stagingBase, globeResp.StatusCode)
	}

	// 5. Owner-authenticated /code, /api/code, /logs, and /api/tests on https://test.dialtone.earth/
	//    must serve the private R2 code portal, repo metadata, and live test logs.
	reqCodePortal, _ := http.NewRequest(http.MethodGet, stagingBase+"/code", nil)
	reqCodePortal.Header.Set("Authorization", "Bearer "+token)
	respCodePortal, err := noRedirectClient.Do(reqCodePortal)
	if err != nil {
		t.Fatalf("owner GET %s/code failed: %v", stagingBase, err)
	}
	codePortalBody, _ := io.ReadAll(io.LimitReader(respCodePortal.Body, 1<<20))
	_ = respCodePortal.Body.Close()
	if respCodePortal.StatusCode != http.StatusOK ||
		!strings.Contains(string(codePortalBody), "DIALTONE // CODE") ||
		!strings.Contains(string(codePortalBody), "dialtone-earth") ||
		!strings.Contains(string(codePortalBody), "/api/code/dialtone-earth/bundle") {
		t.Fatalf("owner GET %s/code failed verification: HTTP %d", stagingBase, respCodePortal.StatusCode)
	}

	reqStagingCodeApi, _ := http.NewRequest(http.MethodGet, stagingBase+"/api/code", nil)
	reqStagingCodeApi.Header.Set("Authorization", "Bearer "+token)
	respStagingCodeApi, err := noRedirectClient.Do(reqStagingCodeApi)
	if err != nil {
		t.Fatalf("owner GET %s/api/code failed: %v", stagingBase, err)
	}
	stagingCodeApiBody, _ := io.ReadAll(io.LimitReader(respStagingCodeApi.Body, 1<<20))
	_ = respStagingCodeApi.Body.Close()
	if respStagingCodeApi.StatusCode != http.StatusOK || !strings.Contains(string(stagingCodeApiBody), `"dialtone-earth"`) {
		t.Fatalf("owner GET %s/api/code failed: HTTP %d\n%s", stagingBase, respStagingCodeApi.StatusCode, string(stagingCodeApiBody))
	}

	reqLogsPage, _ := http.NewRequest(http.MethodGet, stagingBase+"/logs", nil)
	reqLogsPage.Header.Set("Authorization", "Bearer "+token)
	respLogsPage, err := noRedirectClient.Do(reqLogsPage)
	if err != nil {
		t.Fatalf("owner GET %s/logs failed: %v", stagingBase, err)
	}
	logsPageBody, _ := io.ReadAll(io.LimitReader(respLogsPage.Body, 1<<20))
	_ = respLogsPage.Body.Close()
	if respLogsPage.StatusCode != http.StatusOK || !strings.Contains(strings.ToLower(string(logsPageBody)), "<html") {
		t.Fatalf("owner GET %s/logs failed: HTTP %d", stagingBase, respLogsPage.StatusCode)
	}

	reqStagingTests, _ := http.NewRequest(http.MethodGet, stagingBase+"/api/tests", nil)
	reqStagingTests.Header.Set("Authorization", "Bearer "+token)
	respStagingTests, err := noRedirectClient.Do(reqStagingTests)
	if err != nil {
		t.Fatalf("owner GET %s/api/tests failed: %v", stagingBase, err)
	}
	stagingTestsBody, _ := io.ReadAll(io.LimitReader(respStagingTests.Body, 1<<20))
	_ = respStagingTests.Body.Close()
	if respStagingTests.StatusCode != http.StatusOK || !strings.Contains(string(stagingTestsBody), `"tests"`) {
		t.Fatalf("owner GET %s/api/tests failed: HTTP %d", stagingBase, respStagingTests.StatusCode)
	}
}
