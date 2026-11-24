package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const usage = `usage: dialtone-earth <action> [flags]

Actions:
  install   Download Go modules and install test dashboard UI packages
  lint      Check Go and TypeScript sources
  format    Format Go sources
  build     Build the Go CLI binary and test dashboard web UI
  auth      Inspect provider authentication status without logging in
  test      Run the Go tests in cli_test.go
  clean     Remove generated local state
  deploy    Build local bundle (deploy/local) or publish live (--live)
  live      Modify public https://dialtone.earth/ live or watch-deploy
  code      Store, push, pull, and clone git code on Cloudflare R2
  release   Tag and publish SHA-256-verified releases on Cloudflare R2
  plugins   List and publish public Dialtone plugins (e.g. dialtone-shell)
  dev       Start the test dashboard without running tests
  help      Show this help

Flags:
  auth status [--json]     Report configured and verified auth state
  test --filter <regexp>   Run only the Go tests matching this pattern
  test --list              Print the selected test names without running them
  test --browser           Start/reconnect persistent CDP Chrome synced with dashboard
  test --keep-signed-in    Leave Chrome signed into LIVE metal after browser tests
  test --deploy-on-pass    Auto-deploy to https://dialtone.earth/ if all tests pass
  test --close-browser     Close the persistent CDP Chrome browser and exit
  deploy --live            Build registry/ and deploy live to Cloudflare Workers
  live <status|set|reset|watch|init-token>  Control or watch-deploy dialtone.earth live
  code <list|status|push|pull|clone>        Store/sync git bundles directly on Cloudflare R2
  release <list|tag vX.Y.Z [--build]>       Tag releases & upload SHA-256 binaries to R2
  plugins <list|info|publish>               Browse/publish public Dialtone plugins (Iroh + R2)
  dev --port <port>        Serve the dashboard on another port

How the Cloudflare + Iroh workflow works (zero GitHub, zero Tailscale):
  code push [--live]                      Pack git bundle + archives to Cloudflare R2 (and deploy live)
  code pull / code clone <repo> [dir]     Sync or clone a repository directly from dialtone.earth R2
  release tag v0.6.0 --build --live       Tag HEAD, cross-compile 6 binaries + .sha256 to R2, deploy live
  plugins list / plugins info <name>      Discover public Dialtone plugins & live iroh-blobs:// tickets
  plugins publish <name> --from-local     Publish an installed local Dialtone plugin to dialtone.earth
  live watch                              Watch edits -> run synced CDP browser tests -> deploy on pass

Run "<action> --help" (e.g. "dialtone-earth code help", "live help", "release help", "plugins help")
for full subcommand flags. Run with "go run . <action>", ".\dialtone-earth.ps1 <action>", or "bin/dialtone-earth <action>".
`

