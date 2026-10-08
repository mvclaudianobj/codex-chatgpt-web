# ChatGPT Browser API

This branch adds a standalone, OpenAI-compatible HTTP API around the same authenticated ChatGPT
Web adapter used by Codex ChatGPT Web. It is a local integration patch on top of upstream 6.1.6,
not a replacement for the upstream launcher, native Codex route, release packages, or ChatGPT
authentication. The patch adds the `chatgpt-browser-api` entry point, its lifecycle script, optional
full-harness execution, request metadata, and Marks Commander metadata while retaining the upstream
6.1.6 browser transport, startup recovery, model-selection, and context safeguards.

The API is intended for trusted local clients. It does not bypass account capabilities or usage
limits. Every completion request sends a real message through the signed-in ChatGPT Web account.

## Architecture

```text
OpenAI-compatible client
        │ Bearer-authenticated HTTP on loopback
        ▼
chatgpt-browser-api
  ├─ canonical ChatGPT Web model routing
  ├─ Chat Completions and Responses translation
  ├─ request queue and tool-continuation lease
  ├─ optional full-harness turn broker
  └─ optional read-only Marks Commander metadata
        │
        ▼
production-source Electron launcher
  └─ authenticated ChatGPT Web browser session
```

`build_and_run.sh` starts the production launcher source with
`bun run --cwd launcher start`. It does not use `bun run app`,
`scripts/start-launcher.ts`, or the development launcher. When an active launcher descriptor exists,
the API attaches to that launcher-owned browser. Otherwise it can use the configured managed-browser
storage state.

In full mode, the API uses the launcher runtime's turn broker when the broker socket is inside the
active `CODEX_CHATGPT_WEB_HOME/runtime` directory. The broker preserves the outer turn's tool
capability and serializes browser work. Client-side tool continuations are bound to their tool,
thread, and turn identity and block unrelated browser turns until completed or expired.

The API also adds `integration.marks_commander` to the serialized Native2 turn metadata. This is
workspace metadata only. The current implementation is not an outbound MCP client, does not call
Commander tools, and does not independently provide shell, write, or delete operations.

## Prerequisites

- Bun **exactly 1.4.0**. The repository pins `packageManager`, the Bun engine, and Bun types to 1.4.0.
- The locked root and launcher dependencies installed with Bun.
- A graphical desktop session capable of running the Electron launcher.
- A ChatGPT login completed inside the launcher browser profile.
- Account access to each requested ChatGPT model and reasoning control.
- `bash`, `curl`, `python3`, and ordinary process-control utilities for `build_and_run.sh`.

Install the locked dependencies without changing the lockfile:

```bash
bun --version
bun install --frozen-lockfile
bun install --cwd launcher --frozen-lockfile
```

The first command must print `1.4.0`. Packaged upstream applications embed their runtime, but this
source workflow requires the exact local Bun version.

## Modes and risk

### Browser-only

Browser-only mode sends prompts to ChatGPT Web and returns the browser response. Local harness tools
are disabled. Use this mode for the smaller trust boundary:

```bash
CHATGPT_BROWSER_API_FULL_HARNESS=0 \
CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS=0 \
./build_and_run.sh start
```

### Full harness

Full mode attaches the turn broker and permits local tool execution when the launcher configuration,
request, and broker capability allow it. A request that needs local context must provide a valid
workspace through `cwd`, metadata, or a supported workspace environment variable. Workspace paths
are resolved and checked rather than silently falling back to the API process directory.

`build_and_run.sh` currently defaults both `CHATGPT_BROWSER_API_FULL_HARNESS` and
`CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS` to `1`. This is convenient for the local integration harness
but is a high-trust default: prompt injection can reach local tools, and eligible tool calls may be
approved automatically. Set both variables explicitly to `0` unless that behavior is intended.

The API's own generated configuration defaults to browser-only mode with automatic approval off.
The script overrides those defaults when it starts or inspects the API.

