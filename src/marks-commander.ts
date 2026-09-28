import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type MarksCommanderConfig = {
  enabled: boolean;
  transport: "local" | "remote";
  endpoint?: string;
  sharedRoots: string[];
  workspaceMap: Record<string, string>;
};

export type MarksCommanderWorkspace = {
  enabled: boolean;
  state: "disabled" | "invalid_workspace" | "remote_workspace_unmapped" | "ready";
  transport: "local" | "remote";
  endpoint?: string;
  cwd?: string;
  workspace_roots?: string[];
};

function normalizedRoot(value: string): string | undefined {
  if (!isAbsolute(value) || !existsSync(value)) return undefined;
  try {
    if (!statSync(value).isDirectory()) return undefined;
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function rootIsAllowed(root: string, allowlist: string[]): boolean {
  return allowlist.some(candidate => root === candidate || root.startsWith(`${candidate}/`));
}

export function commanderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MarksCommanderConfig {
  const transport = env.MARKS_COMMANDER_TRANSPORT === "remote" ? "remote" : "local";
  const sharedRoots = (env.MARKS_COMMANDER_SHARED_ROOTS || "")
    .split(",")
    .map(value => normalizedRoot(value.trim()))
    .filter((value): value is string => Boolean(value));
  let workspaceMap: Record<string, string> = {};
  if (env.MARKS_COMMANDER_WORKSPACE_MAP) {
    try {
      const parsed = JSON.parse(env.MARKS_COMMANDER_WORKSPACE_MAP) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        workspaceMap = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      }
    } catch {
      workspaceMap = {};
    }
  }
  return {
    enabled: env.MARKS_COMMANDER_ENABLED === "1",
    transport,
    endpoint: env.MARKS_COMMANDER_ENDPOINT?.trim() || undefined,
    sharedRoots,
    workspaceMap,
  };
}

export function commanderWorkspace(root: string | undefined, identity: string | undefined, config: MarksCommanderConfig): MarksCommanderWorkspace & { identity?: string } {
  const base = { enabled: false, transport: config.transport, ...(config.endpoint ? { endpoint: config.endpoint } : {}), ...(identity ? { identity } : {}) };
  if (!config.enabled) return { ...base, state: "disabled" };
  const localRoot = normalizedRoot(root || "");
  if (!localRoot) return { ...base, state: "invalid_workspace" };
  if (config.transport === "local") return { ...base, enabled: true, state: "ready", cwd: localRoot, workspace_roots: [localRoot] };
  if (!config.endpoint) return { ...base, state: "remote_workspace_unmapped" };
  const mappedRoot = config.workspaceMap[localRoot];
  const remoteRoot = mappedRoot || (rootIsAllowed(localRoot, config.sharedRoots) ? localRoot : undefined);
  if (!remoteRoot || !isAbsolute(remoteRoot)) return { ...base, state: "remote_workspace_unmapped" };
  return { ...base, enabled: true, state: "ready", cwd: remoteRoot, workspace_roots: [remoteRoot] };
}