func Run(args []string, stdout, stderr io.Writer) int {
	// Status/help remain independent of language toolchain discovery.
	if len(args) > 0 && args[0] == "auth" {
		return runAuth(args[1:], stdout, stderr)
	}
	if len(args) == 0 || isHelp(args[0]) {
		fmt.Fprint(stdout, usage)
		return 0
	}

	var err error
	switch args[0] {
	case "install":
		err = runInstall(stdout, stderr)
	case "lint":
		err = runLint(stdout, stderr)
	case "format":
		err = runFormat(stdout, stderr)
	case "build":
		err = runBuild(stdout, stderr)
	case "test":
		err = runTest(args[1:], stdout, stderr)
	case "clean":
		err = runClean(stdout)
	case "deploy":
		err = runDeploy(args[1:], stdout, stderr)
	case "live":
		err = runLive(args[1:], stdout, stderr)
	case "code":
		err = runCode(args[1:], stdout, stderr)
	case "release":
		err = runRelease(args[1:], stdout, stderr)
	case "plugins":
		err = runPlugins(args[1:], stdout, stderr)
	case "dev":
		err = runDev(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown action %q\n\n%s", args[0], usage)
		return 2
	}
	if err != nil {
		fmt.Fprintf(stderr, "dialtone-earth %s failed: %v\n", args[0], err)
		return 1
	}
	return 0
}

func runInstall(stdout, stderr io.Writer) error {
	root, err := projectRoot()
	if err != nil {
		return err
	}
	uiInstall := "ci"
	if runtime.GOOS == "windows" || !fileExists(filepath.Join(root, "ui", "package-lock.json")) {
		// Keep the native Vite bindings available to an open dashboard.
		uiInstall = "install"
	}
	steps := []struct {
		label string
		dir   string
		name  string
		args  []string
	}{
		{"Go modules", root, "go", []string{"mod", "download"}},
		{"UI packages", filepath.Join(root, "ui"), "npm", []string{uiInstall}},
	}
	for _, step := range steps {
		fmt.Fprintf(stdout, "install: %s\n", step.label)
		if err := runExternal(step.dir, stdout, stderr, step.name, step.args...); err != nil {
			return err
		}
	}
	return nil
}

func runLint(stdout, stderr io.Writer) error {
	root, err := projectRoot()
	if err != nil {
		return err
	}
	steps := []struct {
		label string
		dir   string
		name  string
		args  []string
	}{
		{"Go vet (CLI & internal)", root, "go", []string{"vet", "./..."}},
		{"TypeScript check", root, "npm", []string{"--prefix", "ui", "run", "lint"}},
	}
	for _, step := range steps {
		fmt.Fprintf(stdout, "lint: %s\n", step.label)
		if err := runExternal(step.dir, stdout, stderr, step.name, step.args...); err != nil {
			return err
		}
	}
	return nil
}

func runFormat(stdout, stderr io.Writer) error {
	root, err := projectRoot()
	if err != nil {
		return err
	}
	fmt.Fprintln(stdout, "format: Go")
	return runExternal(root, stdout, stderr, "go", "fmt", ".")
}

func runBuild(stdout, stderr io.Writer) error {
	root, err := projectRoot()
	if err != nil {
		return err
	}
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return err
	}
	steps := []struct {
		label string
		name  string
		args  []string
	}{
		{"Go binary", "go", []string{"build", "-o", filepath.Join(binDir, binaryName()), "."}},
		{"web UI", "npm", []string{"--prefix", "ui", "run", "build"}},
	}
	for _, step := range steps {
		fmt.Fprintf(stdout, "build: %s\n", step.label)
		if err := runExternal(root, stdout, stderr, step.name, step.args...); err != nil {
			return err
		}
	}
	return nil
}

