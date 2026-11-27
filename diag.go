package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const diagUsage = `usage: dialtone-earth diag <subcommand> [flags]

Run the automated diagnostic loop across dialtone.earth, metal.dialtone.earth,
the Dialtone metal mesh, installed plugins, and dialtone itself.

Subcommands:
  run         Run one diagnostic DAG loop (exits non-zero if any check fails)
  watch       Run diagnostic loops repeatedly on a configurable interval (default 10m)
  help        Show this help

Flags for "diag run" and "diag watch":
  --interval <dur>        Loop interval (default: 10m)
  --iterations <n>        Max iterations for "diag watch" (0 = repeat forever)
  --publish-url <url>     Base URL to POST diagnostic results (default: http://127.0.0.1:5174)
  --publish-live          Explicitly allow publishing to a non-localhost URL (default: false)
  --no-publish            Write local JSON logs only without HTTP POST publish
  --token-file <path>     Path to LIVE_CONTROL_TOKEN file (only used with --publish-live)
  --nodes <csv>           Comma-separated metal nodes to check
  --dialtone-bin <path>   Path to dialtone CLI binary (default: ~/.dialtone/bin/dialtone)
  --task-bin <path>       Path to dialtone-task binary (default: ~/.dialtone/plugins/task/dialtone-task)
  --no-tasks              Disable creating/updating/closing dialtone-task diagnostic tasks
  --run-dialtone-tests    Also run local dialtone repo unit tests if present (default: false)
  --screenshots           Capture annotated UI screenshots after the loop and link them
  --json                  Emit full diagnostic report JSON to stdout
`

type diagCLIFlags struct {
	interval         time.Duration
	iterations       int
	publishURL       string
	publishLive      bool
	noPublish        bool
	tokenFile        string
	nodesCSV         string
	dialtoneBin      string
	taskBin          string
	noTasks          bool
	runDialtoneTests bool
	screenshots      bool
	jsonOut          bool
}

func runDiag(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || isHelp(args[0]) {
		fmt.Fprint(stdout, diagUsage)
		return nil
	}
	switch args[0] {
	case "run":
		return runDiagRun(args[1:], stdout, stderr)
	case "watch":
		return runDiagWatch(args[1:], stdout, stderr)
	default:
		fmt.Fprint(stderr, diagUsage)
		return fmt.Errorf("unknown diag subcommand %q", args[0])
	}
}

func parseDiagFlags(name string, args []string, stdout, stderr io.Writer) (diagCLIFlags, bool, error) {
	var cfg diagCLIFlags
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.DurationVar(&cfg.interval, "interval", 10*time.Minute, "Loop interval")
	fs.IntVar(&cfg.iterations, "iterations", 0, "Max iterations for diag watch (0 = forever)")
	fs.StringVar(&cfg.publishURL, "publish-url", defaultDiagPublishURL, "Target UI base URL for publishing results")
	fs.BoolVar(&cfg.publishLive, "publish-live", false, "Explicitly allow posting to a non-localhost URL")
	fs.BoolVar(&cfg.noPublish, "no-publish", false, "Write local JSON without HTTP POST publishing")
	fs.StringVar(&cfg.tokenFile, "token-file", "", "Path to LIVE_CONTROL_TOKEN file (only with --publish-live)")
	fs.StringVar(&cfg.nodesCSV, "nodes", strings.Join(defaultDiagFleetNodes, ","), "Comma-separated list of metal nodes")
	fs.StringVar(&cfg.dialtoneBin, "dialtone-bin", "", "Path to dialtone CLI binary")
	fs.StringVar(&cfg.taskBin, "task-bin", "", "Path to dialtone-task binary")
	fs.BoolVar(&cfg.noTasks, "no-tasks", false, "Disable dialtone-task diagnostic task sync")
	fs.BoolVar(&cfg.runDialtoneTests, "run-dialtone-tests", false, "Run local dialtone repo unit tests if present")
	fs.BoolVar(&cfg.screenshots, "screenshots", false, "Capture annotated screenshots and link them to the loop")
	fs.BoolVar(&cfg.jsonOut, "json", false, "Emit full JSON report to stdout")

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(stdout, diagUsage)
			return cfg, true, nil
		}
		return cfg, false, err
	}
	if fs.NArg() != 0 {
		return cfg, false, fmt.Errorf("%s accepts flags only; run `dialtone-earth diag help`", name)
	}
	if cfg.interval <= 0 {
		return cfg, false, errors.New("--interval must be positive")
	}
	if !cfg.noPublish {
		if _, err := ValidateDiagPublishTarget(cfg.publishURL, cfg.publishLive); err != nil {
			return cfg, false, err
		}
	}
	return cfg, false, nil
}

