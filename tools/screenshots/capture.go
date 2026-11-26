package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/chromedp/chromedp"
)

// TestState mirrors logs/state.json written by the root CLI.
type TestState struct {
	GeneratedAt string      `json:"generated_at"`
	Tests       []TestEntry `json:"tests"`
}

// TestEntry mirrors one test entry in logs/state.json.
type TestEntry struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Section     string `json:"section,omitempty"`
	Source      string `json:"source,omitempty"`
	Status      string `json:"status"`
	Elapsed     string `json:"elapsed"`
	LastElapsed string `json:"last_elapsed,omitempty"`
	Timestamp   string `json:"timestamp"`
	TestID      string `json:"test-id"`
}

// PipelineState mirrors logs/pipeline.json written by the root CLI.
type PipelineState struct {
	Stage        string `json:"stage"`
	Message      string `json:"message"`
	Changed      string `json:"changed,omitempty"`
	TargetOrigin string `json:"target_origin,omitempty"`
	DeployURL    string `json:"deploy_url,omitempty"`
	VersionID    string `json:"version_id,omitempty"`
	TestedHash   string `json:"tested_hash,omitempty"`
	DeployedHash string `json:"deployed_hash,omitempty"`
	Passed       int    `json:"passed"`
	Failed       int    `json:"failed"`
	Total        int    `json:"total"`
	UpdatedAt    string `json:"updated_at"`
}

// ShotRecord captures metadata for one overview or per-test screenshot.
type ShotRecord struct {
	ID              string          `json:"id"`
	Kind            string          `json:"kind"`
	TestName        string          `json:"test_name,omitempty"`
	Title           string          `json:"title"`
	Section         string          `json:"section,omitempty"`
	Source          string          `json:"source,omitempty"`
	Status          string          `json:"status,omitempty"`
	Elapsed         string          `json:"elapsed,omitempty"`
	TestID          string          `json:"test_id,omitempty"`
	PagePath        string          `json:"page_path"`
	Action          string          `json:"action,omitempty"`
	Description     string          `json:"description,omitempty"`
	Filename        string          `json:"filename"`
	SHA256          string          `json:"sha256"`
	Bytes           int             `json:"bytes"`
	DeclaredRegions []RegionTarget  `json:"declared_regions,omitempty"`
	MatchedRegions  []MatchedRegion `json:"matched_regions,omitempty"`
	MissedRegions   []string        `json:"missed_regions,omitempty"`
	Annotated       bool            `json:"annotated"`
	FallbackReason  string          `json:"fallback_reason,omitempty"`
	CapturedAt      string          `json:"captured_at"`
}

// CaptureManifest is written to manifest.json and drives index.html and publishing.
type CaptureManifest struct {
	SchemaVersion  int           `json:"schema_version"`
	LoopID         string        `json:"loop_id"`
	GeneratedAt    string        `json:"generated_at"`
	DashboardURL   string        `json:"dashboard_url"`
	StableURL      string        `json:"stable_url"`
	GitBranch      string        `json:"git_branch,omitempty"`
	GitCommit      string        `json:"git_commit,omitempty"`
	ViewportWidth  int           `json:"viewport_width"`
	ViewportHeight int           `json:"viewport_height"`
	Pipeline       PipelineState `json:"pipeline"`
	TotalShots     int           `json:"total_shots"`
	OverviewShots  int           `json:"overview_shots"`
	TestShots      int           `json:"test_shots"`
	AnnotatedShots int           `json:"annotated_shots"`
	FallbackShots  int           `json:"fallback_shots"`
	Passed         int           `json:"passed"`
	Failed         int           `json:"failed"`
	Skipped        int           `json:"skipped"`
	Shots          []ShotRecord  `json:"shots"`
}

// CaptureOptions configures a headless Chrome screenshot capture run.
type CaptureOptions struct {
	DashboardURL  string
	OutputDir     string
	StatePath     string
	PipelinePath  string
	Filter        string
	MapFile       string
	ChromeBin     string
	StableURL     string
	Width         int
	Height        int
	Timeout       time.Duration
	SkipOverviews bool
	RepoRoot      string
}

