package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestDiagDAGOrderingAndDependencySkip(t *testing.T) {
	var ran []string
	specs := []DiagCheckSpec{
		{
			ID:        "child.of.fail",
			Category:  "plugins",
			Title:     "Child of failing check",
			DependsOn: []string{"node.offline"},
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				ran = append(ran, "child.of.fail")
				return DiagCheckOutcome{Status: DiagStatusPass}
			},
		},
		{
			ID:        "grandchild.of.fail",
			Category:  "plugins",
			Title:     "Grandchild of failing check",
			DependsOn: []string{"child.of.fail"},
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				ran = append(ran, "grandchild.of.fail")
				return DiagCheckOutcome{Status: DiagStatusPass}
			},
		},
		{
			ID:        "node.offline",
			Category:  "metal",
			Title:     "Offline peer",
			DependsOn: []string{"mesh.root"},
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				ran = append(ran, "node.offline")
				return DiagCheckOutcome{Status: DiagStatusFail, Error: "peer timed out"}
			},
		},
		{
			ID:        "node.online",
			Category:  "metal",
			Title:     "Online peer",
			DependsOn: []string{"mesh.root"},
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				ran = append(ran, "node.online")
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: "ok"}
			},
		},
		{
			ID:       "mesh.root",
			Category: "metal",
			Title:    "Local probe",
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				ran = append(ran, "mesh.root")
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: "3/3 checks ok"}
			},
		},
		{
			ID:        "plugin.consistency",
			Category:  "plugins",
			Title:     "Task hash consistency",
			DependsOn: []string{"mesh.root"},
			After:     []string{"node.online", "node.offline", "child.of.fail"},
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				ran = append(ran, "plugin.consistency")
				if deps["node.online"].Status != DiagStatusPass {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "expected online node"}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: "hashes match across online nodes"}
			},
		},
	}

	report, err := ExecuteDiagDAG(context.Background(), specs, DiagRunMeta{
		RunnerNode: "rosie",
		Interval:   "10m",
	})
	if err != nil {
		t.Fatalf("ExecuteDiagDAG failed: %v", err)
	}

	byID := map[string]DiagCheckResult{}
	indexByID := map[string]int{}
	for i, c := range report.Checks {
		byID[c.CheckID] = c
		indexByID[c.CheckID] = i
	}

	if indexByID["mesh.root"] >= indexByID["node.offline"] || indexByID["mesh.root"] >= indexByID["node.online"] {
		t.Fatalf("mesh.root must precede children in topological order: %v", indexByID)
	}
	if indexByID["node.offline"] >= indexByID["child.of.fail"] || indexByID["child.of.fail"] >= indexByID["grandchild.of.fail"] {
		t.Fatalf("dependency order violated: %v", indexByID)
	}
	if indexByID["child.of.fail"] >= indexByID["plugin.consistency"] {
		t.Fatalf("soft After dependency order violated: %v", indexByID)
	}

	if byID["child.of.fail"].Status != DiagStatusSkipped {
		t.Fatalf("child.of.fail status = %q, want skipped", byID["child.of.fail"].Status)
	}
	if !strings.Contains(byID["child.of.fail"].SkipReason, "node.offline") {
		t.Fatalf("child.of.fail skip_reason = %q, want mention of node.offline", byID["child.of.fail"].SkipReason)
	}
	if byID["grandchild.of.fail"].Status != DiagStatusSkipped {
		t.Fatalf("grandchild.of.fail status = %q, want skipped", byID["grandchild.of.fail"].Status)
	}
	if byID["plugin.consistency"].Status != DiagStatusPass {
		t.Fatalf("plugin.consistency status = %q, want pass", byID["plugin.consistency"].Status)
	}

	for _, id := range ran {
		if id == "child.of.fail" || id == "grandchild.of.fail" {
			t.Fatalf("skipped check %q should not have executed", id)
		}
	}

	// Verify aggregation totals.
	if report.Summary.Total != 6 || report.Summary.Passed != 3 || report.Summary.Failed != 1 || report.Summary.Skipped != 2 {
		t.Fatalf("unexpected summary: %+v", report.Summary)
	}
	if report.Status != DiagStatusFail {
		t.Fatalf("overall status = %q, want fail", report.Status)
	}
}

