package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiagPendingAndInfoStatusAggregationAndTaskSync(t *testing.T) {
	var ranChild bool
	specs := []DiagCheckSpec{
		{
			ID:       "migration.dialtone.v060",
			Category: "migration",
			Title:    "Migration check for dialtone v0.6.0",
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				return DiagCheckOutcome{
					Status:     DiagStatusPending,
					SkipReason: "pending migration: 0/7 nodes on dialtone >= v0.6.0",
					Summary:    "pending migration: 0/7 nodes on dialtone >= v0.6.0",
				}
			},
		},
		{
			ID:        "gb35.api.channels",
			Category:  "gb35",
			Title:     "GET /api/channels",
			DependsOn: []string{"migration.dialtone.v060"},
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				ranChild = true
				return DiagCheckOutcome{Status: DiagStatusPass}
			},
		},
		{
			ID:       "info.sample",
			Category: "versions",
			Title:    "Informational check",
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				return DiagCheckOutcome{Status: DiagStatusInfo, Summary: "note: informational status"}
			},
		},
		{
			ID:       "ok.sample",
			Category: "http",
			Title:    "Passing check",
			Run: func(ctx context.Context, deps map[string]DiagCheckResult) DiagCheckOutcome {
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: "ok"}
			},
		},
	}

	report, err := ExecuteDiagDAG(context.Background(), specs, DiagRunMeta{RunnerNode: "legion"})
	if err != nil {
		t.Fatalf("ExecuteDiagDAG failed: %v", err)
	}
	if ranChild {
		t.Fatal("gb35.api.channels must not run while migration.dialtone.v060 is pending")
	}
	if report.Status != DiagStatusPass {
		t.Fatalf("overall status = %q, want pass (pending/info must never count as failure)", report.Status)
	}
	if report.Summary.Total != 4 || report.Summary.Passed != 1 || report.Summary.Failed != 0 || report.Summary.Skipped != 1 || report.Summary.Pending != 1 || report.Summary.Info != 1 {
		t.Fatalf("unexpected summary: %+v", report.Summary)
	}

	byID := map[string]DiagCheckResult{}
	for _, c := range report.Checks {
		byID[c.CheckID] = c
	}
	if byID["migration.dialtone.v060"].Status != DiagStatusPending {
		t.Fatalf("migration status = %q, want pending", byID["migration.dialtone.v060"].Status)
	}
	if byID["gb35.api.channels"].Status != DiagStatusSkipped {
		t.Fatalf("gb35.api.channels status = %q, want skipped", byID["gb35.api.channels"].Status)
	}
	if !strings.Contains(byID["gb35.api.channels"].SkipReason, "awaits migration") {
		t.Fatalf("gb35.api.channels skip_reason = %q, want 'awaits migration'", byID["gb35.api.channels"].SkipReason)
	}

	// SyncDiagTasks must NOT create or close tasks for pending or info statuses.
	store := &fakeDiagTaskStore{}
	if err := SyncDiagTasks(context.Background(), store, report); err != nil {
		t.Fatalf("SyncDiagTasks failed: %v", err)
	}
	if store.addCalls != 0 || store.updCalls != 0 || store.doneCalls != 0 {
		t.Fatalf("expected 0 task mutations for pass/pending/info/skip, got add=%d upd=%d done=%d", store.addCalls, store.updCalls, store.doneCalls)
	}
}

func TestDiagSemverParsingAndComparison(t *testing.T) {
	cases := []struct {
		raw     string
		min     string
		wantVer string
		wantGE  bool
		wantOK  bool
	}{
		{"dialtone-task 0.4.0\n", "0.4.0", "0.4.0", true, true},
		{"dialtone-agent 0.4.0", "0.5.0", "0.4.0", false, true},
		{"v0.5.6", "0.6.0", "0.5.6", false, true},
		{"0.6.0-rc1", "0.6.0", "0.6.0", true, true},
		{"0.10.2", "0.6.0", "0.10.2", true, true},
		{"not-a-version", "0.4.0", "", false, false},
	}
	for _, tc := range cases {
		ver, ge, ok := semverAtLeast(tc.raw, tc.min)
		if ok != tc.wantOK || ver != tc.wantVer || ge != tc.wantGE {
			t.Errorf("semverAtLeast(%q, %q) = (%q, %v, %v), want (%q, %v, %v)",
				tc.raw, tc.min, ver, ge, ok, tc.wantVer, tc.wantGE, tc.wantOK)
		}
	}
}

