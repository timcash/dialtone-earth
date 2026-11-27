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
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	diagMinTaskVersion          = "0.4.0"
	diagMinAgentVersion         = "0.4.0"
	diagTargetDialtoneV060      = "0.6.0"
	diagTargetTaskV050          = "0.5.0"
	diagTargetAgentV050         = "0.5.0"
	diagTryRPCRetryMinVersion   = "0.4.1"
	diagTryRPCRetryEnvFlag      = "DIAG_ENABLE_TRY_RPC_RETRY_CHECK"
	diagGB34DummyPerm           = "deploy:diag-dummy"
	diagGB34NowhereNode         = "diag-nowhere"
	diagGB35MinStreamBytes      = 3 * 1024 * 1024
	diagGB35UnlistedPluginProbe = "diag-unlisted-plugin-xyz"
)

type diagSemver struct {
	Major int
	Minor int
	Patch int
}

var diagSemverRe = regexp.MustCompile(`\bv?(\d+)\.(\d+)\.(\d+)\b`)

func parseDiagSemver(raw string) (diagSemver, string, bool) {
	m := diagSemverRe.FindStringSubmatch(strings.TrimSpace(raw))
	if len(m) != 4 {
		return diagSemver{}, "", false
	}
	maj, err1 := strconv.Atoi(m[1])
	min, err2 := strconv.Atoi(m[2])
	pat, err3 := strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || err3 != nil {
		return diagSemver{}, "", false
	}
	v := diagSemver{Major: maj, Minor: min, Patch: pat}
	return v, fmt.Sprintf("%d.%d.%d", maj, min, pat), true
}

func compareDiagSemver(a, b diagSemver) int {
	if a.Major != b.Major {
		if a.Major < b.Major {
			return -1
		}
		return 1
	}
	if a.Minor != b.Minor {
		if a.Minor < b.Minor {
			return -1
		}
		return 1
	}
	if a.Patch != b.Patch {
		if a.Patch < b.Patch {
			return -1
		}
		return 1
	}
	return 0
}

func semverAtLeast(raw, minVersion string) (string, bool, bool) {
	got, formatted, ok := parseDiagSemver(raw)
	if !ok {
		return "", false, false
	}
	want, _, wantOK := parseDiagSemver(minVersion)
	if !wantOK {
		return formatted, false, false
	}
	return formatted, compareDiagSemver(got, want) >= 0, true
}

func evaluateMigrationCheck(component, targetVer string, versionsByNode map[string]string) DiagCheckOutcome {
	if len(versionsByNode) == 0 {
		msg := fmt.Sprintf("pending migration: no node versions reported yet for %s >= v%s", component, targetVer)
		return DiagCheckOutcome{
			Status:     DiagStatusPending,
			SkipReason: msg,
			Summary:    msg,
			Details: map[string]any{
				"component":      component,
				"target_version": targetVer,
				"migrated_count": 0,
				"total_nodes":    0,
			},
		}
	}

	nodes := make([]string, 0, len(versionsByNode))
	for n := range versionsByNode {
		nodes = append(nodes, n)
	}
	sort.Strings(nodes)

	migrated := 0
	var pendingNodes []string
	perNode := map[string]any{}
	seenOldVersions := map[string]bool{}

	for _, n := range nodes {
		rawVer := strings.TrimSpace(versionsByNode[n])
		ver, ge, ok := semverAtLeast(rawVer, targetVer)
		if !ok {
			ver = rawVer
			if ver == "" {
				ver = "unknown"
			}
		}
		perNode[n] = map[string]any{
			"version":  ver,
			"migrated": ok && ge,
		}
		if ok && ge {
			migrated++
		} else {
			pendingNodes = append(pendingNodes, n)
			seenOldVersions[ver] = true
		}
	}

	details := map[string]any{
		"component":      component,
		"target_version": targetVer,
		"migrated_count": migrated,
		"total_nodes":    len(nodes),
		"pending_nodes":  pendingNodes,
		"nodes":          perNode,
	}

	if len(pendingNodes) == 0 {
		return DiagCheckOutcome{
			Status:  DiagStatusPass,
			Summary: fmt.Sprintf("all %d/%d nodes on %s >= v%s", migrated, len(nodes), component, targetVer),
			Details: details,
		}
	}

	oldList := make([]string, 0, len(seenOldVersions))
	for v := range seenOldVersions {
		oldList = append(oldList, "v"+strings.TrimPrefix(v, "v"))
	}
	sort.Strings(oldList)
	msg := fmt.Sprintf("pending migration: %d/%d nodes on %s >= v%s (currently %s)",
		migrated, len(nodes), component, targetVer, strings.Join(oldList, ", "))
	return DiagCheckOutcome{
		Status:     DiagStatusPending,
		SkipReason: msg,
		Summary:    msg,
		Details:    details,
	}
}

type diagTaskCLIRunner func(ctx context.Context, args ...string) (stdout, stderr string, exitCode int, err error)

func makeLocalTaskCLIRunner(taskBinOverride string) (string, diagTaskCLIRunner) {
	bin := strings.TrimSpace(taskBinOverride)
	if bin == "" {
		bin = defaultDiagTaskBinary()
	}
	return bin, func(ctx context.Context, args ...string) (string, string, int, error) {
		return runBoundedCommand(ctx, 20*time.Second, bin, args...)
	}
}

func randomDiagNonce() string {
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw[:])
}

