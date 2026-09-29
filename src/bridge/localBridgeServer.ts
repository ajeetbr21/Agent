import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import * as http from "http";
import * as net from "net";
import type { BridgeEnvelope, ChatPromptPayload } from "./protocol";
import { createEnvelope } from "./protocol";
import { isAllowedBridgeOrigin, tokensMatch } from "./pairing";
import {
  createWebSocketAccept,
  decodeFrames,
  encodePingFrame,
  encodePongFrame,
  encodeTextFrame
} from "./webSocketCodec";

export interface BridgeServerOptions {
  readonly port: number;
  readonly token: string;
  readonly sessionId: string;
  /** How long a message waits for a browser to (re)connect before it is dropped. Default 30 s. */
  readonly pendingTtlMs?: number;
}

export interface BridgeClientInfo {
  readonly id: string;
  readonly userAgent: string;
  readonly connectedAt: string;
}

export interface BridgeStatus {
  readonly running: boolean;
  readonly port: number;
  readonly browserClients: readonly BridgeClientInfo[];
}

/** What `/health` reveals to callers that did not present the pairing token. */
export interface PublicBridgeStatus {
  readonly running: boolean;
  readonly port: number;
  readonly clientCount: number;
  readonly authenticated: false;
}

interface BridgeClient {
  readonly info: BridgeClientInfo;
  socket: net.Socket;
  buffer: Buffer;
  /** Order of connection (newer = larger); last tie-breaker for which browser gets prompts. */
  readonly connectedSeq: number;
  /** Date.now() of the last chat.* message (prompt handled, reply streamed) from this browser. */
  lastChatActivityAt: number;
  /** Date.now() of the last sign that this browser has a live provider tab open. */
  lastTabAliveAt: number;
}

interface PendingMessage {
  readonly envelope: BridgeEnvelope;
  readonly queuedAt: number;
}

const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const CLIENT_PING_INTERVAL_MS = 5_000;
const MAX_PENDING_BROWSER_MESSAGES = 20;
const DEFAULT_PENDING_TTL_MS = 30_000;
/** Sent to every connected browser; everything else goes to exactly one (see sendToBrowsers). */
const BROADCAST_TYPES = new Set<BridgeEnvelope["type"]>(["providers.sync"]);
/** Browser → IDE messages that mean "this browser is the one with the live chat tab". */
const ACTIVITY_TYPES = new Set<BridgeEnvelope["type"]>(["chat.state", "chat.stream.delta", "chat.stream.done", "chat.error"]);
/** A browser whose provider tab reported in within this window counts as "has a live chat tab". */
const TAB_ALIVE_FRESH_MS = 30_000;

