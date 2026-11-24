package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultLiveSiteURL       = "https://dialtone.earth"
	defaultCloudflareAccount = "e2f771d3f869b99b6bd643050699d234"
	defaultWorkerName        = "dialtone-earth"
)

const liveUsage = `usage: dialtone-earth live <subcommand> [flags]

Modify the public https://dialtone.earth/ website live on the internet (updates
open browsers in ~1.5s without redeploying or refreshing).

Subcommands:
  status      Show current live site state (public GET /api/live)
  set         Apply live edits to https://dialtone.earth/ (PATCH /api/live)
  reset       Clear all live overrides back to stock defaults (DELETE /api/live)
  watch       Watch local files and auto-deploy live to https://dialtone.earth/
  init-token  Generate LIVE_CONTROL_TOKEN locally and upload to Cloudflare Worker

Flags for "live set":
  --banner <text>     Live announcement bar across the top (empty "" clears)
  --title <text>      Custom header wordmark & page title (empty "" clears)
  --badge <text>      Custom status badge pill (empty "" clears)
  --headline <text>   Custom overview & tour headline (empty "" clears)
  --subline <text>    Custom overview & tour subtitle (empty "" clears)
  --theme <mode>      Switch site theme live: light, dark, or "" to clear
  --view <view>       Switch view live: overview, network, host, users, tests, log
  --network <slug>    Focus 3D globe on network: sim-atlas, sim-foundry, sim-orbit
  --tour <mode>       Guided tour playback: play, pause, or "" to clear
  --fullscreen <mode> Fullscreen table over faded globe: on, off, or "" to clear
  --url <url>         Target site base URL (default: https://dialtone.earth)
  --token-file <path> Path to LIVE_CONTROL_TOKEN file (or set DIALTONE_LIVE_TOKEN)
  --json              Emit raw JSON response

Flags for "live watch":
  --test              Run synced staging tests on every file save (default: true)
  --browser           Drive persistent CDP Chrome projected into test.dialtone.earth (default: true)
  --keep-signed-in    Preserve the authenticated LIVE metal session in Chrome (default: true)
  --deploy-on-pass    Opt-in auto-deploy on pass (default: false — promote manually from test.dialtone.earth)
  --push              Also push git bundle + source archives to Cloudflare R2 on pass
  --filter <regexp>   Optional Go test filter regexp (empty runs all tests)
  --interval <dur>    File change poll interval (default: 1.2s)
`

type liveSiteState struct {
	Revision    int     `json:"revision"`
	UpdatedAt   *string `json:"updated_at"`
	UpdatedBy   *string `json:"updated_by"`
	Title       *string `json:"title"`
	Badge       *string `json:"badge"`
	Banner      *string `json:"banner"`
	Headline    *string `json:"headline"`
	Subline     *string `json:"subline"`
	Theme       *string `json:"theme"`
	View        *string `json:"view"`
	Network     *string `json:"network"`
	TourPlaying *bool   `json:"tour_playing"`
	Fullscreen  *bool   `json:"fullscreen"`
}

func defaultLiveTokenPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config-dialtone-earth", "live-control-token.txt"), nil
}

