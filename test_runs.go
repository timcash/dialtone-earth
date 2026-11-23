package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode"
)

// testRunEnv marks the `go test` process that the test action starts, so a test
// can never launch the action that is already running it.
const testRunEnv = "DIALTONE_EARTH_TEST_RUN"

// goTestTimeout outruns a cold install and build on a slow machine.
const goTestTimeout = "30m"

// stateFile is what the dashboard reads. The test and dev actions generate it;
// nothing else writes it, and it is never committed.
var stateFile = filepath.Join("logs", "state.json")

type testState struct {
	GeneratedAt string      `json:"generated_at"`
	Tests       []testEntry `json:"tests"`
}

type testEntry struct {
	Name      string `json:"name"`
	Title     string `json:"title"`
	Section   string `json:"section,omitempty"`
	Source    string `json:"source,omitempty"`
	Status    string `json:"status"`
	Elapsed   string `json:"elapsed"`
	Timestamp string `json:"timestamp"`
	TestID    string `json:"test-id"`
}

type testRunRecord struct {
	TestID      string `json:"test-id"`
	Name        string `json:"name"`
	Title       string `json:"title"`
	Section     string `json:"section,omitempty"`
	Source      string `json:"source,omitempty"`
	Command     string `json:"command"`
	Status      string `json:"status"`
	Timestamp   string `json:"timestamp"`
	Elapsed     string `json:"elapsed"`
	Artifact    string `json:"artifact"`
	CompletedAt string `json:"completed_at,omitempty"`
}

// goTestEvent is one line of `go test -json`.
type goTestEvent struct {
	Time    string
	Action  string
	Test    string
	Output  string
	Elapsed float64
}

type activeTest struct {
	name    string
	log     *os.File
	record  testRunRecord
	started time.Time
}

// listTestNames asks the Go toolchain which tests exist, in source order.
func listTestNames(root, pattern string) ([]string, error) {
	if pattern == "" {
		pattern = ".*"
	}
	command := exec.Command("go", "test", "-list", pattern, ".")
	command.Dir = root
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("go test -list %s: %w\n%s", pattern, err, output)
	}
	var names []string
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Test") && !strings.ContainsAny(line, " \t") {
			names = append(names, line)
		}
	}
	return names, nil
}

func newTestState(names []string) testState {
	var state testState
	for _, name := range names {
		state.Tests = append(state.Tests, newTestEntry(name))
	}
	return state
}

func newTestEntry(name string) testEntry {
	return testEntry{
		Name:      name,
		Title:     testTitle(name),
		Section:   testSection(name),
		Status:    "pending",
		Elapsed:   "0",
		Timestamp: "none",
	}
}

func testSection(name string) string {
	switch name {
	case "TestDialtoneEarthLiveMetalDaemonE2E",
		"TestDialtoneEarthMetalCloudflareLiveE2E",
		"TestDialtoneEarthLiveMetalUIParity",
		"TestDialtoneEarthGlobeH3AndBundledArcs",
		"TestDialtoneEarthTilingWindowManagerAndQueryRates",
		"TestDialtoneEarthCameraStudioTypeScript",
		"TestDialtoneEarthCloudflareKVConfigAndTour",
		"TestDialtoneEarthSimulatedTour":
		return "Live metal Data & UI"
	case "TestDialtoneEarthCloudflareGateway",
		"TestDialtoneEarthRegistrySecurityHeaders",
		"TestDialtoneEarthOriginBridge",
		"TestDialtoneEarthRegistryNetworks":
		return "Cloudflare Gateway & Security"
	case "TestDialtoneEarthLiveControlCLI",
		"TestLintAllSources",
		"TestBuildArtifacts",
		"TestDeployLocalBundle",
		"TestUIUnitTests",
		"TestWebUIInstallablePWA":
		return "Build, Live CLI & PWA"
	default:
		return "CLI & Test Runner Contracts"
	}
}

// discoverTestSources scans *_test.go files in root using go/parser so every
// test entry and structured log line carries an exact file:line code location.
func discoverTestSources(root string) map[string]string {
	locations := map[string]string{}
	entries, err := os.ReadDir(root)
	if err != nil {
		return locations
	}
	fset := token.NewFileSet()
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		path := filepath.Join(root, entry.Name())
		parsed, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			continue
		}
		for _, decl := range parsed.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv != nil || !strings.HasPrefix(fn.Name.Name, "Test") {
				continue
			}
			pos := fset.Position(fn.Pos())
			locations[fn.Name.Name] = fmt.Sprintf("%s:%d", entry.Name(), pos.Line)
		}
	}
	return locations
}

func populateTestSources(root string, state *testState) {
	locations := discoverTestSources(root)
	for i := range state.Tests {
		if state.Tests[i].Section == "" {
			state.Tests[i].Section = testSection(state.Tests[i].Name)
		}
		if src, ok := locations[state.Tests[i].Name]; ok {
			state.Tests[i].Source = src
		}
	}
}

var inlineSourceLocRe = regexp.MustCompile(`([A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)*\.(?:go|ts|tsx|js|mjs|cjs|rs|css|html)):(\d+)`)