func TestDiagCoverageDAGWiringAndDefaultNodes(t *testing.T) {
	// Default fleet nodes must be the 7 active nodes and exclude grok-bot-metal.
	if len(defaultDiagFleetNodes) != 7 {
		t.Fatalf("defaultDiagFleetNodes len = %d (%v), want 7", len(defaultDiagFleetNodes), defaultDiagFleetNodes)
	}
	for _, n := range defaultDiagFleetNodes {
		if n == "grok-bot-metal" {
			t.Fatal("grok-bot-metal must be excluded from defaultDiagFleetNodes")
		}
	}

	specs := BuildDiagnosticDAG(DiagChecksConfig{})
	waves, err := BuildDiagWaves(specs)
	if err != nil {
		t.Fatalf("BuildDiagWaves failed on default DAG: %v", err)
	}
	if len(waves) < 3 {
		t.Fatalf("expected >= 3 topological waves, got %d", len(waves))
	}

	byID := map[string]DiagCheckSpec{}
	for _, s := range specs {
		byID[s.ID] = s
	}

	if _, exists := byID["mesh.node.grok-bot-metal"]; exists {
		t.Fatal("grok-bot-metal must not have a mesh.node check in default DAG")
	}

	requiredIDs := []string{
		"version.task.node.rosie",
		"version.task.node.legion",
		"version.task.node.build-1",
		"version.task.node.vm-us",
		"version.task.node.vm-eu",
		"version.task.node.vm-asia",
		"version.task.node.steamdeck-2",
		"version.agent.node.rosie",
		"version.agent.node.legion",
		"version.agent.node.build-1",
		"migration.dialtone.v060",
		"migration.task.v050",
		"migration.agent.v050",
		"gb34.spec.reject_missing_fields",
		"gb34.logs.chunk",
		"gb34.approve_deny",
		"gb35.api.channels",
		"gb35.api.manifest",
		"gb35.manifest.signature",
		"gb35.plugin.deny_unlisted",
		"gb35.blob.membership",
		"gb35.blob.stream_3mb",
		"gb35.logs.dialtone_log",
		"gb35.task.channel_separation",
		"rpc.try_rpc.db_open_retry",
		"macapp.version.rosie",
	}
	for _, id := range requiredIDs {
		if _, ok := byID[id]; !ok {
			t.Errorf("missing required check ID %q in BuildDiagnosticDAG", id)
		}
	}

	// Verify key dependency edges.
	assertHasDep := func(checkID, wantDep string) {
		t.Helper()
		spec, ok := byID[checkID]
		if !ok {
			return
		}
		for _, d := range spec.DependsOn {
			if d == wantDep {
				return
			}
		}
		t.Errorf("check %q missing depends_on %q (has %v)", checkID, wantDep, spec.DependsOn)
	}
	assertHasDep("version.task.node.rosie", "mesh.node.rosie")
	assertHasDep("version.agent.node.legion", "mesh.node.legion")
	assertHasDep("macapp.version.rosie", "mesh.node.rosie")
	assertHasDep("gb35.api.channels", "migration.dialtone.v060")
	assertHasDep("gb35.task.channel_separation", "migration.task.v050")
}

