import test from "node:test";
import assert from "node:assert/strict";
import { isSecretFile, REDACTED, redactSecrets, redactionNote } from "../prompt/redact";

/**
 * Fake credentials are assembled at runtime: a literal token shape written into this file would be
 * flagged by secret scanners (GitHub push protection blocks such a commit), even though the value is
 * invented. Splitting the prefix keeps the test meaningful without tripping them.
 */
const fake = (...parts: string[]) => parts.join("");

test("isSecretFile skips credential files", () => {
  const secrets = [
    ".env",
    ".env.local",
    ".env.production",
    "apps/api/.env",
    "config/prod.env",
    ".envrc",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".ssh/config",
    "home/.aws/credentials",
    "certs/server.pem",
    "certs/server.key",
    "keys/id_rsa",
    "keys/id_ed25519.pub",
    "android/app.keystore",
    "release.jks",
    "cert.pfx",
    "gcp/service-account.json",
    "gcp/serviceAccountKey.json",
    "credentials",
    "config/secrets.yml",
    "config/secret.json",
    "deploy/app-secrets.yaml"
  ];
  for (const path of secrets) {
    assert.equal(isSecretFile(path), true, `should skip ${path}`);
  }
});

test("isSecretFile keeps ordinary source files and examples", () => {
  const safe = [
    "src/app.ts",
    "README.md",
    ".env.example",
    ".env.sample",
    ".env.template",
    "config/secrets.example.json",
    "src/auth/token.service.ts",
    "src/keyboard.ts",
    "docs/security.md",
    "package.json",
    "src/components/PasswordField.tsx",
    "test/fixtures/keys.test.ts"
  ];
  for (const path of safe) {
    assert.equal(isSecretFile(path), false, `should keep ${path}`);
  }
});

test("redactSecrets masks well-known token shapes", () => {
  const cases: [string, string][] = [
    [`AWS_ACCESS_KEY_ID=${fake("AKI", "AIOSFODNN7EXAMPLE")}`, "AWS access key id"],
    [`token: ${fake("ghp", "_", "1234567890abcdefghijklmnopqrstuvwxyz")}`, "GitHub token"],
    [`OPENAI_KEY = ${fake("sk", "-proj-", "abcdefghijklmnopqrstuvwxyz1234567890ABCD")}`, "OpenAI key"],
    [`anthropic ${fake("sk", "-ant-", "api03-abcdefghijklmnopqrstuvwx")}`, "Anthropic key"],
    [`key = ${fake("AIz", "aSyA1234567890abcdefghijklmnopqrstuvw")}`, "Google API key"],
    [`slack ${fake("xox", "b-", "123456789012-abcdefghijklmnop")}`, "Slack token"],
    [`stripe ${fake("sk", "_live_", "abcdefghijklmnopqrstuvwx")}`, "Stripe key"],
    [fake("glp", "at-", "abcdefghijklmnopqrst"), "GitLab token"],
    [`Authorization: Bearer ${fake("abcdefghijklmnopqrstuvwxyz", "123456")}`, "Authorization header"]
  ];

  for (const [input, label] of cases) {
    const result = redactSecrets(input);
    assert.ok(result.count >= 1, `should mask: ${input}`);
    assert.ok(result.text.includes(REDACTED), `should contain the mask: ${input}`);
    assert.ok(result.kinds.length > 0, label);
  }
});

test("redactSecrets masks a JWT and a private key block", () => {
  const jwtValue = fake("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r");
  const jwt = redactSecrets(`cookie=${jwtValue}`);
  assert.ok(jwt.text.includes(REDACTED));
  assert.ok(!jwt.text.includes(jwtValue));

  const pem = redactSecrets(
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----\nconst after = 1;"
  );
  assert.equal(pem.text, `${REDACTED}\nconst after = 1;`);
});

test("redactSecrets masks credentials in connection strings", () => {
  const result = redactSecrets("DATABASE_URL=postgres://appuser:s3cr3tPassw0rd@db.internal:5432/app");
  assert.ok(result.text.includes(REDACTED));
  assert.doesNotMatch(result.text, /s3cr3tPassw0rd/);
  assert.match(result.text, /postgres:\/\/appuser:/, "the visible part stays readable");
  assert.match(result.text, /@db\.internal:5432\/app/, "the host survives");
});

