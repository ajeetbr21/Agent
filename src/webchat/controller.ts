import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { exec, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type {
  BridgeEnvelope,
  ChatAttachment,
  ChatCancelPayload,
  ChatModelPayload,
  ChatNavigatePayload,
  ChatPromptPayload,
  ProvidersSyncPayload,
  ChatStreamDeltaPayload,
  ChatStreamDonePayload,
  ChatTogglePayload
} from "../bridge/protocol";
import { createEnvelope } from "../bridge/protocol";
import { LocalBridgeServer } from "../bridge/localBridgeServer";
import {
  generatePairingToken,
  MIN_BRIDGE_TOKEN_LENGTH,
  resolveBridgeToken,
  type BridgeTokenSource
} from "../bridge/pairing";
import {
  buildAgentResponseRepairPrompt,
  buildAgentToolInstructions,
  parseAgentResponse,
  type AgentFileChange,
  type AgentResponse,
  type AgentToolRequest
} from "../agent/toolProtocol";
import { describeTool, executeReadonlyTool } from "../agent/tools";
import { dangerousCommandReason } from "../agent/commandSafety";
import { buildCompactionPrompt } from "../prompt/compaction";
import { buildPrompt } from "../prompt/buildPrompt";
import { buildIndexPrimedNote, planIndexChunks } from "../prompt/indexChunker";
import { isSecretFile, redactSecrets, redactionNote, secretFileNotice, SECRET_FILE_GLOBS } from "../prompt/redact";
import { collectActiveEditorContext } from "../workspace/context";
import {
  AgentChangeError,
  applyAgentFileChanges,
  detectRevertConflicts,
  resolveWorkspacePath,
  revertAgentFileChanges,
  type AppliedAgentChange
} from "../workspace/applyAgentChanges";
import { openAppliedDiffs, previewAgentFileChanges } from "../workspace/previewAgentChanges";
import {
  findProviderByHost,
  getProvider,
  listCustomAdapters,
  listProviders,
  setCustomProviders
} from "../providers/registry";
import { normalizeId, type CustomProviderConfig } from "../providers/custom";
import type { WebChatProvider } from "../providers/types";
import type { PromptFile } from "../prompt/types";
import {
  applyPromptUsage,
  applyResponseUsage,
  capBudgetToWindow,
  CHARS_PER_TOKEN,
  decideNextSessionAction,
  defaultSessionPolicy,
  estimateTokens,
  startFreshSession,
  type SessionPolicy,
  type SessionUsage
} from "../session/policy";
import {
  CODEBASE_CONTEXT_TOKEN,
  FOLDER_CONTEXT_PREFIX,
  GIT_CONTEXT_TOKEN,
  OPEN_EDITORS_CONTEXT_TOKEN,
  PROBLEMS_CONTEXT_TOKEN
} from "../webview/messages";
import { collectDiagnostics, gitDiff, gitStatus, openEditorPaths, refreshDiagnostics } from "../agent/vscodeContext";
import { cleanStreamText, stripMarkedBlock } from "./streamText";
import { decideIndexTurn } from "./indexTurnGate";
import {
  chooseFailoverProvider,
  createRequestState,
  describePhase,
  isFailure,
  isTerminal,
  isSafeToRetryElsewhere,
  recordProviderResult,
  reduceRequest,
  type ProviderHealth,
  type RequestEvent,
  type RequestState
} from "./taskState";
import { buildContinuationPrompt, describeContinuation, type ContinuationPackage } from "./continuation";
import type {
  BridgeStatusInfo,
  ContextInfo,
  FileChangeInfo,
  ProviderInfo,
  SessionInfo,
  SessionUsageInfo,
  WebChatSettings
} from "../webview/messages";

/** Default tool-loop budget per user task; full access mode gets a larger default. */
const DEFAULT_TOOL_ITERATIONS = 6;
const DEFAULT_FULL_ACCESS_TOOL_ITERATIONS = 25;
/** Tool results carried into a continuation package when switching provider. */
const MAX_CARRIED_TOOL_RESULTS = 8;
/** Providers tried for one task before giving up. */
const MAX_FAILOVERS_PER_TASK = 2;

/** How many applied turns can be undone (>= the full-access loop budget, so a whole task fits). */
const MAX_UNDO_TURNS = 40;
/** @folder reads at most this many files (the prompt budget trims further). */
const MAX_FOLDER_MENTION_FILES = 60;
/** Mentioned files bigger than this are skipped (binaries, bundles, data dumps). */
const MAX_MENTION_FILE_BYTES = 400_000;
const MAX_COMMAND_OUTPUT_CHARS = 8000;
/** Max subagents that can be spawned within a single user task (bounds runaway delegation). */
const MAX_SUBAGENTS = 3;
/** How long to wait for the chat to acknowledge one codebase-index chunk before moving on. */
const INDEX_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_INDEX_CHUNKS = 80;
/** How many times to re-send a chunk that looked blocked (page busy / login overlay) before stopping. */
const MAX_INDEX_CHUNK_RETRIES = 2;

const BRIDGE_TOKEN_SECRET_KEY = "webchat.bridge.pairingToken";

/** WebChatSettings keys stored in user settings only (see updateSetting). */
const USER_LEVEL_SETTINGS = new Set<string>(["agentMode", "maxToolIterations", "confirmDangerousCommands", "failoverMode"]);

const COMPACT_ALONGSIDE_TASK_NOTE =
  "Session upkeep for this turn: do the user task above fully as usual, AND make the `summary` field a thorough compacted development state (objective, current status, decisions, files changed, next actions, known errors) so a fresh chat could continue from it.";

const SETTING_PATHS: Record<string, string> = {
  defaultProvider: "defaultProvider",
  includeSelectionOnly: "prompt.includeSelectionOnly",
  autoSubmit: "browser.autoSubmit",
  agentMode: "agent.mode",
  applyMode: "agent.applyMode",
  autoRepair: "agent.autoRepairInvalidResponses",
  maxToolIterations: "agent.maxToolIterations",
  failoverMode: "failover.mode",
  redactSecrets: "privacy.redactSecrets",
  confirmDangerousCommands: "agent.confirmDangerousCommands",
  indexChunked: "index.chunked",
  visionEnabled: "vision.enabled",
  visionEndpoint: "vision.endpoint",
  visionModel: "vision.model",
  bridgePort: "bridge.port",
  maxContextTokens: "session.maxContextTokens",
  maxInputTokens: "session.maxInputTokens",
  maxOutputTokens: "session.maxOutputTokens",
  compactEveryPrompts: "session.compactEveryPrompts",
  rotateWhenBudgetRemainingBelow: "session.rotateWhenBudgetRemainingBelow"
};

export interface DispatchInfo {
  readonly turnId: string;
  readonly instruction: string;
  readonly action: "submit" | "compact" | "rotate" | "continue";
  readonly clientCount: number;
  /** Estimated token count of the prompt sent this turn (chars/4). */
  readonly promptTokens: number;
}

/**
 * Single owner of the WebChat runtime: bridge lifecycle, session/budget bookkeeping, prompt
 * dispatch, assistant-response parsing, and file application. The webview panel and the legacy
 * command-palette flow both drive this one controller. UI surfaces subscribe to the events below.
 */
export class WebChatController implements vscode.Disposable {
  private readonly emitters = {
    status: new vscode.EventEmitter<BridgeStatusInfo>(),
    context: new vscode.EventEmitter<ContextInfo>(),
    settings: new vscode.EventEmitter<WebChatSettings>(),
    usage: new vscode.EventEmitter<SessionUsageInfo>(),
    dispatched: new vscode.EventEmitter<DispatchInfo>(),
    streamDelta: new vscode.EventEmitter<{ turnId?: string; text: string; fullText: string }>(),
    streamDone: new vscode.EventEmitter<{ turnId?: string; displayText: string; responseTokens: number }>(),
    cancelled: new vscode.EventEmitter<{ turnId?: string }>(),
    sessions: new vscode.EventEmitter<readonly SessionInfo[]>(),
    providers: new vscode.EventEmitter<readonly ProviderInfo[]>(),
    assistantParsed: new vscode.EventEmitter<{
      turnId?: string;
      summary: string;
      files: readonly FileChangeInfo[];
      commands: readonly string[];
      nextSteps: readonly string[];
    }>(),
    applyResult: new vscode.EventEmitter<{ applied: readonly FileChangeInfo[]; error?: string }>(),
    commandOutput: new vscode.EventEmitter<{ command: string; output: string; exitCode: number }>(),
    undoResult: new vscode.EventEmitter<{ turnId: string; reverted: readonly string[]; remaining: number }>(),
    notice: new vscode.EventEmitter<{ level: "info" | "warn" | "error"; message: string }>()
  };

  readonly onStatus = this.emitters.status.event;
  readonly onContext = this.emitters.context.event;
  readonly onSettings = this.emitters.settings.event;
  readonly onUsage = this.emitters.usage.event;
  readonly onDispatched = this.emitters.dispatched.event;
  readonly onStreamDelta = this.emitters.streamDelta.event;
  readonly onStreamDone = this.emitters.streamDone.event;
  readonly onCancelled = this.emitters.cancelled.event;
  readonly onSessions = this.emitters.sessions.event;
  readonly onProviders = this.emitters.providers.event;
  readonly onAssistantParsed = this.emitters.assistantParsed.event;
  readonly onApplyResult = this.emitters.applyResult.event;
  readonly onCommandOutput = this.emitters.commandOutput.event;
  readonly onUndoResult = this.emitters.undoResult.event;
  readonly onNotice = this.emitters.notice.event;

  private readonly output: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private bridge: LocalBridgeServer | undefined;
  private bridgeMessageDisposable: (() => void) | undefined;
  private bridgeSessionId: string;
  /** Where the running bridge's token came from (drives the Settings UI and regenerate warnings). */
  private bridgeTokenSource: BridgeTokenSource | undefined;
  private activeBridgeToken: string | undefined;
  private bridgeStarting: Promise<void> | undefined;
  private usage: SessionUsage = { promptCount: 0, inputTokensUsed: 0, outputTokensUsed: 0 };
  private activeAssistantText = "";
  private currentTurnId: string | undefined;
  private lastParsed: { turnId: string; response: AgentResponse } | undefined;
  /** Pre-edit snapshots for the most recently applied turn, powering before→after diffs. */
  private lastApplied: { turnId: string; changes: readonly AppliedAgentChange[] } | undefined;
  /** Applied turns that can be undone, newest last (bounded). */
  private readonly undoStack: { turnId: string; changes: readonly AppliedAgentChange[] }[] = [];
  /** Turns whose files/tools have already been acted on (guards duplicate stream.done events). */
  private readonly handledTurnIds = new Set<string>();
  /** Lifecycle of the in-flight request, so a failure can be classified safe-to-retry or ambiguous. */
  private activeRequest: RequestState | undefined;
  /** Per-provider failure counters and cooldowns, used when choosing a failover target. */
  private readonly providerHealth = new Map<string, ProviderHealth>();
  /** Tool results and errors gathered for this task, carried over if we switch provider. */
  private taskProgress: {
    objective: string;
    readonly toolResults: { label: string; output: string }[];
    readonly errors: string[];
    readonly changedFiles: { path: string; action: string }[];
    readonly relevantFiles: string[];
  } = { objective: "", toolResults: [], errors: [], changedFiles: [], relevantFiles: [] };
  /** Fires when a request stops producing any page feedback, so a silent tab can't stall the task. */
  private requestWatchdog: NodeJS.Timeout | undefined;
  /** Set once per session so the redaction notice isn't repeated on every turn. */
  private redactionNoticeShown = false;
  /** Guard so one failed request triggers at most one failover. */
  private failoverInFlight = false;
  private failoverCount = 0;
  /** Problems to report to the model with the next tool transcript (e.g. edits that didn't apply). */
  private pendingFeedback: string[] = [];
  /** One-off facts to tell the model on the next user turn (e.g. "the user undid your edits"). */
  private pendingNotes: string[] = [];
  /** The last user-initiated turn, so it can be re-sent on manual retry. */
  private lastUserDispatch: { instruction?: string; contextPaths?: readonly string[] } | undefined;
  private lastDispatchProvider: WebChatProvider | undefined;
  private repairAttempts = 0;
  private toolIterations = 0;
  /** Subagents spawned in the current user task; >0 also means "we are inside a subagent context". */
  private subagentCount = 0;
  private statusPollTimer: NodeJS.Timeout | undefined;
  private lastStatusKey = "";
  private lastClientCount = 0;
  /** While a chunked codebase index is being delivered, intermediate chat turns are gated here. */
  private indexingActive = false;
  /** Set by resetSession/dispose to abort an in-flight index delivery between chunks. */
  private indexAborted = false;
  /** Set when the current index chunk looked blocked, so the delivery loop re-sends it. */
  private indexRetryCurrent = false;
  private indexChunkRetries = 0;
  /**
   * Number of chunks whose per-chunk timeout fired and advanced the sender before the chat's real
   * `chat.stream.done` arrived. Those late acks must be swallowed rather than releasing the wrong
   * (already-advanced) chunk's waiter — otherwise one late done cascades into sending every
   * remaining chunk early.
   */
  private indexLateAcks = 0;
  private indexTurnResolver: (() => void) | undefined;
  private indexTurnTimer: NodeJS.Timeout | undefined;
  /** When true, incoming stream deltas/dones are ignored (the in-flight turn was cancelled). */
  private responseSuppressed = false;
  private warnedUntrustedFullAccess = false;
  /** Set by the panel when a webview is live, so we can prefer inline cards over modal dialogs. */
  webviewConnected = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("WebChat Bridge");
    this.disposables.push(this.output, ...Object.values(this.emitters));
    this.bridgeSessionId =
      context.globalState.get<string>("webchat.bridge.sessionId") || randomUUID();
    void context.globalState.update("webchat.bridge.sessionId", this.bridgeSessionId);
    this.loadCustomProviders(false);

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.emitContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.emitContext()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("webchat.customProviders")) {
          this.loadCustomProviders(true);
          this.emitters.providers.fire(this.getProvidersInfo());
          this.syncCustomProvidersToBrowser();
        }
        if (event.affectsConfiguration("webchat")) {
          this.emitters.settings.fire(this.getSettings());
          this.emitters.usage.fire(this.getUsageInfo());
        }
      })
    );

    // Poll the bridge so the panel reflects browser connect/disconnect within a few seconds.
    this.statusPollTimer = setInterval(() => this.pollStatus(), 3000);
  }

  dispose(): void {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
    }
    this.clearRequestWatchdog();
    this.indexAborted = true;
    this.finishIndexTurn();
    this.bridgeMessageDisposable?.();
    this.bridge?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Emit a status update only when running/port/client-count actually changed. */
  private pollStatus(): void {
    const status = this.getBridgeStatus();
    const key = `${status.running}:${status.port}:${status.clientCount}`;
    if (key === this.lastStatusKey) {
      return;
    }
    const previousCount = this.lastClientCount;
    this.lastStatusKey = key;
    this.lastClientCount = status.clientCount;
    this.emitters.status.fire(status);

    if (previousCount === 0 && status.clientCount > 0) {
      this.emitters.notice.fire({
        level: "info",
        message: `Browser connected — ${status.clientCount} chat tab ready. You can send now.`
      });
    } else if (previousCount > 0 && status.clientCount === 0) {
      this.emitters.notice.fire({ level: "warn", message: "Browser disconnected." });
    }
  }

  // ---- bridge ----------------------------------------------------------------------------------
  async startBridge(silent: boolean): Promise<void> {
    // Activation and the webview's "ready" both start the bridge; serialize them so only one
    // server binds the port and only one token is ever generated.
    if (!this.bridgeStarting) {
      this.bridgeStarting = this.startBridgeOnce(silent).finally(() => {
        this.bridgeStarting = undefined;
      });
    }
    return this.bridgeStarting;
  }

  private async startBridgeOnce(silent: boolean): Promise<void> {
    if (this.bridge?.getStatus().running) {
      return;
    }

    const config = vscode.workspace.getConfiguration("webchat");
    const port = config.get<number>("bridge.port", 53451);
    const token = await this.getBridgeToken(true);
    this.activeBridgeToken = token;

    this.bridge = new LocalBridgeServer({ port, token, sessionId: this.bridgeSessionId });
    this.bridgeMessageDisposable = this.bridge.onMessage((message) => this.handleBridgeMessage(message));

    try {
      await this.bridge.start();
      this.output.appendLine(`Bridge listening on ws://127.0.0.1:${port}`);
      if (!silent) {
        this.emitters.notice.fire({ level: "info", message: `Bridge started on port ${port}.` });
      }
    } catch (error) {
      this.bridgeMessageDisposable?.();
      this.bridge = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Bridge failed to start: ${message}`);
      this.emitters.notice.fire({ level: "error", message: `Bridge failed to start: ${message}` });
    }

    this.emitters.status.fire(this.getBridgeStatus());
  }

  /**
   * The pairing token the bridge requires. By default it is a random per-install secret kept in the
   * editor's SecretStorage (OS keychain) — never in settings.json, so it can't leak into a repo.
   * A strong `webchat.bridge.token` user setting overrides it; weak/legacy values are ignored.
   */
  private async getBridgeToken(announce: boolean): Promise<string> {
    const configured = vscode.workspace.getConfiguration("webchat").get<string>("bridge.token", "");
    const stored = await this.context.secrets.get(BRIDGE_TOKEN_SECRET_KEY);
    const resolved = resolveBridgeToken(configured, stored);

    if (resolved.source === "generated") {
      await this.context.secrets.store(BRIDGE_TOKEN_SECRET_KEY, resolved.token);
      this.output.appendLine("Generated a new bridge pairing token. Pair the browser extension with it.");
      // First run (or after a keychain reset): the panel may not be open yet, so use a toast.
      void vscode.window
        .showInformationMessage(
          "LeechCode generated a private bridge pairing token. Paste it into the WebChat Bridge browser extension (click its toolbar icon) to connect.",
          "Copy pairing token"
        )
        .then((choice) => {
          if (choice) {
            void this.copyBridgeToken();
          }
        });
    }
    if (resolved.ignoredSetting && announce) {
      const reason = resolved.ignoredSetting === "legacy"
        ? "is the old public default"
        : `is shorter than ${MIN_BRIDGE_TOKEN_LENGTH} characters`;
      this.output.appendLine(`Ignoring webchat.bridge.token: it ${reason}. Using the generated pairing token.`);
      this.emitters.notice.fire({
        level: "warn",
        message: `webchat.bridge.token ${reason} and was ignored; the generated pairing token is used instead.`
      });
    }

    this.bridgeTokenSource = resolved.source === "setting" ? "setting" : "stored";
    return resolved.token;
  }

  /** Copy the active pairing token so the user can paste it into the browser extension. */
  async copyBridgeToken(): Promise<void> {
    // Prefer the token the running bridge actually enforces (settings may have changed since).
    const token = this.bridge?.getStatus().running && this.activeBridgeToken
      ? this.activeBridgeToken
      : await this.getBridgeToken(false);
    await vscode.env.clipboard.writeText(token);
    this.emitters.settings.fire(this.getSettings());
    this.emitters.notice.fire({
      level: "info",
      message: "Bridge pairing token copied. Paste it in the WebChat Bridge extension options (click the extension icon)."
    });
  }

  /** Replace the stored pairing token, restart the bridge and drop every paired browser. */
  async regenerateBridgeToken(): Promise<void> {
    await this.context.secrets.store(BRIDGE_TOKEN_SECRET_KEY, generatePairingToken());
    if (this.bridgeTokenSource === "setting") {
      this.emitters.notice.fire({
        level: "warn",
        message: "A new token was stored, but webchat.bridge.token is set and still takes precedence. Clear that setting to use the generated token."
      });
    }
    await this.restartBridge();
    await this.copyBridgeToken();
  }

  private async restartBridge(): Promise<void> {
    await this.bridgeStarting;
    this.bridgeMessageDisposable?.();
    this.bridgeMessageDisposable = undefined;
    this.bridge?.dispose();
    this.bridge = undefined;
    await this.startBridge(true);
  }

  getBridgeStatus(): BridgeStatusInfo {
    const status = this.bridge?.getStatus();
    return {
      running: Boolean(status?.running),
      port: status?.port ?? vscode.workspace.getConfiguration("webchat").get<number>("bridge.port", 53451),
      clientCount: status?.browserClients.length ?? 0
    };
  }

  // ---- prompt dispatch -------------------------------------------------------------------------
  async dispatchPrompt(
    instruction?: string,
    forcedAction?: "compact" | "rotate" | "continue",
    contextPaths?: readonly string[],
    resetToolLoop = true,
    attachments?: readonly ChatAttachment[]
  ): Promise<DispatchInfo | undefined> {
    this.responseSuppressed = false; // a new dispatch is a live turn again (clears a prior cancel)
    if (resetToolLoop) {
      this.toolIterations = 0; // a fresh user turn restarts the tool-loop budget
      this.subagentCount = 0; // and the subagent budget / depth
      if (!forcedAction) {
        this.lastUserDispatch = { instruction, contextPaths }; // remember it for manual retry
      }
    }
    const provider = this.getCurrentProvider();
    if (!provider) {
      this.emitters.notice.fire({ level: "error", message: "No web chat provider is configured." });
      return undefined;
    }

    await this.startBridge(true);
    if (!this.bridge?.getStatus().running) {
      this.emitters.notice.fire({ level: "error", message: "WebChat bridge is not running." });
      return undefined;
    }

    // Local vision: turn attached images into text with the user's own model, so the web chat's
    // limited image support is bypassed — the chat LLM receives a rich description instead of a raw
    // image. Non-image attachments (and images when vision is off) still go to the browser injector.
    if (attachments && attachments.length > 0 && this.getBool("vision.enabled", false)) {
      const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
      if (images.length > 0) {
        const described = await this.describeImagesLocally(images);
        if (described) {
          instruction = [instruction, described].filter(Boolean).join("\n\n");
          attachments = attachments.filter((a) => !a.mimeType.startsWith("image/"));
        }
      }
    }

    // Whole-codebase index: if it won't fit one message, deliver the files across several ordered
    // messages first (waiting for the chat to acknowledge each), then send the real task through the
    // normal path with the codebase already primed into the conversation.
    if (
      !forcedAction &&
      contextPaths?.includes(CODEBASE_CONTEXT_TOKEN) &&
      this.getBool("index.chunked", true)
    ) {
      const delivered = await this.deliverCodebaseIndex(provider, contextPaths);
      if (delivered < 0) {
        return undefined; // delivery was aborted (session reset / dispose) — do not send a task turn
      }
      if (delivered > 0) {
        const remaining = contextPaths.filter((p) => p !== CODEBASE_CONTEXT_TOKEN);
        const note = buildIndexPrimedNote(delivered);
        const taskInstruction = instruction ? `${note}\n\n${instruction}` : note;
        // Force a normal task turn: we just primed this chat, so it must NOT be hijacked into a
        // compact/rotate action (which would discard the priming we just delivered).
        return this.dispatchPrompt(taskInstruction, "continue", remaining, false, attachments);
      }
      // delivered === 0: index fit one message, chunking disabled, or no browser — fall through to
      // the normal single-message path (which truncates to fit / copies to clipboard as before).
    }

    // Compact/rotate are decided only on fresh user turns. Tool results, subagent tasks and repairs
    // must land in the SAME chat that asked for them — rotating there opened a new tab and sent the
    // tool output to a conversation that never saw the request.
    const sessionAction = forcedAction ?? (resetToolLoop ? undefined : "continue");
    // One-off notes for the model (e.g. "the user undid your edits") ride along with the next turn.
    // Kept out of `instruction` so they don't appear in the user's own chat bubble.
    const notes = instruction?.trim() && this.pendingNotes.length > 0 ? this.pendingNotes.join("\n") : "";
    if (notes) {
      this.pendingNotes = [];
    }
    // Include the project tree on fresh user turns; skip on tool-loop continuations (already in context).
    const { prompt, action } = await this.buildProviderPrompt(
      provider,
      notes ? `${notes}\n\n${instruction}` : instruction,
      sessionAction,
      contextPaths,
      resetToolLoop
    );
    // A rotate starts a new conversation, so its budget starts over. (Without this reset every later
    // prompt was also "rotate" — a new browser tab for every single message.)
    this.usage = action === "rotate" ? startFreshSession(prompt) : applyPromptUsage(this.usage, prompt);
    const providerLimit = this.getProviderMessageLimit(provider.id);
    if (prompt.length > providerLimit) {
      this.emitters.notice.fire({
        level: "warn",
        message: `Prompt (~${Math.round(prompt.length / 1000)}k chars) exceeds ${provider.label}'s ~${Math.round(providerLimit / 1000)}k per-message limit and may be rejected as "too long". Remove some @context or raise the limit in Settings.`
      });
    }
    this.activeAssistantText = "";
    const turnId = randomUUID();
    this.currentTurnId = turnId;
    this.lastDispatchProvider = provider;
    this.repairAttempts = 0;

    const clientCount = this.bridge.sendToBrowsers(
      createEnvelope<ChatPromptPayload>({
        id: randomUUID(),
        sessionId: this.bridgeSessionId,
        type: "chat.prompt",
        payload: {
          providerId: provider.id,
          chatUrl: provider.chatUrl,
          prompt: this.protectOutgoing(prompt),
          promptNumber: this.usage.promptCount,
          expectedAction: action === "compact" || action === "rotate" ? action : "submit",
          autoSubmit: this.getBool("browser.autoSubmit", false),
          attachments: attachments && attachments.length > 0 ? attachments : undefined
        }
      })
    );

    // Track this request's lifecycle: only a failure that happened before the page submitted may be
    // retried on another provider.
    this.activeRequest = reduceRequest(createRequestState(turnId, provider.id), {
      kind: "dispatched",
      providerId: provider.id,
      delivered: clientCount > 0
    });
    this.armRequestWatchdog();
    if (resetToolLoop && instruction?.trim()) {
      // A fresh user turn starts a new task: reset what we carry over on a provider switch.
      this.taskProgress = { objective: instruction.trim(), toolResults: [], errors: [], changedFiles: [], relevantFiles: [] };
      this.failoverCount = 0;
    }
    if (contextPaths && contextPaths.length > 0) {
      for (const path of contextPaths) {
        if (!path.startsWith("::") && !this.taskProgress.relevantFiles.includes(path)) {
          this.taskProgress.relevantFiles.push(path);
        }
      }
    }

    const info: DispatchInfo = {
      turnId,
      instruction: this.describeInstruction(instruction, action), // without `notes` — that's for the model
      action,
      clientCount,
      promptTokens: estimateTokens(prompt)
    };
    this.emitters.dispatched.fire(info);
    this.emitters.usage.fire(this.getUsageInfo());

    if (clientCount === 0) {
      await vscode.env.clipboard.writeText(prompt);
      this.emitters.notice.fire({
        level: "warn",
        message: "No browser is connected — the prompt was copied to your clipboard. It is still delivered if the browser reconnects within 30 seconds."
      });
    }

    return info;
  }

  compactNow(): Promise<DispatchInfo | undefined> {
    return this.dispatchPrompt(undefined, "compact");
  }

  rotateNow(): Promise<DispatchInfo | undefined> {
    return this.dispatchPrompt(undefined, "rotate");
  }

  /**
   * Cancel the in-flight prompt: suppress its (still-streaming) response, tell the browser to stop
   * generating on the page, and send a short follow-up so the chat model disregards the cancelled
   * message. The next user dispatch clears the suppression.
   */
  async cancelPrompt(turnId?: string): Promise<void> {
    if (turnId && this.currentTurnId && turnId !== this.currentTurnId) {
      return; // not the active turn — nothing to cancel
    }

    this.responseSuppressed = true;
    this.noteRequestEvent({ kind: "cancelled" });
    // Also abort any in-flight chunked-index delivery.
    this.indexAborted = true;
    this.finishIndexTurn();

    const cancelledTurn = this.currentTurnId;
    const provider = this.lastDispatchProvider ?? this.getCurrentProvider();
    const connected = Boolean(this.bridge?.getStatus().running) && this.getBridgeStatus().clientCount > 0;

    // 1) Stop generation on the provider page.
    if (connected && provider) {
      this.bridge!.sendToBrowsers(
        createEnvelope<ChatCancelPayload>({
          id: randomUUID(),
          sessionId: this.bridgeSessionId,
          type: "chat.cancel",
          payload: { providerId: provider.id, reason: "user-cancelled" }
        })
      );
    }

    // 2) Update the UI (stop the spinner, mark the turn cancelled).
    this.emitters.cancelled.fire({ turnId: cancelledTurn });
    this.emitters.notice.fire({ level: "info", message: "Cancelled the request." });

    // 3) Convey to the chat model that the last message should be ignored. Sent raw (not via
    //    dispatchPrompt) and auto-submitted so it doesn't clear the suppression flag — its "ok"
    //    acknowledgement is swallowed too.
    if (connected && provider) {
      this.bridge!.sendToBrowsers(
        createEnvelope<ChatPromptPayload>({
          id: randomUUID(),
          sessionId: this.bridgeSessionId,
          type: "chat.prompt",
          payload: {
            providerId: provider.id,
            chatUrl: provider.chatUrl,
            prompt:
              "I cancelled my previous message. Please disregard it entirely — do not act on it, run tools, or produce any file changes. Just reply \"ok\" and wait for my next instruction.",
            promptNumber: this.usage.promptCount,
            expectedAction: "continue",
            autoSubmit: true
          }
        })
      );
    }
  }

  // ---- assistant response handling -------------------------------------------------------------
  private handleBridgeMessage(message: BridgeEnvelope): void {
    this.output.appendLine(`[${message.type}] ${JSON.stringify(message.payload)}`);

    if (message.type === "pair.request") {
      this.pollStatus();
      this.syncCustomProvidersToBrowser(); // a (re)connected browser needs the custom AI sites
      return;
    }
    if (message.type === "bridge.status") {
      this.pollStatus();
      return;
    }

    // Track which conversation the connected tab is in (on state/done transitions, not every delta).
    if (message.type === "chat.state" || message.type === "chat.stream.done") {
      this.recordSessionFromPayload(message.payload);
    }

    this.trackRequest(message);

    // A cancelled turn (and the follow-up "disregard" exchange) — ignore all streaming until the
    // next real dispatch clears the flag, so nothing from the abandoned prompt reaches the UI/parser.
    if (this.responseSuppressed) {
      return;
    }

    // While priming the chat with codebase-index chunks, swallow the acknowledgement turns: don't
    // stream them into the UI or parse them as agent responses. A stream.done just releases the
    // sequential sender to deliver the next chunk.
    if (this.indexingActive) {
      switch (decideIndexTurn(message.type, message.payload, this.indexLateAcks)) {
        case "abort": {
          // A blocking page state (login wall, rate limit, transient stuck). Don't kill the whole
          // delivery — signal the loop to RE-SEND the current chunk (the browser also self-heals
          // overlays + retries submits). The loop gives up only after MAX_INDEX_CHUNK_RETRIES.
          this.indexRetryCurrent = true;
          this.finishIndexTurn();
          break;
        }
        case "swallow-late":
          this.indexLateAcks -= 1; // real ack for a chunk we already timed out past — ignore it
          break;
        case "release":
          this.finishIndexTurn();
          break;
        default:
          break; // ignore streaming deltas / unrelated states
      }
      return;
    }

    if (message.type === "chat.stream.delta" && isDelta(message.payload)) {
      this.activeAssistantText = message.payload.fullText || `${this.activeAssistantText}${message.payload.text}`;
      // Usage is counted once, on done: a streaming page often re-renders earlier text, and then the
      // "delta" is the whole reply again — summing deltas inflated output usage many times over.
      this.emitters.streamDelta.fire({
        turnId: this.currentTurnId,
        text: message.payload.text,
        // Hide the raw <webchat_agent_response> protocol block while it streams.
        fullText: cleanStreamText(this.activeAssistantText)
      });
      return;
    }

    if (message.type === "chat.error") {
      return; // already folded into the request state by trackRequest
    }

    if (message.type === "chat.stream.done" && isDone(message.payload)) {
      this.activeAssistantText = message.payload.fullText || this.activeAssistantText;
      this.usage = applyResponseUsage(this.usage, this.activeAssistantText);
      this.emitters.usage.fire(this.getUsageInfo());
      void this.handleAssistantDone(this.activeAssistantText, message.payload.providerId);
    }
  }

  private async handleAssistantDone(fullText: string, providerId?: string): Promise<void> {
    // A provider page can emit a second chat.stream.done for the same reply (late DOM mutations
    // after the quiescence timer). Applying a turn twice would duplicate insert-style edits and run
    // its tools again, so side effects happen once per turn.
    const doneTurnId = this.currentTurnId;
    const alreadyHandled = doneTurnId !== undefined && this.handledTurnIds.has(doneTurnId);

    this.emitters.streamDone.fire({
      turnId: this.currentTurnId,
      displayText: stripMarkedBlock(fullText),
      responseTokens: estimateTokens(fullText)
    });

    if (alreadyHandled) {
      this.output.appendLine(`Ignored a repeated completion for turn ${doneTurnId}.`);
      return;
    }

    let response: AgentResponse | undefined;
    try {
      response = parseAgentResponse(fullText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Could not parse WebChat agent response: ${message}`);
      this.noteRequestEvent({ kind: "parse-failed", detail: message });
      const repaired = await this.requestRepair(fullText, message, providerId);
      if (!repaired) {
        this.emitters.notice.fire({ level: "warn", message: `Agent response was not valid: ${message}` });
      }
      return;
    }

    if (!response) {
      return;
    }

    const turnId = this.currentTurnId ?? randomUUID();
    this.noteRequestEvent({ kind: "parsed" });
    this.handledTurnIds.add(turnId);
    if (this.handledTurnIds.size > 100) {
      this.handledTurnIds.delete(this.handledTurnIds.values().next().value as string);
    }
    this.lastParsed = { turnId, response };
    await this.context.globalState.update("webchat.session.summary", response.summary);
    // Mirror the summary onto the active tracked chat so resuming it later can re-prime the model.
    this.updateActiveSessionSummary(response.summary);

    this.emitters.assistantParsed.fire({
      turnId,
      summary: response.summary,
      files: response.files.map((file) => ({ path: file.path, action: file.action })),
      // Only privileged tools (run/spawn_subagent) surface in the approval card; read-only tools
      // (read_file/list_dir/search) run automatically and show up as tool-output messages.
      commands: response.tools.filter(isPrivilegedTool).map(toolApprovalLabel),
      nextSteps: response.nextSteps
    });

    const mode = this.getAgentMode();
    const applyMode = this.getApplyMode();

    // 1) File changes. Problems (e.g. an edit whose "find" text isn't in the file) are reported
    // back to the model together with this turn's tool output, so it can correct itself.
    this.pendingFeedback = [];
    if (response.files.length > 0) {
      if (applyMode === "auto") {
        const result = await this.applyChanges(turnId, { feedbackToModel: false });
        if (!result.ok) {
          this.pendingFeedback.push(result.feedback);
        }
      } else if (applyMode === "ask" && !this.webviewConnected) {
        await this.askToApplyViaModal(response);
      }
    }

    // 2) Tools. Read-only tools (read_file/list_dir/search) are always safe to auto-run. Privileged
    // tools (run/spawn_subagent) require approval in ask AND auto modes; only bypass auto-runs them;
    // plan runs neither. The webview shows an approval card; headless falls back to a modal.
    if (response.tools.length === 0) {
      await this.flushPendingFeedback(); // edits failed and nothing else will continue the loop
      return;
    }
    {
      const privileged = response.tools.filter(isPrivilegedTool);
      const readOnly = response.tools.filter((tool) => !isPrivilegedTool(tool));

      if (mode === "plan") {
        if (readOnly.length > 0) {
          await this.runTools(turnId, readOnly); // reading to plan is allowed; no run/spawn/edits
        }
      } else if (mode === "bypass") {
        // Full access: run everything without prompts — except commands that look destructive
        // (wipe a drive, force-push…) when the dangerous-command guard is on.
        const dangerous = this.getBool("agent.confirmDangerousCommands", true)
          ? privileged.filter((tool) => tool.name === "run" && Boolean(dangerousCommandReason(tool.command)))
          : [];
        if (dangerous.length === 0 || (await this.confirmDangerousTools(dangerous))) {
          await this.runTools(turnId, response.tools);
        } else {
          for (const tool of dangerous) {
            this.emitters.commandOutput.fire({
              command: `$ ${describeTool(tool)}`,
              output: "Declined by the user (flagged as potentially destructive).",
              exitCode: 1
            });
          }
          await this.runTools(turnId, response.tools.filter((tool) => !dangerous.includes(tool)), [
            `The user declined these commands, so they were NOT run: ${dangerous.map(describeTool).join("; ")}. Find a safer way or ask the user.`
          ]);
        }
      } else if (privileged.length === 0) {
        await this.runTools(turnId, readOnly); // ask/auto: read-only tools are safe to auto-run
      } else if (!this.webviewConnected) {
        const choice = await vscode.window.showWarningMessage(
          `LeechCode wants to run ${privileged.length} tool${privileged.length === 1 ? "" : "s"}.`,
          { modal: true, detail: privileged.map(describeTool).join("\n") },
          "Run",
          "Skip"
        );
        if (choice === "Run") {
          await this.runTools(turnId, response.tools);
        } else {
          await this.flushPendingFeedback();
        }
      }
      // ask/auto + webview + privileged tools: wait for the approval card (runCommands message).
    }
  }

  /**
   * Last line of defence before anything leaves the machine: mask credential-looking values in the
   * outgoing prompt. Everything sent to a provider page goes through here — user prompts, file
   * context, command output, git diffs and handover packages — because a web chat is a third party.
   */
  private protectOutgoing(prompt: string): string {
    if (!this.getBool("privacy.redactSecrets", true)) {
      return prompt;
    }
    const result = redactSecrets(prompt);
    if (result.count === 0) {
      return prompt;
    }
    this.output.appendLine(`Masked ${result.count} credential value(s) before sending: ${result.kinds.join(", ")}`);
    if (!this.redactionNoticeShown) {
      this.redactionNoticeShown = true;
      this.emitters.notice.fire({
        level: "info",
        message: `Masked ${result.count} credential value${result.count === 1 ? "" : "s"} (${result.kinds.join(", ")}) before sending to the chat. Turn off with webchat.privacy.redactSecrets.`
      });
    }
    return `${result.text}\n\n${redactionNote(result)}`;
  }

  // ---- request lifecycle + provider failover ---------------------------------------------------
  /** Fold a bridge message into the in-flight request's lifecycle. */
  private trackRequest(message: BridgeEnvelope): void {
    if (!this.activeRequest || this.indexingActive) {
      return;
    }
    const event = requestEventFor(message);
    if (event) {
      this.noteRequestEvent(event);
    }
  }

  private noteRequestEvent(event: RequestEvent): void {
    const previous = this.activeRequest;
    if (!previous) {
      return;
    }
    const next = reduceRequest(previous, event);
    if (next === previous) {
      this.armRequestWatchdog(); // still alive — extend the silence timer
      return;
    }
    this.activeRequest = next;
    if (isTerminal(next.phase)) {
      this.clearRequestWatchdog();
    } else {
      this.armRequestWatchdog();
    }

    if (next.phase !== previous.phase) {
      this.output.appendLine(`[request ${next.turnId.slice(0, 8)} on ${next.providerId}] ${describePhase(next.phase)}${next.detail ? ` — ${next.detail}` : ""}`);
    }
    if (next.phase === "completed") {
      this.providerHealth.set(next.providerId, recordProviderResult(this.providerHealth.get(next.providerId), next.providerId, "ok"));
      return;
    }
    if (isFailure(next.phase)) {
      this.providerHealth.set(
        next.providerId,
        recordProviderResult(this.providerHealth.get(next.providerId), next.providerId, "failed", next.detail)
      );
      this.taskProgress.errors.push(`${next.providerId}: ${describePhase(next.phase)}${next.detail ? ` — ${next.detail}` : ""}`);
      void this.handleRequestFailure(next);
    }
  }

  /**
   * A provider page can simply go quiet — a closed tab, a stuck UI, a network stall — and then no
   * state ever arrives. Without a timer the task would wait forever, so silence for long enough is
   * itself treated as a failure (ambiguous if the prompt was already submitted).
   */
  private armRequestWatchdog(): void {
    this.clearRequestWatchdog();
    const seconds = Math.max(15, this.getNumber("request.timeoutSeconds", 120));
    this.requestWatchdog = setTimeout(() => {
      this.requestWatchdog = undefined;
      this.noteRequestEvent({
        kind: "timeout",
        detail: `no response from the chat page for ${seconds}s`
      });
    }, seconds * 1000);
  }

  private clearRequestWatchdog(): void {
    if (this.requestWatchdog) {
      clearTimeout(this.requestWatchdog);
      this.requestWatchdog = undefined;
    }
  }

  private rememberToolResult(label: string, output: string): void {
    this.taskProgress.toolResults.push({ label, output });
    if (this.taskProgress.toolResults.length > MAX_CARRIED_TOOL_RESULTS) {
      this.taskProgress.toolResults.shift();
    }
  }

  /**
   * A request failed. If it never reached the provider, optionally continue the task on another
   * provider with a locally built handover. If the provider may already have acted, never replay
   * automatically — duplicated edits/commands are worse than a stalled task — so ask instead.
   */
  private async handleRequestFailure(request: RequestState): Promise<void> {
    if (this.failoverInFlight || this.responseSuppressed) {
      return;
    }
    const mode = this.getString("failover.mode", "off");
    if (mode === "off") {
      this.emitters.notice.fire({
        level: "warn",
        message: `${this.providerLabel(request.providerId)} ${describePhase(request.phase)}. Use Retry, or switch provider (enable webchat.failover.mode to hand over automatically).`
      });
      return;
    }
    if (this.failoverCount >= MAX_FAILOVERS_PER_TASK) {
      this.emitters.notice.fire({
        level: "error",
        message: `Tried ${this.failoverCount} provider${this.failoverCount === 1 ? "" : "s"} for this task without success; stopping. Check the browser tab.`
      });
      return;
    }

    const target = chooseFailoverProvider(this.failoverCandidates(), request.providerId, this.providerHealth);
    if (!target) {
      this.emitters.notice.fire({
        level: "warn",
        message: "No other provider is configured for failover — add one in Settings (webchat.failover.providers)."
      });
      return;
    }

    const safe = isSafeToRetryElsewhere(request.phase);
    if (!safe) {
      if (mode !== "always") {
        this.emitters.notice.fire({
          level: "warn",
          message: `${this.providerLabel(request.providerId)} ${describePhase(request.phase)}, so it was NOT resent automatically (that could duplicate edits or commands). Check the tab, then use Retry or switch to ${this.providerLabel(target)}.`
        });
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `${this.providerLabel(request.providerId)} failed after submitting your request.`,
        {
          modal: true,
          detail: `It may already have started editing files or running commands. Continuing on ${this.providerLabel(target)} could duplicate that work.\n\nThe handover tells the new provider to check the workspace first.`
        },
        `Continue on ${this.providerLabel(target)}`
      );
      if (choice === undefined) {
        return;
      }
    }

    await this.failoverTo(target, request);
  }

  /** Hand the task to another provider with a locally built continuation package. */
  private async failoverTo(providerId: string, failed: RequestState): Promise<void> {
    this.failoverInFlight = true;
    try {
      const pack = this.buildContinuationPackage(failed);
      this.emitters.notice.fire({
        level: "info",
        message: `Continuing on ${this.providerLabel(providerId)} — ${describeContinuation(pack)}.`
      });
      await this.setProvider(providerId);
      this.failoverCount += 1;
      // "rotate" opens a fresh conversation on the new provider (it has no history to reuse).
      await this.dispatchPrompt(buildContinuationPrompt(pack), "rotate", undefined, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitters.notice.fire({ level: "error", message: `Could not hand over to ${this.providerLabel(providerId)}: ${message}` });
    } finally {
      this.failoverInFlight = false;
    }
  }

  /** Everything a fresh provider needs to carry on — the provider's own history cannot be moved. */
  private buildContinuationPackage(failed: RequestState): ContinuationPackage {
    return {
      objective: this.taskProgress.objective || this.lastUserDispatch?.instruction || "",
      phase: describePhase(failed.phase),
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
      changedFiles: [...this.taskProgress.changedFiles],
      relevantFiles: [...this.taskProgress.relevantFiles],
      toolResults: [...this.taskProgress.toolResults],
      errors: [...this.taskProgress.errors],
      summary: this.getStoredSummary() || undefined,
      permissions: describePermissions(this.getAgentMode()),
      checkpoint: this.undoStack.length > 0
        ? `${this.undoStack.length} undo step${this.undoStack.length === 1 ? "" : "s"}`
        : undefined,
      previousRequest: {
        providerId: this.providerLabel(failed.providerId),
        phase: describePhase(failed.phase),
        mayHaveActed: !isSafeToRetryElsewhere(failed.phase)
      }
    };
  }

  /** Ordered failover candidates: the configured list, or every provider with the current one first. */
  private failoverCandidates(): string[] {
    const configured = vscode.workspace.getConfiguration("webchat").get<string[]>("failover.providers", []) ?? [];
    const known = new Set(listProviders().map((provider) => provider.id));
    const cleaned = configured.filter((id) => known.has(id) && id !== "mock");
    if (cleaned.length > 0) {
      return cleaned;
    }
    const current = this.getString("defaultProvider", "chatgpt");
    return [current, ...listProviders().map((provider) => provider.id).filter((id) => id !== current && id !== "mock")];
  }

  private providerLabel(providerId: string): string {
    return getProvider(providerId)?.label ?? providerId;
  }

  /** Current request lifecycle, for the panel and the status command. */
  getRequestStatus(): { phase: string; providerId: string; detail?: string } | undefined {
    return this.activeRequest
      ? {
          phase: describePhase(this.activeRequest.phase),
          providerId: this.providerLabel(this.activeRequest.providerId),
          detail: this.activeRequest.detail
        }
      : undefined;
  }

  /** Ask before running commands the dangerous-command guard flagged (full-access mode only). */
  private async confirmDangerousTools(tools: readonly AgentToolRequest[]): Promise<boolean> {
    const detail = tools
      .map((tool) => (tool.name === "run" ? `$ ${tool.command}\n   → ${dangerousCommandReason(tool.command)}` : describeTool(tool)))
      .join("\n");
    const choice = await vscode.window.showWarningMessage(
      "Full access mode: the model wants to run a potentially destructive command.",
      { modal: true, detail: `${detail}\n\n(Turn this check off with webchat.agent.confirmDangerousCommands.)` },
      "Run anyway"
    );
    return choice === "Run anyway";
  }

  /** Send queued problems (failed edits) to the model when no tool transcript will carry them. */
  private async flushPendingFeedback(): Promise<void> {
    if (this.pendingFeedback.length === 0) {
      return;
    }
    const feedback = this.pendingFeedback.join("\n\n");
    this.pendingFeedback = [];
    await this.continueWithToolResult(feedback);
  }

  /** Approve + run the pending turn's tools (webview "Approve & run" and the headless modal). */
  async runCommands(turnId?: string): Promise<void> {
    const response = this.lastParsed && (!turnId || this.lastParsed.turnId === turnId) ? this.lastParsed.response : undefined;
    if (!response || response.tools.length === 0) {
      return;
    }
    // In plan mode only read-only tools are ever executed.
    const tools = this.getAgentMode() === "plan" ? response.tools.filter((t) => !isPrivilegedTool(t)) : response.tools;
    await this.runTools(turnId, tools);
  }

  /**
   * Execute a batch of tools for a turn: read-only tools (read_file/list_dir/search) and shell `run`
   * commands stream their output and feed a combined transcript back to the chat; a spawn_subagent
   * launches a focused isolated continuation instead.
   */
  private async runTools(
    turnId: string | undefined,
    tools: readonly AgentToolRequest[],
    notes: readonly string[] = []
  ): Promise<void> {
    // If this turn both edited files and asks for diagnostics, let the language servers catch up
    // first — otherwise the model reads pre-edit problems and thinks its change compiled.
    const justApplied = this.lastApplied?.turnId === turnId ? this.lastApplied : undefined;
    if (justApplied && tools.some((tool) => tool.name === "diagnostics")) {
      await refreshDiagnostics(
        justApplied.changes.filter((change) => change.action !== "delete").map((change) => change.path)
      );
    }
    // Failed edits / declined commands travel in the same continuation as the tool output, so the
    // model gets exactly one follow-up message per turn.
    const preamble = [...this.pendingFeedback, ...notes];
    this.pendingFeedback = [];
    if (tools.length === 0) {
      if (preamble.length > 0) {
        await this.continueWithToolResult(preamble.join("\n\n"));
      }
      return;
    }
    const subagents = tools.filter(
      (t): t is Extract<AgentToolRequest, { name: "spawn_subagent" }> => t.name === "spawn_subagent"
    );
    const infoAndRun = tools.filter((t) => t.name !== "spawn_subagent");

    const transcript: string[] = [...preamble];
    for (const tool of infoAndRun) {
      if (tool.name === "run") {
        const result = await this.execCommand(tool.command);
        this.emitters.commandOutput.fire({ command: `$ ${tool.command}`, output: result.output, exitCode: result.exitCode });
        transcript.push(`$ ${tool.command}\n(exit code ${result.exitCode})\n${result.output || "(no output)"}`);
        this.rememberToolResult(`$ ${tool.command} (exit ${result.exitCode})`, result.output);
      } else {
        const result = await executeReadonlyTool(tool);
        this.emitters.commandOutput.fire({ command: result.label, output: result.output, exitCode: result.ok ? 0 : 1 });
        transcript.push(`# ${result.label}\n${result.output || "(no output)"}`);
        this.rememberToolResult(result.label, result.output);
      }
    }

    if (subagents.length > 0) {
      await this.launchSubagent(subagents, transcript.join("\n\n"));
      return; // the subagent turn takes over this turn's continuation
    }

    if (transcript.length > 0) {
      await this.continueWithToolResult(transcript.join("\n\n"));
    }
  }

  /** Launch the first requested subagent as a focused, isolated continuation turn. */
  private async launchSubagent(
    subagents: readonly Extract<AgentToolRequest, { name: "spawn_subagent" }>[],
    priorToolOutput: string
  ): Promise<void> {
    if (this.subagentCount >= MAX_SUBAGENTS) {
      this.emitters.notice.fire({
        level: "warn",
        message: `Subagent limit (${MAX_SUBAGENTS}) reached for this task; not spawning more.`
      });
      if (priorToolOutput) {
        await this.continueWithToolResult(priorToolOutput);
      }
      return;
    }
    const [sub, ...rest] = subagents;
    this.subagentCount += 1;
    this.emitters.notice.fire({
      level: "info",
      message: `Spawning subagent: ${sub.task.slice(0, 80)}${sub.task.length > 80 ? "…" : ""}`
    });

    const instruction = [
      "[SUBAGENT] You are a focused sub-agent spawned by the main agent. Do ONLY this task, keep changes minimal, and finish with a concise result summary the main agent can use:",
      sub.task,
      priorToolOutput ? `\nOutput of tools already run this turn:\n${priorToolOutput}` : "",
      rest.length > 0
        ? `\n(The main agent also queued ${rest.length} more subagent task(s); it will request those next — ignore them.)`
        : "",
      "\nYou may read/search/run/edit as needed, but you may NOT spawn further subagents."
    ]
      .filter(Boolean)
      .join("\n");

    // subagentCount > 0 now disables spawn_subagent in the tool instructions (depth cap of 1).
    await this.dispatchPrompt(instruction, "continue", sub.context ?? [], false);
  }

  skipCommands(turnId?: string): void {
    if (turnId && this.lastParsed && this.lastParsed.turnId !== turnId) {
      return; // Skip pressed on an older card — don't touch the current turn's queue
    }
    this.emitters.notice.fire({ level: "info", message: "Skipped the requested tools." });
    void this.flushPendingFeedback();
  }

  private execCommand(command: string): Promise<{ output: string; exitCode: number }> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return new Promise((resolve) => {
      exec(command, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const combined = `${stdout ?? ""}${stderr ?? ""}`.trim();
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ output: truncateOutput(combined), exitCode });
      });
    });
  }

  /** Feed command output back to the chat so the model can read results and continue (capped). */
  private async continueWithToolResult(outputs: string): Promise<void> {
    const maxIterations = this.getMaxToolIterations();
    if (this.toolIterations >= maxIterations) {
      // Don't lose this round's output: carry it into the next user turn so "continue" resumes with
      // the tool results (and any failed-edit feedback) the model never saw.
      this.pendingNotes.push(`Output of the tools from the previous round (the automatic loop paused here):\n${outputs}`);
      this.emitters.notice.fire({
        level: "warn",
        message: `Reached the tool-loop limit (${maxIterations} rounds) for this task; stopping auto-continue. Send "continue" to keep going (the last tool output is carried over), or raise webchat.agent.maxToolIterations.`
      });
      return;
    }
    this.toolIterations += 1;
    const instruction = [
      "Here is the output of the commands you requested. Read it and continue the task.",
      "If something failed, fix it. If everything is verified and done, reply with a final summary and no further commands.",
      "",
      outputs
    ].join("\n");
    await this.dispatchPrompt(instruction, undefined, undefined, false);
  }

  /**
   * Apply a turn's file changes. On failure nothing is written; the problems are either returned to
   * the caller (which batches them with tool output) or, when applied from the UI, sent to the
   * model directly so it can resend corrected edits.
   */
  async applyChanges(
    turnId?: string,
    options: { feedbackToModel?: boolean } = {}
  ): Promise<{ ok: true } | { ok: false; feedback: string }> {
    const files = this.resolveChanges(turnId);
    if (!files) {
      this.emitters.notice.fire({ level: "warn", message: "No pending file changes to apply." });
      return { ok: true };
    }

    try {
      const applied = await applyAgentFileChanges(files, this.context);
      const appliedTurn = turnId ?? this.lastParsed?.turnId ?? "";
      this.lastApplied = { turnId: appliedTurn, changes: applied };
      this.undoStack.push({ turnId: appliedTurn, changes: applied });
      if (this.undoStack.length > MAX_UNDO_TURNS) {
        this.undoStack.shift();
      }
      this.emitters.applyResult.fire({
        applied: applied.map((change) => ({ path: change.path, action: change.action }))
      });
      for (const change of applied) {
        this.taskProgress.changedFiles.push({ path: change.path, action: change.action });
      }
      this.emitters.notice.fire({
        level: "info",
        message: `Applied ${applied.length} file change${applied.length === 1 ? "" : "s"}. Undo: /undo or the card's Undo button.`
      });
      // Show what changed (before→after) unless the user turned it off. Full access mode doesn't
      // open diff tabs on its own (it would flood the editor during a long autonomous loop) —
      // the chat card's "View diff" opens them on demand.
      if (this.getBool("diff.showOnApply", true) && this.getAgentMode() !== "bypass") {
        await openAppliedDiffs(applied, this.context);
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Could not apply WebChat file changes: ${message}`);
      this.emitters.applyResult.fire({ applied: [], error: message });
      this.emitters.notice.fire({ level: "error", message: `Could not apply file changes: ${message}` });
      const feedback = [
        "Your file changes were NOT applied (nothing from that response was written):",
        error instanceof AgentChangeError ? error.problems.map((problem) => `- ${problem}`).join("\n") : `- ${message}`,
        "Re-read the affected files with read_file and send corrected changes."
      ].join("\n");
      if (options.feedbackToModel !== false && this.getAgentMode() !== "plan") {
        await this.continueWithToolResult(feedback);
      }
      return { ok: false, feedback };
    }
  }

  /**
   * Undo the file changes of a turn (default: the most recent one) from the pre-edit snapshots.
   * Files the user changed after the agent wrote them are only overwritten after confirmation.
   */
  async undoChanges(turnId?: string): Promise<void> {
    const index = turnId
      ? this.undoStack.findIndex((entry) => entry.turnId === turnId)
      : this.undoStack.length - 1;
    const entry = index >= 0 ? this.undoStack[index] : undefined;
    if (!entry) {
      this.emitters.notice.fire({ level: "info", message: "Nothing to undo." });
      return;
    }

    let changes = entry.changes;
    const conflicts = await detectRevertConflicts(changes);
    if (conflicts.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `${conflicts.length} file${conflicts.length === 1 ? " was" : "s were"} changed after LeechCode edited ${conflicts.length === 1 ? "it" : "them"}.`,
        { modal: true, detail: `${conflicts.join("\n")}\n\nUndo would overwrite those later edits.` },
        "Undo all (overwrite)",
        "Undo the others only"
      );
      if (!choice) {
        return;
      }
      if (choice === "Undo the others only") {
        changes = changes.filter((change) => !conflicts.includes(change.path));
      }
    }

    try {
      const reverted = await revertAgentFileChanges(changes);
      // Keep anything that was NOT reverted (e.g. "undo the others only") so it stays undoable.
      const revertedKeys = new Set(changes.map((change) => change.key));
      const remaining = entry.changes.filter((change) => !revertedKeys.has(change.key));
      const position = this.undoStack.indexOf(entry); // re-find: the stack may have moved while the dialog was open
      if (position >= 0) {
        if (remaining.length > 0) {
          this.undoStack[position] = { turnId: entry.turnId, changes: remaining };
        } else {
          this.undoStack.splice(position, 1);
        }
      }
      if (this.lastApplied?.turnId === entry.turnId) {
        this.lastApplied = remaining.length > 0 ? { turnId: entry.turnId, changes: remaining } : undefined;
      }
      if (reverted.length > 0) {
        this.emitters.undoResult.fire({ turnId: entry.turnId, reverted, remaining: remaining.length });
      }
      this.emitters.notice.fire({
        level: "info",
        message: reverted.length > 0
          ? `Undid ${reverted.length} file change${reverted.length === 1 ? "" : "s"}: ${reverted.join(", ")}`
          : "Nothing was undone."
      });
      if (reverted.length > 0) {
        this.pendingNotes.push(
          `Note: the user UNDID your earlier changes to ${reverted.join(", ")} — those files are back to their previous content. read_file them again before editing.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitters.notice.fire({ level: "error", message: `Undo failed: ${message}` });
    }
  }

  async previewChanges(turnId?: string, path?: string): Promise<void> {
    // If this turn was already applied, show the real before→after diff from the snapshots (the
    // working file already holds the new content, so a plain disk diff would be empty).
    const appliedTurn = turnId
      ? this.undoStack.find((entry) => entry.turnId === turnId) ??
        (this.lastApplied?.turnId === turnId ? this.lastApplied : undefined)
      : this.lastApplied ?? this.undoStack[this.undoStack.length - 1];
    if (appliedTurn) {
      const opened = await openAppliedDiffs(appliedTurn.changes, this.context, path);
      if (opened > 0) {
        this.emitters.notice.fire({ level: "info", message: `Opened ${opened} diff${opened === 1 ? "" : "s"}.` });
        return;
      }
    }

    // Otherwise it's a pre-apply preview: current-on-disk vs the proposed content.
    let files = this.resolveChanges(turnId);
    if (!files) {
      return;
    }
    if (path) {
      files = files.filter((file) => file.path === path);
    }
    if (files.length === 0) {
      return;
    }
    const opened = await previewAgentFileChanges(files, this.context);
    this.emitters.notice.fire({
      level: "info",
      message: `Opened ${opened} diff${opened === 1 ? "" : "s"}.`
    });
  }

  skipChanges(): void {
    this.emitters.notice.fire({ level: "info", message: "Skipped the suggested file changes." });
  }

  // ---- session ---------------------------------------------------------------------------------
  async resetSession(): Promise<void> {
    // Signal any in-flight index delivery to stop; its loop clears indexingActive in its finally so
    // late acks stay swallowed rather than being parsed as agent responses.
    this.indexAborted = true;
    this.finishIndexTurn();
    this.responseSuppressed = false;
    this.usage = { promptCount: 0, inputTokensUsed: 0, outputTokensUsed: 0 };
    this.activeAssistantText = "";
    this.lastParsed = undefined;
    this.lastApplied = undefined;
    this.pendingFeedback = [];
    this.pendingNotes = [];
    this.handledTurnIds.clear();
    this.clearRequestWatchdog();
    this.activeRequest = undefined;
    this.taskProgress = { objective: "", toolResults: [], errors: [], changedFiles: [], relevantFiles: [] };
    this.failoverCount = 0;
    this.bridgeSessionId = randomUUID();
    await this.context.globalState.update("webchat.bridge.sessionId", this.bridgeSessionId);
    await this.context.globalState.update("webchat.session.summary", "");
    this.emitters.usage.fire(this.getUsageInfo());
    this.emitters.notice.fire({ level: "info", message: "Session state reset." });
  }

  // ---- providers + settings --------------------------------------------------------------------
  /** (Re)read `webchat.customProviders` into the registry, surfacing invalid entries. */
  private loadCustomProviders(announce: boolean): void {
    const raw = vscode.workspace.getConfiguration("webchat").get<unknown>("customProviders", []);
    const errors = setCustomProviders(raw);
    for (const error of errors) {
      this.output.appendLine(`Custom AI site skipped — ${error}`);
    }
    if (announce && errors.length > 0) {
      this.emitters.notice.fire({ level: "warn", message: `Custom AI site skipped — ${errors[0]}` });
    }
  }

  /** Tell the browser extension which custom sites to run on (it asks the user for access). */
  private syncCustomProvidersToBrowser(): void {
    if (!this.bridge?.getStatus().running) {
      return;
    }
    this.bridge.sendToBrowsers(createEnvelope<ProvidersSyncPayload>({
      id: randomUUID(),
      sessionId: this.bridgeSessionId,
      type: "providers.sync",
      payload: { customProviders: listCustomAdapters() }
    }));
  }

  /** Add a user-defined AI site (label + URL; selectors are optional and can be picked in the browser). */
  async addCustomProvider(label: string, url: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("webchat");
    const current = config.get<CustomProviderConfig[]>("customProviders", []) ?? [];
    const next = [...current, { label: label.trim(), url: url.trim() }];
    const errors = setCustomProviders(next);
    if (errors.length > 0) {
      this.loadCustomProviders(false); // restore the registry from the unchanged setting
      this.emitters.notice.fire({ level: "error", message: errors[errors.length - 1] });
      return;
    }
    // Application scope: custom sites are a per-user choice, never picked up from a repo's settings.
    await config.update("customProviders", next, vscode.ConfigurationTarget.Global);
    this.emitters.notice.fire({
      level: "info",
      message: `Added “${label.trim()}”. In the browser, open the WebChat Bridge options page and click “Allow” for it.`
    });
  }

  async removeCustomProvider(id: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("webchat");
    const current = config.get<CustomProviderConfig[]>("customProviders", []) ?? [];
    const next = current.filter((entry) => {
      const entryId = typeof entry?.id === "string" && entry.id.trim()
        ? normalizeId(entry.id)
        : safeHostId(entry?.url);
      return entryId !== id;
    });
    await config.update("customProviders", next, vscode.ConfigurationTarget.Global);
    if (this.getString("defaultProvider", "chatgpt") === id) {
      await this.updateSetting("defaultProvider", "chatgpt");
    }
  }

  getProvidersInfo(): readonly ProviderInfo[] {
    return listProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      host: provider.host,
      tags: provider.tags,
      imageSupport: provider.imageSupport,
      models: this.getProviderModels(provider.id),
      features: provider.features,
      custom: provider.custom,
      chatUrl: provider.custom ? provider.chatUrl : undefined
    }));
  }

  /**
   * Models offered in the switcher for a provider. User overrides (webchat.provider.models) win
   * outright when present — providers deprecate/rename models constantly, so the shipped defaults
   * are only a starting point the user can freely add to / remove from in Settings.
   */
  private getProviderModels(id: string): readonly string[] {
    const overrides = vscode.workspace
      .getConfiguration("webchat")
      .get<Record<string, string[]>>("provider.models", {});
    const override = overrides ? overrides[id] : undefined;
    if (Array.isArray(override)) {
      return override.filter((m) => typeof m === "string" && m.trim().length > 0);
    }
    return getProvider(id)?.models ?? [];
  }

  async setProviderModels(providerId: string, models: readonly string[]): Promise<void> {
    const config = vscode.workspace.getConfiguration("webchat");
    const overrides = { ...(config.get<Record<string, string[]>>("provider.models", {}) ?? {}) };
    const cleaned = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
    overrides[providerId] = cleaned;
    await config.update("provider.models", overrides, vscode.ConfigurationTarget.Workspace);
  }

  /** Ask the browser to toggle an on-page feature (e.g. DeepSeek Search / DeepThink) for the provider. */
  toggleFeature(featureId: string): void {
    const provider = this.getCurrentProvider();
    const feature = provider?.features?.find((f) => f.id === featureId);
    if (!provider || !feature) {
      return;
    }
    if (!this.bridge?.getStatus().running || this.getBridgeStatus().clientCount === 0) {
      this.emitters.notice.fire({ level: "warn", message: "Connect a browser first to toggle a chat feature." });
      return;
    }
    this.bridge.sendToBrowsers(
      createEnvelope<ChatTogglePayload>({
        id: randomUUID(),
        sessionId: this.bridgeSessionId,
        type: "chat.toggle",
        payload: { providerId: provider.id, featureId, label: feature.label }
      })
    );
    this.emitters.notice.fire({ level: "info", message: `Toggling ${feature.label} on ${provider.label}…` });
  }

  /** Ask the browser to switch the on-page model for the current provider (best-effort). */
  setModel(model: string): void {
    const provider = this.getCurrentProvider();
    if (!provider || !model.trim()) {
      return;
    }
    if (!this.bridge?.getStatus().running || this.getBridgeStatus().clientCount === 0) {
      this.emitters.notice.fire({ level: "warn", message: "Connect a browser first to switch the model." });
      return;
    }
    this.bridge.sendToBrowsers(
      createEnvelope<ChatModelPayload>({
        id: randomUUID(),
        sessionId: this.bridgeSessionId,
        type: "chat.model",
        payload: { providerId: provider.id, model: model.trim() }
      })
    );
    this.emitters.notice.fire({ level: "info", message: `Switching ${provider.label} to “${model.trim()}” in the browser…` });
  }

  /** Analyze images with the user's local OpenAI-compatible vision endpoint; return a text block. */
  private async describeImagesLocally(images: readonly ChatAttachment[]): Promise<string> {
    const endpoint = this.getString("vision.endpoint", "").trim();
    const model = this.getString("vision.model", "").trim();
    if (!endpoint || !model) {
      this.emitters.notice.fire({
        level: "warn",
        message: "Local vision is on but the endpoint/model isn't set (Settings → Local vision). Sending the image to the chat instead."
      });
      return "";
    }
    const instruction = this.getString(
      "vision.prompt",
      "Describe this image in detail and transcribe any visible text (OCR) exactly."
    );
    const apiKey = this.getString("vision.apiKey", "").trim();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const parts: string[] = [];
    for (const img of images) {
      this.emitters.notice.fire({ level: "info", message: `Analyzing ${img.name} with your local vision model…` });
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            stream: false,
            max_tokens: 1500,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: instruction },
                  { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } }
                ]
              }
            ]
          })
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
        const text = String(json?.choices?.[0]?.message?.content ?? "").trim();
        if (text) {
          parts.push(`[Attached image "${img.name}" — analyzed locally by ${model}]\n${text}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitters.notice.fire({ level: "error", message: `Local vision failed for ${img.name}: ${message}` });
      }
    }
    if (parts.length > 0) {
      this.emitters.notice.fire({ level: "info", message: `Added local vision analysis for ${parts.length} image${parts.length === 1 ? "" : "s"}.` });
    }
    return parts.join("\n\n");
  }

  // ---- chat sessions (track which conversations we're in) --------------------------------------
  getSessions(): readonly SessionInfo[] {
    return this.context.globalState.get<SessionInfo[]>("webchat.sessions", []) ?? [];
  }

  /**
   * Record the conversation URL currently open in the connected tab (reported by the content script)
   * so the user has a live list of the chats they're using and can jump back into any of them.
   */
  private recordSessionFromPayload(payload: unknown): void {
    const record = payload as { url?: unknown; title?: unknown } | null;
    const url = typeof record?.url === "string" ? record.url : "";
    if (!url) {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const provider = findProviderByHost(parsed.hostname);
    if (!provider || !looksLikeConversationUrl(parsed)) {
      return;
    }
    const sessions = this.getSessions();
    if (sessions[0]?.url === url) {
      return; // already the current session — no churn
    }
    const title = typeof record?.title === "string" ? cleanSessionTitle(record.title, provider.label) : undefined;
    const existing = sessions.find((s) => s.url === url);
    const next: SessionInfo[] = [
      {
        url,
        providerId: provider.id,
        providerLabel: provider.label,
        title: title ?? existing?.title,
        lastUsed: new Date().toISOString(),
        // Keep whatever compacted summary we already had for this chat; else adopt the current one.
        summary: existing?.summary ?? (this.getStoredSummary() || undefined)
      },
      ...sessions.filter((s) => s.url !== url)
    ].slice(0, 20);
    void this.context.globalState.update("webchat.sessions", next);
    this.emitters.sessions.fire(next);
  }

  /** Keep the active (newest) session's summary in sync whenever a fresh summary is stored. */
  private updateActiveSessionSummary(summary: string): void {
    if (!summary.trim()) {
      return;
    }
    const sessions = this.getSessions();
    if (sessions.length === 0) {
      return;
    }
    const next = [{ ...sessions[0], summary }, ...sessions.slice(1)];
    void this.context.globalState.update("webchat.sessions", next);
    this.emitters.sessions.fire(next);
  }

  /** Remove one tracked chat from the history list. */
  removeSession(url: string): void {
    const next = this.getSessions().filter((s) => s.url !== url);
    void this.context.globalState.update("webchat.sessions", next);
    this.emitters.sessions.fire(next);
  }

  /** Clear the whole tracked chat history. */
  clearSessions(): void {
    void this.context.globalState.update("webchat.sessions", []);
    this.emitters.sessions.fire([]);
    this.emitters.notice.fire({ level: "info", message: "Cleared the chat history list." });
  }

  /** Navigate the connected browser tab to a previously-used conversation URL and continue in it. */
  async openChatUrl(url: string): Promise<void> {
    const trimmed = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      this.emitters.notice.fire({ level: "error", message: "That doesn't look like a valid URL." });
      return;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      this.emitters.notice.fire({ level: "error", message: "Paste a full http(s) chat URL." });
      return;
    }
    const provider = findProviderByHost(parsed.hostname);
    if (!provider) {
      this.emitters.notice.fire({
        level: "warn",
        message: `“${parsed.hostname}” isn't a known chat provider. Add it under ⚙ Settings → Custom AI sites first, or use a ChatGPT/Claude/Gemini/Qwen/DeepSeek/AI Studio URL.`
      });
      return;
    }

    if (this.getString("defaultProvider", "chatgpt") !== provider.id) {
      await this.updateSetting("defaultProvider", provider.id);
    }
    await this.startBridge(true);
    const connected = this.getBridgeStatus().clientCount > 0;
    if (!connected) {
      await vscode.env.openExternal(vscode.Uri.parse(trimmed));
      this.emitters.notice.fire({
        level: "info",
        message: `Opened the chat in your browser. Once the bridge connects, your prompts continue in that ${provider.label} conversation.`
      });
    } else {
      this.bridge!.sendToBrowsers(
        createEnvelope<ChatNavigatePayload>({
          id: randomUUID(),
          sessionId: this.bridgeSessionId,
          type: "chat.navigate",
          payload: { providerId: provider.id, url: trimmed }
        })
      );
      this.emitters.notice.fire({ level: "info", message: `Continuing your ${provider.label} conversation…` });
    }
    // If this chat is in our history with a compacted summary, re-prime the model so it reloads the
    // project state before the user's next instruction (the conversation may be old or truncated).
    const tracked = this.getSessions().find((s) => s.url === trimmed);
    this.recordSessionFromPayload({ url: trimmed });
    if (connected && tracked?.summary?.trim()) {
      this.emitters.notice.fire({ level: "info", message: "Re-priming the resumed chat with its saved project summary…" });
      await this.delay(4000); // give the tab time to load the conversation (bridge queues if not ready)
      await this.dispatchPrompt(
        [
          "We are RESUMING this chat session from the IDE. Reload this compacted project state as your working context, then reply with a one-line confirmation of where we left off and wait for my next instruction:",
          "",
          tracked.summary
        ].join("\n"),
        "continue"
      );
    }
  }

  /** Re-send the last user turn (manual retry after a block / no response). */
  async retryLast(): Promise<void> {
    if (!this.lastUserDispatch) {
      this.emitters.notice.fire({ level: "info", message: "Nothing to retry yet." });
      return;
    }
    this.emitters.notice.fire({ level: "info", message: "Retrying the last message…" });
    await this.dispatchPrompt(this.lastUserDispatch.instruction, undefined, this.lastUserDispatch.contextPaths);
  }

  getCurrentProvider(): WebChatProvider | undefined {
    const id = this.getString("defaultProvider", "chatgpt");
    return getProvider(id) ?? listProviders()[0];
  }

  async setProvider(providerId: string): Promise<void> {
    await this.updateSetting("defaultProvider", providerId);
    // If a browser is already connected, open the newly selected chat interface in it.
    const status = this.getBridgeStatus();
    if (status.running && status.clientCount > 0) {
      await this.launchBrowser();
    }
  }

  async openExternalProvider(): Promise<void> {
    const provider = this.getCurrentProvider();
    if (provider) {
      await vscode.env.openExternal(vscode.Uri.parse(provider.chatUrl));
    }
  }

  /**
   * Launch a Chromium browser with the bundled WebChat browser extension loaded and the current
   * provider's chat URL opened in a tab — so the bridge connects automatically. Re-launching with
   * the same profile opens the URL in the already-running browser as a new tab.
   */
  async launchBrowser(): Promise<void> {
    const provider = this.getCurrentProvider();
    if (!provider) {
      this.emitters.notice.fire({ level: "error", message: "No web chat provider is configured." });
      return;
    }

    await this.startBridge(true);

    const extensionDir = vscode.Uri.joinPath(this.context.extensionUri, "browser-extension").fsPath;
    if (!fs.existsSync(path.join(extensionDir, "manifest.json"))) {
      await vscode.env.openExternal(vscode.Uri.parse(provider.chatUrl));
      this.emitters.notice.fire({
        level: "warn",
        message:
          "Bundled browser extension was not found, so the chat opened in your default browser. Load browser-extension/ as an unpacked extension to connect the bridge."
      });
      return;
    }

    const browser = this.findChromiumBrowser();
    if (!browser) {
      await vscode.env.openExternal(vscode.Uri.parse(provider.chatUrl));
      this.emitters.notice.fire({
        level: "warn",
        message:
          "No Chromium browser (Brave/Chrome/Edge) found. Opened the chat in your default browser — load browser-extension/ manually with 'Load unpacked' to connect."
      });
      return;
    }

    const profileDir = path.join(this.context.globalStorageUri.fsPath, "browser-profile");
    try {
      fs.mkdirSync(profileDir, { recursive: true });
    } catch {
      // best effort; spawn will surface a real failure below
    }

    const args = [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      provider.chatUrl
    ];

    try {
      const child = spawn(browser.bin, args, { detached: true, stdio: "ignore" });
      child.unref();
      this.emitters.notice.fire({
        level: "info",
        message: `Opening ${provider.label} in ${browser.name} with the WebChat bridge… log in there if prompted.`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitters.notice.fire({ level: "error", message: `Could not launch the browser: ${message}` });
    }
  }

  /** Close the WebChat browser instance we launched (matched by its dedicated profile dir). */
  async closeBrowser(): Promise<void> {
    const profileDir = path.join(this.context.globalStorageUri.fsPath, "browser-profile");
    const pids = await this.findBrowserPids(profileDir);
    if (pids.length === 0) {
      this.emitters.notice.fire({
        level: "info",
        message: "No WebChat browser instance is running (or it isn't the one this extension launched)."
      });
      return;
    }
    let killed = 0;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        killed += 1;
      } catch {
        // already gone / not permitted
      }
    }
    this.emitters.notice.fire({
      level: "info",
      message: `Closed the WebChat browser (${killed} process${killed === 1 ? "" : "es"}).`
    });
    // The status poll will flip the indicator to "no browser" once the socket drops.
  }

  /** Main browser PIDs whose command line references our profile dir (excludes helper processes). */
  private findBrowserPids(profileDir: string): Promise<number[]> {
    return new Promise((resolve) => {
      if (process.platform === "win32") {
        const escaped = profileDir.replace(/\\/g, "\\\\").replace(/'/g, "");
        exec(
          `wmic process where "CommandLine like '%${escaped}%' and not CommandLine like '%--type=%'" get ProcessId /format:value`,
          { timeout: 10_000 },
          (error, stdout) => resolve(error ? [] : parsePidsFromWmic(stdout))
        );
        return;
      }
      exec("ps -axo pid=,command=", { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error || !stdout) {
          resolve([]);
          return;
        }
        const pids: number[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.includes(profileDir) || line.includes("--type=")) {
            continue; // not ours, or a renderer/gpu helper
          }
          const match = line.trim().match(/^(\d+)\s/);
          if (match) {
            pids.push(Number(match[1]));
          }
        }
        resolve(pids);
      });
    });
  }

  private findChromiumBrowser(): { name: string; bin: string } | undefined {
    const candidates: { name: string; bin: string }[] = [];
    if (process.platform === "darwin") {
      candidates.push(
        { name: "Brave", bin: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
        { name: "Chrome", bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
        { name: "Chromium", bin: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
        { name: "Edge", bin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }
      );
    } else if (process.platform === "win32") {
      const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
      const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
      candidates.push(
        { name: "Brave", bin: `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe` },
        { name: "Chrome", bin: `${pf}\\Google\\Chrome\\Application\\chrome.exe` },
        { name: "Chrome", bin: `${pf86}\\Google\\Chrome\\Application\\chrome.exe` },
        { name: "Edge", bin: `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe` }
      );
    } else {
      candidates.push(
        { name: "Brave", bin: "/usr/bin/brave-browser" },
        { name: "Chrome", bin: "/usr/bin/google-chrome" },
        { name: "Chromium", bin: "/usr/bin/chromium" },
        { name: "Chromium", bin: "/usr/bin/chromium-browser" }
      );
    }
    return candidates.find((candidate) => fs.existsSync(candidate.bin));
  }

  getSettings(): WebChatSettings {
    const config = vscode.workspace.getConfiguration("webchat");
    const policy = defaultSessionPolicy;
    return {
      defaultProvider: config.get("defaultProvider", "chatgpt"),
      includeSelectionOnly: config.get("prompt.includeSelectionOnly", false),
      autoSubmit: config.get("browser.autoSubmit", false),
      agentMode: this.getAgentMode(),
      applyMode: this.getApplyMode(),
      autoRepair: config.get("agent.autoRepairInvalidResponses", true),
      failoverMode: config.get("failover.mode", "off"),
      redactSecrets: config.get("privacy.redactSecrets", true),
      maxToolIterations: config.get("agent.maxToolIterations", 0),
      confirmDangerousCommands: config.get("agent.confirmDangerousCommands", true),
      messageLimit: this.getProviderMessageLimit(config.get("defaultProvider", "chatgpt")),
      sessionLimit: this.getProviderSessionLimit(config.get("defaultProvider", "chatgpt")),
      indexChunked: config.get("index.chunked", true),
      currentProviderLabel: this.getCurrentProvider()?.label ?? "",
      bridgePort: config.get("bridge.port", 53451),
      bridgeTokenCustom: this.bridgeTokenSource === "setting",
      maxContextTokens: config.get("session.maxContextTokens", policy.budget.maxContextTokens),
      maxInputTokens: config.get("session.maxInputTokens", policy.budget.maxInputTokens),
      maxOutputTokens: config.get("session.maxOutputTokens", policy.budget.maxOutputTokens),
      compactEveryPrompts: config.get("session.compactEveryPrompts", policy.compactEveryPrompts),
      rotateWhenBudgetRemainingBelow: config.get(
        "session.rotateWhenBudgetRemainingBelow",
        policy.budget.rotateWhenBudgetRemainingBelow
      ),
      visionEnabled: config.get("vision.enabled", false),
      visionEndpoint: config.get("vision.endpoint", ""),
      visionModel: config.get("vision.model", "")
    };
  }

  async updateSetting(key: keyof WebChatSettings, value: string | number | boolean): Promise<void> {
    // Per-message / per-session limits are stored as per-provider override objects keyed by the
    // current provider, not as flat config values.
    if (key === "messageLimit") {
      await this.setProviderMessageLimit(this.getString("defaultProvider", "chatgpt"), Number(value));
      this.emitters.settings.fire(this.getSettings());
      return;
    }
    if (key === "sessionLimit") {
      await this.setProviderSessionLimit(this.getString("defaultProvider", "chatgpt"), Number(value));
      this.emitters.settings.fire(this.getSettings());
      return;
    }
    const path = SETTING_PATHS[key];
    if (!path) {
      return;
    }
    // Settings that grant the agent autonomy are user-level only (application scope): a cloned
    // repo's .vscode/settings.json must never be able to switch LeechCode into full access.
    const target = USER_LEVEL_SETTINGS.has(key)
      ? vscode.ConfigurationTarget.Global
      : vscode.ConfigurationTarget.Workspace;
    await vscode.workspace.getConfiguration("webchat").update(path, value, target);
    if (key === "bridgePort") {
      this.emitters.notice.fire({
        level: "warn",
        message: "Bridge port changed. Reload the window and set the same port in the browser extension options."
      });
    }
  }

  private getProviderMessageLimit(id: string): number {
    const overrides = vscode.workspace
      .getConfiguration("webchat")
      .get<Record<string, number>>("provider.maxMessageChars", {});
    const override = overrides ? overrides[id] : undefined;
    if (typeof override === "number" && override > 0) {
      return override;
    }
    return getProvider(id)?.maxMessageChars ?? 12000;
  }

  private async setProviderMessageLimit(providerId: string, chars: number): Promise<void> {
    const config = vscode.workspace.getConfiguration("webchat");
    const overrides = { ...(config.get<Record<string, number>>("provider.maxMessageChars", {}) ?? {}) };
    overrides[providerId] = Math.max(1000, Math.trunc(chars || 0));
    await config.update("provider.maxMessageChars", overrides, vscode.ConfigurationTarget.Workspace);
  }

  /** Total character budget for one conversation with this provider (caps a chunked index). */
  private getProviderSessionLimit(id: string): number {
    const overrides = vscode.workspace
      .getConfiguration("webchat")
      .get<Record<string, number>>("provider.maxSessionChars", {});
    const override = overrides ? overrides[id] : undefined;
    if (typeof override === "number" && override > 0) {
      return override;
    }
    return getProvider(id)?.maxSessionChars ?? 200000;
  }

  private async setProviderSessionLimit(providerId: string, chars: number): Promise<void> {
    const config = vscode.workspace.getConfiguration("webchat");
    const overrides = { ...(config.get<Record<string, number>>("provider.maxSessionChars", {}) ?? {}) };
    overrides[providerId] = Math.max(4000, Math.trunc(chars || 0));
    await config.update("provider.maxSessionChars", overrides, vscode.ConfigurationTarget.Workspace);
  }

  getInitState() {
    return {
      providers: this.getProvidersInfo(),
      currentProviderId: this.getString("defaultProvider", "chatgpt"),
      settings: this.getSettings(),
      bridge: this.getBridgeStatus(),
      usage: this.getUsageInfo(),
      summary: this.getStoredSummary(),
      context: this.getContextInfo(),
      sessions: this.getSessions()
    };
  }

  /** Workspace file paths for the @-mention picker, fuzzy-filtered by query and ranked. */
  async listWorkspaceFiles(query: string): Promise<string[]> {
    const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/.vscode-test/**}";
    const uris = await vscode.workspace.findFiles("**/*", exclude, 3000);
    const q = query.trim().toLowerCase();
    let rels = uris.map((uri) => vscode.workspace.asRelativePath(uri, false));
    if (q) {
      rels = rels.filter((rel) => rel.toLowerCase().includes(q));
      rels.sort((a, b) => fileScore(b, q) - fileScore(a, q) || a.length - b.length);
    } else {
      rels.sort((a, b) => a.localeCompare(b));
    }
    return rels.slice(0, 50);
  }

  /**
   * Index the whole workspace: always include a file tree, then as many source files as fit within
   * ~80% of the input-token budget (largest/binary files skipped).
   */
  private async collectCodebaseContext(budget: number): Promise<PromptFile[]> {
    const { files, truncated } = await this.readWorkspaceFiles(budget);
    if (files.length === 0) {
      return [];
    }
    if (truncated) {
      this.emitters.notice.fire({
        level: "warn",
        message: `Indexed the file tree + ${files.length - 1} files (paste-safe budget reached). Use @file to add specific files, raise webchat.context.maxIndexChars, or enable chunked indexing (webchat.index.chunked).`
      });
    } else {
      this.emitters.notice.fire({ level: "info", message: `Indexed the workspace: ${files.length - 1} files + file tree.` });
    }
    return files;
  }

  /**
   * Read workspace source files (largest/binary skipped) up to `budget` characters of content, with
   * a WORKSPACE_FILE_TREE.txt pseudo-file always first. No user-facing notices — callers decide how
   * to report. Used both by single-message indexing (paste budget) and chunked indexing (session cap).
   */
  private async readWorkspaceFiles(budget: number): Promise<{ files: PromptFile[]; truncated: boolean }> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return { files: [], truncated: false };
    }
    const exclude =
      `{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/.vscode-test/**,**/*.vsix,**/*.lock,**/pnpm-lock.yaml,**/package-lock.json,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.webp,**/*.ico,**/*.pdf,**/*.zip,**/*.map,${SECRET_FILE_GLOBS}}`;
    const uris = await vscode.workspace.findFiles("**/*", exclude, 1500);
    const rels = uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort((a, b) => a.localeCompare(b));

    const files: PromptFile[] = [{ path: "WORKSPACE_FILE_TREE.txt", content: rels.join("\n") }];
    let used = rels.join("\n").length;
    let truncated = false;

    for (const rel of rels) {
      if (used >= budget) {
        truncated = true;
        break;
      }
      try {
        const uri = vscode.Uri.joinPath(root.uri, ...rel.split("/").filter(Boolean));
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 200_000) {
          continue;
        }
        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        if (/[\x00-\x08]/.test(content)) {
          continue; // binary
        }
        if (used + content.length > budget) {
          truncated = true;
          continue;
        }
        files.push({ path: rel, content });
        used += content.length;
      } catch {
        // skip unreadable
      }
    }

    return { files, truncated };
  }

  /**
   * Deliver a whole-codebase index as an ordered sequence of paste-safe messages, waiting for the
   * chat to acknowledge each before sending the next. Returns the number of chunks delivered (>0 →
   * proceed to the task turn), 0 → "not chunked" (single-message index, chunking off, or no browser;
   * caller falls back to the normal path), or -1 → aborted mid-flight (caller stops entirely).
   */
  private async deliverCodebaseIndex(provider: WebChatProvider, contextPaths: readonly string[]): Promise<number> {
    if (this.getBridgeStatus().clientCount === 0) {
      return 0; // no browser to submit into — let the normal path copy a truncated prompt to clipboard
    }

    const messageLimit = this.getProviderMessageLimit(provider.id);
    const sessionLimit = this.getProviderSessionLimit(provider.id);
    const { files } = await this.readWorkspaceFiles(sessionLimit);
    if (files.length === 0) {
      return 0;
    }

    const plan = planIndexChunks(files, {
      maxChars: messageLimit,
      maxSessionChars: sessionLimit,
      maxChunks: Math.max(1, this.getNumber("index.maxChunks", DEFAULT_MAX_INDEX_CHUNKS)),
      providerLabel: provider.label
    });
    if (plan.chunks.length <= 1) {
      return 0; // fits in a single message — the normal path handles it (and its @-file merges)
    }

    this.indexingActive = true;
    this.indexAborted = false;
    this.indexLateAcks = 0;
    this.lastDispatchProvider = provider; // so repair/notices during priming name the right provider
    let delivered = 0;
    try {
      for (const chunk of plan.chunks) {
        if (this.indexAborted) {
          break; // reset/dispose asked us to stop; leave indexingActive on until finally
        }
        this.indexChunkRetries = 0;
        // Send (and re-send on a blocking state) the current chunk until it's acknowledged or we
        // give up after MAX_INDEX_CHUNK_RETRIES.
        for (;;) {
          if (this.indexAborted) {
            break;
          }
          this.indexRetryCurrent = false;
          this.emitters.notice.fire({
            level: "info",
            message: `Indexing ${provider.label}: part ${chunk.index}/${chunk.total}${this.indexChunkRetries ? ` (retry ${this.indexChunkRetries})` : ""} (${chunk.files.length} file${chunk.files.length === 1 ? "" : "s"}, ~${Math.round(chunk.chars / 1000)}k chars)…`
          });
          const turnDone = this.waitForIndexTurn();
          const sent = this.bridge!.sendToBrowsers(
            createEnvelope<ChatPromptPayload>({
              id: randomUUID(),
              sessionId: this.bridgeSessionId,
              type: "chat.prompt",
              payload: {
                providerId: provider.id,
                chatUrl: provider.chatUrl,
                prompt: this.protectOutgoing(chunk.text),
                promptNumber: this.usage.promptCount,
                expectedAction: "submit",
                autoSubmit: true,
                chunkIndex: chunk.index,
                chunkTotal: chunk.total
              }
            })
          );
          // Count the primed content against the input budget, but do NOT bump promptCount: index
          // chunks are context delivery, not user turns, and must not trip the compaction cadence.
          this.usage = { ...this.usage, inputTokensUsed: this.usage.inputTokensUsed + estimateTokens(chunk.text) };
          if (sent === 0) {
            this.finishIndexTurn();
            this.indexAborted = true;
            this.emitters.notice.fire({ level: "warn", message: "Browser disconnected during indexing; stopping delivery." });
            break;
          }
          await turnDone;
          if (this.indexAborted) {
            break;
          }
          if (this.indexRetryCurrent) {
            if (this.indexChunkRetries < MAX_INDEX_CHUNK_RETRIES) {
              this.indexChunkRetries += 1;
              this.emitters.notice.fire({
                level: "warn",
                message: `Part ${chunk.index}/${chunk.total} looked blocked; retrying (${this.indexChunkRetries}/${MAX_INDEX_CHUNK_RETRIES})…`
              });
              await this.delay(1200);
              continue; // re-send the same chunk
            }
            this.indexAborted = true;
            this.emitters.notice.fire({
              level: "warn",
              message: `Indexing stopped: ${provider.label} stayed blocked after ${MAX_INDEX_CHUNK_RETRIES} retries (login / rate limit?). The chat may still work — fix it in the browser, then re-run /index.`
            });
            break;
          }
          delivered = chunk.index;
          break; // acknowledged — move to the next chunk
        }
      }
    } finally {
      // Keep indexingActive true until here so any late ack for the last sent chunk is still
      // swallowed (never parsed as an agent response) before we drop the gate.
      this.indexingActive = false;
      this.finishIndexTurn();
    }

    if (this.indexAborted) {
      this.indexAborted = false;
      return -1; // session was reset / controller disposed mid-delivery — stop entirely
    }

    this.emitters.usage.fire(this.getUsageInfo());
    if (delivered === 0) {
      return 0;
    }
    if (plan.droppedFiles.length > 0) {
      this.emitters.notice.fire({
        level: "warn",
        message: `Indexed ${plan.includedFiles} files across ${delivered} message${delivered === 1 ? "" : "s"}; skipped ${plan.droppedFiles.length} file${plan.droppedFiles.length === 1 ? "" : "s"} to fit ${provider.label}'s session window. Raise it in Settings to include more.`
      });
    } else {
      this.emitters.notice.fire({
        level: "info",
        message: `Indexed ${plan.includedFiles} files across ${delivered} message${delivered === 1 ? "" : "s"}. Sending your task…`
      });
    }
    return delivered;
  }

  /** Resolve when the current index chunk is acknowledged (chat.stream.done) or after a timeout. */
  private waitForIndexTurn(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.indexTurnResolver = resolve;
      this.indexTurnTimer = setTimeout(() => {
        // Advance now, but remember that this chunk's real done may still arrive later so we can
        // swallow it instead of releasing the next chunk's waiter early.
        this.indexLateAcks += 1;
        this.emitters.notice.fire({
          level: "warn",
          message: "Indexing: the chat didn't acknowledge in time; continuing to the next part."
        });
        this.finishIndexTurn();
      }, INDEX_TURN_TIMEOUT_MS);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /** Clear the pending index-turn timer and release any waiter (idempotent). */
  private finishIndexTurn(): void {
    if (this.indexTurnTimer) {
      clearTimeout(this.indexTurnTimer);
      this.indexTurnTimer = undefined;
    }
    const resolve = this.indexTurnResolver;
    this.indexTurnResolver = undefined;
    resolve?.();
  }

  /**
   * A compact project structure (relative file paths) included with every turn so the model always
   * knows the layout and can `read_file` what it needs — even when the user didn't @-attach anything.
   */
  private async collectProjectTree(): Promise<PromptFile | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }
    const exclude =
      `{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/.vscode-test/**,**/*.vsix,**/*.map,${SECRET_FILE_GLOBS}}`;
    let rels: string[];
    try {
      const uris = await vscode.workspace.findFiles("**/*", exclude, 3000);
      rels = uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort((a, b) => a.localeCompare(b));
    } catch {
      return undefined;
    }
    if (rels.length === 0) {
      return undefined;
    }

    const cap = Math.max(1000, this.getNumber("context.maxTreeChars", 8000));
    let content = rels.join("\n");
    if (content.length > cap) {
      const kept: string[] = [];
      let used = 0;
      for (const rel of rels) {
        if (used + rel.length + 1 > cap) {
          break;
        }
        kept.push(rel);
        used += rel.length + 1;
      }
      content = `${kept.join("\n")}\n…[${rels.length - kept.length} more files omitted — use list_dir/search to explore]`;
    }
    return { path: "PROJECT_STRUCTURE.txt", content };
  }

  /**
   * Read @-mentions for the prompt: plain workspace files, plus the special mentions —
   * @problems (Problems panel), @git (status + diff), @open (all open editors) and @folder.
   */
  private async collectContextFiles(paths: readonly string[]): Promise<PromptFile[]> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root || paths.length === 0) {
      return [];
    }
    const files: PromptFile[] = [];
    const seen = new Set<string>();
    const addFile = async (rel: string) => {
      if (seen.has(rel)) {
        return;
      }
      seen.add(rel);
      const content = await this.readWorkspaceText(root, rel);
      if (content !== undefined) {
        files.push({ path: rel, content });
      }
    };

    for (const entry of paths) {
      try {
        if (entry === PROBLEMS_CONTEXT_TOKEN) {
          files.push({ path: "PROBLEMS.txt", content: collectDiagnostics() });
        } else if (entry === GIT_CONTEXT_TOKEN) {
          files.push({ path: "GIT_CHANGES.txt", content: await this.describeGitChanges() });
        } else if (entry === OPEN_EDITORS_CONTEXT_TOKEN) {
          for (const rel of openEditorPaths()) {
            await addFile(rel); // addFile → readWorkspaceText, which skips secret files
          }
        } else if (entry.startsWith(FOLDER_CONTEXT_PREFIX)) {
          const folder = entry.slice(FOLDER_CONTEXT_PREFIX.length).replace(/\/+$/, "");
          const listed = await this.listFolderFiles(root, folder);
          files.push({
            path: `${folder}/FOLDER_CONTENTS.txt`,
            content: listed.length > 0
              ? `Files in ${folder}/ (${listed.length}${listed.length >= MAX_FOLDER_MENTION_FILES ? "+, capped" : ""}):\n${listed.join("\n")}`
              : `No readable files in ${folder}/.`
          });
          for (const rel of listed) {
            await addFile(rel);
          }
        } else if (entry !== CODEBASE_CONTEXT_TOKEN) {
          await addFile(entry);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        files.push({ path: `${entry.replace(/[:/\\]+/g, "_")}.error.txt`, content: `Could not collect ${entry}: ${message}` });
      }
    }
    return files;
  }

  /** git status + uncommitted (unstaged and staged) diff, for the @git mention. */
  private async describeGitChanges(): Promise<string> {
    const parts = [await gitStatus(), await gitDiff(undefined, false)];
    const staged = await gitDiff(undefined, true);
    if (!staged.startsWith("No ")) {
      parts.push(staged);
    }
    return parts.join("\n\n");
  }

  /** Text files under a workspace folder, for the @folder mention (capped, no deps/build output). */
  private async listFolderFiles(root: vscode.WorkspaceFolder, folder: string): Promise<string[]> {
    if (folder) {
      resolveWorkspacePath(root, folder); // rejects absolute / ../ paths
    }
    const exclude = `{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/*.map,**/*.lock,**/*.min.js,${SECRET_FILE_GLOBS}}`;
    // Base the pattern on the folder URI: a folder name containing glob characters (Next.js "app/[id]")
    // must be taken literally, not as a character class.
    const pattern = folder
      ? new vscode.RelativePattern(vscode.Uri.joinPath(root.uri, ...folder.split("/").filter(Boolean)), "**/*")
      : new vscode.RelativePattern(root, "**/*");
    const uris = await vscode.workspace.findFiles(pattern, exclude, MAX_FOLDER_MENTION_FILES);
    return uris
      .map((uri) => vscode.workspace.asRelativePath(uri, false))
      .sort((a, b) => a.localeCompare(b));
  }

  /** A workspace file's text, or undefined if it is missing, binary or too large. */
  private async readWorkspaceText(root: vscode.WorkspaceFolder, rel: string): Promise<string | undefined> {
    try {
      if (isSecretFile(rel)) {
        return secretFileNotice(rel); // never send a credential file's contents
      }
      const uri = resolveWorkspacePath(root, rel);
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_MENTION_FILE_BYTES) {
        return undefined;
      }
      const text = Buffer.from(bytes).toString("utf8");
      return /[\x00-\x08]/.test(text) ? undefined : text;
    } catch {
      return undefined; // unreadable / missing / unsafe path
    }
  }

  getContextInfo(): ContextInfo {
    const editor = vscode.window.activeTextEditor;
    return {
      path: editor ? vscode.workspace.asRelativePath(editor.document.uri) : undefined,
      selectionOnly: this.getBool("prompt.includeSelectionOnly", false),
      hasSelection: Boolean(editor && !editor.selection.isEmpty)
    };
  }

  getUsageInfo(): SessionUsageInfo {
    const policy = this.getSessionPolicy(this.getCurrentProvider()?.id);
    const total = this.usage.inputTokensUsed + this.usage.outputTokensUsed;
    return {
      promptCount: this.usage.promptCount,
      inputTokensUsed: this.usage.inputTokensUsed,
      outputTokensUsed: this.usage.outputTokensUsed,
      totalTokensUsed: total,
      maxContextTokens: policy.budget.maxContextTokens,
      maxInputTokens: policy.budget.maxInputTokens,
      maxOutputTokens: policy.budget.maxOutputTokens,
      nextAction: decideNextSessionAction(this.usage, policy)
    };
  }

  // ---- internals -------------------------------------------------------------------------------
  private resolveChanges(turnId?: string): readonly AgentFileChange[] | undefined {
    if (!this.lastParsed) {
      return undefined;
    }
    if (turnId && this.lastParsed.turnId !== turnId) {
      return undefined;
    }
    return this.lastParsed.response.files.length > 0 ? this.lastParsed.response.files : undefined;
  }

  private async buildProviderPrompt(
    provider: WebChatProvider,
    userInstruction?: string,
    forcedAction?: "compact" | "rotate" | "continue",
    contextPaths?: readonly string[],
    includeProjectTree = true
  ): Promise<{ prompt: string; action: "submit" | "compact" | "rotate" | "continue" }> {
    const context = await collectActiveEditorContext(this.getBool("prompt.includeSelectionOnly", false));
    const requested = contextPaths ?? [];
    // The hard constraint: the whole prompt must fit the provider's per-message input limit. Reserve
    // headroom for the instructions + task text, then cap context (also by webchat.context.maxIndexChars).
    const providerLimit = this.getProviderMessageLimit(provider.id);
    const contextBudget = Math.max(
      2000,
      Math.min(this.getNumber("context.maxIndexChars", 48000), providerLimit - 4000)
    );
    const attached = await this.collectContextFiles(requested.filter((p) => p !== CODEBASE_CONTEXT_TOKEN));
    const hasCodebase = requested.includes(CODEBASE_CONTEXT_TOKEN);
    const codebase = hasCodebase ? await this.collectCodebaseContext(contextBudget) : [];
    // Always give the model the project layout (unless a full @codebase index — which already carries
    // the tree — is being sent, or this is a tool-loop continuation where it's already in context).
    const treeFile = includeProjectTree && !hasCodebase ? await this.collectProjectTree() : undefined;
    const treeFiles = treeFile ? [treeFile] : [];
    const files = trimFilesToBudget(
      mergeFiles(mergeFiles(mergeFiles(treeFiles, context.files), attached), codebase),
      contextBudget,
      (dropped) =>
      this.emitters.notice.fire({
        level: "warn",
        message: `Trimmed ${dropped} context file${dropped === 1 ? "" : "s"} to fit ${provider.label}'s ${providerLimit.toLocaleString()}-char message limit. Attach fewer files or raise the limit in Settings.`
      })
    );
    const policy = this.getSessionPolicy(provider.id);
    const decided = forcedAction || decideNextSessionAction(this.usage, policy);
    const storedSummary = this.getStoredSummary();
    const agentInstructions = buildAgentToolInstructions({
      maxContextTokens: policy.budget.maxContextTokens,
      compactEveryPrompts: policy.compactEveryPrompts,
      action: decided,
      mode: this.getAgentMode(),
      previousSummary: storedSummary,
      // Depth cap: once we're inside a subagent turn, don't advertise spawn_subagent again.
      allowSubagents: this.subagentCount === 0,
      providerId: provider.id
    });
    const taskInstruction = userInstruction
      ? `User task:\n${userInstruction}`
      : "Use the following editor context to help with the user's coding task.";
    // A scheduled compaction must never swallow what the user just asked: keep the task and ask for
    // a thorough summary alongside it. Only a manual "compact now" (no task) is a pure compaction turn.
    const pureCompaction = decided === "compact" && !userInstruction;
    const basePrompt = buildPrompt({
      provider,
      instruction: pureCompaction
        ? ["Before continuing, compact the current development state so it can seed a fresh chat later.", agentInstructions].join("\n\n")
        : decided === "compact"
          ? [taskInstruction, COMPACT_ALONGSIDE_TASK_NOTE, agentInstructions].join("\n\n")
          : [taskInstruction, agentInstructions].join("\n\n"),
      files
    });
    const finalPrompt =
      pureCompaction
        ? `${basePrompt}\n\n${buildCompactionPrompt({ recentAssistantText: "", files })}`
        : decided === "rotate" && storedSummary
          ? `${basePrompt}\n\nContinue from this compacted state:\n${storedSummary}`
          : basePrompt;

    return { prompt: finalPrompt, action: decided };
  }

  /** Build the current provider prompt and copy it to the clipboard without touching the budget. */
  async copyPrompt(instruction?: string): Promise<void> {
    const provider = this.getCurrentProvider();
    if (!provider) {
      this.emitters.notice.fire({ level: "error", message: "No web chat provider is configured." });
      return;
    }
    const { prompt } = await this.buildProviderPrompt(provider, instruction);
    await vscode.env.clipboard.writeText(prompt);
    this.emitters.notice.fire({ level: "info", message: `Prompt copied for ${provider.label}.` });
  }

  private describeInstruction(instruction: string | undefined, action: string): string {
    if (instruction?.trim()) {
      return instruction.trim();
    }
    if (action === "compact") {
      return "Compact the current development state.";
    }
    if (action === "rotate") {
      return "Start a fresh chat from the compacted state.";
    }
    return "Continue with the current editor context.";
  }

  private async requestRepair(fullText: string, parseError: string, providerId?: string): Promise<boolean> {
    if (!this.getBool("agent.autoRepairInvalidResponses", true)) {
      return false;
    }
    const provider = (providerId ? getProvider(providerId) : undefined) || this.lastDispatchProvider;
    const maxAttempts = Math.max(0, this.getNumber("agent.maxRepairAttempts", 1));
    if (!provider || this.repairAttempts >= maxAttempts || !this.bridge?.getStatus().running) {
      return false;
    }

    const repairPrompt = buildAgentResponseRepairPrompt({ parseError, invalidResponse: fullText });
    this.usage = applyPromptUsage(this.usage, repairPrompt);
    this.repairAttempts += 1;

    const sent = this.bridge.sendToBrowsers(
      createEnvelope<ChatPromptPayload>({
        id: randomUUID(),
        sessionId: this.bridgeSessionId,
        type: "chat.prompt",
        payload: {
          providerId: provider.id,
          chatUrl: provider.chatUrl,
          prompt: this.protectOutgoing(repairPrompt),
          promptNumber: this.usage.promptCount,
          expectedAction: "continue",
          autoSubmit: this.getBool("browser.autoSubmit", false)
        }
      })
    );

    this.emitters.notice.fire({
      level: "warn",
      message:
        sent === 0
          ? "Copied a repair prompt because no browser is connected."
          : "Requested a corrected tool response from the browser."
    });
    return true;
  }

  private async askToApplyViaModal(response: AgentResponse): Promise<void> {
    const detail = [response.summary, "", response.files.map((f) => `${f.action}: ${f.path}`).join("\n")]
      .filter(Boolean)
      .join("\n");
    const choice = await vscode.window.showInformationMessage(
      `WebChat captured ${response.files.length} file change${response.files.length === 1 ? "" : "s"}.`,
      { modal: true, detail },
      "Apply Changes",
      "Preview Diffs",
      "Skip"
    );
    if (choice === "Apply Changes") {
      const result = await this.applyChanges(this.lastParsed?.turnId, { feedbackToModel: false });
      if (!result.ok) {
        this.pendingFeedback.push(result.feedback);
      }
    } else if (choice === "Preview Diffs") {
      await this.previewChanges(this.lastParsed?.turnId);
    }
  }

  private emitContext(): void {
    this.emitters.context.fire(this.getContextInfo());
  }

  /**
   * Session policy for a provider: the configured budget, capped to that provider's conversation
   * window ("Max conversation length") so a fresh chat starts before the provider cuts it off.
   */
  private getSessionPolicy(providerId?: string): SessionPolicy {
    const config = vscode.workspace.getConfiguration("webchat");
    const windowTokens = providerId
      ? Math.floor(this.getProviderSessionLimit(providerId) / CHARS_PER_TOKEN)
      : undefined;
    return {
      compactEveryPrompts: config.get("session.compactEveryPrompts", defaultSessionPolicy.compactEveryPrompts),
      budget: capBudgetToWindow({
        maxContextTokens: config.get("session.maxContextTokens", defaultSessionPolicy.budget.maxContextTokens),
        maxInputTokens: config.get("session.maxInputTokens", defaultSessionPolicy.budget.maxInputTokens),
        maxOutputTokens: config.get("session.maxOutputTokens", defaultSessionPolicy.budget.maxOutputTokens),
        rotateWhenBudgetRemainingBelow: config.get(
          "session.rotateWhenBudgetRemainingBelow",
          defaultSessionPolicy.budget.rotateWhenBudgetRemainingBelow
        )
      }, windowTokens)
    };
  }

  /** Tool rounds allowed per user task (webchat.agent.maxToolIterations; 0 = mode default). */
  private getMaxToolIterations(): number {
    const configured = Math.trunc(this.getNumber("agent.maxToolIterations", 0));
    if (configured > 0) {
      return Math.min(configured, 200);
    }
    return this.getAgentMode() === "bypass" ? DEFAULT_FULL_ACCESS_TOOL_ITERATIONS : DEFAULT_TOOL_ITERATIONS;
  }

  private getAgentMode(): "ask" | "auto" | "plan" | "bypass" {
    const mode = this.getString("agent.mode", "ask");
    if (mode === "bypass" && vscode.workspace.isTrusted === false) {
      // Restricted Mode (an untrusted folder): never auto-run the model's commands there.
      if (!this.warnedUntrustedFullAccess) {
        this.warnedUntrustedFullAccess = true;
        this.emitters.notice.fire({
          level: "warn",
          message: "This folder isn't trusted (Restricted Mode), so full access acts like Auto-edit: commands still need your approval. Trust the folder to allow full access."
        });
      }
      return "auto";
    }
    return mode === "auto" || mode === "plan" || mode === "bypass" ? mode : "ask";
  }


  /**
   * Effective file-apply behavior, derived ONLY from the agent mode — the legacy `agent.applyMode`
   * setting must NOT override it (that bug made Ask mode silently auto-apply).
   *   ask → review a diff card before applying · auto/bypass → apply automatically · plan → never.
   */
  private getApplyMode(): "ask" | "auto" | "never" {
    switch (this.getAgentMode()) {
      case "auto":
      case "bypass":
        return "auto";
      case "plan":
        return "never";
      default:
        return "ask";
    }
  }

  private getStoredSummary(): string {
    return this.context.globalState.get<string>("webchat.session.summary") || "";
  }

  private getString(key: string, fallback: string): string {
    return vscode.workspace.getConfiguration("webchat").get<string>(key, fallback);
  }

  private getBool(key: string, fallback: boolean): boolean {
    return vscode.workspace.getConfiguration("webchat").get<boolean>(key, fallback);
  }

  private getNumber(key: string, fallback: number): number {
    return vscode.workspace.getConfiguration("webchat").get<number>(key, fallback);
  }
}

