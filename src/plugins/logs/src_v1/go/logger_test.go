package logs

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
	"time"
)

var structuredSourceRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+:[0-9]+$`)

func TestFormatStructuredLineFormat(t *testing.T) {
	ts := time.Date(2026, 11, 20, 5, 30, 15, 0, time.UTC)
	line := FormatStructuredLine(ts, "error", "C:/repo/src/dev.go:412", "wrapped failure")
	parts := strings.SplitN(line, " ", 4)
	if len(parts) != 4 {
		t.Fatalf("expected 4 fields, got %d in %q", len(parts), line)
	}
	if _, err := time.Parse(time.RFC3339, parts[0]); err != nil {
		t.Fatalf("timestamp %q is not RFC3339: %v", parts[0], err)
	}
	if parts[1] != "ERROR" {
		t.Fatalf("level = %q, want ERROR", parts[1])
	}
	if parts[2] != "dev.go:412" {
		t.Fatalf("source = %q, want dev.go:412", parts[2])
	}
	if parts[3] != "wrapped failure" {
		t.Fatalf("message = %q, want %q", parts[3], "wrapped failure")
	}
}

func TestWriteStructuredLinesSplitsMultilineAndSkipsBlank(t *testing.T) {
	var buf bytes.Buffer
	WriteStructuredLines(&buf, "ERROR", "src/dev.go:99", "first line\r\n\r\n  second line  \n")
	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 structured lines, got %d: %q", len(lines), buf.String())
	}
	wantMsgs := []string{"first line", "second line"}
	for i, line := range lines {
		parts := strings.SplitN(line, " ", 4)
		if len(parts) != 4 {
			t.Fatalf("line %d malformed: %q", i, line)
		}
		if _, err := time.Parse(time.RFC3339, parts[0]); err != nil {
			t.Fatalf("line %d timestamp invalid: %v", i, err)
		}
		if parts[1] != "ERROR" {
			t.Fatalf("line %d level = %q, want ERROR", i, parts[1])
		}
		if !structuredSourceRe.MatchString(parts[2]) || parts[2] != "dev.go:99" {
			t.Fatalf("line %d source = %q, want dev.go:99", i, parts[2])
		}
		if parts[3] != wantMsgs[i] {
			t.Fatalf("line %d message = %q, want %q", i, parts[3], wantMsgs[i])
		}
	}
}