## Homes, configuration, and precedence

The standalone API and launcher deliberately use separate homes:

| Path | Default | Purpose |
| --- | --- | --- |
| API home | `~/.chatgpt-browser-api` | Standalone configuration, runtime files, API logs, and PID files |
| API config | `~/.chatgpt-browser-api/config.json` | API key, listener, model defaults, and standalone browser settings |
| Launcher home | `~/.codex-chatgpt-web` | Launcher configuration, browser profile, broker, and descriptor |
| Launcher descriptor | `~/.codex-chatgpt-web/runtime/launcher-browser.json` | Active production browser connection |

When run as root on a system with `/home/marcos`, the lifecycle script re-executes as `marcos` unless
`CHATGPT_BROWSER_API_ALLOW_ROOT=1` is set. It also selects `/home/marcos` as the default home in that
case. Avoid root mode; the browser profile and API secrets should belong to the interactive user.

Effective configuration is resolved in these stages:

1. Built-in API defaults.
2. Standalone `config.json` values.
3. Supported API environment overrides for host, port, key, default model, announced model input,
   full mode, and auto-approval.
4. Active launcher/Codex configuration for the browser host, descriptor or storage state, broker,
   account capabilities, browser interaction mode, timeouts, and full mode.

An active launcher descriptor always selects the launcher browser host. Without it, an existing
launcher storage state and browser settings may be reused. Active launcher full mode is inherited
unless `CHATGPT_BROWSER_API_FULL_HARNESS=0`; setting it to `1` forces full mode. Auto-approval is
additive: an environment value of `1`, standalone `true`, or active launcher `true` enables it; an
environment value of `0` does not override a persisted `true`. Inspect the effective result before
sending a request:

```bash
CHATGPT_BROWSER_API_FULL_HARNESS=0 \
CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS=0 \
./build_and_run.sh status
```

Do not print, copy, synchronize, or commit either home. They can contain an API key, browser session
state, runtime descriptors, and account-bound data.

## Supported environment variables

### Lifecycle script

| Variable | Meaning |
| --- | --- |
| `BUN_BIN` | Exact Bun 1.4.0 executable; otherwise the script tries `/home/marcos/.bun/bin/bun`, then `PATH` |
| `CHATGPT_BROWSER_API_ALLOW_ROOT` | Set to `1` to suppress the script's root-to-`marcos` re-exec |
| `CHATGPT_BROWSER_API_HOME` | Standalone API home |
| `CODEX_CHATGPT_WEB_HOME` | Production launcher/Codex ChatGPT Web home |
| `CHATGPT_BROWSER_API_DEFAULT_HOST` | Script fallback host; default `127.0.0.1` |
| `CHATGPT_BROWSER_API_HOST` | Explicit API bind host; wins over persisted host in the script |
| `CHATGPT_BROWSER_API_PORT` | API port; default `18082` |
| `CHATGPT_BROWSER_API_START_LAUNCHER` | Set to `0` to skip launcher startup |
| `CHATGPT_BROWSER_API_FULL_HARNESS` | Script mode; default `1` |
| `CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS` | Script auto-approval setting; default `1` |
| `CHATGPT_BROWSER_API_LOG_LEVEL` | API production log filter level; default `info` |
| `LINES` | Initial line count for `logs` and `launcher-logs`; default `120` |
| `DBUS_SESSION_BUS_ADDRESS` | Existing graphical session bus; the script supplies the current user's standard bus when absent |

The script also supplies `CODEX_WEB_GPT_BUN`, `CODEX_CHATGPT_WEB_BUN`,
`ELECTRON_DISABLE_GPU`, and `ELECTRON_EXTRA_LAUNCH_ARGS` to its production launcher child. They are
launcher implementation details, not API configuration knobs.

### Standalone API