func TestDiagMigrationGatingPendingAndPass(t *testing.T) {
	oldOutcome := evaluateMigrationCheck("dialtone", "0.6.0", map[string]string{
		"rosie":  "0.5.6",
		"legion": "0.5.6",
	})
	if oldOutcome.Status != DiagStatusPending {
		t.Fatalf("old versions status = %q, want pending (never fail)", oldOutcome.Status)
	}
	if !strings.Contains(strings.ToLower(oldOutcome.Summary), "pending migration") {
		t.Fatalf("old versions summary = %q, want 'pending migration'", oldOutcome.Summary)
	}

	mixedOutcome := evaluateMigrationCheck("dialtone-task", "0.5.0", map[string]string{
		"rosie":  "0.5.0",
		"legion": "0.4.0",
	})
	if mixedOutcome.Status != DiagStatusPending {
		t.Fatalf("mixed versions status = %q, want pending", mixedOutcome.Status)
	}

	upgradedOutcome := evaluateMigrationCheck("dialtone-task", "0.5.0", map[string]string{
		"rosie":  "0.5.0",
		"legion": "0.5.1",
	})
	if upgradedOutcome.Status != DiagStatusPass {
		t.Fatalf("upgraded versions status = %q, want pass", upgradedOutcome.Status)
	}
}

type fakeGB34TaskCLI struct {
	calls        [][]string
	deleted      []string
	nextID       int
	allowBadAdd  bool
	failLogsRead bool
	failApprove  bool
	chunksByID   map[string][]string
}

func (f *fakeGB34TaskCLI) run(ctx context.Context, args ...string) (string, string, int, error) {
	f.calls = append(f.calls, append([]string(nil), args...))
	if len(args) == 0 {
		return "", "no args", 1, errors.New("exit 1")
	}
	if f.chunksByID == nil {
		f.chunksByID = map[string][]string{}
	}
	switch args[0] {
	case "add":
		hasAgent := false
		hasPrompt := false
		for _, a := range args {
			if a == "agent" {
				hasAgent = true
			}
			if a == "--prompt" || a == "--prompt-file" {
				hasPrompt = true
			}
		}
		if hasAgent && !hasPrompt && !f.allowBadAdd {
			return "", "error: agent task missing required field(s): prompt, provider, model, effort", 1, errors.New("exit status 1")
		}
		f.nextID++
		id := "t-dummy-" + string(rune('0'+f.nextID))
		resp := map[string]any{"id": id, "status": "active", "tags": []string{"diagnostic"}}
		raw, _ := json.Marshal(resp)
		return string(raw), "", 0, nil
	case "log":
		id := args[1]
		for i := 0; i < len(args)-1; i++ {
			if args[i] == "--text" {
				f.chunksByID[id] = append(f.chunksByID[id], args[i+1])
			}
		}
		return `{"id":"` + id + `","log_chunks":[{"excerpt":"ok"}]}`, "", 0, nil
	case "logs":
		if f.failLogsRead {
			return "", "simulated read error", 1, errors.New("exit status 1")
		}
		id := args[1]
		text := strings.Join(f.chunksByID[id], "\n") + "\n"
		resp := map[string]any{"task_id": id, "chunks": len(f.chunksByID[id]), "text": text}
		raw, _ := json.Marshal(resp)
		return string(raw), "", 0, nil
	case "deny":
		id := args[1]
		perm := args[2]
		resp := map[string]any{
			"id":     id,
			"status": "paused",
			"permission_approvals": map[string]any{
				perm: map[string]any{"perm": perm, "decision": "denied"},
			},
		}
		raw, _ := json.Marshal(resp)
		return string(raw), "", 0, nil
	case "approve":
		if f.failApprove {
			return "", "simulated approve failure", 1, errors.New("exit status 1")
		}
		id := args[1]
		perm := args[2]
		resp := map[string]any{
			"id":     id,
			"status": "active",
			"permission_approvals": map[string]any{
				perm: map[string]any{"perm": perm, "decision": "approved"},
			},
		}
		raw, _ := json.Marshal(resp)
		return string(raw), "", 0, nil
	case "delete", "done":
		f.deleted = append(f.deleted, args[1])
		return `{"id":"` + args[1] + `","deleted":true}`, "", 0, nil
	default:
		return "", "unknown subcommand", 1, errors.New("exit status 1")
	}
}

