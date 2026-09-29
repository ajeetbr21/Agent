/**
 * Everything LeechCode sends leaves the machine and lands in a third-party web page, so credentials
 * must never travel with it. Two layers:
 *
 *  1. `isSecretFile` — files that exist only to hold secrets are never read at all (.env, keys,
 *     certificates, credential stores). The agent is told they were skipped rather than shown them.
 *  2. `redactSecrets` — a scan of everything actually sent (prompts, file context, command output,
 *     git diffs, handover packages) that masks values which look like credentials.
 *
 * The scan is deliberately conservative: it masks recognisable token shapes and the *values* of
 * secret-looking assignments, but leaves placeholders (`API_KEY=your-key-here`), environment lookups
 * (`process.env.API_KEY`) and short values alone, so normal code keeps working for the model.
 *
 * Pure (no vscode import) so it is unit-testable.
 */

export const REDACTED = "***REDACTED***";

/** Filenames/paths whose whole purpose is holding credentials. */
const SECRET_PATH_RULES: readonly RegExp[] = [
  /(^|\/)\.env($|\.|\/)/i,
  /(^|\/)[^/]*\.env$/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)\.(npmrc|netrc|pgpass|git-credentials|htpasswd)$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.gnupg\//i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)(credentials|secrets?|passwords?)(\.[a-z0-9]+)?$/i,
  /(^|\/)secrets?\.[a-z0-9.]+$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)service[-_]?account[^/]*\.json$/i,
  /\.(pem|key|pfx|p12|jks|keystore|asc|ppk|kdbx)$/i,
  /(^|\/)[^/]*(secret|credential)[^/]*\.(json|ya?ml|txt|ini|conf|cfg|toml|xml)$/i
];

/**
 * True when a workspace-relative path should never be read and sent. `*.key` covers private keys;
 * `*.pub` public keys are still skipped because they sit next to the private one and add no value.
 */
export function isSecretFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  // A sample/example/template file is documentation, not a secret — wherever the marker sits
  // (.env.example, secrets.example.json, config.sample.yml).
  if (/(^|[./-])(example|sample|template|dist|fixture|mock)([./-]|$)/i.test(normalized)) {
    return false;
  }
  return SECRET_PATH_RULES.some((rule) => rule.test(normalized));
}

/** A glob suitable for vscode.workspace.findFiles exclusions. */
export const SECRET_FILE_GLOBS =
  "**/.env,**/.env.*,**/*.env,**/.envrc,**/.npmrc,**/.netrc,**/.pgpass,**/.git-credentials,**/.htpasswd," +
  "**/.ssh/**,**/.aws/**,**/.gnupg/**,**/id_rsa*,**/id_dsa*,**/id_ecdsa*,**/id_ed25519*," +
  "**/*.pem,**/*.key,**/*.pfx,**/*.p12,**/*.jks,**/*.keystore,**/*.ppk,**/*.kdbx," +
  "**/credentials,**/credentials.*,**/secret.*,**/secrets.*,**/service-account*.json,**/serviceAccount*.json";

/**
 * Recognisable credential shapes — masked wherever they appear. `alwaysMask` is for rules whose key
 * name makes the intent unambiguous, so a value that merely *looks* like documentation is still
 * masked (AWS's own example secret literally contains "EXAMPLE").
 */
const TOKEN_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly label: string;
  readonly alwaysMask?: boolean;
}[] = [
  {
    pattern: /(?<prefix>aws_?secret_?access_?key["']?\s*[:=]\s*["']?)(?<secret>[A-Za-z0-9/+=]{40})/gi,
    label: "AWS secret key",
    alwaysMask: true
  },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: "private key" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: "AWS access key id" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, label: "GitHub token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, label: "GitHub token" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, label: "Anthropic key" },
  { pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g, label: "OpenAI key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, label: "Google API key" },
  { pattern: /\bya29\.[0-9A-Za-z_-]{20,}\b/g, label: "Google OAuth token" },
  { pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g, label: "Slack token" },
  { pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{20,}\b/g, label: "Stripe key" },
  { pattern: /\bglpat-[0-9A-Za-z_-]{20,}\b/g, label: "GitLab token" },
  { pattern: /\bhf_[A-Za-z0-9]{30,}\b/g, label: "Hugging Face token" },
  { pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g, label: "npm token" },
  { pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, label: "SendGrid key" },
  { pattern: /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: "JWT" },
  // Patterns that keep a readable prefix use named groups: <prefix> is preserved, <secret> is masked.
  // Credentials inside a URL: scheme://user:secret@host
  { pattern: /\b(?<prefix>[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)(?<secret>[^\s/@]{3,})@/gi, label: "URL password" },
  { pattern: /(?<prefix>Authorization\s*:\s*(?:Bearer|Basic)\s+)(?<secret>[A-Za-z0-9._~+/=-]{16,})/gi, label: "Authorization header" }
];

/** Key names whose assigned value is treated as a secret. */
const SECRET_KEY_NAME =
  /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credential|connection[_-]?string|dsn|session[_-]?key|encryption[_-]?key|signing[_-]?key)/i;

/** Values that are obviously not real secrets. */
const PLACEHOLDER =
  /^(?:|-|null|none|nil|true|false|\d+|your[\w-]*|my[-_]\w+|xxx+|y{3,}|change[-_ ]?me|replace[-_ ]?me|todo|tbd|example[\w-]*|sample[\w-]*|dummy[\w-]*|test[\w-]*|fake[\w-]*|placeholder|secret|password|token|redacted|insert[\w-]*|add[-_]your[\w-]*|\*+|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%|process\.env\.\w+|process\.env\[[^\]]*\]|import\.meta\.env\.\w+|os\.environ(?:\[[^\]]*\]|\.get\([^)]*\))?)$/i;

