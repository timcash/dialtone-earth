package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	guardauth "dialtone/dev/internal/guardauth"
	configv1 "dialtone/dev/plugins/config/src_v1/go"
	logs "dialtone/dev/plugins/logs/src_v1/go"
	replv3 "dialtone/dev/plugins/repl/src_v3/go/repl"
	tsnetv1 "dialtone/dev/plugins/tsnet/src_v1/go"
	"github.com/nats-io/nats.go"
)

var logFile *os.File

func findRepoRootFromPath(start string) (string, error) {
	cwd := start
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return "", err
		}
	}
	cwd, _ = filepath.Abs(cwd)
	for {
		if _, err := os.Stat(filepath.Join(cwd, "dialtone.sh")); err == nil {
			return cwd, nil
		}
		parent := filepath.Dir(cwd)
		if parent == cwd {
			break
		}
		cwd = parent
	}
	return "", os.ErrNotExist
}

func prependPathEntries(entries ...string) {
	current := strings.TrimSpace(os.Getenv("PATH"))
	parts := []string{}
	seen := map[string]struct{}{}
	for _, e := range entries {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if _, err := os.Stat(e); err != nil {
			continue
		}
		if _, ok := seen[e]; !ok {
			parts = append(parts, e)
			seen[e] = struct{}{}
		}
	}
	for _, p := range strings.Split(current, string(os.PathListSeparator)) {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if _, ok := seen[p]; !ok {
			parts = append(parts, p)
			seen[p] = struct{}{}
		}
	}
	_ = os.Setenv("PATH", strings.Join(parts, string(os.PathListSeparator)))
}

func bootstrapDialtoneRuntimeEnv() {
	cwd, _ := os.Getwd()
	repoRoot := strings.TrimSpace(os.Getenv("DIALTONE_REPO_ROOT"))
	if repoRoot == "" {
		if found, err := findRepoRootFromPath(cwd); err == nil {
			repoRoot = found
		}
	}
	if repoRoot != "" {
		repoRoot, _ = filepath.Abs(repoRoot)
		_ = os.Setenv("DIALTONE_REPO_ROOT", repoRoot)
		_ = os.Setenv("DIALTONE_SRC_ROOT", filepath.Join(repoRoot, "src"))
		if strings.TrimSpace(os.Getenv("DIALTONE_ENV_FILE")) == "" {
			_ = os.Setenv("DIALTONE_ENV_FILE", filepath.Join(repoRoot, "env", "dialtone.json"))
		}
		if strings.TrimSpace(os.Getenv("DIALTONE_MESH_CONFIG")) == "" {
			_ = os.Setenv("DIALTONE_MESH_CONFIG", filepath.Join(repoRoot, "env", "dialtone.json"))
		}
	}

	depsDir := GetDialtoneEnv()
	if depsDir != "" {
		goBinDir := filepath.Join(depsDir, "go", "bin")
		bunBinDir := filepath.Join(depsDir, "bun", "bin")
		prependPathEntries(goBinDir, bunBinDir)

		goBin := filepath.Join(goBinDir, "go")
		if _, err := os.Stat(goBin); err == nil {
			_ = os.Setenv("DIALTONE_GO_BIN", goBin)
		}
		bunBin := filepath.Join(bunBinDir, "bun")
		if _, err := os.Stat(bunBin); err == nil {
			_ = os.Setenv("DIALTONE_BUN_BIN", bunBin)
		}
	}
}

