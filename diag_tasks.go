package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const diagTaskTag = "diagnostic"

// DiagTask models one dialtone-task record used by diagnostic task sync.
type DiagTask struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Status  string   `json:"status"`
	Note    string   `json:"note"`
	Tags    []string `json:"tags"`
	Deleted bool     `json:"deleted,omitempty"`
}

// DiagTaskStore abstracts dialtone-task CLI operations so unit tests use a fake.
type DiagTaskStore interface {
	List(ctx context.Context) ([]DiagTask, error)
	Add(ctx context.Context, title string, tags []string, note string) (DiagTask, error)
	Update(ctx context.Context, id string, note string) error
	Done(ctx context.Context, id string, note string) error
}

// CLIDiagTaskStore invokes the local dialtone-task plugin binary.
type CLIDiagTaskStore struct {
	BinPath string
	Timeout time.Duration
}

func defaultDiagTaskBinary() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	name := "dialtone-task"
	if runtime.GOOS == "windows" {
		name = "dialtone-task.exe"
	}
	return filepath.Join(home, ".dialtone", "plugins", "task", name)
}

func (s *CLIDiagTaskStore) bin() string {
	if strings.TrimSpace(s.BinPath) != "" {
		return strings.TrimSpace(s.BinPath)
	}
	return defaultDiagTaskBinary()
}

func (s *CLIDiagTaskStore) timeout() time.Duration {
	if s.Timeout > 0 {
		return s.Timeout
	}
	return 15 * time.Second
}

func (s *CLIDiagTaskStore) runTaskCLI(ctx context.Context, args ...string) ([]byte, error) {
	bin := s.bin()
	if bin == "" || !fileExists(bin) {
		return nil, fmt.Errorf("dialtone-task binary not found at %s", bin)
	}
	cctx, cancel := context.WithTimeout(ctx, s.timeout())
	defer cancel()
	cmd := exec.CommandContext(cctx, bin, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		redacted, _ := RedactDiagText(strings.TrimSpace(string(out)))
		return nil, fmt.Errorf("dialtone-task %s failed: %w (%s)", strings.Join(args, " "), err, redacted)
	}
	return out, nil
}

func (s *CLIDiagTaskStore) List(ctx context.Context) ([]DiagTask, error) {
	out, err := s.runTaskCLI(ctx, "list", "--json")
	if err != nil {
		return nil, err
	}
	var payload struct {
		Tasks []DiagTask `json:"tasks"`
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return nil, fmt.Errorf("parse dialtone-task list JSON: %w", err)
	}
	return payload.Tasks, nil
}

func (s *CLIDiagTaskStore) Add(ctx context.Context, title string, tags []string, note string) (DiagTask, error) {
	args := []string{"add", title}
	for _, tag := range tags {
		args = append(args, "--tag", tag)
	}
	if strings.TrimSpace(note) != "" {
		args = append(args, "--note", note)
	}
	args = append(args, "--json")
	out, err := s.runTaskCLI(ctx, args...)
	if err != nil {
		return DiagTask{}, err
	}
	var created DiagTask
	if err := json.Unmarshal(out, &created); err != nil {
		// Some versions wrap task in {"task": ...}.
		var wrapped struct {
			Task DiagTask `json:"task"`
		}
		if err2 := json.Unmarshal(out, &wrapped); err2 == nil && wrapped.Task.ID != "" {
			return wrapped.Task, nil
		}
		return DiagTask{}, fmt.Errorf("parse dialtone-task add JSON: %w", err)
	}
	if created.ID == "" {
		return DiagTask{}, errors.New("dialtone-task add returned empty task id")
	}
	return created, nil
}

func (s *CLIDiagTaskStore) Update(ctx context.Context, id string, note string) error {
	_, err := s.runTaskCLI(ctx, "update", id, "--note", note, "--json")
	return err
}

func (s *CLIDiagTaskStore) Done(ctx context.Context, id string, note string) error {
	args := []string{"done", id}
	if strings.TrimSpace(note) != "" {
		args = append(args, "--note", note)
	}
	args = append(args, "--json")
	_, err := s.runTaskCLI(ctx, args...)
	return err
}

func diagTaskTitle(checkID string) string {
	return fmt.Sprintf("diag: %s failing", checkID)
}

func hasDiagTag(tags []string) bool {
	for _, t := range tags {
		if strings.EqualFold(strings.TrimSpace(t), diagTaskTag) {
			return true
		}
	}
	return false
}

func isOpenDiagTask(t DiagTask) bool {
	if t.Deleted {
		return false
	}
	st := strings.ToLower(strings.TrimSpace(t.Status))
	return st != "done" && st != "closed" && st != "cancelled"
}

// SyncDiagTasks reconciles diagnostic loop check results against dialtone-task:
// - failing check: create or update exactly one task tagged "diagnostic"
// - passing check: mark any open matching task done
// - skipped check: do nothing (never create noise tasks or prematurely close)
func SyncDiagTasks(ctx context.Context, store DiagTaskStore, report *DiagLoopReport) error {
	if store == nil || report == nil {
		return nil
	}
	existing, err := store.List(ctx)
	if err != nil {
		return err
	}

	openByTitle := map[string][]DiagTask{}
	for _, task := range existing {
		if !isOpenDiagTask(task) {
			continue
		}
		if hasDiagTag(task.Tags) && strings.HasPrefix(task.Title, "diag: ") {
			openByTitle[task.Title] = append(openByTitle[task.Title], task)
		}
	}

	var errs []string
	for i := range report.Checks {
		check := &report.Checks[i]
		title := diagTaskTitle(check.CheckID)
		matches := openByTitle[title]

		switch check.Status {
		case DiagStatusSkipped, DiagStatusPending, DiagStatusInfo:
			continue
		case DiagStatusFail:
			detail := check.Error
			if detail == "" {
				detail = check.Summary
			}
			rawNote := fmt.Sprintf("loop=%s test-id=%s err=%s", report.LoopID, check.TestID, detail)
			note, _ := RedactDiagText(TruncateDiagOutput(rawNote, 480))
			if len(matches) > 0 {
				target := matches[0]
				if err := store.Update(ctx, target.ID, note); err != nil {
					errs = append(errs, fmt.Sprintf("update %s (%s): %v", target.ID, check.CheckID, err))
					continue
				}
				check.TaskID = target.ID
				check.TaskAction = "updated"
			} else {
				created, err := store.Add(ctx, title, []string{diagTaskTag}, note)
				if err != nil {
					errs = append(errs, fmt.Sprintf("add (%s): %v", check.CheckID, err))
					continue
				}
				check.TaskID = created.ID
				check.TaskAction = "created"
				openByTitle[title] = append(openByTitle[title], created)
			}
		case DiagStatusPass:
			if len(matches) == 0 {
				continue
			}
			closeNote := fmt.Sprintf("resolved in loop=%s test-id=%s", report.LoopID, check.TestID)
			for _, target := range matches {
				if err := store.Done(ctx, target.ID, closeNote); err != nil {
					errs = append(errs, fmt.Sprintf("done %s (%s): %v", target.ID, check.CheckID, err))
					continue
				}
				check.TaskID = target.ID
				check.TaskAction = "closed"
			}
			delete(openByTitle, title)
		}
	}

	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}
