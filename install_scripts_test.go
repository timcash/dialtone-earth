package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWrapperScriptRunsHelpAndAuthStatus(t *testing.T) {
	root, err := projectRoot()
	if err != nil {
		t.Fatal(err)
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		ps, err := exec.LookPath("powershell")
		if err != nil {
			t.Skip("powershell not available")
		}
		cmd = exec.Command(ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(root, "dialtone-earth.ps1"), "help")
	} else {
		cmd = exec.Command("sh", filepath.Join(root, "dialtone-earth.sh"), "help")
	}
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wrapper help failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "usage: dialtone-earth <action>") {
		t.Fatalf("unexpected wrapper help output:\n%s", out)
	}
}

func TestInstallScriptVerifiesSHA256ReleaseBinary(t *testing.T) {
	root, err := projectRoot()
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("synthetic-dialtone-earth-release-binary-payload-v0.1.0\n")
	sum := sha256.Sum256(payload)
	sumHex := hex.EncodeToString(sum[:])

	var asset string
	switch runtime.GOOS {
	case "windows":
		if runtime.GOARCH == "arm64" {
			asset = "dialtone-earth-windows-arm64.exe"
		} else {
			asset = "dialtone-earth-windows-amd64.exe"
		}
	case "darwin":
		if runtime.GOARCH == "arm64" {
			asset = "dialtone-earth-darwin-arm64"
		} else {
			asset = "dialtone-earth-darwin-amd64"
		}
	default:
		if runtime.GOARCH == "arm64" {
			asset = "dialtone-earth-linux-arm64"
		} else {
			asset = "dialtone-earth-linux-amd64"
		}
	}

	corruptChecksum := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/download/v0.1.0/" + asset:
			_, _ = w.Write(payload)
		case "/download/v0.1.0/" + asset + ".sha256":
			h := sumHex
			if corruptChecksum {
				h = strings.Repeat("0", 64)
			}
			_, _ = w.Write([]byte(h + "  " + asset + "\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	installDir := filepath.Join(t.TempDir(), "bin")
	runInstaller := func() ([]byte, error) {
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			ps, err := exec.LookPath("powershell")
			if err != nil {
				t.Skip("powershell not available")
			}
			cmd = exec.Command(ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(root, "install.ps1"), "-Version", "v0.1.0", "-InstallDir", installDir)
		} else {
			cmd = exec.Command("sh", filepath.Join(root, "install.sh"), "--version", "v0.1.0", "--install-dir", installDir)
		}
		cmd.Env = append(os.Environ(), "DIALTONE_EARTH_RELEASE_BASE_URL="+srv.URL)
		return cmd.CombinedOutput()
	}

	out, err := runInstaller()
	if err != nil {
		t.Fatalf("verified release install failed: %v\n%s", err, out)
	}
	installedPath := filepath.Join(installDir, binaryName())
	got, err := os.ReadFile(installedPath)
	if err != nil || string(got) != string(payload) {
		t.Fatalf("installed binary mismatch: err=%v len=%d", err, len(got))
	}

	// Corrupt checksum must fail closed and preserve the previous installed binary.
	corruptChecksum = true
	if out, err = runInstaller(); err == nil {
		t.Fatalf("corrupted checksum was accepted:\n%s", out)
	}
	gotAfter, err := os.ReadFile(installedPath)
	if err != nil || string(gotAfter) != string(payload) {
		t.Fatalf("previous binary was not preserved after SHA-256 mismatch: err=%v", err)
	}
}