// runTest is the whole test system: Go lists the tests in cli_test.go, Go runs
// them, and Go records what happened. Tests that exercise src packages, the
// registry, or the UI start those tools themselves.
func runTest(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("test", flag.ContinueOnError)
	flags.SetOutput(stderr)
	filter := flags.String("filter", "", "Run only the Go tests matching this regular expression")
	list := flags.Bool("list", false, "Print the selected test names without running them")
	browser := flags.Bool("browser", false, "Start or reconnect persistent CDP Chrome synced with the test dashboard")
	prod := flags.Bool("prod", false, "Run the live production verification suite against https://metal.dialtone.earth/ and https://dialtone.earth/")
	keepSignedIn := flags.Bool("keep-signed-in", false, "Keep the persistent CDP Chrome browser signed into LIVE session after tests finish")
	deployOnPass := flags.Bool("deploy-on-pass", false, "Automatically deploy live to https://dialtone.earth/ if all tests pass")
	triggerFile := flags.String("trigger-file", "", "Optional edited file label shown in the live pipeline banner")
	closeBrowser := flags.Bool("close-browser", false, "Close the persistent CDP Chrome browser and exit")
	cdpPort := flags.Int("cdp-port", 9222, "Chrome DevTools Protocol loopback port for --browser")
	dashboardURL := flags.String("dashboard-url", "http://127.0.0.1:5174/", "Test dashboard URL opened beside the live app in --browser mode")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("test accepts no positional arguments; use --filter <regexp>")
	}
	if os.Getenv(testRunEnv) != "" {
		return errors.New("test is already running; a test in cli_test.go must not start it again")
	}
	root, err := projectRoot()
	if err != nil {
		return err
	}
	cdpScript := filepath.Join(root, "registry", "scripts", "cdp-session.mjs")
	if *closeBrowser {
		return runExternal(root, stdout, stderr, "node", cdpScript, "close", "--port", strconv.Itoa(*cdpPort))
	}
	if *prod {
		deployedRec := readDeployedRecord(root)
		return runTrackedProductionSuite(root, *cdpPort, *dashboardURL, deployedRec.VersionID, deployedRec.DeployedHash, "", false, stdout, stderr)
	}
	names, err := listTestNames(root, *filter)
	if err != nil {
		return err
	}
	if len(names) == 0 {
		return fmt.Errorf("cli_test.go has no test matching %q", *filter)
	}
	if *list {
		for _, name := range names {
			fmt.Fprintln(stdout, name)
		}
		return nil
	}
	var extraEnv []string
	if *browser {
		// Rebuild registry/dist so any live edits from test.dialtone.earth are served by the isolated staging preview (127.0.0.1:5175).
		regDir := filepath.Join(root, "registry")
		if dirExists(regDir) {
			fmt.Fprintln(stdout, "test --browser: rebuilding staging preview (registry/dist) for isolated test channel")
			if err := runExternal(regDir, stdout, stderr, "pnpm", "run", "build"); err != nil {
				return fmt.Errorf("staging preview build failed: %w", err)
			}
		}
		if err := ensurePersistentBrowserSession(root, cdpScript, *cdpPort, *dashboardURL, stdout, stderr); err != nil {
			return err
		}
		extraEnv = append(extraEnv,
			"DIALTONE_LIVE_CLOUDFLARE_E2E=1",
			"DIALTONE_CDP_REUSE=1",
			"DIALTONE_CDP_PORT="+strconv.Itoa(*cdpPort),
			"DIALTONE_DASHBOARD_URL="+*dashboardURL,
			"QA_HEADED=1",
		)
		if *keepSignedIn {
			extraEnv = append(extraEnv, "QA_KEEP_SIGNED_IN=1")
		}
	}
	state := buildInitialTestState(root, names, *filter)
	populateTestSources(root, &state)
	if err := writeTestState(root, &state); err != nil {
		return err
	}
	msg := fmt.Sprintf("Running %d test(s)", len(names))
	if *deployOnPass {
		msg += " — will auto-deploy to https://dialtone.earth/ on pass"
	}
	runHash := computeStagingFingerprint(root)
	writePipelineState(root, pipelineState{
		Stage:        "testing",
		Message:      msg,
		Changed:      strings.TrimSpace(*triggerFile),
		TargetOrigin: "http://127.0.0.1:5175",
		Total:        len(state.Tests),
	})
	testErr := runGoTests(root, &state, *filter, extraEnv, stdout)
	passed, failed, total := countStateTotals(&state)
	if testErr != nil {
		writePipelineState(root, pipelineState{
			Stage:        "failed",
			Message:      fmt.Sprintf("Tests failed (%d failed) — deploy blocked", failed),
			Changed:      strings.TrimSpace(*triggerFile),
			TargetOrigin: "http://127.0.0.1:5175",
			Passed:       passed,
			Failed:       failed,
			Total:        total,
		})
		return testErr
	}
	testedHash := ""
	if strings.TrimSpace(*filter) == "" && allBrowserTestsPassed(&state) {
		testedHash = runHash
	}
	if !*deployOnPass {
		deployedHash := readDeployedRecord(root).DeployedHash
		stage := "staging_ready"
		readyMsg := fmt.Sprintf("Ready (%d/%d passed on test network) — click deploy to update dialtone.earth", passed, total)
		if testedHash == "" {
			readyMsg = fmt.Sprintf("Passed %d/%d — run full test-network browser suite to unlock deploy", passed, total)
		} else if deployedHash != "" && deployedHash == testedHash {
			stage = "deployed"
			readyMsg = fmt.Sprintf("All %d/%d passed — up to date with live dialtone.earth (nothing new to deploy)", passed, total)
		}
		writePipelineState(root, pipelineState{
			Stage:        stage,
			Message:      readyMsg,
			Changed:      strings.TrimSpace(*triggerFile),
			TargetOrigin: "http://127.0.0.1:5175",
			TestedHash:   testedHash,
			DeployedHash: deployedHash,
			Passed:       passed,
			Failed:       failed,
			Total:        total,
		})
		return nil
	}
	writePipelineState(root, pipelineState{
		Stage:     "deploying",
		Message:   fmt.Sprintf("All %d tests passed — deploying live to https://dialtone.earth/...", passed),
		Changed:   strings.TrimSpace(*triggerFile),
		DeployURL: defaultLiveSiteURL + "/",
		Passed:    passed,
		Failed:    failed,
		Total:     total,
	})
	var deployBuf bytes.Buffer
	deployOut := io.MultiWriter(stdout, &deployBuf)
	if err := runDeployLive(deployOut, stderr); err != nil {
		writePipelineState(root, pipelineState{
			Stage:   "failed",
			Message: fmt.Sprintf("Tests passed, but live deploy failed: %v", err),
			Changed: strings.TrimSpace(*triggerFile),
			Passed:  passed,
			Failed:  failed,
			Total:   total,
		})
		return err
	}
	versionID := extractWranglerVersionID(deployBuf.String())
	writePipelineState(root, pipelineState{
		Stage:     "deployed",
		Message:   fmt.Sprintf("All %d tests passed & deployed live to https://dialtone.earth/", passed),
		Changed:   strings.TrimSpace(*triggerFile),
		DeployURL: defaultLiveSiteURL + "/",
		VersionID: versionID,
		Passed:    passed,
		Failed:    failed,
		Total:     total,
	})
	if *browser {
		_ = exec.Command("node", cdpScript, "banner", "ALL TESTS PASSED — DEPLOYED LIVE TO dialtone.earth!", "--port", strconv.Itoa(*cdpPort)).Run()
	}
	return nil
}

