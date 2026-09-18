#!/usr/bin/env bun
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { closeChatGptBrowserWorkers } from "./adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers, RemoteTurnBroker, TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { createChatGptWebAdapter } from "./adapters/chatgpt-web/index";
import { buildResponseJSON, formatErrorResponse } from "./bridge";
import { CHATGPT_WEB_BACKEND_MODEL, CHATGPT_WEB_INSTANT_CONTEXT_WINDOW, CHATGPT_WEB_LUNA_BACKEND_MODEL } from "./chatgpt-web-models";
import { expandUserPath } from "./config";
import type { AdapterEvent, CodexAssistantContentPart, CodexContentPart, CodexMessage, CodexParsedRequest, CodexProviderConfig, CodexTool, CodexToolResultMessage } from "./types";
import { VERSION } from "./version";

type ChatGptBrowserApiConfig = {
  host: string;
  port: number;
  apiKey: string;
  controlToken?: string;
  model: string;
  models: string[];
  mode?: "browser-only" | "full";
  contextWindow: number;
  browserHost: "managed-chrome" | "launcher";
  browserHostDescriptorPath?: string;
  chromeExecutablePath?: string;
  storageStatePath?: string;
  brokerSocketPath?: string;
  headed: boolean;
  solAvailable: boolean;
  proAvailable: boolean;
  experimentalBiggerContext: boolean;
  extraHighAvailable?: boolean;
  autoApproveToolCalls?: boolean;
  browserInteractionMode?: "automatic" | "manual";
  turnTimeoutMs?: number;
  stallTimeoutSec?: number;
};

type ActiveCodexConfig = Partial<Pick<ChatGptBrowserApiConfig, "mode" | "browserHost" | "browserHostDescriptorPath" | "chromeExecutablePath" | "storageStatePath" | "brokerSocketPath" | "headed" | "solAvailable" | "proAvailable" | "experimentalBiggerContext" | "extraHighAvailable" | "autoApproveToolCalls" | "browserInteractionMode" | "stallTimeoutSec">>;

type ActiveAppInfo = {
  codexHome: string;
  codexConfigPath: string;
  codexConfigFound: boolean;
  launcherDescriptorPath: string;
  launcherDescriptorFound: boolean;
  codexStorageStatePath?: string;
  codexStorageStateFound: boolean;
};

const DEFAULT_MODEL = "gpt-5.6-sol";
const MARKSCODE_BROWSER_MODELS = ["browser-agent/gpt", "browser-agent-gpt"] as const;
const MARKSCODE_LOCAL_API_KEYS = new Set(["local-proxy2", "marks-local2"]);
const TOOL_TURN_TTL_MS = 30 * 60_000;
const TOOL_CONTINUATION_TTL_MS = 10 * 60_000;
const WORKSPACE_ROOT_TTL_MS = 30 * 60_000;
const MAX_WORKSPACE_ROOTS = 256;

type ToolTurnRef = {
  threadId: string;
  turnId: string;
  createdAt: number;
};

const toolTurnRefs = new Map<string, ToolTurnRef>();
const completedToolContinuations = new Map<string, number>();
const workspaceRootsByIdentity = new Map<string, { root: string; createdAt: number }>();

let browserQueueTail: Promise<void> = Promise.resolve();
let browserQueueDepth = 0;
let browserQueueActive = false;
let browserQueueSequence = 0;
let toolLease: ToolLease | undefined;

type ToolLease = {
  id: number;
  threadId?: string;
  turnId?: string;
  toolCallIds: string[];
  createdAt: number;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
  release: () => void;
  promise: Promise<void>;
};

type BrowserTurnOptions = {
  toolContinuation?: boolean;
  body?: Record<string, unknown>;
};

function toolLeaseTimeoutMs(): number {
  const value = Number(process.env.CHATGPT_BROWSER_API_TOOL_LEASE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

function clearToolLease(reason: string): void {
  const lease = toolLease;
  if (!lease) return;
  toolLease = undefined;
  clearTimeout(lease.timeout);
  lease.release();
  console.info(`[chatgpt-browser-api] tool lease id=${lease.id} released reason=${reason}`);
}

function expireToolLease(id: number): void {
  if (toolLease?.id !== id) return;
  console.warn(`[chatgpt-browser-api] tool lease id=${id} expired after ${toolLeaseTimeoutMs()}ms`);
  clearToolLease("expired");
}

async function waitForToolLease(lease: ToolLease, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return lease.promise;
  if (signal.aborted) throw new Error("ChatGPT browser turn aborted while waiting for tool lease");
  await Promise.race([
    lease.promise,
    new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("ChatGPT browser turn aborted while waiting for tool lease")), { once: true })),
  ]);
}

async function enqueueBrowserTurn<T>(kind: "chat" | "responses", signal: AbortSignal | undefined, run: () => Promise<T>, options: BrowserTurnOptions = {}): Promise<T> {
  const id = ++browserQueueSequence;
  for (;;) {
    if (!options.toolContinuation && toolLease) await waitForToolLease(toolLease, signal);
    browserQueueDepth += 1;
    const previous = browserQueueTail.catch(() => undefined);
    let release!: () => void;
    browserQueueTail = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
    await previous;
    browserQueueDepth -= 1;
    if (signal?.aborted) {
      release();
      throw new Error(`ChatGPT browser turn aborted before entering queue: ${kind}`);
    }
    if (!options.toolContinuation && toolLease) {
      const lease = toolLease;
      release();
      await waitForToolLease(lease, signal);
      continue;
    }
    if (options.toolContinuation && toolLease && !toolLeaseMatchesBody(toolLease, options.body)) {
      release();
      await waitForToolLease(toolLease, signal);
      continue;
    }
    browserQueueActive = true;
    console.info(`[chatgpt-browser-api] browser queue turn=${id} kind=${kind} started queued=${browserQueueDepth}`);
    try {
      return await run();
    } finally {
      browserQueueActive = false;
      release();
      console.info(`[chatgpt-browser-api] browser queue turn=${id} kind=${kind} completed queued=${browserQueueDepth}`);
    }
  }
}

function installProductionLogFilter(): void {
  const level = (process.env.CHATGPT_BROWSER_API_LOG_LEVEL || "info").toLowerCase();
  if (level === "debug" || level === "trace") return;
  const originalInfo = console.info.bind(console);
  const noisy = [
    "browser diagnostic trace=",
    " stage=browser_page started",
    " stage=browser_page completed",
    " stage=temporary_chat_preparation started",
    " stage=temporary_chat_preparation completed",
    " stage=effort_selection started",
    " stage=effort_selection completed",
    " stage=prompt_attachment started",
    " stage=prompt_attachment completed",
    " stage=file_attachment started",
    " stage=file_attachment completed",
    " stage=send started",
    " stage=send completed",
    "waiting for completed-turn evidence",
  ];
  console.info = (...args: unknown[]) => {
    const line = args.map(arg => typeof arg === "string" ? arg : String(arg)).join(" ");
    if (noisy.some(fragment => line.includes(fragment))) return;
    originalInfo(...args);
  };
}

installProductionLogFilter();

function homeDir(): string {
  return resolve(expandUserPath(process.env.CHATGPT_BROWSER_API_HOME?.trim() || join(homedir(), ".chatgpt-browser-api")));
}

function codexHomeDir(): string {
  return resolve(expandUserPath(process.env.CODEX_CHATGPT_WEB_HOME?.trim() || join(homedir(), ".codex-chatgpt-web")));
}

function remoteBrokerForConfig(config: ChatGptBrowserApiConfig): RemoteTurnBroker | undefined {
  if (config.mode !== "full" || !config.brokerSocketPath) return undefined;
  const codexRuntime = resolve(join(codexHomeDir(), "runtime"));
  return resolve(config.brokerSocketPath).startsWith(codexRuntime) ? new RemoteTurnBroker(config.brokerSocketPath) : undefined;
}

function configPath(): string {
  return join(homeDir(), "config.json");
}

function runtimePath(name: string): string {
  return join(homeDir(), "runtime", name);
}

function defaultConfig(): ChatGptBrowserApiConfig {
  return {
    host: "127.0.0.1",
    port: 18082,
    apiKey: randomBytes(32).toString("base64url"),
    controlToken: randomBytes(32).toString("base64url"),
    model: DEFAULT_MODEL,
    models: [...MARKSCODE_BROWSER_MODELS, DEFAULT_MODEL, "gpt-5.6-luna"],
    mode: "browser-only",
    contextWindow: CHATGPT_WEB_INSTANT_CONTEXT_WINDOW,
    browserHost: "managed-chrome",
    storageStatePath: runtimePath("storage-state.json"),
    brokerSocketPath: process.platform === "win32" ? undefined : runtimePath("turn-broker.sock"),
    headed: false,
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: false,
    extraHighAvailable: false,
    autoApproveToolCalls: false,
    browserInteractionMode: "automatic",
  };
}

function loadConfig(): ChatGptBrowserApiConfig {
  const path = configPath();
  if (!existsSync(path)) throw new Error(`Missing config at ${path}. Run chatgpt-browser-api init first.`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ChatGptBrowserApiConfig>;
  const base = defaultConfig();
  const envPort = Number(process.env.CHATGPT_BROWSER_API_PORT);
  const envModels = process.env.CHATGPT_BROWSER_API_MODELS?.split(",").map(value => value.trim()).filter(Boolean);
  return {
    ...base,
    ...parsed,
    host: process.env.CHATGPT_BROWSER_API_HOST?.trim() || parsed.host || base.host,
    port: Number.isInteger(envPort) && envPort > 0 && envPort <= 65_535 ? envPort : (parsed.port || base.port),
    apiKey: process.env.CHATGPT_BROWSER_API_KEY?.trim() || parsed.apiKey || parsed.controlToken || base.apiKey,
    controlToken: process.env.CHATGPT_BROWSER_API_CONTROL_TOKEN?.trim() || parsed.controlToken,
    model: process.env.CHATGPT_BROWSER_API_MODEL?.trim() || parsed.model || base.model,
    models: envModels && envModels.length > 0
      ? envModels
      : Array.from(new Set([...(Array.isArray(parsed.models) ? parsed.models : []), ...base.models])),
    mode: process.env.CHATGPT_BROWSER_API_FULL_HARNESS === "1" ? "full" : (parsed.mode || base.mode),
    autoApproveToolCalls: process.env.CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS === "1" || parsed.autoApproveToolCalls === true,
  };
}

function loadOrInitConfig(): ChatGptBrowserApiConfig {
  if (!existsSync(configPath())) writeDefaultConfig();
  return loadConfig();
}

function readActiveCodexConfig(path: string): ActiveCodexConfig | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ActiveCodexConfig;
}