func loadLiveControlToken(tokenFile string) (string, error) {
	if envTok := strings.TrimSpace(os.Getenv("DIALTONE_LIVE_TOKEN")); envTok != "" && tokenFile == "" {
		return envTok, nil
	}
	path := strings.TrimSpace(tokenFile)
	if path == "" {
		var err error
		path, err = defaultLiveTokenPath()
		if err != nil {
			return "", err
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("missing live control token at %s (run `dialtone-earth live init-token` or set DIALTONE_LIVE_TOKEN): %w", path, err)
	}
	tok := strings.TrimSpace(string(raw))
	if tok == "" {
		return "", fmt.Errorf("live control token file %s is empty", path)
	}
	return tok, nil
}

func runLive(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || isHelp(args[0]) {
		fmt.Fprint(stdout, liveUsage)
		return nil
	}
	switch args[0] {
	case "status":
		return runLiveStatus(args[1:], stdout, stderr)
	case "set":
		return runLiveSet(args[1:], stdout, stderr)
	case "reset":
		return runLiveReset(args[1:], stdout, stderr)
	case "watch":
		return runLiveWatch(args[1:], stdout, stderr)
	case "init-token":
		return runLiveInitToken(args[1:], stdout, stderr)
	default:
		fmt.Fprint(stderr, liveUsage)
		return fmt.Errorf("unknown live subcommand %q", args[0])
	}
}

func runLiveStatus(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("live status", flag.ContinueOnError)
	fs.SetOutput(stderr)
	baseURL := fs.String("url", defaultLiveSiteURL, "Target site base URL")
	jsonOut := fs.Bool("json", false, "Emit raw JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("live status accepts no positional arguments")
	}

	endpoint := strings.TrimRight(strings.TrimSpace(*baseURL), "/") + "/api/live"
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(endpoint)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s returned HTTP %d: %s", endpoint, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if *jsonOut {
		_, err = stdout.Write(append(bytes.TrimSpace(body), '\n'))
		return err
	}
	var st liveSiteState
	if err := json.Unmarshal(body, &st); err != nil {
		return err
	}
	printLiveStateSummary(stdout, endpoint, st)
	return nil
}

func runLiveSet(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("live set", flag.ContinueOnError)
	fs.SetOutput(stderr)
	banner := fs.String("banner", "", "Live announcement banner")
	title := fs.String("title", "", "Custom brand title")
	badge := fs.String("badge", "", "Custom header badge")
	headline := fs.String("headline", "", "Custom headline")
	subline := fs.String("subline", "", "Custom subline")
	theme := fs.String("theme", "", "Theme: light, dark, or empty")
	view := fs.String("view", "", "View: overview, network, host, users, tests, log")
	network := fs.String("network", "", "Network slug (e.g. sim-atlas, sim-foundry, sim-orbit)")
	tour := fs.String("tour", "", "Guided tour playback: play, pause, or empty")
	fullscreen := fs.String("fullscreen", "", "Fullscreen table over faded globe: on, off, or empty")
	baseURL := fs.String("url", defaultLiveSiteURL, "Target site base URL")
	tokenFile := fs.String("token-file", "", "Path to LIVE_CONTROL_TOKEN file")
	jsonOut := fs.Bool("json", false, "Emit raw JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("live set accepts flags only; use --banner, --headline, --theme, --view, --network, etc.")
	}

	visited := map[string]bool{}
	fs.Visit(func(f *flag.Flag) {
		visited[f.Name] = true
	})

	payload := map[string]any{}
	if visited["banner"] {
		payload["banner"] = *banner
	}
	if visited["title"] {
		payload["title"] = *title
	}
	if visited["badge"] {
		payload["badge"] = *badge
	}
	if visited["headline"] {
		payload["headline"] = *headline
	}
	if visited["subline"] {
		payload["subline"] = *subline
	}
	if visited["theme"] {
		payload["theme"] = *theme
	}
	if visited["view"] {
		payload["view"] = *view
	}
	if visited["network"] {
		payload["network"] = *network
	}
	if visited["tour"] {
		switch strings.ToLower(strings.TrimSpace(*tour)) {
		case "":
			payload["tour_playing"] = nil
		case "play", "true", "on", "1":
			payload["tour_playing"] = true
		case "pause", "stop", "false", "off", "0":
			payload["tour_playing"] = false
		default:
			return fmt.Errorf("invalid --tour value %q (use play, pause, or empty)", *tour)
		}
	}
	if visited["fullscreen"] {
		switch strings.ToLower(strings.TrimSpace(*fullscreen)) {
		case "":
			payload["fullscreen"] = nil
		case "on", "true", "full", "1":
			payload["fullscreen"] = true
		case "off", "false", "dock", "0":
			payload["fullscreen"] = false
		default:
			return fmt.Errorf("invalid --fullscreen value %q (use on, off, or empty)", *fullscreen)
		}
	}

	if len(payload) == 0 {
		return errors.New("live set requires at least one field flag (e.g. --banner, --headline, --theme, --view, --network, --tour)")
	}
	if host, err := os.Hostname(); err == nil && strings.TrimSpace(host) != "" {
		payload["updated_by"] = "cli@" + strings.ToLower(strings.TrimSpace(host))
	}

	token, err := loadLiveControlToken(*tokenFile)
	if err != nil {
		return err
	}

	rawReq, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint := strings.TrimRight(strings.TrimSpace(*baseURL), "/") + "/api/live"
	req, err := http.NewRequest(http.MethodPatch, endpoint, bytes.NewReader(rawReq))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("PATCH %s returned HTTP %d: %s", endpoint, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if *jsonOut {
		_, err = stdout.Write(append(bytes.TrimSpace(body), '\n'))
		return err
	}
	var envResp struct {
		OK    bool          `json:"ok"`
		State liveSiteState `json:"state"`
	}
	if err := json.Unmarshal(body, &envResp); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "live: updated %s (rev #%d — visible in browsers within ~1.5s)\n", strings.TrimRight(strings.TrimSpace(*baseURL), "/"), envResp.State.Revision)
	printLiveStateSummary(stdout, endpoint, envResp.State)
	return nil
}

