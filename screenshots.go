package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const screenshotsUsage = `usage: dialtone-earth screenshots [flags]

Capture annotated screenshots of the test UI (dashboard, menu, logs, and
per-test highlighted regions) using headless Chrome (chromedp), overwriting the
latest stable-link gallery on every test loop.

Defaults to local dry-run mode (logs/screenshots/latest/ and /screenshots/ on
the local test dashboard). Live upload to Cloudflare R2 requires the explicit
--publish-live flag and owner authentication.

Flags:
  --dashboard-url <url>   Test dashboard base URL (default: http://127.0.0.1:5174)
  --output-dir <dir>      Output directory overwritten per loop (default: logs/screenshots/latest)
  --state <path>          Path to logs/state.json (default: logs/state.json)
  --pipeline <path>       Path to logs/pipeline.json (default: logs/pipeline.json)
  --filter <regexp>       Optional regexp filtering test names to capture
  --map-file <path>       Optional JSON file overriding test-to-UI-region mappings
  --chrome-bin <path>     Optional Chrome/Chromium/Edge binary path
  --width <px>            Viewport width in pixels (default: 1440)
  --height <px>           Viewport height in pixels (default: 900)
  --timeout <dur>         Overall capture timeout (default: 2m)
  --skip-overviews        Skip overview pages (dashboard, menu, logs)
  --publish-live          Explicitly upload to Cloudflare R2 via Worker (default: false, dry-run)
  --publish-url <url>     Stable-link base URL (default: https://test.dialtone.earth)
  --token-file <path>     Path to LIVE_CONTROL_TOKEN file (only used with --publish-live)
  --json                  Emit capture and publish summary JSON
`

// defaultScreenshotsRelDir is overwritten on every loop so the newest set wins.
var defaultScreenshotsRelDir = filepath.Join("logs", "screenshots", "latest")

type screenshotManifestSummary struct {
	LoopID         string `json:"loop_id"`
	GeneratedAt    string `json:"generated_at"`
	StableURL      string `json:"stable_url"`
	TotalShots     int    `json:"total_shots"`
	AnnotatedShots int    `json:"annotated_shots"`
	FallbackShots  int    `json:"fallback_shots"`
}

func runScreenshots(args []string, stdout, stderr io.Writer) error {
	if len(args) > 0 && isHelp(args[0]) {
		fmt.Fprint(stdout, screenshotsUsage)
		return nil
	}

	fs := flag.NewFlagSet("screenshots", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dashboardURL := fs.String("dashboard-url", "http://127.0.0.1:5174", "Test dashboard base URL")
	outputDir := fs.String("output-dir", defaultScreenshotsRelDir, "Output directory overwritten on each loop")
	statePath := fs.String("state", stateFile, "Path to logs/state.json")
	pipelinePath := fs.String("pipeline", pipelineFile, "Path to logs/pipeline.json")
	filter := fs.String("filter", "", "Optional regexp filter on test names")
	mapFile := fs.String("map-file", "", "Optional JSON override file for test-to-region mappings")
	chromeBin := fs.String("chrome-bin", "", "Optional Chrome/Chromium/Edge binary path")
	width := fs.Int("width", 1440, "Viewport width in pixels")
	height := fs.Int("height", 900, "Viewport height in pixels")
	timeout := fs.Duration("timeout", 2*time.Minute, "Overall capture timeout")
	skipOverviews := fs.Bool("skip-overviews", false, "Skip overview pages")
	publishLive := fs.Bool("publish-live", false, "Explicitly upload screenshots to Cloudflare R2 via Worker (default: false)")
	publishURL := fs.String("publish-url", "https://test.dialtone.earth", "Stable-link base URL")
	tokenFile := fs.String("token-file", "", "Path to LIVE_CONTROL_TOKEN file (only with --publish-live)")
	jsonOut := fs.Bool("json", false, "Emit capture and publish summary JSON")

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(stdout, screenshotsUsage)
			return nil
		}
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("screenshots accepts flags only; run `dialtone-earth screenshots help`")
	}

	root, err := projectRoot()
	if err != nil {
		return err
	}
	absOut := resolveUnderRoot(root, *outputDir)
	absState := resolveUnderRoot(root, *statePath)
	absPipeline := resolveUnderRoot(root, *pipelinePath)
	absMap := ""
	if strings.TrimSpace(*mapFile) != "" {
		absMap = resolveUnderRoot(root, *mapFile)
	}
	absToken := ""
	if strings.TrimSpace(*tokenFile) != "" {
		absToken = resolveUnderRoot(root, *tokenFile)
	}

	toolDir := filepath.Join(root, "tools", "screenshots")
	if !dirExists(toolDir) {
		return fmt.Errorf("screenshots tool module not found at %s", toolDir)
	}

	toolArgs := []string{
		"run", ".",
		"--dashboard-url", strings.TrimRight(strings.TrimSpace(*dashboardURL), "/"),
		"--output-dir", absOut,
		"--state", absState,
		"--pipeline", absPipeline,
		"--width", strconv.Itoa(*width),
		"--height", strconv.Itoa(*height),
		"--timeout", timeout.String(),
		"--publish-url", strings.TrimRight(strings.TrimSpace(*publishURL), "/"),
		"--repo-root", root,
	}
	if strings.TrimSpace(*filter) != "" {
		toolArgs = append(toolArgs, "--filter", strings.TrimSpace(*filter))
	}
	if absMap != "" {
		toolArgs = append(toolArgs, "--map-file", absMap)
	}
	if strings.TrimSpace(*chromeBin) != "" {
		toolArgs = append(toolArgs, "--chrome-bin", strings.TrimSpace(*chromeBin))
	}
	if *skipOverviews {
		toolArgs = append(toolArgs, "--skip-overviews")
	}
	if *publishLive {
		toolArgs = append(toolArgs, "--publish-live")
	}
	if absToken != "" {
		toolArgs = append(toolArgs, "--token-file", absToken)
	}
	if *jsonOut {
		toolArgs = append(toolArgs, "--json")
	}

	cmd := exec.Command("go", toolArgs...)
	cmd.Dir = toolDir
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("screenshots capture tool: %w", err)
	}

	recordScreenshotsInPipeline(root, absOut, *publishLive, *publishURL)
	return nil
}