function parsePidsFromWmic(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^ProcessId=(\d+)/);
    if (match) {
      pids.push(Number(match[1]));
    }
  }
  return pids;
}

/** Keep files (in order) until the char budget is reached; always keep at least the first. */
function trimFilesToBudget(
  files: readonly PromptFile[],
  budget: number,
  onTrim: (dropped: number) => void
): PromptFile[] {
  const out: PromptFile[] = [];
  let used = 0;
  let dropped = 0;
  for (const file of files) {
    const size = file.path.length + file.content.length + 40; // + XML/CDATA wrapper overhead
    if (out.length > 0 && used + size > budget) {
      dropped += 1;
      continue;
    }
    out.push(file);
    used += size;
  }
  if (dropped > 0) {
    onTrim(dropped);
  }
  return out;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_COMMAND_OUTPUT_CHARS) {
    return text;
  }
  const head = text.slice(0, Math.floor(MAX_COMMAND_OUTPUT_CHARS * 0.7));
  const tail = text.slice(-Math.floor(MAX_COMMAND_OUTPUT_CHARS * 0.3));
  return `${head}\n…[output truncated]…\n${tail}`;
}

function mergeFiles(base: readonly PromptFile[], extra: readonly PromptFile[]): PromptFile[] {
  const byPath = new Map<string, PromptFile>();
  for (const file of base) {
    byPath.set(file.path, file);
  }
  for (const file of extra) {
    byPath.set(file.path, file); // @-attached files take precedence
  }
  return [...byPath.values()];
}