function activeAppInfo(): { info: ActiveAppInfo; config?: ActiveCodexConfig } {
  const codexHome = codexHomeDir();
  const codexConfigPath = join(codexHome, "config.json");
  const launcherDescriptorPath = join(codexHome, "runtime", "launcher-browser.json");
  const config = readActiveCodexConfig(codexConfigPath);
  const codexStorageStatePath = config?.storageStatePath ? resolve(expandUserPath(config.storageStatePath)) : join(codexHome, "browser", "storage-state.json");
  return {
    info: {
      codexHome,
      codexConfigPath,
      codexConfigFound: !!config,
      launcherDescriptorPath,
      launcherDescriptorFound: existsSync(launcherDescriptorPath),
      codexStorageStatePath,
      codexStorageStateFound: existsSync(codexStorageStatePath),
    },
    config,
  };
}

function applyActiveAppConfig(config: ChatGptBrowserApiConfig): { config: ChatGptBrowserApiConfig; info: ActiveAppInfo } {
  const active = activeAppInfo();
  const next: ChatGptBrowserApiConfig = { ...config };
  if (active.info.launcherDescriptorFound) {
    next.browserHost = "launcher";
    next.browserHostDescriptorPath = active.info.launcherDescriptorPath;
  } else if (active.info.codexStorageStateFound && active.info.codexStorageStatePath) {
    next.storageStatePath = active.info.codexStorageStatePath;
    if (active.config?.browserHost === "managed-chrome" || active.config?.browserHost === "launcher") next.browserHost = active.config.browserHost;
    if (active.config?.chromeExecutablePath) next.chromeExecutablePath = active.config.chromeExecutablePath;
    if (typeof active.config?.headed === "boolean") next.headed = active.config.headed;
  }
  if (active.config?.brokerSocketPath) next.brokerSocketPath = active.config.brokerSocketPath;
  if (typeof active.config?.solAvailable === "boolean") next.solAvailable = active.config.solAvailable;
  if (typeof active.config?.proAvailable === "boolean") next.proAvailable = active.config.proAvailable;
  if (typeof active.config?.experimentalBiggerContext === "boolean") next.experimentalBiggerContext = active.config.experimentalBiggerContext;
  if (typeof active.config?.extraHighAvailable === "boolean") next.extraHighAvailable = active.config.extraHighAvailable;
  if (typeof active.config?.autoApproveToolCalls === "boolean" && next.autoApproveToolCalls !== true) next.autoApproveToolCalls = active.config.autoApproveToolCalls;
  if (active.config?.browserInteractionMode === "automatic" || active.config?.browserInteractionMode === "manual") next.browserInteractionMode = active.config.browserInteractionMode;
  if (active.config?.mode === "full" && process.env.CHATGPT_BROWSER_API_FULL_HARNESS !== "0") next.mode = "full";
  if (typeof active.config?.stallTimeoutSec === "number") next.stallTimeoutSec = active.config.stallTimeoutSec;
  return { config: next, info: active.info };
}

function writeDefaultConfig(): string {
  mkdirSync(join(homeDir(), "runtime"), { recursive: true, mode: 0o700 });
  const path = configPath();
  if (existsSync(path)) return path;
  writeFileSync(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { mode: 0o600 });
  return path;
}

