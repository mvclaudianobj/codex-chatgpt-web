#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_BIN="${BUN_BIN:-/home/marcos/.bun/bin/bun}"
if [[ ! -x "$BUN_BIN" ]]; then
  BUN_BIN="$(command -v bun || true)"
fi
if [[ -z "${BUN_BIN:-}" || ! -x "$BUN_BIN" ]]; then
  echo "bun não encontrado. Defina BUN_BIN=/caminho/para/bun" >&2
  exit 1
fi

if [[ "${EUID:-$(id -u)}" == "0" && "${CHATGPT_BROWSER_API_ALLOW_ROOT:-0}" != "1" && -d "/home/marcos" ]] && command -v runuser >/dev/null 2>&1; then
  exec runuser -u marcos -- "$0" "$@"
fi

DEFAULT_HOME="$HOME"
if [[ "$DEFAULT_HOME" == "/root" && -d "/home/marcos" ]]; then
  DEFAULT_HOME="/home/marcos"
fi

APP_HOME="${CHATGPT_BROWSER_API_HOME:-$DEFAULT_HOME/.chatgpt-browser-api}"
CODEX_WEB_HOME="${CODEX_CHATGPT_WEB_HOME:-$DEFAULT_HOME/.codex-chatgpt-web}"
RUNTIME_DIR="$APP_HOME/runtime"
PID_FILE="$RUNTIME_DIR/chatgpt-browser-api.pid"
LAUNCHER_PID_FILE="$RUNTIME_DIR/codex-web-gpt-launcher.pid"
LOG_FILE="$RUNTIME_DIR/chatgpt-browser-api.log"
LAUNCHER_LOG_FILE="$RUNTIME_DIR/codex-web-gpt-launcher.log"
CONFIG_FILE="$APP_HOME/config.json"
LAUNCHER_DESCRIPTOR="$CODEX_WEB_HOME/runtime/launcher-browser.json"
HOST="${CHATGPT_BROWSER_API_HOST:-127.0.0.1}"
PORT="${CHATGPT_BROWSER_API_PORT:-18082}"
FULL_HARNESS="${CHATGPT_BROWSER_API_FULL_HARNESS:-1}"
AUTO_APPROVE_TOOLS="${CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS:-1}"
LOG_LEVEL="${CHATGPT_BROWSER_API_LOG_LEVEL:-info}"

mkdir -p "$RUNTIME_DIR"