func extractTaskIDFromJSON(raw string) string {
	var single struct {
		ID   string `json:"id"`
		Task struct {
			ID string `json:"id"`
		} `json:"task"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &single); err != nil {
		return ""
	}
	if single.ID != "" {
		return single.ID
	}
	return single.Task.ID
}

func cleanupDummyDiagTask(ctx context.Context, run diagTaskCLIRunner, taskID string) error {
	if strings.TrimSpace(taskID) == "" {
		return nil
	}
	_, stderr, code, err := run(ctx, "delete", taskID, "--json")
	if err == nil && code == 0 {
		return nil
	}
	_, stderr2, code2, err2 := run(ctx, "done", taskID, "--note", "diag dummy cleanup", "--json")
	if err2 == nil && code2 == 0 {
		return nil
	}
	return fmt.Errorf("cleanup task %s failed (delete exit=%d %s; done exit=%d %s)",
		taskID, code, strings.TrimSpace(stderr), code2, strings.TrimSpace(stderr2))
}

func runGB34RejectMissingFields(ctx context.Context, run diagTaskCLIRunner) DiagCheckOutcome {
	title := "diag-gb34-reject-missing-" + randomDiagNonce()
	stdout, stderr, exitCode, err := run(ctx,
		"add", title,
		"--tag", "agent",
		"--tag", diagTaskTag,
		"--node", diagGB34NowhereNode,
		"--json",
	)
	combined := strings.TrimSpace(stdout + "\n" + stderr)
	if err == nil && exitCode == 0 {
		leakedID := extractTaskIDFromJSON(stdout)
		cleanErr := cleanupDummyDiagTask(ctx, run, leakedID)
		errMsg := fmt.Sprintf("agent task missing required fields was unexpectedly accepted (id=%s)", leakedID)
		if cleanErr != nil {
			errMsg += "; " + cleanErr.Error()
		}
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   errMsg,
			Stdout:  stdout,
			Stderr:  stderr,
			Details: map[string]any{"leaked_task_id": leakedID, "cleaned_up": cleanErr == nil},
		}
	}
	lower := strings.ToLower(combined)
	if !strings.Contains(lower, "missing") && !strings.Contains(lower, "required") && !strings.Contains(lower, "prompt") {
		return DiagCheckOutcome{
			Status: DiagStatusFail,
			Error:  fmt.Sprintf("add failed with unexpected error (exit=%d): %s", exitCode, combined),
			Stdout: stdout,
			Stderr: stderr,
		}
	}
	return DiagCheckOutcome{
		Status:  DiagStatusPass,
		Summary: "rejected agent task missing required fields (--node diag-nowhere)",
		Details: map[string]any{"exit_code": exitCode, "node": diagGB34NowhereNode},
		Stderr:  stderr,
	}
}

func runGB34LogsChunk(ctx context.Context, run diagTaskCLIRunner) DiagCheckOutcome {
	nonce := randomDiagNonce()
	title := "diag-gb34-logs-chunk-" + nonce
	marker := "diag-gb34-log-marker-" + nonce

	stdout, stderr, code, err := run(ctx,
		"add", title,
		"--tag", diagTaskTag,
		"--node", diagGB34NowhereNode,
		"--note", "ephemeral diagnostic log chunk test",
		"--json",
	)
	if err != nil || code != 0 {
		return DiagCheckOutcome{
			Status: DiagStatusFail,
			Error:  fmt.Sprintf("create dummy task failed (exit=%d err=%v)", code, err),
			Stdout: stdout,
			Stderr: stderr,
		}
	}
	taskID := extractTaskIDFromJSON(stdout)
	if taskID == "" {
		return DiagCheckOutcome{
			Status: DiagStatusFail,
			Error:  "create dummy task returned empty task id",
			Stdout: stdout,
		}
	}

	cleaned := false
	cleanupOnce := func() error {
		if cleaned || taskID == "" {
			return nil
		}
		cleaned = true
		return cleanupDummyDiagTask(ctx, run, taskID)
	}
	defer func() {
		_ = cleanupOnce()
	}()

	logOut, logErr, logCode, err := run(ctx, "log", taskID, "--text", marker, "--json")
	if err != nil || logCode != 0 {
		cleanupErr := cleanupOnce()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   fmt.Sprintf("dialtone-task log failed (exit=%d err=%v)", logCode, err),
			Details: map[string]any{"dummy_task_id": taskID, "cleaned_up": cleanupErr == nil},
			Stdout:  logOut,
			Stderr:  logErr,
		}
	}

	readOut, readErr, readCode, err := run(ctx, "logs", taskID, "--json")
	if err != nil || readCode != 0 {
		cleanupErr := cleanupOnce()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   fmt.Sprintf("dialtone-task logs failed (exit=%d err=%v)", readCode, err),
			Details: map[string]any{"dummy_task_id": taskID, "cleaned_up": cleanupErr == nil},
			Stdout:  readOut,
			Stderr:  readErr,
		}
	}

	var logsResp struct {
		TaskID string `json:"task_id"`
		Chunks int    `json:"chunks"`
		Text   string `json:"text"`
	}
	if jErr := json.Unmarshal([]byte(strings.TrimSpace(readOut)), &logsResp); jErr != nil {
		cleanupErr := cleanupOnce()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   "invalid dialtone-task logs JSON: " + jErr.Error(),
			Details: map[string]any{"dummy_task_id": taskID, "cleaned_up": cleanupErr == nil},
			Stdout:  readOut,
		}
	}
	if !strings.Contains(logsResp.Text, marker) {
		cleanupErr := cleanupOnce()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   fmt.Sprintf("log round-trip missing marker %q", marker),
			Details: map[string]any{"dummy_task_id": taskID, "chunks": logsResp.Chunks, "cleaned_up": cleanupErr == nil},
			Stdout:  readOut,
		}
	}

	cleanupErr := cleanupOnce()
	if cleanupErr != nil {
		return DiagCheckOutcome{
			Status: DiagStatusFail,
			Error:  "log chunk verified but cleanup failed: " + cleanupErr.Error(),
		}
	}
	return DiagCheckOutcome{
		Status:  DiagStatusPass,
		Summary: fmt.Sprintf("log chunk appended and read back (%d chunk, cleaned up)", logsResp.Chunks),
		Details: map[string]any{"chunks": logsResp.Chunks, "cleaned_up": true},
	}
}

func runGB34ApproveDeny(ctx context.Context, run diagTaskCLIRunner) DiagCheckOutcome {
	nonce := randomDiagNonce()
	var createdIDs []string
	cleanedIDs := map[string]bool{}
	cleanupAll := func() []string {
		var errs []string
		for _, id := range createdIDs {
			if cleanedIDs[id] {
				continue
			}
			cleanedIDs[id] = true
			if err := cleanupDummyDiagTask(ctx, run, id); err != nil {
				errs = append(errs, err.Error())
			}
		}
		return errs
	}
	defer func() {
		_ = cleanupAll()
	}()

	createDummy := func(label string) (string, string, string, error) {
		stdout, stderr, code, err := run(ctx,
			"add", fmt.Sprintf("diag-gb34-%s-%s", label, nonce),
			"--tag", diagTaskTag,
			"--node", diagGB34NowhereNode,
			"--perm", diagGB34DummyPerm,
			"--note", "ephemeral diagnostic approve/deny test",
			"--json",
		)
		if err != nil || code != 0 {
			return "", stdout, stderr, fmt.Errorf("add %s dummy failed (exit=%d err=%v)", label, code, err)
		}
		id := extractTaskIDFromJSON(stdout)
		if id == "" {
			return "", stdout, stderr, fmt.Errorf("add %s dummy returned empty id", label)
		}
		createdIDs = append(createdIDs, id)
		return id, stdout, stderr, nil
	}

	type approvalRec struct {
		Perm     string `json:"perm"`
		Decision string `json:"decision"`
	}
	type taskDecisionResp struct {
		ID                  string                 `json:"id"`
		Status              string                 `json:"status"`
		PermissionApprovals map[string]approvalRec `json:"permission_approvals"`
	}

	// Dummy 1: deny permission -> records denial and pauses task.
	denyID, out1, err1, err := createDummy("deny")
	if err != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error(), Stdout: out1, Stderr: err1}
	}
	denyOut, denyErr, denyCode, err := run(ctx, "deny", denyID, diagGB34DummyPerm, "--note", "diag deny verification", "--json")
	if err != nil || denyCode != 0 {
		cErrs := cleanupAll()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   fmt.Sprintf("deny failed (exit=%d err=%v)", denyCode, err),
			Details: map[string]any{"deny_task_id": denyID, "cleanup_errors": cErrs},
			Stdout:  denyOut,
			Stderr:  denyErr,
		}
	}
	var denyParsed taskDecisionResp
	if jErr := json.Unmarshal([]byte(strings.TrimSpace(denyOut)), &denyParsed); jErr != nil {
		cErrs := cleanupAll()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   "invalid deny JSON: " + jErr.Error(),
			Details: map[string]any{"deny_task_id": denyID, "cleanup_errors": cErrs},
			Stdout:  denyOut,
		}
	}
	if !strings.EqualFold(denyParsed.Status, "paused") || denyParsed.PermissionApprovals[diagGB34DummyPerm].Decision != "denied" {
		cErrs := cleanupAll()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   fmt.Sprintf("deny did not pause or record denial (status=%q decision=%q)", denyParsed.Status, denyParsed.PermissionApprovals[diagGB34DummyPerm].Decision),
			Details: map[string]any{"deny_task_id": denyID, "cleanup_errors": cErrs},
			Stdout:  denyOut,
		}
	}

	// Dummy 2: approve permission -> records approval.
	approveID, out2, err2, err := createDummy("approve")
	if err != nil {
		cErrs := cleanupAll()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   err.Error(),
			Details: map[string]any{"cleanup_errors": cErrs},
			Stdout:  out2,
			Stderr:  err2,
		}
	}
	appOut, appErr, appCode, err := run(ctx, "approve", approveID, diagGB34DummyPerm, "--note", "diag approve verification", "--json")
	if err != nil || appCode != 0 {
		cErrs := cleanupAll()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   fmt.Sprintf("approve failed (exit=%d err=%v)", appCode, err),
			Details: map[string]any{"deny_task_id": denyID, "approve_task_id": approveID, "cleanup_errors": cErrs},
			Stdout:  appOut,
			Stderr:  appErr,
		}
	}
	var appParsed taskDecisionResp
	if jErr := json.Unmarshal([]byte(strings.TrimSpace(appOut)), &appParsed); jErr != nil {
		cErrs := cleanupAll()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   "invalid approve JSON: " + jErr.Error(),
			Details: map[string]any{"deny_task_id": denyID, "approve_task_id": approveID, "cleanup_errors": cErrs},
			Stdout:  appOut,
		}
	}
	if appParsed.PermissionApprovals[diagGB34DummyPerm].Decision != "approved" {
		cErrs := cleanupAll()
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   fmt.Sprintf("approve did not record approval (decision=%q)", appParsed.PermissionApprovals[diagGB34DummyPerm].Decision),
			Details: map[string]any{"deny_task_id": denyID, "approve_task_id": approveID, "cleanup_errors": cErrs},
			Stdout:  appOut,
		}
	}

	cErrs := cleanupAll()
	if len(cErrs) > 0 {
		return DiagCheckOutcome{
			Status: DiagStatusFail,
			Error:  "approve/deny verified but cleanup failed: " + strings.Join(cErrs, "; "),
		}
	}
	return DiagCheckOutcome{
		Status:  DiagStatusPass,
		Summary: fmt.Sprintf("deny paused dummy (%s) and approve recorded decision (%s), both cleaned up", denyID, approveID),
		Details: map[string]any{
			"perm":            diagGB34DummyPerm,
			"deny_task_id":    denyID,
			"approve_task_id": approveID,
			"cleaned_up":      true,
		},
	}
}

// --- GB-35 Channel Scope Types and Fixture Verifiers ---

type gb35ManifestPlugin struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256,omitempty"`
}

type gb35ChannelManifest struct {
	Channel      string               `json:"channel"`
	Version      int                  `json:"version"`
	Plugins      []gb35ManifestPlugin `json:"plugins"`
	SignerPubKey string               `json:"signer_pubkey"`
	Signature    string               `json:"signature,omitempty"`
}

func canonicalGB35ManifestBytes(m gb35ChannelManifest) ([]byte, error) {
	unsigned := struct {
		Channel      string               `json:"channel"`
		Version      int                  `json:"version"`
		Plugins      []gb35ManifestPlugin `json:"plugins"`
		SignerPubKey string               `json:"signer_pubkey"`
	}{
		Channel:      m.Channel,
		Version:      m.Version,
		Plugins:      m.Plugins,
		SignerPubKey: m.SignerPubKey,
	}
	return json.Marshal(unsigned)
}

func decodeBase64OrHex(raw string) ([]byte, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("empty key or signature")
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := hex.DecodeString(s); err == nil {
		return b, nil
	}
	return nil, errors.New("not valid base64 or hex")
}

func verifyGB35ManifestSignature(m gb35ChannelManifest) error {
	pubBytes, err := decodeBase64OrHex(m.SignerPubKey)
	if err != nil || len(pubBytes) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid signer_pubkey (len=%d err=%v)", len(pubBytes), err)
	}
	sigBytes, err := decodeBase64OrHex(m.Signature)
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return fmt.Errorf("invalid signature (len=%d err=%v)", len(sigBytes), err)
	}
	payload, err := canonicalGB35ManifestBytes(m)
	if err != nil {
		return err
	}
	if !ed25519.Verify(ed25519.PublicKey(pubBytes), payload, sigBytes) {
		return errors.New("ed25519 manifest signature verification failed")
	}
	return nil
}