func maybeReexecInNixShell() {
	if isLocalCLITestArgs(os.Args[1:]) {
		return
	}
	if v := strings.TrimSpace(strings.ToLower(os.Getenv("DIALTONE_USE_NIX"))); v == "0" || v == "false" || v == "no" || v == "off" {
		return
	}
	if strings.TrimSpace(os.Getenv("IN_NIX_SHELL")) != "" {
		return
	}
	repoRoot := strings.TrimSpace(os.Getenv("DIALTONE_REPO_ROOT"))
	if repoRoot == "" {
		if found, err := findRepoRootFromPath(""); err == nil {
			repoRoot = found
		}
	}
	if strings.TrimSpace(repoRoot) == "" {
		return
	}
	flakePath := filepath.Join(repoRoot, "flake.nix")
	if _, err := os.Stat(flakePath); err != nil {
		return
	}
	if _, err := exec.LookPath("nix"); err != nil {
		return
	}
	script := filepath.Join(repoRoot, "dialtone.sh")
	args := append([]string{"--extra-experimental-features", "nix-command flakes", "develop", "path:" + repoRoot, "--command", script}, os.Args[1:]...)
	cmd := exec.Command("nix", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		logs.Error("failed to enter nix shell: %v", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func initLogger() {
	if isLocalCLITestArgs(os.Args[1:]) {
		_ = os.Setenv("DIALTONE_LOG_NATS", "0")
		logs.SetOutput(os.Stdout)
		return
	}
	mirrorStdout := true
	if raw := strings.TrimSpace(strings.ToLower(os.Getenv("DIALTONE_LOG_STDOUT"))); raw != "" {
		switch raw {
		case "0", "false", "no", "off":
			mirrorStdout = false
		default:
			mirrorStdout = true
		}
	}
	if mirrorStdout {
		logs.SetOutput(os.Stdout)
	} else {
		logs.SetOutput(io.Discard)
	}

	cwd, _ := os.Getwd()
	repoRoot := cwd
	if filepath.Base(cwd) == "src" {
		repoRoot = filepath.Dir(cwd)
	}
	path := filepath.Join(repoRoot, "dialtone.log")
	var err error
	logFile, err = os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		// Silent failure for logger init to avoid fmt dependency
	}
}

func normalizeGlobalFlags() {
	if len(os.Args) <= 1 {
		return
	}
	filtered := make([]string, 0, len(os.Args))
	filtered = append(filtered, os.Args[0])
	for i := 1; i < len(os.Args); i++ {
		arg := strings.TrimSpace(os.Args[i])
		if arg == "" {
			continue
		}
		switch arg {
		case "--stdout":
			continue
		case "--no-stdout":
			_ = os.Setenv("DIALTONE_LOG_STDOUT", "0")
			continue
		}
		filtered = append(filtered, os.Args[i])
	}
	os.Args = filtered
}

// LoadConfig loads environment variables from env/dialtone.json.
func LoadConfig() {
	cwd, _ := os.Getwd()
	repoRoot := cwd
	if filepath.Base(cwd) == "src" {
		repoRoot = filepath.Dir(cwd)
	}

	jsonPath := strings.TrimSpace(os.Getenv("DIALTONE_ENV_FILE"))
	if jsonPath == "" {
		jsonPath = filepath.Join(repoRoot, "env", "dialtone.json")
	}
	if absPath, err := filepath.Abs(jsonPath); err == nil {
		jsonPath = absPath
	}
	if fileExists(jsonPath) {
		data, err := os.ReadFile(jsonPath)
		if err == nil {
			var config map[string]any
			if err := json.Unmarshal(data, &config); err == nil {
				for k, v := range config {
					if os.Getenv(k) != "" {
						continue
					}
					switch vv := v.(type) {
					case string:
						_ = os.Setenv(k, vv)
					case float64:
						_ = os.Setenv(k, fmt.Sprintf("%v", vv))
					case bool:
						if vv {
							_ = os.Setenv(k, "true")
						} else {
							_ = os.Setenv(k, "false")
						}
					}
				}
			}
		}
	}
}

// GetDialtoneEnv returns the directory where dependencies are installed.
func GetDialtoneEnv() string {
	env := os.Getenv("DIALTONE_ENV")
	if env != "" {
		if strings.HasPrefix(env, "~") {
			home, _ := os.UserHomeDir()
			env = filepath.Join(home, env[1:])
		}
		absEnv, _ := filepath.Abs(env)
		return absEnv
	}
	return configv1.DefaultDialtoneEnv()
}

type Requirement struct {
	Tool    string
	Version string
}

type replMeshConfig struct {
	MeshNodes []replMeshNode `json:"mesh_nodes"`
}

type replMeshNode struct {
	Name           string   `json:"name"`
	Aliases        []string `json:"aliases"`
	Host           string   `json:"host"`
	HostCandidates []string `json:"host_candidates"`
	NATSURL        string   `json:"nats_url"`
	NATSPort       int      `json:"nats_port"`
}

type MissingInstall struct {
	Tool    string
	Command string
	Why     string
}

func EnsureRequirements(reqs []Requirement) error {
	for _, req := range reqs {
		if err := EnsureRequirement(req); err != nil {
			return err
		}
	}
	return nil
}

func EnsureRequirement(req Requirement) error {
	switch req.Tool {
	case "go":
		return ensureGoRequirement(req.Version)
	case "bun":
		return ensureBunRequirement(req.Version)
	default:
		return logs.Errorf("unsupported install requirement tool: %s", req.Tool)
	}
}

func ensureGoRequirement(version string) error {
	depsDir := GetDialtoneEnv()
	goBinName := "go"
	if runtime.GOOS == "windows" {
		goBinName = "go.exe"
	}
	goBin := filepath.Join(depsDir, "go", "bin", goBinName)
	if _, err := os.Stat(goBin); os.IsNotExist(err) {
		logs.Info("[install] Go missing; running ./dialtone.sh go src_v1 install")
		cmd := exec.Command("./dialtone.sh", "go", "src_v1", "install")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return logs.Errorf("failed to install Go: %v", err)
		}
	}

	if version == "" {
		return nil
	}

	out, err := exec.Command(goBin, "version").CombinedOutput()
	if err != nil {
		return logs.Errorf("failed checking go version: %v", err)
	}
	want := "go" + version
	if !strings.Contains(string(out), want) {
		return logs.Errorf("go version mismatch: want %s, got %s", want, strings.TrimSpace(string(out)))
	}
	return nil
}

func ensureBunRequirement(version string) error {
	depsDir := GetDialtoneEnv()
	bunBinName := "bun"
	if runtime.GOOS == "windows" {
		bunBinName = "bun.exe"
	}
	bunBin := filepath.Join(depsDir, "bun", "bin", bunBinName)
	if _, err := os.Stat(bunBin); os.IsNotExist(err) {
		logs.Info("[install] Bun missing; installing via ./dialtone.sh bun src_v1 install")
		cmd := exec.Command("./dialtone.sh", "bun", "src_v1", "install")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return logs.Errorf("failed to install Bun: %v", err)
		}
	}

	if version == "" || version == "latest" {
		return nil
	}

	out, err := exec.Command(bunBin, "--version").CombinedOutput()
	if err != nil {
		return logs.Errorf("failed checking bun version: %v", err)
	}
	got := strings.TrimSpace(string(out))
	if got != version {
		return logs.Errorf("bun version mismatch: want %s, got %s", version, got)
	}
	return nil
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "loop" {
		os.Exit(runOfflineLoop(os.Args[2:], os.Stdout, os.Stderr, time.Sleep))
	}
	bootstrapDialtoneRuntimeEnv()
	maybeReexecInNixShell()
	normalizeGlobalFlags()
	initLogger()
	LoadConfig()
	if shouldLogBootstrapChecks() {
		logBootstrapChecks()
	}
	defer func() {
		if logFile != nil {
			logFile.Close()
		}
	}()

	if len(os.Args) < 2 {
		missing := detectMissingForREPL()
		if len(missing) > 0 {
			logs.System("REPL prerequisites are missing.")
			for _, m := range missing {
				logs.System("- %s: %s", m.Tool, m.Why)
				logs.System("  install: %s", m.Command)
			}
			logs.System("After installing, run ./dialtone.sh again.")
			return
		}
		if err := startDefaultMultiplayerREPL(); err != nil {
			logs.Error("REPL error: %v", err)
			os.Exit(1)
		}
		return
	}

	command := os.Args[1]
	args := os.Args[2:]
	targetHost, sshHost, args := extractTransportFlags(command, args)

	switch command {
	case "help", "-h", "--help":
		printDevUsage()
	case "exit":
		os.Exit(0)
	case "install":
		if err := runPluginScaffold("repl", []string{"src_v3", "install"}); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			logs.Error("Install failed: %v", err)
			os.Exit(1)
		}
		return
	case "branch":
		runBranch(args)
	case "plugins":
		listPlugins()
	case "dev":
		if len(args) > 0 && args[0] == "install" {
			runDevInstall()
			return
		}
		logs.Error("Unknown dev command: %v", args)
	case "test":
		if strings.TrimSpace(sshHost) == "" && strings.TrimSpace(targetHost) == "" && !isLegacyTestPluginInvocation(args) {
			os.Exit(runLocalCLITest(args, os.Stdout))
		}
		dispatchNonBuiltinCommand(command, args, targetHost, sshHost)
	default:
		dispatchNonBuiltinCommand(command, args, targetHost, sshHost)
	}
}

func dispatchNonBuiltinCommand(command string, args []string, targetHost, sshHost string) {
	if strings.TrimSpace(sshHost) != "" {
		if err := runViaSSHHost(strings.TrimSpace(sshHost), command, args); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			logs.Error("SSH transport failed: %v", err)
			os.Exit(1)
		}
		return
	}
	if shouldRouteCommandViaREPL(command, args) {
		if err := dispatchViaREPL(command, args, targetHost); err != nil {
			if strings.HasPrefix(strings.TrimSpace(err.Error()), "DIALTONE ERROR:") {
				logs.System("%s", strings.TrimSpace(err.Error()))
				os.Exit(1)
			}
			logs.Error("REPL dispatch failed: %v", err)
			os.Exit(1)
		}
		return
	}
	if err := warmREPLForForegroundQuery(command, args, targetHost); err != nil {
		logs.Error("REPL foreground warmup failed: %v", err)
		os.Exit(1)
	}
	if err := runPluginScaffold(command, args); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		logs.Error("Orchestrator error: %v", err)
		os.Exit(1)
	}
}

func extractTransportFlags(command string, args []string) (targetHost string, sshHost string, filtered []string) {
	filtered = make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := strings.TrimSpace(args[i])
		if a == "" {
			continue
		}
		if a == "--ssh-host" && i+1 < len(args) {
			h := strings.TrimSpace(args[i+1])
			if h != "" {
				sshHost = h
			}
			i++
			continue
		}
		if strings.HasPrefix(a, "--ssh-host=") {
			h := strings.TrimSpace(strings.TrimPrefix(a, "--ssh-host="))
			if h != "" {
				sshHost = h
			}
			continue
		}
		if a == "--target-host" && i+1 < len(args) {
			h := strings.TrimSpace(args[i+1])
			if h != "" {
				targetHost = h
			}
			i++
			continue
		}
		if strings.HasPrefix(a, "--target-host=") {
			h := strings.TrimSpace(strings.TrimPrefix(a, "--target-host="))
			if h != "" {
				targetHost = h
			}
			continue
		}
		// --host is a global REPL routing flag for commands that don't define
		// plugin-local host semantics. Keep plugin-local --host for commands
		// that already use it as an operational target/bind flag.
		if command != "ssh" && command != "repl" && command != "autoswap" && command != "robot" && command != "chrome" {
			if a == "--host" && i+1 < len(args) {
				h := strings.TrimSpace(args[i+1])
				if h != "" {
					targetHost = h
				}
				i++
				continue
			}
			if strings.HasPrefix(a, "--host=") {
				h := strings.TrimSpace(strings.TrimPrefix(a, "--host="))
				if h != "" {
					targetHost = h
				}
				continue
			}
		}
		filtered = append(filtered, a)
	}
	return targetHost, sshHost, filtered
}