func detectLogLevel(line string) string {
	trimmed := strings.TrimSpace(line)
	lower := strings.ToLower(trimmed)
	switch {
	case strings.Contains(trimmed, "--- FAIL:") ||
		trimmed == "FAIL" ||
		strings.HasPrefix(trimmed, "FAIL\t") ||
		strings.HasPrefix(trimmed, "FAIL ") ||
		strings.HasPrefix(trimmed, "✖") ||
		strings.HasPrefix(trimmed, "not ok ") ||
		strings.Contains(trimmed, "AssertionError") ||
		strings.Contains(trimmed, "Error:") ||
		strings.Contains(trimmed, "panic:") ||
		strings.Contains(lower, "exit status") ||
		strings.Contains(lower, "failed:") ||
		strings.HasPrefix(trimmed, "at file://"):
		return "ERROR"
	case strings.Contains(trimmed, "--- SKIP:") ||
		strings.HasPrefix(trimmed, "(!)") ||
		strings.Contains(lower, "warn:") ||
		strings.Contains(lower, "warning:"):
		return "WARN "
	case strings.Contains(trimmed, "--- PASS:") ||
		trimmed == "PASS" ||
		strings.HasPrefix(trimmed, "✔") ||
		strings.HasPrefix(trimmed, "ok \t") ||
		strings.HasPrefix(trimmed, "ok  "):
		return "PASS "
	default:
		return "INFO "
	}
}