const prodVerificationFilter = "^(TestBrowser0[1-9]|TestProductionLiveSmoke|TestDialtoneEarthLiveOwnerAccessOnCloudflare)$"
const defaultProdBrowserOrigin = "https://metal.dialtone.earth"

// runTrackedProductionSuite runs the live production test suite (all 9 dual-format
// browser tests against live https://metal.dialtone.earth + live https://dialtone.earth/
// HTTP/R2/security smoke checks) while streaming live test progress into logs/state.json
// and projecting both wide & mobile production views into the test dashboard.
func runTrackedProductionSuite(
	root string,
	cdpPort int,
	dashboardURL string,
	versionID string,
	deployedHash string,
	promotedRel string,
	recordDeploy bool,
	stdout, stderr io.Writer,
) error {
	cdpScript := filepath.Join(root, "registry", "scripts", "cdp-session.mjs")
	if err := ensurePersistentBrowserSessionForOrigin(root, cdpScript, cdpPort, dashboardURL, defaultProdBrowserOrigin, stdout, stderr); err != nil {
		return err
	}
	names, err := listTestNames(root, prodVerificationFilter)
	if err != nil {
		return err
	}
	if len(names) == 0 {
		return errors.New("production verification filter matched no tests in cli_test.go")
	}
	state := buildInitialTestState(root, names, prodVerificationFilter)
	populateTestSources(root, &state)
	if err := writeTestState(root, &state); err != nil {
		return err
	}
	prevPipe := readPipelineState(root)
	keepTestedHash := deployedHash
	if keepTestedHash == "" {
		keepTestedHash = prevPipe.TestedHash
	}
	writePipelineState(root, pipelineState{
		Stage:        "verifying_prod",
		Message:      fmt.Sprintf("Running live production suite (%d tests) on https://metal.dialtone.earth & https://dialtone.earth...", len(names)),
		TargetOrigin: defaultProdBrowserOrigin,
		DeployURL:    defaultLiveSiteURL + "/",
		VersionID:    versionID,
		TestedHash:   keepTestedHash,
		Total:        len(state.Tests),
	})

	extraEnv := []string{
		"DIALTONE_VERIFY_PROD=1",
		"DIALTONE_LIVE_CLOUDFLARE_E2E=1",
		"DIALTONE_CDP_REUSE=1",
		"DIALTONE_CDP_PORT=" + strconv.Itoa(cdpPort),
		"DIALTONE_DASHBOARD_URL=" + dashboardURL,
		"QA_HEADED=1",
		"QA_KEEP_SIGNED_IN=1",
		"QA_ORIGIN=" + defaultProdBrowserOrigin,
		"QA_EMAIL=test@dialtone.earth",
	}
	if tok, err := loadLiveControlToken(""); err == nil && tok != "" {
		extraEnv = append(extraEnv, "DIALTONE_LIVE_TOKEN="+tok)
	}

	testErr := runGoTests(root, &state, prodVerificationFilter, extraEnv, stdout)
	passed, failed, total := countStateTotals(&state)
	if testErr != nil {
		writePipelineState(root, pipelineState{
			Stage:        "failed",
			Message:      fmt.Sprintf("Live production verification failed (%d/%d passed, %d failed)", passed, total, failed),
			TargetOrigin: defaultProdBrowserOrigin,
			DeployURL:    defaultLiveSiteURL + "/",
			VersionID:    versionID,
			TestedHash:   keepTestedHash,
			Passed:       passed,
			Failed:       failed,
			Total:        total,
		})
		return testErr
	}
	if recordDeploy && deployedHash != "" {
		writeDeployedRecord(root, deployedRecord{
			DeployedHash: deployedHash,
			VersionID:    versionID,
			VerifiedProd: true,
		})
	}
	msg := fmt.Sprintf("Live on https://dialtone.earth/ & production verified (%d/%d live prod tests passed)", passed, total)
	if promotedRel != "" {
		msg += fmt.Sprintf(" + dialtone auto-update %s", promotedRel)
	}
	writePipelineState(root, pipelineState{
		Stage:        "deployed",
		Message:      msg,
		TargetOrigin: defaultProdBrowserOrigin,
		DeployURL:    defaultLiveSiteURL + "/",
		VersionID:    versionID,
		TestedHash:   keepTestedHash,
		DeployedHash: deployedHash,
		Passed:       passed,
		Failed:       0,
		Total:        total,
	})
	return nil
}

