package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const codeUsage = `usage: dialtone-earth code <subcommand> [flags]

Store and sync git code directly on Cloudflare R2 + KV (zero GitHub dependency).

Subcommands:
  list    List repositories stored on https://dialtone.earth/api/code
  status  Inspect stored branches, tags, and archives for a repository
  push    Pack git bundle + source archives to Cloudflare R2 (--live deploys immediately)
  pull    Fetch and fast-forward local git from Cloudflare R2
  clone   Clone a repository bundle directly from Cloudflare R2

Flags:
  --repo <name>        Repository slug (default: current directory name, e.g. dialtone-earth)
  --branch <name>      Git branch to push/pull (default: current branch or main)
  --tag <vX.Y.Z>       Optional release tag to attach on push
  --live               After pushing, immediately deploy live to https://dialtone.earth/
  --no-archive         Skip uploading main.tar.gz and main.zip source archives on push
  --url <url>          Registry base URL (default: https://dialtone.earth)
  --token-file <path>  Path to LIVE_CONTROL_TOKEN file (or set DIALTONE_LIVE_TOKEN)
  --json               Emit raw JSON response
`

const releaseUsage = `usage: dialtone-earth release <subcommand> [flags]

Tag and publish SHA-256-verified releases directly on Cloudflare R2 (zero GitHub dependency).

Subcommands:
  list              List tagged releases for a repository
  tag <vX.Y.Z>      Tag HEAD, push bundle, optionally cross-compile & upload binaries (--build)

Flags:
  --repo <name>        Repository slug (default: current directory name)
  --notes <text>       Release notes stored in Cloudflare KV
  --build              Cross-compile dialtone-earth binaries (win/linux/darwin) & upload to R2
  --live               After tagging, immediately deploy live to https://dialtone.earth/
  --url <url>          Registry base URL (default: https://dialtone.earth)
  --token-file <path>  Path to LIVE_CONTROL_TOKEN file (or set DIALTONE_LIVE_TOKEN)
  --json               Emit raw JSON response
`

const pluginsUsage = `usage: dialtone-earth plugins <subcommand> [flags]

Discover and publish public Dialtone plugins (e.g. dialtone-shell) on Cloudflare + Iroh.

Subcommands:
  list              List public Dialtone plugins from https://dialtone.earth/api/plugins
  info <name>       Show full manifest, SHA-256 digests, R2 URLs, and Iroh ticket
  publish <name>    Publish a plugin manifest (and optional binary asset) to Cloudflare

Flags for "plugins publish":
  --from-local         Read version/hashes/protocols from local 'dialtone plugin list --json' + 'share'
  --local-name <name>  Local dialtone plugin name when --from-local differs (e.g. shell for dialtone-shell)
  --version <ver>      Plugin version (e.g. 0.5.5)
  --description <txt>  Human-readable summary
  --protocols <csv>    Comma-separated RPC protocols (e.g. dialtone/shell/1)
  --repo <slug>        Source repository slug (e.g. dialtone-shell)
  --ticket <uri>       Iroh blob ticket for P2P install
  --file <path>        Optional binary file to upload to Cloudflare R2
  --asset <name>       Asset filename in R2 (default: basename of --file)
  --url <url>          Registry base URL (default: https://dialtone.earth)
  --token-file <path>  Path to LIVE_CONTROL_TOKEN file (or set DIALTONE_LIVE_TOKEN)
  --json               Emit raw JSON response
`

func defaultRepoSlug() string {
	wd, err := os.Getwd()
	if err != nil {
		return "dialtone-earth"
	}
	base := strings.ToLower(strings.TrimSpace(filepath.Base(wd)))
	if base == "" || base == "." || base == "/" {
		return "dialtone-earth"
	}
	return base
}

func runCode(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || isHelp(args[0]) {
		fmt.Fprint(stdout, codeUsage)
		return nil
	}
	switch args[0] {
	case "list":
		return runCodeList(args[1:], stdout, stderr)
	case "status":
		return runCodeStatus(args[1:], stdout, stderr)
	case "push":
		return runCodePush(args[1:], stdout, stderr)
	case "pull":
		return runCodePull(args[1:], stdout, stderr)
	case "clone":
		return runCodeClone(args[1:], stdout, stderr)
	default:
		fmt.Fprint(stderr, codeUsage)
		return fmt.Errorf("unknown code subcommand %q", args[0])
	}
}

