package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultDiagPublishURL = "http://127.0.0.1:5174"
	defaultDiagHistoryMax = 50
)

// DiagPublishOptions controls posting diagnostic results to the UI server.
type DiagPublishOptions struct {
	BaseURL     string
	PublishLive bool
	Token       string
	HTTPClient  *http.Client
}

type diagLogUpload struct {
	Record testRunRecord `json:"record"`
	Log    string        `json:"log"`
}

// ValidateDiagPublishTarget enforces that non-localhost URLs require --publish-live.
func ValidateDiagPublishTarget(rawURL string, publishLive bool) (string, error) {
	cleaned := strings.TrimRight(strings.TrimSpace(rawURL), "/")
	if cleaned == "" {
		cleaned = defaultDiagPublishURL
	}
	parsed, err := url.Parse(cleaned)
	if err != nil {
		return "", fmt.Errorf("invalid publish URL %q: %w", rawURL, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("publish URL %q must use http or https", rawURL)
	}
	host := strings.ToLower(parsed.Hostname())
	isLocalhost := host == "127.0.0.1" || host == "localhost" || host == "::1"
	if !isLocalhost && !publishLive {
		return "", fmt.Errorf("refusing to publish diagnostics to non-localhost URL %q without explicit --publish-live flag", cleaned)
	}
	return cleaned, nil
}

// formatDiagCheckLog renders a structured log compatible with /logs/?test-id=.
func formatDiagCheckLog(report *DiagLoopReport, check DiagCheckResult) (testRunRecord, string) {
	level := "INFO "
	switch check.Status {
	case DiagStatusPass:
		level = "PASS "
	case DiagStatusFail:
		level = "ERROR"
	case DiagStatusSkipped:
		level = "WARN "
	}
	ts := formatLogTimestamp(check.StartedAt)
	endTs := formatLogTimestamp(check.EndedAt)
	var b strings.Builder
	fmt.Fprintf(&b, "%s [INFO ] diag:%s | loop=%s runner=%s category=%s title=%q\n",
		ts, check.CheckID, report.LoopID, report.RunnerNode, check.Category, check.Title)
	if len(check.DependsOn) > 0 {
		fmt.Fprintf(&b, "%s [INFO ] diag:%s | depends_on=%s\n", ts, check.CheckID, strings.Join(check.DependsOn, ","))
	}
	fmt.Fprintf(&b, "%s [%s] diag:%s | status=%s duration_ms=%d summary=%s\n",
		endTs, level, check.CheckID, check.Status, check.DurationMs, check.Summary)
	if check.SkipReason != "" {
		fmt.Fprintf(&b, "%s [WARN ] diag:%s | skip_reason=%s\n", endTs, check.CheckID, check.SkipReason)
	}
	if check.Error != "" {
		fmt.Fprintf(&b, "%s [ERROR] diag:%s | error=%s\n", endTs, check.CheckID, check.Error)
	}
	if check.TaskID != "" {
		fmt.Fprintf(&b, "%s [INFO ] diag:%s | task_id=%s task_action=%s\n", endTs, check.CheckID, check.TaskID, check.TaskAction)
	}
	if len(check.Details) > 0 {
		if raw, err := json.Marshal(check.Details); err == nil {
			redacted, _ := RedactDiagText(string(raw))
			fmt.Fprintf(&b, "%s [INFO ] diag:%s | details=%s\n", endTs, check.CheckID, redacted)
		}
	}
	if strings.TrimSpace(check.Stdout) != "" {
		for _, line := range strings.Split(strings.TrimRight(check.Stdout, "\n"), "\n") {
			fmt.Fprintf(&b, "%s [INFO ] diag:%s | stdout: %s\n", endTs, check.CheckID, line)
		}
	}
	if strings.TrimSpace(check.Stderr) != "" {
		for _, line := range strings.Split(strings.TrimRight(check.Stderr, "\n"), "\n") {
			fmt.Fprintf(&b, "%s [WARN ] diag:%s | stderr: %s\n", endTs, check.CheckID, line)
		}
	}

	uiStatus := check.Status
	if uiStatus == DiagStatusSkipped {
		uiStatus = "skip"
	}
	rec := testRunRecord{
		TestID:      check.TestID,
		Name:        check.CheckID,
		Title:       check.Title,
		Section:     "Diagnostics: " + check.Category,
		Source:      "diag:" + check.CheckID,
		Command:     "go run . diag run",
		Status:      uiStatus,
		Timestamp:   check.StartedAt,
		Elapsed:     fmt.Sprintf("%.3f", float64(check.DurationMs)/1000.0),
		Artifact:    "logs/" + check.TestID + ".log",
		CompletedAt: check.EndedAt,
	}
	return rec, b.String()
}

// PersistDiagReportLocally writes logs/diag/{latest,history,runs/<loop-id>}.json
// and compatible logs/<test-id>.{json,log} files so the local dev server serves them.
func PersistDiagReportLocally(root string, report *DiagLoopReport, maxHistory int) error {
	if report == nil {
		return errors.New("diagnostic report is nil")
	}
	if maxHistory <= 0 {
		maxHistory = defaultDiagHistoryMax
	}
	diagDir := filepath.Join(root, "logs", "diag")
	runsDir := filepath.Join(diagDir, "runs")
	if err := os.MkdirAll(runsDir, 0o755); err != nil {
		return err
	}

	// Write compatible per-check logs/<test-id>.{json,log} for /logs/?test-id=.
	for _, check := range report.Checks {
		if check.TestID == "" {
			continue
		}
		rec, logText := formatDiagCheckLog(report, check)
		if err := writeRunRecord(root, rec); err != nil {
			return err
		}
		logPath := filepath.Join(root, "logs", check.TestID+".log")
		if err := os.WriteFile(logPath, []byte(logText), 0o600); err != nil {
			return err
		}
	}

	if err := writeJSONFile(filepath.Join(runsDir, report.LoopID+".json"), report); err != nil {
		return err
	}
	if err := writeJSONFile(filepath.Join(diagDir, "latest.json"), report); err != nil {
		return err
	}

	histPath := filepath.Join(diagDir, "history.json")
	var history []DiagHistoryEntry
	if raw, err := os.ReadFile(histPath); err == nil {
		_ = json.Unmarshal(raw, &history)
	}
	entry := ToDiagHistoryEntry(report)
	filtered := make([]DiagHistoryEntry, 0, len(history)+1)
	filtered = append(filtered, entry)
	for _, h := range history {
		if h.LoopID == entry.LoopID {
			continue
		}
		filtered = append(filtered, h)
		if len(filtered) >= maxHistory {
			break
		}
	}
	return writeJSONFile(histPath, filtered)
}

// PublishDiagReport POSTs the diagnostic loop report and per-check logs to
// <baseURL>/api/diagnostics/runs, refusing non-localhost URLs unless PublishLive is true.
func PublishDiagReport(ctx context.Context, root string, report *DiagLoopReport, opts DiagPublishOptions) error {
	if report == nil {
		return errors.New("diagnostic report is nil")
	}
	baseURL, err := ValidateDiagPublishTarget(opts.BaseURL, opts.PublishLive)
	if err != nil {
		return err
	}

	parsed, _ := url.Parse(baseURL)
	host := strings.ToLower(parsed.Hostname())
	isLocalhost := host == "127.0.0.1" || host == "localhost" || host == "::1"
	if !isLocalhost && strings.TrimSpace(opts.Token) == "" {
		return errors.New("--publish-live to a remote host requires an owner Bearer token (--token-file or DIALTONE_LIVE_TOKEN)")
	}

	logsMap := make(map[string]diagLogUpload, len(report.Checks))
	for _, check := range report.Checks {
		if check.TestID == "" {
			continue
		}
		rec, logText := formatDiagCheckLog(report, check)
		logsMap[check.TestID] = diagLogUpload{
			Record: rec,
			Log:    logText,
		}
	}

	payload := map[string]any{
		"report": report,
		"logs":   logsMap,
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	endpoint := baseURL + "/api/diagnostics/runs"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if tok := strings.TrimSpace(opts.Token); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}

	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("POST %s: %w", endpoint, err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		redacted, _ := RedactDiagText(strings.TrimSpace(string(respBody)))
		return fmt.Errorf("POST %s returned HTTP %d: %s", endpoint, resp.StatusCode, redacted)
	}
	return nil
}
