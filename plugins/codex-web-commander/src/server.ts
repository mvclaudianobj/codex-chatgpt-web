import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, relative, resolve } from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18182;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_ENTRIES = 100;
const MAX_ENTRIES = 1_000;
const DEFAULT_MAX_READ_BYTES = 262_144;
const MAX_READ_BYTES = 1_048_576;
const DEFAULT_MAX_READ_LINES = 1_000;
const MAX_READ_LINES = 10_000;
const PROTOCOL_VERSION = "2025-03-26";

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

export type CommanderConfig = {
  host?: string;
  port?: number;
  apiKey: string;
  workspace?: string;
  corsOrigins?: string[];
  maxBodyBytes?: number;
};

const tools = [
  {
    name: "workspace_status",
    description: "Returns safe metadata about the explicitly selected workspace.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "Absolute workspace directory." } },
      additionalProperties: false,
    },
  },
  {
    name: "list_directory",
    description: "Lists entries in a directory below the selected workspace.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        path: { type: "string", description: "Relative path, or . for the workspace root." },
        limit: { type: "integer", minimum: 1, maximum: MAX_ENTRIES },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Reads a bounded UTF-8 text file below the selected workspace.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        path: { type: "string" },
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_READ_BYTES },
        maxLines: { type: "integer", minimum: 1, maximum: MAX_READ_LINES },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

function error(code: number, message: string, id: JsonRpcId = null, data?: unknown): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function result(id: JsonRpcId, value: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result: value };
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function authorized(request: Request, apiKey: string): boolean {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return false;
  return constantTimeEqual(value.slice(7), apiKey);
}

