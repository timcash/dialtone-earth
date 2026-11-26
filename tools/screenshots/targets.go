package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// RegionTarget describes one DOM selector on the test UI to highlight for a test.
type RegionTarget struct {
	Selector       string `json:"selector"`
	Label          string `json:"label"`
	Color          string `json:"color,omitempty"`
	ScrollIntoView bool   `json:"scroll_into_view,omitempty"`
}

// TestCaptureSpec declares which page, optional UI action, and highlighted DOM
// regions correspond to a specific Go test. When Regions is empty, the capture
// falls back gracefully with no highlight overlay rather than drawing a wrong one.
type TestCaptureSpec struct {
	TestName     string         `json:"test_name"`
	PagePath     string         `json:"page_path"`
	WaitSelector string         `json:"wait_selector,omitempty"`
	Action       string         `json:"action,omitempty"`
	Description  string         `json:"description,omitempty"`
	Regions      []RegionTarget `json:"regions,omitempty"`
}

// OverviewSpec describes a clean overview page capture of the test UI.
type OverviewSpec struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	PagePath     string `json:"page_path"`
	WaitSelector string `json:"wait_selector"`
	Action       string `json:"action,omitempty"`
	Description  string `json:"description"`
}

// DefaultOverviewSpecs returns the fixed overview pages captured for every loop.
func DefaultOverviewSpecs() []OverviewSpec {
	return []OverviewSpec{
		{
			ID:           "overview-dashboard",
			Title:        "Test Dashboard Overview",
			PagePath:     "/",
			WaitSelector: `[data-testid="wm-shell"]`,
			Description:  "Full 1|2 split test dashboard showing the test table, wide and mobile CDP panels, and bottom pipeline bar.",
		},
		{
			ID:           "overview-menu",
			Title:        "Window Manager and Runner Menu",
			PagePath:     "/",
			WaitSelector: `[data-testid="menu-overlay"]`,
			Action:       "open-menu",
			Description:  "Menu overlay with tiling split layouts, pane assignments, multi-browser CDP controls, and runner toggles.",
		},
		{
			ID:           "overview-logs",
			Title:        "Immutable Test Logs Index",
			PagePath:     "/logs",
			WaitSelector: `main.log-page`,
			Description:  "Per-run log index linking each test execution to its formatted and raw log files.",
		},
	}
}

func testRowRegion(testName string) RegionTarget {
	return RegionTarget{
		Selector:       fmt.Sprintf(`tr[data-test-name="%s"]`, testName),
		Label:          "TEST ROW",
		Color:          "#38bdf8",
		ScrollIntoView: true,
	}
}