| Variable | Meaning |
| --- | --- |
| `CHATGPT_BROWSER_API_HOME` | Standalone home and `config.json` location |
| `CODEX_CHATGPT_WEB_HOME` | Active launcher configuration, descriptor, storage state, and broker home |
| `CHATGPT_BROWSER_API_HOST` | Listener host override |
| `CHATGPT_BROWSER_API_PORT` | Valid listener port override, `1` through `65535` |
| `CHATGPT_BROWSER_API_KEY` | In-memory bearer-key override; do not place it in a committed file or command log |
| `CHATGPT_BROWSER_API_CONTROL_TOKEN` | Compatibility control-token override used by configuration loading |
| `CHATGPT_BROWSER_API_MODEL` | Default request model or compatible alias |
| `CHATGPT_BROWSER_API_MODELS` | Comma-separated standalone model input; canonical `/v1/models` output is still capability-derived |
| `CHATGPT_BROWSER_API_FULL_HARNESS` | `1` forces full mode; `0` prevents active launcher full-mode inheritance |
| `CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS` | `1` enables automatic approval; it does not force a persisted `true` off |
| `CHATGPT_BROWSER_API_LOG_LEVEL` | `debug` keeps verbose production logs; other values filter known noisy browser lines |
| `CHATGPT_BROWSER_API_TOOL_LEASE_TIMEOUT_MS` | Positive client-tool lease timeout; default `120000` |
| `CHATGPT_BROWSER_API_CONTEXT_PACKET_MAX_CHARS` | Context-packet threshold with implementation bounds; default `120000`, maximum `180000` |
| `CHATGPT_BROWSER_API_CWD` | Default explicit workspace for local-context requests |
| `MARKSCODE_WORKSPACE_ROOT` | Secondary workspace fallback |
| `OPENCODE_WORKSPACE_ROOT` | Tertiary workspace fallback |
| `CHATGPT_BROWSER_API_CLIENT_TOOLS` | `1` returns compatible tool calls to the client instead of executing them locally |
| `CHATGPT_BROWSER_API_FAST_LOCAL_INSPECTION` | Set to `0` to disable the optimized local-inspection path |
| `CHATGPT_BROWSER_API_MARKSCODE_COMPAT` | Set to `0` to disable the built-in loopback MarksCode bearer compatibility path |

### Marks Commander metadata

| Variable | Meaning |
| --- | --- |
| `MARKS_COMMANDER_ENABLED` | `1` enables Commander metadata |
| `MARKS_COMMANDER_TRANSPORT` | `local` or `remote`; other values resolve to `local` |
| `MARKS_COMMANDER_ENDPOINT` | Required endpoint metadata for a remote mapping |
| `MARKS_COMMANDER_SHARED_ROOTS` | Comma-separated existing absolute local roots allowed unchanged for remote metadata |
| `MARKS_COMMANDER_WORKSPACE_MAP` | JSON object mapping local realpaths to remote absolute paths |

Invalid or missing workspaces produce `invalid_workspace` or `remote_workspace_unmapped` metadata.
They do not cause an unverified `cwd` to be forwarded.

## Lifecycle commands

Run all commands from the repository root.

| Command | Behavior |
| --- | --- |
| `./build_and_run.sh build` | Runs root typecheck and the production launcher build |
| `./build_and_run.sh init` | Creates the standalone config if absent and prints its path |
| `./build_and_run.sh start` | Starts the production-source launcher, waits for its descriptor and broker, then starts the API |
| `./build_and_run.sh run` | Alias of `start` |
| `./build_and_run.sh start-api` | Initializes and starts only the API; it can attach to an already active launcher |
| `./build_and_run.sh start-launcher` | Starts only the production-source Electron launcher |
| `./build_and_run.sh stop` | Stops the API and launcher processes recorded by this script |
| `./build_and_run.sh stop-api` | Stops only the recorded API process |
| `./build_and_run.sh stop-launcher` | Stops only the recorded launcher process |
| `./build_and_run.sh restart` | Stops and starts both recorded processes |
| `./build_and_run.sh status` | Prints homes, files, process state, descriptor state, health, and effective API configuration |
| `./build_and_run.sh logs` | Follows the API log; use `LINES=40` to change the initial count |
| `./build_and_run.sh launcher-logs` | Follows the launcher log |
| `./build_and_run.sh test` | Calls health, models, harness status, and one real chat completion |
| `./build_and_run.sh help` | Prints the supported commands and primary variables |

