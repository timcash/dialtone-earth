package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScreenshotsHelpAndFlagValidation(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := Run([]string{"screenshots", "help"}, &stdout, &stderr); code != 0 {
		t.Fatalf("screenshots help code = %d, stderr = %s", code, stderr.String())
	}
	out := stdout.String()
	for _, want := range []string{"--dashboard-url", "--output-dir", "--publish-live", "dry-run"} {
		if !strings.Contains(out, want) {
			t.Errorf("screenshots help missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "\u2014") {
		t.Fatal("screenshots help must not contain em-dashes")
	}

	stdout.Reset()
	stderr.Reset()
	if code := Run([]string{"screenshots", "unexpected-positional"}, &stdout, &stderr); code == 0 {
		t.Fatal("screenshots accepted unexpected positional argument")
	}
}

func TestRecordScreenshotsInPipelineUpdatesMetadata(t *testing.T) {
	root := t.TempDir()
	outDir := filepath.Join(root, "logs", "screenshots", "latest")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writePipelineState(root, pipelineState{
		Stage:   "staging_ready",
		Message: "Ready",
		Passed:  10,
		Total:   10,
	})
	manifest := `{
  "loop_id": "20261125-190000Z-abc123",
  "generated_at": "2026-11-25T19:00:00Z",
  "stable_url": "https://test.dialtone.earth/screenshots/",
  "total_shots": 13,
  "annotated_shots": 8,
  "fallback_shots": 2
}`
	if err := os.WriteFile(filepath.Join(outDir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}

	// Dry-run updates pipeline with local stable path /screenshots/.
	recordScreenshotsInPipeline(root, outDir, false, "https://test.dialtone.earth")
	pipe := readPipelineState(root)
	if pipe.ScreenshotsURL != "/screenshots/" {
		t.Fatalf("dry-run ScreenshotsURL = %q, want /screenshots/", pipe.ScreenshotsURL)
	}
	if pipe.ScreenshotsCount != 13 || pipe.ScreenshotsAnnotated != 8 || pipe.ScreenshotsLoopID != "20261125-190000Z-abc123" {
		raw, _ := json.Marshal(pipe)
		t.Fatalf("unexpected pipeline metadata: %s", string(raw))
	}

	// Live publish records full stable URL.
	recordScreenshotsInPipeline(root, outDir, true, "https://test.dialtone.earth")
	pipeLive := readPipelineState(root)
	if pipeLive.ScreenshotsURL != "https://test.dialtone.earth/screenshots/" {
		t.Fatalf("live ScreenshotsURL = %q, want https://test.dialtone.earth/screenshots/", pipeLive.ScreenshotsURL)
	}
}

func TestScreenshotsToolModuleVetAndTests(t *testing.T) {
	runToolInDir(t, filepath.Join("tools", "screenshots"), "go", "vet", "./...")
	runToolInDir(t, filepath.Join("tools", "screenshots"), "go", "test", "-count=1", "./...")
}