func TestDiagGB34ChecksAndCleanupOnFailure(t *testing.T) {
	// 1. gb34.spec.reject_missing_fields passes when rejected.
	cliOK := &fakeGB34TaskCLI{}
	out := runGB34RejectMissingFields(context.Background(), cliOK.run)
	if out.Status != DiagStatusPass {
		t.Fatalf("reject_missing_fields got %+v, want pass", out)
	}
	// Must pass --node diag-nowhere so even unexpected creation cannot dispatch.
	if len(cliOK.calls) == 0 || !strings.Contains(strings.Join(cliOK.calls[0], " "), "--node diag-nowhere") {
		t.Fatalf("reject_missing_fields must include --node diag-nowhere, calls=%v", cliOK.calls)
	}

	// 2. gb34.spec.reject_missing_fields fails AND deletes if unexpectedly accepted.
	cliLeak := &fakeGB34TaskCLI{allowBadAdd: true}
	outLeak := runGB34RejectMissingFields(context.Background(), cliLeak.run)
	if outLeak.Status != DiagStatusFail {
		t.Fatalf("expected fail when bad agent task was accepted, got %+v", outLeak)
	}
	if len(cliLeak.deleted) != 1 {
		t.Fatalf("expected immediate cleanup delete of unexpectedly created task, deleted=%v", cliLeak.deleted)
	}

	// 3. gb34.logs.chunk happy path + cleanup + never tagged "agent".
	cliLogs := &fakeGB34TaskCLI{}
	outLogs := runGB34LogsChunk(context.Background(), cliLogs.run)
	if outLogs.Status != DiagStatusPass {
		t.Fatalf("gb34.logs.chunk got %+v, want pass", outLogs)
	}
	if len(cliLogs.deleted) != 1 {
		t.Fatalf("expected dummy task cleanup, deleted=%v", cliLogs.deleted)
	}
	for _, call := range cliLogs.calls {
		if call[0] == "add" && strings.Contains(strings.Join(call, " "), "--tag agent") {
			t.Fatalf("gb34.logs.chunk dummy task must NEVER be tagged agent: %v", call)
		}
	}

	// 4. gb34.logs.chunk STILL cleans up on read failure.
	cliLogsFail := &fakeGB34TaskCLI{failLogsRead: true}
	outLogsFail := runGB34LogsChunk(context.Background(), cliLogsFail.run)
	if outLogsFail.Status != DiagStatusFail {
		t.Fatalf("expected fail when logs read fails, got %+v", outLogsFail)
	}
	if len(cliLogsFail.deleted) != 1 {
		t.Fatalf("expected dummy task cleanup even on failure, deleted=%v", cliLogsFail.deleted)
	}

	// 5. gb34.approve_deny happy path (2 dummies cleaned up, never tagged agent).
	cliAD := &fakeGB34TaskCLI{}
	outAD := runGB34ApproveDeny(context.Background(), cliAD.run)
	if outAD.Status != DiagStatusPass {
		t.Fatalf("gb34.approve_deny got %+v, want pass", outAD)
	}
	if len(cliAD.deleted) != 2 {
		t.Fatalf("expected 2 dummy tasks cleaned up, deleted=%v", cliAD.deleted)
	}
	for _, call := range cliAD.calls {
		if call[0] == "add" && strings.Contains(strings.Join(call, " "), "--tag agent") {
			t.Fatalf("gb34.approve_deny dummy task must NEVER be tagged agent: %v", call)
		}
	}

	// 6. gb34.approve_deny STILL cleans up both dummies if approve fails.
	cliADFail := &fakeGB34TaskCLI{failApprove: true}
	outADFail := runGB34ApproveDeny(context.Background(), cliADFail.run)
	if outADFail.Status != DiagStatusFail {
		t.Fatalf("expected fail when approve fails, got %+v", outADFail)
	}
	if len(cliADFail.deleted) != 2 {
		t.Fatalf("expected both dummy tasks cleaned up on approve failure, deleted=%v", cliADFail.deleted)
	}
}

