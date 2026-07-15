#!/usr/bin/env bash
# Arnfar AI — one-command dev stack.
#
#   ./scripts/dev.sh          start everything that is down, then print status
#   ./scripts/dev.sh status   check only, start nothing
#   ./scripts/dev.sh stop     stop the host processes (rag-api, web) and the containers
#   ./scripts/dev.sh reset    delete apps/web/.next — fixes a web app that 500s on every
#                             route with "Cannot find module './430.js'"
#   ./scripts/dev.sh logs api|web|lao-nlp|docx-extractor|postgres
#
# Ports and URLs are read from .env — never hardcoded. Postgres is on 5433 here
# (the host has a native PG18 squatting on 5432) and the sidecar URLs may point at
# non-compose containers, so hardcoding would start the wrong thing.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/.logs"
RUN_DIR="$ROOT/.run"
mkdir -p "$LOG_DIR" "$RUN_DIR"

# ── output helpers ────────────────────────────────────────────
if [[ -t 1 ]]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[34m'; DIM=$'\e[2m'; BOLD=$'\e[1m'; N=$'\e[0m'
else
  R=; G=; Y=; B=; DIM=; BOLD=; N=
fi
ok()   { printf '  %s✔%s %-16s %s\n' "$G" "$N" "$1" "${2-}"; }
bad()  { printf '  %s✘%s %-16s %s\n' "$R" "$N" "$1" "${2-}"; }
warn() { printf '  %s!%s %-16s %s\n' "$Y" "$N" "$1" "${2-}"; }
step() { printf '%s→%s %s\n' "$B" "$N" "$1"; }
head_() { printf '\n%s%s%s\n' "$BOLD" "$1" "$N"; }

# ── .env ──────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  bad ".env" "missing — run: cp .env.example .env && edit it"
  exit 1
fi
set -a; source .env; set +a

: "${POSTGRES_HOST:=localhost}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_USER:=arnfar}"
: "${POSTGRES_DB:=arnfar}"
: "${OLLAMA_BASE_URL:=http://localhost:11434}"
: "${LAO_NLP_URL:=http://localhost:7731}"
: "${DOCX_EXTRACTOR_URL:=http://localhost:7732}"
: "${RAG_API_PORT:=7730}"
: "${WEB_PORT:=3000}"

port_of() { sed -E 's#^[^:]+://[^:/]+:?([0-9]*).*#\1#' <<<"$1"; }
LAO_NLP_PORT="$(port_of "$LAO_NLP_URL")"
DOCX_PORT="$(port_of "$DOCX_EXTRACTOR_URL")"

# ── probes (each: 0 = healthy) ────────────────────────────────
tcp_up()  { timeout 2 bash -c ": >/dev/tcp/${1}/${2}" 2>/dev/null; }
http_ok() { curl -fsS --max-time 3 "$1" >/dev/null 2>&1; }
web_up()  { [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:$WEB_PORT" 2>/dev/null)" == "200" ]]; }

docker_ok() { docker info >/dev/null 2>&1; }

# Every PID listening on a port. `bun run dev:web` spawns `next dev`, which spawns the
# actual server, and killing the wrapper does NOT reliably take the server with it — the
# orphan keeps the port and keeps serving. So we stop by port, not by recorded PID.
pids_on_port() {
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

# TERM, wait, then KILL. Returns non-zero only if the port is STILL held afterwards.
kill_port() {
  local port="$1" pids
  pids="$(pids_on_port "$port")"
  [[ -z "$pids" ]] && return 0

  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null
  local i=0
  while (( i < 10 )); do
    sleep 1; ((i++))
    [[ -z "$(pids_on_port "$port")" ]] && return 0
  done

  pids="$(pids_on_port "$port")"
  # shellcheck disable=SC2086
  [[ -n "$pids" ]] && kill -KILL $pids 2>/dev/null
  sleep 1
  [[ -z "$(pids_on_port "$port")" ]]
}

pg_up()   { tcp_up "$POSTGRES_HOST" "$POSTGRES_PORT"; }
lao_up()  { http_ok "$LAO_NLP_URL/health"; }
docx_up() { http_ok "$DOCX_EXTRACTOR_URL/health"; }
oll_up()  { http_ok "$OLLAMA_BASE_URL/api/tags"; }
api_up()  { http_ok "http://localhost:$RAG_API_PORT/health"; }

# Wait for a probe to go green. wait_for <fn> <seconds> <label>
wait_for() {
  local fn="$1" secs="$2" label="$3" i=0
  while (( i < secs )); do
    "$fn" && return 0
    sleep 1; ((i++))
  done
  return 1
}

ollama_has_model() { curl -fsS --max-time 3 "$OLLAMA_BASE_URL/api/tags" 2>/dev/null | grep -qF "\"$1"; }

# ── status ────────────────────────────────────────────────────
print_status() {
  head_ "Infra"
  if docker_ok; then ok "docker" "daemon reachable"
  else bad "docker" "daemon unreachable — is your user in the 'docker' group? (sudo snap restart docker)"; fi

  if pg_up; then ok "postgres" "${DIM}${POSTGRES_HOST}:${POSTGRES_PORT}  db=${POSTGRES_DB}${N}"
  else bad "postgres" "${POSTGRES_HOST}:${POSTGRES_PORT} not accepting connections"; fi

  if lao_up; then ok "lao-nlp" "${DIM}${LAO_NLP_URL}${N}"
  else bad "lao-nlp" "$LAO_NLP_URL/health down"; fi

  if docx_up; then ok "docx-extractor" "${DIM}${DOCX_EXTRACTOR_URL}${N}"
  else bad "docx-extractor" "$DOCX_EXTRACTOR_URL/health down"; fi

  head_ "Inference"
  if oll_up; then
    ok "ollama" "${DIM}${OLLAMA_BASE_URL}${N}"
    for m in "${OLLAMA_EMBED_MODEL:-}" "${OLLAMA_GEN_MODEL:-}" "${OLLAMA_GEN_MODEL_ALT:-}"; do
      [[ -z "$m" ]] && continue
      if ollama_has_model "$m"; then ok "  model" "${DIM}${m}${N}"
      else warn "  model" "${m} not pulled — ollama pull ${m}"; fi
    done
  else
    bad "ollama" "$OLLAMA_BASE_URL unreachable"
  fi

  head_ "App"
  if api_up; then ok "rag-api" "${DIM}http://localhost:${RAG_API_PORT}${N}"
  else bad "rag-api" "http://localhost:${RAG_API_PORT}/health down"; fi

  if web_up; then ok "web" "${DIM}http://localhost:${WEB_PORT}${N}"
  else bad "web" "http://localhost:${WEB_PORT} down"; fi
  echo
}

# ── start ─────────────────────────────────────────────────────
# Bring up a compose service, but only if .env actually points at the port compose
# publishes. The sidecar URLs currently point at throwaway containers (7741/7743),
# not the compose ones (7731/7732) — starting compose there would give a healthy
# container nothing is talking to.
compose_up() {
  local svc="$1" expected_port="$2" configured_port="$3"
  if [[ -n "$expected_port" && -n "$configured_port" && "$expected_port" != "$configured_port" ]]; then
    warn "$svc" "down, and .env points at :${configured_port} while compose publishes :${expected_port}"
    printf '     %sNot starting it — that container is not managed by compose. Either start it yourself,%s\n' "$DIM" "$N"
    printf '     %sor point %s at :%s and re-run.%s\n' "$DIM" "$svc" "$expected_port" "$N"
    return 1
  fi
  step "docker compose up -d $svc"
  docker compose up -d "$svc"
}

start_host_proc() {
  # start_host_proc <name> <bun-script> <probe-fn> <wait-secs> <port>
  local name="$1" script="$2" probe="$3" secs="$4" port="$5"
  local pidfile="$RUN_DIR/$name.pid" log="$LOG_DIR/$name.log"

  if "$probe"; then ok "$name" "already running"; return 0; fi

  # A just-killed server can hold the port for a moment while it tears down, so give it a
  # few seconds to let go before concluding someone else owns it.
  local waited=0
  while tcp_up localhost "$port" && (( waited < 6 )); do
    sleep 1; ((waited++))
  done

  # Health-down but port-still-held means something else owns it — a server stuck
  # mid-compile, or one someone started by hand. Starting a second `next dev` here would be
  # actively destructive: both processes write the same .next/, and the build dir ends up
  # corrupt ("Cannot find module './430.js'", 404s on every chunk). Refuse and say so.
  if tcp_up localhost "$port"; then
    bad "$name" "port $port is held by another process, but it is not healthy"
    printf '     %sSomething else is already serving :%s (a stale dev server, or one you started\n' "$DIM" "$port"
    printf '     by hand). Not starting a second one — two servers sharing .next/ corrupts it.\n'
    printf '     Stop it first:  ./scripts/dev.sh stop   (or: pkill -f "next dev")%s\n' "$N"
    return 1
  fi

  step "starting $name  ${DIM}(log: .logs/$name.log)${N}"
  nohup bun run "$script" >"$log" 2>&1 &
  echo $! >"$pidfile"

  if wait_for "$probe" "$secs" "$name"; then
    ok "$name" "up"
  else
    # Leaving a half-started server holding the port is worse than not starting one: the
    # next run would find the port busy and unhealthy, and refuse to start anything.
    bad "$name" "did not come up in ${secs}s — last lines of .logs/$name.log:"
    tail -n 15 "$log" | sed 's/^/       /'
    kill_port "$port" >/dev/null 2>&1
    rm -f "$pidfile"
    return 1
  fi
}

do_start() {
  head_ "Starting Arnfar AI"

  if ! docker_ok; then
    bad "docker" "daemon unreachable — cannot start postgres or the sidecars"
    printf '     %sFix: sudo snap restart docker   (or add yourself: sudo usermod -aG docker $USER, then re-login)%s\n' "$DIM" "$N"
  else
    pg_up   || compose_up postgres "$POSTGRES_PORT" "$POSTGRES_PORT"
    lao_up  || compose_up lao-nlp        7731 "$LAO_NLP_PORT"
    docx_up || compose_up docx-extractor 7732 "$DOCX_PORT"

    pg_up || wait_for pg_up 30 postgres
  fi

  if ! oll_up; then
    if command -v ollama >/dev/null 2>&1; then
      step "starting ollama  ${DIM}(log: .logs/ollama.log)${N}"
      nohup ollama serve >"$LOG_DIR/ollama.log" 2>&1 &
      echo $! >"$RUN_DIR/ollama.pid"
      wait_for oll_up 20 ollama || bad "ollama" "failed to start — see .logs/ollama.log"
    else
      bad "ollama" "not installed on the host"
    fi
  fi

  # rag-api needs postgres; web needs rag-api. Start in order, don't bother if a dep is down.
  if pg_up; then
    start_host_proc rag-api dev:api api_up 40 "$RAG_API_PORT"
  else
    warn "rag-api" "skipped — postgres is down"
  fi

  if api_up; then
    start_host_proc web dev:web web_up 60 "$WEB_PORT"
  else
    warn "web" "skipped — rag-api is down"
  fi

  print_status

  if api_up && web_up; then
    printf '%s%s  Ready → http://localhost:%s%s   %schat /chat · studio /studio%s\n\n' "$BOLD" "$G" "$WEB_PORT" "$N" "$DIM" "$N"
  else
    printf '%sSome services are down. See the log files under .logs/ .%s\n\n' "$Y" "$N"
    exit 1
  fi
}

do_stop() {
  head_ "Stopping host processes"
  # Stop by port so we also collect servers this script did not start (and orphans it
  # failed to). Ollama is left alone: it is a shared host service, other things use it,
  # and it is not ours to kill.
  stop_one web "$WEB_PORT"
  stop_one rag-api "$RAG_API_PORT"

  head_ "Stopping containers"
  if docker_ok; then
    docker compose down && ok "compose" "down"
  else
    bad "docker" "daemon unreachable"
  fi
  echo
}

# Next's dev build dir is not crash-safe: kill a `next dev` mid-write (or let two of them
# share it) and it serves 500s with "Cannot find module './430.js'" and 404s on every
# chunk, forever, because nothing invalidates it. Deleting it is the only fix, and it is
# always safe — it is a cache.
do_reset() {
  head_ "Resetting the web build cache"

  # Deleting .next under a LIVE server is what corrupts it in the first place — the server
  # keeps serving from a directory that no longer exists and 500s every route. So the
  # delete only happens once the port is provably free.
  stop_one web "$WEB_PORT"
  if [[ -n "$(pids_on_port "$WEB_PORT")" ]]; then
    bad ".next" "not deleted — :$WEB_PORT is still held, and deleting the cache under a"
    printf '     %srunning server is exactly what corrupts it. Kill it first.%s\n\n' "$DIM" "$N"
    exit 1
  fi

  rm -rf "$ROOT/apps/web/.next"
  ok ".next" "deleted"
  printf '\n%sNow run: ./scripts/dev.sh%s\n\n' "$DIM" "$N"
}

stop_one() {
  local name="$1" port="$2"
  rm -f "$RUN_DIR/$name.pid"
  if [[ -z "$(pids_on_port "$port")" ]]; then
    warn "$name" "not running"
    return 0
  fi
  if kill_port "$port"; then
    ok "$name" "stopped"
  else
    bad "$name" "could not free port $port"
  fi
}

do_logs() {
  local what="${1-}"
  case "$what" in
    api|rag-api) tail -f "$LOG_DIR/rag-api.log" ;;
    web)         tail -f "$LOG_DIR/web.log" ;;
    ollama)      tail -f "$LOG_DIR/ollama.log" ;;
    postgres|lao-nlp|docx-extractor) docker compose logs -f "$what" ;;
    *) echo "usage: $0 logs api|web|ollama|postgres|lao-nlp|docx-extractor"; exit 1 ;;
  esac
}

case "${1:-start}" in
  start)  do_start ;;
  status) print_status ;;
  stop)   do_stop ;;
  reset)  do_reset ;;
  logs)   shift; do_logs "${1-}" ;;
  *) echo "usage: $0 [start|status|stop|reset|logs <service>]"; exit 1 ;;
esac