func runDiagRun(args []string, stdout, stderr io.Writer) error {
	cfg, helpShown, err := parseDiagFlags("diag run", args, stdout, stderr)
	if err != nil || helpShown {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	report, err := executeOneDiagLoop(ctx, cfg, stdout, stderr)
	if err != nil {
		return err
	}
	if report.Summary.Failed > 0 {
		return fmt.Errorf("diagnostic loop %s failed (%d/%d checks failed)", report.LoopID, report.Summary.Failed, report.Summary.Total)
	}
	return nil
}

func runDiagWatch(args []string, stdout, stderr io.Writer) error {
	cfg, helpShown, err := parseDiagFlags("diag watch", args, stdout, stderr)
	if err != nil || helpShown {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	fmt.Fprintf(stdout, "diag watch: starting loop every %s (publish=%s, live=%v)\n",
		cfg.interval, cfg.publishURL, cfg.publishLive)

	for iter := 1; cfg.iterations == 0 || iter <= cfg.iterations; iter++ {
		if ctx.Err() != nil {
			break
		}
		fmt.Fprintf(stdout, "\n[diag watch] iteration %d starting at %s\n", iter, time.Now().UTC().Format(time.RFC3339))
		report, loopErr := executeOneDiagLoop(ctx, cfg, stdout, stderr)
		if loopErr != nil {
			fmt.Fprintf(stderr, "[diag watch] iteration %d error: %v\n", iter, loopErr)
		} else if report.Summary.Failed > 0 {
			fmt.Fprintf(stdout, "[diag watch] iteration %d completed with %d failing check(s)\n", iter, report.Summary.Failed)
		}
		if cfg.iterations > 0 && iter >= cfg.iterations {
			break
		}
		timer := time.NewTimer(cfg.interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			fmt.Fprintln(stdout, "diag watch: stopped")
			return nil
		case <-timer.C:
		}
	}
	return nil
}

func executeOneDiagLoop(ctx context.Context, cfg diagCLIFlags, stdout, stderr io.Writer) (*DiagLoopReport, error) {
	root, err := projectRoot()
	if err != nil {
		return nil, err
	}

	var nodes []string
	for _, part := range strings.Split(cfg.nodesCSV, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			nodes = append(nodes, trimmed)
		}
	}

	runnerNode := detectRunnerNode(cfg.dialtoneBin)
	branch, commit := diagGitInfo(root)
	pipe := readPipelineState(root)
	shotsURL := pipe.ScreenshotsURL
	if shotsURL == "" {
		shotsURL = "/screenshots/"
	}
	shotsLoopID := pipe.ScreenshotsLoopID

	if cfg.screenshots {
		if shotErr := runPostLoopScreenshots(root, cfg.publishURL, "", false, cfg.publishURL, false, stdout, stderr); shotErr != nil {
			fmt.Fprintf(stderr, "diag: screenshot capture warning: %v\n", shotErr)
		} else {
			updatedPipe := readPipelineState(root)
			if updatedPipe.ScreenshotsURL != "" {
				shotsURL = updatedPipe.ScreenshotsURL
			}
			shotsLoopID = updatedPipe.ScreenshotsLoopID
		}
	}

	specs := BuildDiagnosticDAG(DiagChecksConfig{
		DialtoneBin:      cfg.dialtoneBin,
		TaskBin:          cfg.taskBin,
		Nodes:            nodes,
		RunDialtoneTests: cfg.runDialtoneTests,
	})

	report, err := ExecuteDiagDAG(ctx, specs, DiagRunMeta{
		Source:            "cli",
		RunnerNode:        runnerNode,
		Interval:          cfg.interval.String(),
		ScreenshotsURL:    shotsURL,
		ScreenshotsLoopID: shotsLoopID,
		GitBranch:         branch,
		GitCommit:         commit,
	})
	if err != nil {
		return nil, err
	}

	if !cfg.noTasks {
		store := &CLIDiagTaskStore{BinPath: cfg.taskBin}
		if fileExists(store.bin()) {
			if taskErr := SyncDiagTasks(ctx, store, report); taskErr != nil {
				fmt.Fprintf(stderr, "diag: diagnostic task sync warning: %v\n", taskErr)
			}
		}
	}

	if err := PersistDiagReportLocally(root, report, defaultDiagHistoryMax); err != nil {
		return nil, fmt.Errorf("persist local diagnostics: %w", err)
	}

	if !cfg.noPublish {
		token := ""
		if cfg.publishLive {
			tok, tokErr := loadLiveControlToken(cfg.tokenFile)
			if tokErr != nil {
				return nil, tokErr
			}
			token = tok
		}
		if pubErr := PublishDiagReport(ctx, root, report, DiagPublishOptions{
			BaseURL:     cfg.publishURL,
			PublishLive: cfg.publishLive,
			Token:       token,
		}); pubErr != nil {
			fmt.Fprintf(stderr, "diag: publish warning (%s): %v\n", cfg.publishURL, pubErr)
		}
	}

	if cfg.jsonOut {
		raw, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			return nil, err
		}
		_, _ = stdout.Write(append(raw, '\n'))
	} else {
		printDiagSummary(stdout, report, cfg.publishURL)
	}
	return report, nil
}