function fileScore(rel: string, query: string): number {
  const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  if (base === query) {
    return 4;
  }
  if (base.startsWith(query)) {
    return 3;
  }
  if (base.includes(query)) {
    return 2;
  }
  return 1; // matched somewhere in the path
}

/** Tools that mutate or execute — gated by agent mode. Read-only tools run automatically. */
function isPrivilegedTool(tool: AgentToolRequest): boolean {
  return tool.name === "run" || tool.name === "spawn_subagent";
}

/** Heuristic: does this provider URL point at a specific conversation (vs. the provider's home/new)? */
function looksLikeConversationUrl(url: URL): boolean {
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/new" || path === "/app" || path === "/prompts/new_chat") {
    return false;
  }
  // Require an id-ish segment (a conversation id) somewhere in the path.
  return path.split("/").some((segment) => /[a-z0-9-]{8,}/i.test(segment));
}

/** Trim a browser tab title down to a short session label (drop the provider suffix). */
function cleanSessionTitle(title: string, providerLabel: string): string | undefined {
  const cleaned = title
    .replace(new RegExp(`\\s*[|\\-–]\\s*${providerLabel}\\s*$`, "i"), "")
    .replace(/\s*[|\-–]\s*(ChatGPT|Claude|Gemini|Qwen|DeepSeek|Google AI Studio)\s*$/i, "")
    .trim();
  return cleaned && cleaned.length <= 80 ? cleaned : undefined;
}

