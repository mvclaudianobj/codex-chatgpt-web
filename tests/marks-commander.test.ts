import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { requestMetadata } from "../src/chatgpt-browser-api";
import { commanderConfigFromEnv, commanderWorkspace } from "../src/marks-commander";

const root = join("/tmp/markscode", `marks-commander-${process.pid}`);

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Marks Commander workspace contract", () => {
  test("is disabled by default", () => {
    expect(commanderWorkspace(root, "thread-1", commanderConfigFromEnv({}))).toMatchObject({ enabled: false, state: "disabled", identity: "thread-1" });
  });

  test("includes a validated local workspace and session identity", () => {
    mkdirSync(root, { recursive: true });
    const result = commanderWorkspace(root, "thread-2", { enabled: true, transport: "local", sharedRoots: [], workspaceMap: {} });
    expect(result).toMatchObject({ enabled: true, state: "ready", cwd: realRoot(root), workspace_roots: [realRoot(root)], identity: "thread-2" });
  });

  test("does not forward an invalid or unmapped remote workspace", () => {
    mkdirSync(root, { recursive: true });
    expect(commanderWorkspace(join(root, "missing"), "thread-3", { enabled: true, transport: "remote", endpoint: "https://marks1.invalid/mcp", sharedRoots: [], workspaceMap: {} })).toMatchObject({ enabled: false, state: "invalid_workspace" });
    expect(commanderWorkspace(root, "thread-3", { enabled: true, transport: "remote", endpoint: "https://marks1.invalid/mcp", sharedRoots: [], workspaceMap: {} })).toMatchObject({ enabled: false, state: "remote_workspace_unmapped" });
  });

  test("allows remote marks1 only with explicit mapping", () => {
    mkdirSync(root, { recursive: true });
    expect(commanderWorkspace(root, "session-4", { enabled: true, transport: "remote", endpoint: "https://marks1.invalid/mcp", sharedRoots: [], workspaceMap: { [realRoot(root)]: "/srv/workspace" } })).toMatchObject({ enabled: true, state: "ready", cwd: "/srv/workspace", identity: "session-4" });
  });

  test("publishes Commander and Native2 metadata for the same session", () => {
    mkdirSync(root, { recursive: true });
    const previous = process.env.MARKS_COMMANDER_ENABLED;
    process.env.MARKS_COMMANDER_ENABLED = "1";
    try {
      const metadata = requestMetadata({ cwd: root, thread_id: "thread-5", turn_id: "turn-5" });
      expect(metadata).toMatchObject({ cwd: realRoot(root), thread_id: "thread-5", turn_id: "turn-5", sandbox: "read-only", sandbox_mode: "read-only", integration: { marks_commander: { enabled: true, state: "ready", identity: "thread-5", thread_id: "thread-5", turn_id: "turn-5", cwd: realRoot(root), workspace_roots: [realRoot(root)] } } });
    } finally {
      if (previous === undefined) delete process.env.MARKS_COMMANDER_ENABLED;
      else process.env.MARKS_COMMANDER_ENABLED = previous;
    }
  });
});

function realRoot(value: string): string {
  return realpathSync(value);
}