pid_value() {
  local file="$1"
  [[ -f "$file" ]] && tr -d '[:space:]' < "$file" || true
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

api_pid() { pid_value "$PID_FILE"; }
launcher_pid() { pid_value "$LAUNCHER_PID_FILE"; }

health() {
  curl -fsS "http://$HOST:$PORT/healthz" 2>/dev/null || true
}

build() {
  cd "$ROOT_DIR"
  "$BUN_BIN" run typecheck
  "$BUN_BIN" run --cwd launcher build
}

init_config() {
  cd "$ROOT_DIR"
  CHATGPT_BROWSER_API_HOME="$APP_HOME" CHATGPT_BROWSER_API_HOST="$HOST" CHATGPT_BROWSER_API_PORT="$PORT" CHATGPT_BROWSER_API_FULL_HARNESS="$FULL_HARNESS" CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS="$AUTO_APPROVE_TOOLS" "$BUN_BIN" run src/chatgpt-browser-api.ts init >/dev/null
}

launcher_descriptor_pid() {
  python3 - "$LAUNCHER_DESCRIPTOR" <<'PY2' 2>/dev/null || true
import json, sys
p=sys.argv[1]
try:
    d=json.load(open(p))
    print(d.get('pid') or d.get('browserPid') or d.get('process',{}).get('pid') or '')
except Exception:
    pass
PY2
}

launcher_descriptor_running() {
  [[ -f "$LAUNCHER_DESCRIPTOR" ]] || return 1
  local pid
  pid="$(launcher_descriptor_pid)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

broker_socket_path() {
  python3 - "$CODEX_WEB_HOME/config.json" <<'PY2' 2>/dev/null || true
import json, sys
p=sys.argv[1]
try:
    c=json.load(open(p))
    print(c.get('brokerSocketPath') or '')
except Exception:
    pass
PY2
}

wait_broker_socket() {
  if [[ "$FULL_HARNESS" != "1" ]]; then
    return 0
  fi
  local socket
  socket="$(broker_socket_path)"
  if [[ -z "$socket" ]]; then
    return 0
  fi
  for _ in {1..60}; do
    if [[ -S "$socket" || -e "$socket" ]]; then
      echo "turn broker pronto: $socket"
      return 0
    fi
    sleep 1
  done
  echo "aviso: turn broker ainda não ficou pronto: $socket" >&2
  echo "a API será iniciada mesmo assim; requests sem cwd usam browser-only e full harness aguardará broker quando disponível" >&2
  return 0
}

start_launcher() {
  if [[ "${CHATGPT_BROWSER_API_START_LAUNCHER:-1}" == "0" ]]; then
    echo "launcher visual desabilitado por CHATGPT_BROWSER_API_START_LAUNCHER=0"
    return 0
  fi
  if launcher_descriptor_running; then
    echo "launcher visual já está ativo via descriptor: $LAUNCHER_DESCRIPTOR"
    return 0
  fi
  local pid
  pid="$(launcher_pid)"
  if is_running "$pid"; then
    echo "launcher visual já está rodando pid=$pid"
  else
    cd "$ROOT_DIR"
    : > "$LAUNCHER_LOG_FILE"
    ELECTRON_DISABLE_GPU=1 ELECTRON_EXTRA_LAUNCH_ARGS="--disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --disable-features=UseOzonePlatform" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}" CODEX_CHATGPT_WEB_HOME="$CODEX_WEB_HOME" CODEX_WEB_GPT_BUN="$BUN_BIN" CODEX_CHATGPT_WEB_BUN="$BUN_BIN" nohup "$BUN_BIN" run --cwd launcher start >>"$LAUNCHER_LOG_FILE" 2>&1 &
    pid=$!
    echo "$pid" > "$LAUNCHER_PID_FILE"
    echo "launcher visual iniciado pid=$pid"
    echo "launcher log: $LAUNCHER_LOG_FILE"
  fi
  for _ in {1..60}; do
    if launcher_descriptor_running; then
      echo "launcher descriptor pronto: $LAUNCHER_DESCRIPTOR"
      return 0
    fi
    if ! is_running "$pid"; then
      echo "launcher encerrou antes do descriptor ficar pronto. Logs:" >&2
      tail -120 "$LAUNCHER_LOG_FILE" >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "launcher iniciou, mas descriptor ainda não validou: $LAUNCHER_DESCRIPTOR" >&2
  tail -80 "$LAUNCHER_LOG_FILE" >&2 || true
  return 1
}

start_api() {
  local pid
  pid="$(api_pid)"
  if is_running "$pid"; then
    echo "chatgpt-browser-api já está rodando pid=$pid"
    health || true
    return 0
  fi
  init_config
  wait_broker_socket
  cd "$ROOT_DIR"
  : > "$LOG_FILE"
  CHATGPT_BROWSER_API_HOME="$APP_HOME" CODEX_CHATGPT_WEB_HOME="$CODEX_WEB_HOME" CHATGPT_BROWSER_API_HOST="$HOST" CHATGPT_BROWSER_API_PORT="$PORT" CHATGPT_BROWSER_API_FULL_HARNESS="$FULL_HARNESS" CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS="$AUTO_APPROVE_TOOLS" CHATGPT_BROWSER_API_LOG_LEVEL="$LOG_LEVEL" nohup "$BUN_BIN" run src/chatgpt-browser-api.ts run >>"$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" > "$PID_FILE"
  sleep 1
  if ! is_running "$pid"; then
    echo "falha ao iniciar API. Logs:" >&2
    tail -120 "$LOG_FILE" >&2 || true
    exit 1
  fi
  echo "chatgpt-browser-api iniciado pid=$pid"
  echo "api log: $LOG_FILE"
  for _ in {1..30}; do
    local response
    response="$(health)"
    if [[ -n "$response" ]]; then
      echo "$response"
      return 0
    fi
    sleep 1
  done
  echo "API iniciou, mas healthz ainda não respondeu" >&2
}

start() {
  start_launcher
  start_api
}

stop_api() {
  local pid
  pid="$(api_pid)"
  if ! is_running "$pid"; then
    echo "chatgpt-browser-api não está rodando"
    rm -f "$PID_FILE"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! is_running "$pid"; then
      rm -f "$PID_FILE"
      echo "chatgpt-browser-api parado"
      return 0
    fi
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "chatgpt-browser-api finalizado com SIGKILL"
}

stop_launcher() {
  local pid
  pid="$(launcher_pid)"
  if ! is_running "$pid"; then
    echo "launcher visual não está rodando pelo pid file"
    rm -f "$LAUNCHER_PID_FILE"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in {1..30}; do
    if ! is_running "$pid"; then
      rm -f "$LAUNCHER_PID_FILE"
      echo "launcher visual parado"
      return 0
    fi
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$LAUNCHER_PID_FILE"
  echo "launcher visual finalizado com SIGKILL"
}

stop() {
  stop_api
  stop_launcher
}

status() {
  local pid lpid dpid
  pid="$(api_pid)"
  lpid="$(launcher_pid)"
  dpid="$(launcher_descriptor_pid)"
  echo "home_api: $APP_HOME"
  echo "home_launcher: $CODEX_WEB_HOME"
  echo "config: $CONFIG_FILE"
  echo "api_pid_file: $PID_FILE"
  echo "launcher_pid_file: $LAUNCHER_PID_FILE"
  echo "api_log: $LOG_FILE"
  echo "launcher_log: $LAUNCHER_LOG_FILE"
  echo "launcher_descriptor: $LAUNCHER_DESCRIPTOR"
  [[ -f "$LAUNCHER_DESCRIPTOR" ]] && echo "launcher_descriptor_found: yes" || echo "launcher_descriptor_found: no"
  [[ -n "$dpid" ]] && echo "launcher_descriptor_pid: $dpid"
  is_running "$lpid" && echo "launcher_status: running pid=$lpid" || echo "launcher_status: stopped"
  launcher_descriptor_running && echo "launcher_descriptor_status: running" || echo "launcher_descriptor_status: not-running"
  if is_running "$pid"; then
    echo "api_status: running pid=$pid"
    health || true
  else
    echo "api_status: stopped"
  fi
  cd "$ROOT_DIR"
  CHATGPT_BROWSER_API_HOME="$APP_HOME" CODEX_CHATGPT_WEB_HOME="$CODEX_WEB_HOME" CHATGPT_BROWSER_API_HOST="$HOST" CHATGPT_BROWSER_API_PORT="$PORT" CHATGPT_BROWSER_API_FULL_HARNESS="$FULL_HARNESS" CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS="$AUTO_APPROVE_TOOLS" "$BUN_BIN" run src/chatgpt-browser-api.ts status || true
}

logs() {
  touch "$LOG_FILE"
  tail -n "${LINES:-120}" -f "$LOG_FILE"
}

launcher_logs() {
  touch "$LAUNCHER_LOG_FILE"
  tail -n "${LINES:-120}" -f "$LAUNCHER_LOG_FILE"
}

restart() {
  stop
  start
}

api_key() {
  init_config
  local subcommand="${1:-get}"
  local value="${2:-}"
  cd "$ROOT_DIR"
  case "$subcommand" in
    get) CHATGPT_BROWSER_API_HOME="$APP_HOME" "$BUN_BIN" run src/chatgpt-browser-api.ts api-key get ;;
    set) CHATGPT_BROWSER_API_HOME="$APP_HOME" "$BUN_BIN" run src/chatgpt-browser-api.ts api-key set "$value" ;;
    rotate) CHATGPT_BROWSER_API_HOME="$APP_HOME" "$BUN_BIN" run src/chatgpt-browser-api.ts api-key rotate ;;
    *) echo "uso: $0 api-key [get|set|rotate] [valor]" >&2; exit 2 ;;
  esac
}

