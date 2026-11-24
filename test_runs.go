package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
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
	"sort"
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

// pipelineFile tracks the live Edit -> Test -> Deploy stage for the dashboard.
var pipelineFile = filepath.Join("logs", "pipeline.json")

// deployedFile records the exact staging content fingerprint last deployed live
// to https://dialtone.earth/ so the deploy button only lights up when new changes exist.
var deployedFile = filepath.Join("logs", "deployed.json")

type deployedRecord struct {
	DeployedHash string `json:"deployed_hash"`
	VersionID    string `json:"version_id,omitempty"`
	VerifiedProd bool   `json:"verified_prod,omitempty"`
	DeployedAt   string `json:"deployed_at"`
}

type pipelineState struct {
	Stage        string `json:"stage"`
	Message      string `json:"message"`
	Changed      string `json:"changed,omitempty"`
	TargetOrigin string `json:"target_origin,omitempty"`
	DeployURL    string `json:"deploy_url,omitempty"`
	VersionID    string `json:"version_id,omitempty"`
	TestedHash   string `json:"tested_hash,omitempty"`
	DeployedHash string `json:"deployed_hash,omitempty"`
	Passed       int    `json:"passed"`
	Failed       int    `json:"failed"`
	Total        int    `json:"total"`
	UpdatedAt    string `json:"updated_at"`
}

func readPipelineState(root string) pipelineState {
	var p pipelineState
	if raw, err := os.ReadFile(filepath.Join(root, pipelineFile)); err == nil {
		_ = json.Unmarshal(raw, &p)
	}
	return p
}

func readDeployedRecord(root string) deployedRecord {
	var rec deployedRecord
	if raw, err := os.ReadFile(filepath.Join(root, deployedFile)); err == nil {
		_ = json.Unmarshal(raw, &rec)
	}
	return rec
}

func writeDeployedRecord(root string, rec deployedRecord) {
	rec.DeployedAt = time.Now().UTC().Format(time.RFC3339Nano)
	_ = writeJSONFile(filepath.Join(root, deployedFile), rec)
}

