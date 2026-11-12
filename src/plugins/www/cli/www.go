package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	chrome "dialtone/dev/plugins/chrome/src_v1/go"
	configv1 "dialtone/dev/plugins/config/src_v1/go"
	wwwtest "dialtone/dev/plugins/www/test"

	"github.com/chromedp/chromedp"
	stdruntime "runtime"
)

func getDialtoneCmd(args ...string) *exec.Cmd {
	if stdruntime.GOOS == "windows" {
		return exec.Command("powershell", append([]string{"-ExecutionPolicy", "Bypass", "-File", ".\\dialtone.ps1"}, args...)...)
	}
	return exec.Command("./dialtone.sh", args...)
}

func logInfo(format string, args ...interface{}) {
	fmt.Printf("[www] "+format+"\n", args...)
}

func logFatal(format string, args ...interface{}) {
	fmt.Printf("[www] FATAL: "+format+"\n", args...)
	os.Exit(1)
}

func dialtoneBunPath() (string, bool) {
	envDir := configv1.DefaultDialtoneEnv()
	candidates := []string{
		configv1.ManagedBunBinPath(envDir),
		filepath.Join(envDir, "bin", "bun"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, true
		}
	}
	return "", false
}

func dialtoneNpmPath() (string, bool) {
	envDir := configv1.DefaultDialtoneEnv()
	candidate := filepath.Join(envDir, "node", "bin", "npm")
	if _, err := os.Stat(candidate); err == nil {
		return candidate, true
	}
	return "", false
}

func installWwwDeps(webDir string) {
	if bunPath, ok := dialtoneBunPath(); ok {
		logInfo("Installing dependencies with DIALTONE_ENV bun: %s", bunPath)
		cmd := exec.Command(bunPath, "install")
		cmd.Dir = webDir
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		if err := cmd.Run(); err != nil {
			logFatal("bun install failed: %v", err)
		}
		return
	}

	if npmPath, ok := dialtoneNpmPath(); ok {
		logInfo("Installing dependencies with DIALTONE_ENV npm: %s", npmPath)
		cmd := exec.Command(npmPath, "install")
		cmd.Dir = webDir
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		if err := cmd.Run(); err != nil {
			logFatal("npm install failed: %v", err)
		}
		return
	}

	logFatal("Neither Bun nor npm found in DIALTONE_ENV. Run './dialtone.sh install' first.")
}

func ensureNpmDeps(webDir string) {
	tscPath := filepath.Join(webDir, "node_modules", ".bin", "tsc")
	if _, err := os.Stat(tscPath); err == nil {
		return
	}

	installWwwDeps(webDir)
}

func runCommand(dir, name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		logFatal("%s failed: %v", filepath.Base(name), err)
	}
}

func runWwwNpmScript(webDir, script string) {
	ensureNpmDeps(webDir)
	runCommand(webDir, "npm", "run", script)
}

func publishRegistry(registryDir string, args []string) {
	for _, arg := range args {
		if arg == "--help" || arg == "-h" {
			fmt.Println("Usage: dialtone www publish [options]")
			fmt.Println("\nTests, builds, and deploys registry/ to the dialtone-earth Cloudflare Worker.")
			fmt.Println("Production also deploys automatically through .github/workflows/deploy-registry.yml")
			fmt.Println("when registry changes are pushed to main.")
			fmt.Println("\nRequired environment variables:")
			fmt.Println("  CLOUDFLARE_API_TOKEN")
			fmt.Println("  CLOUDFLARE_ACCOUNT_ID")
			fmt.Println("\nOptions:")
			fmt.Println("  --help, -h    Show this help message")
			fmt.Println("  Other non-secret options are passed to 'wrangler deploy'.")
			return
		}
	}

	for _, name := range []string{"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"} {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			logFatal("%s is required to deploy the registry Worker", name)
		}
	}

	pnpmPath, err := exec.LookPath("pnpm")
	if err != nil {
		logFatal("pnpm not found in PATH. Install pnpm before publishing.")
	}

	logInfo("Installing, testing, and building registry assets...")
	runCommand(registryDir, pnpmPath, "install", "--frozen-lockfile")
	runCommand(registryDir, pnpmPath, "test")
	runCommand(registryDir, pnpmPath, "build")
	deployArgs := append([]string{"exec", "wrangler", "deploy"}, args...)
	runCommand(registryDir, pnpmPath, deployArgs...)
	logInfo("Registry Worker deployment successful!")
}

