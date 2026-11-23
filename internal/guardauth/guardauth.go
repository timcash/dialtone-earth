package guardauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Network represents an isolated Dialtone Earth deployment boundary.
type Network string

const (
	NetworkMetal Network = "metal"
	NetworkTest  Network = "test"
)

// Action represents a guarded CLI or host operation.
type Action string

const (
	ActionHeartbeat Action = "heartbeat"
	ActionWhoami    Action = "whoami"
	ActionAudit     Action = "audit"
	ActionDeploy    Action = "deploy"
	ActionExec      Action = "exec"
)

// TokenClaims describes a verified, scoped principal credential.
type TokenClaims struct {
	Subject        string
	AllowedNetwork Network
	AllowedHosts   []string
	AllowedActions []Action
	ExpiresAt      time.Time
	Revoked        bool
}

// AuthRequest is an incoming guarded operation request.
type AuthRequest struct {
	Token   string
	Network Network
	Host    string
	Action  Action
}

// AuthDecision is the immutable authorization outcome.
type AuthDecision struct {
	Allowed bool
	Subject string
	Network Network
	Host    string
	Action  Action
	Reason  string
}

// AuditEvent captures a single authorization check for offline/online auditing.
type AuditEvent struct {
	Timestamp time.Time
	Subject   string
	Network   Network
	Host      string
	Action    Action
	Allowed   bool
	Reason    string
}

// TokenVerifier validates raw tokens without network I/O when backed by a mock.
type TokenVerifier interface {
	Verify(token string) (TokenClaims, error)
}

// AuditSink persists authorization decisions; failures must fail closed.
type AuditSink interface {
	Record(event AuditEvent) error
}

// Authorizer enforces guarded offline authorization policy.
type Authorizer struct {
	Verifier TokenVerifier
	Audit    AuditSink
	Now      func() time.Time
}

// Authorize evaluates token validity, expiry, revocation, Metal/Test network
// isolation, host allowlist, action scope, and fail-closed audit recording.
func (a *Authorizer) Authorize(req AuthRequest) (AuthDecision, error) {
	now := time.Now().UTC()
	if a.Now != nil {
		now = a.Now().UTC()
	}
	decision := AuthDecision{
		Allowed: false,
		Network: req.Network,
		Host:    strings.TrimSpace(req.Host),
		Action:  req.Action,
	}

	deny := func(reason string, cause error) (AuthDecision, error) {
		decision.Allowed = false
		decision.Reason = reason
		if a.Audit != nil {
			if auditErr := a.Audit.Record(AuditEvent{
				Timestamp: now,
				Subject:   decision.Subject,
				Network:   decision.Network,
				Host:      decision.Host,
				Action:    decision.Action,
				Allowed:   false,
				Reason:    reason,
			}); auditErr != nil {
				return decision, fmt.Errorf("authorization denied (%s) and audit failed: %w", reason, auditErr)
			}
		}
		if cause != nil {
			return decision, fmt.Errorf("authorization denied (%s): %w", reason, cause)
		}
		return decision, fmt.Errorf("authorization denied (%s)", reason)
	}

	if a.Verifier == nil {
		return deny("missing_verifier", errors.New("token verifier not configured"))
	}
	if a.Audit == nil {
		return deny("missing_audit_sink", errors.New("audit sink not configured"))
	}
	if strings.TrimSpace(req.Token) == "" {
		return deny("missing_token", nil)
	}
	if req.Network != NetworkMetal && req.Network != NetworkTest {
		return deny("invalid_network", nil)
	}
	if decision.Host == "" {
		return deny("missing_host", nil)
	}
	if strings.TrimSpace(string(req.Action)) == "" {
		return deny("missing_action", nil)
	}

	claims, err := a.Verifier.Verify(req.Token)
	if err != nil {
		return deny("invalid_token", err)
	}
	decision.Subject = strings.TrimSpace(claims.Subject)
	if decision.Subject == "" {
		return deny("missing_subject", nil)
	}
	if claims.Revoked {
		return deny("token_revoked", nil)
	}
	if claims.ExpiresAt.IsZero() || !now.Before(claims.ExpiresAt) {
		return deny("token_expired", nil)
	}
	if claims.AllowedNetwork != req.Network {
		return deny("network_isolation_violation", nil)
	}
	if !containsHost(claims.AllowedHosts, decision.Host) {
		return deny("host_not_allowed", nil)
	}
	if !containsAction(claims.AllowedActions, req.Action) {
		return deny("action_not_allowed", nil)
	}

	decision.Allowed = true
	decision.Reason = "authorized"
	if auditErr := a.Audit.Record(AuditEvent{
		Timestamp: now,
		Subject:   decision.Subject,
		Network:   decision.Network,
		Host:      decision.Host,
		Action:    decision.Action,
		Allowed:   true,
		Reason:    decision.Reason,
	}); auditErr != nil {
		decision.Allowed = false
		decision.Reason = "audit_write_failed"
		return decision, fmt.Errorf("authorization failed closed on audit write: %w", auditErr)
	}
	return decision, nil
}

