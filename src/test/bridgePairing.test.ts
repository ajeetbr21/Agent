import * as http from "node:http";
import { createServer } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalBridgeServer } from "../bridge/localBridgeServer";
import {
  generatePairingToken,
  isAllowedBridgeOrigin,
  isUsableOverrideToken,
  LEGACY_BRIDGE_TOKEN,
  resolveBridgeToken,
  tokensMatch
} from "../bridge/pairing";

const STRONG = "a".repeat(43);

test("generatePairingToken returns unique 256-bit base64url tokens", () => {
  const tokens = new Set(Array.from({ length: 50 }, () => generatePairingToken()));
  assert.equal(tokens.size, 50);
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(isUsableOverrideToken(token));
  }
});

test("resolveBridgeToken prefers a strong setting, then the stored token, then generates", () => {
  const generate = () => "generated-token-generated-token-xx";

  assert.deepEqual(resolveBridgeToken(STRONG, "stored-token-stored-token-stored", generate), {
    token: STRONG,
    source: "setting"
  });
  assert.deepEqual(resolveBridgeToken("", "stored-token-stored-token-stored", generate), {
    token: "stored-token-stored-token-stored",
    source: "stored",
    ignoredSetting: undefined
  });
  assert.deepEqual(resolveBridgeToken(undefined, undefined, generate), {
    token: "generated-token-generated-token-xx",
    source: "generated",
    ignoredSetting: undefined
  });
});

test("resolveBridgeToken never accepts the legacy public token or weak overrides", () => {
  const generate = () => STRONG;

  const legacy = resolveBridgeToken(LEGACY_BRIDGE_TOKEN, undefined, generate);
  assert.equal(legacy.token, STRONG);
  assert.equal(legacy.source, "generated");
  assert.equal(legacy.ignoredSetting, "legacy");

  const short = resolveBridgeToken("hunter2", "stored-token-stored-token-stored", generate);
  assert.equal(short.source, "stored");
  assert.equal(short.ignoredSetting, "too-short");

  // A legacy value that somehow ended up in secret storage is replaced too.
  assert.equal(resolveBridgeToken("", LEGACY_BRIDGE_TOKEN, generate).source, "generated");
});

test("tokensMatch compares exactly and rejects empty input", () => {
  assert.equal(tokensMatch(STRONG, STRONG), true);
  assert.equal(tokensMatch(`${STRONG}x`, STRONG), false);
  assert.equal(tokensMatch("", STRONG), false);
  assert.equal(tokensMatch(null, STRONG), false);
  assert.equal(tokensMatch(undefined, STRONG), false);
  assert.equal(tokensMatch("x", ""), false);
});

test("isAllowedBridgeOrigin admits extension/local clients and refuses web pages", () => {
  assert.equal(isAllowedBridgeOrigin(undefined), true);
  assert.equal(isAllowedBridgeOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), true);
  assert.equal(isAllowedBridgeOrigin("moz-extension://1234-abcd"), true);

  assert.equal(isAllowedBridgeOrigin("https://chatgpt.com"), false);
  assert.equal(isAllowedBridgeOrigin("https://evil.example"), false);
  assert.equal(isAllowedBridgeOrigin("http://127.0.0.1:3000"), false);
  assert.equal(isAllowedBridgeOrigin("null"), false);
  assert.equal(isAllowedBridgeOrigin("chrome-extension://abc/../x"), false);
});

test("LocalBridgeServer refuses to start without a token", () => {
  assert.throws(() => new LocalBridgeServer({ port: 1, token: "", sessionId: "s" }));
});

test("LocalBridgeServer rejects WebSocket upgrades with a wrong token or a web-page origin", async (t) => {
  const port = await getFreePort();
  const server = new LocalBridgeServer({ port, token: STRONG, sessionId: "s" });
  await server.start();
  t.after(() => server.dispose());

  assert.equal(await upgradeStatus(port, "wrong-token"), 401);
  assert.equal(await upgradeStatus(port, LEGACY_BRIDGE_TOKEN), 401);
  assert.equal(await upgradeStatus(port, STRONG, "https://evil.example"), 403);
  assert.equal(await upgradeStatus(port, STRONG, "chrome-extension://abcdefghijklmnop"), 101);
  assert.equal(await upgradeStatus(port, STRONG), 101);
});

test("LocalBridgeServer rejects HTTP prompts from web-page origins even with the token", async (t) => {
  const port = await getFreePort();
  const server = new LocalBridgeServer({ port, token: STRONG, sessionId: "s" });
  await server.start();
  t.after(() => server.dispose());

  const body = JSON.stringify({ providerId: "chatgpt", chatUrl: "https://chatgpt.com/", prompt: "hi" });
  assert.equal(await httpStatus(port, "POST", "/prompt", { "x-webchat-token": STRONG, origin: "https://evil.example" }, body), 403);
  assert.equal(await httpStatus(port, "POST", "/prompt", { "x-webchat-token": "nope" }, body), 401);
  assert.equal(await httpStatus(port, "POST", "/prompt", { "x-webchat-token": STRONG }, body), 200);
  assert.equal(await httpStatus(port, "GET", "/health", { origin: "https://evil.example" }), 403);
});

function upgradeStatus(port: number, token: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64")
    };
    if (origin) {
      headers.Origin = origin;
    }
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: `/?token=${encodeURIComponent(token)}`,
      headers
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      // The server writes a bare status line and destroys the socket on rejection.
      const match = /HTTP\/1\.1 (\d{3})/.exec(String(error.message));
      if (match) {
        resolve(Number(match[1]));
      } else {
        reject(error);
      }
    });
    request.end();
  });
}

function httpStatus(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", ...headers } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Unable to allocate a free port.")));
      }
    });
  });
}
