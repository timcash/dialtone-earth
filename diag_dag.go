package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	DiagStatusPass    = "pass"
	DiagStatusFail    = "fail"
	DiagStatusSkipped = "skipped"
)

// DiagCheckOutcome is returned by a single check implementation.
type DiagCheckOutcome struct {
	Status     string
	SkipReason string
	Summary    string
	Error      string
	Details    map[string]any
	Stdout     string
	Stderr     string
}

// DiagCheckSpec defines one node in the diagnostic dependency DAG.
type DiagCheckSpec struct {
	ID        string
	Category  string
	Title     string
	DependsOn []string
	After     []string
	Run       func(ctx context.Context, depResults map[string]DiagCheckResult) DiagCheckOutcome
}

// DiagCheckResult is the immutable structured result of one check in a loop.
type DiagCheckResult struct {
	CheckID       string         `json:"check_id"`
	TestID        string         `json:"test_id"`
	Category      string         `json:"category"`
	Title         string         `json:"title"`
	DependsOn     []string       `json:"depends_on"`
	After         []string       `json:"after,omitempty"`
	Status        string         `json:"status"`
	SkipReason    string         `json:"skip_reason,omitempty"`
	StartedAt     string         `json:"started_at"`
	EndedAt       string         `json:"ended_at"`
	DurationMs    int64          `json:"duration_ms"`
	Summary       string         `json:"summary"`
	Error         string         `json:"error,omitempty"`
	Details       map[string]any `json:"details,omitempty"`
	Stdout        string         `json:"stdout,omitempty"`
	Stderr        string         `json:"stderr,omitempty"`
	RedactedCount int            `json:"redacted_count,omitempty"`
	TaskID        string         `json:"task_id,omitempty"`
	TaskAction    string         `json:"task_action,omitempty"`
}

// DiagSummary aggregates pass/fail/skipped counts for a loop.
type DiagSummary struct {
	Total   int `json:"total"`
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Skipped int `json:"skipped"`
}

// DiagRunMeta supplies loop-level metadata to ExecuteDiagDAG.
type DiagRunMeta struct {
	Source            string
	RunnerNode        string
	Interval          string
	ScreenshotsURL    string
	ScreenshotsLoopID string
	GitBranch         string
	GitCommit         string
	MaxConcurrency    int
}

// DiagLoopReport is the full structured report emitted per diagnostic loop.
type DiagLoopReport struct {
	SchemaVersion     int               `json:"schema_version"`
	LoopID            string            `json:"loop_id"`
	Source            string            `json:"source"`
	RunnerNode        string            `json:"runner_node"`
	Interval          string            `json:"interval"`
	StartedAt         string            `json:"started_at"`
	EndedAt           string            `json:"ended_at"`
	DurationMs        int64             `json:"duration_ms"`
	Status            string            `json:"status"`
	Summary           DiagSummary       `json:"summary"`
	ScreenshotsURL    string            `json:"screenshots_url,omitempty"`
	ScreenshotsLoopID string            `json:"screenshots_loop_id,omitempty"`
	GitBranch         string            `json:"git_branch,omitempty"`
	GitCommit         string            `json:"git_commit,omitempty"`
	Checks            []DiagCheckResult `json:"checks"`
}

// DiagHistoryEntry is a compact summary entry kept in history (last 50 loops).
type DiagHistoryEntry struct {
	LoopID            string      `json:"loop_id"`
	Source            string      `json:"source"`
	RunnerNode        string      `json:"runner_node"`
	StartedAt         string      `json:"started_at"`
	EndedAt           string      `json:"ended_at"`
	DurationMs        int64       `json:"duration_ms"`
	Status            string      `json:"status"`
	Summary           DiagSummary `json:"summary"`
	ScreenshotsURL    string      `json:"screenshots_url,omitempty"`
	ScreenshotsLoopID string      `json:"screenshots_loop_id,omitempty"`
	FailedCheckIDs    []string    `json:"failed_check_ids,omitempty"`
}

func generateDiagTestID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func generateDiagLoopID(now time.Time) string {
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return now.UTC().Format("20060102-150405Z")
	}
	return now.UTC().Format("20060102-150405Z") + "-" + hex.EncodeToString(raw[:])
}

