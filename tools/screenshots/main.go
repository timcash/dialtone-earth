package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func loadOwnerToken(tokenFile string) (string, error) {
	if envTok := strings.TrimSpace(os.Getenv("DIALTONE_LIVE_TOKEN")); envTok != "" && strings.TrimSpace(tokenFile) == "" {
		return envTok, nil
	}
	path := strings.TrimSpace(tokenFile)
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, ".config-dialtone-earth", "live-control-token.txt")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read owner token %s: %w", path, err)
	}
	tok := strings.TrimSpace(string(raw))
	if tok == "" {
		return "", fmt.Errorf("owner token file %s is empty", path)
	}
	return tok, nil
}

func runCLI(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("screenshots", flag.ContinueOnError)
	fs.SetOutput(stderr)

	dashboardURL := fs.String("dashboard-url", "http://127.0.0.1:5174", "Local or remote test dashboard base URL to capture")
	outputDir := fs.String("output-dir", filepath.Join("logs", "screenshots", "latest"), "Local output directory overwritten on each loop")
	statePath := fs.String("state", filepath.Join("logs", "state.json"), "Path to logs/state.json")
	pipelinePath := fs.String("pipeline", filepath.Join("logs", "pipeline.json"), "Path to logs/pipeline.json")
	filter := fs.String("filter", "", "Optional regexp filter on test names to capture")
	mapFile := fs.String("map-file", "", "Optional JSON file overriding test-to-UI-region mappings")
	chromeBin := fs.String("chrome-bin", "", "Optional path to Chrome/Chromium/Edge binary")
	width := fs.Int("width", 1440, "Browser viewport width in pixels")
	height := fs.Int("height", 900, "Browser viewport height in pixels")
	timeout := fs.Duration("timeout", 120*time.Second, "Overall capture timeout")
	skipOverviews := fs.Bool("skip-overviews", false, "Skip capturing overview pages (dashboard, menu, logs)")
	publishLive := fs.Bool("publish-live", false, "Explicitly upload screenshots to Cloudflare R2 via the Worker (default: false, local dry-run)")
	publishURL := fs.String("publish-url", defaultPublishBaseURL, "Stable-link host base URL for publish")
	tokenFile := fs.String("token-file", "", "Path to LIVE_CONTROL_TOKEN file (only used with --publish-live)")
	repoRoot := fs.String("repo-root", ".", "Repository root path for git metadata")
	jsonOut := fs.Bool("json", false, "Print capture and publish summary as JSON")

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() != 0 {
		fmt.Fprintln(stderr, "screenshots accepts flags only; pass --help for usage")
		return 2
	}

	absOut, err := filepath.Abs(*outputDir)
	if err != nil {
		fmt.Fprintf(stderr, "screenshots failed: %v\n", err)
		return 1
	}

	stableURL := strings.TrimRight(strings.TrimSpace(*publishURL), "/") + "/screenshots/"
	manifest, err := CaptureAll(context.Background(), CaptureOptions{
		DashboardURL:  *dashboardURL,
		OutputDir:     absOut,
		StatePath:     *statePath,
		PipelinePath:  *pipelinePath,
		Filter:        *filter,
		MapFile:       *mapFile,
		ChromeBin:     *chromeBin,
		StableURL:     stableURL,
		Width:         *width,
		Height:        *height,
		Timeout:       *timeout,
		SkipOverviews: *skipOverviews,
		RepoRoot:      *repoRoot,
	}, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "screenshots capture failed: %v\n", err)
		return 1
	}

	token := ""
	if *publishLive {
		token, err = loadOwnerToken(*tokenFile)
		if err != nil {
			fmt.Fprintf(stderr, "screenshots live publish failed: %v\n", err)
			return 1
		}
	}

	plan, err := Publish(context.Background(), manifest, PublishOptions{
		OutputDir:   absOut,
		PublishLive: *publishLive,
		PublishURL:  *publishURL,
		Token:       token,
	}, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "screenshots publish failed: %v\n", err)
		return 1
	}

	if *jsonOut {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(map[string]any{
			"manifest": manifest,
			"publish":  plan,
		})
	}
	return 0
}

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdout, os.Stderr))
}