// RunWww handles 'www <subcommand>'
func RunWww(args []string) {
	// Handle help explicitly
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Println("Usage: dialtone www <subcommand> [options]")
		fmt.Println("\nSubcommands:")
		fmt.Println("  publish            Test, build, and deploy the registry Worker")
		fmt.Println("  install            Install WWW dependencies using DIALTONE_ENV bun/npm")
		fmt.Println("  build              Vite build (generates /dist)")
		fmt.Println("  dev                Vite dev server (hot reload)")
		fmt.Println("  lint               Run static analysis (tsc --noEmit)")
		fmt.Println("  test               Run standard WWW integration tests")
		fmt.Println("  smoke              Quick smoke pass across all sections")
		fmt.Println("  smoke-chrome       Verify Chrome browser reaping lifecycle")
		fmt.Println("  test cad [--live]  Run headed browser tests for CAD generator")
		fmt.Println("  about demo         Zero-config local About section demo")
		fmt.Println("  cad demo           Zero-config local CAD development environment")
		fmt.Println("  earth demo         Zero-config local Earth development environment")
		fmt.Println("  music demo         Zero-config local Music section demo")
		fmt.Println("  webgpu demo        Zero-config local WebGPU development environment")
		fmt.Println("  webgpu debug       Chromedp debug run for WebGPU rendering")
		fmt.Println("  policy demo        Zero-config local Policy section demo")
		fmt.Println("  radio demo         Zero-config local Radio section demo")
		fmt.Println("  vision demo        Zero-config local Vision section demo")
		fmt.Println("\nRun 'dialtone www <subcommand> --help' for specific details.")
		return
	}

	subcommand := args[0]
	webDir := filepath.Join("src", "plugins", "www", "app")
	registryDir := "registry"

	switch subcommand {
	case "vision":
		handleDemo(webDir, "vision", "#s-vision")
	case "about":
		handleDemo(webDir, "about", "#s-about")
	case "cad":
		if len(args) > 1 && args[1] == "demo" {
			handleCadDemo(webDir)
			return
		}
		logFatal("Unknown 'cad' command.")
	case "earth":
		handleDemo(webDir, "earth", "#s-home")
	case "music":
		handleDemo(webDir, "music", "#s-music")
	case "webgpu":
		if len(args) > 1 && args[1] == "demo" {
			handleDemo(webDir, "webgpu", "#s-webgpu-template")
			return
		}
		if len(args) > 1 && args[1] == "debug" {
			handleWebgpuDebug(webDir)
			return
		}
		logFatal("Unknown 'webgpu' command.")
	case "radio":
		handleDemo(webDir, "radio", "#s-radio")
	case "policy":
		handleDemo(webDir, "policy", "#s-policy")
	case "test":
		logInfo("Running integration tests...")
		if err := wwwtest.RunAll(); err != nil {
			logFatal("Tests failed: %v", err)
		}
	case "publish":
		publishRegistry(registryDir, args[1:])
	case "install":
		installWwwDeps(webDir)
	case "build":
		runWwwNpmScript(webDir, "build")
	case "lint":
		runWwwNpmScript(webDir, "lint")
	case "smoke":
		logInfo("Running comprehensive smoke tests...")
		if err := wwwtest.RunComprehensiveSmoke(); err != nil {
			logFatal("Smoke tests failed: %v", err)
		}
	case "smoke-chrome":
		logInfo("Running Chrome lifecycle smoke test...")
		if err := wwwtest.RunSmokeChromeLifecycleTest(); err != nil {
			logFatal("Chrome lifecycle test failed: %v", err)
		}
	case "dev":
		logInfo("Starting local development server...")
		cmd := exec.Command("npm", "run", "dev")
		cmd.Dir = webDir
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		if err := cmd.Run(); err != nil {
			logFatal("Dev server failed: %v", err)
		}
	default:
		logFatal("Unknown www command %q. Run 'dialtone www help' for usage.", subcommand)
	}
}

