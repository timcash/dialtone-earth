package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

var defaultDiagFleetNodes = []string{
	"rosie",
	"legion",
	"build-1",
	"vm-us",
	"vm-eu",
	"vm-asia",
	"steamdeck-2",
}

var defaultDiagAgentNodes = []string{
	"rosie",
	"legion",
	"build-1",
}

// DiagChecksConfig configures the real read-only diagnostic check DAG.
type DiagChecksConfig struct {
	DialtoneBin      string
	TaskBin          string
	DaemonAPIURL     string
	DialtoneOrigin   string
	MetalOrigin      string
	TestOrigin       string
	Nodes            []string
	RunDialtoneTests bool
	HTTPClient       *http.Client
}

type meshNodeSnapshot struct {
	Node                string             `json:"node"`
	OS                  string             `json:"os"`
	Arch                string             `json:"arch"`
	Version             string             `json:"version"`
	Counter             int64              `json:"counter"`
	BeatIntervalSecs    int64              `json:"beat_interval_secs"`
	UpdatedAtUnix       int64              `json:"updated_at_unix"`
	ObservedRemoteAddrs []string           `json:"observed_remote_addrs"`
	PeerRTTMs           map[string]float64 `json:"peer_rtt_ms"`
	Probe               struct {
		Build       string `json:"build"`
		PassedCount int    `json:"passed_count"`
		TotalCount  int    `json:"total_count"`
	} `json:"probe"`
	IrohTransport struct {
		ExcludeTailnet bool   `json:"exclude_tailnet"`
		RelayMode      string `json:"relay_mode"`
		Profile        string `json:"profile"`
	} `json:"iroh_transport"`
}

type meshStateSnapshot struct {
	SelfNode   string             `json:"self_node"`
	Mesh       string             `json:"mesh"`
	Nodes      []meshNodeSnapshot `json:"nodes"`
	MeshRTTMs  map[string]float64 `json:"mesh_rtt_ms"`
	BootStages []struct {
		ID            string `json:"id"`
		Status        string `json:"status"`
		UpdatedAtUnix int64  `json:"updated_at_unix"`
	} `json:"boot_stages"`
}

type diagSharedRuntime struct {
	mu             sync.RWMutex
	selfNode       string
	meshSnapshot   *meshStateSnapshot
	nodeByName     map[string]meshNodeSnapshot
	beatAge        map[string]int
	beatOK         map[string]bool
	taskHashes     map[string]string
	taskPeers      map[string]int
	taskVersions   map[string]string
	agentVersions  map[string]string
	daemonVersions map[string]string
	gb35Manifest   *gb35ChannelManifest
}

func newDiagSharedRuntime() *diagSharedRuntime {
	return &diagSharedRuntime{
		nodeByName:     map[string]meshNodeSnapshot{},
		beatAge:        map[string]int{},
		beatOK:         map[string]bool{},
		taskHashes:     map[string]string{},
		taskPeers:      map[string]int{},
		taskVersions:   map[string]string{},
		agentVersions:  map[string]string{},
		daemonVersions: map[string]string{},
	}
}

func defaultDialtoneBinary() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "dialtone"
	}
	name := "dialtone"
	if runtime.GOOS == "windows" {
		name = "dialtone.exe"
	}
	candidate := filepath.Join(home, ".dialtone", "bin", name)
	if fileExists(candidate) {
		return candidate
	}
	return name
}

func isWindowsPeer(node string, snap *meshNodeSnapshot) bool {
	if snap != nil && strings.EqualFold(snap.OS, "windows") {
		return true
	}
	lower := strings.ToLower(strings.TrimSpace(node))
	return lower == "legion" || lower == "build-1"
}

func classifyMeshPath(addrs []string) string {
	for _, a := range addrs {
		lower := strings.ToLower(strings.TrimSpace(a))
		if lower == "local:self" {
			return "local"
		}
		if strings.HasPrefix(lower, "active:direct:") {
			return "direct"
		}
		if strings.HasPrefix(lower, "active:relay:") {
			return "relay"
		}
	}
	if len(addrs) > 0 {
		return "direct"
	}
	return "unknown"
}

func runBoundedCommand(ctx context.Context, timeout time.Duration, name string, args ...string) (string, string, int, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, name, args...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return stdout.String(), stderr.String(), exitCode, err
}