function corsHeaders(request: Request, origins: string[]): HeadersInit {
  const origin = request.headers.get("origin");
  if (!origin || !origins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, mcp-session-id",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "Origin",
  };
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Value must be an integer between 1 and ${maximum}`);
  }
  return value;
}

async function existingDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  const real = await realpath(resolved).catch(() => {
    throw new Error("Workspace does not exist or is not accessible");
  });
  const details = await stat(real).catch(() => {
    throw new Error("Workspace does not exist or is not accessible");
  });
  if (!details.isDirectory()) throw new Error("Workspace must be a directory");
  return real;
}

async function safePath(workspace: string, requested: string): Promise<string> {
  if (!requested || typeof requested !== "string") throw new Error("path is required");
  const candidate = resolve(workspace, requested);
  const relation = relative(workspace, candidate);
  if (relation.startsWith("..") || relation === ".." || relation.includes("\0")) {
    throw new Error("path must stay inside cwd");
  }
  const real = await realpath(candidate).catch(() => {
    throw new Error("path does not exist or is not accessible");
  });
  const realRelation = relative(workspace, real);
  if (realRelation.startsWith("..") || realRelation === "..") throw new Error("path must stay inside cwd");
  return real;
}

async function workspaceFor(args: JsonObject, configuredWorkspace?: string): Promise<string> {
  const cwd = args.cwd;
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd)) throw new Error("cwd must be a non-empty string");
  const selected: string | undefined = cwd !== undefined ? cwd : configuredWorkspace;
  if (!selected) throw new Error("cwd is required or CODEX_WEB_COMMANDER_WORKSPACE must be configured");
  if (!selected.startsWith("/")) throw new Error("cwd must be an absolute directory path");
  return existingDirectory(selected);
}

async function callTool(name: string, args: JsonObject, configuredWorkspace?: string): Promise<unknown> {
  const workspace = await workspaceFor(args, configuredWorkspace);
  if (name === "workspace_status") {
    return { cwd: workspace, name: basename(workspace), isDirectory: true };
  }
  if (name === "list_directory") {
    const target = await safePath(workspace, typeof args.path === "string" ? args.path : ".");
    const details = await stat(target);
    if (!details.isDirectory()) throw new Error("path is not a directory");
    const limit = boundedInteger(args.limit, DEFAULT_MAX_ENTRIES, MAX_ENTRIES);
    const entries: Array<{ name: string; type: string }> = [];
    const names = await readdir(target, { withFileTypes: true });
    for (const entry of names) {
      if (entries.length >= limit) break;
      if (!entry.name) continue;
      const entryPath = await safePath(workspace, resolve(target, entry.name));
      const entryDetails = await stat(entryPath);
      entries.push({ name: entry.name, type: entryDetails.isDirectory() ? "directory" : "file" });
    }
    return { cwd: workspace, path: target, entries, truncated: entries.length >= limit };
  }
  if (name === "read_file") {
    const target = await safePath(workspace, typeof args.path === "string" ? args.path : "");
    const details = await stat(target);
    if (!details.isFile()) throw new Error("path is not a regular file");
    const maxBytes = boundedInteger(args.maxBytes, DEFAULT_MAX_READ_BYTES, MAX_READ_BYTES);
    const maxLines = boundedInteger(args.maxLines, DEFAULT_MAX_READ_LINES, MAX_READ_LINES);
    const bytes = new Uint8Array(await readFile(target));
    const truncatedBytes = bytes.length > maxBytes;
    const text = new TextDecoder().decode(bytes.subarray(0, maxBytes));
    const lines = text.split("\n");
    const truncatedLines = lines.length > maxLines;
    const content = lines.slice(0, maxLines).join("\n");
    return { path: target, content, bytes: Math.min(bytes.length, maxBytes), truncated: truncatedBytes || truncatedLines };
  }
  throw new Error("Unknown tool");
}

async function handleRpc(body: unknown, configuredWorkspace?: string): Promise<JsonObject> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return error(-32600, "Invalid Request");
  const request = body as JsonObject;
  const id: JsonRpcId = (typeof request.id === "string" || typeof request.id === "number" || request.id === null) ? request.id : null;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return error(-32600, "Invalid Request", id);
  try {
    if (request.method === "initialize") {
      return result(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "codex-web-commander", version: "0.1.0" } });
    }
    if (request.method === "notifications/initialized") return result(id, {});
    if (request.method === "tools/list") return result(id, { tools });
    if (request.method === "tools/call") {
      const params = request.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("params must be an object");
      const name = (params as JsonObject).name;
      const args = (params as JsonObject).arguments ?? {};
      if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments");
      const value = await callTool(name, args as JsonObject, configuredWorkspace);
      return result(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false });
    }
    return error(-32601, "Method not found", id);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Request failed";
    return error(-32602, message, id);
  }
}

export function createCommanderHandler(config: CommanderConfig): (request: Request) => Promise<Response> {
  if (!config.apiKey) throw new Error("CODEX_WEB_COMMANDER_API_KEY is required");
  const origins = config.corsOrigins ?? [];
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async (request) => {
    const headers = corsHeaders(request, origins);
    if (request.method === "OPTIONS") return new Response(null, { status: origins.length ? 204 : 403, headers });
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true, service: "codex-web-commander" }, 200, headers);
    if (url.pathname !== "/mcp") return json({ error: "Not found" }, 404, headers);
    if (request.method !== "POST") return json(error(-32600, "Only POST is supported on /mcp"), 405, headers);
    if (!authorized(request, config.apiKey)) return json({ error: "Unauthorized" }, 401, { ...headers, "www-authenticate": "Bearer" });
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > maxBodyBytes) return json(error(-32600, "Request body is too large"), 413, headers);
    const body = await request.arrayBuffer();
    if (body.byteLength > maxBodyBytes) return json(error(-32600, "Request body is too large"), 413, headers);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { return json(error(-32700, "Parse error"), 400, headers); }
    return json(await handleRpc(parsed, config.workspace), 200, headers);
  };
}

export function configFromEnvironment(env: Record<string, string | undefined> = process.env): CommanderConfig {
  const port = Number(env.CODEX_WEB_COMMANDER_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CODEX_WEB_COMMANDER_PORT must be a valid port");
  const corsOrigins = (env.CODEX_WEB_COMMANDER_CORS_ORIGIN ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (corsOrigins.includes("*")) throw new Error("Wildcard CORS is not supported");
  return { host: env.CODEX_WEB_COMMANDER_HOST ?? DEFAULT_HOST, port, apiKey: env.CODEX_WEB_COMMANDER_API_KEY ?? "", workspace: env.CODEX_WEB_COMMANDER_WORKSPACE, corsOrigins };
}

function requestFromNode(request: IncomingMessage, body: Uint8Array): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.from(body),
    duplex: "half",
  } as RequestInit);
}

async function readNodeBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function serveNodeRequest(request: IncomingMessage, response: ServerResponse, handler: (request: Request) => Promise<Response>, maxBytes: number): Promise<void> {
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? new Uint8Array() : await readNodeBody(request, maxBytes);
    const result = await handler(requestFromNode(request, body));
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Request failed";
    response.writeHead(message === "Request body is too large" ? 413 : 500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(error(message === "Request body is too large" ? -32600 : -32603, message)));
  }
}

export function startCommander(config = configFromEnvironment()): Server {
  const handler = createCommanderHandler(config);
  const server = createServer((request, response) => {
    void serveNodeRequest(request, response, handler, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  });
  server.listen(config.port ?? DEFAULT_PORT, config.host ?? DEFAULT_HOST);
  return server;
}