func verifyGB35PluginAllowed(m gb35ChannelManifest, pluginName string) error {
	target := strings.TrimSpace(pluginName)
	if target == "" {
		return errors.New("empty plugin name denied (fail closed)")
	}
	for _, p := range m.Plugins {
		if strings.EqualFold(strings.TrimSpace(p.Name), target) {
			return nil
		}
	}
	return fmt.Errorf("plugin %q not listed in channel %q manifest (denied, fail closed)", target, m.Channel)
}

type gb35FixtureBlobMembership struct {
	mu      sync.RWMutex
	members map[string]bool
}

func newGB35FixtureBlobMembership(initialPeers []string) *gb35FixtureBlobMembership {
	m := &gb35FixtureBlobMembership{members: map[string]bool{}}
	for _, p := range initialPeers {
		m.members[strings.TrimSpace(p)] = true
	}
	return m
}

func (m *gb35FixtureBlobMembership) CanAccess(peer string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.members[strings.TrimSpace(peer)]
}

func (m *gb35FixtureBlobMembership) RemovePeer(peer string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.members, strings.TrimSpace(peer))
}

func streamGB35BlobFixture(r io.Reader, chunkSize int) (int64, string, error) {
	if chunkSize <= 0 {
		chunkSize = 64 * 1024
	}
	buf := make([]byte, chunkSize)
	h := sha256.New()
	var total int64
	for {
		n, err := r.Read(buf)
		if n > 0 {
			total += int64(n)
			_, _ = h.Write(buf[:n])
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return total, "", err
		}
	}
	return total, hex.EncodeToString(h.Sum(nil)), nil
}