func TestDiagDAGRejectsCyclesAndUnknownDeps(t *testing.T) {
	cycleSpecs := []DiagCheckSpec{
		{ID: "a", DependsOn: []string{"b"}, Run: func(context.Context, map[string]DiagCheckResult) DiagCheckOutcome { return DiagCheckOutcome{Status: DiagStatusPass} }},
		{ID: "b", DependsOn: []string{"a"}, Run: func(context.Context, map[string]DiagCheckResult) DiagCheckOutcome { return DiagCheckOutcome{Status: DiagStatusPass} }},
	}
	if _, err := ExecuteDiagDAG(context.Background(), cycleSpecs, DiagRunMeta{}); err == nil {
		t.Fatal("expected cycle error, got nil")
	}

	missingDepSpecs := []DiagCheckSpec{
		{ID: "a", DependsOn: []string{"does.not.exist"}, Run: func(context.Context, map[string]DiagCheckResult) DiagCheckOutcome { return DiagCheckOutcome{Status: DiagStatusPass} }},
	}
	if _, err := ExecuteDiagDAG(context.Background(), missingDepSpecs, DiagRunMeta{}); err == nil {
		t.Fatal("expected missing dependency error, got nil")
	}
}

func TestDiagCheckAggregationAndUniqueTestIDs(t *testing.T) {
	hex32 := regexp.MustCompile(`^[a-f0-9]{32}$`)
	specs := []DiagCheckSpec{
		{
			ID:       "check.pass",
			Category: "http",
			Title:    "Pass check",
			Run: func(context.Context, map[string]DiagCheckResult) DiagCheckOutcome {
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: "200 OK"}
			},
		},
		{
			ID:       "check.skip",
			Category: "plugins",
			Title:    "Optional plugin",
			Run: func(context.Context, map[string]DiagCheckResult) DiagCheckOutcome {
				return DiagCheckOutcome{Status: DiagStatusSkipped, SkipReason: "not installed"}
			},
		},
	}

	r1, err := ExecuteDiagDAG(context.Background(), specs, DiagRunMeta{RunnerNode: "rosie"})
	if err != nil {
		t.Fatal(err)
	}
	r2, err := ExecuteDiagDAG(context.Background(), specs, DiagRunMeta{RunnerNode: "rosie"})
	if err != nil {
		t.Fatal(err)
	}

	if r1.Status != DiagStatusPass {
		t.Fatalf("pass+skipped loop status = %q, want pass", r1.Status)
	}
	if r1.Summary.Passed != 1 || r1.Summary.Skipped != 1 || r1.Summary.Failed != 0 || r1.Summary.Total != 2 {
		t.Fatalf("unexpected summary: %+v", r1.Summary)
	}
	if r1.LoopID == "" || r1.LoopID == r2.LoopID {
		t.Fatalf("expected distinct loop IDs: %q vs %q", r1.LoopID, r2.LoopID)
	}

	seen := map[string]bool{}
	for _, rep := range []*DiagLoopReport{r1, r2} {
		for _, c := range rep.Checks {
			if !hex32.MatchString(c.TestID) {
				t.Fatalf("check %s invalid test_id %q", c.CheckID, c.TestID)
			}
			if seen[c.TestID] {
				t.Fatalf("duplicate test_id generated: %s", c.TestID)
			}
			seen[c.TestID] = true
		}
	}
}