func shouldRouteCommandViaREPL(command string, args []string) bool {
	if logs.IsREPLContext() {
		return false
	}
	switch strings.TrimSpace(command) {
	case "", "help", "-h", "--help", "exit", "branch", "plugins", "dev":
		return false
	case "test":
		return isLegacyTestPluginInvocation(args)
	case "repl", "go", "bun":
		return false
	default:
		return !shouldRunForegroundQuery(command, args)
	}
}

func shouldRunForegroundQuery(command string, args []string) bool {
	command = strings.TrimSpace(strings.ToLower(command))
	subcommand := scaffoldSubcommand(args)
	switch command {
	case "cad":
		switch subcommand {
		case "test", "publish":
			// CAD test/publish output is much easier to use when it streams directly.
			return true
		}
	case "proc":
		switch subcommand {
		case "list", "ps":
			return true
		}
	case "logs":
		switch subcommand {
		case "stream", "tail", "nats-status":
			return true
		}
	case "wsl":
		switch subcommand {
		case "list", "ls", "status":
			return true
		}
	}
	return false
}

func scaffoldSubcommand(args []string) string {
	if len(args) == 0 {
		return ""
	}
	first := strings.TrimSpace(strings.ToLower(args[0]))
	if strings.HasPrefix(first, "src_v") {
		if len(args) < 2 {
			return ""
		}
		return strings.TrimSpace(strings.ToLower(args[1]))
	}
	if len(args) >= 2 {
		second := strings.TrimSpace(strings.ToLower(args[1]))
		if strings.HasPrefix(second, "src_v") {
			return first
		}
	}
	return first
}

func resolveREPLTopicEnv() string {
	topic := strings.TrimSpace(os.Getenv("DIALTONE_REPL_TOPIC"))
	if topic == "" {
		topic = "index"
	}
	return topic
}

func resolveREPLDispatchCandidates(targetHost string) (string, []string) {
	natsURL := strings.TrimSpace(os.Getenv("DIALTONE_REPL_NATS_URL"))
	if natsURL == "" {
		natsURL = "nats://127.0.0.1:4222"
	}
	room := resolveREPLTopicEnv()
	candidateNATSURLs := []string{natsURL}
	if host := strings.TrimSpace(targetHost); host != "" {
		candidateNATSURLs = resolveTargetNATSURLs(host)
	}
	return room, candidateNATSURLs
}

func ensureLocalREPLRuntime(candidateURL, room string) error {
	candidateURL = strings.TrimSpace(candidateURL)
	room = sanitizeREPLRoom(room)
	if candidateURL == "" {
		return fmt.Errorf("empty nats endpoint candidate")
	}
	if !isLocalNATSURL(candidateURL) {
		return nil
	}
	if !replv3.LeaderHealthy(candidateURL, 1200*time.Millisecond) {
		if !replAutostartEnabled() {
			return fmt.Errorf("no REPL daemon detected on %s (autostart disabled)", candidateURL)
		}
		logs.System("No REPL leader detected on %s; starting background leader for topic %s", candidateURL, room)
		if err := replv3.EnsureLeaderRunning(candidateURL, room); err != nil {
			return fmt.Errorf("repl leader autostart failed: %w", err)
		}
	}
	if replBootstrapHTTPAutostartEnabled() {
		host := strings.TrimSpace(os.Getenv("DIALTONE_REPL_BOOTSTRAP_HTTP_HOST"))
		if host == "" {
			host = "127.0.0.1"
		}
		port := 8811
		if raw := strings.TrimSpace(os.Getenv("DIALTONE_REPL_BOOTSTRAP_HTTP_PORT")); raw != "" {
			if p, err := strconv.Atoi(raw); err == nil && p > 0 {
				port = p
			}
		}
		if err := replv3.EnsureBootstrapHTTPRunning(host, port); err != nil {
			return fmt.Errorf("bootstrap http autostart failed: %w", err)
		}
	}
	return nil
}

func warmREPLForForegroundQuery(command string, args []string, targetHost string) error {
	if !shouldRunForegroundQuery(command, args) {
		return nil
	}
	room, candidateNATSURLs := resolveREPLDispatchCandidates(targetHost)
	if len(candidateNATSURLs) == 0 {
		return fmt.Errorf("no nats endpoint candidates were resolved")
	}
	attemptErrs := make([]string, 0, len(candidateNATSURLs))
	for _, candidateURL := range candidateNATSURLs {
		if err := ensureLocalREPLRuntime(candidateURL, room); err == nil {
			return nil
		} else {
			attemptErrs = append(attemptErrs, fmt.Sprintf("%s: %v", candidateURL, err))
		}
	}
	return fmt.Errorf("repl foreground warmup failed after %d endpoint attempt(s): %s", len(attemptErrs), strings.Join(attemptErrs, " | "))
}

func shouldLogBootstrapChecks() bool {
	if isLocalCLITestArgs(os.Args[1:]) {
		return false
	}
	if strings.TrimSpace(strings.ToLower(os.Getenv("DIALTONE_VERBOSE_BOOTSTRAP"))) == "1" {
		return true
	}
	if len(os.Args) < 2 {
		return true
	}
	command := strings.TrimSpace(os.Args[1])
	switch command {
	case "", "help", "-h", "--help", "dev", "plugins", "branch":
		return true
	case "repl":
		switch scaffoldSubcommand(os.Args[2:]) {
		case "", "help", "-h", "--help", "run", "join", "leader", "bootstrap", "bootstrap-http", "status":
			return true
		default:
			return false
		}
	default:
		return false
	}
}

func dispatchViaREPL(command string, args []string, targetHost string) error {
	user := replv3.DefaultPromptName()
	filtered := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := strings.TrimSpace(args[i])
		if a == "" {
			continue
		}
		if a == "--user" && i+1 < len(args) {
			u := strings.TrimSpace(args[i+1])
			if u != "" {
				user = u
			}
			i++
			continue
		}
		if strings.HasPrefix(a, "--user=") {
			u := strings.TrimSpace(strings.TrimPrefix(a, "--user="))
			if u != "" {
				user = u
			}
			continue
		}
		filtered = append(filtered, a)
	}
	displayLine := strings.TrimSpace(strings.Join(append([]string{command}, filtered...), " "))
	injectLine := strings.TrimSpace(shellJoin(append([]string{command}, filtered...)))
	if injectLine == "" {
		return fmt.Errorf("empty command")
	}
	if err := validateSingleCommandTokens(shellSplit(displayLine)); err != nil {
		return err
	}
	room, candidateNATSURLs := resolveREPLDispatchCandidates(targetHost)
	attemptErrs := make([]string, 0, len(candidateNATSURLs))
	for _, candidateURL := range candidateNATSURLs {
		if err := ensureLocalREPLRuntime(candidateURL, room); err != nil {
			attemptErrs = append(attemptErrs, fmt.Sprintf("%s: %v", candidateURL, err))
			continue
		}
		if err := relayInjectedIndexLifecycle(candidateURL, room, user, displayLine, injectLine, func() error {
			return replv3.InjectCommand(candidateURL, room, user, "", injectLine)
		}); err == nil {
			return nil
		} else {
			attemptErrs = append(attemptErrs, fmt.Sprintf("%s: %v", candidateURL, err))
		}
	}
	if len(attemptErrs) == 0 {
		return fmt.Errorf("no nats endpoint candidates were resolved")
	}
	return fmt.Errorf("repl inject failed after %d endpoint attempt(s): %s", len(attemptErrs), strings.Join(attemptErrs, " | "))
}