function writeConfig(config: ChatGptBrowserApiConfig): string {
  mkdirSync(join(homeDir(), "runtime"), { recursive: true, mode: 0o700 });
  const path = configPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function configuredApiKey(): string {
  return loadOrInitConfig().apiKey;
}

function setConfiguredApiKey(value?: string): string {
  const apiKey = value?.trim() || randomBytes(32).toString("base64url");
  if (apiKey.length < 8) throw new Error("API key must have at least 8 characters");
  const config = loadOrInitConfig();
  config.apiKey = apiKey;
  writeConfig(config);
  return apiKey;
}

function providerConfig(config: ChatGptBrowserApiConfig): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    models: config.models,
    liveModels: false,
    defaultModel: config.model,
    contextWindow: config.contextWindow,
    modelInputModalities: Object.fromEntries(config.models.map(model => [model, ["text", "image"]])),
    modelReasoningEfforts: Object.fromEntries(config.models.map(model => [model, ["low", "medium", "high", "xhigh", ...(config.proAvailable ? ["max"] : [])]])),
    modelDefaultReasoningEfforts: Object.fromEntries(config.models.map(model => [model, config.solAvailable ? "high" : "low"])),
    noReasoningModels: [],
    chatgptWeb: {
      appName: "Codex Native2",
      browserInteractionMode: config.browserInteractionMode || "automatic",
      browserHost: config.browserHost,
      browserHostDescriptorPath: config.browserHostDescriptorPath,
      storageStatePath: config.storageStatePath,
      chromeExecutablePath: config.chromeExecutablePath,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: runtimePath("thread-environments.json"),
      lunaCheckpointStatePath: runtimePath("luna-checkpoints.json"),
      headed: config.headed,
      localToolsEnabled: config.mode === "full",
      solAvailable: config.solAvailable,
      extraHighAvailable: config.extraHighAvailable,
      proAvailable: config.proAvailable,
      experimentalBiggerContext: config.experimentalBiggerContext,
      ...(config.turnTimeoutMs !== undefined ? { turnTimeoutMs: config.turnTimeoutMs } : {}),
      ...(config.stallTimeoutSec !== undefined ? { stallTimeoutSec: config.stallTimeoutSec } : {}),
      autoApproveToolCalls: config.autoApproveToolCalls === true,
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function unauthorized(): Response {
  return json({ error: { type: "authentication_error", message: "Bearer authentication required" } }, 401);
}

function tokenMatches(actualToken: string, expectedToken: string): boolean {
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(actualToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isAuthorized(request: Request, config: ChatGptBrowserApiConfig): boolean {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7).trim();
  if (tokenMatches(token, config.apiKey)) return true;
  return isLoopbackHost(config.host)
    && process.env.CHATGPT_BROWSER_API_MARKSCODE_COMPAT !== "0"
    && MARKSCODE_LOCAL_API_KEYS.has(token);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON object body required");
  return body as Record<string, unknown>;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => textFromUnknown(part)).join("");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (typeof item.text === "string") return item.text;
    if (typeof item.input_text === "string") return item.input_text;
    if (typeof item.output_text === "string") return item.output_text;
    if (item.content !== undefined) return textFromUnknown(item.content);
    if (item.input !== undefined) return textFromUnknown(item.input);
  }
  return value == null ? "" : String(value);
}

function contentParts(value: unknown): string | CodexContentPart[] {
  if (!Array.isArray(value)) return textFromUnknown(value);
  const parts: CodexContentPart[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if ((type === "text" || type === "input_text") && typeof record.text === "string") parts.push({ type: "text", text: record.text });
    const imageUrl = record.image_url;
    if ((type === "image_url" || type === "input_image") && imageUrl) {
      const url = typeof imageUrl === "string" ? imageUrl : typeof imageUrl === "object" && imageUrl && typeof (imageUrl as { url?: unknown }).url === "string" ? (imageUrl as { url: string }).url : undefined;
      if (url) parts.push({ type: "image", imageUrl: url, detail: typeof record.detail === "string" ? record.detail : undefined });
    }
  }
  return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
}

function messagesFromChat(body: Record<string, unknown>): CodexMessage[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const now = Date.now();
  return messages.flatMap((message, index): CodexMessage[] => {
    if (!message || typeof message !== "object") return [];
    const messageRecord = message as Record<string, unknown>;
    const role = messageRecord.role;
    const timestamp = now + index;
    if (role === "assistant") {
      const content = Array.isArray(messageRecord.content)
        ? messageRecord.content.flatMap((part): CodexAssistantContentPart[] => {
          const item = record(part);
          if (item?.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string") {
            return [{ type: "toolCall", id: item.id, name: item.name, arguments: record(item.arguments) ?? {} }];
          }
          return [{ type: "text", text: textFromUnknown(part) }];
        })
        : [{ type: "text" as const, text: textFromUnknown(messageRecord.content) }];
      if (Array.isArray(messageRecord.tool_calls)) {
        for (const toolCall of messageRecord.tool_calls) {
          const call = record(toolCall);
          const fn = record(call?.function);
          const id = stringField(call?.id);
          const name = stringField(fn?.name);
          if (id && name) content.push({ type: "toolCall", id, name, arguments: parseToolArguments(typeof fn?.arguments === "string" ? fn.arguments : "{}") });
        }
      }
      return [{ role: "assistant", content, timestamp }];
    }
    if (role === "tool" || role === "tool_result" || role === "toolResult") return [{
      role: "toolResult",
      toolCallId: stringField(messageRecord.tool_call_id, messageRecord.toolCallId) ?? "",
      toolName: stringField(messageRecord.name, messageRecord.toolName) ?? "exec",
      content: textFromUnknown(messageRecord.content),
      isError: messageRecord.is_error === true || messageRecord.isError === true,
      timestamp,
    }];
    if (role === "system" || role === "developer") return [{ role: "developer", content: contentParts(messageRecord.content), timestamp }];
    return [{ role: "user", content: contentParts(messageRecord.content), timestamp }];
  });
}

function messagesFromResponses(body: Record<string, unknown>): CodexMessage[] {
  const input = body.input;
  const now = Date.now();
  if (typeof input === "string") return [{ role: "user", content: input, timestamp: now }];
  if (!Array.isArray(input)) return [];
  return input.flatMap((item, index): CodexMessage[] => {
    if (typeof item === "string") return [{ role: "user", content: item, timestamp: now + index }];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const role = record.role;
    if (role === "assistant") return [{ role: "assistant", content: [{ type: "text", text: textFromUnknown(record.content) }], timestamp: now + index }];
    if (role === "system" || role === "developer") return [{ role: "developer", content: contentParts(record.content), timestamp: now + index }];
    return [{ role: "user", content: contentParts(record.content), timestamp: now + index }];
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function syntheticId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(8).toString("base64url")}`;
}

function stableInputItemId(prefix: string, value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  return `${prefix}_${digest}`;
}

function existingCodexMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = record(body.client_metadata)?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try { return record(JSON.parse(raw)); }
    catch { return undefined; }
  }
  return record(raw);
}

function pruneToolTurnRefs(): void {
  const cutoff = Date.now() - TOOL_TURN_TTL_MS;
  for (const [callId, ref] of toolTurnRefs) {
    if (ref.createdAt < cutoff) toolTurnRefs.delete(callId);
  }
}

function toolCallIdsFromBody(body: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const item = record(message);
    if (!item) continue;
    const direct = stringField(item.tool_call_id, item.toolCallId);
    if (direct) ids.push(direct);
    for (const toolCall of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
      const id = stringField(record(toolCall)?.id);
      if (id) ids.push(id);
    }
    for (const part of Array.isArray(item.content) ? item.content : []) {
      const content = record(part);
      if (content?.type !== "toolCall") continue;
      const id = stringField(content.id);
      if (id) ids.push(id);
    }
  }
  return ids;
}

function toolResultIdsFromBody(body: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const item = record(message);
    const role = stringField(item?.role);
    if (role === "tool" || role === "tool_result" || role === "toolResult") {
      const id = stringField(item?.tool_call_id, item?.toolCallId);
      if (id) ids.push(id);
    }
  }
  for (const entry of Array.isArray(body.input) ? body.input : []) {
    const item = record(entry);
    const type = stringField(item?.type);
    if (type === "function_call_output" || type === "tool_result" || type === "toolResult") {
      const id = stringField(item?.call_id, item?.tool_call_id, item?.toolCallId);
      if (id) ids.push(id);
    }
  }
  return ids;
}

function rememberedToolTurn(body: Record<string, unknown>): ToolTurnRef | undefined {
  pruneToolTurnRefs();
  for (const callId of toolCallIdsFromBody(body)) {
    const ref = toolTurnRefs.get(callId);
    if (ref) return ref;
  }
  return undefined;
}

function bodyThreadTurn(body: Record<string, unknown> | undefined): { threadId?: string; turnId?: string } {
  if (!body) return {};
  const metadata = existingCodexMetadata(body) ?? record(body.metadata) ?? {};
  return {
    threadId: stringField(body.thread_id, metadata.thread_id, metadata.threadId),
    turnId: stringField(body.turn_id, metadata.turn_id, metadata.turnId),
  };
}

function workspaceIdentity(body: Record<string, unknown>): string | undefined {
  const metadata = existingCodexMetadata(body) ?? record(body.metadata) ?? {};
  const remembered = rememberedToolTurn(body);
  const identity = stringField(
    body.thread_id,
    metadata.thread_id,
    metadata.threadId,
    body.session_id,
    metadata.session_id,
    metadata.sessionId,
    body.conversation_id,
    metadata.conversation_id,
    metadata.conversationId,
    body.response_id,
    body.previous_response_id,
    remembered?.threadId,
  );
  return identity ? `${identity}` : undefined;
}

function pruneWorkspaceRoots(): void {
  const cutoff = Date.now() - WORKSPACE_ROOT_TTL_MS;
  for (const [identity, entry] of workspaceRootsByIdentity) {
    if (entry.createdAt < cutoff || !existsSync(entry.root)) workspaceRootsByIdentity.delete(identity);
  }
  while (workspaceRootsByIdentity.size > MAX_WORKSPACE_ROOTS) {
    const oldest = workspaceRootsByIdentity.keys().next().value;
    if (typeof oldest !== "string") break;
    workspaceRootsByIdentity.delete(oldest);
  }
}

function rememberedWorkspaceRoot(body: Record<string, unknown>): string | undefined {
  pruneWorkspaceRoots();
  const identity = workspaceIdentity(body);
  if (!identity) return undefined;
  const entry = workspaceRootsByIdentity.get(identity);
  if (!entry || !existsSync(entry.root)) return undefined;
  entry.createdAt = Date.now();
  workspaceRootsByIdentity.delete(identity);
  workspaceRootsByIdentity.set(identity, entry);
  return entry.root;
}

function rememberWorkspaceRoot(body: Record<string, unknown>, root: string): void {
  const identity = workspaceIdentity(body);
  if (!identity || !existsSync(root)) return;
  workspaceRootsByIdentity.delete(identity);
  workspaceRootsByIdentity.set(identity, { root, createdAt: Date.now() });
  pruneWorkspaceRoots();
}

function toolLeaseMatchesBody(lease: ToolLease, body: Record<string, unknown> | undefined): boolean {
  if (!body) return false;
  const ids = toolResultIdsFromBody(body);
  if (lease.toolCallIds.length > 0) return ids.length > 0 && ids.every(id => lease.toolCallIds.includes(id));
  const ref = bodyThreadTurn(body);
  if (lease.threadId && ref.threadId && lease.threadId !== ref.threadId) return false;
  if (lease.turnId && ref.turnId && lease.turnId !== ref.turnId) return false;
  return true;
}

function pruneCompletedToolContinuations(): void {
  const cutoff = Date.now() - TOOL_CONTINUATION_TTL_MS;
  for (const [key, createdAt] of completedToolContinuations) {
    if (createdAt < cutoff) completedToolContinuations.delete(key);
  }
}

function toolContinuationKey(body: Record<string, unknown>, kind: "chat" | "responses"): string | undefined {
  const values: unknown[] = [];
  if (kind === "chat") {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const item = record(message);
      if (!item) continue;
      const role = stringField(item.role);
      if (role === "tool" || role === "tool_result" || role === "toolResult") values.push({ role, id: stringField(item.tool_call_id, item.toolCallId), content: item.content });
    }
  } else {
    for (const entry of Array.isArray(body.input) ? body.input : []) {
      const item = record(entry);
      const type = stringField(item?.type);
      if (type === "function_call_output" || type === "tool_result" || type === "toolResult") values.push({ type, id: stringField(item?.call_id, item?.tool_call_id, item?.toolCallId), output: item?.output ?? item?.content });
    }
  }
  if (values.length === 0) return undefined;
  return createHash("sha256").update(JSON.stringify({ kind, values })).digest("hex");
}

const DEFAULT_CONTEXT_PACKET_MAX_CHARS = 120_000;
const MAX_CONTEXT_PACKET_MAX_CHARS = 180_000;

function contextPacketMaxChars(): number {
  const value = Number.parseInt(process.env.CHATGPT_BROWSER_API_CONTEXT_PACKET_MAX_CHARS ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CONTEXT_PACKET_MAX_CHARS;
  return Math.min(value, MAX_CONTEXT_PACKET_MAX_CHARS);
}

function isSecretContextKey(key: string): boolean {
  return /token|cookie|secret|password|passwd|api[_-]?key|authorization|credential|session|bearer|private[_-]?key/i.test(key);
}

function safeAccessParameters(body: Record<string, unknown>): Record<string, unknown> {
  const metadata = record(body.metadata) ?? {};
  const source: Record<string, unknown> = {
    cwd: body.cwd ?? metadata.cwd,
    branch: body.branch ?? metadata.branch,
    host: body.host ?? metadata.host ?? metadata.hostname,
    permission: body.permission ?? body.permissions ?? metadata.permission ?? metadata.permissions ?? metadata.sandbox_mode,
  };
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && !isSecretContextKey(key)));
}

function contextRecordText(value: unknown): string {
  const item = record(value);
  if (!item) return textFromUnknown(value).trim();
  const role = stringField(item.role, item.type) ?? "record";
  const text = textFromUnknown(item.content ?? item.output ?? item.input).trim()
    .replace(/\b(api[_-]?key|authorization|bearer|token|cookie|password|secret|private[_-]?key)\b\s*[:=]\s*[^\s,;}]+/gi, "$1=[redacted]");
  const id = stringField(item.id, item.call_id, item.tool_call_id, item.toolCallId);
  return [role, id ? `id=${id}` : "", text].filter(Boolean).join(" ");
}

function contextEntries(body: Record<string, unknown>, kind: "chat" | "responses"): unknown[] {
  return kind === "chat"
    ? (Array.isArray(body.messages) ? body.messages : [])
    : (Array.isArray(body.input) ? body.input : body.input === undefined ? [] : [body.input]);
}

function isToolContextEntry(value: unknown): boolean {
  const item = record(value);
  if (!item) return false;
  const role = stringField(item.role);
  const type = stringField(item.type);
  return role === "assistant" && (Array.isArray(item.tool_calls) || (Array.isArray(item.content) && item.content.some(part => record(part)?.type === "toolCall")))
    || role === "tool" || role === "tool_result" || role === "toolResult"
    || type === "function_call" || type === "function_call_output" || type === "tool_result" || type === "toolResult";
}

function isActiveInstructionEntry(value: unknown, kind: "chat" | "responses"): boolean {
  if (typeof value === "string") return kind === "chat";
  const item = record(value);
  if (!item || stringField(item.role) !== "user") return false;
  if (kind === "chat") return Boolean(contextRecordText(item));
  const content = Array.isArray(item.content) ? item.content : [];
  return content.some(part => {
    const contentPart = record(part);
    return stringField(contentPart?.type) === "input_text" && typeof contentPart?.text === "string" && contentPart.text.trim().length > 0;
  });
}

function needsContextPacket(body: Record<string, unknown>, kind: "chat" | "responses"): boolean {
  const entries = contextEntries(body, kind);
  return entries.length > 0 && JSON.stringify(entries).length > contextPacketMaxChars();
}

function explicitToolExecutionRequested(body: Record<string, unknown>): boolean {
  if (body.tool_choice === "required") return true;
  const text = userVisibleText(body).toLowerCase();
  return /\b(execute|executar|rode|rodar|run|use a ferramenta|use ferramenta|via exec|no terminal|comando|ls|pwd|git status|inspecione|inspecionar|verifique os arquivos|leia o arquivo|abra o arquivo)\b/.test(text);
}

function contextPacketBody(body: Record<string, unknown>, kind: "chat" | "responses"): Record<string, unknown> {
  const entries = contextEntries(body, kind);
  const maxChars = contextPacketMaxChars();
  const encodedSize = JSON.stringify(entries).length;
  if (!needsContextPacket(body, kind)) return body;
  const activeIndex = entries.reduce<number>((found, entry, index) => {
    return isActiveInstructionEntry(entry, kind) && !isToolContextEntry(entry) ? index : found;
  }, -1);
  const latestInstruction = activeIndex >= 0 ? contextRecordText(entries[activeIndex]) : "";
  let recent = entries.slice(Math.max(0, activeIndex - 3), activeIndex).filter(entry => !isToolContextEntry(entry));
  const relevantToolHistory = entries.filter(isToolContextEntry);
  const done = relevantToolHistory
    .filter(entry => {
      const item = record(entry);
      const role = stringField(item?.role);
      const type = stringField(item?.type);
      return role === "tool" || role === "tool_result" || role === "toolResult" || type === "function_call_output" || type === "tool_result" || type === "toolResult";
    })
    .map(contextRecordText);
  const remaining = latestInstruction ? [latestInstruction] : [];
  const executionPrompt = latestInstruction || recent.map(contextRecordText).filter(Boolean).join("\n");
  const packetBase = {
    schema: "markscode.chatgpt-browser.context-packet",
    version: 1,
    trust: "informational_context_only",
    done,
    remaining,
    access_parameters: safeAccessParameters(body),
    execution_prompt: executionPrompt,
    latest_instruction: latestInstruction,
    relevant_tool_history: relevantToolHistory.map(contextRecordText),
    recent_messages: recent.map(contextRecordText).filter(Boolean),
  };
  const continuation = hasToolContinuation(body);
  const packetFor = (toolHistory: string[], recentMessages: string[]) => ({ ...packetBase, relevant_tool_history: toolHistory, recent_messages: recentMessages });
  const packetTextFor = (toolHistory: string[], recentMessages: string[]) => ["<markscode_context_packet>", JSON.stringify(packetFor(toolHistory, recentMessages)), "</markscode_context_packet>"].join("\n");
  let toolHistory = packetBase.relevant_tool_history;
  let recentMessages = packetBase.recent_messages;
  if (continuation) toolHistory = [];
  let packetText = packetTextFor(toolHistory, recentMessages);
  const packetEntryFor = (text: string) => kind === "chat"
    ? { role: "user", content: text, id: stableInputItemId("context_packet", text) }
    : { id: stableInputItemId("context_packet", text), type: "message", role: "user", content: [{ type: "input_text", text }] };
  const entriesFor = (text: string, retained: unknown[]) => [packetEntryFor(text), ...retained, ...(activeIndex >= 0 ? [entries[activeIndex]] : [])];
  const bodyFor = (text: string, retained: unknown[]) => kind === "chat"
    ? { ...body, messages: entriesFor(text, retained) }
    : { ...body, input: entriesFor(text, retained) };
  const sizeFor = (text: string, retained: unknown[]) => JSON.stringify(bodyFor(text, retained)).length;
  let retained = entries.filter((entry, index) => {
    const item = record(entry);
    const role = stringField(item?.role);
    return index !== activeIndex && (role === "system" || role === "developer" || (continuation && isToolContextEntry(entry)) || (!isToolContextEntry(entry) && index >= Math.max(0, activeIndex - 3)));
  });
  while ((toolHistory.length > 0 || recentMessages.length > 0) && sizeFor(packetText, retained) > maxChars) {
    if (recentMessages.length > 0) recentMessages = recentMessages.slice(1);
    else toolHistory = toolHistory.slice(1);
    packetText = packetTextFor(toolHistory, recentMessages);
  }
  while (retained.length > 0 && sizeFor(packetText, retained) > maxChars) {
    const removableIndex = retained.findIndex(entry => !["system", "developer"].includes(stringField(record(entry)?.role) ?? "") && !(continuation && isToolContextEntry(entry)));
    if (removableIndex < 0) break;
    retained = retained.toSpliced(removableIndex, 1);
  }
  const compacted = bodyFor(packetText, retained) as Record<string, unknown>;
  if (!hasToolContinuation(body) && !explicitToolExecutionRequested(body)) {
    compacted.tools = [];
    compacted.tool_choice = "none";
  }
  const compactedSize = JSON.stringify(compacted).length;
  if (compactedSize > maxChars) throw new Error(`Context packet could not fit within ${maxChars} characters; refusing unsafe browser compaction`);
  console.info(`[chatgpt-browser-api] context packet applied originalChars=${encodedSize} packetChars=${compactedSize} originalRecords=${entries.length} retainedRecords=${retained.length + 1 + (activeIndex >= 0 ? 1 : 0)}`);
  return compacted;
}

function compactToolContinuation(body: Record<string, unknown>, kind: "chat" | "responses"): Record<string, unknown> {
  if (kind === "chat") {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    let callIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const item = record(messages[index]);
      if (item?.role === "assistant" && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
        callIndex = index;
        break;
      }
    }
    if (callIndex < 0) throw new Error("Tool continuation rejected: matching assistant tool_calls were not found");
    const resultIndexes = messages.flatMap((message, index) => {
      const item = record(message);
      const role = stringField(item?.role);
      return index > callIndex && (role === "tool" || role === "tool_result" || role === "toolResult") ? [index] : [];
    });
    if (resultIndexes.length === 0) throw new Error("Tool continuation rejected: tool results must follow assistant tool_calls");
    const resultIds = resultIndexes.map(index => stringField(record(messages[index])?.tool_call_id, record(messages[index])?.toolCallId));
    if (resultIds.some(id => !id)) throw new Error("Tool continuation rejected: every tool result must include a tool_call_id");
    const ids = resultIds as string[];
    const callIds = (record(messages[callIndex])?.tool_calls as unknown[]).flatMap(call => stringField(record(call)?.id) ? [stringField(record(call)?.id)!] : []);
    if (!ids.every(id => callIds.includes(id))) throw new Error("Tool continuation rejected: tool results do not match assistant tool_calls");
    const userIndex = messages.reduce((found, message, index) => index <= callIndex && record(message)?.role === "user" ? index : found, -1);
    if (userIndex < 0) throw new Error("Tool continuation rejected: active user message was not found");
    const retained = messages.filter((message, index) => index === userIndex || index === callIndex || resultIndexes.includes(index) || ["system", "developer"].includes(stringField(record(message)?.role) ?? ""));
    return { ...body, messages: retained };
  }
  const input = Array.isArray(body.input) ? body.input : [];
  const outputs = input.filter(entry => ["function_call_output", "tool_result", "toolResult"].includes(stringField(record(entry)?.type) ?? ""));
  const outputIds = outputs.map(entry => stringField(record(entry)?.call_id, record(entry)?.tool_call_id, record(entry)?.toolCallId));
  if (outputIds.some(id => !id)) throw new Error("Tool continuation rejected: every function output must include a call_id");
  const ids = outputIds as string[];
  const calls = input.filter(entry => {
    const item = record(entry);
    return stringField(item?.type) === "function_call" && ids.includes(stringField(item?.call_id, item?.id) ?? "");
  });
  if (calls.length !== ids.length) throw new Error("Tool continuation rejected: matching function_call items were not found");
  const userIndex = input.reduce((found, entry, index) => index < input.indexOf(calls[0]) && record(entry)?.role === "user" && stringField(record(entry)?.type) === "message" ? index : found, -1);
  if (userIndex < 0) throw new Error("Tool continuation rejected: active user message was not found");
  const retained = input.filter((entry, index) => index === userIndex || calls.includes(entry) || outputs.includes(entry) || stringField(record(entry)?.type) === "developer");
  return { ...body, input: retained };
}

function startOrRenewToolLease(calls: LocalToolCall[], body: Record<string, unknown>): void {
  clearToolLease("renewed");
  const id = browserQueueSequence;
  const now = Date.now();
  const timeoutMs = toolLeaseTimeoutMs();
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  const ref = bodyThreadTurn(body);
  toolLease = {
    id,
    threadId: ref.threadId,
    turnId: ref.turnId,
    toolCallIds: calls.map(call => call.id).filter(Boolean),
    createdAt: now,
    expiresAt: now + timeoutMs,
    timeout: setTimeout(() => expireToolLease(id), timeoutMs),
    release,
    promise,
  };
  console.info(`[chatgpt-browser-api] tool lease id=${id} created calls=${toolLease.toolCallIds.length} ttlMs=${timeoutMs}`);
}

function toolLeaseStatus(): Record<string, unknown> | undefined {
  if (!toolLease) return undefined;
  return {
    id: toolLease.id,
    pending: true,
    threadId: toolLease.threadId,
    turnId: toolLease.turnId,
    toolCallIds: toolLease.toolCallIds,
    createdAt: toolLease.createdAt,
    expiresAt: toolLease.expiresAt,
    remainingMs: Math.max(0, toolLease.expiresAt - Date.now()),
  };
}


function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function configuredWorkspaceRoot(): string | undefined {
  const cwd = stringField(process.env.CHATGPT_BROWSER_API_CWD, process.env.MARKSCODE_WORKSPACE_ROOT, process.env.OPENCODE_WORKSPACE_ROOT);
  return cwd ? resolve(expandUserPath(cwd)) : undefined;
}


function inferWorkspaceRootFromText(body: Record<string, unknown>): string | undefined {
  const texts = [userVisibleText(body), bodyText(body)].filter(Boolean);
  for (const text of texts) {
    const matches = text.matchAll(/(?:^|\s)(\/(?:[^\s`"'<>|;&]+\/?)+)/g);
    for (const match of matches) {
      const candidate = resolve(expandUserPath(match[1].replace(/[.,:)\]]+$/, "")));
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function requestWorkspaceRoot(body: Record<string, unknown>): string | undefined {
  const metadata = existingCodexMetadata(body) ?? record(body.metadata) ?? {};
  const explicit = stringField(body.cwd, metadata.cwd);
  if (explicit) {
    const root = resolve(expandUserPath(explicit));
    if (existsSync(root)) {
      rememberWorkspaceRoot(body, root);
      return root;
    }
  }
  const inferred = inferWorkspaceRootFromText(body);
  if (inferred) {
    rememberWorkspaceRoot(body, inferred);
    return inferred;
  }
  const remembered = rememberedWorkspaceRoot(body);
  if (remembered) return remembered;
  const configured = configuredWorkspaceRoot();
  return configured && existsSync(configured) ? configured : undefined;
}

function workspaceRoot(body: Record<string, unknown>): string {
  const cwd = requestWorkspaceRoot(body);
  if (!cwd) throw new Error("chatgpt-browser-api requires an explicit cwd/workspace for local context; send body.cwd, metadata.cwd, or set CHATGPT_BROWSER_API_CWD/MARKSCODE_WORKSPACE_ROOT/OPENCODE_WORKSPACE_ROOT");
  return cwd;
}

function missingWorkspaceIntent(body: Record<string, unknown>): boolean {
  if (hasToolContinuation(body)) return false;
  if (inferWorkspaceRootFromText(body)) return false;
  const text = userVisibleText(body).toLowerCase();
  return /\b(continuar|retomar|projeto|repo|reposit[oó]rio|workspace|cwd|diret[oó]rio|pasta|branch|git|status|tarefas?|tasks?|roadmap|arquivos?|c[oó]digo|implementar|corrigir|bug|feature)\b/.test(text);
}

function missingWorkspaceBody(body: Record<string, unknown>, kind: "chat" | "responses"): Record<string, unknown> | undefined {
  if (requestWorkspaceRoot(body) || !missingWorkspaceIntent(body)) return undefined;
  const prompt = "O usuário quer continuar um projeto, mas nenhum diretório/cwd foi informado pelo cliente. Não assuma o diretório do serviço nem use ferramentas. Responda em português, de forma breve, pedindo o caminho do projeto ou instruindo o cliente a enviar cwd. Cite como exemplo: /media/marcos/Arquivos/projetos/marks/ecosystem/systems/agent-os.";
  if (kind === "chat") {
    return {
      ...body,
      tool_choice: "none",
      tools: [],
      __missing_workspace_prompt: true,
      messages: [{ role: "user", content: prompt }],
    };
  }
  return {
    ...body,
    tools: [],
    __missing_workspace_prompt: true,
    input: prompt,
  };
}

function environmentContext(root: string): string {
  const escaped = xmlEscape(root);
  return `<environment_context>\n<cwd>${escaped}</cwd>\n<approval_policy>never</approval_policy>\n<sandbox_mode>read-only</sandbox_mode>\n<network_access>enabled</network_access>\n<workspace_roots>\n<root>${escaped}</root>\n</workspace_roots>\n</environment_context>`;
}

function defaultFullTools(): CodexTool[] {
  return [{
    name: "exec",
    description: "Execute a read-only shell command in the configured workspace and return stdout/stderr. Use only for inspection commands.",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "Command to run." },
        command: { type: "string", description: "Command to run." },
        timeout_ms: { type: "number", minimum: 1_000, maximum: 30_000 },
      },
      additionalProperties: true,
    },
  }];
}

