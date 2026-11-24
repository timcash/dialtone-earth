package main

import (
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
  test --close-browser     Close the persistent CDP Chrome browser and exit
  deploy --live            Build registry/ and deploy live to Cloudflare Workers
  live <status|set|reset|watch|init-token>  Control or watch-deploy dialtone.earth live
  code <list|status|push|pull|clone>        Store/sync git bundles directly on Cloudflare R2
  release <list|tag vX.Y.Z [--build]>       Tag releases & upload SHA-256 binaries to R2
  plugins <list|info|publish>               Browse/publish public Dialtone plugins (Iroh + R2)
  dev --port <port>        Serve the dashboard on another port

Run an action with "go run . <action>", or with "bin/dialtone-earth <action>" after build.
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
	keepSignedIn := flags.Bool("keep-signed-in", false, "Keep the persistent CDP Chrome browser signed into LIVE metal after tests finish")
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
	return runGoTests(root, &state, *filter, extraEnv, stdout)
}

func ensurePersistentBrowserSession(root, cdpScript string, port int, dashboardURL string, stdout, stderr io.Writer) error {
	command := exec.Command("node", cdpScript, "ensure", "--port", strconv.Itoa(port), "--dashboard", dashboardURL)
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
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("deploy accepts no positional arguments; use --live to publish to Cloudflare")
	}
	if *live {
		return runDeployLive(stdout, stderr)
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
