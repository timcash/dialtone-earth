package logs

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

var logOutput io.Writer = io.Discard
var plainLogMu sync.Mutex
var plainLogEpoch = map[string]time.Time{}

func SetOutput(w io.Writer) {
	logOutput = w
}

func ResetClock(topic string) {
	key := strings.TrimSpace(topic)
	if key == "" {
		key = "default"
	}
	plainLogMu.Lock()
	delete(plainLogEpoch, key)
	plainLogMu.Unlock()
}

func formatPlain(level, message string) string {
	src := callerSourceLocation()
	return formatPlainWithSource(level, src, message, false)
}

func formatPlainWithSource(level, source, message string, isTest bool) string {
	if IsREPLContext() {
		if isTest {
			message = TestPrefix(message)
		}
		return strings.TrimSpace(message)
	}
	src := normalizeSourcePath(source)
	if src == "" {
		src = "unknown"
	}
	if isTest {
		message = TestPrefix(message)
	}
	elapsed := elapsedSeconds("default")
	return fmt.Sprintf("[T+%04ds|%s|%s] %s", elapsed, strings.ToUpper(level), src, message)
}

func FormatDialtoneMessage(prefix, message string) string {
	message = strings.TrimSpace(message)
	if IsREPLContext() {
		return message
	}
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		prefix = "dialtone"
	} else if strings.HasPrefix(strings.ToUpper(prefix), "DIALTONE") {
		prefix = "dialtone" + prefix[len("DIALTONE"):]
	}
	return prefix + "> " + message
}

func FormatSystemMessage(message string) string {
	return FormatDialtoneMessage("dialtone", message)
}

func FormatUserMessage(message string) string {
	return FormatDialtoneMessage("dialtone", message)
}

func formatSystemMessage(message string) string {
	return FormatSystemMessage(message)
}

func formatUserMessage(message string) string {
	return FormatUserMessage(message)
}

func TestPrefix(line string) string {
	line = strings.TrimSpace(line)
	if strings.HasPrefix(line, "[TEST]") {
		return line
	}
	return "[TEST] " + line
}

func elapsedSeconds(topic string) int {
	key := strings.TrimSpace(topic)
	if key == "" {
		key = "default"
	}
	now := time.Now()
	plainLogMu.Lock()
	start, ok := plainLogEpoch[key]
	if !ok {
		start = now
		plainLogEpoch[key] = now
	}
	plainLogMu.Unlock()
	sec := int(now.Sub(start).Seconds())
	if sec < 0 {
		return 0
	}
	return sec
}

func callerSourceLocation() string {
	for i := 2; i < 12; i++ {
		_, file, line, ok := runtime.Caller(i)
		if !ok {
			break
		}
		norm := filepath.ToSlash(file)
		if strings.Contains(norm, "/plugins/logs/src_v1/go/logger.go") || strings.Contains(norm, "/plugins/logs/src_v1/go/nats.go") {
			continue
		}
		src := normalizeSourcePath(file)
		if src == "" {
			src = "unknown"
		}
		if line > 0 {
			return fmt.Sprintf("%s:%d", src, line)
		}
		return src
	}
	return "unknown"
}

func normalizeSourcePath(source string) string {
	s := strings.TrimSpace(filepath.ToSlash(source))
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "src/") {
		return s
	}
	if idx := strings.Index(s, "/src/"); idx >= 0 {
		return s[idx+1:]
	}
	return filepath.Base(s)
}

func Info(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("INFO", msg, callerSourceLocation(), false)
	fmt.Fprintf(logOutput, "%s\n", formatPlain("INFO", msg))
}

func InfoFrom(source, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("INFO", msg, source, false)
	fmt.Fprintf(logOutput, "%s\n", formatPlainWithSource("INFO", source, msg, false))
}

func InfoFromTest(source, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("INFO", msg, source, true)
	fmt.Fprintf(logOutput, "%s\n", formatPlainWithSource("INFO", source, msg, true))
}

func Raw(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("INFO", msg, callerSourceLocation(), false)
	fmt.Fprintf(logOutput, "%s\n", msg)
}

func System(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimaryWithKind("INFO", "status", msg, callerSourceLocation(), false)
	fmt.Fprintf(logOutput, "%s\n", formatSystemMessage(msg))
}

func User(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimaryWithKind("INFO", "chat", msg, callerSourceLocation(), false)
	fmt.Fprintf(logOutput, "%s\n", formatUserMessage(msg))
}

func Error(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("ERROR", msg, callerSourceLocation(), false)
	fmt.Fprintf(logOutput, "%s\n", formatPlain("ERROR", msg))
}

func ErrorFrom(source, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("ERROR", msg, source, false)
	fmt.Fprintf(logOutput, "%s\n", formatPlainWithSource("ERROR", source, msg, false))
}