func extractWranglerVersionID(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if idx := strings.Index(line, "Current Version ID:"); idx >= 0 {
			return strings.TrimSpace(line[idx+len("Current Version ID:"):])
		}
	}
	return ""
}

func ensurePersistentBrowserSession(root, cdpScript string, port int, dashboardURL string, stdout, stderr io.Writer) error {
	return ensurePersistentBrowserSessionForOrigin(root, cdpScript, port, dashboardURL, "http://127.0.0.1:5175", stdout, stderr)
}

func ensurePersistentBrowserSessionForOrigin(root, cdpScript string, port int, dashboardURL, origin string, stdout, stderr io.Writer) error {
	args := []string{cdpScript, "ensure", "--port", strconv.Itoa(port), "--dashboard", dashboardURL}
	if strings.TrimSpace(origin) != "" {
		args = append(args, "--origin", strings.TrimSpace(origin))
	}
	command := exec.Command("node", args...)
	command.Dir = root
	command.Stderr = stderr
	out, err := command.Output()
	if err != nil {
		return fmt.Errorf("ensure persistent CDP browser on port %d: %w", port, err)
	}
	var meta struct {
		Port   int    `json:"port"`
		Reused bool   `json:"reused"`
		AppURL string `json:"app_url"`
	}
	if json.Unmarshal(out, &meta) == nil && meta.Port > 0 {
		verb := "launched persistent"
		if meta.Reused {
			verb = "reconnected to"
		}
		fmt.Fprintf(stdout, "browser: %s Chrome CDP on 127.0.0.1:%d (%s)\n", verb, meta.Port, meta.AppURL)
	}
	return nil
}