// FindBrowserBinary locates a Chromium-based binary for chromedp.
func FindBrowserBinary(override string) string {
	candidates := []string{
		strings.TrimSpace(override),
		strings.TrimSpace(os.Getenv("CHROME_BIN")),
		strings.TrimSpace(os.Getenv("CHROMIUM_BIN")),
	}
	switch runtime.GOOS {
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		candidates = append(candidates,
			`C:\Program Files\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
			filepath.Join(localAppData, `Google\Chrome\Application\chrome.exe`),
			`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
			`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		)
	case "darwin":
		candidates = append(candidates,
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		)
	default:
		for _, bin := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"} {
			if p, err := exec.LookPath(bin); err == nil {
				candidates = append(candidates, p)
			}
		}
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c
		}
	}
	return ""
}

func loadTestState(path string) (TestState, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return TestState{}, fmt.Errorf("read test state %s: %w", path, err)
	}
	var st TestState
	if err := json.Unmarshal(raw, &st); err != nil {
		return TestState{}, fmt.Errorf("parse test state %s: %w", path, err)
	}
	return st, nil
}

func loadPipelineState(path string) PipelineState {
	var p PipelineState
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &p)
	}
	return p
}

func newLoopID() string {
	var buf [6]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return time.Now().UTC().Format("20060102T150405Z")
	}
	return time.Now().UTC().Format("20060102-150405Z") + "-" + hex.EncodeToString(buf[:])
}

func gitMetadata(root string) (branch, commit string) {
	if strings.TrimSpace(root) == "" {
		return "", ""
	}
	runGit := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		out, err := cmd.Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	return runGit("rev-parse", "--abbrev-ref", "HEAD"), runGit("rev-parse", "--short=10", "HEAD")
}

func checkDashboardReachable(ctx context.Context, baseURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/", nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("test dashboard at %s is not reachable (start it with `go run . dev --port 5174`): %w", baseURL, err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("test dashboard at %s returned HTTP %d", baseURL, resp.StatusCode)
	}
	return nil
}

// CaptureAll drives headless Chrome with chromedp to capture overview and
// per-test annotated screenshots, then atomically replaces opts.OutputDir.
func CaptureAll(ctx context.Context, opts CaptureOptions, stdout io.Writer) (*CaptureManifest, error) {
	if stdout == nil {
		stdout = io.Discard
	}
	if opts.Width <= 0 {
		opts.Width = 1440
	}
	if opts.Height <= 0 {
		opts.Height = 900
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 120 * time.Second
	}
	opts.DashboardURL = strings.TrimRight(strings.TrimSpace(opts.DashboardURL), "/")
	if opts.DashboardURL == "" {
		opts.DashboardURL = "http://127.0.0.1:5174"
	}
	if strings.TrimSpace(opts.OutputDir) == "" {
		return nil, errors.New("output directory is required")
	}

	var filterRe *regexp.Regexp
	if strings.TrimSpace(opts.Filter) != "" {
		var err error
		filterRe, err = regexp.Compile(opts.Filter)
		if err != nil {
			return nil, fmt.Errorf("invalid --filter regexp %q: %w", opts.Filter, err)
		}
	}

	state, err := loadTestState(opts.StatePath)
	if err != nil {
		return nil, err
	}
	pipeline := loadPipelineState(opts.PipelinePath)
	defaults := DefaultRegionMap()
	overrides, err := LoadCustomRegionMap(opts.MapFile)
	if err != nil {
		return nil, err
	}

	runCtx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()

	if err := checkDashboardReachable(runCtx, opts.DashboardURL); err != nil {
		return nil, err
	}

	var selected []TestEntry
	for _, entry := range state.Tests {
		if filterRe != nil && !filterRe.MatchString(entry.Name) {
			continue
		}
		selected = append(selected, entry)
	}

	absOut, err := filepath.Abs(opts.OutputDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(absOut), 0o755); err != nil {
		return nil, err
	}
	stagingDir := absOut + ".staging"
	if err := os.RemoveAll(stagingDir); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		return nil, err
	}
	defer os.RemoveAll(stagingDir)

	allocOpts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", "new"),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("hide-scrollbars", false),
		chromedp.Flag("mute-audio", true),
		chromedp.WindowSize(opts.Width, opts.Height),
	)
	if chromeBin := FindBrowserBinary(opts.ChromeBin); chromeBin != "" {
		allocOpts = append(allocOpts, chromedp.ExecPath(chromeBin))
	}

	allocCtx, allocCancel := chromedp.NewExecAllocator(runCtx, allocOpts...)
	defer allocCancel()
	browserCtx, browserCancel := chromedp.NewContext(allocCtx)
	defer browserCancel()

	branch, commit := gitMetadata(opts.RepoRoot)
	stableURL := strings.TrimSpace(opts.StableURL)
	if stableURL == "" {
		stableURL = "https://test.dialtone.earth/screenshots/"
	}

	manifest := &CaptureManifest{
		SchemaVersion:  1,
		LoopID:         newLoopID(),
		GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
		DashboardURL:   opts.DashboardURL + "/",
		StableURL:      stableURL,
		GitBranch:      branch,
		GitCommit:      commit,
		ViewportWidth:  opts.Width,
		ViewportHeight: opts.Height,
		Pipeline:       pipeline,
	}

	currentPath := ""
	menuCurrentlyOpen := false

	navigateAndPrepare := func(pagePath, waitSelector, action string) error {
		targetURL := opts.DashboardURL + pagePath
		if currentPath != pagePath {
			if err := chromedp.Do(browserCtx,
				chromedp.EmulateViewport(int64(opts.Width), int64(opts.Height)),
				chromedp.Navigate(targetURL),
				chromedp.WaitReady("body"),
			); err != nil {
				return fmt.Errorf("navigate %s: %w", targetURL, err)
			}
			currentPath = pagePath
			menuCurrentlyOpen = false
			// Wait for initial UI hydration (dashboard polls /api/tests on mount).
			waitSel := waitSelector
			if waitSel == "" || action == "open-menu" {
				waitSel = `[data-testid="wm-shell"]`
			}
			if err := waitForSelectorBounded(browserCtx, waitSel, 6*time.Second); err != nil {
				// Continue gracefully if a secondary element is still absent (e.g. empty state).
				_ = waitForSelectorBounded(browserCtx, "body", 2*time.Second)
			}
			// Give the table/layout one brief settle tick after API fetch.
			time.Sleep(350 * time.Millisecond)
		}

		// Sync menu overlay state on root page.
		if pagePath == "/" {
			if action == "open-menu" && !menuCurrentlyOpen {
				opened, _ := chromedp.Run(browserCtx, chromedp.Evaluate[bool](`(() => {
					const btn = document.querySelector('[data-testid="open-menu"]');
					const overlay = document.querySelector('[data-testid="menu-overlay"]');
					if (overlay && !overlay.hidden) return true;
					if (btn) { btn.click(); return true; }
					return false;
				})()`))
				if opened {
					menuCurrentlyOpen = true
					_ = waitForSelectorBounded(browserCtx, `[data-testid="menu-overlay"]:not([hidden])`, 2*time.Second)
					time.Sleep(150 * time.Millisecond)
				}
			} else if action != "open-menu" && menuCurrentlyOpen {
				closed, _ := chromedp.Run(browserCtx, chromedp.Evaluate[bool](`(() => {
					const done = document.querySelector('[data-testid="menu-done"]');
					const overlay = document.querySelector('[data-testid="menu-overlay"]');
					if (!overlay || overlay.hidden) return true;
					if (done) { done.click(); return true; }
					const btn = document.querySelector('[data-testid="open-menu"]');
					if (btn) { btn.click(); return true; }
					return false;
				})()`))
				if closed {
					menuCurrentlyOpen = false
					time.Sleep(150 * time.Millisecond)
				}
			}
		}

		if waitSelector != "" && action != "open-menu" {
			_ = waitForSelectorBounded(browserCtx, waitSelector, 3*time.Second)
		}
		return nil
	}

	writeShotPNG := func(filename string, pngBytes []byte) (string, error) {
		sum := sha256.Sum256(pngBytes)
		dest := filepath.Join(stagingDir, filename)
		if err := os.WriteFile(dest, pngBytes, 0o644); err != nil {
			return "", err
		}
		return hex.EncodeToString(sum[:]), nil
	}

	// 1. Capture clean overview pages.
	if !opts.SkipOverviews {
		for _, ov := range DefaultOverviewSpecs() {
			if err := navigateAndPrepare(ov.PagePath, ov.WaitSelector, ov.Action); err != nil {
				return nil, fmt.Errorf("overview %s: %w", ov.ID, err)
			}
			if _, err := chromedp.Run(browserCtx, chromedp.Evaluate[chromedp.Void](BuildClearOverlayScript())); err != nil {
				return nil, fmt.Errorf("clear overlay for overview %s: %w", ov.ID, err)
			}
			if _, err := chromedp.Run(browserCtx, chromedp.Sleep(80*time.Millisecond)); err != nil {
				return nil, fmt.Errorf("sleep for overview %s: %w", ov.ID, err)
			}
			pngBytes, err := chromedp.Run(browserCtx, chromedp.CaptureScreenshot())
			if err != nil {
				return nil, fmt.Errorf("capture overview %s: %w", ov.ID, err)
			}
			filename := SafeShotFilename("", ov.ID)
			digest, err := writeShotPNG(filename, pngBytes)
			if err != nil {
				return nil, err
			}
			manifest.Shots = append(manifest.Shots, ShotRecord{
				ID:          ov.ID,
				Kind:        "overview",
				Title:       ov.Title,
				PagePath:    ov.PagePath,
				Action:      ov.Action,
				Description: ov.Description,
				Filename:    filename,
				SHA256:      digest,
				Bytes:       len(pngBytes),
				Annotated:   false,
				CapturedAt:  time.Now().UTC().Format(time.RFC3339),
			})
			manifest.OverviewShots++
			fmt.Fprintf(stdout, "screenshots: captured overview %s -> %s (%d bytes)\n", ov.ID, filename, len(pngBytes))
		}
	}

	// 2. Plan per-test captures and group by PagePath + Action to minimize navigations.
	type plannedTest struct {
		index int
		entry TestEntry
		spec  TestCaptureSpec
	}
	planned := make([]plannedTest, 0, len(selected))
	for i, entry := range selected {
		planned = append(planned, plannedTest{
			index: i,
			entry: entry,
			spec:  ResolveCaptureSpec(entry, defaults, overrides),
		})
	}
	sort.SliceStable(planned, func(i, j int) bool {
		ki := planned[i].spec.PagePath + "|" + planned[i].spec.Action
		kj := planned[j].spec.PagePath + "|" + planned[j].spec.Action
		if ki != kj {
			return ki < kj
		}
		return planned[i].index < planned[j].index
	})

	capturedTests := make([]ShotRecord, len(selected))
	for _, item := range planned {
		entry := item.entry
		spec := item.spec

		if err := navigateAndPrepare(spec.PagePath, spec.WaitSelector, spec.Action); err != nil {
			return nil, fmt.Errorf("test %s (%s): %w", entry.Name, spec.PagePath, err)
		}

		overlayJS, err := BuildInjectOverlayScript(entry.Name, entry.Title, entry.Status, spec.Regions)
		if err != nil {
			return nil, err
		}

		overlayRes, err := chromedp.Run(browserCtx, chromedp.Evaluate[OverlayResult](overlayJS))
		if err != nil {
			return nil, fmt.Errorf("inject overlay for test %s: %w", entry.Name, err)
		}
		if _, err := chromedp.Run(browserCtx, chromedp.Sleep(60*time.Millisecond)); err != nil {
			return nil, fmt.Errorf("sleep for test %s: %w", entry.Name, err)
		}
		pngBytes, err := chromedp.Run(browserCtx, chromedp.CaptureScreenshot())
		if err != nil {
			return nil, fmt.Errorf("capture test %s: %w", entry.Name, err)
		}

		filename := SafeShotFilename("test", entry.Name)
		digest, err := writeShotPNG(filename, pngBytes)
		if err != nil {
			return nil, err
		}

		fallbackReason := ""
		if len(spec.Regions) == 0 {
			fallbackReason = "no UI region declared for test"
		} else if !overlayRes.OverlayDrawn {
			fallbackReason = "declared selector(s) not visible in current DOM; skipped overlay"
		}

		rec := ShotRecord{
			ID:              "test-" + entry.Name,
			Kind:            "test",
			TestName:        entry.Name,
			Title:           entry.Title,
			Section:         entry.Section,
			Source:          entry.Source,
			Status:          entry.Status,
			Elapsed:         entry.Elapsed,
			TestID:          entry.TestID,
			PagePath:        spec.PagePath,
			Action:          spec.Action,
			Description:     spec.Description,
			Filename:        filename,
			SHA256:          digest,
			Bytes:           len(pngBytes),
			DeclaredRegions: spec.Regions,
			MatchedRegions:  overlayRes.Matched,
			MissedRegions:   overlayRes.Missed,
			Annotated:       overlayRes.OverlayDrawn,
			FallbackReason:  fallbackReason,
			CapturedAt:      time.Now().UTC().Format(time.RFC3339),
		}
		capturedTests[item.index] = rec

		switch strings.ToLower(entry.Status) {
		case "pass":
			manifest.Passed++
		case "fail":
			manifest.Failed++
		case "skip":
			manifest.Skipped++
		}
		manifest.TestShots++
		if rec.Annotated {
			manifest.AnnotatedShots++
		} else {
			manifest.FallbackShots++
		}
	}

	// Restore source test order in the final manifest and gallery.
	manifest.Shots = append(manifest.Shots, capturedTests...)
	manifest.TotalShots = len(manifest.Shots)

	// Write manifest.json and index.html into stagingDir before atomic directory swap.
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "manifest.json"), append(manifestBytes, '\n'), 0o644); err != nil {
		return nil, err
	}
	galleryHTML := RenderGalleryHTML(manifest)
	if err := os.WriteFile(filepath.Join(stagingDir, "index.html"), []byte(galleryHTML), 0o644); err != nil {
		return nil, err
	}

	if err := replaceDirectory(stagingDir, absOut); err != nil {
		return nil, fmt.Errorf("replace output directory %s: %w", absOut, err)
	}

	fmt.Fprintf(stdout, "screenshots: loop %s ready at %s (%d total: %d overview, %d annotated, %d clean fallback)\n",
		manifest.LoopID, absOut, manifest.TotalShots, manifest.OverviewShots, manifest.AnnotatedShots, manifest.FallbackShots)
	return manifest, nil
}

func waitForSelectorBounded(ctx context.Context, selector string, maxWait time.Duration) error {
	deadline := time.Now().Add(maxWait)
	for time.Now().Before(deadline) {
		exists, err := chromedp.Run(ctx, chromedp.Evaluate[bool](
			fmt.Sprintf(`Boolean(document.querySelector(%q))`, selector),
		))
		if err == nil && exists {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("timed out waiting for selector %q", selector)
}

// replaceDirectory swaps stagingDir into targetDir cleanly so each new test
// loop overwrites the previous screenshot set with no stale leftover files.
func replaceDirectory(stagingDir, targetDir string) error {
	backupDir := targetDir + ".prev"
	_ = os.RemoveAll(backupDir)

	hadPrev := false
	if _, err := os.Stat(targetDir); err == nil {
		hadPrev = true
		if err := renameWithRetry(targetDir, backupDir); err != nil {
			return err
		}
	}
	if err := renameWithRetry(stagingDir, targetDir); err != nil {
		if hadPrev {
			_ = renameWithRetry(backupDir, targetDir)
		}
		return err
	}
	if hadPrev {
		_ = os.RemoveAll(backupDir)
	}
	return nil
}

func renameWithRetry(src, dst string) error {
	var lastErr error
	for attempt := 0; attempt < 10; attempt++ {
		if err := os.Rename(src, dst); err == nil {
			return nil
		} else {
			lastErr = err
		}
		time.Sleep(time.Duration(attempt+1) * 40 * time.Millisecond)
	}
	return lastErr
}