// computeStagingFingerprint returns a deterministic SHA-256 hex digest over all
// deployable dialtone.earth site & Worker source files. Matches ui/vite.config.ts.
func computeStagingFingerprint(root string) string {
	var relPaths []string
	addFile := func(rel string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			relPaths = append(relPaths, rel)
		}
	}
	addTree := func(relDir string) {
		base := filepath.Join(root, filepath.FromSlash(relDir))
		_ = filepath.WalkDir(base, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				name := d.Name()
				if name == "node_modules" || name == "dist" || name == ".git" {
					return filepath.SkipDir
				}
				return nil
			}
			rel, relErr := filepath.Rel(root, path)
			if relErr == nil {
				relPaths = append(relPaths, filepath.ToSlash(rel))
			}
			return nil
		})
	}
	addTree("registry/src")
	addTree("registry/worker")
	addFile("registry/index.html")
	addFile("registry/wrangler.jsonc")
	addFile("install.sh")
	addFile("install.ps1")
	sort.Strings(relPaths)
	h := sha256.New()
	for _, rel := range relPaths {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		_, _ = h.Write([]byte(rel))
		_, _ = h.Write([]byte("\n"))
		_, _ = h.Write(data)
		_, _ = h.Write([]byte("\n"))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func writePipelineState(root string, p pipelineState) {
	if p.DeployedHash == "" {
		p.DeployedHash = readDeployedRecord(root).DeployedHash
	}
	p.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	_ = writeJSONFile(filepath.Join(root, pipelineFile), p)
}

func allBrowserTestsPassed(state *testState) bool {
	if state == nil {
		return false
	}
	browserTotal := 0
	browserPass := 0
	for _, t := range state.Tests {
		if strings.HasPrefix(t.Name, "TestBrowser") {
			browserTotal++
			if t.Status == "pass" {
				browserPass++
			}
		}
	}
	return browserTotal > 0 && browserPass == browserTotal
}

func countStateTotals(state *testState) (passed, failed, total int) {
	if state == nil {
		return 0, 0, 0
	}
	total = len(state.Tests)
	for _, t := range state.Tests {
		switch t.Status {
		case "pass":
			passed++
		case "fail":
			failed++
		}
	}
	return passed, failed, total
}

func verifyStagingGate(root string) (int, int, error) {
	raw, err := os.ReadFile(filepath.Join(root, stateFile))
	if err != nil {
		return 0, 0, fmt.Errorf("staging gate blocked: no test state found at %s (run tests first)", stateFile)
	}
	var state testState
	if err := json.Unmarshal(raw, &state); err != nil {
		return 0, 0, fmt.Errorf("staging gate blocked: invalid %s: %w", stateFile, err)
	}
	if len(state.Tests) == 0 {
		return 0, 0, errors.New("staging gate blocked: test list is empty")
	}
	byName := make(map[string]string, len(state.Tests))
	var passed, failed, running, pending int
	for _, t := range state.Tests {
		byName[t.Name] = t.Status
		switch t.Status {
		case "pass":
			passed++
		case "fail":
			failed++
		case "running":
			running++
		case "pending", "":
			pending++
		}
	}
	if running > 0 {
		return passed, len(state.Tests), fmt.Errorf("staging gate blocked: %d test(s) still running", running)
	}
	if failed > 0 {
		return passed, len(state.Tests), fmt.Errorf("staging gate blocked: %d test(s) failed — fix before deploying to dialtone.earth", failed)
	}
	if pending > 0 {
		return passed, len(state.Tests), fmt.Errorf("staging gate blocked: %d test(s) still pending — run all tests first", pending)
	}
	if passed == 0 {
		return 0, len(state.Tests), errors.New("staging gate blocked: 0 tests passed — run tests before deploying")
	}
	if !allBrowserTestsPassed(&state) {
		return passed, len(state.Tests), errors.New("staging gate blocked: test-network browser tests (TestBrowser01..09) must all pass before deploying")
	}
	for _, required := range []string{
		"TestDialtoneEarthOwnerOnlyAccess",
		"TestDialtoneEarthCloudflareRegistry",
		"TestUIUnitTests",
	} {
		if st, exists := byName[required]; exists && st != "pass" {
			return passed, len(state.Tests), fmt.Errorf("staging gate blocked: required test %s is %q (must be pass)", required, st)
		}
	}
	currentHash := computeStagingFingerprint(root)
	pipe := readPipelineState(root)
	if pipe.TestedHash == "" || pipe.TestedHash != currentHash {
		return passed, len(state.Tests), errors.New("staging gate blocked: files changed since last passing test-network run — re-run tests first")
	}
	deployed := readDeployedRecord(root)
	if deployed.DeployedHash != "" && deployed.DeployedHash == currentHash {
		return passed, len(state.Tests), errors.New("nothing new to deploy: staging already matches live dialtone.earth")
	}
	return passed, len(state.Tests), nil
}

type testState struct {
	GeneratedAt string      `json:"generated_at"`
	Tests       []testEntry `json:"tests"`
}

type testEntry struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Section     string `json:"section,omitempty"`
	Source      string `json:"source,omitempty"`
	Status      string `json:"status"`
	Elapsed     string `json:"elapsed"`
	LastElapsed string `json:"last_elapsed,omitempty"`
	Timestamp   string `json:"timestamp"`
	TestID      string `json:"test-id"`
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
	if strings.HasPrefix(name, "TestBrowser") {
		return "Synced Live Browser (CDP)"
	}
	switch name {
	case "TestDialtoneEarthLiveMetalDaemonE2E",
		"TestDialtoneEarthMetalLiveBrowserE2E",
		"TestDialtoneEarthLiveMetalUIParity",
		"TestDialtoneEarthGlobeH3AndBundledArcs",
		"TestDialtoneEarthTilingWindowManagerAndQueryRates",
		"TestDialtoneEarthCameraStudioTypeScript",
		"TestDialtoneEarthCloudflareKVConfigAndTour",
		"TestDialtoneEarthSimulatedTour":
		return "Live metal Data & UI"
	case "TestDialtoneEarthCloudflareGateway",
		"TestDialtoneEarthCloudflareRegistry",
		"TestDialtoneEarthOwnerOnlyAccess",
		"TestDialtoneEarthLiveOwnerAccessOnCloudflare",
		"TestDialtoneEarthRegistrySecurityHeaders",
		"TestDialtoneEarthOriginBridge",
		"TestDialtoneEarthRegistryNetworks":
		return "Cloudflare Gateway & Security"
	case "TestDialtoneEarthLiveControlCLI",
		"TestDialtoneEarthRegistryCLI",
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

func previousElapsedForEntry(prev testEntry) string {
	if (prev.Status == "pass" || prev.Status == "fail") && strings.TrimSpace(prev.Elapsed) != "" && strings.TrimSpace(prev.Elapsed) != "0" {
		return strings.TrimSpace(prev.Elapsed)
	}
	if strings.TrimSpace(prev.LastElapsed) != "" && strings.TrimSpace(prev.LastElapsed) != "0" {
		return strings.TrimSpace(prev.LastElapsed)
	}
	return ""
}

func buildInitialTestState(root string, selectedNames []string, filter string) testState {
	previous := map[string]testEntry{}
	if raw, err := os.ReadFile(filepath.Join(root, stateFile)); err == nil {
		var prevState testState
		if json.Unmarshal(raw, &prevState) == nil {
			for _, entry := range prevState.Tests {
				previous[entry.Name] = entry
			}
		}
	}
	if strings.TrimSpace(filter) == "" {
		state := newTestState(selectedNames)
		for i := range state.Tests {
			if prev, ok := previous[state.Tests[i].Name]; ok {
				state.Tests[i].LastElapsed = previousElapsedForEntry(prev)
			}
		}
		return state
	}
	allNames, err := listTestNames(root, "")
	if err != nil || len(allNames) == 0 {
		state := newTestState(selectedNames)
		for i := range state.Tests {
			if prev, ok := previous[state.Tests[i].Name]; ok {
				state.Tests[i].LastElapsed = previousElapsedForEntry(prev)
			}
		}
		return state
	}
	selected := make(map[string]bool, len(selectedNames))
	for _, n := range selectedNames {
		selected[n] = true
	}
	state := newTestState(allNames)
	for i := range state.Tests {
		name := state.Tests[i].Name
		if prev, ok := previous[name]; ok {
			state.Tests[i].LastElapsed = previousElapsedForEntry(prev)
			if !selected[name] {
				state.Tests[i].Status = prev.Status
				state.Tests[i].Elapsed = prev.Elapsed
				state.Tests[i].Timestamp = prev.Timestamp
				state.Tests[i].TestID = prev.TestID
			}
		}
	}
	return state
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
func runGoTests(root string, state *testState, pattern string, extraEnv []string, stdout io.Writer) error {
	started := time.Now()
	args := []string{"test", "-json", "-count=1", "-timeout", goTestTimeout}
	if pattern != "" {
		args = append(args, "-run", pattern)
	}
	command := exec.Command("go", append(args, ".")...)
	command.Dir = root
	command.Env = append(append(os.Environ(), testRunEnv+"=1"), extraEnv...)
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
	printTestSummary(stdout, state, time.Since(started))
	if consumeErr != nil {
		return consumeErr
	}
	if len(failures) > 0 {
		return fmt.Errorf("%d test(s) failed: %s", len(failures), strings.Join(failures, ", "))
	}
	return waitErr
}

func printTestSummary(stdout io.Writer, state *testState, elapsed time.Duration) {
	if len(state.Tests) == 0 {
		return
	}
	var passed, failed, skipped int
	var failedEntries []testEntry
	for _, t := range state.Tests {
		switch t.Status {
		case "pass":
			passed++
		case "fail":
			failed++
			failedEntries = append(failedEntries, t)
		case "skip":
			skipped++
		}
	}
	ts := time.Now().UTC().Format("15:04:05Z")
	fmt.Fprintf(stdout, "\n[%s] === DIALTONE-EARTH TEST SUMMARY (%.2fs) ===\n", ts, elapsed.Seconds())
	fmt.Fprintf(stdout, "[%s] PASS: %d | FAIL: %d | SKIP: %d | TOTAL: %d | STATE: %s\n",
		ts, passed, failed, skipped, len(state.Tests), stateFile)
	for _, f := range failedEntries {
		fmt.Fprintf(stdout, "[%s] [ERROR] %s (%s) -> logs/%s.log\n", ts, f.Name, f.Source, f.TestID)
	}
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