// DefaultRegionMap maps tests that exercise observable UI sections on
// test.dialtone.earth to their exact DOM selectors. Tests that do not target a
// UI region are intentionally omitted so they fall back cleanly with no overlay.
func DefaultRegionMap() map[string]TestCaptureSpec {
	m := map[string]TestCaptureSpec{
		"TestBrowser01SignedOutContainment": {
			TestName:     "TestBrowser01SignedOutContainment",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Signed-out containment and 401 checks projected across wide and mobile CDP viewports.",
			Regions: []RegionTarget{
				testRowRegion("TestBrowser01SignedOutContainment"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
				{Selector: `[data-testid="wm-pane-2"]`, Label: "MOBILE CDP 390x844", Color: "#f1c84b"},
				{Selector: `[data-testid="cdp-status"]`, Label: "CDP STATUS", Color: "#a78bfa"},
			},
		},
		"TestBrowser02MagicLinkLogin": {
			TestName:     "TestBrowser02MagicLinkLogin",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Magic-link sign-in flow and replay protection in the projected CDP browsers.",
			Regions: []RegionTarget{
				testRowRegion("TestBrowser02MagicLinkLogin"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
				{Selector: `[data-testid="wm-pane-2"]`, Label: "MOBILE CDP 390x844", Color: "#f1c84b"},
				{Selector: `[data-testid="run-browser-suite"]`, Label: "RUN BROWSER SUITE", Color: "#a78bfa"},
			},
		},
		"TestBrowser03GlobeOverlaysAndLANPaths": {
			TestName:     "TestBrowser03GlobeOverlaysAndLANPaths",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "3D H3 globe overlays, RTT arcs, and live test mesh host paths.",
			Regions: []RegionTarget{
				testRowRegion("TestBrowser03GlobeOverlaysAndLANPaths"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
				{Selector: `[data-testid="test-mesh-pill"]`, Label: "TEST MESH STATUS", Color: "#f1c84b"},
			},
		},
		"TestBrowser04LiveDialtoneShellAndRedaction": {
			TestName:     "TestBrowser04LiveDialtoneShellAndRedaction",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Live dialtone-shell session streaming and secret redaction on the test mesh.",
			Regions: []RegionTarget{
				testRowRegion("TestBrowser04LiveDialtoneShellAndRedaction"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
				{Selector: `[data-testid="test-mesh-pill"]`, Label: "TEST MESH STATUS", Color: "#f1c84b"},
			},
		},
		"TestBrowser05HostAndUsersPresence": {
			TestName:     "TestBrowser05HostAndUsersPresence",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Host drill-down and edge user presence projected into wide and mobile browsers.",
			Regions: []RegionTarget{
				testRowRegion("TestBrowser05HostAndUsersPresence"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
				{Selector: `[data-testid="wm-pane-2"]`, Label: "MOBILE CDP 390x844", Color: "#f1c84b"},
			},
		},
		"TestBrowser06LiveTestsAndLogProxy": {
			TestName:     "TestBrowser06LiveTestsAndLogProxy",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Live test table streaming and immutable run log proxy verification.",
			Regions: []RegionTarget{
				testRowRegion("TestBrowser06LiveTestsAndLogProxy"),
				{Selector: `[data-testid="wm-pane-0"]`, Label: "DB TESTS PANE", Color: "#2fd065"},
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#f1c84b"},
			},
		},
		"TestBrowser07Tiling2x2AndCFKV": {
			TestName:     "TestBrowser07Tiling2x2AndCFKV",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "2x2 desktop split layout paired with strict 1-column mobile viewport verification.",
			Regions: []RegionTarget{
				testRowRegion("TestBrowser07Tiling2x2AndCFKV"),
				{Selector: `[data-testid="split-grid"]`, Label: "TILING SPLIT GRID", Color: "#a78bfa"},
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
				{Selector: `[data-testid="wm-pane-2"]`, Label: "MOBILE CDP 390x844", Color: "#f1c84b"},
			},
		},
		"TestBrowser08CameraStudioTSAndReload": {
			TestName:     "TestBrowser08CameraStudioTSAndReload",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Camera Studio TypeScript policy execution and hard reload KV restore.",
			Regions: []RegionTarget{
				testRowRegion("TestBrowser08CameraStudioTSAndReload"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
				{Selector: `[data-testid="wm-pane-2"]`, Label: "MOBILE CDP 390x844", Color: "#f1c84b"},
			},
		},
		"TestBrowser09SignOutContainment": {
			TestName:     "TestBrowser09SignOutContainment",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Sign-out containment and persistent browser session handling.",
			Regions: []RegionTarget{
				testRowRegion("TestBrowser09SignOutContainment"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
				{Selector: `[data-testid="cdp-status"]`, Label: "CDP STATUS", Color: "#a78bfa"},
			},
		},
		"TestDialtoneEarthLiveMetalDaemonE2E": {
			TestName:     "TestDialtoneEarthLiveMetalDaemonE2E",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Live metal daemon data contract tracked in the test table and mesh status pill.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthLiveMetalDaemonE2E"),
				{Selector: `[data-testid="test-mesh-pill"]`, Label: "TEST MESH STATUS", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthMetalLiveBrowserE2E": {
			TestName:     "TestDialtoneEarthMetalLiveBrowserE2E",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Standalone Chrome CDP E2E walkthrough projected in browser panes.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthMetalLiveBrowserE2E"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthLiveMetalUIParity": {
			TestName:     "TestDialtoneEarthLiveMetalUIParity",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Live metal UI parity against simulated mode.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthLiveMetalUIParity"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthGlobeH3AndBundledArcs": {
			TestName:     "TestDialtoneEarthGlobeH3AndBundledArcs",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "H3 telemetry cluster cells and bundled arcs rendered in the preview browser.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthGlobeH3AndBundledArcs"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthTilingWindowManagerAndQueryRates": {
			TestName:     "TestDialtoneEarthTilingWindowManagerAndQueryRates",
			PagePath:     "/",
			WaitSelector: `[data-testid="menu-overlay"]`,
			Action:       "open-menu",
			Description:  "Tiling window manager layout options and pane assignment controls.",
			Regions: []RegionTarget{
				{Selector: `.cfg-layout-row`, Label: "TILING LAYOUTS", Color: "#38bdf8"},
				{Selector: `.cfg-pane-map`, Label: "PANE ASSIGNMENTS", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthCameraStudioTypeScript": {
			TestName:     "TestDialtoneEarthCameraStudioTypeScript",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Camera Studio TypeScript policy engine.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthCameraStudioTypeScript"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthCloudflareKVConfigAndTour": {
			TestName:     "TestDialtoneEarthCloudflareKVConfigAndTour",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Cloudflare KV UI configuration persistence and tour controls.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthCloudflareKVConfigAndTour"),
				{Selector: `[data-testid="pipeline-bar"]`, Label: "PIPELINE BAR", Color: "#f1c84b"},
			},
		},
		"TestDialtoneEarthSimulatedTour": {
			TestName:     "TestDialtoneEarthSimulatedTour",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Simulated network tour behavior displayed in the browser preview.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthSimulatedTour"),
				{Selector: `[data-testid="wm-pane-1"]`, Label: "WIDE CDP 1440x900", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthCloudflareGateway": {
			TestName:     "TestDialtoneEarthCloudflareGateway",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Cloudflare Worker gateway allowlist and staging gate verification.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthCloudflareGateway"),
				{Selector: `[data-testid="staging-gate-pill"]`, Label: "STAGING GATE", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthCloudflareRegistry": {
			TestName:     "TestDialtoneEarthCloudflareRegistry",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Cloudflare R2 and KV registry routes gating deploy readiness.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthCloudflareRegistry"),
				{Selector: `[data-testid="staging-gate-pill"]`, Label: "STAGING GATE", Color: "#2fd065"},
				{Selector: `[data-testid="deploy-live"]`, Label: "DEPLOY GATE", Color: "#f1c84b"},
			},
		},
		"TestDialtoneEarthOwnerOnlyAccess": {
			TestName:     "TestDialtoneEarthOwnerOnlyAccess",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Owner-only access enforcement on dialtone.earth and test.dialtone.earth.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthOwnerOnlyAccess"),
				{Selector: `[data-testid="staging-gate-pill"]`, Label: "STAGING GATE", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthLiveOwnerAccessOnCloudflare": {
			TestName:     "TestDialtoneEarthLiveOwnerAccessOnCloudflare",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Live Cloudflare owner-only verification for /code, /logs, and APIs.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthLiveOwnerAccessOnCloudflare"),
				{Selector: `[data-testid="run-prod-suite"]`, Label: "TEST LIVE BUTTON", Color: "#f1c84b"},
				{Selector: `[data-testid="pipeline-bar"]`, Label: "PIPELINE BAR", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthRegistrySecurityHeaders": {
			TestName:     "TestDialtoneEarthRegistrySecurityHeaders",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Security headers and CSP contract on served pages.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthRegistrySecurityHeaders"),
				{Selector: `[data-testid="staging-gate-pill"]`, Label: "STAGING GATE", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthOriginBridge": {
			TestName:     "TestDialtoneEarthOriginBridge",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Local staging origin bridge forwarding test.dialtone.earth to the dashboard.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthOriginBridge"),
				{Selector: `[data-testid="test-mesh-pill"]`, Label: "TEST MESH STATUS", Color: "#2fd065"},
			},
		},
		"TestDialtoneEarthRegistryNetworks": {
			TestName:     "TestDialtoneEarthRegistryNetworks",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Network catalog and telemetry fixtures.",
			Regions: []RegionTarget{
				testRowRegion("TestDialtoneEarthRegistryNetworks"),
				{Selector: `[data-testid="wm-pane-0"]`, Label: "DB TESTS PANE", Color: "#2fd065"},
			},
		},
		"TestProductionLiveSmoke": {
			TestName:     "TestProductionLiveSmoke",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Live production smoke suite triggered by the test live action and post-deploy verify stage.",
			Regions: []RegionTarget{
				testRowRegion("TestProductionLiveSmoke"),
				{Selector: `[data-testid="run-prod-suite"]`, Label: "TEST LIVE BUTTON", Color: "#f1c84b"},
				{Selector: `[data-testid="pipeline-bar"]`, Label: "PIPELINE BAR", Color: "#2fd065"},
			},
		},
		"TestDashboardReadsGeneratedState": {
			TestName:     "TestDashboardReadsGeneratedState",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Test dashboard table, Start tests trigger, and read-only state polling.",
			Regions: []RegionTarget{
				{Selector: `[data-testid="tests-db-table"]`, Label: "TESTS TABLE", Color: "#38bdf8"},
				{Selector: `[data-testid="start-tests"]`, Label: "START TESTS BUTTON", Color: "#2fd065"},
				{Selector: `[data-testid="pipeline-bar"]`, Label: "PIPELINE BAR", Color: "#f1c84b"},
			},
		},
		"TestGoTestOutputDrivesRunState": {
			TestName:     "TestGoTestOutputDrivesRunState",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Go test JSON event stream populating live test table rows and status counts.",
			Regions: []RegionTarget{
				testRowRegion("TestGoTestOutputDrivesRunState"),
				{Selector: `[data-testid="tests-db-table"]`, Label: "TESTS TABLE", Color: "#2fd065"},
				{Selector: `[data-testid="pipeline-bar"]`, Label: "PIPELINE BAR", Color: "#f1c84b"},
			},
		},
		"TestStructuredTestLogsIncludeTimestampLevelAndSource": {
			TestName:     "TestStructuredTestLogsIncludeTimestampLevelAndSource",
			PagePath:     "/logs",
			WaitSelector: `main.log-page`,
			Description:  "Structured UTC timestamp, level, and file:line log rendering on the run log page.",
			Regions: []RegionTarget{
				{Selector: `[data-testid="test-log-output"]`, Label: "STRUCTURED LOG OUTPUT", Color: "#38bdf8"},
				{Selector: `dl.run-details`, Label: "RUN METADATA", Color: "#2fd065"},
				{Selector: `[data-testid="test-run-command"]`, Label: "RERUN COMMAND", Color: "#f1c84b"},
			},
		},
		"TestEachRunKeepsItsOwnLog": {
			TestName:     "TestEachRunKeepsItsOwnLog",
			PagePath:     "/logs",
			WaitSelector: `main.log-page`,
			Description:  "Immutable per-execution log files linked from the test logs index.",
			Regions: []RegionTarget{
				{Selector: `main.log-page table.earth-table`, Label: "IMMUTABLE LOGS TABLE", Color: "#38bdf8"},
			},
		},
		"TestUIUnitTests": {
			TestName:     "TestUIUnitTests",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Test dashboard UI model and API unit test suite.",
			Regions: []RegionTarget{
				testRowRegion("TestUIUnitTests"),
				{Selector: `[data-testid="wm-pane-0"]`, Label: "DB TESTS PANE", Color: "#2fd065"},
				{Selector: `[data-testid="staging-gate-pill"]`, Label: "STAGING GATE", Color: "#f1c84b"},
			},
		},
		"TestWebUIInstallablePWA": {
			TestName:     "TestWebUIInstallablePWA",
			PagePath:     "/",
			WaitSelector: `[data-testid="wm-shell"]`,
			Description:  "Installable PWA shell of the test dashboard.",
			Regions: []RegionTarget{
				testRowRegion("TestWebUIInstallablePWA"),
				{Selector: `[data-testid="bottom-bar"]`, Label: "APP BOTTOM BAR", Color: "#2fd065"},
			},
		},
		"TestLintAllSources": {
			TestName:     "TestLintAllSources",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Go vet and UI TypeScript lint check tracked in the staging gate.",
			Regions: []RegionTarget{
				testRowRegion("TestLintAllSources"),
				{Selector: `[data-testid="staging-gate-pill"]`, Label: "STAGING GATE", Color: "#f1c84b"},
			},
		},
		"TestBuildArtifacts": {
			TestName:     "TestBuildArtifacts",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Go CLI and Vite UI production artifact build.",
			Regions: []RegionTarget{
				testRowRegion("TestBuildArtifacts"),
				{Selector: `[data-testid="deploy-live"]`, Label: "DEPLOY CONTROL", Color: "#2fd065"},
			},
		},
		"TestDeployLocalBundle": {
			TestName:     "TestDeployLocalBundle",
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "Safe local deploy bundle generation.",
			Regions: []RegionTarget{
				testRowRegion("TestDeployLocalBundle"),
				{Selector: `[data-testid="deploy-live"]`, Label: "DEPLOY CONTROL", Color: "#2fd065"},
			},
		},
	}
	return m
}

// LoadCustomRegionMap reads an optional JSON file mapping test names to TestCaptureSpec.
func LoadCustomRegionMap(path string) (map[string]TestCaptureSpec, error) {
	if strings.TrimSpace(path) == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read custom region map %s: %w", path, err)
	}
	var custom map[string]TestCaptureSpec
	if err := json.Unmarshal(raw, &custom); err != nil {
		return nil, fmt.Errorf("parse custom region map %s: %w", path, err)
	}
	for name, spec := range custom {
		if spec.TestName == "" {
			spec.TestName = name
		}
		if spec.PagePath == "" {
			spec.PagePath = "/"
		}
		custom[name] = spec
	}
	return custom, nil
}

// ResolveCaptureSpec returns the capture specification for a test entry.
// If the test does not declare any UI region, Regions is nil so the capture
// gracefully takes a clean screenshot without drawing a wrong highlight overlay.
func ResolveCaptureSpec(entry TestEntry, defaults, overrides map[string]TestCaptureSpec) TestCaptureSpec {
	var spec TestCaptureSpec
	var found bool
	if overrides != nil {
		spec, found = overrides[entry.Name]
	}
	if !found && defaults != nil {
		spec, found = defaults[entry.Name]
	}
	if !found {
		return TestCaptureSpec{
			TestName:     entry.Name,
			PagePath:     "/",
			WaitSelector: `[data-testid="tests-db-table"]`,
			Description:  "No UI region declared for this test; captured cleanly without highlight overlay.",
			Regions:      nil,
		}
	}

	// Clone regions so caller mutations cannot affect the map.
	cloned := spec
	if len(spec.Regions) > 0 {
		cloned.Regions = append([]RegionTarget(nil), spec.Regions...)
	}
	if cloned.TestName == "" {
		cloned.TestName = entry.Name
	}
	if cloned.PagePath == "" {
		cloned.PagePath = "/"
	}

	// For structured log tests, open the specific run log when a valid 32-hex test-id is available.
	if cloned.PagePath == "/logs" && isHexTestID(entry.TestID) &&
		entry.Name == "TestStructuredTestLogsIncludeTimestampLevelAndSource" {
		cloned.PagePath = "/logs?test-id=" + entry.TestID
		cloned.WaitSelector = `[data-testid="test-log-output"]`
	} else if cloned.PagePath == "/logs" && entry.Name == "TestStructuredTestLogsIncludeTimestampLevelAndSource" {
		// Without a test-id we stay on /logs index and highlight the logs table instead.
		cloned.WaitSelector = `main.log-page table.earth-table`
		cloned.Regions = []RegionTarget{
			{Selector: `main.log-page table.earth-table`, Label: "TEST LOGS TABLE", Color: "#38bdf8"},
		}
	}

	if cloned.WaitSelector == "" {
		if strings.HasPrefix(cloned.PagePath, "/logs") {
			cloned.WaitSelector = `main.log-page`
		} else {
			cloned.WaitSelector = `[data-testid="tests-db-table"]`
		}
	}
	return cloned
}

var hexTestIDRe = regexp.MustCompile(`^[a-f0-9]{32}$`)

func isHexTestID(id string) bool {
	return hexTestIDRe.MatchString(strings.TrimSpace(id))
}

var unsafeSlugRe = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

// SafeShotFilename produces a deterministic, URL-safe PNG filename for a shot.
func SafeShotFilename(prefix, name string) string {
	cleaned := unsafeSlugRe.ReplaceAllString(strings.TrimSpace(name), "-")
	cleaned = strings.Trim(cleaned, "-_")
	if cleaned == "" {
		cleaned = "shot"
	}
	if prefix != "" {
		return prefix + "-" + cleaned + ".png"
	}
	return cleaned + ".png"
}
