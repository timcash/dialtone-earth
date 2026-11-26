package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const defaultPublishBaseURL = "https://test.dialtone.earth"

// PublishOptions controls local dry-run vs explicit live upload to Cloudflare R2 via the Worker.
type PublishOptions struct {
	OutputDir   string
	PublishLive bool
	PublishURL  string
	Token       string
	HTTPClient  *http.Client
}

// PublishFileEntry describes one file in the stable-link bundle.
type PublishFileEntry struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Bytes       int    `json:"bytes"`
	SHA256      string `json:"sha256"`
	R2Key       string `json:"r2_key"`
	URL         string `json:"url"`
}

// PublishPlan records the deterministic overwrite plan for a screenshot loop.
type PublishPlan struct {
	Mode             string             `json:"mode"`
	Published        bool               `json:"published"`
	LoopID           string             `json:"loop_id"`
	StableURL        string             `json:"stable_url"`
	ManifestURL      string             `json:"manifest_url"`
	UploadBaseURL    string             `json:"upload_base_url"`
	CommitURL        string             `json:"commit_url"`
	R2Prefix         string             `json:"r2_prefix"`
	FileCount        int                `json:"file_count"`
	TotalBytes       int                `json:"total_bytes"`
	Files            []PublishFileEntry `json:"files"`
	RequiresApproval []string           `json:"requires_approval,omitempty"`
	PlannedAt        string             `json:"planned_at"`
	PublishedAt      string             `json:"published_at,omitempty"`
}

// BuildPublishPlan inspects OutputDir and builds the overwrite plan for the stable link.
func BuildPublishPlan(manifest *CaptureManifest, opts PublishOptions) (*PublishPlan, error) {
	if manifest == nil {
		return nil, errors.New("manifest is required")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(opts.PublishURL), "/")
	if baseURL == "" {
		baseURL = defaultPublishBaseURL
	}

	seen := map[string]bool{}
	var filenames []string
	addFile := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		filenames = append(filenames, name)
	}
	for _, s := range manifest.Shots {
		addFile(s.Filename)
	}
	addFile("manifest.json")
	addFile("index.html")
	sort.Strings(filenames)

	files := make([]PublishFileEntry, 0, len(filenames))
	totalBytes := 0
	for _, name := range filenames {
		full := filepath.Join(opts.OutputDir, name)
		data, err := os.ReadFile(full)
		if err != nil {
			return nil, fmt.Errorf("read bundle file %s: %w", full, err)
		}
		sum := sha256.Sum256(data)
		totalBytes += len(data)
		files = append(files, PublishFileEntry{
			Filename:    name,
			ContentType: contentTypeForFilename(name),
			Bytes:       len(data),
			SHA256:      hex.EncodeToString(sum[:]),
			R2Key:       "screenshots/latest/" + name,
			URL:         baseURL + "/screenshots/" + url.PathEscape(name),
		})
	}

	mode := "dry-run"
	var approval []string
	if opts.PublishLive {
		mode = "live"
	} else {
		approval = []string{
			"Deploy updated Cloudflare Worker (registry/worker/screenshots.ts + staging.ts) with `dialtone-earth deploy --live`",
			"Re-run screenshot publish with explicit `--publish-live` flag and owner LIVE_CONTROL_TOKEN",
		}
	}

	return &PublishPlan{
		Mode:             mode,
		Published:        false,
		LoopID:           manifest.LoopID,
		StableURL:        baseURL + "/screenshots/",
		ManifestURL:      baseURL + "/api/screenshots/latest",
		UploadBaseURL:    baseURL + "/api/screenshots/latest/files/",
		CommitURL:        baseURL + "/api/screenshots/latest/commit",
		R2Prefix:         "screenshots/latest/",
		FileCount:        len(files),
		TotalBytes:       totalBytes,
		Files:            files,
		RequiresApproval: approval,
		PlannedAt:        time.Now().UTC().Format(time.RFC3339),
	}, nil
}

