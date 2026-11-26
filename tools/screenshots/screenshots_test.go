package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestResolveCaptureSpecKnownAndFallback(t *testing.T) {
	defaults := DefaultRegionMap()

	// Known browser test maps to its row plus wide and mobile CDP panels.
	browserSpec := ResolveCaptureSpec(TestEntry{
		Name:   "TestBrowser01SignedOutContainment",
		Status: "pass",
	}, defaults, nil)
	if browserSpec.PagePath != "/" {
		t.Fatalf("PagePath = %q, want /", browserSpec.PagePath)
	}
	if len(browserSpec.Regions) < 3 {
		t.Fatalf("expected >= 3 regions for TestBrowser01SignedOutContainment, got %d", len(browserSpec.Regions))
	}

	// Structured log test uses /logs?test-id=<id> when a 32-hex ID is present.
	logSpec := ResolveCaptureSpec(TestEntry{
		Name:   "TestStructuredTestLogsIncludeTimestampLevelAndSource",
		TestID: "0123456789abcdef0123456789abcdef",
	}, defaults, nil)
	if logSpec.PagePath != "/logs?test-id=0123456789abcdef0123456789abcdef" {
		t.Fatalf("PagePath = %q, want /logs?test-id=...", logSpec.PagePath)
	}
	if len(logSpec.Regions) != 3 {
		t.Fatalf("expected 3 log regions, got %d", len(logSpec.Regions))
	}

	// Without a test-id, log test falls back to /logs table rather than broken /logs?test-id=.
	logFallback := ResolveCaptureSpec(TestEntry{
		Name:   "TestStructuredTestLogsIncludeTimestampLevelAndSource",
		TestID: "",
	}, defaults, nil)
	if logFallback.PagePath != "/logs" {
		t.Fatalf("PagePath = %q, want /logs", logFallback.PagePath)
	}

	// Undeclared tests must fall back cleanly with nil Regions (no overlay).
	for _, undeclared := range []string{"TestHelpListsEveryAction", "TestCompletelyUnknownFutureTest"} {
		spec := ResolveCaptureSpec(TestEntry{Name: undeclared}, defaults, nil)
		if len(spec.Regions) != 0 {
			t.Errorf("%s should have 0 declared regions for graceful fallback, got %+v", undeclared, spec.Regions)
		}
		if spec.PagePath != "/" {
			t.Errorf("%s PagePath = %q, want /", undeclared, spec.PagePath)
		}
	}
}