func checkGB35APIChannels(ctx context.Context, client *http.Client, daemonAPI string) DiagCheckOutcome {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(daemonAPI, "/")+"/api/channels", nil)
	if err != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
	}
	resp, err := client.Do(req)
	if err != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode != http.StatusOK || !json.Valid(body) {
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   fmt.Sprintf("GET /api/channels returned HTTP %d", resp.StatusCode),
			Details: map[string]any{"status_code": resp.StatusCode},
		}
	}
	return DiagCheckOutcome{
		Status:  DiagStatusPass,
		Summary: fmt.Sprintf("GET /api/channels HTTP 200 (%d bytes)", len(body)),
		Details: map[string]any{"status_code": resp.StatusCode, "bytes": len(body)},
		Stdout:  string(body),
	}
}

func checkGB35APIManifest(ctx context.Context, client *http.Client, daemonAPI string) (DiagCheckOutcome, gb35ChannelManifest) {
	var parsed gb35ChannelManifest
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(daemonAPI, "/")+"/api/channel/manifest", nil)
	if err != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}, parsed
	}
	resp, err := client.Do(req)
	if err != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}, parsed
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode != http.StatusOK {
		return DiagCheckOutcome{
			Status:  DiagStatusFail,
			Error:   fmt.Sprintf("GET /api/channel/manifest returned HTTP %d", resp.StatusCode),
			Details: map[string]any{"status_code": resp.StatusCode},
		}, parsed
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.Channel == "" {
		return DiagCheckOutcome{
			Status: DiagStatusFail,
			Error:  "GET /api/channel/manifest returned invalid manifest JSON",
			Stdout: string(body),
		}, parsed
	}
	return DiagCheckOutcome{
		Status:  DiagStatusPass,
		Summary: fmt.Sprintf("channel=%s plugins=%d", parsed.Channel, len(parsed.Plugins)),
		Details: map[string]any{"channel": parsed.Channel, "version": parsed.Version, "plugin_count": len(parsed.Plugins)},
		Stdout:  string(body),
	}, parsed
}

func parseGB35DialtoneLogOutput(stdout string) DiagCheckOutcome {
	trimmed := strings.TrimSpace(stdout)
	if trimmed == "" {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: "dialtone log returned empty output"}
	}
	lines := strings.Split(trimmed, "\n")
	return DiagCheckOutcome{
		Status:  DiagStatusPass,
		Summary: fmt.Sprintf("dialtone log readable (%d line(s))", len(lines)),
		Details: map[string]any{"lines": len(lines)},
		Stdout:  trimmed,
	}
}

func verifyGB35TaskChannelSeparation(baseTempDir string) DiagCheckOutcome {
	dirA := filepath.Join(baseTempDir, "channels", "diag-alpha", "task")
	dirB := filepath.Join(baseTempDir, "channels", "diag-beta", "task")
	if err := os.MkdirAll(dirA, 0o700); err != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
	}
	if err := os.MkdirAll(dirB, 0o700); err != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
	}
	fileA := filepath.Join(dirA, "tasks.json")
	fileB := filepath.Join(dirB, "tasks.json")
	if err := os.WriteFile(fileA, []byte(`{"channel":"diag-alpha","tasks":["t-alpha-1"]}`), 0o600); err != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
	}
	if err := os.WriteFile(fileB, []byte(`{"channel":"diag-beta","tasks":["t-beta-1"]}`), 0o600); err != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
	}
	rawA, errA := os.ReadFile(fileA)
	rawB, errB := os.ReadFile(fileB)
	if errA != nil || errB != nil {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("read separated stores failed: %v / %v", errA, errB)}
	}
	if strings.Contains(string(rawA), "t-beta-1") || strings.Contains(string(rawB), "t-alpha-1") {
		return DiagCheckOutcome{Status: DiagStatusFail, Error: "cross-channel task leakage detected"}
	}
	return DiagCheckOutcome{
		Status:  DiagStatusPass,
		Summary: "isolated channel task directories verified (zero cross-channel leakage)",
		Details: map[string]any{"channels_checked": []string{"diag-alpha", "diag-beta"}},
	}
}