function toolsFromBody(body: Record<string, unknown>, config?: ChatGptBrowserApiConfig): CodexTool[] | undefined {
  if (Array.isArray(body.tools)) {
    return body.tools.flatMap((tool): CodexTool[] => {
      const item = record(tool);
      const fn = record(item?.function);
      if (item?.type === "function" && fn) {
        const name = stringField(fn.name);
        if (!name) return [];
        return [{
          name,
          description: typeof fn.description === "string" ? fn.description : "",
          parameters: record(fn.parameters) ?? {},
          ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
        }];
      }
      return item ? [item as unknown as CodexTool] : [];
    });
  }
  return config?.mode === "full" ? defaultFullTools() : undefined;
}

function responsesContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.flatMap(part => {
    if (typeof part === "string") return [{ type: "input_text", text: part }];
    const item = record(part);
    if (!item) return [];
    if (typeof item.text === "string") return [{ type: "input_text", text: item.text }];
    if (typeof item.input_text === "string") return [{ type: "input_text", text: item.input_text }];
    return [part];
  });
  return [{ type: "input_text", text: textFromUnknown(value) }];
}

function environmentInputItem(body: Record<string, unknown>, turnId: string): Record<string, unknown> {
  return {
    id: `env_${syntheticId("ctx")}`,
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: environmentContext(workspaceRoot(body)) }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function inputWithEnvironmentBeforeActiveUser(input: unknown[], body: Record<string, unknown>, turnId: string): unknown[] {
  const env = environmentInputItem(body, turnId);
  const filtered = input.filter(item => {
    const value = record(item);
    return !(value?.type === "message" && /<\/?environment_context/i.test(textFromUnknown(value.content)));
  });
  for (let index = filtered.length - 1; index >= 0; index -= 1) {
    const item = record(filtered[index]);
    if (item?.type === "message" && item.role === "user") return [...filtered.slice(0, index), env, ...filtered.slice(index)];
  }
  return [env, ...filtered];
}

function inputMessageFromChatMessage(item: Record<string, unknown>, index: number, turnId: string): Record<string, unknown>[] {
  const rawRole = item.role;
  const role = rawRole === "system" || rawRole === "developer" ? rawRole : rawRole === "assistant" ? "assistant" : rawRole === "tool" || rawRole === "tool_result" || rawRole === "toolResult" ? rawRole : "user";
  const id = stringField(item.id) ?? stableInputItemId(`msg_${index}_${role}`, { role: rawRole ?? "user", content: item.content, tool_calls: item.tool_calls, tool_call_id: item.tool_call_id ?? item.toolCallId });
  if (rawRole === "assistant") {
    const content: unknown[] = Array.isArray(item.content)
      ? item.content.flatMap(part => {
        const value = record(part);
        if (value?.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string") return [{ type: "toolCall", id: value.id, name: value.name, arguments: record(value.arguments) ?? {} }];
        return responsesContent(part);
      })
      : [responsesContent(item.content)].flat();
    const toolCalls = Array.isArray(item.tool_calls)
      ? item.tool_calls.flatMap(toolCall => {
        const call = record(toolCall);
        const fn = record(call?.function);
        const callId = stringField(call?.id);
        const name = stringField(fn?.name);
        if (!callId || !name) return [];
        return [{ type: "toolCall", id: callId, name, arguments: parseToolArguments(typeof fn?.arguments === "string" ? fn.arguments : "{}") }];
      })
      : [];
    return [{ id, type: "message", role: "assistant", content: [...content, ...toolCalls] }];
  }
  if (rawRole === "tool" || rawRole === "tool_result" || rawRole === "toolResult") return [{
    id,
    type: "toolResult",
    toolCallId: stringField(item.tool_call_id, item.toolCallId) ?? "",
    toolName: stringField(item.name, item.toolName) ?? "exec",
    content: item.content,
    isError: item.is_error === true || item.isError === true,
    ...(typeof item.timestamp === "number" ? { timestamp: item.timestamp } : {}),
  }];
  return [{
    id,
    type: "message",
    role,
    content: responsesContent(item.content),
    ...(role === "user" ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
  }];
}

function inputFromChatMessages(body: Record<string, unknown>, turnId: string, config: ChatGptBrowserApiConfig): unknown[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = messages.flatMap((message, index) => {
    const item = record(message);
    if (!item) return [];
    return inputMessageFromChatMessage(item, index, turnId);
  });
  return config.mode === "full" ? inputWithEnvironmentBeforeActiveUser(input, body, turnId) : input;
}

function requestMetadata(body: Record<string, unknown>): Record<string, unknown> {
  const metadata = existingCodexMetadata(body) ?? record(body.metadata) ?? {};
  const remembered = rememberedToolTurn(body);
  const threadId = stringField(body.thread_id, metadata.thread_id, metadata.threadId, remembered?.threadId) ?? syntheticId("thread");
  const turnId = stringField(body.turn_id, metadata.turn_id, metadata.turnId, remembered?.turnId) ?? syntheticId("turn");
  const root = workspaceRoot(body);
  return {
    ...metadata,
    thread_id: threadId,
    turn_id: turnId,
    cwd: root,
    agent_name: stringField(metadata.agent_name, metadata.agentName) ?? "chatgpt-browser-api",
    sandbox: typeof metadata.sandbox === "string" ? metadata.sandbox : "read-only",
    sandbox_mode: typeof metadata.sandbox_mode === "string" ? metadata.sandbox_mode : "read-only",
    workspaces: record(metadata.workspaces) ?? { [root]: { writable: false } },
  };
}

function ensureRequestMetadata(body: Record<string, unknown>): Record<string, unknown> {
  const metadata = requestMetadata(body);
  return {
    ...body,
    client_metadata: {
      ...(record(body.client_metadata) ?? {}),
      "x-codex-turn-metadata": JSON.stringify(metadata),
    },
  };
}

function rememberToolTurn(calls: LocalToolCall[], body: Record<string, unknown>): void {
  const metadata = existingCodexMetadata(body);
  const threadId = stringField(metadata?.thread_id, metadata?.threadId);
  const turnId = stringField(metadata?.turn_id, metadata?.turnId);
  if (!threadId || !turnId) return;
  const ref = { threadId, turnId, createdAt: Date.now() };
  for (const call of calls) toolTurnRefs.set(call.id, ref);
  pruneToolTurnRefs();
}

function rawBodyForAdapter(body: Record<string, unknown>, kind: "chat" | "responses", config: ChatGptBrowserApiConfig): Record<string, unknown> {
  const metadata = config.mode === "full" ? requestMetadata(body) : { turn_id: syntheticId("turn") };
  let input = kind === "chat" && !Array.isArray(body.input) ? inputFromChatMessages(body, metadata.turn_id as string, config) : body.input;
  if (kind === "responses" && !Array.isArray(input)) {
    const bodyInput = body.input;
    const text = typeof bodyInput === "string" ? bodyInput : bodyText(body) || textFromUnknown(bodyInput);
    const id = stableInputItemId("msg_user", { input: bodyInput, text });
    input = typeof body.input === "string"
      ? [{ id, type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
      : [{ id, type: "message", role: "user", content: [{ type: "input_text", text }] }];
  }
  if (config.mode !== "full") {
    return {
      ...body,
      ...(Array.isArray(input) ? { input } : {}),
      client_metadata: {
        ...(record(body.client_metadata) ?? {}),
        "x-codex-turn-metadata": JSON.stringify(metadata),
      },
    };
  }
  if (kind === "responses" && Array.isArray(input)) {
    input = inputWithEnvironmentBeforeActiveUser(input, body, metadata.turn_id as string);
  }
  const root = workspaceRoot(body);
  return {
    ...body,
    cwd: root,
    metadata: {
      ...(record(body.metadata) ?? {}),
      cwd: root,
      sandbox_mode: "read-only",
      workspaces: record(record(body.metadata)?.workspaces) ?? { [root]: { writable: false } },
    },
    ...(Array.isArray(input) ? { input } : {}),
    client_metadata: {
      ...(record(body.client_metadata) ?? {}),
      "x-codex-turn-metadata": JSON.stringify(metadata),
    },
  };
}

function bodyText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const messageText = messages.map(message => {
    const item = record(message);
    if (!item) return "";
    return textFromUnknown(item.content);
  }).join("\n");
  const inputText = body.input !== undefined ? textFromUnknown(body.input) : "";
  return [messageText, inputText].filter(Boolean).join("\n");
}

function userVisibleText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const item = record(messages[index]);
    if (!item) continue;
    if (item.role === "user") return textFromUnknown(item.content);
  }
  return body.input !== undefined ? textFromUnknown(body.input) : bodyText(body);
}

function inferredToolChoice(body: Record<string, unknown>, config: ChatGptBrowserApiConfig): unknown {
  if (body.tool_choice !== undefined) return body.tool_choice;
  if (config.mode !== "full") return undefined;
  if (localToolTaskRequested(body, config)) return "required";
  const text = bodyText(body).toLowerCase();
  if (/\b(m[aá]quina|recursos|cpu|mem[oó]ria|ram|disco|gpu|sistema|processos|terminal|comando|execute|verifique)\b/.test(text)) return "required";
  return "auto";
}

function hasToolContinuation(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.some(message => {
    const item = record(message);
    if (!item) return false;
    const role = typeof item.role === "string" ? item.role : undefined;
    if (role === "tool" || role === "tool_result" || role === "toolResult") return true;
    if (role !== "assistant") return false;
    if (item.tool_calls !== undefined) return true;
    const content = Array.isArray(item.content) ? item.content : [];
    return content.some(part => {
      const contentPart = record(part);
      return contentPart?.type === "toolCall";
    });
  })) return true;
  const input = Array.isArray(body.input) ? body.input : [];
  return input.some(entry => {
    const item = record(entry);
    if (!item) return false;
    const type = stringField(item.type);
    return type === "function_call_output" || type === "tool_result" || type === "toolResult" || item.output !== undefined;
  });
}

function localInspectionRequested(body: Record<string, unknown>, config: ChatGptBrowserApiConfig): boolean {
  if (hasToolContinuation(body)) return false;
  if (clientToolMode(body, config)) return false;
  if (body.tool_choice !== undefined || config.mode !== "full") return false;
  const text = bodyText(body).toLowerCase();
  return /\b(m[aá]quina|recursos|cpu|mem[oó]ria|ram|disco|gpu|sistema|processos)\b/.test(text);
}


function normalizeWorkspacePathOnlyBody(body: Record<string, unknown>, config: ChatGptBrowserApiConfig): Record<string, unknown> {
  if (config.mode !== "full" || hasToolContinuation(body)) return body;
  if (body.cwd !== undefined || body.tool_choice !== undefined) return body;
  const root = inferWorkspaceRootFromText(body);
  if (!root) return body;
  const text = userVisibleText(body).trim();
  if (text !== root) return body;
  const prompt = `O diretório do projeto é ${root}. Use a ferramenta exec para executar uma inspeção inicial segura neste cwd: pwd, git status --short --branch, ls -la, e liste .tasks/ ou roadmap/ se existirem. Depois resuma objetivamente o estado do projeto e próximos passos.`;
  return {
    ...body,
    cwd: root,
    tool_choice: "required",
    input: prompt,
    messages: [{
      role: "user",
      content: prompt,
    }],
  };
}

function normalizeLocalInspectionBody(body: Record<string, unknown>, config: ChatGptBrowserApiConfig): Record<string, unknown> {
  if (hasToolContinuation(body)) return body;
  if (!localInspectionRequested(body, config)) return body;
  return {
    ...body,
    tool_choice: "required",
    messages: [{
      role: "user",
      content: "Use a ferramenta exec para executar exatamente estes comandos em chamadas separadas: nproc, free -h, df -h /. Depois responda em português com apenas 3 linhas: CPU, Memória, Disco.",
    }],
  };
}

function adapterModelId(body: Record<string, unknown>, config: ChatGptBrowserApiConfig): string {
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : config.model;
  if (model === CHATGPT_WEB_LUNA_BACKEND_MODEL || model === "luna") return CHATGPT_WEB_LUNA_BACKEND_MODEL;
  return CHATGPT_WEB_BACKEND_MODEL;
}

function reasoningEffort(body: Record<string, unknown>): string | undefined {
  const reasoning = record(body.reasoning);
  const effort = typeof reasoning?.effort === "string" ? reasoning.effort : typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
  if (!effort) return undefined;
  return effort === "ultra" ? "max" : effort;
}

function parsedRequest(body: Record<string, unknown>, config: ChatGptBrowserApiConfig, kind: "chat" | "responses"): CodexParsedRequest {
  const model = adapterModelId(body, config);
  const transportBody = contextPacketBody(body, kind);
  const rawBody = rawBodyForAdapter(transportBody, kind, config);
  const reasoning = reasoningEffort(body);
  return {
    modelId: model,
    previousResponseId: typeof body.previous_response_id === "string" ? body.previous_response_id : undefined,
    context: {
      messages: [
        ...(config.mode === "full" ? [{ role: "developer" as const, content: environmentContext(workspaceRoot(transportBody)), timestamp: Date.now() }] : []),
        ...(kind === "chat" ? messagesFromChat(transportBody) : messagesFromResponses(transportBody)),
      ],
      tools: toolsFromBody(transportBody, config),
    },
    stream: false,
    options: {
      maxOutputTokens: typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
      toolChoice: inferredToolChoice(body, config) as never,
      parallelToolCalls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      topP: typeof body.top_p === "number" ? body.top_p : undefined,
      reasoning,
    },
    _rawBody: rawBody,
  };
}

function textFromOutputItems(output: unknown[], finalOnly: boolean): string {
  let text = "";
  for (const item of output) {
    const outputItem = record(item);
    if (!outputItem) continue;
    if (finalOnly && outputItem.phase !== "final_answer") continue;
    const content = Array.isArray(outputItem.content) ? outputItem.content : [];
    for (const part of content) {
      const contentPart = record(part);
      if (typeof contentPart?.text === "string") text += contentPart.text;
    }
  }
  return text;
}

function outputText(response: Record<string, unknown>): string {
  const output = Array.isArray(response.output) ? response.output : [];
  return textFromOutputItems(output, true) || textFromOutputItems(output, false);
}

function normalizeResponseForClient(response: Record<string, unknown>): Record<string, unknown> {
  const cleanText = response.__missing_workspace_prompt === true || response.__suppress_local_tools_warning === true
    ? stripLocalToolsUnavailableWarning(outputText(response))
    : outputText(response);
  if (!cleanText) return response;
  return {
    ...response,
    output_text: cleanText,
  };
}

function localToolTaskRequested(body: Record<string, unknown>, config?: ChatGptBrowserApiConfig): boolean {
  if (config?.mode !== "full") return false;
  if (hasToolContinuation(body)) return false;
  if (inferWorkspaceRootFromText(body)) return true;
  const text = bodyText(body).toLowerCase();
  return /\b(sda|nvme|parti[cç][aã]o|mount|montado|df|du|lsblk|limpar|limpeza|espa[cç]o|ocupado|armazenamento|disco|m[aá]quina|recursos|cpu|mem[oó]ria|ram|sistema|processos|terminal|comando|execute|verifique|continuar|projeto)\b/.test(text);
}

function clientToolMode(body: Record<string, unknown>, config?: ChatGptBrowserApiConfig): boolean {
  if (body.tool_execution === "client" || process.env.CHATGPT_BROWSER_API_CLIENT_TOOLS === "1") return true;
  if (localToolTaskRequested(body, config)) return true;
  const model = stringField(body.model);
  return !!model && MARKSCODE_BROWSER_MODELS.includes(model as typeof MARKSCODE_BROWSER_MODELS[number])
    && Array.isArray(body.tools) && body.tools.length > 0;
}

function chatToolCallsFromEvents(events: AdapterEvent[]): Record<string, unknown>[] {
  return collectToolCalls(events).map(call => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.argumentsText || "{}" },
  }));
}