`test` is not read-only: its final request sends `Responda apenas: ok` as a real ChatGPT message.

## API key management

The API config is created with mode `0600`; the script creates its home and runtime directories with
mode `0700`, uses `umask 077`, and creates logs and PID files with mode `0600`. Preserve those modes:

```bash
chmod 700 "$HOME/.chatgpt-browser-api" "$HOME/.chatgpt-browser-api/runtime"
chmod 600 "$HOME/.chatgpt-browser-api/config.json"
```

Read the key into a temporary shell variable without printing it:

```bash
API_KEY="$(./build_and_run.sh api-key get)"
```

Set a key without putting its value directly in shell history:

```bash
read -rsp 'New API key: ' NEW_API_KEY
printf '\n'
./build_and_run.sh api-key set "$NEW_API_KEY" >/dev/null
unset NEW_API_KEY
```

The key must contain at least eight characters. Rotation generates a new random key, persists it,
and prints it once; capture it directly and restart the API so the running process reloads config:

```bash
API_KEY="$(./build_and_run.sh api-key rotate)"
./build_and_run.sh restart
```

Clear the client variable after use:

```bash
unset API_KEY
```

Never paste an API key into chat, source code, issue text, shell tracing, screenshots, committed
configuration, or logs. Redirecting `api-key get` or `rotate` to an ordinary file creates another
secret that must be protected and removed.

## HTTP API

The default base URL is `http://127.0.0.1:18082`. Keep the listener on loopback. Binding to a
non-loopback interface exposes a browser-backed account integration and is not hardened as a public
network service.

| Endpoint | Authentication | Contract |
| --- | --- | --- |
| `GET /healthz` | None | Product, version, and basic liveness |
| `GET /v1/models` | Bearer | Canonical, currently enabled ChatGPT Web routes |
| `GET /v1/harness/status` | Bearer | Effective mode, tools, approval, broker, browser host, queue, and tool lease |
| `POST /v1/chat/completions` | Bearer | OpenAI-style chat input; JSON or SSE when `stream: true` |
| `POST /v1/responses` | Bearer | Responses-style input and normalized response JSON |

Use `Authorization: Bearer $API_KEY`. Missing or incorrect authentication returns `401` with an
`authentication_error`. Unknown paths return `404`. Invalid JSON objects, unsupported models or
efforts, unavailable account capabilities, invalid workspaces, and adapter validation failures
return `400` with `invalid_request_error`. Invalid model and effort combinations are rejected before
a ChatGPT browser turn is sent.

## Models and capabilities

`GET /v1/models` announces canonical modern routes selected from effective account capabilities. It
does not simply echo arbitrary aliases from `CHATGPT_BROWSER_API_MODELS`.

| Canonical ID | Capability | Allowed `reasoning_effort` |
| --- | --- | --- |
| `chatgpt-web/gpt-5.6-luna` | Luna-only account | `low`, `medium` |
| `chatgpt-web/gpt-6-sol-instant` | Sol available | `low` |
| `chatgpt-web/gpt-6-sol` | Sol available | `medium`, `high`, and `xhigh` when Extra High is available |
| `chatgpt-web/gpt-5.6-sol-instant` | Sol available | `low` |
| `chatgpt-web/gpt-5.6-sol` | Sol available | `medium`, `high`, and `xhigh` when Extra High is available |
| `chatgpt-web/gpt-5.6-pro` | Pro available | `max` |
| `chatgpt-web/gpt-6-pro` | Pro available | `max` |

