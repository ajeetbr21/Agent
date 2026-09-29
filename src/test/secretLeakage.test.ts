import test from "node:test";
import assert from "node:assert/strict";
import { isSecretFile, redactSecrets } from "../prompt/redact";

/**
 * End-to-end style check on the values themselves: take a realistic project that contains
 * credentials in several places and assert none of them can survive into an outgoing message —
 * either because the file is never read, or because the scan masks the value.
 */

/**
 * Invented credentials, assembled at runtime: writing a literal token shape into this file would be
 * flagged by secret scanners (GitHub push protection blocks such a commit) even though the values are
 * fake. Splitting the recognisable prefix avoids that while keeping the test realistic.
 */
const fake = (...parts: string[]) => parts.join("");

const SECRETS = {
  dbPassword: "Tr0ub4dor3-horse-battery",
  stripeKey: fake("sk", "_live_", "51HabcdefghijklmnopqrstuvwxyzABCD"),
  awsId: fake("AKI", "AIOSFODNN7EXAMPLE"),
  awsSecret: fake("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
  githubToken: fake("ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
  openaiKey: fake("sk", "-proj-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"),
  jwt: fake("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJhZG1pbiJ9", ".", "s7yQ1xhC0Vb3nKqPzR4mN8dLwTgXeUvA2f"),
  privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${fake("b3BlbnNzaC1rZXkt", "djEAAAAA")}\n-----END OPENSSH PRIVATE KEY-----`
};

/** Files a normal repository really has, with secrets spread across them. */
const PROJECT: Record<string, string> = {
  ".env": [
    "PORT=8080",
    `DATABASE_URL=postgres://app:${SECRETS.dbPassword}@db:5432/prod`,
    `STRIPE_SECRET_KEY=${SECRETS.stripeKey}`,
    "FEATURE_FLAG=true"
  ].join("\n"),
  ".env.production": `AWS_ACCESS_KEY_ID=${SECRETS.awsId}\nAWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret}`,
  ".npmrc": `//registry.npmjs.org/:_authToken=${SECRETS.githubToken}`,
  "keys/id_rsa": SECRETS.privateKey,
  "certs/server.key": SECRETS.privateKey,
  "gcp/service-account.json": `{ "private_key": "${SECRETS.privateKey.replace(/\n/g, "\\n")}" }`,
  // Secrets that leaked into ordinary source files — these ARE read, so the scan must catch them.
  "src/config.ts": [
    "export const config = {",
    `  apiKey: "${SECRETS.openaiKey}",`,
    "  retries: 3,",
    "  timeoutMs: 30000",
    "};"
  ].join("\n"),
  "src/legacy.ts": `const session = "${SECRETS.jwt}"; // TODO: move to env`,
  "docs/setup.md": `Run with \`AWS_ACCESS_KEY_ID=${SECRETS.awsId}\` set.`,
  // Documentation of the same shape must stay readable.
  ".env.example": `PORT=8080\nDATABASE_URL=postgres://user:your-password@localhost:5432/dev\nSTRIPE_SECRET_KEY=${fake("sk", "_live_", "replace_me")}`
};

/** What the extension would actually send for a file: nothing, or the scanned contents. */
function outgoingFor(path: string, content: string): string {
  return isSecretFile(path) ? `[skipped ${path}]` : redactSecrets(content).text;
}

test("no secret value from a realistic project can reach an outgoing message", () => {
  const everythingSent = Object.entries(PROJECT)
    .map(([path, content]) => outgoingFor(path, content))
    .join("\n\n");

  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!everythingSent.includes(value), `${name} must not be sent`);
  }
  // The private key's body, in either raw or JSON-escaped form.
  assert.ok(!everythingSent.includes(fake("b3BlbnNzaC1rZXkt", "djEAAAAA")), "key material must not be sent");
});

test("credential files are skipped, ordinary files are still sent", () => {
  assert.equal(outgoingFor(".env", PROJECT[".env"]), "[skipped .env]");
  assert.equal(outgoingFor("keys/id_rsa", PROJECT["keys/id_rsa"]), "[skipped keys/id_rsa]");
  assert.equal(outgoingFor(".npmrc", PROJECT[".npmrc"]), "[skipped .npmrc]");

  const config = outgoingFor("src/config.ts", PROJECT["src/config.ts"]);
  assert.match(config, /export const config = \{/, "the code is still sent");
  assert.match(config, /retries: 3/, "non-secrets survive");
  assert.match(config, /timeoutMs: 30000/);
  assert.ok(!config.includes(SECRETS.openaiKey), "but the key is masked");
});

test("the example file stays fully readable", () => {
  const sent = outgoingFor(".env.example", PROJECT[".env.example"]);
  assert.equal(sent, PROJECT[".env.example"], "documentation must not be skipped or mangled");
});

test("secrets in command output are masked", () => {
  // e.g. the agent runs `printenv` or a deploy script that echoes its configuration.
  const output = [
    "$ printenv | sort",
    `AWS_ACCESS_KEY_ID=${SECRETS.awsId}`,
    `AWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret}`,
    "HOME=/home/dev",
    "NODE_ENV=production",
    `GITHUB_TOKEN=${SECRETS.githubToken}`
  ].join("\n");

  const sent = redactSecrets(output).text;
  assert.match(sent, /HOME=\/home\/dev/, "harmless environment survives");
  assert.match(sent, /NODE_ENV=production/);
  for (const value of [SECRETS.awsId, SECRETS.awsSecret, SECRETS.githubToken]) {
    assert.ok(!sent.includes(value));
  }
});

test("secrets inside a git diff are masked", () => {
  const diff = [
    "diff --git a/src/config.ts b/src/config.ts",
    "@@ -1,3 +1,3 @@",
    '-  apiKey: "",',
    `+  apiKey: "${SECRETS.openaiKey}",`,
    "   retries: 3"
  ].join("\n");

  const sent = redactSecrets(diff).text;
  assert.match(sent, /diff --git a\/src\/config\.ts/, "the diff structure survives");
  assert.match(sent, /retries: 3/);
  assert.ok(!sent.includes(SECRETS.openaiKey));
});