func TestDiagRedactionAndTruncation(t *testing.T) {
	input := strings.Join([]string{
		"Authorization: Bearer super_secret_bearer_token_1234567890",
		"Cookie: dialtone_session=abc123def456ghi789",
		"DIALTONE_LIVE_TOKEN=live_secret_value_999",
		"rpc.token=rpc_secret_987654321",
		"mesh.key=mesh_secret_key_abcdef",
		"ticket=iroh-blobs://ticket/blobabcdef1234567890xyz",
		"invite=dialtone-invite-v2:secretinvitepayload12345",
		"channel_secret=dt-secretchannelkey123456",
		"https://alice:topsecretpass@db.internal:5432/prod",
		"jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aW0ifQ.signaturepart12345",
		"ghp_abcdefghijklmnopqrstuvwxyz123456",
		"safe line: status=200 latency=14ms",
	}, "\n")

	redacted, count := RedactDiagText(input)
	if count < 10 {
		t.Fatalf("expected >= 10 redactions, got %d\n%s", count, redacted)
	}
	forbidden := []string{
		"super_secret_bearer_token_1234567890",
		"abc123def456ghi789",
		"live_secret_value_999",
		"rpc_secret_987654321",
		"mesh_secret_key_abcdef",
		"blobabcdef1234567890xyz",
		"secretinvitepayload12345",
		"dt-secretchannelkey123456",
		"topsecretpass",
		"signaturepart12345",
		"ghp_abcdefghijklmnopqrstuvwxyz123456",
	}
	for _, secret := range forbidden {
		if strings.Contains(redacted, secret) {
			t.Errorf("secret leaked after redaction: %q\n%s", secret, redacted)
		}
	}
	if !strings.Contains(redacted, "safe line: status=200 latency=14ms") {
		t.Fatalf("safe text was unexpectedly altered:\n%s", redacted)
	}

	huge := strings.Repeat("x", 8000)
	truncated := TruncateDiagOutput(huge, 4096)
	if len(truncated) > 4120 || !strings.HasSuffix(truncated, "[truncated]") {
		t.Fatalf("expected truncated output around 4096 bytes, got len=%d", len(truncated))
	}
}

type fakeDiagTaskStore struct {
	tasks     []DiagTask
	nextID    int
	addCalls  int
	updCalls  int
	doneCalls int
}

func (f *fakeDiagTaskStore) List(ctx context.Context) ([]DiagTask, error) {
	out := make([]DiagTask, len(f.tasks))
	copy(out, f.tasks)
	return out, nil
}

func (f *fakeDiagTaskStore) Add(ctx context.Context, title string, tags []string, note string) (DiagTask, error) {
	f.nextID++
	f.addCalls++
	t := DiagTask{
		ID:     "t-fake-" + string(rune('0'+f.nextID)),
		Title:  title,
		Status: "active",
		Tags:   append([]string(nil), tags...),
		Note:   note,
	}
	f.tasks = append(f.tasks, t)
	return t, nil
}

func (f *fakeDiagTaskStore) Update(ctx context.Context, id string, note string) error {
	f.updCalls++
	for i := range f.tasks {
		if f.tasks[i].ID == id {
			f.tasks[i].Note = note
			return nil
		}
	}
	return nil
}

func (f *fakeDiagTaskStore) Done(ctx context.Context, id string, note string) error {
	f.doneCalls++
	for i := range f.tasks {
		if f.tasks[i].ID == id {
			f.tasks[i].Status = "done"
			f.tasks[i].Note = note
			return nil
		}
	}
	return nil
}