func relayInjectedIndexLifecycle(natsURL, room, user, displayLine, injectLine string, inject func() error) error {
	if inject == nil {
		return fmt.Errorf("inject function is required")
	}
	nc, err := nats.Connect(strings.TrimSpace(natsURL), nats.Timeout(1500*time.Millisecond))
	if err != nil {
		return inject()
	}
	defer nc.Close()

	room = sanitizeREPLRoom(room)
	subject := "repl.topic." + room
	targetInput := "/" + strings.TrimSpace(injectLine)
	displayInput := "/" + strings.TrimSpace(displayLine)
	requestLine := "Request received."
	seenInput := false
	startedLifecycle := false
	seenTaskQueued := false
	seenTaskTopic := false
	seenTaskLog := false
	taskID := ""
	done := make(chan struct{})
	var doneOnce sync.Once
	finish := func() {
		doneOnce.Do(func() {
			close(done)
		})
	}
	var subErr error
	sub, err := nc.Subscribe(subject, func(msg *nats.Msg) {
		frame := replv3.BusFrame{}
		if err := json.Unmarshal(msg.Data, &frame); err != nil {
			return
		}
		switch strings.TrimSpace(frame.Type) {
		case "input":
			if strings.TrimSpace(frame.From) != strings.TrimSpace(user) {
				return
			}
			if strings.TrimSpace(frame.Message) != targetInput {
				return
			}
			seenInput = true
			fmt.Fprintf(os.Stdout, "%s> %s\n", strings.TrimSpace(frame.From), displayInput)
		case "line":
			if !seenInput || strings.TrimSpace(frame.Scope) != "index" {
				return
			}
			msgText := strings.TrimSpace(frame.Message)
			if !startedLifecycle {
				if msgText != requestLine {
					return
				}
				startedLifecycle = true
				replv3.WriteDialtoneSystemLine(os.Stdout, msgText)
				return
			}
			if !shouldForwardInjectedQueueLine(msgText) {
				return
			}
			switch {
			case strings.HasPrefix(msgText, "Task queued as task-"):
				if seenTaskQueued {
					return
				}
				seenTaskQueued = true
				taskID = parseQueuedTaskID(msgText)
			case strings.HasPrefix(msgText, "Task topic: task."):
				if seenTaskTopic {
					return
				}
				seenTaskTopic = true
			case strings.HasPrefix(msgText, "Task log: "):
				if seenTaskLog {
					return
				}
				seenTaskLog = true
			default:
				return
			}
			replv3.WriteDialtoneSystemLine(os.Stdout, msgText)
			if seenTaskLog {
				if strings.TrimSpace(taskID) != "" {
					replv3.WriteDialtoneSystemLine(os.Stdout, fmt.Sprintf("To view the last 10 log lines: ./dialtone.sh repl src_v3 task log --task-id %s --lines 10", strings.TrimSpace(taskID)))
				}
				finish()
			}
		}
	})
	if err != nil {
		return inject()
	}
	defer func() {
		if unsubErr := sub.Unsubscribe(); unsubErr != nil && subErr == nil {
			subErr = unsubErr
		}
	}()
	if err := nc.Flush(); err != nil {
		return inject()
	}
	seenInput = true
	if err := inject(); err != nil {
		return err
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
	}
	return subErr
}

func sanitizeREPLRoom(room string) string {
	room = strings.TrimSpace(room)
	if room == "" {
		return "index"
	}
	return room
}

func shouldForwardInjectedQueueLine(msgText string) bool {
	msgText = strings.TrimSpace(msgText)
	switch {
	case msgText == "":
		return false
	case strings.HasPrefix(msgText, "Task queued as task-"):
		return true
	case strings.HasPrefix(msgText, "Task topic: task."):
		return true
	case strings.HasPrefix(msgText, "Task log: "):
		return true
	default:
		return false
	}
}

func parseQueuedTaskID(msgText string) string {
	msgText = strings.TrimSpace(msgText)
	const prefix = "Task queued as "
	if !strings.HasPrefix(msgText, prefix) {
		return ""
	}
	taskID := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(msgText, prefix), "."))
	if strings.HasPrefix(taskID, "task-") {
		return taskID
	}
	return ""
}

func resolveTargetNATSURLs(host string) []string {
	host = strings.TrimSpace(strings.TrimPrefix(host, "@"))
	if host == "" {
		return []string{"nats://127.0.0.1:4222"}
	}
	if strings.HasPrefix(host, "nats://") {
		return []string{host}
	}
	if strings.Contains(host, ":") && !strings.Contains(host, "/") {
		return []string{"nats://" + host}
	}
	if host == "localhost" || net.ParseIP(host) != nil {
		return []string{"nats://" + host + ":4222"}
	}

	out := make([]string, 0, 4)
	seen := map[string]struct{}{}
	add := func(raw string) {
		n := normalizeNATSURL(raw)
		if n == "" {
			return
		}
		if _, ok := seen[n]; ok {
			return
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}

	cfgPath := strings.TrimSpace(os.Getenv("DIALTONE_MESH_CONFIG"))
	if cfgPath == "" {
		cfgPath = strings.TrimSpace(os.Getenv("DIALTONE_ENV_FILE"))
	}
	if cfgPath == "" {
		repoRoot := strings.TrimSpace(os.Getenv("DIALTONE_REPO_ROOT"))
		if repoRoot != "" {
			cfgPath = filepath.Join(repoRoot, "env", "dialtone.json")
		}
	}
	if cfgPath != "" {
		if b, err := os.ReadFile(cfgPath); err == nil {
			var cfg replMeshConfig
			if err := json.Unmarshal(b, &cfg); err == nil {
				target := strings.ToLower(host)
				for _, node := range cfg.MeshNodes {
					if meshNodeMatches(node, target) {
						if v := strings.TrimSpace(node.NATSURL); v != "" {
							add(v)
						}
						port := node.NATSPort
						if port <= 0 {
							port = 4222
						}
						// Prefer host candidates (tailnet/LAN fallback), then node host.
						for _, c := range node.HostCandidates {
							candidate := strings.TrimSpace(c)
							if candidate == "" {
								continue
							}
							add(fmt.Sprintf("%s:%d", candidate, port))
						}
						candidate := strings.TrimSpace(node.Host)
						for _, c := range node.HostCandidates {
							if strings.TrimSpace(c) != "" {
								candidate = strings.TrimSpace(c)
								break
							}
						}
						if candidate != "" {
							add(fmt.Sprintf("%s:%d", candidate, port))
						}
						break
					}
				}
			}
		}
	}
	add(host + ":4222")
	if len(out) == 0 {
		return []string{"nats://127.0.0.1:4222"}
	}
	return out
}

func runViaSSHHost(host, command string, args []string) error {
	host = strings.TrimSpace(host)
	if host == "" {
		return fmt.Errorf("--ssh-host requires a host value")
	}
	baseArgs := append([]string{"./dialtone.sh", command}, args...)
	remoteDialtoneCmd := shellJoin(baseArgs)
	remoteRepo := strings.TrimSpace(os.Getenv("DIALTONE_REMOTE_REPO"))
	var remoteCmd string
	if remoteRepo != "" {
		remoteCmd = fmt.Sprintf(
			"if [ -x %s/dialtone.sh ]; then cd %s && %s; elif [ -x ./dialtone.sh ]; then %s; elif [ -x \"$HOME/dialtone/dialtone.sh\" ]; then cd \"$HOME/dialtone\" && %s; else echo \"dialtone.sh not found in %s, $PWD, or $HOME/dialtone\" >&2; exit 127; fi",
			shellQuote(remoteRepo), shellQuote(remoteRepo), remoteDialtoneCmd, remoteDialtoneCmd, remoteDialtoneCmd, shellQuote(remoteRepo),
		)
	} else {
		remoteCmd = fmt.Sprintf(
			"if [ -x ./dialtone.sh ]; then %s; elif [ -x \"$HOME/dialtone/dialtone.sh\" ]; then cd \"$HOME/dialtone\" && %s; else echo \"dialtone.sh not found in $PWD or $HOME/dialtone\" >&2; exit 127; fi",
			remoteDialtoneCmd, remoteDialtoneCmd,
		)
	}
	sshArgs := []string{
		"src_v1",
		"run",
		"--host", host,
		"--cmd", remoteCmd,
	}
	return runPluginScaffold("ssh", sshArgs)
}

func shellJoin(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, shellQuote(a))
	}
	return strings.Join(quoted, " ")
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func shellSplit(line string) []string {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}
	args := make([]string, 0, 8)
	var cur strings.Builder
	var quote rune
	flush := func() {
		if cur.Len() == 0 {
			return
		}
		args = append(args, cur.String())
		cur.Reset()
	}
	for i := 0; i < len(line); i++ {
		ch := rune(line[i])
		if quote != 0 {
			if ch == quote {
				quote = 0
				continue
			}
			if ch == '\\' && quote == '"' && i+1 < len(line) {
				i++
				cur.WriteByte(line[i])
				continue
			}
			cur.WriteRune(ch)
			continue
		}
		switch ch {
		case '\'', '"':
			quote = ch
		case ' ', '\t', '\n', '\r':
			flush()
		case '\\':
			if i+1 < len(line) {
				i++
				cur.WriteByte(line[i])
			}
		default:
			cur.WriteRune(ch)
		}
	}
	flush()
	return args
}

