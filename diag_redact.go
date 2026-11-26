package main

import (
	"regexp"
	"strings"
)

const (
	diagRedactedPlaceholder = "[REDACTED]"
	defaultDiagMaxOutput    = 4096
)

var (
	diagPEMBlockRe = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	diagSSHKeyRe   = regexp.MustCompile(`\b(ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/=]{24,}(?:\s+[^\s]+)?`)
	diagURLCredRe  = regexp.MustCompile(`(?i)(\b(?:https?|wss?|postgres(?:ql)?|mysql|redis|amqp|nats)://)([^/\s:@]+):([^/\s@]+)@`)
	diagHeaderRe   = regexp.MustCompile(`(?i)((?:Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Cookie|Set-Cookie|Cf-Access-Jwt-Assertion)\s*:\s*)([^\r\n"']+)`)
	diagAuthRe     = regexp.MustCompile(`(?i)\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})`)
	diagTicketRe   = regexp.MustCompile(`\biroh-blobs://ticket/[^\s"'` + "`" + `]+`)
	diagInviteRe   = regexp.MustCompile(`\bdialtone-invite-v\d+:[^\s"'` + "`" + `]+`)
	diagDtSecretRe = regexp.MustCompile(`\bdt-[A-Za-z0-9_-]{8,}\b`)
	diagCLIFlagRe  = regexp.MustCompile(`(?i)((?:--?(?:password|passwd|pass|token|api[-_]?token|gateway[-_]?token|api[-_]?key|secret|private[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?token|session[-_]?key|signing[-_]?key|bearer|ticket|invite))\s*(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s"'` + "`" + `]+)`)
	diagKVSecretRe = regexp.MustCompile(`(?i)(\b[A-Z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH_?KEY|SIGNING_?KEY|CREDENTIAL|CF_AUTHORIZATION|DIALTONE_SESSION|RPC\.TOKEN|MESH\.KEY|COOKIE|SESSION_ID|TICKET|INVITE)[A-Z0-9_.-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"'` + "`" + `,;]+)`)
	diagKnownTokRe = regexp.MustCompile(`\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b`)
)

// RedactDiagText scrubs credentials, tokens, cookies, tickets, invites, and
// private keys from diagnostic text before persisting or publishing.
func RedactDiagText(input string) (string, int) {
	if input == "" {
		return "", 0
	}
	text := input
	count := 0

	apply := func(re *regexp.Regexp, repl func([]string) string) {
		text = re.ReplaceAllStringFunc(text, func(match string) string {
			sub := re.FindStringSubmatch(match)
			count++
			return repl(sub)
		})
	}

	apply(diagPEMBlockRe, func([]string) string { return "[PRIVATE KEY " + diagRedactedPlaceholder + "]" })
	apply(diagSSHKeyRe, func(m []string) string { return m[1] + " " + diagRedactedPlaceholder })
	apply(diagURLCredRe, func(m []string) string { return m[1] + m[2] + ":" + diagRedactedPlaceholder + "@" })
	apply(diagTicketRe, func([]string) string { return "iroh-blobs://ticket/" + diagRedactedPlaceholder })
	apply(diagInviteRe, func([]string) string { return "dialtone-invite:" + diagRedactedPlaceholder })
	apply(diagDtSecretRe, func([]string) string { return "dt-" + diagRedactedPlaceholder })
	apply(diagHeaderRe, func(m []string) string { return m[1] + diagRedactedPlaceholder })
	apply(diagAuthRe, func(m []string) string { return m[1] + " " + diagRedactedPlaceholder })
	apply(diagCLIFlagRe, func(m []string) string { return m[1] + diagRedactedPlaceholder })
	apply(diagKVSecretRe, func(m []string) string { return m[1] + diagRedactedPlaceholder })
	apply(diagKnownTokRe, func([]string) string { return diagRedactedPlaceholder })

	return text, count
}

// TruncateDiagOutput caps stdout/stderr length while keeping a clear marker.
func TruncateDiagOutput(input string, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = defaultDiagMaxOutput
	}
	if len(input) <= maxBytes {
		return input
	}
	suffix := "\n...[truncated]"
	cut := maxBytes - len(suffix)
	if cut < 0 {
		cut = 0
	}
	return strings.TrimRight(input[:cut], "\r\n") + suffix
}

// SanitizeDiagOutput redacts secrets and truncates length.
func SanitizeDiagOutput(input string, maxBytes int) (string, int) {
	redacted, count := RedactDiagText(input)
	return TruncateDiagOutput(redacted, maxBytes), count
}

// SanitizeDiagDetails recursively redacts string values inside details maps.
func SanitizeDiagDetails(details map[string]any) (map[string]any, int) {
	if len(details) == 0 {
		return nil, 0
	}
	out := make(map[string]any, len(details))
	total := 0
	for k, v := range details {
		lowerKey := strings.ToLower(k)
		if strings.Contains(lowerKey, "token") ||
			strings.Contains(lowerKey, "secret") ||
			strings.Contains(lowerKey, "password") ||
			strings.Contains(lowerKey, "cookie") ||
			strings.Contains(lowerKey, "ticket") ||
			strings.Contains(lowerKey, "invite") ||
			strings.Contains(lowerKey, "mesh_key") {
			out[k] = diagRedactedPlaceholder
			total++
			continue
		}
		sanitized, n := sanitizeAny(v)
		total += n
		out[k] = sanitized
	}
	return out, total
}

func sanitizeAny(v any) (any, int) {
	switch val := v.(type) {
	case string:
		return RedactDiagText(val)
	case []string:
		out := make([]string, len(val))
		total := 0
		for i, s := range val {
			rs, n := RedactDiagText(s)
			out[i] = rs
			total += n
		}
		return out, total
	case map[string]any:
		return SanitizeDiagDetails(val)
	case map[string]string:
		out := make(map[string]string, len(val))
		total := 0
		for k, s := range val {
			rs, n := RedactDiagText(s)
			out[k] = rs
			total += n
		}
		return out, total
	default:
		return v, 0
	}
}
