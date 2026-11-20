package guardauth

import (
	"errors"
	"testing"
	"time"
)

func TestRunOfflineGuardedAuthorizationCheckPasses(t *testing.T) {
	report, err := RunOfflineGuardedAuthorizationCheck()
	if err != nil {
		t.Fatalf("RunOfflineGuardedAuthorizationCheck failed: %v", err)
	}
	if report.ChecksExecuted != 9 {
		t.Fatalf("ChecksExecuted = %d, want 9", report.ChecksExecuted)
	}
	if report.AuditEvents != 8 {
		t.Fatalf("AuditEvents = %d, want 8", report.AuditEvents)
	}
}

func TestAuthorizerFailsClosedWithoutAuditSink(t *testing.T) {
	now := time.Date(2026, 11, 20, 5, 0, 0, 0, time.UTC)
	verifier := &MockTokenVerifier{Secret: []byte("secret")}
	tok := verifier.Issue("t1", TokenClaims{
		Subject:        "op",
		AllowedNetwork: NetworkTest,
		AllowedHosts:   []string{"Legion"},
		AllowedActions: []Action{ActionWhoami},
		ExpiresAt:      now.Add(time.Minute),
	})
	authz := &Authorizer{
		Verifier: verifier,
		Audit:    nil,
		Now:      func() time.Time { return now },
	}
	dec, err := authz.Authorize(AuthRequest{
		Token:   tok,
		Network: NetworkTest,
		Host:    "Legion",
		Action:  ActionWhoami,
	})
	if dec.Allowed || err == nil || dec.Reason != "missing_audit_sink" {
		t.Fatalf("expected missing_audit_sink denial, got allowed=%t reason=%q err=%v", dec.Allowed, dec.Reason, err)
	}
}

func TestAuthorizerPropagatesAuditFailureOnDeny(t *testing.T) {
	authz := &Authorizer{
		Verifier: &MockTokenVerifier{Secret: []byte("secret")},
		Audit:    &MockAuditSink{FailErr: errors.New("disk full")},
	}
	dec, err := authz.Authorize(AuthRequest{
		Token:   "",
		Network: NetworkTest,
		Host:    "Legion",
		Action:  ActionWhoami,
	})
	if dec.Allowed || err == nil {
		t.Fatalf("expected denied decision with wrapped audit error, got allowed=%t err=%v", dec.Allowed, err)
	}
}