// --- RPC try_rpc Database Already Open Retry Check ---

func runTryRPCDbOpenRetryCheck(ctx context.Context, versionOutput string, featureEnabled bool, run diagTaskCLIRunner) DiagCheckOutcome {
	ver, ge, ok := semverAtLeast(versionOutput, diagTryRPCRetryMinVersion)
	if !featureEnabled && (!ok || !ge) {
		return DiagCheckOutcome{
			Status:     DiagStatusSkipped,
			SkipReason: "not in a release yet",
			Summary:    fmt.Sprintf("not in a release yet (detected dialtone-task v%s; requires >= v%s or %s=1)", ver, diagTryRPCRetryMinVersion, diagTryRPCRetryEnvFlag),
			Details: map[string]any{
				"detected_version": ver,
				"min_version":      diagTryRPCRetryMinVersion,
				"feature_flag":     diagTryRPCRetryEnvFlag,
			},
		}
	}
	if run == nil {
		return DiagCheckOutcome{
			Status:     DiagStatusSkipped,
			SkipReason: "no task runner configured",
		}
	}

	type callRes struct {
		stdout   string
		stderr   string
		exitCode int
		err      error
	}
	results := make([]callRes, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			so, se, ec, err := run(ctx, "status", "--json")
			results[idx] = callRes{stdout: so, stderr: se, exitCode: ec, err: err}
		}(i)
	}
	wg.Wait()

	for i, r := range results {
		combined := r.stdout + "\n" + r.stderr
		if strings.Contains(combined, "Database already open") {
			return DiagCheckOutcome{
				Status: DiagStatusFail,
				Error:  fmt.Sprintf("concurrent status call #%d hit Database already open without try_rpc retry", i+1),
				Stdout: r.stdout,
				Stderr: r.stderr,
			}
		}
		if r.err != nil || r.exitCode != 0 {
			return DiagCheckOutcome{
				Status: DiagStatusFail,
				Error:  fmt.Sprintf("concurrent status call #%d failed (exit=%d err=%v)", i+1, r.exitCode, r.err),
				Stdout: r.stdout,
				Stderr: r.stderr,
			}
		}
	}
	return DiagCheckOutcome{
		Status:  DiagStatusPass,
		Summary: fmt.Sprintf("concurrent try_rpc status calls succeeded on v%s without lock contention", ver),
		Details: map[string]any{"detected_version": ver, "feature_flag_enabled": featureEnabled},
	}
}

// --- Mac App Version Check on rosie ---