/** Short label for a privileged tool shown in the webview approval card. */
function toolApprovalLabel(tool: AgentToolRequest): string {
  if (tool.name === "run") {
    return tool.command;
  }
  if (tool.name === "spawn_subagent") {
    return `subagent → ${tool.task}`;
  }
  return tool.name;
}

function isDelta(payload: unknown): payload is ChatStreamDeltaPayload {
  return typeof payload === "object" && payload !== null && typeof (payload as { text?: unknown }).text === "string";
}

function isDone(payload: unknown): payload is ChatStreamDonePayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { fullText?: unknown }).fullText === "string"
  );
}

function safeHostId(url: unknown): string {
  if (typeof url !== "string") {
    return "";
  }
  try {
    return normalizeId(new URL(url.trim()).hostname);
  } catch {
    return "";
  }
}

/** Map a bridge message to a request-lifecycle event (undefined = not lifecycle-relevant). */
function requestEventFor(message: BridgeEnvelope): RequestEvent | undefined {
  switch (message.type) {
    case "chat.state": {
      const payload = message.payload as { state?: unknown; detail?: unknown };
      return typeof payload?.state === "string"
        ? { kind: "page-state", state: payload.state, detail: typeof payload.detail === "string" ? payload.detail : undefined }
        : undefined;
    }
    case "chat.stream.delta":
      return { kind: "delta" };
    case "chat.stream.done":
      return { kind: "response-done" };
    case "chat.error": {
      const payload = message.payload as { detail?: unknown };
      return { kind: "transport-error", detail: typeof payload?.detail === "string" ? payload.detail : undefined };
    }
    default:
      return undefined;
  }
}

/** What the new provider is allowed to do, in words, for the handover package. */
function describePermissions(mode: "ask" | "auto" | "plan" | "bypass"): string {
  switch (mode) {
    case "bypass":
      return "Full access: file edits are applied automatically and shell commands run automatically.";
    case "auto":
      return "Auto-edit: file edits are applied automatically; shell commands need the user's approval.";
    case "plan":
      return "Plan only: do not edit files or run commands.";
    default:
      return "Ask: the user reviews a diff before edits are applied, and approves shell commands.";
  }
}