func TestDiagGB35FixtureChecks(t *testing.T) {
	// Generate throwaway Ed25519 keypair for fixture channel manifest.
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest := gb35ChannelManifest{
		Channel: "diag-fixture-channel",
		Version: 1,
		Plugins: []gb35ManifestPlugin{
			{Name: "task", SHA256: strings.Repeat("a", 64)},
			{Name: "shell", SHA256: strings.Repeat("b", 64)},
		},
		SignerPubKey: base64.StdEncoding.EncodeToString(pub),
	}
	canonical, err := canonicalGB35ManifestBytes(manifest)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, canonical)
	manifest.Signature = base64.StdEncoding.EncodeToString(sig)

	// 1 & 2. /api/channels and /api/channel/manifest via throwaway httptest server.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/channels":
			_, _ = w.Write([]byte(`{"channels":[{"name":"diag-fixture-channel","active":true}]}`))
		case "/api/channel/manifest":
			_ = json.NewEncoder(w).Encode(manifest)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	chOut := checkGB35APIChannels(context.Background(), srv.Client(), srv.URL)
	if chOut.Status != DiagStatusPass {
		t.Fatalf("gb35.api.channels failed on fixture server: %+v", chOut)
	}
	manOut, fetched := checkGB35APIManifest(context.Background(), srv.Client(), srv.URL)
	if manOut.Status != DiagStatusPass || fetched.Channel != "diag-fixture-channel" {
		t.Fatalf("gb35.api.manifest failed on fixture server: %+v", manOut)
	}

	// 3. Manifest signature verifies (valid passes, tampered fails).
	if err := verifyGB35ManifestSignature(fetched); err != nil {
		t.Fatalf("valid fixture manifest signature failed: %v", err)
	}
	tampered := fetched
	tampered.Channel = "evil-channel"
	if err := verifyGB35ManifestSignature(tampered); err == nil {
		t.Fatal("tampered manifest signature must fail verification")
	}

	// 4. Unlisted plugin is denied (fails closed).
	if err := verifyGB35PluginAllowed(fetched, "task"); err != nil {
		t.Fatalf("listed plugin 'task' should be allowed: %v", err)
	}
	if err := verifyGB35PluginAllowed(fetched, "diag-unlisted-plugin"); err == nil {
		t.Fatal("unlisted plugin must be denied (fail closed)")
	}

	// 5. Blob membership: removed peer loses access.
	mem := newGB35FixtureBlobMembership([]string{"peer-alpha", "peer-beta"})
	if !mem.CanAccess("peer-alpha") || !mem.CanAccess("peer-beta") {
		t.Fatal("both enrolled peers should have initial blob access")
	}
	mem.RemovePeer("peer-beta")
	if mem.CanAccess("peer-beta") {
		t.Fatal("removed peer must lose blob access immediately")
	}
	if !mem.CanAccess("peer-alpha") {
		t.Fatal("remaining peer should retain blob access")
	}

	// 6. Blob share >= 3 MB streams cleanly with exact hash.
	const payloadSize = 3*1024*1024 + 65536
	payload := bytes.Repeat([]byte("dialtone-gb35-stream-chunk-0123456789abcdef\n"), payloadSize/44+1)[:payloadSize]
	wantSum := sha256.Sum256(payload)
	streamedBytes, gotHash, err := streamGB35BlobFixture(bytes.NewReader(payload), 64*1024)
	if err != nil {
		t.Fatalf("streamGB35BlobFixture error: %v", err)
	}
	if streamedBytes < 3*1024*1024 || gotHash != hex.EncodeToString(wantSum[:]) {
		t.Fatalf("stream mismatch: bytes=%d hash=%s want=%s", streamedBytes, gotHash, hex.EncodeToString(wantSum[:]))
	}

	// 7. Channel logs readable with dialtone log.
	logOut := parseGB35DialtoneLogOutput("2026-11-27T12:00:00Z [INFO] channel=diag-fixture-channel peer=legion mesh ready\n")
	if logOut.Status != DiagStatusPass {
		t.Fatalf("parseGB35DialtoneLogOutput failed: %+v", logOut)
	}

	// 8. Task channel separation across two throwaway temp directories.
	sepOut := verifyGB35TaskChannelSeparation(t.TempDir())
	if sepOut.Status != DiagStatusPass {
		t.Fatalf("verifyGB35TaskChannelSeparation failed: %+v", sepOut)
	}
}