func validateSingleCommandTokens(args []string) error {
	if len(args) == 0 {
		return nil
	}
	for i, arg := range args {
		token := strings.TrimSpace(arg)
		switch token {
		case "&&", "||", ";":
			return fmt.Errorf("DIALTONE ERROR: run exactly one ./dialtone.sh command at a time; command chaining with %q is not allowed. Use one foreground command per turn, or a single command with a trailing & for background mode.", token)
		case "&":
			if i != len(args)-1 {
				return fmt.Errorf("DIALTONE ERROR: run exactly one ./dialtone.sh command at a time; only a trailing & is allowed for background mode")
			}
		}
	}
	return nil
}

func meshNodeMatches(node replMeshNode, target string) bool {
	if strings.EqualFold(strings.TrimSpace(node.Name), target) {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(node.Host), target) {
		return true
	}
	for _, a := range node.Aliases {
		if strings.EqualFold(strings.TrimSpace(a), target) {
			return true
		}
	}
	for _, c := range node.HostCandidates {
		if strings.EqualFold(strings.TrimSpace(c), target) {
			return true
		}
	}
	return false
}

func normalizeNATSURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "nats://127.0.0.1:4222"
	}
	if strings.HasPrefix(raw, "nats://") {
		return raw
	}
	if strings.Contains(raw, ":") && !strings.Contains(raw, "/") {
		return "nats://" + raw
	}
	return "nats://" + raw + ":4222"
}

func isLocalNATSURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	host := strings.TrimSpace(strings.ToLower(u.Hostname()))
	switch host {
	case "", "127.0.0.1", "localhost", "0.0.0.0", "::1", "::":
		return true
	default:
		return false
	}
}

func logBootstrapChecks() {
	repoRoot := strings.TrimSpace(os.Getenv("DIALTONE_REPO_ROOT"))
	srcRoot := strings.TrimSpace(os.Getenv("DIALTONE_SRC_ROOT"))
	envDir := strings.TrimSpace(os.Getenv("DIALTONE_ENV"))
	envFile := strings.TrimSpace(os.Getenv("DIALTONE_ENV_FILE"))
	meshFile := strings.TrimSpace(os.Getenv("DIALTONE_MESH_CONFIG"))
	goBin := strings.TrimSpace(os.Getenv("DIALTONE_GO_BIN"))

	logs.System("Bootstrap checks:")
	logPathCheck("repo root", repoRoot)
	logPathCheck("src root", srcRoot)
	logPathCheck("env dir", envDir)
	logPathCheck("env json", envFile)
	logPathCheck("mesh config", meshFile)
	logPathCheck("go bin", goBin)

	natsURL := strings.TrimSpace(os.Getenv("DIALTONE_REPL_NATS_URL"))
	if natsURL == "" {
		natsURL = "nats://127.0.0.1:4222"
	}
	logs.System("State:")
	natsReachable := endpointReachable(natsURL, 700*time.Millisecond)
	logs.System("- nats endpoint %s reachable=%t", natsURL, natsReachable)
	logs.System("- repl leader process running=%t", replLeaderProcessRunning())

	if active, provider, tailnet := tsnetv1.NativeTailnetConnected(); active {
		logs.System("- tailnet active=true provider=%s tailnet=%s", provider, strings.TrimSpace(tailnet))
	} else {
		logs.System("- tailnet active=false")
	}

	logs.System("- cloudflare running=%t", cloudflaredRunning())

	host := strings.TrimSpace(os.Getenv("DIALTONE_REPL_BOOTSTRAP_HTTP_HOST"))
	if host == "" {
		host = "127.0.0.1"
	}
	port := 8811
	if raw := strings.TrimSpace(os.Getenv("DIALTONE_REPL_BOOTSTRAP_HTTP_PORT")); raw != "" {
		if p, err := strconv.Atoi(raw); err == nil && p > 0 {
			port = p
		}
	}
	bootstrapRunning := bootstrapHTTPReachable(host, port)
	logs.System("- bootstrap http %s running=%t", fmt.Sprintf("http://%s:%d/install.sh", host, port), bootstrapRunning)
	logs.System("- bootstrap http process running=%t", bootstrapHTTPProcessRunning())

	replScaffold := fileExists(filepath.Join(srcRoot, "plugins", "repl", "scaffold", "main.go"))
	procScaffold := fileExists(filepath.Join(srcRoot, "plugins", "proc", "scaffold", "main.go"))
	sshScaffold := fileExists(filepath.Join(srcRoot, "plugins", "ssh", "scaffold", "main.go"))
	logs.System("Command checks:")
	logs.System("- help command available=true")
	logs.System("- ps command available=%t (proc scaffold)", procScaffold)
	logs.System("- ssh command available=%t (ssh scaffold)", sshScaffold)
	logs.System("- repl command path available=%t (repl scaffold)", replScaffold)
	logs.System("- repl injection ready=%t", natsReachable && replScaffold)
	logs.System("- repl autostart enabled=%t", replAutostartEnabled())
	logs.System("- bootstrap http autostart enabled=%t", replBootstrapHTTPAutostartEnabled())

	validateEnvJSON(envFile)
}

func logPathCheck(label, path string) {
	p := strings.TrimSpace(path)
	if p == "" {
		logs.System("- %s: <empty>", label)
		return
	}
	info, err := os.Stat(p)
	if err != nil {
		logs.System("- %s: %s (missing)", label, p)
		return
	}
	kind := "file"
	if info.IsDir() {
		kind = "dir"
	}
	logs.System("- %s: %s (%s)", label, p, kind)
}

func cloudflaredRunning() bool {
	if runtime.GOOS == "windows" {
		return false
	}
	cmd := exec.Command("pgrep", "-f", "cloudflared")
	return cmd.Run() == nil
}

func replLeaderProcessRunning() bool {
	if runtime.GOOS == "windows" {
		return false
	}
	if processMatch(`plugins/repl/scaffold/main.go src_v3 leader`) {
		return true
	}
	if processMatch(`src_v3 leader --embedded-nats`) {
		return true
	}
	return false
}

func bootstrapHTTPProcessRunning() bool {
	if runtime.GOOS == "windows" {
		return false
	}
	return processMatch(`bootstrap-http --host`)
}

func processMatch(pattern string) bool {
	cmd := exec.Command("pgrep", "-f", pattern)
	return cmd.Run() == nil
}

