package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strconv"
	"syscall"
	"time"

	chrome "dialtone/dev/plugins/chrome/src_v1/go"

	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

func handleVisionDemo(webDir string) {
	logInfo("Setting up Vision Demo Environment...")

	// 1. Port cleanup
	logInfo("Cleaning up port 5173...")
	_ = chrome.CleanupPort(5173)
	time.Sleep(1500 * time.Millisecond)

	// 2. Kill existing Dialtone Chrome instances
	logInfo("Cleaning up Chrome processes...")
	_ = getDialtoneCmd("chrome", "kill", "all").Run()

	// 3. Start WWW Dev Server
	logInfo("Starting WWW Dev Server...")
	devCmd := exec.Command("npm", "run", "dev", "--", "--host", "127.0.0.1")
	devCmd.Dir = webDir
	stdout, err := devCmd.StdoutPipe()
	if err != nil {
		logFatal("Failed to attach to dev server stdout: %v", err)
	}
	stderr, err := devCmd.StderrPipe()
	if err != nil {
		logFatal("Failed to attach to dev server stderr: %v", err)
	}
	if err := devCmd.Start(); err != nil {
		logFatal("Failed to start dev server: %v", err)
	}
	defer func() {
		if devCmd.Process != nil {
			_ = devCmd.Process.Kill()
		}
	}()

	// 4. Wait for dev server ready and detect port
	logInfo("Waiting for Dev Server...")
	port := 5173
	portCh := make(chan int, 1)
	go func() {
		reader := io.MultiReader(stdout, stderr)
		scanner := bufio.NewScanner(reader)
		re := regexp.MustCompile(`http://127\.0\.0\.1:(\d+)/`)
		for scanner.Scan() {
			line := scanner.Text()
			// Forward dev server logs to stdout
			fmt.Printf("[dev] %s\n", line)
			if match := re.FindStringSubmatch(line); len(match) == 2 {
				if p, err := strconv.Atoi(match[1]); err == nil {
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
		logInfo("Dev server port not detected yet; falling back to %d", port)
	}

	ready := false
	for i := 0; i < 30; i++ {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d", port))
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			ready = true
			break
		}
		time.Sleep(1 * time.Second)
	}
	if !ready {
		logFatal("Dev server failed to start within 30 seconds")
	}

	// 5. Launch Chrome on Vision section
	baseURL := fmt.Sprintf("http://127.0.0.1:%d/#s-vision", port)
	logInfo("Launching Chrome on Vision section...")
	chromeCmd := getDialtoneCmd("chrome", "new", baseURL, "--gpu")

	// Capture output to get the WebSocket URL for chromedp
	chromeOut, err := chromeCmd.CombinedOutput()
	if err != nil {
		logFatal("Failed to launch Chrome: %v\nOutput: %s", err, string(chromeOut))
	}

	re := regexp.MustCompile(`ws://127\.0\.0\.1:\d+/devtools/browser/[a-z0-9-]+`)
	wsURL := re.FindString(string(chromeOut))
	if wsURL == "" {
		logFatal("Failed to find WebSocket URL in chrome output: %s", string(chromeOut))
	}

	// 6. Attach chromedp to log console output
	allocCtx, cancel := chromedp.NewRemoteAllocator(context.Background(), wsURL)
	defer cancel()

	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	chromedp.ListenTarget(ctx, func(ev interface{}) {
		switch ev := ev.(type) {
		case *runtime.EventConsoleAPICalled:
			for _, arg := range ev.Args {
				fmt.Printf("[browser] [%s] %s\n", ev.Type, arg.Value)
			}
		case *runtime.EventExceptionThrown:
			fmt.Printf("[browser] [EXCEPTION] %s\n", ev.ExceptionDetails.Text)
		}
	})

	// Run a simple task to keep the session alive and ensure we are on the right section
	err = chromedp.Run(ctx,
		chromedp.Navigate(baseURL),
		chromedp.WaitReady("#vision-container"),
		chromedp.Evaluate(`console.log("Vision demo attached successfully")`, nil),
	)
	if err != nil {
		logInfo("Chromedp error: %v", err)
	}

	logInfo("Vision Demo Environment is LIVE!")
	logInfo("Dev Server: %s", baseURL)
	logInfo("Browser console logs are being forwarded to this terminal.")
	logInfo("Press Ctrl+C to stop...")

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan
	logInfo("Shutting down...")
}
