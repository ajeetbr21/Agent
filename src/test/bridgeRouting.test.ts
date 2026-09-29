import { createServer } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalBridgeServer } from "../bridge/localBridgeServer";
import { createEnvelope, type BridgeEnvelope } from "../bridge/protocol";

// Regression tests for "every message opens new tabs": prompts used to be broadcast to every paired
// browser, and prompts queued while no browser was connected were replayed whenever one appeared.

type TestSocket = {
  readonly received: BridgeEnvelope[];
  send: (data: string) => void;
  close: () => void;
};

const TOKEN = "routing-test-token-routing-test-token";

test("a prompt goes to exactly one browser even when several are paired", async (t) => {
  const { server, port } = await startServer(t);
  const first = await connect(t, port);
  const second = await connect(t, port);
  await waitFor(() => server.getStatus().browserClients.length === 2);

  const sent = server.sendToBrowsers(prompt("hello"));
  await delay(150);

  assert.equal(sent, 1);
  assert.equal(countPrompts(first) + countPrompts(second), 1);
  // With no tab activity yet, the most recently connected browser wins.
  assert.equal(countPrompts(second), 1);
});

test("the browser with a live chat tab gets prompts, not one that merely reconnected", async (t) => {
  const { server, port } = await startServer(t);
  const chatting = await connect(t, port);
  chatting.send(JSON.stringify(browserMessage("bridge.status", { state: "tab-alive", tabId: 7 })));
  await delay(100);
  const idle = await connect(t, port); // newer connection, but no provider tab
  await waitFor(() => server.getStatus().browserClients.length === 2);

  server.sendToBrowsers(prompt("route me"));
  await delay(150);

  assert.equal(countPrompts(chatting), 1);
  assert.equal(countPrompts(idle), 0);
});

test("broadcast messages (providers.sync) still reach every browser", async (t) => {
  const { server, port } = await startServer(t);
  const first = await connect(t, port);
  const second = await connect(t, port);
  await waitFor(() => server.getStatus().browserClients.length === 2);

  const sent = server.sendToBrowsers(createEnvelope({
    id: "sync-1",
    sessionId: "s",
    type: "providers.sync",
    payload: { customProviders: [] }
  }));
  await delay(150);

  assert.equal(sent, 2);
  assert.ok(first.received.some((m) => m.type === "providers.sync"));
  assert.ok(second.received.some((m) => m.type === "providers.sync"));
});

test("queued prompts are delivered on a quick reconnect but dropped once stale", async (t) => {
  const { server, port } = await startServer(t, 300);

  assert.equal(server.sendToBrowsers(prompt("fresh")), 0); // queued
  const quick = await connect(t, port);
  await delay(150);
  assert.equal(countPrompts(quick), 1);
  quick.close();
  await waitFor(() => server.getStatus().browserClients.length === 0);

  assert.equal(server.sendToBrowsers(prompt("stale")), 0);
  await delay(450); // longer than the 300 ms TTL
  const late = await connect(t, port);
  await delay(150);
  assert.equal(countPrompts(late), 0);
});

function prompt(text: string): BridgeEnvelope {
  return createEnvelope({
    id: `prompt-${text}`,
    sessionId: "s",
    type: "chat.prompt",
    payload: { providerId: "chatgpt", chatUrl: "https://chatgpt.com/", prompt: text, promptNumber: 1, expectedAction: "submit" }
  });
}

function browserMessage(type: BridgeEnvelope["type"], payload: unknown): BridgeEnvelope {
  return createEnvelope({ id: `${type}-${Math.random()}`, sessionId: "browser-extension", type, payload });
}

function countPrompts(socket: TestSocket): number {
  return socket.received.filter((message) => message.type === "chat.prompt").length;
}

async function startServer(
  t: { after: (fn: () => void) => void },
  pendingTtlMs?: number
): Promise<{ server: LocalBridgeServer; port: number }> {
  const port = await getFreePort();
  const server = new LocalBridgeServer({ port, token: TOKEN, sessionId: "s", pendingTtlMs });
  await server.start();
  t.after(() => server.dispose());
  return { server, port };
}

async function connect(t: { after: (fn: () => void) => void }, port: number): Promise<TestSocket> {
  const WebSocketConstructor = (globalThis as unknown as {
    WebSocket: new (url: string) => {
      addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => void;
      send: (data: string) => void;
      close: () => void;
    };
  }).WebSocket;
  const ws = new WebSocketConstructor(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
  const received: BridgeEnvelope[] = [];
  ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data)) as BridgeEnvelope));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed.")));
  });
  t.after(() => ws.close());
  return { received, send: (data) => ws.send(data), close: () => ws.close() };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await delay(20);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