func runLiveReset(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("live reset", flag.ContinueOnError)
	fs.SetOutput(stderr)
	baseURL := fs.String("url", defaultLiveSiteURL, "Target site base URL")
	tokenFile := fs.String("token-file", "", "Path to LIVE_CONTROL_TOKEN file")
	jsonOut := fs.Bool("json", false, "Emit raw JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("live reset accepts no positional arguments")
	}

	token, err := loadLiveControlToken(*tokenFile)
	if err != nil {
		return err
	}
	endpoint := strings.TrimRight(strings.TrimSpace(*baseURL), "/") + "/api/live"
	req, err := http.NewRequest(http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("DELETE %s returned HTTP %d: %s", endpoint, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if *jsonOut {
		_, err = stdout.Write(append(bytes.TrimSpace(body), '\n'))
		return err
	}
	var envResp struct {
		OK    bool          `json:"ok"`
		State liveSiteState `json:"state"`
	}
	if err := json.Unmarshal(body, &envResp); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "live: reset %s back to stock defaults (rev #%d)\n", strings.TrimRight(strings.TrimSpace(*baseURL), "/"), envResp.State.Revision)
	return nil
}

func runLiveWatch(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("live watch", flag.ContinueOnError)
	fs.SetOutput(stderr)
	interval := fs.Duration("interval", 1200*time.Millisecond, "File change poll interval")
	runTests := fs.Bool("test", true, "Run synced tests before deploying live")
	browser := fs.Bool("browser", true, "Run with persistent CDP Chrome browser synced to the test dashboard")
	keepSignedIn := fs.Bool("keep-signed-in", true, "Keep persistent CDP Chrome signed into LIVE metal")
	deployOnPass := fs.Bool("deploy-on-pass", false, "Opt-in auto-deploy to https://dialtone.earth/ on pass (default false: promote from test.dialtone.earth)")
	filter := fs.String("filter", "", "Optional Go test filter regexp (empty runs all tests)")
	pushCode := fs.Bool("push", false, "Also push git bundle to Cloudflare R2 on pass")
	repo := fs.String("repo", defaultRepoSlug(), "Repository slug when --push is set")
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL when --push is set")
	tokenFile := fs.String("token-file", "", "Path to LIVE_CONTROL_TOKEN file when --push is set")
	if err := fs.Parse(args); err != nil {
		return err
	}
	root, err := projectRoot()
	if err != nil {
		return err
	}
	watchDirs := []string{
		filepath.Join(root, "registry", "src"),
		filepath.Join(root, "registry", "worker"),
	}
	snapshotMap := func() map[string]string {
		m := map[string]string{}
		for _, dir := range watchDirs {
			_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, walkErr error) error {
				if walkErr != nil || d.IsDir() {
					return nil
				}
				if info, err := d.Info(); err == nil {
					rel, _ := filepath.Rel(root, path)
					m[filepath.ToSlash(rel)] = fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
				}
				return nil
			})
		}
		return m
	}
	last := snapshotMap()
	fmt.Fprintf(stdout, "live watch: watching registry/src & registry/worker (every %s) -> test -> deploy https://dialtone.earth/\n", *interval)
	fmt.Fprintln(stdout, "live watch: save any file to trigger synced tests + auto-deploy on pass (Ctrl+C to stop)")
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	for range ticker.C {
		cur := snapshotMap()
		var changed []string
		for k, v := range cur {
			if last[k] != v {
				changed = append(changed, k)
			}
		}
		for k := range last {
			if _, ok := cur[k]; !ok {
				changed = append(changed, k)
			}
		}
		if len(changed) == 0 {
			continue
		}
		last = cur
		changedLabel := strings.Join(changed, ", ")
		fmt.Fprintf(stdout, "\n[%s] live watch: edit detected in %s\n", time.Now().Format("15:04:05"), changedLabel)
		writePipelineState(root, pipelineState{
			Stage:   "edit",
			Changed: changedLabel,
			Message: "Edit detected in " + changedLabel + " — triggering synced test pipeline...",
		})
		if *runTests {
			testArgs := []string{"test"}
			if *browser {
				testArgs = append(testArgs, "--browser")
				if *keepSignedIn {
					testArgs = append(testArgs, "--keep-signed-in")
				}
			}
			if *deployOnPass {
				testArgs = append(testArgs, "--deploy-on-pass")
			}
			if *filter != "" {
				testArgs = append(testArgs, "--filter", *filter)
			}
			testArgs = append(testArgs, "--trigger-file", changedLabel)
			if code := Run(testArgs, stdout, stderr); code != 0 {
				fmt.Fprintf(stderr, "live watch: tests failed (exit %d) — deploy blocked\n", code)
				continue
			}
		} else if *deployOnPass {
			if err := runDeployLive(stdout, stderr); err != nil {
				fmt.Fprintf(stderr, "live watch deploy error: %v\n", err)
				continue
			}
		}
		if *pushCode {
			if tok, err := loadLiveControlToken(*tokenFile); err == nil {
				if _, err := pushCodeBundle(root, *repo, "", "", *baseURL, tok, true, stdout); err != nil {
					fmt.Fprintf(stderr, "live watch code push error: %v\n", err)
				}
			}
		}
	}
	return nil
}