func TestLoadCustomRegionMapOverride(t *testing.T) {
	tmp := t.TempDir()
	mapPath := filepath.Join(tmp, "regions.json")
	raw := `{
  "TestCustomPanel": {
    "page_path": "/",
    "description": "Custom override test",
    "regions": [
      {"selector": "[data-testid=\"custom-box\"]", "label": "CUSTOM BOX", "color": "#2fd065"}
    ]
  }
}`
	if err := os.WriteFile(mapPath, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	overrides, err := LoadCustomRegionMap(mapPath)
	if err != nil {
		t.Fatal(err)
	}
	spec := ResolveCaptureSpec(TestEntry{Name: "TestCustomPanel"}, DefaultRegionMap(), overrides)
	if len(spec.Regions) != 1 || spec.Regions[0].Label != "CUSTOM BOX" {
		t.Fatalf("unexpected override spec: %+v", spec)
	}
}

func TestBuildInjectOverlayScriptFallbackAndRegions(t *testing.T) {
	emptyJS, err := BuildInjectOverlayScript("TestHelpListsEveryAction", "Help", "pass", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(emptyJS, "overlay_drawn: false") {
		t.Fatalf("empty overlay script must return overlay_drawn: false:\n%s", emptyJS)
	}
	if strings.Contains(emptyJS, "createElement") {
		t.Fatalf("empty overlay script must not create DOM overlay elements:\n%s", emptyJS)
	}

	annotatedJS, err := BuildInjectOverlayScript("TestDashboardReadsGeneratedState", "Dashboard", "pass", []RegionTarget{
		{Selector: `[data-testid="tests-db-table"]`, Label: "TESTS TABLE", Color: "#38bdf8"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"TestDashboardReadsGeneratedState", "TESTS TABLE", "dt-screenshot-overlay-root", "overlay_drawn: true"} {
		if !strings.Contains(annotatedJS, want) {
			t.Errorf("annotated overlay script missing %q", want)
		}
	}
}

func TestRenderGalleryHTMLContainsAnnotatedAndFallbackCards(t *testing.T) {
	manifest := &CaptureManifest{
		SchemaVersion:  1,
		LoopID:         "20261125-190000Z-abcdef",
		GeneratedAt:    "2026-11-25T19:00:00Z",
		DashboardURL:   "http://127.0.0.1:5174/",
		StableURL:      "https://test.dialtone.earth/screenshots/",
		GitBranch:      "feat/test-ui-annotated-screenshots",
		GitCommit:      "1234567890",
		Pipeline:       PipelineState{Stage: "staging_ready"},
		TotalShots:     3,
		OverviewShots:  1,
		TestShots:      2,
		AnnotatedShots: 1,
		FallbackShots:  1,
		Passed:         2,
		Shots: []ShotRecord{
			{
				ID:       "overview-dashboard",
				Kind:     "overview",
				Title:    "Test Dashboard Overview",
				PagePath: "/",
				Filename: "overview-dashboard.png",
				Bytes:    12345,
			},
			{
				ID:        "test-TestDashboardReadsGeneratedState",
				Kind:      "test",
				TestName:  "TestDashboardReadsGeneratedState",
				Title:     "Dashboard Reads Generated State",
				Status:    "pass",
				Elapsed:   "0.010",
				TestID:    "0123456789abcdef0123456789abcdef",
				PagePath:  "/",
				Filename:  "test-TestDashboardReadsGeneratedState.png",
				Bytes:     23456,
				Annotated: true,
				MatchedRegions: []MatchedRegion{
					{Selector: `[data-testid="tests-db-table"]`, Label: "TESTS TABLE", Color: "#38bdf8"},
				},
			},
			{
				ID:             "test-TestHelpListsEveryAction",
				Kind:           "test",
				TestName:       "TestHelpListsEveryAction",
				Title:          "Help Lists Every Action",
				Status:         "pass",
				PagePath:       "/",
				Filename:       "test-TestHelpListsEveryAction.png",
				Bytes:          19876,
				Annotated:      false,
				FallbackReason: "no UI region declared for test",
			},
		},
	}

	htmlOut := RenderGalleryHTML(manifest)
	for _, want := range []string{
		"20261125-190000Z-abcdef",
		"overview-dashboard.png",
		"test-TestDashboardReadsGeneratedState.png",
		"TESTS TABLE",
		"test-TestHelpListsEveryAction.png",
		"no UI region declared for test",
		"/logs?test-id=0123456789abcdef0123456789abcdef",
		"https://test.dialtone.earth/screenshots/",
	} {
		if !strings.Contains(htmlOut, want) {
			t.Errorf("gallery HTML missing %q", want)
		}
	}
	if strings.Contains(htmlOut, "\u2014") {
		t.Fatal("gallery HTML must not contain em-dashes")
	}
}

func TestPublishDryRunWritesPlanWithoutNetwork(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "overview-dashboard.png"), []byte("\x89PNG\r\n\x1a\nfake"))
	writeFile(t, filepath.Join(dir, "index.html"), []byte("<html>ok</html>"))
	writeFile(t, filepath.Join(dir, "manifest.json"), []byte(`{"loop_id":"loop-1"}`))

	manifest := &CaptureManifest{
		LoopID:      "loop-1",
		GeneratedAt: "2026-11-25T19:00:00Z",
		Shots: []ShotRecord{
			{ID: "overview-dashboard", Filename: "overview-dashboard.png"},
		},
	}

	var stdout bytes.Buffer
	plan, err := Publish(context.Background(), manifest, PublishOptions{
		OutputDir:   dir,
		PublishLive: false,
		PublishURL:  "https://test.dialtone.earth",
	}, &stdout)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != "dry-run" || plan.Published {
		t.Fatalf("expected dry-run unpublished plan, got %+v", plan)
	}
	if plan.StableURL != "https://test.dialtone.earth/screenshots/" {
		t.Fatalf("StableURL = %q", plan.StableURL)
	}
	if plan.FileCount != 3 {
		t.Fatalf("FileCount = %d, want 3", plan.FileCount)
	}
	if _, err := os.Stat(filepath.Join(dir, "publish-plan.json")); err != nil {
		t.Fatalf("expected publish-plan.json to be written: %v", err)
	}
}

func TestPublishLiveUploadsAndCommitsToMockWorker(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "overview-dashboard.png"), []byte("\x89PNG\r\n\x1a\npngdata"))
	writeFile(t, filepath.Join(dir, "index.html"), []byte("<html>gallery</html>"))
	writeFile(t, filepath.Join(dir, "manifest.json"), []byte(`{"loop_id":"loop-live-1"}`))

	const secret = "owner-test-token-123"
	uploaded := map[string][]byte{}
	var committed map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+secret {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/api/screenshots/latest/files/"):
			name := strings.TrimPrefix(r.URL.Path, "/api/screenshots/latest/files/")
			body, _ := io.ReadAll(r.Body)
			uploaded[name] = body
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/screenshots/latest/commit":
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &committed)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	manifest := &CaptureManifest{
		LoopID:      "loop-live-1",
		GeneratedAt: "2026-11-25T19:00:00Z",
		Shots: []ShotRecord{
			{ID: "overview-dashboard", Filename: "overview-dashboard.png"},
		},
	}

	var stdout bytes.Buffer
	plan, err := Publish(context.Background(), manifest, PublishOptions{
		OutputDir:   dir,
		PublishLive: true,
		PublishURL:  srv.URL,
		Token:       secret,
		HTTPClient:  srv.Client(),
	}, &stdout)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.Published || plan.Mode != "live" {
		t.Fatalf("expected published live plan, got %+v", plan)
	}
	for _, wantFile := range []string{"overview-dashboard.png", "index.html", "manifest.json"} {
		if len(uploaded[wantFile]) == 0 {
			t.Errorf("file %s was not uploaded to mock Worker", wantFile)
		}
	}
	if committed["loop_id"] != "loop-live-1" {
		t.Fatalf("commit payload missing loop_id: %+v", committed)
	}
}