function estimatedTokens(value: unknown): number {
  const text = typeof value === "string" ? value : textFromUnknown(value);
  const normalized = text.trim();
  if (!normalized) return 0;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(Math.max(normalized.length / 4, wordCount * 1.35)));
}

function usageFor(input: unknown, output: unknown): Record<string, number> {
  const inputTokens = estimatedTokens(input);
  const outputTokens = estimatedTokens(output);
  const totalTokens = inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
  };
}

function responseUsage(response: Record<string, unknown>, fallbackInput: unknown = ""): Record<string, number> {
  const usage = record(response.usage);
  const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const total = typeof usage?.total_tokens === "number" ? usage.total_tokens : undefined;
  if (input !== undefined || output !== undefined || total !== undefined) {
    const inputTokens = input ?? Math.max(0, (total ?? 0) - (output ?? 0));
    const outputTokens = output ?? Math.max(0, (total ?? 0) - inputTokens);
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: total ?? inputTokens + outputTokens,
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
    };
  }
  return usageFor(fallbackInput, outputText(response));
}

function responseWithClientToolCalls(events: AdapterEvent[], model: string): Record<string, unknown> {
  const toolCalls = chatToolCallsFromEvents(events);
  return {
    id: `resp_${randomBytes(16).toString("hex")}`,
    object: "response",
    status: "requires_action",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: [{
      type: "message",
      role: "assistant",
      content: [],
      tool_calls: toolCalls,
    }],
    required_action: {
      type: "submit_tool_outputs",
      submit_tool_outputs: { tool_calls: toolCalls },
    },
    usage: usageFor("", JSON.stringify(toolCalls)),
  };
}