func bootstrapHTTPReachable(host string, port int) bool {
	client := &http.Client{Timeout: 800 * time.Millisecond}
	resp, err := client.Get(fmt.Sprintf("http://%s:%d/install.sh", host, port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func validateEnvJSON(path string) {
	path = strings.TrimSpace(path)
	logs.System("env/dialtone.json checks:")
	if path == "" {
		logs.System("- format valid=false (env file path empty)")
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		logs.System("- format valid=false (read error: %v)", err)
		return
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		logs.System("- format valid=false (json error: %v)", err)
		return
	}
	logs.System("- format valid=true")

	requiredCore := []string{"DIALTONE_HOME", "DIALTONE_ENV", "DIALTONE_REPO_ROOT"}
	for _, key := range requiredCore {
		logs.System("- required %s present=%t", key, nonEmptyJSONValue(doc, key))
	}
	logs.System("- shared go cache configured=%t", nonEmptyJSONValue(doc, "DIALTONE_GO_CACHE_DIR"))
	logs.System("- shared bun cache configured=%t", nonEmptyJSONValue(doc, "DIALTONE_BUN_CACHE_DIR"))

	tsReady := nonEmptyJSONValue(doc, "TS_AUTHKEY") || (nonEmptyJSONValue(doc, "TS_API_KEY") && nonEmptyJSONValue(doc, "TS_TAILNET"))
	logs.System("- tsnet bootstrap keys present=%t (TS_AUTHKEY or TS_API_KEY+TS_TAILNET)", tsReady)

	cfReady := nonEmptyJSONValue(doc, "CF_TUNNEL_TOKEN_SHELL") || (nonEmptyJSONValue(doc, "CLOUDFLARE_API_TOKEN") && nonEmptyJSONValue(doc, "CLOUDFLARE_ACCOUNT_ID"))
	logs.System("- cloudflare bootstrap keys present=%t (CF_TUNNEL_TOKEN_SHELL or CLOUDFLARE_API_TOKEN+CLOUDFLARE_ACCOUNT_ID)", cfReady)

	nodesOK, nodeCount := meshNodesReady(doc["mesh_nodes"])
	logs.System("- mesh_nodes valid=%t count=%d (each needs name+host+user)", nodesOK, nodeCount)
}

func nonEmptyJSONValue(doc map[string]any, key string) bool {
	v, ok := doc[key]
	if !ok || v == nil {
		return false
	}
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t) != ""
	case float64:
		return true
	case bool:
		return true
	default:
		return fmt.Sprintf("%v", t) != ""
	}
}

func meshNodesReady(raw any) (bool, int) {
	nodes, ok := raw.([]any)
	if !ok || len(nodes) == 0 {
		return false, 0
	}
	count := 0
	for _, n := range nodes {
		m, ok := n.(map[string]any)
		if !ok {
			return false, count
		}
		if !mapValueNonEmpty(m, "name") || !mapValueNonEmpty(m, "host") || !mapValueNonEmpty(m, "user") {
			return false, count
		}
		count++
	}
	return true, count
}

func mapValueNonEmpty(m map[string]any, key string) bool {
	v, ok := m[key]
	if !ok || v == nil {
		return false
	}
	s, ok := v.(string)
	if !ok {
		return false
	}
	return strings.TrimSpace(s) != ""
}

func detectMissingForREPL() []MissingInstall {
	missing := []MissingInstall{}
	envDir := GetDialtoneEnv()
	goBinName := "go"
	bunBinName := "bun"
	installPrefix := "./dialtone.sh"
	if runtime.GOOS == "windows" {
		goBinName = "go.exe"
		bunBinName = "bun.exe"
		installPrefix = ".\\dialtone.ps1"
	}
	goBin := filepath.Join(envDir, "go", "bin", goBinName)
	if _, err := os.Stat(goBin); err != nil {
		missing = append(missing, MissingInstall{
			Tool:    "Go runtime",
			Command: installPrefix + " go src_v1 install",
			Why:     "required to run plugin scaffolds and queued task workers",
		})
	}
	bunBin := filepath.Join(envDir, "bun", "bin", bunBinName)
	if _, err := os.Stat(bunBin); err != nil {
		missing = append(missing, MissingInstall{
			Tool:    "Bun runtime",
			Command: installPrefix + " bun src_v1 install",
			Why:     "required for plugins that build or run JS/TS UIs",
		})
	}
	return missing
}

func runDevInstall() {
	missing := detectMissingForREPL()
	if len(missing) == 0 {
		logs.Info("Managed runtimes already installed.")
		logs.Info("Ready. You can now run plugin commands (install/build/test) via DIALTONE.")
		return
	}

	needGo := false
	needBun := false
	for _, m := range missing {
		switch m.Tool {
		case "Go runtime":
			needGo = true
		case "Bun runtime":
			needBun = true
		}
	}

	if needGo {
		logs.Info("Installing managed Go runtime...")
		if err := runPluginScaffold("go", []string{"src_v1", "install", "--latest"}); err != nil {
			logs.Error("Go install failed: %v", err)
			return
		}
	}
	if needBun {
		logs.Info("Installing managed Bun runtime...")
		if err := runPluginScaffold("bun", []string{"src_v1", "install"}); err != nil {
			logs.Error("Bun install failed: %v", err)
			return
		}
	}

	logs.Info("Bootstrap complete. Initializing dev.go scaffold...")
	logs.Info("Ready. You can now run plugin commands (install/build/test) via DIALTONE.")
}

func printDevUsage() {
	script := "./dialtone.sh"
	if runtime.GOOS == "windows" {
		script = ".\\dialtone.cmd"
	}
	logs.Info("Usage: %s <command> [options]", script)
	logs.Info("Global flags:")
	logs.Info("  --no-stdout          Disable stdout mirroring (logs still publish to NATS)")
	logs.Info("  --target-host <host> Route injected command to a specific REPL host over NATS/tsnet")
	logs.Info("  --host <host>        Alias of --target-host (NATS routing, not SSH)")
	logs.Info("  --ssh-host <host>    Run any command over SSH transport via ssh src_v1 run --host <host>")
	logs.Info("")
	logs.Info("Dev orchestrator commands:")
	logs.Info("  test                 Run ordered Dialtone Earth test inventory (offline guarded auth first, remaining live tests skipped)")
	logs.Info("  plugins              List available plugin scaffolds")
	logs.Info("  branch <name>        Create or checkout a feature branch")
	logs.Info("  help                 Show this help")
	logs.Info("")
	logs.Info("Plugin routing:")
	logs.Info("  <plugin> <args...>   Run <plugin>/{scaffold|cli}/main.go in src/plugins (or scaffold.sh/cli.sh)")
	logs.Info("")
	logs.Info("Examples:")
	logs.Info("  ./dialtone.sh go install --latest")
	logs.Info("  ./dialtone.sh go exec version")
	logs.Info("  ./dialtone.sh robot install src_v1")
	logs.Info("  ./dialtone.sh dag install src_v3")
	logs.Info("  ./dialtone.sh gemini run --task task.md")
	logs.Info("  ./dialtone.sh go src_v1 version --host grey")
	logs.Info("  ./dialtone.sh go src_v1 version --ssh-host grey")
	logs.Info("  ./dialtone.sh test src_v1 test --target-host wsl")
}

func listPlugins() {
	roots := []string{"plugins"}
	seen := map[string]struct{}{}
	logs.Info("Available commands with scaffold:")
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			name := entry.Name()
			if _, exists := seen[name]; exists {
				continue
			}
			goScaffold := filepath.Join(root, name, "scaffold", "main.go")
			cliScaffold := filepath.Join(root, name, "cli", "main.go")
			shScaffold := filepath.Join(root, name, "scaffold.sh")
			cliShell := filepath.Join(root, name, "cli.sh")
			if fileExists(goScaffold) || fileExists(shScaffold) {
				logs.Info("  - %s (%s)", name, root)
				seen[name] = struct{}{}
				continue
			}
			if fileExists(cliScaffold) || fileExists(cliShell) {
				logs.Info("  - %s (%s)", name, root)
				seen[name] = struct{}{}
			}
		}
	}
}