func TestDiagTryRPCDbOpenRetryGating(t *testing.T) {
	// On 0.4.0 without feature flag, must skip with "not in a release yet".
	skipOut := runTryRPCDbOpenRetryCheck(context.Background(), "dialtone-task 0.4.0", false, nil)
	if skipOut.Status != DiagStatusSkipped || !strings.Contains(skipOut.SkipReason, "not in a release yet") {
		t.Fatalf("expected skipped 'not in a release yet', got %+v", skipOut)
	}

	// When version >= 0.4.1 (or feature flag set), runs concurrent status calls.
	passRunner := func(ctx context.Context, args ...string) (string, string, int, error) {
		return `{"node":"legion","serve_running":true,"state_hash":"abc"}`, "", 0, nil
	}
	passOut := runTryRPCDbOpenRetryCheck(context.Background(), "dialtone-task 0.5.0", false, passRunner)
	if passOut.Status != DiagStatusPass {
		t.Fatalf("expected pass on 0.5.0, got %+v", passOut)
	}

	failRunner := func(ctx context.Context, args ...string) (string, string, int, error) {
		return "", "error: Database already open. Cannot acquire lock.", 1, errors.New("exit 1")
	}
	failOut := runTryRPCDbOpenRetryCheck(context.Background(), "dialtone-task 0.4.0", true, failRunner)
	if failOut.Status != DiagStatusFail || !strings.Contains(failOut.Error, "Database already open") {
		t.Fatalf("expected fail on 'Database already open' with feature flag, got %+v", failOut)
	}
}

func TestDiagMacAppVersionParser(t *testing.T) {
	plistJSON := `{"CFBundleName":"Dialtone Tasks","CFBundleIdentifier":"earth.dialtone.tasks.mac","CFBundleVersion":"1","CFBundleShortVersionString":"0.1.0"}`
	out := parseMacAppInfoPlistJSON("rosie", "/Users/tim.c/Applications/Dialtone Tasks.app/Contents/Info.plist", plistJSON)
	if out.Status != DiagStatusPass {
		t.Fatalf("expected pass for valid Info.plist JSON, got %+v", out)
	}
	if !strings.Contains(out.Summary, "0.1.0") {
		t.Fatalf("summary %q missing version 0.1.0", out.Summary)
	}

	badOut := parseMacAppInfoPlistJSON("rosie", "/path", `{"CFBundleName":"Dialtone Tasks"}`)
	if badOut.Status != DiagStatusFail {
		t.Fatalf("expected fail when CFBundleShortVersionString is missing, got %+v", badOut)
	}
}

func TestDiagNoEmDashInDiagnosticFiles(t *testing.T) {
	files := []string{
		"diag.go",
		"diag_dag.go",
		"diag_checks.go",
		"diag_coverage.go",
		"diag_tasks.go",
		"diag_publish.go",
		"diag_test.go",
		"diag_coverage_test.go",
		filepath.Join("docs", "diagnostic-loop.md"),
		filepath.Join("registry", "worker", "diagnostics.ts"),
	}
	for _, rel := range files {
		raw, err := os.ReadFile(rel)
		if err != nil {
			t.Errorf("read %s: %v", rel, err)
			continue
		}
		if strings.Contains(string(raw), "\u2014") {
			t.Errorf("file %s contains forbidden em-dash character", rel)
		}
	}
}