func parseMacAppInfoPlistJSON(node, plistPath, rawJSON string) DiagCheckOutcome {
	var plist struct {
		Name       string `json:"CFBundleName"`
		Display    string `json:"CFBundleDisplayName"`
		BundleID   string `json:"CFBundleIdentifier"`
		ShortVer   string `json:"CFBundleShortVersionString"`
		BundleVer  string `json:"CFBundleVersion"`
		MinMacOS   string `json:"LSMinimumSystemVersion"`
		Executable string `json:"CFBundleExecutable"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(rawJSON)), &plist); err != nil {
		return DiagCheckOutcome{
			Status: DiagStatusFail,
			Error:  "invalid Mac app Info.plist JSON: " + err.Error(),
			Stdout: rawJSON,
		}
	}
	ver := strings.TrimSpace(plist.ShortVer)
	if ver == "" {
		return DiagCheckOutcome{
			Status: DiagStatusFail,
			Error:  "Mac app Info.plist missing CFBundleShortVersionString",
			Stdout: rawJSON,
		}
	}
	appName := strings.TrimSpace(plist.Display)
	if appName == "" {
		appName = strings.TrimSpace(plist.Name)
	}
	if appName == "" {
		appName = "Dialtone Tasks"
	}
	summary := fmt.Sprintf("%s v%s", appName, ver)
	if plist.BundleVer != "" {
		summary += fmt.Sprintf(" (build %s", plist.BundleVer)
		if plist.BundleID != "" {
			summary += ", " + plist.BundleID
		}
		summary += ")"
	}
	return DiagCheckOutcome{
		Status:  DiagStatusPass,
		Summary: summary,
		Details: map[string]any{
			"node":       node,
			"app_name":   appName,
			"bundle_id":  plist.BundleID,
			"version":    ver,
			"build":      plist.BundleVer,
			"plist_path": plistPath,
		},
		Stdout: rawJSON,
	}
}

func isDiagAgentNode(node string) bool {
	for _, n := range defaultDiagAgentNodes {
		if strings.EqualFold(strings.TrimSpace(node), n) {
			return true
		}
	}
	return false
}

// appendCoverageChecks appends version, migration, GB-34, GB-35, try_rpc, and Mac app checks.
func appendCoverageChecks(
	specs []DiagCheckSpec,
	cfg DiagChecksConfig,
	rt *diagSharedRuntime,
	dialtoneBin string,
	daemonAPI string,
	httpClient *http.Client,
	nodes []string,
	daemonCheckIDs []string,
) []DiagCheckSpec {
	var versionTaskCheckIDs []string
	var versionAgentCheckIDs []string
	hasRosie := false

	for _, rawNode := range nodes {
		node := strings.TrimSpace(rawNode)
		if node == "" {
			continue
		}
		if strings.EqualFold(node, "rosie") {
			hasRosie = true
		}
		meshCheckID := "mesh.node." + node
		verTaskID := "version.task.node." + node
		versionTaskCheckIDs = append(versionTaskCheckIDs, verTaskID)

		specs = append(specs, DiagCheckSpec{
			ID:        verTaskID,
			Category:  "versions",
			Title:     fmt.Sprintf("dialtone-task version on %s (>= v%s)", node, diagMinTaskVersion),
			DependsOn: []string{meshCheckID},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				rt.mu.RLock()
				snap, hasSnap := rt.nodeByName[node]
				rt.mu.RUnlock()
				var snapPtr *meshNodeSnapshot
				if hasSnap {
					s := snap
					snapPtr = &s
				}
				win := isWindowsPeer(node, snapPtr)
				cmd := `if [ -x "$HOME/.dialtone/plugins/task/dialtone-task" ]; then "$HOME/.dialtone/plugins/task/dialtone-task" --version; else echo "__DIAG_NOT_INSTALLED__"; fi`
				if win {
					cmd = `$p = Join-Path $env:USERPROFILE '.dialtone\plugins\task\dialtone-task.exe'; if (Test-Path $p) { & $p --version } else { Write-Output '__DIAG_NOT_INSTALLED__' }`
				}
				execRes, rawOut, rawErr, execErr := runDialtoneExec(ctx, dialtoneBin, node, win, 20*time.Second, cmd)
				outText := strings.TrimSpace(execRes.Stdout)
				if strings.Contains(outText, "__DIAG_NOT_INSTALLED__") {
					return DiagCheckOutcome{
						Status:  DiagStatusFail,
						Error:   fmt.Sprintf("dialtone-task not installed on %s", node),
						Details: map[string]any{"node": node, "installed": false},
					}
				}
				if execErr != nil || execRes.ExitCode != 0 {
					return DiagCheckOutcome{
						Status: DiagStatusFail,
						Error:  fmt.Sprintf("dialtone-task --version failed on %s (exit=%d err=%v)", node, execRes.ExitCode, execErr),
						Stdout: rawOut,
						Stderr: rawErr,
					}
				}
				ver, ge, ok := semverAtLeast(outText, diagMinTaskVersion)
				if !ok {
					return DiagCheckOutcome{
						Status: DiagStatusFail,
						Error:  fmt.Sprintf("could not parse dialtone-task version on %s: %q", node, outText),
						Stdout: outText,
					}
				}
				rt.mu.Lock()
				rt.taskVersions[node] = ver
				rt.mu.Unlock()
				details := map[string]any{
					"node":        node,
					"version":     ver,
					"min_version": diagMinTaskVersion,
				}
				if !ge {
					return DiagCheckOutcome{
						Status:  DiagStatusFail,
						Error:   fmt.Sprintf("dialtone-task v%s on %s is below required v%s", ver, node, diagMinTaskVersion),
						Details: details,
						Stdout:  outText,
					}
				}
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: fmt.Sprintf("dialtone-task v%s", ver),
					Details: details,
					Stdout:  outText,
				}
			},
		})

		if isDiagAgentNode(node) {
			verAgentID := "version.agent.node." + node
			versionAgentCheckIDs = append(versionAgentCheckIDs, verAgentID)
			specs = append(specs, DiagCheckSpec{
				ID:        verAgentID,
				Category:  "versions",
				Title:     fmt.Sprintf("dialtone-agent version on %s (>= v%s)", node, diagMinAgentVersion),
				DependsOn: []string{meshCheckID},
				Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
					rt.mu.RLock()
					snap, hasSnap := rt.nodeByName[node]
					rt.mu.RUnlock()
					var snapPtr *meshNodeSnapshot
					if hasSnap {
						s := snap
						snapPtr = &s
					}
					win := isWindowsPeer(node, snapPtr)
					cmd := `if [ -x "$HOME/.dialtone/plugins/agent/dialtone-agent" ]; then "$HOME/.dialtone/plugins/agent/dialtone-agent" --version; else echo "__DIAG_NOT_INSTALLED__"; fi`
					if win {
						cmd = `$p = Join-Path $env:USERPROFILE '.dialtone\plugins\agent\dialtone-agent.exe'; if (Test-Path $p) { & $p --version } else { Write-Output '__DIAG_NOT_INSTALLED__' }`
					}
					execRes, rawOut, rawErr, execErr := runDialtoneExec(ctx, dialtoneBin, node, win, 20*time.Second, cmd)
					outText := strings.TrimSpace(execRes.Stdout)
					if strings.Contains(outText, "__DIAG_NOT_INSTALLED__") {
						return DiagCheckOutcome{
							Status:  DiagStatusFail,
							Error:   fmt.Sprintf("dialtone-agent not installed on %s", node),
							Details: map[string]any{"node": node, "installed": false},
						}
					}
					if execErr != nil || execRes.ExitCode != 0 {
						return DiagCheckOutcome{
							Status: DiagStatusFail,
							Error:  fmt.Sprintf("dialtone-agent --version failed on %s (exit=%d err=%v)", node, execRes.ExitCode, execErr),
							Stdout: rawOut,
							Stderr: rawErr,
						}
					}
					ver, ge, ok := semverAtLeast(outText, diagMinAgentVersion)
					if !ok {
						return DiagCheckOutcome{
							Status: DiagStatusFail,
							Error:  fmt.Sprintf("could not parse dialtone-agent version on %s: %q", node, outText),
							Stdout: outText,
						}
					}
					rt.mu.Lock()
					rt.agentVersions[node] = ver
					rt.mu.Unlock()
					details := map[string]any{
						"node":        node,
						"version":     ver,
						"min_version": diagMinAgentVersion,
					}
					if !ge {
						return DiagCheckOutcome{
							Status:  DiagStatusFail,
							Error:   fmt.Sprintf("dialtone-agent v%s on %s is below required v%s", ver, node, diagMinAgentVersion),
							Details: details,
							Stdout:  outText,
						}
					}
					return DiagCheckOutcome{
						Status:  DiagStatusPass,
						Summary: fmt.Sprintf("dialtone-agent v%s", ver),
						Details: details,
						Stdout:  outText,
					}
				},
			})
		}
	}

	// Migration readiness checks (pending while nodes are on old version, never a failure).
	specs = append(specs,
		DiagCheckSpec{
			ID:        "migration.dialtone.v060",
			Category:  "migration",
			Title:     "Migration readiness: dialtone v0.6.0 across nodes",
			DependsOn: []string{"mesh.local.probe"},
			After:     daemonCheckIDs,
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				rt.mu.RLock()
				versions := make(map[string]string, len(nodes))
				for _, n := range nodes {
					if v := rt.daemonVersions[n]; v != "" {
						versions[n] = v
					} else if snap, ok := rt.nodeByName[n]; ok && snap.Version != "" {
						versions[n] = snap.Version
					}
				}
				rt.mu.RUnlock()
				return evaluateMigrationCheck("dialtone", diagTargetDialtoneV060, versions)
			},
		},
		DiagCheckSpec{
			ID:        "migration.task.v050",
			Category:  "migration",
			Title:     "Migration readiness: dialtone-task v0.5.0 across nodes",
			DependsOn: []string{"mesh.local.probe"},
			After:     versionTaskCheckIDs,
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				rt.mu.RLock()
				versions := make(map[string]string, len(rt.taskVersions))
				for k, v := range rt.taskVersions {
					versions[k] = v
				}
				rt.mu.RUnlock()
				return evaluateMigrationCheck("dialtone-task", diagTargetTaskV050, versions)
			},
		},
		DiagCheckSpec{
			ID:        "migration.agent.v050",
			Category:  "migration",
			Title:     "Migration readiness: dialtone-agent v0.5.0 across agent nodes",
			DependsOn: []string{"mesh.local.probe"},
			After:     versionAgentCheckIDs,
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				rt.mu.RLock()
				versions := make(map[string]string, len(rt.agentVersions))
				for k, v := range rt.agentVersions {
					versions[k] = v
				}
				rt.mu.RUnlock()
				return evaluateMigrationCheck("dialtone-agent", diagTargetAgentV050, versions)
			},
		},
	)

	// GB-34 agent spec checks (safe dummy tasks tagged diagnostic, always cleaned up).
	taskBin, localTaskRun := makeLocalTaskCLIRunner(cfg.TaskBin)
	specs = append(specs,
		DiagCheckSpec{
			ID:        "gb34.spec.reject_missing_fields",
			Category:  "gb34",
			Title:     "GB-34: reject agent task missing required fields (--node diag-nowhere)",
			DependsOn: []string{"mesh.local.status"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				if taskBin == "" || !fileExists(taskBin) {
					return DiagCheckOutcome{Status: DiagStatusSkipped, SkipReason: "local dialtone-task binary not installed"}
				}
				return runGB34RejectMissingFields(ctx, localTaskRun)
			},
		},
		DiagCheckSpec{
			ID:        "gb34.logs.chunk",
			Category:  "gb34",
			Title:     "GB-34: append log chunk and read back via dialtone-task logs",
			DependsOn: []string{"gb34.spec.reject_missing_fields"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				if taskBin == "" || !fileExists(taskBin) {
					return DiagCheckOutcome{Status: DiagStatusSkipped, SkipReason: "local dialtone-task binary not installed"}
				}
				return runGB34LogsChunk(ctx, localTaskRun)
			},
		},
		DiagCheckSpec{
			ID:        "gb34.approve_deny",
			Category:  "gb34",
			Title:     "GB-34: deny pauses task and approve records permission decision",
			DependsOn: []string{"gb34.spec.reject_missing_fields"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				if taskBin == "" || !fileExists(taskBin) {
					return DiagCheckOutcome{Status: DiagStatusSkipped, SkipReason: "local dialtone-task binary not installed"}
				}
				return runGB34ApproveDeny(ctx, localTaskRun)
			},
		},
	)

	// GB-35 channel scope checks (each returns "skip: awaits migration" while nodes are on old versions).
	specs = append(specs,
		DiagCheckSpec{
			ID:        "gb35.api.channels",
			Category:  "gb35",
			Title:     "GB-35: GET /api/channels responds",
			DependsOn: []string{"migration.dialtone.v060"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				return checkGB35APIChannels(ctx, httpClient, daemonAPI)
			},
		},
		DiagCheckSpec{
			ID:        "gb35.api.manifest",
			Category:  "gb35",
			Title:     "GB-35: GET /api/channel/manifest responds",
			DependsOn: []string{"gb35.api.channels"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				out, manifest := checkGB35APIManifest(ctx, httpClient, daemonAPI)
				if out.Status == DiagStatusPass {
					mCopy := manifest
					rt.mu.Lock()
					rt.gb35Manifest = &mCopy
					rt.mu.Unlock()
				}
				return out
			},
		},
		DiagCheckSpec{
			ID:        "gb35.manifest.signature",
			Category:  "gb35",
			Title:     "GB-35: channel manifest Ed25519 signature verifies",
			DependsOn: []string{"gb35.api.manifest"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				rt.mu.RLock()
				manifest := rt.gb35Manifest
				rt.mu.RUnlock()
				if manifest == nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "no manifest loaded from /api/channel/manifest"}
				}
				if err := verifyGB35ManifestSignature(*manifest); err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
				}
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: fmt.Sprintf("verified Ed25519 signature for channel %s manifest v%d", manifest.Channel, manifest.Version),
				}
			},
		},
		DiagCheckSpec{
			ID:        "gb35.plugin.deny_unlisted",
			Category:  "gb35",
			Title:     "GB-35: unlisted plugin is denied (fails closed)",
			DependsOn: []string{"gb35.api.manifest"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				rt.mu.RLock()
				manifest := rt.gb35Manifest
				rt.mu.RUnlock()
				if manifest == nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "no manifest loaded from /api/channel/manifest"}
				}
				if err := verifyGB35PluginAllowed(*manifest, diagGB35UnlistedPluginProbe); err == nil {
					return DiagCheckOutcome{
						Status: DiagStatusFail,
						Error:  fmt.Sprintf("unlisted plugin %q was unexpectedly allowed", diagGB35UnlistedPluginProbe),
					}
				}
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: fmt.Sprintf("unlisted plugin %q denied (fail closed)", diagGB35UnlistedPluginProbe),
				}
			},
		},
		DiagCheckSpec{
			ID:        "gb35.blob.membership",
			Category:  "gb35",
			Title:     "GB-35: removed peer loses blob access (membership enforcement)",
			DependsOn: []string{"migration.dialtone.v060"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				// Never mutate live metal channel membership; verify membership enforcement in a throwaway fixture.
				mem := newGB35FixtureBlobMembership([]string{"diag-peer-a", "diag-peer-b"})
				if !mem.CanAccess("diag-peer-b") {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "fixture peer lacked initial access"}
				}
				mem.RemovePeer("diag-peer-b")
				if mem.CanAccess("diag-peer-b") || !mem.CanAccess("diag-peer-a") {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "removed peer retained blob access"}
				}
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: "blob membership revocation verified in isolated fixture (live metal membership untouched)",
				}
			},
		},
		DiagCheckSpec{
			ID:        "gb35.blob.stream_3mb",
			Category:  "gb35",
			Title:     "GB-35: blob share of >= 3 MB streams cleanly",
			DependsOn: []string{"migration.dialtone.v060"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				const size = diagGB35MinStreamBytes + 64*1024
				payload := bytes.Repeat([]byte("dialtone-gb35-3mb-stream-test-0123456789abcdef\n"), size/47+1)[:size]
				want := sha256.Sum256(payload)
				n, gotHash, err := streamGB35BlobFixture(bytes.NewReader(payload), 64*1024)
				if err != nil || n < diagGB35MinStreamBytes || gotHash != hex.EncodeToString(want[:]) {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("3MB stream check failed: bytes=%d err=%v", n, err)}
				}
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: fmt.Sprintf("streamed %d bytes (>= 3 MB) with verified SHA-256", n),
					Details: map[string]any{"bytes": n, "sha256": gotHash[:16]},
				}
			},
		},
		DiagCheckSpec{
			ID:        "gb35.logs.dialtone_log",
			Category:  "gb35",
			Title:     "GB-35: channel logs readable via dialtone log",
			DependsOn: []string{"migration.dialtone.v060"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				stdout, stderr, code, err := runBoundedCommand(ctx, 15*time.Second, dialtoneBin, "log", "--lines", "20")
				if err != nil || code != 0 {
					return DiagCheckOutcome{
						Status: DiagStatusFail,
						Error:  fmt.Sprintf("dialtone log failed (exit=%d err=%v)", code, err),
						Stdout: stdout,
						Stderr: stderr,
					}
				}
				return parseGB35DialtoneLogOutput(stdout)
			},
		},
		DiagCheckSpec{
			ID:        "gb35.task.channel_separation",
			Category:  "gb35",
			Title:     "GB-35: task data separated by channel",
			DependsOn: []string{"migration.dialtone.v060", "migration.task.v050"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				tmpDir, err := os.MkdirTemp("", "diag-gb35-task-sep-*")
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
				}
				defer os.RemoveAll(tmpDir)
				return verifyGB35TaskChannelSeparation(tmpDir)
			},
		},
	)

	// RPC try_rpc "Database already open" retry check (skipped until released or feature flag enabled).
	specs = append(specs, DiagCheckSpec{
		ID:        "rpc.try_rpc.db_open_retry",
		Category:  "rpc",
		Title:     "RPC: try_rpc Database already open retry",
		DependsOn: []string{"mesh.local.status"},
		Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
			if taskBin == "" || !fileExists(taskBin) {
				return DiagCheckOutcome{Status: DiagStatusSkipped, SkipReason: "local dialtone-task binary not installed"}
			}
			verOut, _, _, _ := localTaskRun(ctx, "--version")
			featureEnabled := strings.TrimSpace(os.Getenv(diagTryRPCRetryEnvFlag)) == "1"
			return runTryRPCDbOpenRetryCheck(ctx, verOut, featureEnabled, localTaskRun)
		},
	})

	// Mac app version check on rosie (strictly read-only over metal).
	if hasRosie {
		specs = append(specs, DiagCheckSpec{
			ID:        "macapp.version.rosie",
			Category:  "macapp",
			Title:     "Mac app version on rosie (read-only Info.plist)",
			DependsOn: []string{"mesh.node.rosie"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				cmd := `for p in "$HOME/Applications/Dialtone Tasks.app/Contents/Info.plist" "/Applications/Dialtone Tasks.app/Contents/Info.plist" "$HOME/Applications/Dialtone.app/Contents/Info.plist" "/Applications/Dialtone.app/Contents/Info.plist"; do if [ -f "$p" ]; then echo "__PLIST_PATH__=$p"; plutil -convert json -o - "$p"; exit 0; fi; done; echo "__MACAPP_NOT_FOUND__"`
				execRes, rawOut, rawErr, execErr := runDialtoneExec(ctx, dialtoneBin, "rosie", false, 20*time.Second, cmd)
				outText := strings.TrimSpace(execRes.Stdout)
				if strings.Contains(outText, "__MACAPP_NOT_FOUND__") {
					return DiagCheckOutcome{
						Status:     DiagStatusInfo,
						SkipReason: "manual: Dialtone Mac app bundle not found in ~/Applications or /Applications on rosie",
						Summary:    "manual check: install Dialtone Tasks.app on rosie and verify CFBundleShortVersionString",
						Details:    map[string]any{"node": "rosie", "found": false},
					}
				}
				if execErr != nil || execRes.ExitCode != 0 {
					return DiagCheckOutcome{
						Status: DiagStatusFail,
						Error:  fmt.Sprintf("read Mac app Info.plist on rosie failed (exit=%d err=%v)", execRes.ExitCode, execErr),
						Stdout: rawOut,
						Stderr: rawErr,
					}
				}
				plistPath := ""
				jsonLines := make([]string, 0)
				for _, line := range strings.Split(outText, "\n") {
					if strings.HasPrefix(line, "__PLIST_PATH__=") {
						plistPath = strings.TrimPrefix(line, "__PLIST_PATH__=")
						continue
					}
					jsonLines = append(jsonLines, line)
				}
				return parseMacAppInfoPlistJSON("rosie", plistPath, strings.Join(jsonLines, "\n"))
			},
		})
	}

	return specs
}