test("redactSecrets masks secret-looking assignments but keeps the key name", () => {
  const result = redactSecrets([
    "DB_PASSWORD=hunter2SuperSecret",
    'API_KEY: "abcdef1234567890abcdef"',
    "client_secret = 'zK3p9QhnTm2vB7xL'",
    '"accessToken": "aVeryLongLivedTokenValue123"'
  ].join("\n"));

  assert.equal(result.count, 4);
  assert.match(result.text, /^DB_PASSWORD=\*\*\*REDACTED\*\*\*$/m);
  assert.match(result.text, /API_KEY: "\*\*\*REDACTED\*\*\*"/);
  assert.match(result.text, /client_secret = '\*\*\*REDACTED\*\*\*'/);
  assert.match(result.text, /"accessToken": "\*\*\*REDACTED\*\*\*"/);
  assert.doesNotMatch(result.text, /hunter2|abcdef1234|zK3p9|aVeryLong/);
});

test("redactSecrets leaves placeholders, env lookups and code alone", () => {
  const source = [
    "API_KEY=",
    "API_KEY=your-key-here",
    "PASSWORD=changeme",
    "SECRET=<your-secret>",
    "TOKEN=${GITHUB_TOKEN}",
    "API_KEY=$OPENAI_KEY",
    "password = process.env.DB_PASSWORD",
    'const apiKey = process.env["API_KEY"];',
    "password: os.environ.get('DB_PASS')",
    "const token = await getToken();",
    "PASSWORD=xxx",
    "secret: null",
    "retries = 3",
    "MAX_TOKENS=4096",
    "const passwordField = document.querySelector('#password');",
    "// TODO: move the API_KEY into a secret store",
    "PORT=3000",
    "NODE_ENV=production"
  ].join("\n");

  const result = redactSecrets(source);
  assert.equal(result.count, 0, `nothing should be masked, got: ${result.text}`);
  assert.equal(result.text, source);
});

test("redactSecrets leaves ordinary code untouched", () => {
  const code = [
    "export interface AuthConfig {",
    "  readonly tokenUrl: string;",
    "  readonly clientId: string;",
    "}",
    "",
    "export async function login(user: string, password: string) {",
    "  const response = await fetch(`${base}/login`, {",
    "    method: 'POST',",
    "    headers: { 'Content-Type': 'application/json' },",
    "    body: JSON.stringify({ user, password })",
    "  });",
    "  return response.json();",
    "}"
  ].join("\n");

  const result = redactSecrets(code);
  assert.equal(result.count, 0);
  assert.equal(result.text, code);
});

test("redactSecrets handles a realistic .env and command output", () => {
  const envFile = [
    "# production",
    "PORT=8080",
    "DATABASE_URL=postgres://app:Tr0ub4dor&3xyz@10.0.0.5:5432/prod",
    `STRIPE_SECRET_KEY=${fake("sk", "_live_", "51Habcdefghijklmnopqrstuvwxyz")}`,
    `AWS_ACCESS_KEY_ID=${fake("AKI", "AIOSFODNN7EXAMPLE")}`,
    `AWS_SECRET_ACCESS_KEY=${fake("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY")}`,
    "FEATURE_NEW_UI=true"
  ].join("\n");

  const result = redactSecrets(envFile);
  assert.ok(result.count >= 4);
  assert.match(result.text, /^PORT=8080$/m, "non-secrets survive");
  assert.match(result.text, /^FEATURE_NEW_UI=true$/m);
  for (const leak of ["Tr0ub4dor", "51Habcdefghij", "AIOSFODNN7EXAMPLE", "wJalrXUtnFEMI"]) {
    assert.ok(!result.text.includes(leak), `must not leak ${leak}`);
  }
});

test("redactionNote explains what was masked, and is empty when nothing was", () => {
  assert.equal(redactionNote({ text: "x", count: 0, kinds: [] }), "");
  const note = redactionNote({ text: "x", count: 2, kinds: ["GitHub token", "credential value"] });
  assert.match(note, /masked 2 credential values/);
  assert.match(note, /GitHub token, credential value/);
  assert.match(note, /never guess them/);
});