func runRelease(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || isHelp(args[0]) {
		fmt.Fprint(stdout, releaseUsage)
		return nil
	}
	switch args[0] {
	case "list":
		return runReleaseList(args[1:], stdout, stderr)
	case "tag":
		return runReleaseTag(args[1:], stdout, stderr)
	default:
		fmt.Fprint(stderr, releaseUsage)
		return fmt.Errorf("unknown release subcommand %q", args[0])
	}
}

func runPlugins(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || isHelp(args[0]) {
		fmt.Fprint(stdout, pluginsUsage)
		return nil
	}
	switch args[0] {
	case "list":
		return runPluginsList(args[1:], stdout, stderr)
	case "info":
		return runPluginsInfo(args[1:], stdout, stderr)
	case "publish":
		return runPluginsPublish(args[1:], stdout, stderr)
	default:
		fmt.Fprint(stderr, pluginsUsage)
		return fmt.Errorf("unknown plugins subcommand %q", args[0])
	}
}

func registryHTTPDo(method, endpoint, token string, body io.Reader, headers map[string]string) ([]byte, http.Header, error) {
	req, err := http.NewRequest(method, endpoint, body)
	if err != nil {
		return nil, nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 128<<20))
	if err != nil {
		return nil, resp.Header, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.Header, fmt.Errorf("%s %s returned HTTP %d: %s", method, endpoint, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return data, resp.Header, nil
}

func runGitOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// ---------------------------------------------------------------------------
// code subcommands
// ---------------------------------------------------------------------------

func runCodeList(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("code list", flag.ContinueOnError)
	fs.SetOutput(stderr)
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	jsonOut := fs.Bool("json", false, "Emit raw JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	endpoint := strings.TrimRight(*baseURL, "/") + "/api/code"
	raw, _, err := registryHTTPDo(http.MethodGet, endpoint, "", nil, nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		_, err = stdout.Write(append(bytes.TrimSpace(raw), '\n'))
		return err
	}
	var payload struct {
		Repos []struct {
			Name          string   `json:"name"`
			DefaultBranch string   `json:"default_branch"`
			HeadSHA       string   `json:"head_sha"`
			HeadSubject   string   `json:"head_subject"`
			UpdatedAt     string   `json:"updated_at"`
			Tags          []string `json:"tags"`
		} `json:"repos"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	if len(payload.Repos) == 0 {
		fmt.Fprintln(stdout, "code: no repositories stored yet (run `dialtone-earth code push`)")
		return nil
	}
	for _, r := range payload.Repos {
		shortSHA := r.HeadSHA
		if len(shortSHA) > 10 {
			shortSHA = shortSHA[:10]
		}
		fmt.Fprintf(stdout, "%-20s %-8s %-10s tags=%d  %s\n", r.Name, r.DefaultBranch, shortSHA, len(r.Tags), r.HeadSubject)
	}
	return nil
}

func runCodeStatus(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("code status", flag.ContinueOnError)
	fs.SetOutput(stderr)
	repo := fs.String("repo", defaultRepoSlug(), "Repository slug")
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	jsonOut := fs.Bool("json", false, "Emit raw JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	endpoint := strings.TrimRight(*baseURL, "/") + "/api/code/" + url.PathEscape(*repo)
	raw, _, err := registryHTTPDo(http.MethodGet, endpoint, "", nil, nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		_, err = stdout.Write(append(bytes.TrimSpace(raw), '\n'))
		return err
	}
	var rec struct {
		Name          string   `json:"name"`
		DefaultBranch string   `json:"default_branch"`
		HeadSHA       string   `json:"head_sha"`
		HeadSubject   string   `json:"head_subject"`
		UpdatedAt     string   `json:"updated_at"`
		BundleURL     string   `json:"bundle_url"`
		Tags          []string `json:"tags"`
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "repo:    %s\nbranch:  %s\nhead:    %s (%s)\nupdated: %s\ntags:    %s\nbundle:  %s\n",
		rec.Name, rec.DefaultBranch, rec.HeadSHA, rec.HeadSubject, rec.UpdatedAt, strings.Join(rec.Tags, ", "), rec.BundleURL)
	return nil
}

func pushCodeBundle(dir, repo, branch, tag, baseURL, token string, includeArchives bool, stdout io.Writer) (string, error) {
	sha, err := runGitOutput(dir, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(branch) == "" {
		b, err := runGitOutput(dir, "rev-parse", "--abbrev-ref", "HEAD")
		if err != nil || b == "" || b == "HEAD" {
			branch = "main"
		} else {
			branch = b
		}
	}
	subject, _ := runGitOutput(dir, "log", "-1", "--pretty=%s")
	author, _ := runGitOutput(dir, "log", "-1", "--pretty=%an")

	tmpDir, err := os.MkdirTemp("", "dialtone-earth-bundle-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmpDir)

	bundlePath := filepath.Join(tmpDir, repo+".bundle")
	bundleArgs := []string{"bundle", "create", bundlePath, "HEAD"}
	if _, err := runGitOutput(dir, "rev-parse", "-q", "--verify", "refs/heads/"+branch); err == nil {
		bundleArgs = append(bundleArgs, "refs/heads/"+branch)
	}
	if tag != "" {
		if _, err := runGitOutput(dir, "rev-parse", "-q", "--verify", "refs/tags/"+tag); err == nil {
			bundleArgs = append(bundleArgs, "refs/tags/"+tag)
		}
	}
	if _, err := runGitOutput(dir, bundleArgs...); err != nil {
		return "", err
	}
	bundleData, err := os.ReadFile(bundlePath)
	if err != nil {
		return "", err
	}

	shallowRoots := ""
	if gitDir, err := runGitOutput(dir, "rev-parse", "--git-dir"); err == nil {
		shallowPath := filepath.Join(gitDir, "shallow")
		if !filepath.IsAbs(shallowPath) {
			shallowPath = filepath.Join(dir, shallowPath)
		}
		if rawShallow, err := os.ReadFile(shallowPath); err == nil {
			shallowRoots = strings.Join(strings.Fields(string(rawShallow)), ",")
		}
	}

	endpoint := strings.TrimRight(baseURL, "/") + "/api/code/" + url.PathEscape(repo) + "/push"
	raw, _, err := registryHTTPDo(http.MethodPut, endpoint, token, bytes.NewReader(bundleData), map[string]string{
		"Content-Type":       "application/octet-stream",
		"X-Dialtone-Branch":  branch,
		"X-Dialtone-Sha":     sha,
		"X-Dialtone-Subject": subject,
		"X-Dialtone-Author":  author,
		"X-Dialtone-Tag":     tag,
		"X-Dialtone-Shallow": shallowRoots,
	})
	if err != nil {
		return "", err
	}
	var pushResp struct {
		BundleBytes  int    `json:"bundle_bytes"`
		BundleSHA256 string `json:"bundle_sha256"`
		BundleURL    string `json:"bundle_url"`
	}
	_ = json.Unmarshal(raw, &pushResp)
	fmt.Fprintf(stdout, "code push: %s@%s (%s) -> %s (%d bytes, sha256:%s)\n",
		repo, branch, sha[:minInt(10, len(sha))], pushResp.BundleURL, pushResp.BundleBytes, pushResp.BundleSHA256[:minInt(12, len(pushResp.BundleSHA256))])

	if includeArchives {
		for _, spec := range []struct {
			format string
			name   string
		}{
			{"tar.gz", branch + ".tar.gz"},
			{"zip", branch + ".zip"},
		} {
			archPath := filepath.Join(tmpDir, spec.name)
			if _, err := runGitOutput(dir, "archive", "--format="+spec.format, "--prefix="+repo+"/", "-o", archPath, "HEAD"); err != nil {
				return sha, err
			}
			archBytes, err := os.ReadFile(archPath)
			if err != nil {
				return sha, err
			}
			archEndpoint := strings.TrimRight(baseURL, "/") + "/api/code/" + url.PathEscape(repo) + "/archive/" + url.PathEscape(spec.name)
			if _, _, err := registryHTTPDo(http.MethodPut, archEndpoint, token, bytes.NewReader(archBytes), map[string]string{
				"Content-Type": "application/octet-stream",
			}); err != nil {
				return sha, err
			}
			fmt.Fprintf(stdout, "code archive: uploaded %s (%d bytes) -> %s\n", spec.name, len(archBytes), archEndpoint)
		}
	}
	return sha, nil
}

func runCodePush(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("code push", flag.ContinueOnError)
	fs.SetOutput(stderr)
	repo := fs.String("repo", defaultRepoSlug(), "Repository slug")
	branch := fs.String("branch", "", "Git branch name (default: current branch)")
	tag := fs.String("tag", "", "Optional release tag (e.g. v0.6.0)")
	live := fs.Bool("live", false, "Deploy live to https://dialtone.earth/ immediately after pushing")
	noArchive := fs.Bool("no-archive", false, "Skip uploading source tar.gz and zip archives")
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	tokenFile := fs.String("token-file", "", "Path to LIVE_CONTROL_TOKEN file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	token, err := loadLiveControlToken(*tokenFile)
	if err != nil {
		return err
	}
	wd, err := os.Getwd()
	if err != nil {
		return err
	}
	if _, err := pushCodeBundle(wd, *repo, *branch, *tag, *baseURL, token, !*noArchive, stdout); err != nil {
		return err
	}
	if *live {
		return runDeployLive(stdout, stderr)
	}
	return nil
}

func runCodePull(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("code pull", flag.ContinueOnError)
	fs.SetOutput(stderr)
	repo := fs.String("repo", defaultRepoSlug(), "Repository slug")
	branch := fs.String("branch", "main", "Git branch to pull")
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	if err := fs.Parse(args); err != nil {
		return err
	}
	endpoint := strings.TrimRight(*baseURL, "/") + "/api/code/" + url.PathEscape(*repo) + "/bundle?branch=" + url.QueryEscape(*branch)
	raw, _, err := registryHTTPDo(http.MethodGet, endpoint, "", nil, nil)
	if err != nil {
		return err
	}
	tmpDir, err := os.MkdirTemp("", "dialtone-earth-pull-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)
	bundlePath := filepath.Join(tmpDir, *repo+".bundle")
	if err := os.WriteFile(bundlePath, raw, 0o600); err != nil {
		return err
	}
	wd, err := os.Getwd()
	if err != nil {
		return err
	}
	refspec := fmt.Sprintf("refs/heads/%s:refs/remotes/cloudflare/%s", *branch, *branch)
	if _, err := runGitOutput(wd, "fetch", bundlePath, refspec); err != nil {
		return err
	}
	if out, err := runGitOutput(wd, "merge", "--ff-only", "refs/remotes/cloudflare/"+*branch); err != nil {
		fmt.Fprintf(stdout, "code pull: fetched refs/remotes/cloudflare/%s (fast-forward skipped: %v)\n", *branch, err)
	} else {
		fmt.Fprintf(stdout, "code pull: %s (%s)\n", *repo, out)
	}
	return nil
}

func runCodeClone(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("code clone", flag.ContinueOnError)
	fs.SetOutput(stderr)
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 || fs.NArg() > 2 {
		return errors.New("usage: dialtone-earth code clone <repo> [dir]")
	}
	repo := fs.Arg(0)
	targetDir := repo
	if fs.NArg() == 2 {
		targetDir = fs.Arg(1)
	}
	endpoint := strings.TrimRight(*baseURL, "/") + "/api/code/" + url.PathEscape(repo) + "/bundle"
	raw, respHeaders, err := registryHTTPDo(http.MethodGet, endpoint, "", nil, nil)
	if err != nil {
		return err
	}
	tmpDir, err := os.MkdirTemp("", "dialtone-earth-clone-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)
	bundlePath := filepath.Join(tmpDir, repo+".bundle")
	if err := os.WriteFile(bundlePath, raw, 0o600); err != nil {
		return err
	}
	wd, err := os.Getwd()
	if err != nil {
		return err
	}
	shallow := strings.TrimSpace(respHeaders.Get("X-Dialtone-Shallow"))
	branch := strings.TrimSpace(respHeaders.Get("X-Dialtone-Branch"))
	if branch == "" {
		branch = "main"
	}
	if shallow != "" {
		absTarget := targetDir
		if !filepath.IsAbs(absTarget) {
			absTarget = filepath.Join(wd, targetDir)
		}
		if _, err := runGitOutput(wd, "init", "-b", branch, absTarget); err != nil {
			return err
		}
		var lines []string
		for _, tok := range strings.Split(shallow, ",") {
			if tok = strings.TrimSpace(tok); tok != "" {
				lines = append(lines, tok)
			}
		}
		if err := os.WriteFile(filepath.Join(absTarget, ".git", "shallow"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
			return err
		}
		if _, err := runGitOutput(absTarget, "fetch", bundlePath, "refs/heads/"+branch+":refs/remotes/cloudflare/"+branch, "refs/tags/*:refs/tags/*"); err != nil {
			return err
		}
		if _, err := runGitOutput(absTarget, "checkout", "-B", branch, "refs/remotes/cloudflare/"+branch); err != nil {
			return err
		}
	} else {
		if _, err := runGitOutput(wd, "clone", bundlePath, targetDir); err != nil {
			return err
		}
	}
	fmt.Fprintf(stdout, "code clone: cloned %s from Cloudflare R2 into %s\n", repo, targetDir)
	return nil
}

// ---------------------------------------------------------------------------
// release subcommands
// ---------------------------------------------------------------------------

func runReleaseList(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("release list", flag.ContinueOnError)
	fs.SetOutput(stderr)
	repo := fs.String("repo", defaultRepoSlug(), "Repository slug")
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	jsonOut := fs.Bool("json", false, "Emit raw JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	endpoint := strings.TrimRight(*baseURL, "/") + "/api/releases/" + url.PathEscape(*repo)
	raw, _, err := registryHTTPDo(http.MethodGet, endpoint, "", nil, nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		_, err = stdout.Write(append(bytes.TrimSpace(raw), '\n'))
		return err
	}
	var payload struct {
		Repo     string `json:"repo"`
		Releases []struct {
			Tag          string                 `json:"tag"`
			SHA          string                 `json:"sha"`
			Notes        string                 `json:"notes"`
			CreatedAt    string                 `json:"created_at"`
			DownloadBase string                 `json:"download_base"`
			Assets       map[string]interface{} `json:"assets"`
		} `json:"releases"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	if len(payload.Releases) == 0 {
		fmt.Fprintf(stdout, "release: no tagged releases for %s yet (run `dialtone-earth release tag v0.6.0 --build`)\n", *repo)
		return nil
	}
	for _, rel := range payload.Releases {
		shortSHA := rel.SHA
		if len(shortSHA) > 10 {
			shortSHA = shortSHA[:10]
		}
		fmt.Fprintf(stdout, "%-12s %-10s assets=%-2d %s  (%s)\n", rel.Tag, shortSHA, len(rel.Assets), rel.Notes, rel.DownloadBase)
	}
	return nil
}

func runReleaseTag(args []string, stdout, stderr io.Writer) error {
	// Accept positional tag before or after flags so both `release tag v0.6.0 --build` and `release tag --build v0.6.0` work.
	var tag string
	var flagArgs []string
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "-") && tag == "" {
			tag = args[i]
			continue
		}
		flagArgs = append(flagArgs, args[i])
		if strings.HasPrefix(args[i], "-") && !strings.Contains(args[i], "=") &&
			args[i] != "--build" && args[i] != "-build" &&
			args[i] != "--live" && args[i] != "-live" &&
			args[i] != "--json" && args[i] != "-json" &&
			i+1 < len(args) {
			i++
			flagArgs = append(flagArgs, args[i])
		}
	}

	fs := flag.NewFlagSet("release tag", flag.ContinueOnError)
	fs.SetOutput(stderr)
	repo := fs.String("repo", defaultRepoSlug(), "Repository slug")
	notes := fs.String("notes", "", "Release notes")
	build := fs.Bool("build", false, "Cross-compile and upload platform binaries to Cloudflare R2")
	live := fs.Bool("live", false, "Deploy live to https://dialtone.earth/ after tagging")
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	tokenFile := fs.String("token-file", "", "Path to LIVE_CONTROL_TOKEN file")
	if err := fs.Parse(flagArgs); err != nil {
		return err
	}
	if tag == "" && fs.NArg() > 0 {
		tag = fs.Arg(0)
	}
	if tag == "" {
		return errors.New("usage: dialtone-earth release tag <vX.Y.Z> [--notes ...] [--build] [--live]")
	}
	token, err := loadLiveControlToken(*tokenFile)
	if err != nil {
		return err
	}
	wd, err := os.Getwd()
	if err != nil {
		return err
	}
	// Create local git tag if not already present.
	if _, err := runGitOutput(wd, "rev-parse", "-q", "--verify", "refs/tags/"+tag); err != nil {
		msg := *notes
		if msg == "" {
			msg = "Release " + tag
		}
		if _, err := runGitOutput(wd, "tag", "-a", tag, "-m", msg); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "release: created local git tag %s\n", tag)
	}

	sha, err := pushCodeBundle(wd, *repo, "", tag, *baseURL, token, true, stdout)
	if err != nil {
		return err
	}

	host, _ := os.Hostname()
	relBody, _ := json.Marshal(map[string]any{
		"sha":          sha,
		"notes":        *notes,
		"published_by": "cli@" + strings.ToLower(strings.TrimSpace(host)),
	})
	relEndpoint := strings.TrimRight(*baseURL, "/") + "/api/releases/" + url.PathEscape(*repo) + "/" + url.PathEscape(tag)
	if _, _, err := registryHTTPDo(http.MethodPost, relEndpoint, token, bytes.NewReader(relBody), map[string]string{
		"Content-Type": "application/json",
	}); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "release: published %s %s (%s)\n", *repo, tag, sha[:minInt(10, len(sha))])

	if *build {
		targets := []struct {
			goos   string
			goarch string
			asset  string
		}{
			{"windows", "amd64", *repo + "-windows-amd64.exe"},
			{"windows", "arm64", *repo + "-windows-arm64.exe"},
			{"linux", "amd64", *repo + "-linux-amd64"},
			{"linux", "arm64", *repo + "-linux-arm64"},
			{"darwin", "amd64", *repo + "-darwin-amd64"},
			{"darwin", "arm64", *repo + "-darwin-arm64"},
		}
		tmpDir, err := os.MkdirTemp("", "dialtone-earth-release-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(tmpDir)

		for _, t := range targets {
			outFile := filepath.Join(tmpDir, t.asset)
			cmd := exec.Command("go", "build", "-trimpath", "-o", outFile, ".")
			cmd.Dir = wd
			cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+t.goos, "GOARCH="+t.goarch)
			if out, err := cmd.CombinedOutput(); err != nil {
				return fmt.Errorf("build %s: %w\n%s", t.asset, err, string(out))
			}
			binBytes, err := os.ReadFile(outFile)
			if err != nil {
				return err
			}
			assetEndpoint := strings.TrimRight(*baseURL, "/") + "/api/releases/" + url.PathEscape(*repo) + "/" + url.PathEscape(tag) + "/assets/" + url.PathEscape(t.asset)
			raw, _, err := registryHTTPDo(http.MethodPut, assetEndpoint, token, bytes.NewReader(binBytes), map[string]string{
				"Content-Type": "application/octet-stream",
			})
			if err != nil {
				return err
			}
			var up struct {
				SHA256      string `json:"sha256"`
				DownloadURL string `json:"download_url"`
			}
			_ = json.Unmarshal(raw, &up)
			fmt.Fprintf(stdout, "release asset: %-34s (%d bytes) sha256:%s -> %s\n",
				t.asset, len(binBytes), up.SHA256[:minInt(12, len(up.SHA256))], up.DownloadURL)
		}
	}

	if *live {
		return runDeployLive(stdout, stderr)
	}
	return nil
}