func runPluginScaffold(plugin string, args []string) error {
	roots := []string{"plugins"}
	pluginDir := ""
	var fallbackDir string
	for _, root := range roots {
		candidate := filepath.Join(root, plugin)
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			goScaffold := filepath.Join(candidate, "scaffold", "main.go")
			cliScaffold := filepath.Join(candidate, "cli", "main.go")
			shScaffold := filepath.Join(candidate, "scaffold.sh")
			if fileExists(goScaffold) || fileExists(cliScaffold) || fileExists(shScaffold) {
				pluginDir = candidate
				break
			}
			if fallbackDir == "" {
				fallbackDir = candidate
			}
		}
	}
	if pluginDir == "" && fallbackDir != "" {
		pluginDir = fallbackDir
	}
	if pluginDir == "" {
		return logs.Errorf("unknown plugin: %s", plugin)
	}

	goScaffold := filepath.Join(pluginDir, "scaffold", "main.go")
	cliScaffold := filepath.Join(pluginDir, "cli", "main.go")
	if fileExists(goScaffold) {
		var cmd *exec.Cmd
		if fileExists(filepath.Join(pluginDir, "go.mod")) {
			cmd = exec.Command("go", append([]string{"run", "./scaffold/main.go"}, args...)...)
			cmd.Dir = pluginDir
		} else {
			cmd = exec.Command("go", append([]string{"run", "./" + filepath.ToSlash(goScaffold)}, args...)...)
		}
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		return cmd.Run()
	}

	if fileExists(cliScaffold) {
		var cmd *exec.Cmd
		if fileExists(filepath.Join(pluginDir, "go.mod")) {
			cmd = exec.Command("go", append([]string{"run", "./cli/main.go"}, args...)...)
			cmd.Dir = pluginDir
		} else {
			cmd = exec.Command("go", append([]string{"run", "./" + filepath.ToSlash(cliScaffold)}, args...)...)
		}
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		return cmd.Run()
	}

	shScaffold := filepath.Join(pluginDir, "scaffold.sh")
	if fileExists(shScaffold) {
		cmd := exec.Command("bash", append([]string{shScaffold}, args...)...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		return cmd.Run()
	}

	return logs.Errorf("plugin %s has no scaffold/cli main.go or scaffold.sh/cli.sh in candidate roots", plugin)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func runBranch(args []string) {
	if len(args) == 0 {
		logs.Error("Usage: ./dialtone.sh branch <name>")
		os.Exit(1)
	}

	branchName := args[0]
	check := exec.Command("git", "branch", "--list", branchName)
	output, err := check.Output()
	if err != nil {
		logs.Error("Failed to check branches: %v", err)
		os.Exit(1)
	}

	var cmd *exec.Cmd
	if strings.TrimSpace(string(output)) != "" {
		logs.Info("Branch '%s' exists, checking out...", branchName)
		cmd = exec.Command("git", "checkout", branchName)
	} else {
		logs.Info("Creating new branch '%s'...", branchName)
		cmd = exec.Command("git", "checkout", "-b", branchName)
	}

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		logs.Error("Git operation failed: %v", err)
		os.Exit(1)
	}

	logs.Info("Now on branch: %s", branchName)
}

func startDefaultMultiplayerREPL() error {
	room := resolveREPLTopicEnv()
	clientURL := strings.TrimSpace(os.Getenv("DIALTONE_REPL_NATS_URL"))
	if clientURL == "" {
		clientURL = "nats://127.0.0.1:4222"
	}
	joinArgs := []string{"--nats-url", clientURL, room}
	leaderHealthy := replv3.LeaderHealthy(clientURL, 1200*time.Millisecond)
	if !leaderHealthy && !replAutostartEnabled() {
		return fmt.Errorf("no REPL daemon detected on %s (autostart disabled). start daemon with: ./dialtone.sh repl src_v3 service --mode run --topic %s", clientURL, room)
	}
	if !leaderHealthy {
		logs.System("No REPL leader detected on %s; starting background leader for topic %s", clientURL, room)
		if err := replv3.EnsureLeaderRunning(clientURL, room); err != nil {
			return err
		}
	}
	if replBootstrapHTTPAutostartEnabled() {
		host := strings.TrimSpace(os.Getenv("DIALTONE_REPL_BOOTSTRAP_HTTP_HOST"))
		if host == "" {
			host = "127.0.0.1"
		}
		port := 8811
		if raw := strings.TrimSpace(os.Getenv("DIALTONE_REPL_BOOTSTRAP_HTTP_PORT")); raw != "" {
			if p, err := strconv.Atoi(raw); err == nil && p > 0 {
				port = p
			}
		}
		if err := replv3.EnsureBootstrapHTTPRunning(host, port); err != nil {
			return err
		}
		logs.System("Bootstrap installer available at http://%s:%d/install.sh", host, port)
	}
	logREPLStartupState(clientURL, room)
	return replv3.RunJoin(joinArgs)
}

func logREPLStartupState(clientURL, room string) {
	hostName := strings.TrimSpace(replv3.DefaultPromptName())
	if hostName == "" {
		hostName = "unknown"
	}
	cpuCores := runtime.NumCPU()
	memText := humanizeBytes(detectHostMemoryBytes())
	if memText == "" {
		memText = "unknown"
	}

	logs.System("REPL startup state:")
	logs.System("- repl version=%s host=%s os=%s arch=%s cpu_cores=%d mem_total=%s", strings.TrimSpace(replv3.BuildVersion), hostName, runtime.GOOS, runtime.GOARCH, cpuCores, memText)
	logs.System("- topic=%s nats=%s reachable=%t", strings.TrimSpace(room), strings.TrimSpace(clientURL), endpointReachable(clientURL, 700*time.Millisecond))

	pids := replLeaderPIDs()
	if len(pids) == 0 {
		logs.System("- repl leader pid=<none>")
	} else {
		logs.System("- repl leader pid(s)=%s", joinInts(pids, ","))
		for _, pid := range pids {
			cpuPct, rssKB, etime := replProcessStats(pid)
			rssText := "-"
			if rssKB > 0 {
				rssText = humanizeBytes(uint64(rssKB) * 1024)
			}
			logs.System("  pid=%d cpu=%s%% rss=%s etime=%s", pid, cpuPct, rssText, etime)
		}
	}

	if active, provider, tailnet := tsnetv1.NativeTailnetConnected(); active {
		logs.System("- native tailscale active=true provider=%s tailnet=%s", provider, strings.TrimSpace(tailnet))
	} else {
		logs.System("- native tailscale active=false")
	}
	if cfg, err := tsnetv1.ResolveConfig(hostName, ""); err == nil {
		logs.System("- tsnet config hostname=%s tailnet=%s auth_key=%t api_key=%t", strings.TrimSpace(cfg.Hostname), strings.TrimSpace(cfg.Tailnet), cfg.AuthKeyPresent, cfg.APIKeyPresent)
	}

	bootstrapHost := strings.TrimSpace(os.Getenv("DIALTONE_REPL_BOOTSTRAP_HTTP_HOST"))
	if bootstrapHost == "" {
		bootstrapHost = "127.0.0.1"
	}
	bootstrapPort := 8811
	if raw := strings.TrimSpace(os.Getenv("DIALTONE_REPL_BOOTSTRAP_HTTP_PORT")); raw != "" {
		if p, err := strconv.Atoi(raw); err == nil && p > 0 {
			bootstrapPort = p
		}
	}
	logs.System("- bootstrap_http=%s running=%t", fmt.Sprintf("http://%s:%d/install.sh", bootstrapHost, bootstrapPort), bootstrapHTTPReachable(bootstrapHost, bootstrapPort))
}

func replLeaderPIDs() []int {
	if runtime.GOOS == "windows" {
		return nil
	}
	patterns := []string{
		`plugins/repl/scaffold/main.go src_v3 leader`,
		`src_v3 leader --embedded-nats`,
	}
	seen := map[int]struct{}{}
	out := make([]int, 0, 2)
	for _, p := range patterns {
		cmd := exec.Command("pgrep", "-f", p)
		raw, err := cmd.Output()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			pid, err := strconv.Atoi(line)
			if err != nil || pid <= 0 {
				continue
			}
			if _, ok := seen[pid]; ok {
				continue
			}
			seen[pid] = struct{}{}
			out = append(out, pid)
		}
	}
	sort.Ints(out)
	return out
}