func TestCaptureAllEndToEndWithHeadlessChromeAndOverwrite(t *testing.T) {
	if FindBrowserBinary("") == "" {
		t.Skip("no local Chrome/Chromium/Edge binary found for headless chromedp test")
	}

	mockUI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if strings.HasPrefix(r.URL.Path, "/logs") {
			_, _ = w.Write([]byte(`<!doctype html><html><body style="background:#0c0c0c;color:#fff;margin:0;padding:16px">
				<main class="log-page">
					<h1>Test Runs</h1>
					<table class="earth-table" style="width:100%"><tr><td>PASS</td><td>TestEachRunKeepsItsOwnLog</td></tr></table>
				</main>
			</body></html>`))
			return
		}
		_, _ = w.Write([]byte(`<!doctype html><html><body style="background:#0c0c0c;color:#fff;margin:0">
			<div class="hud-shell" data-testid="wm-shell" style="width:1440px;height:900px;display:flex;flex-direction:column">
				<div data-testid="split-grid" style="flex:1;display:grid;grid-template-columns:1fr 1fr">
					<section data-testid="wm-pane-0" style="padding:12px">
						<table data-testid="tests-db-table" style="width:100%">
							<tbody>
								<tr data-test-name="TestDashboardReadsGeneratedState"><td>PASS</td><td>Dashboard Reads Generated State</td></tr>
								<tr data-test-name="TestHelpListsEveryAction"><td>PASS</td><td>Help Lists Every Action</td></tr>
							</tbody>
						</table>
					</section>
					<section data-testid="wm-pane-1" style="padding:12px">Wide CDP Pane</section>
				</div>
				<footer data-testid="bottom-bar" style="padding:10px;border-top:1px solid #333">
					<div data-testid="pipeline-bar">1.EDIT -> 2.STAGING TESTS -> 3.READY</div>
					<button data-testid="start-tests">start tests</button>
					<button data-testid="open-menu" onclick="document.querySelector('[data-testid=menu-overlay]').hidden=false">menu</button>
				</footer>
				<section data-testid="menu-overlay" hidden style="position:fixed;inset:20px;background:#111;border:1px solid #444;padding:16px">
					<button data-testid="menu-done" onclick="document.querySelector('[data-testid=menu-overlay]').hidden=true">done</button>
					<div>Menu Overlay Content</div>
				</section>
			</div>
		</body></html>`))
	}))
	defer mockUI.Close()

	tmp := t.TempDir()
	outDir := filepath.Join(tmp, "screenshots", "latest")
	statePath := filepath.Join(tmp, "state.json")
	pipePath := filepath.Join(tmp, "pipeline.json")
	writeFile(t, pipePath, []byte(`{"stage":"staging_ready","message":"All passed","passed":2,"total":2}`))

	// Loop 1: one mapped test (annotated) + one undeclared test (clean fallback).
	state1 := TestState{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Tests: []TestEntry{
			{Name: "TestDashboardReadsGeneratedState", Title: "Dashboard Reads Generated State", Status: "pass", Elapsed: "0.010"},
			{Name: "TestHelpListsEveryAction", Title: "Help Lists Every Action", Status: "pass", Elapsed: "0.005"},
		},
	}
	raw1, _ := json.Marshal(state1)
	writeFile(t, statePath, raw1)

	var out bytes.Buffer
	m1, err := CaptureAll(context.Background(), CaptureOptions{
		DashboardURL: mockUI.URL,
		OutputDir:    outDir,
		StatePath:    statePath,
		PipelinePath: pipePath,
		Width:        1280,
		Height:       800,
		Timeout:      45 * time.Second,
	}, &out)
	if err != nil {
		t.Fatalf("CaptureAll loop 1 failed: %v\n%s", err, out.String())
	}
	if m1.OverviewShots != 3 || m1.TestShots != 2 || m1.AnnotatedShots != 1 || m1.FallbackShots != 1 {
		t.Fatalf("unexpected loop 1 counts: overview=%d test=%d annotated=%d fallback=%d",
			m1.OverviewShots, m1.TestShots, m1.AnnotatedShots, m1.FallbackShots)
	}
	for _, s := range m1.Shots {
		data, err := os.ReadFile(filepath.Join(outDir, s.Filename))
		if err != nil {
			t.Fatalf("missing screenshot %s: %v", s.Filename, err)
		}
		if len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
			t.Fatalf("file %s is not a valid PNG (len=%d)", s.Filename, len(data))
		}
	}

	// Loop 2: capture only TestDashboardReadsGeneratedState and verify stale file from Loop 1 is overwritten/removed.
	state2 := TestState{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Tests: []TestEntry{
			{Name: "TestDashboardReadsGeneratedState", Title: "Dashboard Reads Generated State", Status: "pass", Elapsed: "0.012"},
		},
	}
	raw2, _ := json.Marshal(state2)
	writeFile(t, statePath, raw2)

	m2, err := CaptureAll(context.Background(), CaptureOptions{
		DashboardURL: mockUI.URL,
		OutputDir:    outDir,
		StatePath:    statePath,
		PipelinePath: pipePath,
		Width:        1280,
		Height:       800,
		Timeout:      45 * time.Second,
	}, &out)
	if err != nil {
		t.Fatalf("CaptureAll loop 2 failed: %v", err)
	}
	if m2.LoopID == m1.LoopID {
		t.Fatalf("loop 2 reused loop 1 ID: %s", m2.LoopID)
	}
	staleFile := filepath.Join(outDir, "test-TestHelpListsEveryAction.png")
	if _, err := os.Stat(staleFile); !os.IsNotExist(err) {
		t.Fatalf("stale screenshot from loop 1 was not removed on overwrite: %s", staleFile)
	}
	if _, err := os.Stat(filepath.Join(outDir, "index.html")); err != nil {
		t.Fatalf("index.html missing after loop 2: %v", err)
	}
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}