func formatLogTimestamp(eventTime string) string {
	if t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(eventTime)); err == nil {
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func extractLineSource(root, line, fallback string) string {
	if match := inlineSourceLocRe.FindStringSubmatch(line); len(match) == 3 {
		file := strings.ReplaceAll(match[1], "\\", "/")
		rootSlash := strings.TrimSuffix(strings.ReplaceAll(root, "\\", "/"), "/")
		rootNoDrive := rootSlash
		if len(rootNoDrive) >= 2 && rootNoDrive[1] == ':' {
			rootNoDrive = strings.TrimPrefix(rootNoDrive[2:], "/")
		}
		file = strings.TrimPrefix(file, rootSlash+"/")
		file = strings.TrimPrefix(file, rootNoDrive+"/")
		return file + ":" + match[2]
	}
	if fallback != "" {
		return fallback
	}
	return "test:0"
}

// formatStructuredLogOutput enriches real `go test -json` output lines with
// UTC timestamp, log level ([INFO ]/[PASS ]/[WARN ]/[ERROR]), and file:line.
// Synthetic test fixtures without Event.Time keep raw lines unchanged.
func formatStructuredLogOutput(root, eventTime, defaultSource, rawOutput string) string {
	if strings.TrimSpace(eventTime) == "" {
		return rawOutput
	}
	ts := formatLogTimestamp(eventTime)
	hasTrailingNewline := strings.HasSuffix(rawOutput, "\n")
	trimmed := strings.TrimSuffix(rawOutput, "\n")
	lines := strings.Split(trimmed, "\n")
	var out strings.Builder
	for i, line := range lines {
		clean := strings.TrimRight(line, "\r")
		if strings.TrimSpace(clean) == "" {
			if hasTrailingNewline || i < len(lines)-1 {
				out.WriteByte('\n')
			}
			continue
		}
		level := detectLogLevel(clean)
		source := extractLineSource(root, clean, defaultSource)
		fmt.Fprintf(&out, "%s [%s] %s | %s", ts, level, source, clean)
		if hasTrailingNewline || i < len(lines)-1 {
			out.WriteByte('\n')
		}
	}
	return out.String()
}

func (state *testState) entry(name string) *testEntry {
	for index := range state.Tests {
		if state.Tests[index].Name == name {
			return &state.Tests[index]
		}
	}
	state.Tests = append(state.Tests, newTestEntry(name))
	return &state.Tests[len(state.Tests)-1]
}

func writeTestState(root string, state *testState) error {
	state.GeneratedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return writeJSONFile(filepath.Join(root, stateFile), state)
}

// runGoTests runs the selected tests and turns the event stream into live
// output, per-execution logs, and dashboard state.
func runGoTests(root string, state *testState, pattern string, stdout io.Writer) error {
	args := []string{"test", "-json", "-count=1", "-timeout", goTestTimeout}
	if pattern != "" {
		args = append(args, "-run", pattern)
	}
	command := exec.Command("go", append(args, ".")...)
	command.Dir = root
	command.Env = append(os.Environ(), testRunEnv+"=1")
	var toolErrors bytes.Buffer
	command.Stderr = &toolErrors
	events, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	failures, consumeErr := consumeGoTestEvents(root, state, events, stdout)
	waitErr := command.Wait()
	if toolErrors.Len() > 0 {
		fmt.Fprint(stdout, toolErrors.String())
	}
	if consumeErr != nil {
		return consumeErr
	}
	if len(failures) > 0 {
		return fmt.Errorf("%d test(s) failed: %s", len(failures), strings.Join(failures, ", "))
	}
	return waitErr
}

// consumeGoTestEvents reads `go test -json` lines and records what happened.
// Subtest output is folded into the log of the test that owns it.
func consumeGoTestEvents(root string, state *testState, events io.Reader, stdout io.Writer) ([]string, error) {
	populateTestSources(root, state)
	active := map[string]*activeTest{}
	var failures []string
	scanner := bufio.NewScanner(events)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var event goTestEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			fmt.Fprintln(stdout, scanner.Text())
			continue
		}
		owner := topLevelTest(event.Test)
		switch event.Action {
		case "output":
			if _, err := io.WriteString(stdout, event.Output); err != nil {
				return failures, err
			}
			if run := active[owner]; run != nil {
				formatted := formatStructuredLogOutput(root, event.Time, run.record.Source, event.Output)
				if _, err := io.WriteString(run.log, formatted); err != nil {
					return failures, err
				}
			}
		case "run":
			if event.Test == "" || event.Test != owner {
				continue
			}
			run, err := beginTestRun(root, state, owner)
			if err != nil {
				return failures, err
			}
			active[owner] = run
			fmt.Fprintf(stdout, "=== TEST-ID %s %s\n", owner, run.record.TestID)
		case "pass", "fail", "skip":
			run := active[owner]
			if run == nil || event.Test == "" || event.Test != owner {
				continue
			}
			delete(active, owner)
			if err := finishTestRun(root, state, run, event.Action, event.Elapsed); err != nil {
				return failures, err
			}
			if event.Action == "fail" {
				failures = append(failures, owner)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return failures, err
	}
	// A panic or a killed process can end the stream mid-test. Close the books
	// so no row is left running forever.
	for name, run := range active {
		if err := finishTestRun(root, state, run, "fail", time.Since(run.started).Seconds()); err != nil {
			return failures, err
		}
		failures = append(failures, name)
	}
	return failures, nil
}

func beginTestRun(root string, state *testState, name string) (*activeTest, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	id := hex.EncodeToString(random[:])
	if err := os.MkdirAll(filepath.Join(root, "logs"), 0o755); err != nil {
		return nil, err
	}
	log, err := os.OpenFile(filepath.Join(root, "logs", id+".log"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	started := time.Now().UTC()
	entry := state.entry(name)
	entry.Status, entry.TestID = "running", id
	entry.Timestamp, entry.Elapsed = started.Format(time.RFC3339Nano), "0"
	run := &activeTest{name: name, log: log, started: started, record: testRunRecord{
		TestID:    id,
		Name:      name,
		Title:     entry.Title,
		Section:   entry.Section,
		Source:    entry.Source,
		Command:   fmt.Sprintf("go run . test --filter %q", "^"+name+"$"),
		Status:    "running",
		Timestamp: entry.Timestamp,
		Elapsed:   "0",
		Artifact:  "logs/" + id + ".log",
	}}
	if err := writeRunRecord(root, run.record); err != nil {
		_ = log.Close()
		return nil, err
	}
	if err := writeTestState(root, state); err != nil {
		_ = log.Close()
		return nil, err
	}
	return run, nil
}

func finishTestRun(root string, state *testState, run *activeTest, action string, elapsed float64) error {
	status := "fail"
	if action == "pass" || action == "skip" {
		status = action
	}
	seconds := fmt.Sprintf("%.3f", elapsed)
	entry := state.entry(run.name)
	entry.Status, entry.Elapsed = status, seconds
	run.record.Status, run.record.Elapsed = status, seconds
	run.record.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := run.log.Close(); err != nil {
		return err
	}
	if err := writeRunRecord(root, run.record); err != nil {
		return err
	}
	return writeTestState(root, state)
}

func writeRunRecord(root string, record testRunRecord) error {
	return writeJSONFile(filepath.Join(root, "logs", record.TestID+".json"), record)
}

func topLevelTest(name string) string {
	if index := strings.Index(name, "/"); index >= 0 {
		return name[:index]
	}
	return name
}

// testTitle turns TestDialtoneEarthOfflineGuardedAuth into "Dialtone Earth Offline Guarded Auth".
func testTitle(name string) string {
	runes := []rune(strings.TrimPrefix(name, "Test"))
	if len(runes) == 0 {
		return name
	}
	var title strings.Builder
	for index, char := range runes {
		next := ' '
		if index+1 < len(runes) {
			next = runes[index+1]
		}
		if index > 0 && unicode.IsUpper(char) && (!unicode.IsUpper(runes[index-1]) || unicode.IsLower(next)) {
			title.WriteRune(' ')
		}
		title.WriteRune(char)
	}
	return title.String()
}

func writeJSONFile(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path+".tmp", append(raw, '\n'), 0o644); err != nil {
		return err
	}
	// Windows readers and antivirus scanners can briefly deny replacement of an
	// open file. Keep the update atomic and retry only that transient error.
	for attempt := 0; ; attempt++ {
		err := os.Rename(path+".tmp", path)
		if runtime.GOOS != "windows" || !errors.Is(err, os.ErrPermission) || attempt >= 19 {
			return err
		}
		time.Sleep(25 * time.Millisecond)
	}
}