export class LocalBridgeServer {
  private readonly events = new EventEmitter();
  private readonly clients = new Map<string, BridgeClient>();
  private readonly pendingBrowserMessages: PendingMessage[] = [];
  private connectionCounter = 0;
  private server: http.Server | undefined;
  private pingTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: BridgeServerOptions) {
    if (!options.token) {
      throw new Error("LocalBridgeServer requires a non-empty pairing token.");
    }
  }

  onMessage(listener: (message: BridgeEnvelope) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((request, response) => {
      this.handleHttpRequest(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.sendJson(response, 500, { error: message });
      });
    });

    this.server.on("upgrade", (request, socket) => {
      this.handleUpgrade(request, socket as net.Socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port, "127.0.0.1", () => {
        this.server?.off("error", reject);
        this.startClientPing();
        resolve();
      });
    });
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.socket.destroy();
    }
    this.clients.clear();
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.server?.close();
    this.server = undefined;
    this.events.removeAllListeners();
  }

  getStatus(): BridgeStatus {
    return {
      running: this.server !== undefined,
      port: this.options.port,
      browserClients: [...this.clients.values()]
        .filter((client) => this.isClientConnected(client))
        .map((client) => client.info)
    };
  }

  /**
   * Deliver an envelope to the browser. Prompts and page commands go to ONE browser (see
   * clientsByPreference). Broadcasting them made every paired browser
   * (e.g. the LeechCode-launched profile plus your normal Chrome) open its own tab and answer.
   * Returns how many browsers received it (0 means it was queued briefly for a reconnect).
   */
  sendToBrowsers(envelope: BridgeEnvelope): number {
    this.pruneDisconnectedClients();

    const text = JSON.stringify(envelope);
    const targets = BROADCAST_TYPES.has(envelope.type)
      ? [...this.clients.values()]
      : this.clientsByPreference();
    let sent = 0;

    for (const client of targets) {
      try {
        client.socket.write(encodeTextFrame(text));
        sent += 1;
      } catch {
        this.removeClient(client.info.id);
        continue;
      }
      if (!BROADCAST_TYPES.has(envelope.type)) {
        break; // exactly one browser handles a prompt/command
      }
    }

    if (sent === 0 && !BROADCAST_TYPES.has(envelope.type)) {
      // Broadcast types are re-sent on every pair, so only targeted messages need the queue.
      this.queueBrowserMessage(envelope);
    }

    return sent;
  }

  /** Id of the browser client that currently receives prompts (for tests / diagnostics). */
  getPreferredClientId(): string | undefined {
    this.pruneDisconnectedClients();
    return this.clientsByPreference()[0]?.info.id;
  }

  /**
   * Which browser should handle a prompt, best first:
   * 1. browsers with a live provider tab (reported within TAB_ALIVE_FRESH_MS),
   * 2. then the one that most recently handled a chat turn,
   * 3. then the most recently connected.
   * This keeps prompts in the browser the user is actually chatting in, and a browser that merely
   * reconnected (e.g. after sleep) doesn't steal them.
   */
  private clientsByPreference(): BridgeClient[] {
    const now = Date.now();
    const fresh = (client: BridgeClient) => (now - client.lastTabAliveAt <= TAB_ALIVE_FRESH_MS ? 1 : 0);
    return [...this.clients.values()]
      .filter((client) => this.isClientConnected(client))
      .sort((a, b) =>
        fresh(b) - fresh(a) ||
        b.lastChatActivityAt - a.lastChatActivityAt ||
        b.connectedSeq - a.connectedSeq
      );
  }

  private pruneDisconnectedClients(): void {
    for (const [clientId, client] of this.clients.entries()) {
      if (!this.isClientConnected(client)) {
        this.removeClient(clientId);
      }
    }
  }

  private isClientConnected(client: BridgeClient): boolean {
    return !client.socket.destroyed &&
      !client.socket.readableEnded &&
      !client.socket.writableEnded;
  }

  private removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    client?.socket.destroy();
    this.clients.delete(clientId);
  }

  private queueBrowserMessage(envelope: BridgeEnvelope): void {
    this.pendingBrowserMessages.push({ envelope, queuedAt: Date.now() });

    if (this.pendingBrowserMessages.length > MAX_PENDING_BROWSER_MESSAGES) {
      this.pendingBrowserMessages.shift();
    }
  }

  private startClientPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.pingBrowserClients();
    }, CLIENT_PING_INTERVAL_MS);
  }

  private pingBrowserClients(): void {
    const payload = Buffer.from(String(Date.now()));

    for (const [clientId, client] of this.clients.entries()) {
      if (!this.isClientConnected(client)) {
        this.removeClient(clientId);
        continue;
      }

      try {
        client.socket.write(encodePingFrame(payload));
      } catch {
        this.removeClient(clientId);
      }
    }
  }

  private async handleHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

    if (!isAllowedBridgeOrigin(readHeader(request, "origin"))) {
      this.sendJson(response, 403, { error: "Forbidden origin" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      // Anyone local may learn whether the bridge is up; client details need the token.
      if (this.isAuthorizedHttpRequest(request, url)) {
        this.sendJson(response, 200, { ...this.getStatus(), authenticated: true });
      } else {
        const status = this.getStatus();
        const publicStatus: PublicBridgeStatus = {
          running: status.running,
          port: status.port,
          clientCount: status.browserClients.length,
          authenticated: false
        };
        this.sendJson(response, 200, publicStatus);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/prompt") {
      if (!this.isAuthorizedHttpRequest(request, url)) {
        this.sendJson(response, 401, { error: "Unauthorized" });
        return;
      }

      try {
        const payload = normalizePromptPayload(await readJsonBody(request));
        const envelope = createEnvelope<ChatPromptPayload>({
          id: randomUUID(),
          sessionId: this.options.sessionId,
          type: "chat.prompt",
          payload
        });
        const sent = this.sendToBrowsers(envelope);
        this.sendJson(response, 200, { sent, envelope });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.sendJson(response, 400, { error: message });
      }
      return;
    }

    this.sendJson(response, 404, { error: "Not found" });
  }

  private isAuthorizedHttpRequest(request: http.IncomingMessage, url: URL): boolean {
    const token = readHeader(request, "x-webchat-token") || url.searchParams.get("token");
    return tokensMatch(token, this.options.token);
  }

  private sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  }

  private handleUpgrade(request: http.IncomingMessage, socket: net.Socket): void {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    const token = url.searchParams.get("token");
    const key = request.headers["sec-websocket-key"];

    if (!isAllowedBridgeOrigin(readHeader(request, "origin"))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!tokensMatch(token, this.options.token) || typeof key !== "string") {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
      "\r\n"
    ].join("\r\n"));

    const clientId = randomUUID();
    const client: BridgeClient = {
      info: {
        id: clientId,
        userAgent: request.headers["user-agent"] || "Unknown browser",
        connectedAt: new Date().toISOString()
      },
      socket,
      buffer: Buffer.alloc(0),
      connectedSeq: ++this.connectionCounter,
      lastChatActivityAt: 0,
      lastTabAliveAt: 0
    };

    this.clients.set(clientId, client);
    this.acceptClient(client);
    this.flushPendingMessages(client);
    socket.setKeepAlive(true, 15_000);

    const removeClient = () => this.removeClient(clientId);
    socket.on("data", (chunk) => this.handleData(client, chunk));
    socket.on("end", removeClient);
    socket.on("close", removeClient);
    socket.on("error", removeClient);
  }

  private acceptClient(client: BridgeClient): void {
    client.socket.write(encodeTextFrame(JSON.stringify(createEnvelope({
      id: randomUUID(),
      sessionId: this.options.sessionId,
      type: "pair.accepted",
      payload: {
        clientId: client.info.id,
        connectedClients: this.clients.size
      }
    }))));
  }

  private flushPendingMessages(client: BridgeClient): void {
    if (this.pendingBrowserMessages.length === 0) {
      return;
    }

    // Only replay what is still fresh: a prompt the user gave up on minutes ago (and got on the
    // clipboard instead) must not suddenly be typed into a chat when a browser shows up later.
    const ttl = this.options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    const cutoff = Date.now() - ttl;
    const pending = this.pendingBrowserMessages.splice(0).filter((item) => item.queuedAt >= cutoff);

    for (const item of pending) {
      try {
        client.socket.write(encodeTextFrame(JSON.stringify(item.envelope)));
      } catch {
        this.pendingBrowserMessages.push(item);
        this.removeClient(client.info.id);
        return;
      }
    }
  }

  private handleData(client: BridgeClient, chunk: Buffer): void {
    try {
      const decoded = decodeFrames(Buffer.concat([client.buffer, chunk]));
      client.buffer = Buffer.from(decoded.remaining);

      for (const pongPayload of decoded.pongPayloads) {
        client.socket.write(encodePongFrame(pongPayload));
      }

      for (const message of decoded.messages) {
        const envelope = JSON.parse(message) as BridgeEnvelope;
        if (ACTIVITY_TYPES.has(envelope.type)) {
          client.lastChatActivityAt = Date.now();
          client.lastTabAliveAt = client.lastChatActivityAt;
        } else if (envelope.type === "bridge.status" && isTabAlive(envelope.payload)) {
          client.lastTabAliveAt = Date.now();
        }
        this.events.emit("message", envelope);
      }

      if (decoded.closeRequested) {
        this.removeClient(client.info.id);
      }
    } catch (error) {
      this.removeClient(client.info.id);
    }
  }
}