// ---------------------------------------------------------------------------
// plugins subcommands
// ---------------------------------------------------------------------------

func runPluginsList(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("plugins list", flag.ContinueOnError)
	fs.SetOutput(stderr)
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	jsonOut := fs.Bool("json", false, "Emit raw JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	endpoint := strings.TrimRight(*baseURL, "/") + "/api/plugins"
	raw, _, err := registryHTTPDo(http.MethodGet, endpoint, "", nil, nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		_, err = stdout.Write(append(bytes.TrimSpace(raw), '\n'))
		return err
	}
	var payload struct {
		Plugins []struct {
			Name        string   `json:"name"`
			Version     string   `json:"version"`
			Description string   `json:"description"`
			Protocols   []string `json:"protocols"`
			Bytes       int      `json:"bytes"`
			IrohTicket  string   `json:"iroh_ticket"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	if len(payload.Plugins) == 0 {
		fmt.Fprintln(stdout, "plugins: no public Dialtone plugins published yet")
		return nil
	}
	for _, p := range payload.Plugins {
		proto := strings.Join(p.Protocols, ",")
		if proto == "" {
			proto = "-"
		}
		ticketFlag := "no-ticket"
		if strings.TrimSpace(p.IrohTicket) != "" {
			ticketFlag = "iroh-ticket"
		}
		fmt.Fprintf(stdout, "%-18s v%-8s %-20s %-11s %s\n", p.Name, p.Version, proto, ticketFlag, p.Description)
	}
	return nil
}

func runPluginsInfo(args []string, stdout, stderr io.Writer) error {
	var name string
	var flagArgs []string
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "-") && name == "" {
			name = args[i]
			continue
		}
		flagArgs = append(flagArgs, args[i])
		if strings.HasPrefix(args[i], "-") && !strings.Contains(args[i], "=") && args[i] != "--json" && i+1 < len(args) {
			i++
			flagArgs = append(flagArgs, args[i])
		}
	}
	fs := flag.NewFlagSet("plugins info", flag.ContinueOnError)
	fs.SetOutput(stderr)
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	jsonOut := fs.Bool("json", false, "Emit raw JSON")
	if err := fs.Parse(flagArgs); err != nil {
		return err
	}
	if name == "" && fs.NArg() > 0 {
		name = fs.Arg(0)
	}
	if name == "" {
		return errors.New("usage: dialtone-earth plugins info <name>")
	}
	endpoint := strings.TrimRight(*baseURL, "/") + "/api/plugins/" + url.PathEscape(name)
	raw, _, err := registryHTTPDo(http.MethodGet, endpoint, "", nil, nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		_, err = stdout.Write(append(bytes.TrimSpace(raw), '\n'))
		return err
	}
	var p struct {
		Name         string            `json:"name"`
		Version      string            `json:"version"`
		Description  string            `json:"description"`
		Protocols    []string          `json:"protocols"`
		Repo         string            `json:"repo"`
		IrohTicket   string            `json:"iroh_ticket"`
		Blake3Hash   string            `json:"blake3_hash"`
		BlobDigest   string            `json:"blob_digest"`
		Bytes        int               `json:"bytes"`
		UpdatedAt    string            `json:"updated_at"`
		DownloadURLs map[string]string `json:"download_urls"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "plugin:      %s (v%s)\ndescription: %s\nprotocols:   %s\nrepo:        %s\ndigest:      %s\nblake3:      %s\nbytes:       %d\nupdated:     %s\n",
		p.Name, p.Version, p.Description, strings.Join(p.Protocols, ", "), p.Repo, p.BlobDigest, p.Blake3Hash, p.Bytes, p.UpdatedAt)
	if p.IrohTicket != "" {
		fmt.Fprintf(stdout, "iroh-ticket: %s\n", p.IrohTicket)
		fmt.Fprintf(stdout, "install:     dialtone install %s --ticket %q\n", strings.TrimPrefix(p.Name, "dialtone-"), p.IrohTicket)
	}
	for asset, dl := range p.DownloadURLs {
		fmt.Fprintf(stdout, "asset:       %s -> %s\n", asset, dl)
	}
	return nil
}

func runPluginsPublish(args []string, stdout, stderr io.Writer) error {
	var name string
	var flagArgs []string
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "-") && name == "" {
			name = args[i]
			continue
		}
		flagArgs = append(flagArgs, args[i])
		if strings.HasPrefix(args[i], "-") && !strings.Contains(args[i], "=") &&
			args[i] != "--from-local" && args[i] != "-from-local" &&
			args[i] != "--json" && args[i] != "-json" &&
			i+1 < len(args) {
			i++
			flagArgs = append(flagArgs, args[i])
		}
	}
	fs := flag.NewFlagSet("plugins publish", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fromLocal := fs.Bool("from-local", false, "Read metadata & Iroh ticket from local dialtone daemon")
	localName := fs.String("local-name", "", "Local plugin name in dialtone daemon (default: name without dialtone- prefix)")
	version := fs.String("version", "", "Plugin version")
	description := fs.String("description", "", "Plugin description")
	protocolsCSV := fs.String("protocols", "", "Comma-separated RPC protocols")
	repo := fs.String("repo", "", "Source repository slug")
	ticket := fs.String("ticket", "", "Iroh blob ticket")
	filePath := fs.String("file", "", "Optional plugin binary file to upload to R2")
	assetName := fs.String("asset", "", "Asset filename in R2")
	baseURL := fs.String("url", defaultLiveSiteURL, "Registry base URL")
	tokenFile := fs.String("token-file", "", "Path to LIVE_CONTROL_TOKEN file")
	if err := fs.Parse(flagArgs); err != nil {
		return err
	}
	if name == "" && fs.NArg() > 0 {
		name = fs.Arg(0)
	}
	if name == "" {
		return errors.New("usage: dialtone-earth plugins publish <name> [--from-local] [--version ...] [--file ...]")
	}
	token, err := loadLiveControlToken(*tokenFile)
	if err != nil {
		return err
	}

	payload := map[string]any{
		"repo": name,
	}

	if *fromLocal {
		ln := strings.TrimSpace(*localName)
		if ln == "" {
			ln = strings.TrimPrefix(name, "dialtone-")
		}
		dtBin := findLocalDialtoneBinary()
		if dtBin == "" {
			return errors.New("--from-local requires local dialtone binary (~/.dialtone/bin/dialtone)")
		}
		listOut, err := exec.Command(dtBin, "plugin", "list", "--json").Output()
		if err != nil {
			return fmt.Errorf("dialtone plugin list --json: %w", err)
		}
		var parsed struct {
			Plugins []struct {
				Manifest struct {
					Name        string   `json:"name"`
					Version     string   `json:"version"`
					Description string   `json:"description"`
					Kind        string   `json:"kind"`
					Protocols   []string `json:"protocols"`
					Blake3Hash  string   `json:"blake3_hash"`
					BlobDigest  string   `json:"blob_digest"`
					Bytes       int      `json:"bytes"`
				} `json:"manifest"`
			} `json:"plugins"`
		}
		if err := json.Unmarshal(listOut, &parsed); err != nil {
			return err
		}
		found := false
		for _, item := range parsed.Plugins {
			if item.Manifest.Name == ln || "dialtone-"+item.Manifest.Name == name {
				found = true
				payload["version"] = item.Manifest.Version
				payload["description"] = item.Manifest.Description
				payload["kind"] = item.Manifest.Kind
				payload["protocols"] = item.Manifest.Protocols
				payload["blake3_hash"] = item.Manifest.Blake3Hash
				payload["blob_digest"] = item.Manifest.BlobDigest
				payload["bytes"] = item.Manifest.Bytes
				break
			}
		}
		if !found {
			return fmt.Errorf("local dialtone plugin %q not found in `dialtone plugin list --json`", ln)
		}
		if shareOut, err := exec.Command(dtBin, "plugin", "share", ln).CombinedOutput(); err == nil {
			for _, tok := range strings.Fields(string(shareOut)) {
				if strings.HasPrefix(tok, "iroh-blobs://") || strings.HasPrefix(tok, "blob") {
					payload["iroh_ticket"] = strings.TrimSpace(tok)
					break
				}
			}
		}
	}

	if *version != "" {
		payload["version"] = *version
	}
	if *description != "" {
		payload["description"] = *description
	}
	if *protocolsCSV != "" {
		var protos []string
		for _, p := range strings.Split(*protocolsCSV, ",") {
			if p = strings.TrimSpace(p); p != "" {
				protos = append(protos, p)
			}
		}
		payload["protocols"] = protos
	}
	if *repo != "" {
		payload["repo"] = *repo
	}
	if *ticket != "" {
		payload["iroh_ticket"] = *ticket
	}

	rawReq, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint := strings.TrimRight(*baseURL, "/") + "/api/plugins/" + url.PathEscape(name)
	if _, _, err := registryHTTPDo(http.MethodPut, endpoint, token, bytes.NewReader(rawReq), map[string]string{
		"Content-Type": "application/json",
	}); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "plugins publish: published %s -> %s\n", name, endpoint)

	if *filePath != "" {
		binBytes, err := os.ReadFile(*filePath)
		if err != nil {
			return err
		}
		asset := strings.TrimSpace(*assetName)
		if asset == "" {
			asset = filepath.Base(*filePath)
		}
		assetEndpoint := strings.TrimRight(*baseURL, "/") + "/api/plugins/" + url.PathEscape(name) + "/assets/" + url.PathEscape(asset)
		raw, _, err := registryHTTPDo(http.MethodPut, assetEndpoint, token, bytes.NewReader(binBytes), map[string]string{
			"Content-Type": "application/octet-stream",
		})
		if err != nil {
			return err
		}
		var up struct {
			SHA256      string `json:"sha256"`
			DownloadURL string `json:"download_url"`
		}
		_ = json.Unmarshal(raw, &up)
		fmt.Fprintf(stdout, "plugins asset:   %s (%d bytes, sha256:%s) -> %s\n",
			asset, len(binBytes), up.SHA256[:minInt(12, len(up.SHA256))], up.DownloadURL)
	}
	return nil
}

func findLocalDialtoneBinary() string {
	exe := "dialtone"
	if runtime.GOOS == "windows" {
		exe = "dialtone.exe"
	}
	home, _ := os.UserHomeDir()
	candidates := []string{
		os.Getenv("DIALTONE_BIN"),
		filepath.Join(home, ".dialtone", "bin", exe),
		filepath.Join(home, ".local", "bin", exe),
	}
	for _, c := range candidates {
		if c != "" && fileExists(c) {
			return c
		}
	}
	if p, err := exec.LookPath(exe); err == nil {
		return p
	}
	return ""
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
