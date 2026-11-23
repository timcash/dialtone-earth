export interface RedactionResult {
  text: string;
  redactedCount: number;
}

const REDACTED = "[REDACTED]";

const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const SSH_KEY_RE =
  /\b(ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/=]{24,}(?:\s+[^\s]+)?/g;

const URL_CREDENTIALS_RE =
  /(\bhttps?:\/\/|wss?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|redis:\/\/|amqp:\/\/|nats:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

const AUTH_SCHEME_RE =
  /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

const HEADER_SECRET_RE =
  /((?:Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|Cookie|Set-Cookie|Cf-Access-Jwt-Assertion)\s*:\s*)([^\r\n"']+)/gi;

const CLI_FLAG_SECRET_RE =
  /((?:--?(?:password|passwd|pass|token|api[-_]?key|secret|private[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?token|session[-_]?key|signing[-_]?key|bearer|key))\s*(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s"'`]+)/gi;

const ENV_OR_KV_SECRET_RE =
  /(\b[A-Z0-9_.-]*(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH_?KEY|SIGNING_?KEY|CREDENTIAL|CF_AUTHORIZATION|DIALTONE_SESSION)[A-Z0-9_.-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"'`,;]+)/gi;

const KNOWN_TOKEN_PREFIX_RE =
  /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

/**
 * Redacts private keys, passwords, bearer/API tokens, cookies, and URL credentials
 * from dialtone-shell command transcripts before display or sharing across network members.
 */
export function redactSecrets(input: string): RedactionResult {
  if (!input) return { text: "", redactedCount: 0 };

  let text = input;
  let redactedCount = 0;

  const replaceWithCount = (
    regex: RegExp,
    replacer: (...args: string[]) => string,
  ): void => {
    text = text.replace(regex, (...args) => {
      redactedCount += 1;
      return replacer(...(args as string[]));
    });
  };

  replaceWithCount(PEM_BLOCK_RE, () => `[PRIVATE KEY ${REDACTED}]`);
  replaceWithCount(SSH_KEY_RE, (_m, algo) => `${algo} ${REDACTED}`);
  replaceWithCount(
    URL_CREDENTIALS_RE,
    (_m, proto, user) => `${proto}${user}:${REDACTED}@`,
  );
  replaceWithCount(HEADER_SECRET_RE, (_m, prefix) => `${prefix}${REDACTED}`);
  replaceWithCount(AUTH_SCHEME_RE, (_m, scheme) => `${scheme} ${REDACTED}`);
  replaceWithCount(CLI_FLAG_SECRET_RE, (_m, flag) => `${flag}${REDACTED}`);
  replaceWithCount(ENV_OR_KV_SECRET_RE, (_m, keyPart) => `${keyPart}${REDACTED}`);
  replaceWithCount(KNOWN_TOKEN_PREFIX_RE, () => REDACTED);

  return { text, redactedCount };
}

export function redactText(input: string): string {
  return redactSecrets(input).text;
}