func runClean(stdout io.Writer) error {
	root, err := projectRoot()
	if err != nil {
		return err
	}
	paths := []string{
		filepath.Join(root, "bin"),
		filepath.Join(root, "deploy"),
		filepath.Join(root, "ui", "dist"),
		filepath.Join(root, "ui", "node_modules"),
		filepath.Join(root, stateFile),
	}
	for _, path := range paths {
		if err := removeGeneratedPath(root, path, stdout); err != nil {
			return err
		}
	}
	fmt.Fprintln(stdout, "clean: kept archived run logs; dev or test will list the tests again")
	return nil
}

func runDeploy(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("deploy", flag.ContinueOnError)
	flags.SetOutput(stderr)
	live := flags.Bool("live", false, "Build registry/ and publish live to Cloudflare Workers (https://dialtone.earth/)")
	requirePass := flags.Bool("require-pass", false, "Enforce staging test gate: refuse deploy unless all recorded tests pass")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("deploy accepts no positional arguments; use --live to publish to Cloudflare")
	}
	if *live {
		root, err := projectRoot()
		if err != nil {
			return err
		}
		var passed, total int
		if *requirePass {
			passed, total, err = verifyStagingGate(root)
			if err != nil {
				writePipelineState(root, pipelineState{
					Stage:   "failed",
					Message: err.Error(),
					Passed:  passed,
					Total:   total,
				})
				return err
			}
			writePipelineState(root, pipelineState{
				Stage:     "deploying",
				Message:   fmt.Sprintf("Staging gate passed (%d/%d) — promoting to https://dialtone.earth/...", passed, total),
				DeployURL: defaultLiveSiteURL + "/",
				Passed:    passed,
				Total:     total,
			})
		}
		var deployBuf bytes.Buffer
		if err := runDeployLive(io.MultiWriter(stdout, &deployBuf), stderr); err != nil {
			if *requirePass {
				writePipelineState(root, pipelineState{
					Stage:   "failed",
					Message: fmt.Sprintf("Staging promotion failed: %v", err),
					Passed:  passed,
					Total:   total,
				})
			}
			return err
		}
		promotedRel := promoteTestReleaseChannelToLatest(defaultLiveSiteURL, "", stdout)
		deployedHash := computeStagingFingerprint(root)
		versionID := extractWranglerVersionID(deployBuf.String())
		return runTrackedProductionSuite(root, 9222, "http://127.0.0.1:5174/", versionID, deployedHash, promotedRel, true, stdout, stderr)
	}
	root, err := projectRoot()
	if err != nil {
		return err
	}
	if err := runBuild(stdout, stderr); err != nil {
		return err
	}
	target := filepath.Join(root, "deploy", "local")
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	if err := copyFile(filepath.Join(root, "bin", binaryName()), filepath.Join(target, "bin", binaryName())); err != nil {
		return err
	}
	if err := copyDir(filepath.Join(root, "ui", "dist"), filepath.Join(target, "ui")); err != nil {
		return err
	}
	manifest := map[string]string{
		"name":         "dialtone-earth",
		"built_at_utc": time.Now().UTC().Format(time.RFC3339),
		"go_binary":    filepath.ToSlash(filepath.Join("bin", binaryName())),
		"ui":           filepath.ToSlash(filepath.Join("ui", "index.html")),
	}
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(target, "manifest.json"), append(raw, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "deploy: safe local bundle ready at %s\n", target)
	return nil
}

func runDev(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("dev", flag.ContinueOnError)
	flags.SetOutput(stderr)
	host := flags.String("listen-host", "127.0.0.1", "Vite listen host")
	port := flags.Int("port", 5174, "Vite listen port")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("dev accepts no positional arguments")
	}
	root, err := projectRoot()
	if err != nil {
		return err
	}
	if !dirExists(filepath.Join(root, "ui", "node_modules")) {
		fmt.Fprintln(stdout, "dev: installing UI packages")
		if err := runExternal(root, stdout, stderr, "npm", "--prefix", "ui", "install"); err != nil {
			return err
		}
	}
	names, err := listTestNames(root, "")
	if err != nil {
		return err
	}
	if !fileExists(filepath.Join(root, stateFile)) {
		state := newTestState(names)
		populateTestSources(root, &state)
		if err := writeTestState(root, &state); err != nil {
			return err
		}
	}
	url := fmt.Sprintf("http://%s:%d/", *host, *port)
	fmt.Fprintf(stdout, "dev: %s\n", url)
	fmt.Fprintf(stdout, "dev: %d tests available; use the Start tests button to run them\n", len(names))
	return runExternal(root, stdout, stderr, "npm", "--prefix", "ui", "run", "dev", "--", "--host", *host, "--port", strconv.Itoa(*port))
}