function stripLocalToolsUnavailableWarning(text: string): string {
  if (!text.includes("Local tools unavailable")) return text;
  const actionIndex = text.indexOf("> **Action:**");
  if (actionIndex >= 0) {
    const afterAction = text.indexOf("\n", actionIndex + 1);
    if (afterAction >= 0) {
      const remainder = text.slice(afterAction + 1).replace(/^>.*(?:\n|$)/gm, "").trimStart();
      if (remainder) return remainder;
    }
  }
  const markers = ["Opa", "Oi", "Olá", "Claro.", "Me envie", "Preciso", "Para continuar"];
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index > 0) return text.slice(index).trimStart();
  }
  return text.replace(/^>.*(?:\n|$)/gm, "").trimStart();
}

function chatCompletionFromResponse(response: Record<string, unknown>, model: string): Record<string, unknown> {
  if (response.status === "requires_action") {
    const output = Array.isArray(response.output) ? response.output : [];
    const message = output.map(record).find(item => Array.isArray(item?.tool_calls));
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    return {
      id: typeof response.id === "string" ? response.id : `chatcmpl_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }],
      usage: responseUsage(response, JSON.stringify(toolCalls)),
    };
  }
  const content = response.__missing_workspace_prompt === true || response.__suppress_local_tools_warning === true ? stripLocalToolsUnavailableWarning(outputText(response)) : outputText(response);
  return {
    id: typeof response.id === "string" ? response.id : `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: response.status === "completed" ? "stop" : "length" }],
    usage: responseUsage(response, content),
  };
}