// BuildDiagWaves validates a DAG of checks (unique IDs, known dependencies,
// acyclic) and returns deterministic topological execution waves.
func BuildDiagWaves(specs []DiagCheckSpec) ([][]DiagCheckSpec, error) {
	if len(specs) == 0 {
		return nil, errors.New("diagnostic DAG has no checks")
	}
	byID := make(map[string]DiagCheckSpec, len(specs))
	declOrder := make(map[string]int, len(specs))
	for i, s := range specs {
		id := strings.TrimSpace(s.ID)
		if id == "" {
			return nil, fmt.Errorf("check at index %d has empty ID", i)
		}
		if _, dup := byID[id]; dup {
			return nil, fmt.Errorf("duplicate diagnostic check ID %q", id)
		}
		s.ID = id
		byID[id] = s
		declOrder[id] = i
	}

	inDegree := make(map[string]int, len(specs))
	dependents := make(map[string][]string, len(specs))
	for _, s := range specs {
		seenEdge := map[string]bool{}
		addEdge := func(parent string) error {
			parent = strings.TrimSpace(parent)
			if parent == "" {
				return nil
			}
			if _, ok := byID[parent]; !ok {
				return fmt.Errorf("check %q depends on unknown check %q", s.ID, parent)
			}
			if parent == s.ID {
				return fmt.Errorf("check %q cannot depend on itself", s.ID)
			}
			if seenEdge[parent] {
				return nil
			}
			seenEdge[parent] = true
			inDegree[s.ID]++
			dependents[parent] = append(dependents[parent], s.ID)
			return nil
		}
		for _, dep := range s.DependsOn {
			if err := addEdge(dep); err != nil {
				return nil, err
			}
		}
		for _, after := range s.After {
			if err := addEdge(after); err != nil {
				return nil, err
			}
		}
	}

	var ready []string
	for _, s := range specs {
		if inDegree[s.ID] == 0 {
			ready = append(ready, s.ID)
		}
	}

	var waves [][]DiagCheckSpec
	visited := 0
	for len(ready) > 0 {
		wave := make([]DiagCheckSpec, 0, len(ready))
		for _, id := range ready {
			wave = append(wave, byID[id])
		}
		waves = append(waves, wave)
		visited += len(ready)

		var nextReady []string
		for _, id := range ready {
			for _, child := range dependents[id] {
				inDegree[child]--
				if inDegree[child] == 0 {
					nextReady = append(nextReady, child)
				}
			}
		}
		// Keep declaration order within each wave for deterministic reporting.
		for i := 0; i < len(nextReady); i++ {
			for j := i + 1; j < len(nextReady); j++ {
				if declOrder[nextReady[j]] < declOrder[nextReady[i]] {
					nextReady[i], nextReady[j] = nextReady[j], nextReady[i]
				}
			}
		}
		ready = nextReady
	}

	if visited != len(specs) {
		return nil, errors.New("diagnostic DAG contains a dependency cycle")
	}
	return waves, nil
}

// ExecuteDiagDAG runs all checks wave-by-wave in topological order, skipping
// any check whose hard dependency failed or was skipped, redacting outputs,
// and aggregating loop results.
func ExecuteDiagDAG(ctx context.Context, specs []DiagCheckSpec, meta DiagRunMeta) (*DiagLoopReport, error) {
	waves, err := BuildDiagWaves(specs)
	if err != nil {
		return nil, err
	}

	loopStart := time.Now().UTC()
	source := strings.TrimSpace(meta.Source)
	if source == "" {
		source = "cli"
	}
	maxConc := meta.MaxConcurrency
	if maxConc <= 0 {
		maxConc = 8
	}

	resultsByID := make(map[string]DiagCheckResult, len(specs))
	orderedResults := make([]DiagCheckResult, 0, len(specs))

	for _, wave := range waves {
		waveResults := make([]DiagCheckResult, len(wave))
		sem := make(chan struct{}, maxConc)
		var wg sync.WaitGroup

		// Snapshot completed results for safe concurrent read inside this wave.
		snapshot := make(map[string]DiagCheckResult, len(resultsByID))
		for k, v := range resultsByID {
			snapshot[k] = v
		}

		for i, spec := range wave {
			wg.Add(1)
			go func(idx int, s DiagCheckSpec) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()

				waveResults[idx] = executeOneDiagCheck(ctx, s, snapshot)
			}(i, spec)
		}
		wg.Wait()

		for _, res := range waveResults {
			resultsByID[res.CheckID] = res
			orderedResults = append(orderedResults, res)
		}
	}

	loopEnd := time.Now().UTC()
	summary := AggregateDiagSummary(orderedResults)
	overall := DiagStatusPass
	if summary.Failed > 0 {
		overall = DiagStatusFail
	}

	return &DiagLoopReport{
		SchemaVersion:     1,
		LoopID:            generateDiagLoopID(loopStart),
		Source:            source,
		RunnerNode:        meta.RunnerNode,
		Interval:          meta.Interval,
		StartedAt:         loopStart.Format(time.RFC3339Nano),
		EndedAt:           loopEnd.Format(time.RFC3339Nano),
		DurationMs:        loopEnd.Sub(loopStart).Milliseconds(),
		Status:            overall,
		Summary:           summary,
		ScreenshotsURL:    meta.ScreenshotsURL,
		ScreenshotsLoopID: meta.ScreenshotsLoopID,
		GitBranch:         meta.GitBranch,
		GitCommit:         meta.GitCommit,
		Checks:            orderedResults,
	}, nil
}

