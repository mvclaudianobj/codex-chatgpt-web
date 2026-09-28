import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommanderHandler } from "../src/server.ts";

const root = "/tmp/markscode/codex-web-commander-test";
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "hello.txt"), "hello\nworld\n", "utf8");
  handler = createCommanderHandler({ apiKey: "test-secret", workspace: root });
});

afterAll(async () => rm(root, { recursive: true, force: true }));

async function request(body: unknown, authorization = "Bearer test-secret") {
  return handler(new Request("http://localhost/mcp", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) }));
}

describe("codex web commander", () => {
  test("health is public and MCP auth is required", async () => {
    expect((await handler(new Request("http://localhost/healthz"))).status).toBe(200);
    expect((await request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "Bearer wrong")).status).toBe(401);
  });

  test("supports initialize and tools/list", async () => {
    const initialize = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect((await initialize.json()).result.serverInfo.name).toBe("codex-web-commander");
    const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await listed.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["workspace_status", "list_directory", "read_file"]);
  });

  test("returns workspace status and reads a file", async () => {
    const status = await request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_status", arguments: { cwd: root } } });
    expect((await status.json()).result.structuredContent.isDirectory).toBe(true);
    const read = await request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_file", arguments: { path: "hello.txt" } } });
    expect((await read.json()).result.structuredContent.content).toBe("hello\nworld\n");
  });

  test("blocks traversal", async () => {
    const response = await request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_file", arguments: { path: "../etc/passwd" } } });
    const body = await response.json();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("inside cwd");
  });
});
