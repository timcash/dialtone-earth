package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestShouldRunForegroundQueryCADTest(t *testing.T) {
	if !shouldRunForegroundQuery("cad", []string{"src_v1", "test"}) {
		t.Fatalf("cad src_v1 test should run in foreground")
	}
}

func TestShouldRunForegroundQueryCADPublish(t *testing.T) {
	if !shouldRunForegroundQuery("cad", []string{"src_v1", "publish"}) {
		t.Fatalf("cad src_v1 publish should run in foreground")
	}
}

func TestShouldRunForegroundQueryCADBuildStaysRouted(t *testing.T) {
	if shouldRunForegroundQuery("cad", []string{"src_v1", "build"}) {
		t.Fatalf("cad src_v1 build should stay routed")
	}
}

func TestShouldRouteCommandViaREPLHonorsForegroundCADTest(t *testing.T) {
	if shouldRouteCommandViaREPL("cad", []string{"src_v1", "test"}) {
		t.Fatalf("cad src_v1 test should not route via REPL")
	}
	if shouldRouteCommandViaREPL("cad", []string{"src_v1", "publish"}) {
		t.Fatalf("cad src_v1 publish should not route via REPL")
	}
	if !shouldRouteCommandViaREPL("cad", []string{"src_v1", "build"}) {
		t.Fatalf("cad src_v1 build should route via REPL")
	}
}

func TestShouldRouteCommandViaREPLKeepsLocalCLITestDirect(t *testing.T) {
	if shouldRouteCommandViaREPL("test", nil) {
		t.Fatalf("top-level test command should not route via REPL")
	}
	if !shouldRouteCommandViaREPL("test", []string{"src_v1", "test"}) {
		t.Fatalf("legacy test src_v1 plugin invocation should preserve REPL routing")
	}
	if !isLocalCLITestArgs([]string{"test"}) {
		t.Fatalf("expected [test] to be recognized as local CLI test")
	}
	if isLocalCLITestArgs([]string{"test", "src_v1", "test"}) {
		t.Fatalf("legacy [test src_v1 test] must not be treated as local CLI test")
	}
	if isLocalCLITestArgs([]string{"test", "--target-host", "wsl"}) {
		t.Fatalf("remote targeted test must not be treated as local CLI test")
	}
}

var testLogSourceRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+:[0-9]+$`)

func expectedOrderedInventoryTitles() []string {
	return []string{
		"offline guarded authorization",
		"browser sign-in",
		"Metal/Test isolation",
		"heartbeat vm-us",
		"heartbeat vm-eu",
		"heartbeat vm-asia",
		"heartbeat Rosie",
		"heartbeat Legion",
		"heartbeat Build-1",
		"fixed whoami vm-us",
		"audit vm-us",
		"fixed whoami vm-eu",
		"audit vm-eu",
		"fixed whoami vm-asia",
		"audit vm-asia",
		"fixed whoami Rosie",
		"audit Rosie",
		"fixed whoami Legion",
		"audit Legion",
		"fixed whoami Build-1",
		"audit Build-1",
	}
}

type expectedOutcome struct {
	Level  string
	Status string
	Title  string
}

func expectedFirstPassAllRestSkip() []expectedOutcome {
	titles := expectedOrderedInventoryTitles()
	out := make([]expectedOutcome, 0, len(titles))
	for i, title := range titles {
		if i == 0 {
			out = append(out, expectedOutcome{Level: "INFO", Status: "PASS", Title: title})
		} else {
			out = append(out, expectedOutcome{Level: "WARN", Status: "SKIP", Title: title})
		}
	}
	return out
}

func expectedFirstFailAllRestSkip() []expectedOutcome {
	titles := expectedOrderedInventoryTitles()
	out := make([]expectedOutcome, 0, len(titles))
	for i, title := range titles {
		if i == 0 {
			out = append(out, expectedOutcome{Level: "ERROR", Status: "FAIL", Title: title})
		} else {
			out = append(out, expectedOutcome{Level: "WARN", Status: "SKIP", Title: title})
		}
	}
	return out
}

func assertExactOrderedTestStdout(t *testing.T, raw string, want []expectedOutcome) {
	t.Helper()
	if strings.TrimSpace(raw) == "" {
		t.Fatalf("expected non-empty stdout, got empty output")
	}
	normalized := strings.ReplaceAll(raw, "\r\n", "\n")
	if !strings.HasSuffix(normalized, "\n") {
		t.Fatalf("stdout must terminate with newline: %q", raw)
	}
	lines := strings.Split(strings.TrimSuffix(normalized, "\n"), "\n")
	if len(lines) != len(want) {
		t.Fatalf("stdout line count = %d, want exactly %d\nstdout:\n%s", len(lines), len(want), raw)
	}
	for i, line := range lines {
		if strings.HasPrefix(line, "DIALTONE>") || strings.HasPrefix(line, "dialtone>") || strings.HasPrefix(line, "[T+") {
			t.Fatalf("line %d contains forbidden raw banner/prefix: %q", i+1, line)
		}
		fields := strings.SplitN(line, " ", 4)
		if len(fields) != 4 {
			t.Fatalf("line %d malformed (want '<RFC3339> <LEVEL> <filename:line> <message>'): %q", i+1, line)
		}
		if _, err := time.Parse(time.RFC3339, fields[0]); err != nil {
			t.Fatalf("line %d invalid RFC3339 timestamp %q: %v", i+1, fields[0], err)
		}
		if fields[1] != want[i].Level {
			t.Fatalf("line %d level = %q, want %q (line=%q)", i+1, fields[1], want[i].Level, line)
		}
		if !testLogSourceRe.MatchString(fields[2]) {
			t.Fatalf("line %d invalid filename:line %q (line=%q)", i+1, fields[2], line)
		}
		wantMsg := want[i].Status + " " + want[i].Title
		if fields[3] != wantMsg {
			t.Fatalf("line %d message = %q, want exact %q (line=%q)", i+1, fields[3], wantMsg, line)
		}
	}
}

func TestRunCLITestInventoryFirstPassRestSkipAndNeverAdvancesTest2(t *testing.T) {
	cases := defaultCLITestInventory()
	test2Called := false
	cases[1].Run = func() error {
		test2Called = true
		return nil
	}

	var out bytes.Buffer
	code := runCLITestInventory(cases, &out)
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d\nstdout:\n%s", code, out.String())
	}
	if test2Called {
		t.Fatalf("test 2 must never execute; runner must stop after test 1 and SKIP all remaining tests")
	}
	assertExactOrderedTestStdout(t, out.String(), expectedFirstPassAllRestSkip())
}

func TestRunCLITestInventoryFailurePreservesNonzeroExitAndExactStdout(t *testing.T) {
	cases := defaultCLITestInventory()
	cases[0].Run = func() error {
		return errors.New("mock policy rejection\nextra wrapped detail")
	}
	test2Called := false
	cases[1].Run = func() error {
		test2Called = true
		return nil
	}

	var out bytes.Buffer
	code := runCLITestInventory(cases, &out)
	if code == 0 {
		t.Fatalf("expected nonzero exit code on first-test failure, got 0\nstdout:\n%s", out.String())
	}
	if test2Called {
		t.Fatalf("test 2 must not run after test 1 failure")
	}
	assertExactOrderedTestStdout(t, out.String(), expectedFirstFailAllRestSkip())
}

func TestDialtoneCLITestSubcommandEndToEndSuccessAndFailure(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	repoRoot := filepath.Dir(cwd)
	if !fileExists(filepath.Join(repoRoot, "dialtone.ps1")) {
		t.Fatalf("expected dialtone.ps1 at %s", repoRoot)
	}

	runCLI := func(args ...string) (string, string, int) {
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			psArgs := append([]string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(repoRoot, "dialtone.ps1")}, args...)
			cmd = exec.Command("powershell.exe", psArgs...)
			cmd.Dir = repoRoot
		} else {
			goArgs := append([]string{"run", "dev.go"}, args...)
			cmd = exec.Command("go", goArgs...)
			cmd.Dir = cwd
		}
		cmd.Env = buildOfflineTestEnv(os.Environ())
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		code := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				t.Fatalf("failed to invoke CLI %v: %v", args, err)
			}
		}
		return stdout.String(), stderr.String(), code
	}

	// Success case: top-level CLI `test` passes test 1, skips tests 2..21, exits 0.
	stdout, stderr, code := runCLI("test")
	if code != 0 {
		t.Fatalf("CLI success case exited %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if strings.TrimSpace(stderr) != "" {
		t.Fatalf("expected empty stderr on passing CLI test, got:\n%s", stderr)
	}
	assertExactOrderedTestStdout(t, stdout, expectedFirstPassAllRestSkip())

	// Failure case: arbitrary go test flags (including -exec) are rejected with nonzero exit and exact stdout contract.
	failStdout, _, failCode := runCLI("test", "-exec", "echo")
	if failCode == 0 {
		t.Fatalf("CLI failure case exited 0; expected nonzero\nstdout:\n%s", failStdout)
	}
	assertExactOrderedTestStdout(t, failStdout, expectedFirstFailAllRestSkip())
}