func resolveUnderRoot(root, path string) string {
	cleaned := strings.TrimSpace(path)
	if cleaned == "" {
		return root
	}
	if filepath.IsAbs(cleaned) {
		return cleaned
	}
	return filepath.Join(root, cleaned)
}

func recordScreenshotsInPipeline(root, outputDir string, publishLive bool, publishURL string) {
	raw, err := os.ReadFile(filepath.Join(outputDir, "manifest.json"))
	if err != nil {
		return
	}
	var summary screenshotManifestSummary
	if err := json.Unmarshal(raw, &summary); err != nil {
		return
	}
	pipe := readPipelineState(root)
	if publishLive {
		pipe.ScreenshotsURL = strings.TrimRight(strings.TrimSpace(publishURL), "/") + "/screenshots/"
	} else {
		pipe.ScreenshotsURL = "/screenshots/"
	}
	if rel, err := filepath.Rel(root, outputDir); err == nil && !strings.HasPrefix(rel, "..") {
		pipe.ScreenshotsDir = filepath.ToSlash(rel)
	} else {
		pipe.ScreenshotsDir = filepath.ToSlash(outputDir)
	}
	pipe.ScreenshotsCount = summary.TotalShots
	pipe.ScreenshotsAnnotated = summary.AnnotatedShots
	pipe.ScreenshotsLoopID = summary.LoopID
	writePipelineState(root, pipe)
}

func dashboardIsReachable(dashboardURL string) bool {
	base := strings.TrimRight(strings.TrimSpace(dashboardURL), "/")
	if base == "" {
		return false
	}
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(base + "/")
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode < 500
}

// runPostLoopScreenshots executes the automated annotated screenshot capture
// at the end of a test loop. When required is false (implicit auto-capture in
// --browser mode), an offline local dashboard logs a notice instead of failing.
func runPostLoopScreenshots(
	root string,
	dashboardURL string,
	filter string,
	publishLive bool,
	publishURL string,
	required bool,
	stdout, stderr io.Writer,
) error {
	if !dashboardIsReachable(dashboardURL) {
		msg := fmt.Sprintf("screenshots: skipped post-loop capture (dashboard %s is not reachable; start `go run . dev --port 5174`)", dashboardURL)
		if required {
			return errors.New(msg)
		}
		fmt.Fprintln(stdout, msg)
		return nil
	}
	args := []string{
		"--dashboard-url", strings.TrimRight(strings.TrimSpace(dashboardURL), "/"),
		"--output-dir", filepath.Join(root, defaultScreenshotsRelDir),
		"--state", filepath.Join(root, stateFile),
		"--pipeline", filepath.Join(root, pipelineFile),
	}
	if strings.TrimSpace(filter) != "" {
		args = append(args, "--filter", strings.TrimSpace(filter))
	}
	if publishLive {
		args = append(args, "--publish-live", "--publish-url", strings.TrimRight(strings.TrimSpace(publishURL), "/"))
	}
	return runScreenshots(args, stdout, stderr)
}