func TestDiagTaskSyncDedupeUpdateSkipAndClose(t *testing.T) {
	store := &fakeDiagTaskStore{}

	// Loop 1: mesh.node.grok-bot-metal fails, plugin.task.node.grok-bot-metal is skipped, http.dialtone.home passes.
	rep1 := &DiagLoopReport{
		LoopID: "loop-1",
		Checks: []DiagCheckResult{
			{CheckID: "http.dialtone.home", TestID: strings.Repeat("a", 32), Status: DiagStatusPass},
			{CheckID: "mesh.node.grok-bot-metal", TestID: strings.Repeat("b", 32), Status: DiagStatusFail, Error: "peer offline Bearer secret_tok_123456"},
			{CheckID: "plugin.task.node.grok-bot-metal", TestID: strings.Repeat("c", 32), Status: DiagStatusSkipped, SkipReason: "parent failed"},
		},
	}
	if err := SyncDiagTasks(context.Background(), store, rep1); err != nil {
		t.Fatal(err)
	}
	if store.addCalls != 1 || len(store.tasks) != 1 {
		t.Fatalf("expected 1 task created, got addCalls=%d tasks=%+v", store.addCalls, store.tasks)
	}
	task := store.tasks[0]
	if task.Title != "diag: mesh.node.grok-bot-metal failing" {
		t.Fatalf("unexpected task title: %q", task.Title)
	}
	if len(task.Tags) != 1 || task.Tags[0] != "diagnostic" {
		t.Fatalf("unexpected task tags: %v", task.Tags)
	}
	if strings.Contains(task.Note, "secret_tok_123456") {
		t.Fatalf("task note leaked secret: %q", task.Note)
	}
	if !strings.Contains(task.Note, strings.Repeat("b", 32)) {
		t.Fatalf("task note missing test-id: %q", task.Note)
	}
	if rep1.Checks[1].TaskAction != "created" || rep1.Checks[1].TaskID != task.ID {
		t.Fatalf("unexpected check task metadata: %+v", rep1.Checks[1])
	}
	if rep1.Checks[2].TaskID != "" {
		t.Fatalf("skipped check must not create a task: %+v", rep1.Checks[2])
	}

	// Loop 2: same check fails again -> must UPDATE existing task, NOT create duplicate.
	rep2 := &DiagLoopReport{
		LoopID: "loop-2",
		Checks: []DiagCheckResult{
			{CheckID: "mesh.node.grok-bot-metal", TestID: strings.Repeat("d", 32), Status: DiagStatusFail, Error: "still offline"},
		},
	}
	if err := SyncDiagTasks(context.Background(), store, rep2); err != nil {
		t.Fatal(err)
	}
	if store.addCalls != 1 || store.updCalls != 1 || len(store.tasks) != 1 {
		t.Fatalf("expected deduped update: add=%d upd=%d tasks=%+v", store.addCalls, store.updCalls, store.tasks)
	}
	if !strings.Contains(store.tasks[0].Note, strings.Repeat("d", 32)) {
		t.Fatalf("updated note missing new test-id: %q", store.tasks[0].Note)
	}
	if rep2.Checks[0].TaskAction != "updated" {
		t.Fatalf("expected task action updated, got %q", rep2.Checks[0].TaskAction)
	}

	// Loop 3: check recovers -> mark task DONE.
	rep3 := &DiagLoopReport{
		LoopID: "loop-3",
		Checks: []DiagCheckResult{
			{CheckID: "mesh.node.grok-bot-metal", TestID: strings.Repeat("e", 32), Status: DiagStatusPass},
		},
	}
	if err := SyncDiagTasks(context.Background(), store, rep3); err != nil {
		t.Fatal(err)
	}
	if store.doneCalls != 1 || store.tasks[0].Status != "done" {
		t.Fatalf("expected task closed on recovery: done=%d task=%+v", store.doneCalls, store.tasks[0])
	}
	if rep3.Checks[0].TaskAction != "closed" {
		t.Fatalf("expected task action closed, got %q", rep3.Checks[0].TaskAction)
	}
}

func TestDiagLocalhostPublishGuard(t *testing.T) {
	allowedLocal := []string{
		"http://127.0.0.1:5174",
		"http://localhost:5174/",
		"http://[::1]:5174",
	}
	for _, raw := range allowedLocal {
		if _, err := ValidateDiagPublishTarget(raw, false); err != nil {
			t.Errorf("localhost URL %q should be allowed without --publish-live: %v", raw, err)
		}
	}

	blockedRemote := []string{
		"https://test.dialtone.earth",
		"https://dialtone.earth",
		"http://192.168.1.40:5174",
		"https://127.0.0.1.evil.example",
	}
	for _, raw := range blockedRemote {
		if _, err := ValidateDiagPublishTarget(raw, false); err == nil {
			t.Errorf("non-localhost URL %q must be refused without --publish-live", raw)
		}
		if _, err := ValidateDiagPublishTarget(raw, true); err != nil {
			t.Errorf("non-localhost URL %q should be allowed when --publish-live is set: %v", raw, err)
		}
	}
}