func runLiveInitToken(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("live init-token", flag.ContinueOnError)
	fs.SetOutput(stderr)
	tokenFile := fs.String("token-file", "", "Path to store LIVE_CONTROL_TOKEN")
	workerName := fs.String("worker", defaultWorkerName, "Cloudflare Worker name")
	rotate := fs.Bool("rotate", false, "Force generating a new token even if one already exists")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("live init-token accepts no positional arguments")
	}

	path := strings.TrimSpace(*tokenFile)
	if path == "" {
		var err error
		path, err = defaultLiveTokenPath()
		if err != nil {
			return err
		}
	}

	var token string
	if !*rotate {
		if existing, err := os.ReadFile(path); err == nil {
			token = strings.TrimSpace(string(existing))
		}
	}
	if token == "" {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return err
		}
		token = hex.EncodeToString(buf)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "live: generated new LIVE_CONTROL_TOKEN at %s\n", path)
	} else {
		fmt.Fprintf(stdout, "live: reusing existing LIVE_CONTROL_TOKEN at %s\n", path)
	}

	root, err := projectRoot()
	if err != nil {
		return err
	}
	regDir := filepath.Join(root, "registry")
	cmd := exec.Command("pnpm", "exec", "wrangler", "secret", "put", "LIVE_CONTROL_TOKEN", "--name", *workerName)
	cmd.Dir = regDir
	cmd.Env = cloudflareWranglerEnv()
	cmd.Stdin = strings.NewReader(token + "\n")
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("upload LIVE_CONTROL_TOKEN to Cloudflare Worker %q: %w", *workerName, err)
	}
	fmt.Fprintf(stdout, "live: uploaded LIVE_CONTROL_TOKEN secret to Cloudflare Worker %s\n", *workerName)
	return nil
}