func replProcessStats(pid int) (cpuPct string, rssKB int, etime string) {
	cpuPct = "-"
	etime = "-"
	if pid <= 0 || runtime.GOOS == "windows" {
		return cpuPct, 0, etime
	}
	if out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "pcpu=").Output(); err == nil {
		v := strings.TrimSpace(string(out))
		if v != "" {
			cpuPct = v
		}
	}
	if out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "rss=").Output(); err == nil {
		if parsed, perr := strconv.Atoi(strings.TrimSpace(string(out))); perr == nil && parsed > 0 {
			rssKB = parsed
		}
	}
	if out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "etime=").Output(); err == nil {
		v := strings.TrimSpace(string(out))
		if v != "" {
			etime = v
		}
	}
	return cpuPct, rssKB, etime
}

func detectHostMemoryBytes() uint64 {
	switch runtime.GOOS {
	case "darwin":
		if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
			if v, perr := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64); perr == nil {
				return v
			}
		}
	case "linux":
		if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
			for _, line := range strings.Split(string(raw), "\n") {
				line = strings.TrimSpace(line)
				if !strings.HasPrefix(line, "MemTotal:") {
					continue
				}
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if kb, perr := strconv.ParseUint(fields[1], 10, 64); perr == nil {
						return kb * 1024
					}
				}
				break
			}
		}
	}
	return 0
}

func humanizeBytes(v uint64) string {
	if v == 0 {
		return ""
	}
	const unit = 1024
	if v < unit {
		return fmt.Sprintf("%d B", v)
	}
	div, exp := uint64(unit), 0
	for n := v / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	suffixes := []string{"KiB", "MiB", "GiB", "TiB", "PiB"}
	if exp < 0 || exp >= len(suffixes) {
		return fmt.Sprintf("%d B", v)
	}
	return fmt.Sprintf("%.1f %s", float64(v)/float64(div), suffixes[exp])
}

func joinInts(vals []int, sep string) string {
	if len(vals) == 0 {
		return ""
	}
	parts := make([]string, 0, len(vals))
	for _, v := range vals {
		parts = append(parts, strconv.Itoa(v))
	}
	return strings.Join(parts, sep)
}

func replAutostartEnabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("DIALTONE_REPL_AUTOSTART")))
	switch v {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

func replBootstrapHTTPAutostartEnabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("DIALTONE_REPL_BOOTSTRAP_HTTP_AUTOSTART")))
	switch v {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

func endpointReachable(natsURL string, timeout time.Duration) bool {
	u, err := url.Parse(strings.TrimSpace(natsURL))
	if err != nil {
		return false
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "4222"
	}
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

type cliTestCase struct {
	Title string
	Run   func() error
}

func defaultCLITestInventory() []cliTestCase {
	hosts := []string{"vm-us", "vm-eu", "vm-asia", "Rosie", "Legion", "Build-1"}
	cases := make([]cliTestCase, 0, 3+len(hosts)*3)
	cases = append(cases,
		cliTestCase{
			Title: "offline guarded authorization",
			Run: func() error {
				report, err := guardauth.RunOfflineGuardedAuthorizationCheck()
				if err != nil {
					return err
				}
				if report.ChecksExecuted < 9 || report.AuditEvents < 8 {
					return fmt.Errorf("insufficient offline authorization assertions: checks=%d audit=%d", report.ChecksExecuted, report.AuditEvents)
				}
				return nil
			},
		},
		cliTestCase{Title: "browser sign-in"},
		cliTestCase{Title: "Metal/Test isolation"},
	)
	for _, host := range hosts {
		cases = append(cases, cliTestCase{Title: "heartbeat " + host})
	}
	for _, host := range hosts {
		cases = append(cases,
			cliTestCase{Title: "fixed whoami " + host},
			cliTestCase{Title: "audit " + host},
		)
	}
	return cases
}

func isLegacyTestPluginInvocation(args []string) bool {
	if len(args) >= 1 && strings.HasPrefix(strings.ToLower(strings.TrimSpace(args[0])), "src_v") {
		return true
	}
	if len(args) >= 2 && strings.HasPrefix(strings.ToLower(strings.TrimSpace(args[1])), "src_v") {
		return true
	}
	return false
}

func isLocalCLITestArgs(argv []string) bool {
	filtered := make([]string, 0, len(argv))
	for _, raw := range argv {
		arg := strings.TrimSpace(raw)
		if arg == "" || arg == "--stdout" || arg == "--no-stdout" {
			continue
		}
		filtered = append(filtered, raw)
	}
	if len(filtered) == 0 {
		return false
	}
	if strings.ToLower(strings.TrimSpace(filtered[0])) != "test" {
		return false
	}
	targetHost, sshHost, rest := extractTransportFlags("test", filtered[1:])
	if strings.TrimSpace(targetHost) != "" || strings.TrimSpace(sshHost) != "" {
		return false
	}
	return !isLegacyTestPluginInvocation(rest)
}

func runLocalCLITest(args []string, out io.Writer) int {
	cases := defaultCLITestInventory()
	if len(args) > 0 {
		// Reject unexpected arguments while preserving strict stdout log contract
		// and nonzero failure exit.
		cases[0].Run = func() error {
			return fmt.Errorf("unexpected test arguments: %s", strings.Join(args, " "))
		}
	}
	return runCLITestInventory(cases, out)
}

// runCLITestInventory executes ONLY the first ordered test and emits exactly one
// RFC3339 structured log line per ordered test ("PASS <title>", "FAIL <title>",
// or "SKIP <title>"). Remaining tests are never executed and always emit SKIP.
func runCLITestInventory(cases []cliTestCase, out io.Writer) int {
	if out == nil {
		out = os.Stdout
	}
	exitCode := 0
	for i, tc := range cases {
		title := strings.TrimSpace(tc.Title)
		if i == 0 && tc.Run != nil {
			if err := tc.Run(); err != nil {
				logs.WriteStructuredLines(out, "ERROR", logs.CallerFileLine(1), "FAIL "+title)
				exitCode = 1
			} else {
				logs.WriteStructuredLines(out, "INFO", logs.CallerFileLine(1), "PASS "+title)
			}
			continue
		}
		// Never advance to test 2 or any subsequent planned live test.
		logs.WriteStructuredLines(out, "WARN", logs.CallerFileLine(1), "SKIP "+title)
	}
	return exitCode
}

func buildOfflineTestEnv(base []string) []string {
	if len(base) == 0 {
		base = os.Environ()
	}
	out := make([]string, 0, len(base)+4)
	for _, kv := range base {
		k, _, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch strings.ToUpper(k) {
		case "DIALTONE_LOG_NATS", "DIALTONE_USE_NIX", "GOPROXY", "GOTOOLCHAIN":
			continue
		}
		out = append(out, kv)
	}
	out = append(out, "DIALTONE_LOG_NATS=0", "DIALTONE_USE_NIX=0", "GOPROXY=off", "GOTOOLCHAIN=local")
	return out
}

// runOfflineLoop only repeats the fixed native offline inventory. The first
// tick runs immediately; later ticks wait ten minutes after completion.
func runOfflineLoop(args []string, out, errOut io.Writer, wait func(time.Duration)) int {
	count := 0
	if len(args) == 1 && args[0] == "--once" {
		count = 1
	} else if len(args) == 2 && args[0] == "--max-count" {
		for n := 1; n <= 48; n++ {
			if args[1] == fmt.Sprint(n) {
				count = n
				break
			}
		}
	}
	if count == 0 {
		fmt.Fprintln(errOut, "usage: dialtone loop --once | --max-count N (1-48)")
		return 2
	}
	logs.SetOutput(out)
	for i := 0; i < count; i++ {
		if i > 0 {
			wait(10 * time.Minute)
		}
		if code := runLocalCLITest(nil, out); code != 0 {
			return code
		}
	}
	return 0
}