func executeOneDiagCheck(ctx context.Context, spec DiagCheckSpec, depResults map[string]DiagCheckResult) DiagCheckResult {
	started := time.Now().UTC()
	testID, err := generateDiagTestID()
	if err != nil {
		testID = fmt.Sprintf("%032x", started.UnixNano())
	}

	deps := append([]string(nil), spec.DependsOn...)
	if deps == nil {
		deps = []string{}
	}
	after := append([]string(nil), spec.After...)

	for _, parentID := range spec.DependsOn {
		parent, ok := depResults[parentID]
		if !ok || parent.Status != DiagStatusPass {
			ended := time.Now().UTC()
			reason := fmt.Sprintf("skipped because dependency %s %s", parentID, parent.Status)
			if parent.Status == DiagStatusFail {
				reason = fmt.Sprintf("skipped because dependency %s failed", parentID)
			} else if parent.Status == DiagStatusSkipped {
				reason = fmt.Sprintf("skipped because dependency %s was skipped", parentID)
			}
			return DiagCheckResult{
				CheckID:    spec.ID,
				TestID:     testID,
				Category:   spec.Category,
				Title:      spec.Title,
				DependsOn:  deps,
				After:      after,
				Status:     DiagStatusSkipped,
				SkipReason: reason,
				StartedAt:  started.Format(time.RFC3339Nano),
				EndedAt:    ended.Format(time.RFC3339Nano),
				DurationMs: ended.Sub(started).Milliseconds(),
				Summary:    reason,
			}
		}
	}

	var outcome DiagCheckOutcome
	if spec.Run == nil {
		outcome = DiagCheckOutcome{
			Status:     DiagStatusSkipped,
			SkipReason: "check has no runner configured",
		}
	} else {
		outcome = spec.Run(ctx, depResults)
	}
	ended := time.Now().UTC()

	status := outcome.Status
	if status != DiagStatusPass && status != DiagStatusFail && status != DiagStatusSkipped {
		status = DiagStatusFail
	}

	redactedCount := 0
	summary, n1 := RedactDiagText(strings.TrimSpace(outcome.Summary))
	redactedCount += n1
	errMsg, n2 := RedactDiagText(strings.TrimSpace(outcome.Error))
	redactedCount += n2
	skipReason, n3 := RedactDiagText(strings.TrimSpace(outcome.SkipReason))
	redactedCount += n3
	stdout, n4 := SanitizeDiagOutput(outcome.Stdout, defaultDiagMaxOutput)
	redactedCount += n4
	stderr, n5 := SanitizeDiagOutput(outcome.Stderr, defaultDiagMaxOutput)
	redactedCount += n5
	details, n6 := SanitizeDiagDetails(outcome.Details)
	redactedCount += n6

	if summary == "" {
		switch status {
		case DiagStatusPass:
			summary = "ok"
		case DiagStatusSkipped:
			summary = skipReason
		default:
			summary = errMsg
		}
	}

	return DiagCheckResult{
		CheckID:       spec.ID,
		TestID:        testID,
		Category:      spec.Category,
		Title:         spec.Title,
		DependsOn:     deps,
		After:         after,
		Status:        status,
		SkipReason:    skipReason,
		StartedAt:     started.Format(time.RFC3339Nano),
		EndedAt:       ended.Format(time.RFC3339Nano),
		DurationMs:    ended.Sub(started).Milliseconds(),
		Summary:       summary,
		Error:         errMsg,
		Details:       details,
		Stdout:        stdout,
		Stderr:        stderr,
		RedactedCount: redactedCount,
	}
}

// AggregateDiagSummary computes pass/fail/skipped totals from check results.
func AggregateDiagSummary(results []DiagCheckResult) DiagSummary {
	s := DiagSummary{Total: len(results)}
	for _, r := range results {
		switch r.Status {
		case DiagStatusPass:
			s.Passed++
		case DiagStatusFail:
			s.Failed++
		case DiagStatusSkipped:
			s.Skipped++
		}
	}
	return s
}

// ToDiagHistoryEntry converts a full loop report into a compact history row.
func ToDiagHistoryEntry(report *DiagLoopReport) DiagHistoryEntry {
	var failedIDs []string
	for _, c := range report.Checks {
		if c.Status == DiagStatusFail {
			failedIDs = append(failedIDs, c.CheckID)
		}
	}
	return DiagHistoryEntry{
		LoopID:            report.LoopID,
		Source:            report.Source,
		RunnerNode:        report.RunnerNode,
		StartedAt:         report.StartedAt,
		EndedAt:           report.EndedAt,
		DurationMs:        report.DurationMs,
		Status:            report.Status,
		Summary:           report.Summary,
		ScreenshotsURL:    report.ScreenshotsURL,
		ScreenshotsLoopID: report.ScreenshotsLoopID,
		FailedCheckIDs:    failedIDs,
	}
}