func runDeployLive(stdout, stderr io.Writer) error {
	root, err := projectRoot()
	if err != nil {
		return err
	}
	regDir := filepath.Join(root, "registry")
	if !dirExists(regDir) {
		return fmt.Errorf("registry directory not found at %s", regDir)
	}
	// Sync root install.sh & install.ps1 into registry/public so https://dialtone.earth/install.{sh,ps1} stay current.
	for _, script := range []string{"install.sh", "install.ps1"} {
		src := filepath.Join(root, script)
		if fileExists(src) {
			_ = copyFile(src, filepath.Join(regDir, "public", script))
		}
	}
	fmt.Fprintln(stdout, "deploy --live: building registry frontend + Worker")
	buildCmd := exec.Command("pnpm", "run", "build")
	buildCmd.Dir = regDir
	buildCmd.Env = cloudflareWranglerEnv()
	buildCmd.Stdout = stdout
	buildCmd.Stderr = stderr
	if err := buildCmd.Run(); err != nil {
		return fmt.Errorf("pnpm run build in registry: %w", err)
	}

	fmt.Fprintln(stdout, "deploy --live: publishing to Cloudflare Workers (https://dialtone.earth/)")
	deployCmd := exec.Command("pnpm", "exec", "wrangler", "deploy")
	deployCmd.Dir = regDir
	deployCmd.Env = cloudflareWranglerEnv()
	deployCmd.Stdout = stdout
	deployCmd.Stderr = stderr
	if err := deployCmd.Run(); err != nil {
		return fmt.Errorf("wrangler deploy: %w", err)
	}
	fmt.Fprintln(stdout, "deploy --live: published live to https://dialtone.earth/")
	return nil
}

func cloudflareWranglerEnv() []string {
	env := os.Environ()
	hasAccount := false
	hasXDG := false
	for _, kv := range env {
		if strings.HasPrefix(kv, "CLOUDFLARE_ACCOUNT_ID=") {
			hasAccount = true
		}
		if strings.HasPrefix(kv, "XDG_CONFIG_HOME=") {
			hasXDG = true
		}
	}
	if !hasAccount {
		env = append(env, "CLOUDFLARE_ACCOUNT_ID="+defaultCloudflareAccount)
	}
	if !hasXDG {
		if home, err := os.UserHomeDir(); err == nil {
			cfgDir := filepath.Join(home, ".config-dialtone-earth")
			if dirExists(cfgDir) {
				env = append(env, "XDG_CONFIG_HOME="+cfgDir)
			}
		}
	}
	return env
}

func printLiveStateSummary(w io.Writer, endpoint string, st liveSiteState) {
	fmt.Fprintf(w, "endpoint: %s (rev #%d)\n", endpoint, st.Revision)
	if st.UpdatedAt != nil {
		by := "unknown"
		if st.UpdatedBy != nil {
			by = *st.UpdatedBy
		}
		fmt.Fprintf(w, "updated:  %s by %s\n", *st.UpdatedAt, by)
	}
	showStr := func(label string, v *string) {
		if v != nil && *v != "" {
			fmt.Fprintf(w, "%-9s %s\n", label+":", *v)
		}
	}
	showStr("title", st.Title)
	showStr("badge", st.Badge)
	showStr("banner", st.Banner)
	showStr("headline", st.Headline)
	showStr("subline", st.Subline)
	showStr("theme", st.Theme)
	showStr("view", st.View)
	showStr("network", st.Network)
	if st.TourPlaying != nil {
		mode := "pause"
		if *st.TourPlaying {
			mode = "play"
		}
		fmt.Fprintf(w, "%-9s %s\n", "tour:", mode)
	}
	if st.Fullscreen != nil {
		mode := "dock"
		if *st.Fullscreen {
			mode = "full"
		}
		fmt.Fprintf(w, "%-9s %s\n", "table:", mode)
	}
}