func detectRunnerNode(dialtoneBin string) string {
	bin := strings.TrimSpace(dialtoneBin)
	if bin == "" {
		bin = defaultDialtoneBinary()
	}
	if out, _, code, err := runBoundedCommand(context.Background(), 5*time.Second, bin, "daemon", "status"); err == nil && code == 0 {
		var s struct {
			Node string `json:"node"`
		}
		if json.Unmarshal([]byte(out), &s) == nil && s.Node != "" {
			return s.Node
		}
	}
	host, _ := os.Hostname()
	return strings.TrimSpace(host)
}

func diagGitInfo(root string) (string, string) {
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

func printDiagSummary(w io.Writer, report *DiagLoopReport, publishURL string) {
	fmt.Fprintf(w, "=== DIAGNOSTIC LOOP %s (%s, %dms, runner=%s) ===\n",
		report.LoopID, strings.ToUpper(report.Status), report.DurationMs, report.RunnerNode)
	fmt.Fprintf(w, "PASS: %d | FAIL: %d | SKIPPED: %d | PENDING: %d | TOTAL: %d\n",
		report.Summary.Passed, report.Summary.Failed, report.Summary.Skipped, report.Summary.Pending, report.Summary.Total)
	for _, c := range report.Checks {
		tag := "PASS"
		switch c.Status {
		case DiagStatusFail:
			tag = "FAIL"
		case DiagStatusSkipped:
			tag = "SKIP"
		case DiagStatusPending:
			tag = "PEND"
		case DiagStatusInfo:
			tag = "INFO"
		}
		extra := ""
		if c.TaskID != "" {
			extra = fmt.Sprintf(" [task:%s %s]", c.TaskID, c.TaskAction)
		}
		fmt.Fprintf(w, "  [%s] %-34s %4dms  test-id=%s  %s%s\n",
			tag, c.CheckID, c.DurationMs, c.TestID, c.Summary, extra)
	}
	fmt.Fprintf(w, "local json: %s\n", filepath.ToSlash(filepath.Join("logs", "diag", "latest.json")))
	fmt.Fprintf(w, "ui url:     %s/diagnostics\n", strings.TrimRight(publishURL, "/"))
}