func containsHost(hosts []string, target string) bool {
	for _, h := range hosts {
		if strings.EqualFold(strings.TrimSpace(h), strings.TrimSpace(target)) {
			return true
		}
	}
	return false
}

func containsAction(actions []Action, target Action) bool {
	for _, a := range actions {
		if a == target {
			return true
		}
	}
	return false
}

// MockTokenVerifier issues and verifies HMAC-SHA256 signed offline mock tokens.
type MockTokenVerifier struct {
	Secret []byte
	Claims map[string]TokenClaims
}

// Issue signs a mock token ID with HMAC-SHA256 and stores its claims in memory.
func (m *MockTokenVerifier) Issue(tokenID string, claims TokenClaims) string {
	if m.Claims == nil {
		m.Claims = map[string]TokenClaims{}
	}
	m.Claims[tokenID] = claims
	mac := hmac.New(sha256.New, m.Secret)
	mac.Write([]byte(tokenID))
	sig := hex.EncodeToString(mac.Sum(nil))
	return tokenID + "." + sig
}

// Verify checks the HMAC signature and resolves stored offline mock claims.
func (m *MockTokenVerifier) Verify(token string) (TokenClaims, error) {
	tokenID, sigHex, ok := strings.Cut(strings.TrimSpace(token), ".")
	if !ok || tokenID == "" || sigHex == "" {
		return TokenClaims{}, errors.New("malformed token")
	}
	gotSig, err := hex.DecodeString(sigHex)
	if err != nil {
		return TokenClaims{}, fmt.Errorf("decode signature: %w", err)
	}
	mac := hmac.New(sha256.New, m.Secret)
	mac.Write([]byte(tokenID))
	wantSig := mac.Sum(nil)
	if !hmac.Equal(gotSig, wantSig) {
		return TokenClaims{}, errors.New("signature mismatch")
	}
	claims, exists := m.Claims[tokenID]
	if !exists {
		return TokenClaims{}, errors.New("unknown token")
	}
	return claims, nil
}

// MockAuditSink records audit events in memory and optionally injects failures.
type MockAuditSink struct {
	Events  []AuditEvent
	FailErr error
}

// Record stores an audit event or returns the configured mock failure.
func (s *MockAuditSink) Record(event AuditEvent) error {
	if s.FailErr != nil {
		return s.FailErr
	}
	s.Events = append(s.Events, event)
	return nil
}

// OfflineAuthReport summarizes verified offline guarded authorization checks.
type OfflineAuthReport struct {
	ChecksExecuted int
	AuditEvents    int
}