/**
 * Markers that mark a value as documentation even inside a longer string, so example files and
 * README snippets keep working: `sk_live_replace_me`, `postgres://user:your-password@host`.
 */
const PLACEHOLDER_MARKER =
  /(?:your[-_]?|change[-_]?me|replace[-_]?me|placeholder|example|sample|dummy|redacted|insert[-_]?|xxxx|<[^>]*>|\$\{)/i;

/** True when a value is documentation rather than a real credential. */
function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || PLACEHOLDER_MARKER.test(value);
}

/** Shortest value worth masking for a generic assignment (avoids mangling flags and enums). */
const MIN_SECRET_VALUE_LENGTH = 8;

export interface RedactionResult {
  readonly text: string;
  /** How many values were masked. */
  readonly count: number;
  /** Short descriptions, for telling the user what was protected. */
  readonly kinds: readonly string[];
}

/** Mask credential-looking content. Returns the text unchanged when nothing matched. */
export function redactSecrets(text: string): RedactionResult {
  if (!text) {
    return { text, count: 0, kinds: [] };
  }

  let result = text;
  let count = 0;
  const kinds = new Set<string>();

  for (const { pattern, label, alwaysMask } of TOKEN_PATTERNS) {
    result = result.replace(pattern, (...args: unknown[]) => {
      const match = String(args[0]);
      // With named groups, String.replace passes the groups object last; otherwise the trailing
      // arguments are the offset and the whole input, which must not be mistaken for captures.
      const last = args[args.length - 1];
      const groups = typeof last === "object" && last !== null ? (last as Record<string, string | undefined>) : undefined;
      const prefix = groups?.prefix;
      const secret = groups?.secret;

      // A documented example (postgres://user:your-password@host) is not a credential.
      if (!alwaysMask && secret !== undefined && looksLikePlaceholder(secret)) {
        return match;
      }
      count += 1;
      kinds.add(label);
      return prefix === undefined ? REDACTED : `${prefix}${REDACTED}${match.endsWith("@") ? "@" : ""}`;
    });
  }

  result = redactAssignments(result, () => {
    count += 1;
    kinds.add("credential value");
  });

  return { text: result, count, kinds: [...kinds] };
}

/**
 * Mask the value of `KEY = value` / `"key": "value"` / `KEY: value` where the key name looks like a
 * credential. Only the value is touched, so the surrounding code stays readable and editable.
 */
function redactAssignments(text: string, onRedact: () => void): string {
  // Bounded to a single line: `\s*` around the separator would otherwise let an empty assignment
  // swallow the next line as its "value".
  const assignment = /(["'`]?)([A-Za-z0-9_.\-[\]]*?)\1([ \t]*[:=][ \t]*)(["'`]?)([^\s"'`,;=)}\]]*)\4/g;

  return text.replace(assignment, (match, keyQuote: string, key: string, middle: string, valueQuote: string, value: string) => {
    if (!key || !SECRET_KEY_NAME.test(key) || !value) {
      return match;
    }
    // A variable expansion ($VAR, ${VAR}, %VAR%) points at a secret, it isn't one.
    if (/^[$%]/.test(value)) {
      return match;
    }
    if (looksLikePlaceholder(value) || value.length < MIN_SECRET_VALUE_LENGTH) {
      return match;
    }
    // A value that is itself a reference/expression is not a literal secret.
    if (/^(?:[A-Za-z_$][\w$]*\s*[.(]|await\b|new\b)/.test(value)) {
      return match;
    }
    onRedact();
    return `${keyQuote}${key}${keyQuote}${middle}${valueQuote}${REDACTED}${valueQuote}`;
  });
}

/** Note appended to a prompt when something was masked, so the model doesn't chase missing values. */
export function redactionNote(result: RedactionResult): string {
  if (result.count === 0) {
    return "";
  }
  const kinds = result.kinds.length > 0 ? ` (${result.kinds.join(", ")})` : "";
  return `[LeechCode masked ${result.count} credential value${result.count === 1 ? "" : "s"}${kinds} as ${REDACTED} before sending this message. Treat those values as unknown — never guess them, and if a task needs one, ask the developer to set it themselves.]`;
}

/** Placeholder content used in place of a skipped secret file. */
export function secretFileNotice(relativePath: string): string {
  return `[LeechCode did not send this file: ${relativePath} holds credentials. Assume it exists and is configured; ask the developer if you need to know which keys it defines.]`;
}