// Publish defaults to local dry-run mode (writes publish-plan.json with zero
// network calls). Only when opts.PublishLive is true does it upload the bundle
// to the Worker R2 endpoint and atomically commit the latest manifest.
func Publish(ctx context.Context, manifest *CaptureManifest, opts PublishOptions, stdout io.Writer) (*PublishPlan, error) {
	if stdout == nil {
		stdout = io.Discard
	}
	plan, err := BuildPublishPlan(manifest, opts)
	if err != nil {
		return nil, err
	}

	if !opts.PublishLive {
		raw, err := json.MarshalIndent(plan, "", "  ")
		if err != nil {
			return nil, err
		}
		planPath := filepath.Join(opts.OutputDir, "publish-plan.json")
		if err := os.WriteFile(planPath, append(raw, '\n'), 0o644); err != nil {
			return nil, err
		}
		fmt.Fprintf(stdout, "publish [dry-run]: %d files (%s) staged locally at %s\n",
			plan.FileCount, formatBytes(plan.TotalBytes), opts.OutputDir)
		fmt.Fprintf(stdout, "publish [dry-run]: local gallery ready at %s\n", filepath.Join(opts.OutputDir, "index.html"))
		fmt.Fprintf(stdout, "publish [dry-run]: live stable target (requires --publish-live after Worker deploy): %s\n", plan.StableURL)
		return plan, nil
	}

	token := strings.TrimSpace(opts.Token)
	if token == "" {
		return nil, errors.New("--publish-live requires an owner Bearer token (--token-file or DIALTONE_LIVE_TOKEN)")
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}

	for _, entry := range plan.Files {
		data, err := os.ReadFile(filepath.Join(opts.OutputDir, entry.Filename))
		if err != nil {
			return nil, err
		}
		endpoint := plan.UploadBaseURL + url.PathEscape(entry.Filename)
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", entry.ContentType)
		req.Header.Set("X-Dialtone-Sha256", entry.SHA256)
		req.Header.Set("X-Dialtone-Loop-Id", manifest.LoopID)
		resp, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("PUT %s: %w", endpoint, err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("PUT %s returned HTTP %d: %s", endpoint, resp.StatusCode, strings.TrimSpace(string(body)))
		}
	}

	commitPayload := map[string]any{
		"loop_id":      manifest.LoopID,
		"generated_at": manifest.GeneratedAt,
		"files":        plan.Files,
		"manifest":     manifest,
	}
	commitBytes, err := json.Marshal(commitPayload)
	if err != nil {
		return nil, err
	}
	commitReq, err := http.NewRequestWithContext(ctx, http.MethodPost, plan.CommitURL, bytes.NewReader(commitBytes))
	if err != nil {
		return nil, err
	}
	commitReq.Header.Set("Authorization", "Bearer "+token)
	commitReq.Header.Set("Content-Type", "application/json")
	commitResp, err := client.Do(commitReq)
	if err != nil {
		return nil, fmt.Errorf("POST %s: %w", plan.CommitURL, err)
	}
	commitBody, _ := io.ReadAll(io.LimitReader(commitResp.Body, 64*1024))
	_ = commitResp.Body.Close()
	if commitResp.StatusCode < 200 || commitResp.StatusCode >= 300 {
		return nil, fmt.Errorf("POST %s returned HTTP %d: %s", plan.CommitURL, commitResp.StatusCode, strings.TrimSpace(string(commitBody)))
	}

	plan.Published = true
	plan.PublishedAt = time.Now().UTC().Format(time.RFC3339)
	fmt.Fprintf(stdout, "publish [live]: published %d files (%s) to %s (loop %s)\n",
		plan.FileCount, formatBytes(plan.TotalBytes), plan.StableURL, plan.LoopID)
	return plan, nil
}

func contentTypeForFilename(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		return "image/png"
	case ".html":
		return "text/html; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}