// RunOfflineGuardedAuthorizationCheck executes real offline authorization
// assertions using in-memory HMAC token and audit mocks only.
func RunOfflineGuardedAuthorizationCheck() (OfflineAuthReport, error) {
	now := time.Date(2026, 11, 20, 5, 0, 0, 0, time.UTC)
	verifier := &MockTokenVerifier{Secret: []byte("offline-mock-signing-key")}
	audit := &MockAuditSink{}
	authz := &Authorizer{
		Verifier: verifier,
		Audit:    audit,
		Now:      func() time.Time { return now },
	}

	hosts := []string{"vm-us", "vm-eu", "vm-asia", "Rosie", "Legion", "Build-1"}
	validTestToken := verifier.Issue("tok-test-ro", TokenClaims{
		Subject:        "mock-operator",
		AllowedNetwork: NetworkTest,
		AllowedHosts:   hosts,
		AllowedActions: []Action{ActionHeartbeat, ActionWhoami, ActionAudit},
		ExpiresAt:      now.Add(15 * time.Minute),
	})
	expiredToken := verifier.Issue("tok-expired", TokenClaims{
		Subject:        "mock-operator",
		AllowedNetwork: NetworkTest,
		AllowedHosts:   hosts,
		AllowedActions: []Action{ActionWhoami},
		ExpiresAt:      now.Add(-1 * time.Second),
	})
	revokedToken := verifier.Issue("tok-revoked", TokenClaims{
		Subject:        "mock-operator",
		AllowedNetwork: NetworkTest,
		AllowedHosts:   hosts,
		AllowedActions: []Action{ActionWhoami},
		ExpiresAt:      now.Add(15 * time.Minute),
		Revoked:        true,
	})
	tamperedToken := validTestToken[:len(validTestToken)-2] + "ff"
	if tamperedToken == validTestToken {
		tamperedToken = validTestToken[:len(validTestToken)-2] + "00"
	}

	type checkCase struct {
		name        string
		req         AuthRequest
		wantAllowed bool
		wantReason  string
	}
	cases := []checkCase{
		{
			name:        "deny_missing_token",
			req:         AuthRequest{Token: "", Network: NetworkTest, Host: "Legion", Action: ActionWhoami},
			wantAllowed: false,
			wantReason:  "missing_token",
		},
		{
			name:        "deny_tampered_signature",
			req:         AuthRequest{Token: tamperedToken, Network: NetworkTest, Host: "Legion", Action: ActionWhoami},
			wantAllowed: false,
			wantReason:  "invalid_token",
		},
		{
			name:        "deny_expired_token",
			req:         AuthRequest{Token: expiredToken, Network: NetworkTest, Host: "Legion", Action: ActionWhoami},
			wantAllowed: false,
			wantReason:  "token_expired",
		},
		{
			name:        "deny_revoked_token",
			req:         AuthRequest{Token: revokedToken, Network: NetworkTest, Host: "Legion", Action: ActionWhoami},
			wantAllowed: false,
			wantReason:  "token_revoked",
		},
		{
			name:        "deny_metal_test_cross_network",
			req:         AuthRequest{Token: validTestToken, Network: NetworkMetal, Host: "vm-us", Action: ActionHeartbeat},
			wantAllowed: false,
			wantReason:  "network_isolation_violation",
		},
		{
			name:        "deny_unlisted_host",
			req:         AuthRequest{Token: validTestToken, Network: NetworkTest, Host: "rogue-host", Action: ActionWhoami},
			wantAllowed: false,
			wantReason:  "host_not_allowed",
		},
		{
			name:        "deny_unscoped_mutating_action",
			req:         AuthRequest{Token: validTestToken, Network: NetworkTest, Host: "Legion", Action: ActionDeploy},
			wantAllowed: false,
			wantReason:  "action_not_allowed",
		},
		{
			name:        "allow_scoped_offline_read_check",
			req:         AuthRequest{Token: validTestToken, Network: NetworkTest, Host: "Legion", Action: ActionAudit},
			wantAllowed: true,
			wantReason:  "authorized",
		},
	}

	checksExecuted := 0
	for _, tc := range cases {
		checksExecuted++
		dec, err := authz.Authorize(tc.req)
		if dec.Allowed != tc.wantAllowed {
			return OfflineAuthReport{}, fmt.Errorf("%s: allowed=%t, want %t (reason=%s, err=%v)", tc.name, dec.Allowed, tc.wantAllowed, dec.Reason, err)
		}
		if dec.Reason != tc.wantReason {
			return OfflineAuthReport{}, fmt.Errorf("%s: reason=%q, want %q", tc.name, dec.Reason, tc.wantReason)
		}
		if tc.wantAllowed && err != nil {
			return OfflineAuthReport{}, fmt.Errorf("%s: unexpected error on allowed decision: %w", tc.name, err)
		}
		if !tc.wantAllowed && err == nil {
			return OfflineAuthReport{}, fmt.Errorf("%s: expected error on denied decision", tc.name)
		}
	}

	if len(audit.Events) != len(cases) {
		return OfflineAuthReport{}, fmt.Errorf("audit event count=%d, want %d", len(audit.Events), len(cases))
	}

	// Verify fail-closed behavior when the mock audit sink fails on an otherwise valid request.
	checksExecuted++
	failingAudit := &MockAuditSink{FailErr: errors.New("mock audit storage unavailable")}
	failClosedAuthz := &Authorizer{
		Verifier: verifier,
		Audit:    failingAudit,
		Now:      func() time.Time { return now },
	}
	dec, err := failClosedAuthz.Authorize(AuthRequest{
		Token:   validTestToken,
		Network: NetworkTest,
		Host:    "Legion",
		Action:  ActionAudit,
	})
	if dec.Allowed || err == nil || dec.Reason != "audit_write_failed" {
		return OfflineAuthReport{}, fmt.Errorf("fail_closed_audit: allowed=%t reason=%q err=%v, want denied with audit_write_failed", dec.Allowed, dec.Reason, err)
	}

	return OfflineAuthReport{
		ChecksExecuted: checksExecuted,
		AuditEvents:    len(audit.Events),
	}, nil
}