The API also accepts `reasoning.effort`. Incoming `ultra` is normalized to `max`, but new canonical
Pro routes are defined with `max`.

Compatibility aliases remain accepted for saved clients and older tasks, including
`gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-luna`, `browser-agent/gpt`, `browser-agent-gpt`,
`chatgpt-web/luna`, `chatgpt-web/think`, `chatgpt-web/light`, `chatgpt-web/medium`,
`chatgpt-web/high`, `chatgpt-web/extra-high`, and `chatgpt-web/pro`. They are not advertised by the
canonical `/v1/models` response. The generic standalone aliases resolve according to effective
capabilities and effort. `gpt-6-sol` and the generic browser-agent aliases select only GPT-6 routes;
`gpt-5.6-sol` remains explicitly in the 5.6 family. On Luna-only accounts, only the generic
browser-agent aliases may resolve to Luna; explicit family aliases fail closed. Use canonical IDs
for deterministic routing.

Manual launcher interaction mode exposes the separate Zero Risk routes instead of the automatic
catalog. This guide's curl examples assume automatic interaction mode.

## Request examples

Set client variables first:

```bash
API_BASE="http://127.0.0.1:18082"
API_KEY="$(./build_and_run.sh api-key get)"
```

Each `POST` example below sends a real message to ChatGPT and consumes account capacity. Do not use
them as passive health checks.

List the effective canonical catalog:

```bash
curl -fsS "$API_BASE/v1/models" \
  -H "Authorization: Bearer $API_KEY"
```

GPT-6 Sol at High:

```bash
curl -fsS "$API_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatgpt-web/gpt-6-sol",
    "reasoning_effort": "high",
    "messages": [{"role": "user", "content": "Reply with exactly: GPT-6 SOL HIGH READY"}]
  }'
```

GPT-5.6 Pro:

```bash
curl -fsS "$API_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatgpt-web/gpt-5.6-pro",
    "reasoning_effort": "max",
    "messages": [{"role": "user", "content": "Reply with exactly: PRO READY"}]
  }'
```

GPT-6 Pro:

```bash
curl -fsS "$API_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatgpt-web/gpt-6-pro",
    "reasoning_effort": "max",
    "messages": [{"role": "user", "content": "Reply with exactly: GPT 6 READY"}]
  }'
```

Luna Think-level effort:

```bash
curl -fsS "$API_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatgpt-web/gpt-5.6-luna",
    "reasoning_effort": "medium",
    "messages": [{"role": "user", "content": "Reply with exactly: LUNA READY"}]
  }'
```

Responses API:

```bash
curl -fsS "$API_BASE/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatgpt-web/gpt-5.6-sol-instant",
    "reasoning": {"effort": "low"},
    "input": "Reply with exactly: RESPONSES READY"
  }'
```

After testing:

```bash
unset API_KEY API_BASE
```

## Selection is fail-closed

The browser adapter treats model family and effort as separate controls. It selects the exact
family, reopens the picker, checks the selected radio, reads the slider, and verifies ChatGPT's
model announcement before Send. GPT-6 Pro must identify version 6 for the final Pro response;
lower-effort multipart acknowledgements remain verified as 5.6. A missing, duplicate, ambiguous, or
unverified selector returns `model_version_unavailable`, and the pending message is not sent.

ChatGPT can change DOM structure, labels, languages, accessibility attributes, and selector
ownership independently of this repository. Such selector drift must fail closed. Do not weaken
selectors or add an unverified fallback merely to restore sending. Reproduce against the current
browser UI, update the selector and announcement parser together, and rerun selection tests before
accepting a patch.

## Workspace and Commander metadata

Full-mode metadata preserves or creates `thread_id` and `turn_id`, resolves the workspace, and
serializes it in `client_metadata["x-codex-turn-metadata"]`. The integration records Commander
state, transport, optional endpoint, identity, `cwd`, and `workspace_roots` under
`integration.marks_commander`.