func ErrorFromTest(source, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("ERROR", msg, source, true)
	fmt.Fprintf(logOutput, "%s\n", formatPlainWithSource("ERROR", source, msg, true))
}

func Errorf(format string, args ...any) error {
	msg := fmt.Sprintf(format, args...)
	Error("%s", msg)
	return fmt.Errorf("%s", msg)
}

func Warn(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("WARN", msg, callerSourceLocation(), false)
	fmt.Fprintf(logOutput, "%s\n", formatPlain("WARN", msg))
}

func WarnFrom(source, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("WARN", msg, source, false)
	fmt.Fprintf(logOutput, "%s\n", formatPlainWithSource("WARN", source, msg, false))
}

func WarnFromTest(source, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("WARN", msg, source, true)
	fmt.Fprintf(logOutput, "%s\n", formatPlainWithSource("WARN", source, msg, true))
}

func Debug(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("DEBUG", msg, callerSourceLocation(), false)
	fmt.Fprintf(logOutput, "%s\n", formatPlain("DEBUG", msg))
}

func DebugFrom(source, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("DEBUG", msg, source, false)
	fmt.Fprintf(logOutput, "%s\n", formatPlainWithSource("DEBUG", source, msg, false))
}

func DebugFromTest(source, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("DEBUG", msg, source, true)
	fmt.Fprintf(logOutput, "%s\n", formatPlainWithSource("DEBUG", source, msg, true))
}

func Fatal(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	publishPrimary("FATAL", msg, callerSourceLocation(), false)
	fmt.Fprintf(logOutput, "%s\n", formatPlain("FATAL", msg))
	os.Exit(1)
}

// CallerFileLine returns the caller's base filename and line number formatted as "filename:line".
func CallerFileLine(skip int) string {
	_, file, line, ok := runtime.Caller(skip)
	if !ok || strings.TrimSpace(file) == "" {
		return "unknown:0"
	}
	if line < 0 {
		line = 0
	}
	return fmt.Sprintf("%s:%d", filepath.Base(filepath.ToSlash(file)), line)
}

func formatFilenameLine(source string) string {
	s := strings.TrimSpace(filepath.ToSlash(source))
	if s == "" {
		return callerFileLineSkipLogger()
	}
	filePart := s
	linePart := ""
	if idx := strings.LastIndex(s, ":"); idx >= 0 {
		candidateLine := strings.TrimSpace(s[idx+1:])
		if isDigits(candidateLine) {
			filePart = s[:idx]
			linePart = candidateLine
		}
	}
	base := filepath.Base(strings.TrimSpace(filePart))
	if base == "" || base == "." || base == "/" {
		base = "unknown"
	}
	if linePart == "" {
		linePart = "0"
	}
	return base + ":" + linePart
}

func callerFileLineSkipLogger() string {
	for i := 2; i < 12; i++ {
		_, file, line, ok := runtime.Caller(i)
		if !ok {
			break
		}
		norm := filepath.ToSlash(file)
		if strings.Contains(norm, "/plugins/logs/src_v1/go/logger.go") || strings.Contains(norm, "/plugins/logs/src_v1/go/nats.go") {
			continue
		}
		if line < 0 {
			line = 0
		}
		return fmt.Sprintf("%s:%d", filepath.Base(norm), line)
	}
	return "unknown:0"
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// FormatStructuredLine formats one log line with an RFC3339 UTC timestamp,
// conventional level, filename:line, and single-line message.
func FormatStructuredLine(ts time.Time, level, source, message string) string {
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	lvl := strings.ToUpper(strings.TrimSpace(level))
	switch lvl {
	case "DEBUG", "INFO", "WARN", "ERROR", "FATAL":
	default:
		lvl = "INFO"
	}
	src := formatFilenameLine(source)
	msg := strings.TrimSpace(message)
	if msg == "" {
		msg = "(empty)"
	}
	return fmt.Sprintf("%s %s %s %s", ts.UTC().Format(time.RFC3339), lvl, src, msg)
}

// WriteStructuredLines writes one RFC3339 structured log line per non-empty line in text.
func WriteStructuredLines(w io.Writer, level, source, text string) {
	if w == nil {
		w = logOutput
	}
	if w == nil {
		return
	}
	src := formatFilenameLine(source)
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	lines := strings.Split(normalized, "\n")

	plainLogMu.Lock()
	defer plainLogMu.Unlock()
	for _, raw := range lines {
		msg := strings.TrimSpace(raw)
		if msg == "" {
			continue
		}
		fmt.Fprintf(w, "%s\n", FormatStructuredLine(time.Now().UTC(), level, src, msg))
	}
}