type dialtoneExecJSON struct {
	ElapsedMs int64  `json:"elapsed_ms"`
	ExitCode  int    `json:"exit_code"`
	Node      string `json:"node"`
	OS        string `json:"os"`
	Shell     string `json:"shell"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	TimedOut  bool   `json:"timed_out"`
}

func runDialtoneExec(ctx context.Context, bin, node string, win bool, timeout time.Duration, command string) (dialtoneExecJSON, string, string, error) {
	shellFlag := "--bash"
	if win {
		shellFlag = "--powershell"
	}
	args := []string{
		"exec",
		"--node", node,
		shellFlag,
		"--timeout", timeout.String(),
		"--json",
		"--",
		command,
	}
	stdout, stderr, _, err := runBoundedCommand(ctx, timeout+5*time.Second, bin, args...)
	var parsed dialtoneExecJSON
	if jErr := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &parsed); jErr == nil && (parsed.Node != "" || parsed.Shell != "") {
		return parsed, stdout, stderr, err
	}
	return parsed, stdout, stderr, err
}

// BuildDiagnosticDAG constructs the full read-only diagnostic check DAG across
// dialtone.earth HTTP, the metal network, plugins, and dialtone itself.
func BuildDiagnosticDAG(cfg DiagChecksConfig) []DiagCheckSpec {
	dialtoneBin := strings.TrimSpace(cfg.DialtoneBin)
	if dialtoneBin == "" {
		dialtoneBin = defaultDialtoneBinary()
	}
	daemonAPI := strings.TrimRight(strings.TrimSpace(cfg.DaemonAPIURL), "/")
	if daemonAPI == "" {
		daemonAPI = "http://127.0.0.1:8788"
	}
	dialtoneOrigin := strings.TrimRight(strings.TrimSpace(cfg.DialtoneOrigin), "/")
	if dialtoneOrigin == "" {
		dialtoneOrigin = "https://dialtone.earth"
	}
	metalOrigin := strings.TrimRight(strings.TrimSpace(cfg.MetalOrigin), "/")
	if metalOrigin == "" {
		metalOrigin = "https://metal.dialtone.earth"
	}
	testOrigin := strings.TrimRight(strings.TrimSpace(cfg.TestOrigin), "/")
	if testOrigin == "" {
		testOrigin = "https://test.dialtone.earth"
	}
	nodes := cfg.Nodes
	if len(nodes) == 0 {
		nodes = defaultDiagFleetNodes
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 12 * time.Second}
	}
	noRedirectClient := &http.Client{
		Timeout: httpClient.Timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	rt := newDiagSharedRuntime()
	var specs []DiagCheckSpec

	// --- Category A: dialtone.earth, metal.dialtone.earth, test.dialtone.earth (HTTP GET only) ---
	httpGet := func(ctx context.Context, client *http.Client, targetURL string) (int, http.Header, string, int64, error) {
		start := time.Now()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
		if err != nil {
			return 0, nil, "", 0, err
		}
		resp, err := client.Do(req)
		elapsed := time.Since(start).Milliseconds()
		if err != nil {
			return 0, nil, "", elapsed, err
		}
		defer resp.Body.Close()
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
		return resp.StatusCode, resp.Header, string(body), elapsed, readErr
	}

	specs = append(specs,
		DiagCheckSpec{
			ID:       "http.dialtone.home",
			Category: "http",
			Title:    "dialtone.earth homepage and security headers",
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				code, hdr, body, ms, err := httpGet(ctx, httpClient, dialtoneOrigin+"/")
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error(), Details: map[string]any{"url": dialtoneOrigin + "/", "latency_ms": ms}}
				}
				if code != http.StatusOK {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("HTTP %d (want 200)", code), Details: map[string]any{"status_code": code, "latency_ms": ms}}
				}
				var missing []string
				if !strings.Contains(body, `id="app"`) {
					missing = append(missing, `id="app"`)
				}
				if hdr.Get("Strict-Transport-Security") == "" {
					missing = append(missing, "HSTS")
				}
				if hdr.Get("Content-Security-Policy") == "" {
					missing = append(missing, "CSP")
				}
				if hdr.Get("X-Frame-Options") != "DENY" {
					missing = append(missing, "X-Frame-Options:DENY")
				}
				details := map[string]any{"url": dialtoneOrigin + "/", "status_code": code, "latency_ms": ms}
				if len(missing) > 0 {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "missing: " + strings.Join(missing, ", "), Details: details}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: fmt.Sprintf("HTTP 200 (%dms), headers ok", ms), Details: details}
			},
		},
		DiagCheckSpec{
			ID:        "http.dialtone.session",
			Category:  "http",
			Title:     "dialtone.earth /api/session anonymous simulated mode",
			DependsOn: []string{"http.dialtone.home"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				code, _, body, ms, err := httpGet(ctx, httpClient, dialtoneOrigin+"/api/session")
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
				}
				var sess struct {
					Authenticated bool   `json:"authenticated"`
					Mode          string `json:"mode"`
				}
				if code != http.StatusOK || json.Unmarshal([]byte(body), &sess) != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("HTTP %d invalid JSON", code), Details: map[string]any{"status_code": code, "latency_ms": ms}}
				}
				if sess.Authenticated || sess.Mode != "simulated" {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("unexpected session authenticated=%v mode=%q", sess.Authenticated, sess.Mode)}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: fmt.Sprintf("HTTP 200 (%dms), mode=simulated", ms), Details: map[string]any{"status_code": code, "latency_ms": ms, "mode": sess.Mode}}
			},
		},
		DiagCheckSpec{
			ID:        "http.dialtone.installers",
			Category:  "http",
			Title:     "dialtone.earth /install.sh and /install.ps1",
			DependsOn: []string{"http.dialtone.home"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				latencies := map[string]any{}
				for _, path := range []string{"/install.sh", "/install.ps1"} {
					code, _, body, ms, err := httpGet(ctx, httpClient, dialtoneOrigin+path)
					latencies[path] = ms
					if err != nil {
						return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("%s: %v", path, err), Details: latencies}
					}
					if code != http.StatusOK {
						return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("%s returned HTTP %d", path, code), Details: latencies}
					}
					if strings.Contains(body, "github.com") {
						return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("%s contains github.com reference", path), Details: latencies}
					}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: "install.sh and install.ps1 HTTP 200 (zero GitHub)", Details: latencies}
			},
		},
		DiagCheckSpec{
			ID:        "http.dialtone.plugins",
			Category:  "http",
			Title:     "dialtone.earth /api/plugins catalog",
			DependsOn: []string{"http.dialtone.home"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				code, _, body, ms, err := httpGet(ctx, httpClient, dialtoneOrigin+"/api/plugins")
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
				}
				var parsed struct {
					Plugins []struct {
						Name string `json:"name"`
					} `json:"plugins"`
				}
				if code != http.StatusOK || json.Unmarshal([]byte(body), &parsed) != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("HTTP %d invalid JSON", code)}
				}
				names := make([]string, 0, len(parsed.Plugins))
				hasShell := false
				for _, p := range parsed.Plugins {
					names = append(names, p.Name)
					if p.Name == "dialtone-shell" {
						hasShell = true
					}
				}
				if !hasShell {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "public plugin catalog missing dialtone-shell", Details: map[string]any{"plugins": names, "latency_ms": ms}}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: fmt.Sprintf("HTTP 200 (%dms), %d plugin(s)", ms, len(names)), Details: map[string]any{"status_code": code, "latency_ms": ms, "plugins": names}}
			},
		},
		DiagCheckSpec{
			ID:        "http.dialtone.releases",
			Category:  "http",
			Title:     "dialtone.earth release channels and feeds",
			DependsOn: []string{"http.dialtone.home"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				details := map[string]any{}
				for _, path := range []string{"/api/releases/dialtone/channels", "/api/releases/dialtone-earth"} {
					code, _, body, ms, err := httpGet(ctx, httpClient, dialtoneOrigin+path)
					details[path+"_ms"] = ms
					if err != nil {
						return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("%s: %v", path, err), Details: details}
					}
					if code != http.StatusOK || !json.Valid([]byte(body)) {
						return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("%s returned HTTP %d", path, code), Details: details}
					}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: "release channels and dialtone-earth releases HTTP 200", Details: details}
			},
		},
		DiagCheckSpec{
			ID:        "http.dialtone.live",
			Category:  "http",
			Title:     "dialtone.earth /api/live state endpoint",
			DependsOn: []string{"http.dialtone.home"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				code, _, body, ms, err := httpGet(ctx, httpClient, dialtoneOrigin+"/api/live")
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
				}
				if code != http.StatusOK || !json.Valid([]byte(body)) {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("HTTP %d invalid JSON", code)}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: fmt.Sprintf("HTTP 200 (%dms)", ms), Details: map[string]any{"status_code": code, "latency_ms": ms}}
			},
		},
		DiagCheckSpec{
			ID:        "http.dialtone.security",
			Category:  "http",
			Title:     "dialtone.earth /api/code anonymous 401 gate",
			DependsOn: []string{"http.dialtone.home"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				code, _, _, ms, err := httpGet(ctx, httpClient, dialtoneOrigin+"/api/code")
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
				}
				if code != http.StatusUnauthorized {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("expected 401 on anonymous /api/code, got %d", code)}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: fmt.Sprintf("HTTP 401 enforced (%dms)", ms), Details: map[string]any{"status_code": code, "latency_ms": ms}}
			},
		},
		DiagCheckSpec{
			ID:       "http.metal.home",
			Category: "http",
			Title:    "metal.dialtone.earth homepage",
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				code, _, body, ms, err := httpGet(ctx, httpClient, metalOrigin+"/")
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
				}
				if code != http.StatusOK || !strings.Contains(body, `id="app"`) {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("HTTP %d or missing #app", code), Details: map[string]any{"status_code": code, "latency_ms": ms}}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: fmt.Sprintf("HTTP 200 (%dms)", ms), Details: map[string]any{"status_code": code, "latency_ms": ms}}
			},
		},
		DiagCheckSpec{
			ID:        "http.metal.auth_gate",
			Category:  "http",
			Title:     "metal.dialtone.earth /api/mesh/state anonymous 401 gate",
			DependsOn: []string{"http.metal.home"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				code, _, _, ms, err := httpGet(ctx, httpClient, metalOrigin+"/api/mesh/state")
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
				}
				if code != http.StatusUnauthorized {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("expected 401 on anonymous /api/mesh/state, got %d", code)}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: fmt.Sprintf("HTTP 401 enforced (%dms)", ms), Details: map[string]any{"status_code": code, "latency_ms": ms}}
			},
		},
		DiagCheckSpec{
			ID:       "http.test.auth_gate",
			Category: "http",
			Title:    "test.dialtone.earth owner-only login redirect gate",
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				code, hdr, _, ms, err := httpGet(ctx, noRedirectClient, testOrigin+"/")
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: err.Error()}
				}
				loc := hdr.Get("Location")
				if code != http.StatusFound || loc != "/login" {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("expected 302 -> /login, got %d -> %q", code, loc)}
				}
				loginCode, _, loginBody, loginMs, loginErr := httpGet(ctx, httpClient, testOrigin+"/login")
				if loginErr != nil || loginCode != http.StatusOK || !strings.Contains(loginBody, `auth-globe-stage`) {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("GET /login check failed (status=%d err=%v)", loginCode, loginErr)}
				}
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: fmt.Sprintf("302 -> /login (%dms), /login 200 (%dms)", ms, loginMs),
					Details: map[string]any{"redirect_status": code, "location": loc, "login_status": loginCode, "latency_ms": ms + loginMs},
				}
			},
		},
	)

	// --- Category B: Metal network (local status, local probe, per-node reachability + exec round trip) ---
	specs = append(specs,
		DiagCheckSpec{
			ID:       "mesh.local.status",
			Category: "metal",
			Title:    "Local dialtone status and transport report",
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				stdout, stderr, exitCode, err := runBoundedCommand(ctx, 15*time.Second, dialtoneBin, "status")
				if err != nil || exitCode != 0 {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("dialtone status exit=%d err=%v", exitCode, err), Stdout: stdout, Stderr: stderr}
				}
				var parsed struct {
					Node        string `json:"node"`
					Owner       string `json:"owner"`
					DataPlane   string `json:"steady_state_data_plane"`
					Diagnostics struct {
						NodeID         string `json:"node_id"`
						ExcludeTailnet bool   `json:"exclude_tailnet"`
						Profile        string `json:"profile"`
					} `json:"diagnostics"`
				}
				if err := json.Unmarshal([]byte(stdout), &parsed); err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "invalid status JSON: " + err.Error(), Stdout: stdout, Stderr: stderr}
				}
				if parsed.Node == "" || parsed.Diagnostics.NodeID == "" {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "missing node or node_id in dialtone status", Stdout: stdout}
				}
				rt.mu.Lock()
				rt.selfNode = parsed.Node
				rt.mu.Unlock()
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: fmt.Sprintf("node=%s plane=%s exclude_tailnet=%v", parsed.Node, parsed.DataPlane, parsed.Diagnostics.ExcludeTailnet),
					Details: map[string]any{
						"node":            parsed.Node,
						"owner":           parsed.Owner,
						"data_plane":      parsed.DataPlane,
						"exclude_tailnet": parsed.Diagnostics.ExcludeTailnet,
						"profile":         parsed.Diagnostics.Profile,
					},
					Stdout: stdout,
					Stderr: stderr,
				}
			},
		},
		DiagCheckSpec{
			ID:        "mesh.local.probe",
			Category:  "metal",
			Title:     "Local dialtone probe and mesh peer inventory",
			DependsOn: []string{"mesh.local.status"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				stdout, stderr, exitCode, err := runBoundedCommand(ctx, 20*time.Second, dialtoneBin, "probe")
				if err != nil || exitCode != 0 {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("dialtone probe exit=%d err=%v", exitCode, err), Stdout: stdout, Stderr: stderr}
				}
				var probeResp struct {
					Node   string `json:"node"`
					Status string `json:"status"`
					Probe  struct {
						PassedCount int    `json:"passed_count"`
						TotalCount  int    `json:"total_count"`
						Build       string `json:"build"`
						Checks      []struct {
							Code   string `json:"code"`
							Detail string `json:"detail"`
							OK     bool   `json:"ok"`
						} `json:"checks"`
						Beats []struct {
							Peer     string `json:"peer"`
							AgeSecs  int    `json:"age_secs"`
							HearsAll bool   `json:"hears_all"`
							OK       bool   `json:"ok"`
						} `json:"beats"`
					} `json:"probe"`
				}
				if err := json.Unmarshal([]byte(stdout), &probeResp); err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "invalid probe JSON: " + err.Error(), Stdout: stdout}
				}

				// Also read local daemon /api/mesh for direct/relay paths, versions, and RTT.
				meshCode, _, meshBody, _, meshErr := httpGet(ctx, httpClient, daemonAPI+"/api/mesh")
				var meshSnap meshStateSnapshot
				if meshErr == nil && meshCode == http.StatusOK {
					_ = json.Unmarshal([]byte(meshBody), &meshSnap)
				}

				rt.mu.Lock()
				if probeResp.Node != "" {
					rt.selfNode = probeResp.Node
				}
				beatingOK := 0
				for _, b := range probeResp.Probe.Beats {
					rt.beatAge[b.Peer] = b.AgeSecs
					rt.beatOK[b.Peer] = b.OK
					if b.OK {
						beatingOK++
					}
				}
				if len(meshSnap.Nodes) > 0 {
					rt.meshSnapshot = &meshSnap
					for _, n := range meshSnap.Nodes {
						rt.nodeByName[n.Node] = n
					}
				}
				rt.mu.Unlock()

				mshOK := true
				nbrOK := true
				beatDetail := ""
				for _, chk := range probeResp.Probe.Checks {
					switch chk.Code {
					case "MSH":
						mshOK = chk.OK
					case "NBR":
						nbrOK = chk.OK
					case "BEAT":
						beatDetail = chk.Detail
					}
				}

				if probeResp.Status != "ok" || !mshOK || !nbrOK {
					return DiagCheckOutcome{
						Status:  DiagStatusFail,
						Error:   fmt.Sprintf("local mesh probe unhealthy: status=%s msh=%v nbr=%v passed=%d/%d", probeResp.Status, mshOK, nbrOK, probeResp.Probe.PassedCount, probeResp.Probe.TotalCount),
						Stdout:  stdout,
						Stderr:  stderr,
						Details: map[string]any{"passed": probeResp.Probe.PassedCount, "total": probeResp.Probe.TotalCount, "msh_ok": mshOK, "nbr_ok": nbrOK, "peers_beating": beatingOK, "peers_total": len(probeResp.Probe.Beats)},
					}
				}
				summary := fmt.Sprintf("mesh open (%d/%d probe checks, %d/%d peers beating)", probeResp.Probe.PassedCount, probeResp.Probe.TotalCount, beatingOK, len(probeResp.Probe.Beats))
				if beatDetail != "" && probeResp.Probe.PassedCount < probeResp.Probe.TotalCount {
					summary += " [" + beatDetail + "]"
				}
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: summary,
					Details: map[string]any{
						"node":          probeResp.Node,
						"passed":        probeResp.Probe.PassedCount,
						"total":         probeResp.Probe.TotalCount,
						"msh_ok":        mshOK,
						"nbr_ok":        nbrOK,
						"peers_beating": beatingOK,
						"peers_total":   len(probeResp.Probe.Beats),
						"beat_detail":   beatDetail,
						"build":         probeResp.Probe.Build,
					},
					Stdout: stdout,
					Stderr: stderr,
				}
			},
		},
	)

	// Per-node mesh, plugin, and dialtone daemon checks.
	var taskCheckIDs []string
	var daemonCheckIDs []string
	for _, rawNode := range nodes {
		node := strings.TrimSpace(rawNode)
		if node == "" {
			continue
		}
		meshCheckID := "mesh.node." + node
		taskCheckID := "plugin.task.node." + node
		dispatchCheckID := "plugin.dispatch.node." + node
		agentCheckID := "plugin.agent.node." + node
		daemonCheckID := "dialtone.daemon.node." + node
		taskCheckIDs = append(taskCheckIDs, taskCheckID)
		daemonCheckIDs = append(daemonCheckIDs, daemonCheckID)

		specs = append(specs,
			DiagCheckSpec{
				ID:        meshCheckID,
				Category:  "metal",
				Title:     fmt.Sprintf("Metal peer %s reachability and exec round trip", node),
				DependsOn: []string{"mesh.local.probe"},
				Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
					rt.mu.RLock()
					snap, hasSnap := rt.nodeByName[node]
					selfNode := rt.selfNode
					beatOK := rt.beatOK[node]
					beatAge, hasBeat := rt.beatAge[node]
					rt.mu.RUnlock()

					var snapPtr *meshNodeSnapshot
					if hasSnap {
						snapCopy := snap
						snapPtr = &snapCopy
					}
					win := isWindowsPeer(node, snapPtr)
					pathKind := "unknown"
					if hasSnap {
						pathKind = classifyMeshPath(snap.ObservedRemoteAddrs)
					} else if node == selfNode {
						pathKind = "local"
					}

					if node != selfNode && !hasSnap && !beatOK {
						return DiagCheckOutcome{
							Status:  DiagStatusFail,
							Error:   fmt.Sprintf("peer %s offline (not beating in mesh probe)", node),
							Details: map[string]any{"node": node, "online": false, "path": pathKind},
						}
					}

					start := time.Now()
					execRes, rawOut, rawErr, execErr := runDialtoneExec(ctx, dialtoneBin, node, win, 20*time.Second, "echo ok")
					wallMs := time.Since(start).Milliseconds()
					latencyMs := execRes.ElapsedMs
					if latencyMs <= 0 {
						latencyMs = wallMs
					}

					details := map[string]any{
						"node":         node,
						"os":           execRes.OS,
						"shell":        execRes.Shell,
						"path":         pathKind,
						"latency_ms":   latencyMs,
						"wall_ms":      wallMs,
						"beat_ok":      beatOK || node == selfNode,
						"beat_present": hasBeat || node == selfNode,
					}
					if hasBeat {
						details["beat_age_secs"] = beatAge
					}
					if hasSnap && len(snap.ObservedRemoteAddrs) > 0 {
						details["observed_addrs"] = snap.ObservedRemoteAddrs
					}
					if execErr != nil || execRes.ExitCode != 0 || execRes.TimedOut || !strings.Contains(strings.TrimSpace(execRes.Stdout), "ok") {
						errMsg := fmt.Sprintf("dialtone exec failed (exit=%d timed_out=%v err=%v)", execRes.ExitCode, execRes.TimedOut, execErr)
						return DiagCheckOutcome{
							Status:  DiagStatusFail,
							Error:   errMsg,
							Details: details,
							Stdout:  rawOut,
							Stderr:  rawErr,
						}
					}
					return DiagCheckOutcome{
						Status:  DiagStatusPass,
						Summary: fmt.Sprintf("ok (%dms, path=%s)", latencyMs, pathKind),
						Details: details,
						Stdout:  rawOut,
						Stderr:  rawErr,
					}
				},
			},
			// Category C: Plugins per node
			DiagCheckSpec{
				ID:        taskCheckID,
				Category:  "plugins",
				Title:     fmt.Sprintf("Plugin dialtone-task status on %s", node),
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
					cmd := `if [ -x "$HOME/.dialtone/plugins/task/dialtone-task" ]; then "$HOME/.dialtone/plugins/task/dialtone-task" status --json; else echo "__DIAG_NOT_INSTALLED__"; fi`
					if win {
						cmd = `$p = Join-Path $env:USERPROFILE '.dialtone\plugins\task\dialtone-task.exe'; if (Test-Path $p) { & $p status --json } else { Write-Output '__DIAG_NOT_INSTALLED__' }`
					}
					execRes, rawOut, rawErr, execErr := runDialtoneExec(ctx, dialtoneBin, node, win, 20*time.Second, cmd)
					outText := strings.TrimSpace(execRes.Stdout)
					if strings.Contains(outText, "__DIAG_NOT_INSTALLED__") {
						return DiagCheckOutcome{
							Status:     DiagStatusSkipped,
							SkipReason: fmt.Sprintf("dialtone-task not installed on %s", node),
							Details:    map[string]any{"node": node, "installed": false},
						}
					}
					if execErr != nil || execRes.ExitCode != 0 {
						return DiagCheckOutcome{
							Status: DiagStatusFail,
							Error:  fmt.Sprintf("dialtone-task status failed on %s (exit=%d err=%v)", node, execRes.ExitCode, execErr),
							Stdout: rawOut,
							Stderr: rawErr,
						}
					}
					var st struct {
						Node         string `json:"node"`
						ServeRunning bool   `json:"serve_running"`
						PeerCount    int    `json:"peer_count"`
						TaskCount    int    `json:"task_count"`
						StaleCount   int    `json:"stale_count"`
						StateHash    string `json:"state_hash"`
					}
					if err := json.Unmarshal([]byte(outText), &st); err != nil {
						return DiagCheckOutcome{Status: DiagStatusFail, Error: "invalid dialtone-task status JSON: " + err.Error(), Stdout: outText, Stderr: execRes.Stderr}
					}
					details := map[string]any{
						"node":          node,
						"installed":     true,
						"serve_running": st.ServeRunning,
						"peer_count":    st.PeerCount,
						"task_count":    st.TaskCount,
						"stale_count":   st.StaleCount,
						"state_hash":    st.StateHash,
					}
					if st.StateHash != "" {
						rt.mu.Lock()
						rt.taskHashes[node] = st.StateHash
						rt.taskPeers[node] = st.PeerCount
						rt.mu.Unlock()
					}
					if !st.ServeRunning || st.StateHash == "" {
						return DiagCheckOutcome{
							Status:  DiagStatusFail,
							Error:   fmt.Sprintf("dialtone-task unhealthy on %s: serve_running=%v state_hash=%q", node, st.ServeRunning, st.StateHash),
							Details: details,
							Stdout:  outText,
						}
					}
					shortHash := st.StateHash
					if len(shortHash) > 12 {
						shortHash = shortHash[:12]
					}
					return DiagCheckOutcome{
						Status:  DiagStatusPass,
						Summary: fmt.Sprintf("serve=true peers=%d tasks=%d hash=%s", st.PeerCount, st.TaskCount, shortHash),
						Details: details,
						Stdout:  outText,
					}
				},
			},
			DiagCheckSpec{
				ID:        dispatchCheckID,
				Category:  "plugins",
				Title:     fmt.Sprintf("Plugin dispatch (dialtone task status) on %s", node),
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
					cmd := `if [ -x "$HOME/.dialtone/plugins/task/dialtone-task" ] && [ -x "$HOME/.dialtone/bin/dialtone" ]; then "$HOME/.dialtone/bin/dialtone" task status --json; else echo "__DIAG_NOT_INSTALLED__"; fi`
					if win {
						cmd = `$p = Join-Path $env:USERPROFILE '.dialtone\plugins\task\dialtone-task.exe'; $d = Join-Path $env:USERPROFILE '.dialtone\bin\dialtone.exe'; if ((Test-Path $p) -and (Test-Path $d)) { & $d task status --json } else { Write-Output '__DIAG_NOT_INSTALLED__' }`
					}
					execRes, rawOut, rawErr, execErr := runDialtoneExec(ctx, dialtoneBin, node, win, 20*time.Second, cmd)
					combined := execRes.Stdout + "\n" + execRes.Stderr
					if strings.Contains(combined, "__DIAG_NOT_INSTALLED__") ||
						strings.Contains(strings.ToLower(combined), "unknown argument") ||
						strings.Contains(strings.ToLower(combined), "unknown action") {
						return DiagCheckOutcome{
							Status:     DiagStatusSkipped,
							SkipReason: fmt.Sprintf("plugin dispatch (dialtone task) not installed on %s", node),
							Details:    map[string]any{"node": node, "installed": false},
						}
					}
					if execErr != nil || execRes.ExitCode != 0 {
						return DiagCheckOutcome{
							Status: DiagStatusFail,
							Error:  fmt.Sprintf("dialtone task status failed on %s (exit=%d err=%v)", node, execRes.ExitCode, execErr),
							Stdout: rawOut,
							Stderr: rawErr,
						}
					}
					var st struct {
						ServeRunning bool   `json:"serve_running"`
						StateHash    string `json:"state_hash"`
					}
					if err := json.Unmarshal([]byte(strings.TrimSpace(execRes.Stdout)), &st); err != nil || st.StateHash == "" {
						return DiagCheckOutcome{Status: DiagStatusFail, Error: "dialtone task status did not return valid status JSON", Stdout: execRes.Stdout, Stderr: execRes.Stderr}
					}
					return DiagCheckOutcome{
						Status:  DiagStatusPass,
						Summary: fmt.Sprintf("dispatch ok (serve=%v)", st.ServeRunning),
						Details: map[string]any{"node": node, "installed": true, "serve_running": st.ServeRunning},
						Stdout:  execRes.Stdout,
					}
				},
			},
			DiagCheckSpec{
				ID:        agentCheckID,
				Category:  "plugins",
				Title:     fmt.Sprintf("Plugin dialtone-agent status on %s", node),
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
					cmd := `if [ -x "$HOME/.dialtone/plugins/agent/dialtone-agent" ]; then "$HOME/.dialtone/plugins/agent/dialtone-agent" status; else echo "__DIAG_NOT_INSTALLED__"; fi`
					if win {
						cmd = `$p = Join-Path $env:USERPROFILE '.dialtone\plugins\agent\dialtone-agent.exe'; if (Test-Path $p) { & $p status } else { Write-Output '__DIAG_NOT_INSTALLED__' }`
					}
					execRes, rawOut, rawErr, execErr := runDialtoneExec(ctx, dialtoneBin, node, win, 20*time.Second, cmd)
					if strings.Contains(execRes.Stdout, "__DIAG_NOT_INSTALLED__") {
						return DiagCheckOutcome{
							Status:     DiagStatusSkipped,
							SkipReason: fmt.Sprintf("dialtone-agent not installed on %s", node),
							Details:    map[string]any{"node": node, "installed": false},
						}
					}
					if execErr != nil || execRes.ExitCode != 0 {
						return DiagCheckOutcome{
							Status: DiagStatusFail,
							Error:  fmt.Sprintf("dialtone-agent status failed on %s (exit=%d err=%v)", node, execRes.ExitCode, execErr),
							Stdout: rawOut,
							Stderr: rawErr,
						}
					}
					return DiagCheckOutcome{
						Status:  DiagStatusPass,
						Summary: fmt.Sprintf("dialtone-agent status ok on %s", node),
						Details: map[string]any{"node": node, "installed": true},
						Stdout:  execRes.Stdout,
						Stderr:  execRes.Stderr,
					}
				},
			},
			// Category D: Dialtone daemon per node
			DiagCheckSpec{
				ID:        daemonCheckID,
				Category:  "dialtone",
				Title:     fmt.Sprintf("Dialtone daemon version and uptime on %s", node),
				DependsOn: []string{meshCheckID},
				Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
					rt.mu.RLock()
					snap, hasSnap := rt.nodeByName[node]
					meshSnap := rt.meshSnapshot
					selfNode := rt.selfNode
					rt.mu.RUnlock()

					var snapPtr *meshNodeSnapshot
					if hasSnap {
						s := snap
						snapPtr = &s
					}
					win := isWindowsPeer(node, snapPtr)
					cmd := `"$HOME/.dialtone/bin/dialtone" daemon status`
					if win {
						cmd = `& "$env:USERPROFILE\.dialtone\bin\dialtone.exe" daemon status`
					}
					execRes, rawOut, rawErr, execErr := runDialtoneExec(ctx, dialtoneBin, node, win, 20*time.Second, cmd)
					if execErr != nil || execRes.ExitCode != 0 {
						return DiagCheckOutcome{
							Status: DiagStatusFail,
							Error:  fmt.Sprintf("dialtone daemon status failed on %s (exit=%d err=%v)", node, execRes.ExitCode, execErr),
							Stdout: rawOut,
							Stderr: rawErr,
						}
					}
					var dStatus struct {
						Node               string `json:"node"`
						Channel            string `json:"channel"`
						ChannelFingerprint string `json:"channel_fingerprint"`
						Configured         bool   `json:"configured"`
						Listen             string `json:"listen"`
					}
					if err := json.Unmarshal([]byte(strings.TrimSpace(execRes.Stdout)), &dStatus); err != nil {
						return DiagCheckOutcome{Status: DiagStatusFail, Error: "invalid daemon status JSON: " + err.Error(), Stdout: execRes.Stdout}
					}
					version := "unknown"
					build := ""
					var uptimeSecs int64
					if hasSnap {
						if snap.Version != "" {
							version = snap.Version
						}
						build = snap.Probe.Build
						if snap.Counter > 0 && snap.BeatIntervalSecs > 0 {
							uptimeSecs = snap.Counter * snap.BeatIntervalSecs
						}
					}
					if version != "" && version != "unknown" {
						rt.mu.Lock()
						rt.daemonVersions[node] = version
						rt.mu.Unlock()
					}
					if node == selfNode && meshSnap != nil && len(meshSnap.BootStages) > 0 && meshSnap.BootStages[0].UpdatedAtUnix > 0 {
						nowUnix := time.Now().Unix()
						if nowUnix > meshSnap.BootStages[0].UpdatedAtUnix {
							uptimeSecs = nowUnix - meshSnap.BootStages[0].UpdatedAtUnix
						}
					}
					details := map[string]any{
						"node":                node,
						"version":             version,
						"build":               build,
						"uptime_secs":         uptimeSecs,
						"channel":             dStatus.Channel,
						"channel_fingerprint": dStatus.ChannelFingerprint,
						"listen":              dStatus.Listen,
					}
					return DiagCheckOutcome{
						Status:  DiagStatusPass,
						Summary: fmt.Sprintf("v%s channel=%s uptime=%ds", version, dStatus.Channel, uptimeSecs),
						Details: details,
						Stdout:  execRes.Stdout,
					}
				},
			},
		)
	}

	// Cross-node plugin.task.consistency check (runs after all per-node task checks).
	specs = append(specs,
		DiagCheckSpec{
			ID:        "plugin.task.consistency",
			Category:  "plugins",
			Title:     "dialtone-task state_hash equality across nodes",
			DependsOn: []string{"mesh.local.probe"},
			After:     taskCheckIDs,
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				rt.mu.RLock()
				hashes := make(map[string]string, len(rt.taskHashes))
				peers := make(map[string]int, len(rt.taskPeers))
				for k, v := range rt.taskHashes {
					hashes[k] = v
				}
				for k, v := range rt.taskPeers {
					peers[k] = v
				}
				rt.mu.RUnlock()

				if len(hashes) == 0 {
					return DiagCheckOutcome{
						Status:     DiagStatusSkipped,
						SkipReason: "no online nodes with dialtone-task installed",
					}
				}
				unique := map[string][]string{}
				for node, h := range hashes {
					unique[h] = append(unique[h], node)
				}
				for h := range unique {
					sort.Strings(unique[h])
				}
				details := map[string]any{
					"nodes_compared": len(hashes),
					"hashes_by_node": hashes,
					"peers_by_node":  peers,
				}
				if len(unique) > 1 {
					return DiagCheckOutcome{
						Status:  DiagStatusFail,
						Error:   fmt.Sprintf("state_hash diverged across %d nodes (%d distinct hashes)", len(hashes), len(unique)),
						Details: details,
					}
				}
				var onlyHash string
				for h := range unique {
					onlyHash = h
				}
				short := onlyHash
				if len(short) > 12 {
					short = short[:12]
				}
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: fmt.Sprintf("all %d node(s) match state_hash=%s", len(hashes), short),
					Details: details,
				}
			},
		},
		buildStaleTasksCheckSpec(cfg.TaskBin),
		// Category D: Dialtone CLI version & optional repo unit tests
		DiagCheckSpec{
			ID:        "dialtone.cli.version",
			Category:  "dialtone",
			Title:     "Local dialtone CLI binary and daemon metadata",
			DependsOn: []string{"mesh.local.probe"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				stdout, stderr, exitCode, err := runBoundedCommand(ctx, 10*time.Second, dialtoneBin, "daemon", "status")
				if err != nil || exitCode != 0 {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: fmt.Sprintf("dialtone daemon status exit=%d err=%v", exitCode, err), Stdout: stdout, Stderr: stderr}
				}
				rt.mu.RLock()
				selfSnap := rt.nodeByName[rt.selfNode]
				rt.mu.RUnlock()
				ver := selfSnap.Version
				if ver == "" {
					ver = "unknown"
				}
				return DiagCheckOutcome{
					Status:  DiagStatusPass,
					Summary: fmt.Sprintf("cli=%s version=%s build=%s", filepath.Base(dialtoneBin), ver, selfSnap.Probe.Build),
					Details: map[string]any{
						"binary":  dialtoneBin,
						"version": ver,
						"build":   selfSnap.Probe.Build,
					},
					Stdout: stdout,
				}
			},
		},
		DiagCheckSpec{
			ID:        "dialtone.repo.tests",
			Category:  "dialtone",
			Title:     "Dialtone repo unit tests (only when cheap/enabled)",
			DependsOn: []string{"dialtone.cli.version"},
			Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
				if !cfg.RunDialtoneTests {
					return DiagCheckOutcome{
						Status:     DiagStatusSkipped,
						SkipReason: "dialtone Rust unit tests skipped by default (expensive cargo test; pass --run-dialtone-tests to enable)",
					}
				}
				home, _ := os.UserHomeDir()
				repoDir := filepath.Join(home, "dialtone")
				if !fileExists(filepath.Join(repoDir, "Cargo.toml")) {
					return DiagCheckOutcome{
						Status:     DiagStatusSkipped,
						SkipReason: "local dialtone repo not found at " + repoDir,
					}
				}
				cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
				defer cancel()
				cmd := exec.CommandContext(cctx, "cargo", "test", "--lib")
				cmd.Dir = repoDir
				out, err := cmd.CombinedOutput()
				if err != nil {
					return DiagCheckOutcome{Status: DiagStatusFail, Error: "cargo test --lib failed: " + err.Error(), Stdout: string(out)}
				}
				return DiagCheckOutcome{Status: DiagStatusPass, Summary: "cargo test --lib passed", Stdout: string(out)}
			},
		},
	)

	specs = appendCoverageChecks(specs, cfg, rt, dialtoneBin, daemonAPI, httpClient, nodes, daemonCheckIDs)

	return specs
}

func buildStaleTasksCheckSpec(taskBinOverride string) DiagCheckSpec {
	return DiagCheckSpec{
		ID:       "plugin.task.stale",
		Category: "plugins",
		Title:    "dialtone-task stale active task count",
		Run: func(ctx context.Context, _ map[string]DiagCheckResult) DiagCheckOutcome {
			bin := strings.TrimSpace(taskBinOverride)
			if bin == "" {
				bin = defaultDiagTaskBinary()
			}
			if bin == "" || !fileExists(bin) {
				return DiagCheckOutcome{
					Status:     DiagStatusSkipped,
					SkipReason: "local dialtone-task binary not installed",
					Details:    map[string]any{"installed": false},
				}
			}
			stdout, stderr, exitCode, err := runBoundedCommand(ctx, 15*time.Second, bin, "status", "--json")
			if err != nil || exitCode != 0 {
				return DiagCheckOutcome{
					Status: DiagStatusFail,
					Error:  fmt.Sprintf("dialtone-task status --json failed (exit=%d err=%v)", exitCode, err),
					Stdout: stdout,
					Stderr: stderr,
				}
			}
			var st struct {
				Node         string `json:"node"`
				ServeRunning bool   `json:"serve_running"`
				TaskCount    int    `json:"task_count"`
				StaleCount   int    `json:"stale_count"`
				StateHash    string `json:"state_hash"`
			}
			if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &st); err != nil {
				return DiagCheckOutcome{
					Status: DiagStatusFail,
					Error:  "invalid dialtone-task status JSON: " + err.Error(),
					Stdout: stdout,
					Stderr: stderr,
				}
			}
			details := map[string]any{
				"node":          st.Node,
				"serve_running": st.ServeRunning,
				"task_count":    st.TaskCount,
				"stale_count":   st.StaleCount,
				"state_hash":    st.StateHash,
			}
			if st.StaleCount > 0 {
				return DiagCheckOutcome{
					Status:  DiagStatusFail,
					Error:   fmt.Sprintf("%d stale active task(s) overdue for update", st.StaleCount),
					Details: details,
					Stdout:  stdout,
				}
			}
			return DiagCheckOutcome{
				Status:  DiagStatusPass,
				Summary: fmt.Sprintf("0 stale active tasks (total=%d)", st.TaskCount),
				Details: details,
				Stdout:  stdout,
			}
		},
	}
}
