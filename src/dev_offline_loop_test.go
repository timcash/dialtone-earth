package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestOfflineLoopBoundedSequential(t *testing.T) {
	var out, errOut bytes.Buffer
	waits := 0
	code := runOfflineLoop([]string{"--max-count", "2"}, &out, &errOut, func(d time.Duration) {
		waits++
		if d != 10*time.Minute || strings.Count(out.String(), "\n") != 21 {
			t.Fatalf("wait must follow complete first inventory: %s, %q", d, out.String())
		}
	})
	if code != 0 || waits != 1 || strings.Count(out.String(), "\n") != 42 || errOut.Len() != 0 {
		t.Fatalf("code=%d waits=%d stdout=%q stderr=%q", code, waits, out.String(), errOut.String())
	}
}

func TestOfflineLoopRejectsImplicitOrRemoteArguments(t *testing.T) {
	for _, args := range [][]string{nil, {"--max-count", "0"}, {"--max-count", "49"}, {"--once", "--host", "Legion"}, {"--once", "--live"}} {
		var out, errOut bytes.Buffer
		if code := runOfflineLoop(args, &out, &errOut, func(time.Duration) { t.Fatal("unexpected wait") }); code != 2 || out.Len() != 0 || !strings.HasPrefix(errOut.String(), "usage:") {
			t.Fatalf("%v: code=%d stdout=%q stderr=%q", args, code, out.String(), errOut.String())
		}
	}
}