curl_test() {
  local key
  key="$(api_key)"
  curl -fsS "http://$HOST:$PORT/healthz"
  echo
  curl -fsS -H "Authorization: Bearer $key" "http://$HOST:$PORT/v1/models"
  echo
  curl -fsS -H "Authorization: Bearer $key" "http://$HOST:$PORT/v1/harness/status"
  echo
  curl -fsS "http://$HOST:$PORT/v1/chat/completions" \
    -H "Authorization: Bearer $key" \
    -H "content-type: application/json" \
    -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Responda apenas: ok"}]}'
  echo
}

usage() {
  cat <<USAGE
Uso: ./build_and_run.sh <comando>

Comandos:
  build             roda typecheck + build do launcher
  init              cria config em $CONFIG_FILE
  start|run         inicia launcher visual de produção + API em background
  start-api         inicia só a API
  start-launcher    inicia só o launcher visual de produção
  stop              para API + launcher iniciado por este script
  stop-api          para só a API
  stop-launcher     para só o launcher iniciado por este script
  restart           reinicia launcher + API
  status            mostra status de launcher, descriptor e API
  logs              acompanha logs da API
  launcher-logs     acompanha logs do launcher visual
  test              testa health/models/chat
  api-key [get|set|rotate] [valor]
                    imprime, registra ou rotaciona a API key global

Produção visual:
  usa: bun run --cwd launcher start
  não usa: bun run app / scripts/start-launcher.ts / launcher dev

Variáveis:
  CHATGPT_BROWSER_API_HOME=$APP_HOME
  CODEX_CHATGPT_WEB_HOME=$CODEX_WEB_HOME
  CHATGPT_BROWSER_API_HOST=$HOST
  CHATGPT_BROWSER_API_PORT=$PORT
  CHATGPT_BROWSER_API_START_LAUNCHER=1
  CHATGPT_BROWSER_API_FULL_HARNESS=$FULL_HARNESS
  CHATGPT_BROWSER_API_AUTO_APPROVE_TOOLS=$AUTO_APPROVE_TOOLS
  CHATGPT_BROWSER_API_LOG_LEVEL=$LOG_LEVEL
  BUN_BIN=$BUN_BIN
USAGE
}

case "${1:-status}" in
  build) build ;;
  init) init_config; echo "$CONFIG_FILE" ;;
  start|run) start ;;
  start-api) start_api ;;
  start-launcher) start_launcher ;;
  stop) stop ;;
  stop-api) stop_api ;;
  stop-launcher) stop_launcher ;;
  restart) restart ;;
  status) status ;;
  logs) logs ;;
  launcher-logs) launcher_logs ;;
  test) curl_test ;;
  api-key) api_key "${2:-get}" "${3:-}" ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