function isTabAlive(payload: unknown): boolean {
  return isRecord(payload) && payload.state === "tab-alive";
}

function readHeader(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_HTTP_BODY_BYTES) {
        reject(new Error("Request body is too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function normalizePromptPayload(value: unknown): ChatPromptPayload {
  if (!isRecord(value)) {
    throw new Error("Prompt request must be a JSON object.");
  }

  const providerId = readRequiredString(value, "providerId");
  const chatUrl = readRequiredString(value, "chatUrl");
  const prompt = readRequiredString(value, "prompt");
  const promptNumber = typeof value.promptNumber === "number" &&
    Number.isFinite(value.promptNumber)
    ? Math.max(0, Math.trunc(value.promptNumber))
    : 0;
  const expectedAction = isExpectedAction(value.expectedAction)
    ? value.expectedAction
    : "submit";
  const autoSubmit = typeof value.autoSubmit === "boolean"
    ? value.autoSubmit
    : undefined;
  const chunkIndex = readPositiveInt(value.chunkIndex);
  const chunkTotal = readPositiveInt(value.chunkTotal);

  return {
    providerId,
    chatUrl,
    prompt,
    promptNumber,
    expectedAction,
    autoSubmit,
    chunkIndex,
    chunkTotal
  };
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function readRequiredString(value: Record<string, unknown>, property: string): string {
  const field = value[property];

  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`Prompt request requires a non-empty ${property} string.`);
  }

  return field;
}

function isExpectedAction(value: unknown): value is ChatPromptPayload["expectedAction"] {
  return value === "submit" || value === "compact" || value === "continue" || value === "rotate";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