Local Commander metadata requires an existing absolute directory. Remote metadata additionally
requires an endpoint and either an exact realpath entry in `MARKS_COMMANDER_WORKSPACE_MAP` or a
matching `MARKS_COMMANDER_SHARED_ROOTS` entry. This prevents an arbitrary local path from being
presented as a remote workspace.

The metadata is descriptive. This branch does not open an outbound MCP connection to Commander and
does not use the Commander endpoint to execute actions.

## Validation

Documentation-only validation should not start the API or send a browser message. Use:

```bash
bash -n build_and_run.sh
bun run typecheck
bun run --cwd launcher typecheck
git diff --check
```

For implementation changes, also run the repository tests and launcher tests:

```bash
bun test ./tests
bun run --cwd launcher test
```

Live validation requires a signed-in account and intentionally sends messages. Start with
`GET /healthz`, `GET /v1/models`, and `GET /v1/harness/status`; only then run the smallest applicable
completion example.

## Troubleshooting

### Full mode reports a missing broker

Run `./build_and_run.sh status` and inspect the launcher descriptor, effective mode, and broker path.
Start the production launcher first with `./build_and_run.sh start-launcher`. The script waits for a
configured broker but still starts the API after warning, so browser-only requests can work while
full-harness requests wait or fail. Confirm that API and launcher use the same
`CODEX_CHATGPT_WEB_HOME`.

### Requests return `401`

Refresh the shell variable with `API_KEY="$(./build_and_run.sh api-key get)"`. If the key was
rotated, restart the API. Verify the exact `Authorization: Bearer $API_KEY` header and avoid trailing
newlines or quotes inside the value.

### A model is not announced or returns `400`

Treat `/v1/models` as authoritative for the active account and launcher mode. Pro and GPT-6 require
the exact routes exposed by the 6.1.6 capability catalog; Luna is for Luna-only accounts; Extra High
requires its separate capability. Use an
allowed effort for the exact canonical route. The API intentionally rejects an invalid combination
before opening a browser turn.

### Browser login or selector verification fails

The 6.1.6 launcher retries recoverable browser startup failures and refreshes stale host state before
surfacing a terminal error. Open the production launcher, sign in to ChatGPT, and confirm the composer
works interactively. If
model verification reports an unsupported language, set ChatGPT to English in Settings, reload, and
retry. Inspect `./build_and_run.sh launcher-logs` for descriptor or browser failures.

### Full mode rejects `cwd`

Send an existing absolute directory as top-level `cwd` or metadata `cwd`, or set
`CHATGPT_BROWSER_API_CWD`. Do not rely on the API service directory. Remote Commander metadata needs
an explicit valid mapping or shared-root allowlist.

### The port is busy

Run `./build_and_run.sh status`, stop the recorded API, or select another port consistently:

```bash
CHATGPT_BROWSER_API_PORT=18083 ./build_and_run.sh start-api
```

Persist or export the same port for later status and stop operations. Do not expose the alternate
port on a public interface.

### Logs are missing or too noisy

Use `./build_and_run.sh logs` and `./build_and_run.sh launcher-logs`. Set `LINES` for more initial
history. Set `CHATGPT_BROWSER_API_LOG_LEVEL=debug` only for a bounded diagnostic run, then restore
`info`; logs can contain paths and request diagnostics even though secret values should not be
logged.

## Stop and rollback

Stop processes created by the lifecycle script:

```bash
./build_and_run.sh stop
```

`stop` acts on the script's PID files. It does not terminate an unrelated launcher discovered only
through an external descriptor. Check `status` after stopping.

To roll back the patch without deleting account state, stop the API, restore the upstream 6.1.6
source files or checkout, and leave both homes untouched until rollback is verified. Removing
`~/.codex-chatgpt-web` signs the launcher out and destroys its local profile; removing
`~/.chatgpt-browser-api` deletes the standalone key and runtime state. Back up or remove those homes
only as an explicit, separate secret-handling operation.