function chatCompletionStreamResponse(completion: Record<string, unknown>, model: string): Response {
  const id = stringField(completion.id) ?? `chatcmpl_${Date.now()}`;
  const created = typeof completion.created === "number" ? completion.created : Math.floor(Date.now() / 1000);
  const choice = record(Array.isArray(completion.choices) ? completion.choices[0] : undefined) ?? {};
  const message = record(choice.message) ?? {};
  const finishReason = stringField(choice.finish_reason) ?? "stop";
  const chunks: Record<string, unknown>[] = [];
  const push = (delta: Record<string, unknown>, finish: string | null) => chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  push({ role: "assistant" }, null);
  if (typeof message.content === "string" && message.content.length > 0) push({ content: message.content }, null);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  toolCalls.forEach((toolCall, index) => {
    const call = record(toolCall) ?? {};
    const fn = record(call.function) ?? {};
    push({
      tool_calls: [{
        index,
        id: stringField(call.id) ?? syntheticId("call"),
        type: "function",
        function: {
          name: stringField(fn.name) ?? "tool",
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        },
      }],
    }, null);
  });
  push({}, finishReason);
  chunks[chunks.length - 1]!.usage = responseUsage(completion);
  const payload = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(payload, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

type LocalToolCall = { id: string; name: string; argumentsText: string };

function collectToolCalls(events: AdapterEvent[]): LocalToolCall[] {
  const calls: LocalToolCall[] = [];
  let current: LocalToolCall | undefined;
  for (const event of events) {
    if (event.type === "tool_call_start") {
      current = { id: event.id, name: event.name, argumentsText: "" };
      calls.push(current);
    } else if (event.type === "tool_call_delta" && current) {
      current.argumentsText += event.arguments;
    } else if (event.type === "tool_call_end") {
      current = undefined;
    }
  }
  return calls;
}

function parseToolArguments(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || "{}");
    return record(parsed) ?? {};
  } catch {
    return { cmd: text };
  }
}

function isReadOnlyCommand(command: string): boolean {
  const value = command.trim();
  if (!value) return false;
  if (/[;&|`$<>]/.test(value)) return false;
  const first = value.split(/\s+/)[0] ?? "";
  return new Set(["pwd", "ls", "df", "free", "uptime", "nproc", "uname", "lscpu", "cat", "du", "id", "whoami", "date", "stat", "ps"]).has(first);
}

async function executeLocalTool(call: LocalToolCall, body: Record<string, unknown>): Promise<CodexToolResultMessage> {
  const args = parseToolArguments(call.argumentsText);
  const command = stringField(args.cmd, args.command, args.input);
  if (call.name !== "exec" || !command || !isReadOnlyCommand(command)) {
    return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: `Tool ${call.name} blocked or unsupported by chatgpt-browser-api read-only executor.`, isError: true, timestamp: Date.now() };
  }
  const proc = Bun.spawn(["bash", "-lc", command], { cwd: workspaceRoot(body), stdout: "pipe", stderr: "pipe" });
  const timeout = Math.min(Math.max(Number(args.timeout_ms) || 10_000, 1_000), 30_000);
  const timed = new Promise<{ timedOut: true }>(resolveTimeout => setTimeout(() => resolveTimeout({ timedOut: true }), timeout));
  const completed = proc.exited.then(async code => ({ code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() }));
  const result = await Promise.race([completed, timed]);
  if ("timedOut" in result) {
    proc.kill();
    return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: `Command timed out after ${timeout}ms: ${command}`, isError: true, timestamp: Date.now() };
  }
  const output = [`$ ${command}`, `exit=${result.code}`, result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: output.slice(0, 20_000), isError: result.code !== 0, timestamp: Date.now() };
}

function appendToolRound(body: Record<string, unknown>, events: AdapterEvent[], results: CodexToolResultMessage[]): Record<string, unknown> {
  const calls = collectToolCalls(events).map(call => ({ role: "assistant", content: [{ type: "toolCall", id: call.id, name: call.name, arguments: parseToolArguments(call.argumentsText) }] }));
  const toolResults = results.map(result => ({ role: "tool_result", tool_call_id: result.toolCallId, name: result.toolName, content: result.content }));
  const { tool_choice: _toolChoice, ...rest } = body;
  return { ...rest, messages: [...(Array.isArray(body.messages) ? body.messages : []), ...calls, ...toolResults] };
}

async function commandOutput(command: string, cwd: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe" });
  const timeoutMs = 10_000;
  const timed = new Promise<{ timedOut: true }>(resolveTimeout => setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs));
  const completed = proc.exited.then(async code => ({ code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() }));
  const result = await Promise.race([completed, timed]);
  if ("timedOut" in result) {
    proc.kill();
    return `timeout after ${timeoutMs}ms`;
  }
  return (result.stdout || result.stderr).trim();
}

function firstLine(value: string): string {
  return value.split("\n").map(line => line.trim()).find(Boolean) || "indisponível";
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  const formatted = size >= 10 || unit === 0 ? Math.round(size).toString() : size.toFixed(1).replace(".", ",");
  return `${formatted} ${units[unit]}`;
}

async function localInspectionResponse(body: Record<string, unknown>, config: ChatGptBrowserApiConfig): Promise<Record<string, unknown>> {
  const cwd = workspaceRoot(body);
  const [cpu, memory, disk] = await Promise.all([
    commandOutput("nproc", cwd),
    commandOutput("LC_ALL=C free -b", cwd),
    commandOutput("LC_ALL=C df -B1 /", cwd),
  ]);
  const memLine = memory.split("\n").find(line => /^Mem:/i.test(line.trim())) || firstLine(memory);
  const diskLine = disk.split("\n").find(line => /\/$/.test(line.trim())) || firstLine(disk);
  const memParts = memLine.trim().split(/\s+/).map(part => Number(part));
  const diskParts = diskLine.trim().split(/\s+/);
  const diskTotal = Number(diskParts[1]);
  const diskUsed = Number(diskParts[2]);
  const diskAvail = Number(diskParts[3]);
  const text = [
    `CPU: ${firstLine(cpu)} núcleos`,
    Number.isFinite(memParts[1]) && Number.isFinite(memParts[2]) && Number.isFinite(memParts[6]) ? `Memória: ${formatBytes(memParts[1])} total, ${formatBytes(memParts[2])} usada, ${formatBytes(memParts[6])} disponível` : `Memória: ${memLine.trim()}`,
    Number.isFinite(diskTotal) && Number.isFinite(diskUsed) && Number.isFinite(diskAvail) ? `Disco: ${formatBytes(diskTotal)} total, ${formatBytes(diskUsed)} usado, ${formatBytes(diskAvail)} disponível (${diskParts[4]})` : `Disco: ${diskLine.trim()}`,
  ].join("\n");
  return {
    id: `resp_${randomBytes(16).toString("hex")}`,
    object: "response",
    status: "completed",
    created_at: Math.floor(Date.now() / 1000),
    model: adapterModelId(body, config),
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: usageFor(body, text),
  };
}


function pathOnlyWorkspaceRoot(body: Record<string, unknown>): string | undefined {
  if (hasToolContinuation(body)) return undefined;
  const visible = userVisibleText(body).trim();
  const match = visible.match(/^(\/(?:[^\s`"'<>|;&]+\/?)+)/);
  if (!match) return undefined;
  const candidate = resolve(expandUserPath(match[1].replace(/[.,:)\]]+$/, "")));
  return existsSync(candidate) ? candidate : undefined;
}

function directWorkspaceInspectionToolCall(body: Record<string, unknown>, config: ChatGptBrowserApiConfig): Record<string, unknown> | undefined {
  const root = pathOnlyWorkspaceRoot(body);
  if (config.mode !== "full") return undefined;
  if (!root) return undefined;
  const command = `cd ${JSON.stringify(root).slice(1, -1)} && pwd && printf '\n--- git status --short --branch ---\n' && git status --short --branch && printf '\n--- ls -la ---\n' && ls -la && printf '\n--- .tasks/ ou roadmap/ ---\n' && if [ -d .tasks ]; then echo '[.tasks]'; find .tasks -maxdepth 2 -mindepth 1 -print | sort; fi && if [ -d roadmap ]; then echo '[roadmap]'; find roadmap -maxdepth 2 -mindepth 1 -print | sort; fi && if [ ! -d .tasks ] && [ ! -d roadmap ]; then echo 'Nenhum diretório .tasks/ ou roadmap/ encontrado.'; fi`;
  const toolCalls = [{
    id: stableInputItemId("call_bash", { root, command }),
    type: "function",
    function: { name: "bash", arguments: JSON.stringify({ command, timeout: 30000, workdir: root, description: "Inspect workspace status" }) },
  }];
  return {
    id: `resp_${randomBytes(16).toString("hex")}`,
    object: "response",
    status: "requires_action",
    created_at: Math.floor(Date.now() / 1000),
    model: adapterModelId(body, config),
    output: [{ type: "message", role: "assistant", content: [], tool_calls: toolCalls }],
    required_action: { type: "submit_tool_outputs", submit_tool_outputs: { tool_calls: toolCalls } },
    usage: usageFor(body, JSON.stringify(toolCalls)),
  };
}