func TestDiagLocalPersistAndPublish(t *testing.T) {
	root := t.TempDir()
	var postedBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/diagnostics/runs" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(r.Body)
		postedBody = buf.Bytes()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"loop_id":"loop-abc","url":"/diagnostics"}`))
	}))
	defer srv.Close()

	report := &DiagLoopReport{
		SchemaVersion: 1,
		LoopID:        "loop-abc",
		Source:        "cli",
		RunnerNode:    "rosie",
		Interval:      "10m0s",
		StartedAt:     time.Now().UTC().Format(time.RFC3339Nano),
		EndedAt:       time.Now().UTC().Format(time.RFC3339Nano),
		Status:        DiagStatusPass,
		Summary:       DiagSummary{Total: 1, Passed: 1},
		Checks: []DiagCheckResult{
			{
				CheckID:    "http.dialtone.home",
				TestID:     strings.Repeat("1", 32),
				Category:   "http",
				Title:      "dialtone.earth homepage",
				Status:     DiagStatusPass,
				StartedAt:  time.Now().UTC().Format(time.RFC3339Nano),
				EndedAt:    time.Now().UTC().Format(time.RFC3339Nano),
				DurationMs: 42,
				Summary:    "HTTP 200 OK",
			},
		},
	}

	if err := PersistDiagReportLocally(root, report, 50); err != nil {
		t.Fatal(err)
	}
	if !fileExists(filepath.Join(root, "logs", "diag", "latest.json")) {
		t.Fatal("missing logs/diag/latest.json")
	}
	if !fileExists(filepath.Join(root, "logs", "diag", "runs", "loop-abc.json")) {
		t.Fatal("missing logs/diag/runs/loop-abc.json")
	}
	if !fileExists(filepath.Join(root, "logs", strings.Repeat("1", 32)+".json")) {
		t.Fatal("missing compatible logs/<test-id>.json")
	}
	if !fileExists(filepath.Join(root, "logs", strings.Repeat("1", 32)+".log")) {
		t.Fatal("missing compatible logs/<test-id>.log")
	}

	// Publish to local httptest server succeeds without --publish-live.
	if err := PublishDiagReport(context.Background(), root, report, DiagPublishOptions{
		BaseURL:     srv.URL,
		PublishLive: false,
	}); err != nil {
		t.Fatalf("PublishDiagReport failed: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(postedBody, &payload); err != nil {
		t.Fatalf("posted invalid JSON: %v", err)
	}
	if _, ok := payload["report"]; !ok {
		t.Fatalf("posted payload missing report field: %v", payload)
	}
	if _, ok := payload["logs"]; !ok {
		t.Fatalf("posted payload missing logs field: %v", payload)
	}

	// History cap at 50 entries.
	for i := 0; i < 55; i++ {
		r := *report
		r.LoopID = "loop-hist-" + time.Now().UTC().Format("150405") + "-" + string(rune('a'+(i%26))) + string(rune('0'+(i/26)))
		if err := PersistDiagReportLocally(root, &r, 50); err != nil {
			t.Fatal(err)
		}
	}
	rawHist, err := os.ReadFile(filepath.Join(root, "logs", "diag", "history.json"))
	if err != nil {
		t.Fatal(err)
	}
	var hist []DiagHistoryEntry
	if err := json.Unmarshal(rawHist, &hist); err != nil {
		t.Fatal(err)
	}
	if len(hist) != 50 {
		t.Fatalf("history length = %d, want 50", len(hist))
	}
}

func TestDiagCLIHelpAndNoEmDash(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := Run([]string{"diag", "help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("diag help code = %d, stderr = %s", code, stderr.String())
	}
	out := stdout.String()
	for _, want := range []string{"diag run", "diag watch", "--interval", "--publish-url", "--publish-live"} {
		if !strings.Contains(out, want) {
			t.Errorf("diag help missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "\u2014") {
		t.Fatal("diag help must not contain em-dashes")
	}
}