func handleDemo(webDir, name, anchor string) {
	logInfo("Setting up %s Demo Environment...", name)
	_ = chrome.CleanupPort(5173)
	chrome.KillDialtoneResources()

	devCmd := exec.Command("npm", "run", "dev", "--", "--host", "127.0.0.1")
	devCmd.Dir = webDir
	stdout, _ := devCmd.StdoutPipe()
	stderr, _ := devCmd.StderrPipe()
	if err := devCmd.Start(); err != nil {
		logFatal("Failed to start dev server: %v", err)
	}

	port := 5173
	portCh := make(chan int, 1)
	go func() {
		reader := io.MultiReader(stdout, stderr)
		scanner := bufio.NewScanner(reader)
		re := regexp.MustCompile(`http://127\.0\.0\.1:(\d+)/`)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Println(line)
			if match := re.FindStringSubmatch(line); len(match) == 2 {
				if p, _ := strconv.Atoi(match[1]); p > 0 {
					select {
					case portCh <- p:
					default:
					}
				}
			}
		}
	}()

	select {
	case detected := <-portCh:
		port = detected
	case <-time.After(10 * time.Second):
		logInfo("Timeout detecting port, using default %d", port)
	}

	baseURL := fmt.Sprintf("http://127.0.0.1:%d/%s", port, anchor)
	session, err := chrome.StartSession(chrome.SessionOptions{Role: "demo", Headless: false, GPU: true, TargetURL: baseURL})
	if err != nil {
		logFatal("Failed to start chrome: %v", err)
	}
	defer chrome.CleanupSession(session)

	logInfo("%s Demo is LIVE at %s", strings.ToUpper(name), baseURL)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan
	logInfo("Shutting down...")
}

func handleCadDemo(webDir string) {
	logInfo("Setting up CAD Demo Environment...")
	_ = chrome.CleanupPort(5173)
	_ = chrome.CleanupPort(8081)
	chrome.KillDialtoneResources()

	cadCmd := getDialtoneCmd("cad", "src_v1", "serve")
	if err := cadCmd.Start(); err != nil {
		logFatal("Failed to start CAD server: %v", err)
	}

	devCmd := exec.Command("npm", "run", "dev", "--", "--host", "127.0.0.1")
	devCmd.Dir = webDir
	if err := devCmd.Start(); err != nil {
		logFatal("Failed to start dev server: %v", err)
	}

	// Wait for servers
	time.Sleep(5 * time.Second)

	baseURL := "http://127.0.0.1:5173/#s-cad"
	session, err := chrome.StartSession(chrome.SessionOptions{Role: "demo", Headless: false, GPU: true, TargetURL: baseURL})
	if err != nil {
		logFatal("Failed to start chrome: %v", err)
	}
	defer chrome.CleanupSession(session)

	logInfo("CAD Demo is LIVE at %s", baseURL)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan
}

func handleWebgpuDebug(webDir string) {
	logInfo("Setting up WebGPU Debug Environment...")
	_ = chrome.CleanupPort(5173)
	chrome.KillDialtoneResources()

	devCmd := exec.Command("npm", "run", "dev", "--", "--host", "127.0.0.1")
	devCmd.Dir = webDir
	if err := devCmd.Start(); err != nil {
		logFatal("Failed to start dev server: %v", err)
	}
	time.Sleep(5 * time.Second)

	allocOpts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", false),
		chromedp.Flag("disable-gpu", false),
		chromedp.Flag("enable-unsafe-webgpu", true),
		chromedp.Flag("dialtone-origin", true),
	)

	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), allocOpts...)
	defer cancel()
	defer chrome.KillDialtoneResources()

	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	err := chromedp.Run(ctx,
		chromedp.Navigate("http://127.0.0.1:5173/#s-webgpu-template"),
		chromedp.WaitReady("#webgpu-template-container"),
		chromedp.Sleep(5*time.Second),
	)
	if err != nil {
		logInfo("Debug failed: %v", err)
	}
}