func runExternal(dir string, stdout, stderr io.Writer, name string, args ...string) error {
	if filepath.Base(name) == name {
		if _, err := exec.LookPath(name); err != nil {
			return fmt.Errorf("%s not found on PATH", name)
		}
	}
	command := exec.Command(name, args...)
	command.Dir = dir
	command.Stdout = stdout
	command.Stderr = stderr
	command.Stdin = os.Stdin
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}

func projectRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for dir := wd; ; dir = filepath.Dir(dir) {
		if fileExists(filepath.Join(dir, "go.mod")) &&
			fileExists(filepath.Join(dir, "cli.go")) &&
			fileExists(filepath.Join(dir, "ui", "package.json")) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not find dialtone-earth root from %s", wd)
		}
	}
}

func removeGeneratedPath(root, path string, stdout io.Writer) error {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("refusing to remove path outside project root: %s", path)
	}
	if err := os.RemoveAll(path); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "clean: removed %s\n", path)
	return nil
}

func copyDir(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		return copyFile(path, destination)
	})
}

func copyFile(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	output, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}
	return output.Close()
}

func binaryName() string {
	if runtime.GOOS == "windows" {
		return "dialtone-earth.exe"
	}
	return "dialtone-earth"
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func isHelp(value string) bool {
	return value == "help" || value == "-h" || value == "--help"
}

func main() {
	os.Exit(Run(os.Args[1:], os.Stdout, os.Stderr))
}

// AuthStatus is a nonsecret snapshot, not a credential or an authorization grant.
// A project-specific provider adapter replaces authenticationStatus and verifies
// the exact target through the provider's supported SDK/CLI with a bounded call.
// Never infer Verified from an environment variable, a cached token's presence,
// network reachability, or an unverified claim. Do not return raw provider errors.
type AuthStatus struct {
	Provider   string `json:"provider"`
	Target     string `json:"target"`
	Kind       string `json:"kind"`
	Configured bool   `json:"configured"`
	Verified   bool   `json:"verified"`
	Status     string `json:"status"`
	NextStep   string `json:"next_step"`
}

func authenticationStatus() AuthStatus {
	return AuthStatus{Status: "not_configured", NextStep: "Implement a project-specific provider adapter with bounded verification for the intended target; then rerun auth status."}
}

const authUsage = `usage: dialtone-earth auth status [--json]
       dialtone-earth auth help

Report nonsecret authentication state. No live provider is configured by default.
This command does not read credentials, log in, open a browser, or change access.
Exit 0: verified (or help); 1: not configured/unverified/unavailable; 2: usage.
`

func runAuth(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || (len(args) == 1 && isHelp(args[0])) ||
		(len(args) == 2 && args[0] == "status" && isHelp(args[1])) {
		fmt.Fprint(stdout, authUsage)
		return 0
	}
	jsonOutput := len(args) == 2 && args[1] == "--json"
	if args[0] != "status" || (len(args) != 1 && !jsonOutput) {
		// Do not echo arguments: an accidental secret may be present.
		fmt.Fprint(stderr, authUsage)
		return 2
	}
	status := authenticationStatus()
	if jsonOutput {
		if err := json.NewEncoder(stdout).Encode(status); err != nil {
			fmt.Fprintln(stderr, "unable to write auth status")
			return 1
		}
	} else {
		if _, err := fmt.Fprintf(stdout, "auth: %s\nprovider: %s\ntarget: %s\nkind: %s\nconfigured: %t\nverified: %t\nnext: %s\n", status.Status, status.Provider, status.Target, status.Kind, status.Configured, status.Verified, status.NextStep); err != nil {
			return 1
		}
	}
	if status.Configured && status.Verified && status.Status == "verified" {
		return 0
	}
	return 1
}