function directWorkspaceInspectionResult(body: Record<string, unknown>, config: ChatGptBrowserApiConfig): Record<string, unknown> | undefined {
  const results: string[] = [];
  let matched = false;
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const item = record(message);
    if (!item) continue;
    const role = item.role;
    if (role !== "tool" && role !== "tool_result" && role !== "toolResult") continue;
    const callId = stringField(item.tool_call_id, item.toolCallId);
    if (!(callId?.startsWith("call_exec_") || callId?.startsWith("call_bash_"))) continue;
    matched = true;
    const content = textFromUnknown(item.content).trim();
    if (content) results.push(content);
  }
  const input = Array.isArray(body.input) ? body.input : [];
  for (const entry of input) {
    const item = record(entry);
    if (!item) continue;
    const callId = stringField(item.call_id, item.tool_call_id, item.toolCallId, item.id);
    const type = stringField(item.type);
    if (callId && !callId.startsWith("call_exec_") && !callId.startsWith("call_bash_")) continue;
    if (!callId && type !== "function_call_output" && type !== "tool_result" && type !== "toolResult") continue;
    matched = true;
    const content = textFromUnknown(item.output ?? item.content).trim();
    if (content) results.push(content);
  }
  if (!matched) return undefined;
  const raw = results.join("\n\n").trim();
  const text = raw
    ? `Inspeção inicial executada com sucesso.\n\n${raw.slice(0, 12000)}`
    : "Inspeção inicial executada, mas a ferramenta não retornou conteúdo.";
  return {
    id: `resp_${randomBytes(16).toString("hex")}`,
    object: "response",
    status: "completed",
    created_at: Math.floor(Date.now() / 1000),
    model: adapterModelId(body, config),
    output_text: text,
    output: [{ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] }],
    usage: usageFor(body, text),
  };
}

async function runAdapter(body: Record<string, unknown>, config: ChatGptBrowserApiConfig, kind: "chat" | "responses", signal?: AbortSignal): Promise<Record<string, unknown>> {
  const directToolResult = directWorkspaceInspectionResult(body, config);
  if (directToolResult) return directToolResult;
  const directToolCall = directWorkspaceInspectionToolCall(body, config);
  if (directToolCall) return directToolCall;
  const missingWorkspace = missingWorkspaceBody(body, kind);
  if (missingWorkspace) {
    body = missingWorkspace;
    config = { ...config, mode: "browser-only" };
  } else if (!requestWorkspaceRoot(body) && !hasToolContinuation(body)) {
    body = { ...body, __suppress_local_tools_warning: true };
    config = { ...config, mode: "browser-only" };
  } else {
    body = normalizeWorkspacePathOnlyBody(body, config);
    body = ensureRequestMetadata(body);
  }
  if (kind === "chat" && localInspectionRequested(body, config) && process.env.CHATGPT_BROWSER_API_FAST_LOCAL_INSPECTION !== "0") return localInspectionResponse(body, config);
  const toolContinuation = hasToolContinuation(body);
  let continuationKey: string | undefined;
  if (toolContinuation) {
    continuationKey = toolContinuationKey(body, kind);
    if (!continuationKey) throw new Error("Tool continuation rejected: no tool result identity was provided");
    pruneCompletedToolContinuations();
    if (completedToolContinuations.has(continuationKey)) throw new Error("Tool continuation already processed; refusing to open another ChatGPT browser turn");
    body = contextPacketBody(compactToolContinuation(body, kind), kind);
    if (toolLease && !toolLeaseMatchesBody(toolLease, body)) throw new Error("Tool continuation rejected: tool results do not match the active tool lease");
  }
  return enqueueBrowserTurn(kind, signal, async () => {
    const continuationLeaseId = toolContinuation && toolLease && toolLeaseMatchesBody(toolLease, body) ? toolLease.id : undefined;
    try {
      body = normalizeLocalInspectionBody(body, config);
      const provider = providerConfig(config);
      const remoteBroker = remoteBrokerForConfig(config);
      if (remoteBroker) await remoteBroker.assertCompatible();
      const adapter = createChatGptWebAdapter(provider, remoteBroker ? { broker: remoteBroker } : undefined);
      let workingBody = body;
      let lastEvents: AdapterEvent[] = [];
      for (let round = 0; round < 4; round++) {
        const parsed = parsedRequest(workingBody, config, kind);
        const events: AdapterEvent[] = [];
        await adapter.runTurn(parsed, { headers: new Headers(), abortSignal: signal }, event => events.push(event));
        lastEvents = events;
        const calls = collectToolCalls(events);
        if (calls.length === 0) {
          const response = buildResponseJSON(events, parsed.modelId);
          if (continuationKey) completedToolContinuations.set(continuationKey, Date.now());
          if (workingBody.__missing_workspace_prompt === true) response.__missing_workspace_prompt = true;
          if (workingBody.__suppress_local_tools_warning === true) response.__suppress_local_tools_warning = true;
          return normalizeResponseForClient(response);
        }
        if (kind === "chat" && clientToolMode(workingBody, config)) {
          rememberToolTurn(calls, workingBody);
          startOrRenewToolLease(calls, workingBody);
          return responseWithClientToolCalls(events, parsed.modelId);
        }
        const results = await Promise.all(calls.map(call => executeLocalTool(call, workingBody)));
        workingBody = appendToolRound(workingBody, events, results);
      }
      throw new Error("ChatGPT browser tool continuation exceeded the maximum of 4 tool rounds");
    } catch (error) {
      if (continuationKey) completedToolContinuations.delete(continuationKey);
      if (toolContinuation) console.error(`[chatgpt-browser-api] tool continuation failed before completion lease=${continuationLeaseId ?? "none"}:`, error);
      throw error;
    } finally {
      if (continuationLeaseId && toolLease?.id === continuationLeaseId) clearToolLease("continuation-completed");
    }
  }, { toolContinuation, body });
}

async function serve(config = loadConfig()): Promise<void> {
  mkdirSync(join(homeDir(), "runtime"), { recursive: true, mode: 0o700 });
  const remoteBroker = remoteBrokerForConfig(config);
  if (!remoteBroker && config.mode === "full" && config.brokerSocketPath) {
    await TurnBroker.forSocket(config.brokerSocketPath).listen();
  }
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, product: "chatgpt-browser-api", version: VERSION });
        if (!isAuthorized(request, config)) return unauthorized();
        if (request.method === "GET" && url.pathname === "/v1/models") return json({ object: "list", data: config.models.map(id => ({ id, object: "model", owned_by: "chatgpt-browser-api" })) });
        if (request.method === "GET" && url.pathname === "/v1/harness/status") return json({
          mode: config.mode || "browser-only",
          localToolsEnabled: config.mode === "full",
          autoApproveToolCalls: config.autoApproveToolCalls === true,
          brokerSocketPath: config.brokerSocketPath,
          browserHost: config.browserHost,
          browserHostDescriptorPath: config.browserHostDescriptorPath,
          queue: { active: browserQueueActive, depth: browserQueueDepth, sequence: browserQueueSequence, toolLease: toolLeaseStatus() },
        });
        if (request.method === "POST" && url.pathname === "/v1/responses") return json(await runAdapter(await readBody(request), config, "responses", request.signal));
        if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
          const body = await readBody(request);
          const response = await runAdapter(body, config, "chat", request.signal);
          const model = typeof body.model === "string" ? body.model : config.model;
          const completion = chatCompletionFromResponse(response, model);
          return body.stream === true ? chatCompletionStreamResponse(completion, model) : json(completion);
        }
        return json({ error: { type: "not_found", message: "Not found" } }, 404);
      } catch (error) {
        return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
      }
    },
  });
  process.stdout.write(`chatgpt-browser-api listening on http://${server.hostname}:${server.port}\n`);
  const shutdown = async () => {
    server.stop(true);
    await closeChatGptBrowserWorkers();
    await closeTurnBrokers();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function run(): Promise<void> {
  const resolved = applyActiveAppConfig(loadOrInitConfig());
  await serve(resolved.config);
}

function status(): void {
  const path = configPath();
  const standalone = existsSync(path) ? loadConfig() : defaultConfig();
  const active = applyActiveAppConfig(standalone);
  process.stdout.write(JSON.stringify({
    home: homeDir(),
    config: path,
    exists: existsSync(path),
    host: standalone.host,
    port: standalone.port,
    models: standalone.models,
    browserHost: standalone.browserHost,
    browserHostDescriptorPath: standalone.browserHostDescriptorPath,
    storageStatePath: standalone.storageStatePath,
    effectiveMode: active.config.mode,
    localToolsEnabled: active.config.mode === "full",
    autoApproveToolCalls: active.config.autoApproveToolCalls === true,
    brokerSocketPath: active.config.brokerSocketPath,
    effectiveBrowserHost: active.config.browserHost,
    effectiveBrowserHostDescriptorPath: active.config.browserHostDescriptorPath,
    effectiveStorageStatePath: active.config.storageStatePath,
    codexHome: active.info.codexHome,
    codexConfig: active.info.codexConfigPath,
    codexConfigFound: active.info.codexConfigFound,
    launcherDescriptor: active.info.launcherDescriptorPath,
    launcherDescriptorFound: active.info.launcherDescriptorFound,
    codexStorageStatePath: active.info.codexStorageStatePath,
    codexStorageStateFound: active.info.codexStorageStateFound,
  }, null, 2) + "\n");
}

async function main(): Promise<void> {
  const command = process.argv[2] || "serve";
  if (command === "init") {
    process.stdout.write(`${writeDefaultConfig()}\n`);
    return;
  }
  if (command === "doctor" || command === "status") {
    status();
    return;
  }
  if (command === "api-key") {
    const subcommand = process.argv[3] || "get";
    if (subcommand === "get") {
      process.stdout.write(`${configuredApiKey()}
`);
      return;
    }
    if (subcommand === "set") {
      process.stdout.write(`${setConfiguredApiKey(process.argv[4])}\n`);
      return;
    }
    if (subcommand === "rotate") {
      process.stdout.write(`${setConfiguredApiKey()}\n`);
      return;
    }
    process.stderr.write("Usage: chatgpt-browser-api api-key <get|set|rotate> [value]\n");
    process.exit(2);
  }
  if (command === "serve") {
    await serve();
    return;
  }
  if (command === "run") {
    await run();
    return;
  }
  process.stderr.write("Usage: chatgpt-browser-api <run|serve|init|doctor|status|api-key>\n");
  process.exit(2);
}

main().catch(error => {
  process.stderr.write(`chatgpt-browser-api: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
