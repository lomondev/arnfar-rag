#!/usr/bin/env bash
# Arnfar AI — one-command dev stack.
#
#   ./scripts/dev.sh          start everything that is down, then print status
#   ./scripts/dev.sh status   check only, start nothing
#   ./scripts/dev.sh stop     stop the host processes (rag-api, web) and the containers
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
  # start_host_proc <name> <bun-script> <probe-fn> <wait-secs>
  local name="$1" script="$2" probe="$3" secs="$4"
  local pidfile="$RUN_DIR/$name.pid" log="$LOG_DIR/$name.log"

  if "$probe"; then ok "$name" "already running"; return 0; fi

  step "starting $name  ${DIM}(log: .logs/$name.log)${N}"
  nohup bun run "$script" >"$log" 2>&1 &
  echo $! >"$pidfile"

  if wait_for "$probe" "$secs" "$name"; then
    ok "$name" "up"
  else
    bad "$name" "did not come up in ${secs}s — last lines of .logs/$name.log:"
    tail -n 15 "$log" | sed 's/^/       /'
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
    start_host_proc rag-api dev:api api_up 40
  else
    warn "rag-api" "skipped — postgres is down"
  fi

  if api_up; then
    start_host_proc web dev:web web_up 60
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
  for name in web rag-api ollama; do
    local_pidfile="$RUN_DIR/$name.pid"
    if [[ -f "$local_pidfile" ]] && kill -0 "$(cat "$local_pidfile")" 2>/dev/null; then
      pkill -TERM -P "$(cat "$local_pidfile")" 2>/dev/null
      kill -TERM "$(cat "$local_pidfile")" 2>/dev/null
      ok "$name" "stopped"
      rm -f "$local_pidfile"
    else
      warn "$name" "not started by this script (leave it alone)"
      rm -f "$local_pidfile"
    fi
  done

  head_ "Stopping containers"
  if docker_ok; then
    docker compose down && ok "compose" "down"
  else
    bad "docker" "daemon unreachable"
  fi
  echo
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
  logs)   shift; do_logs "${1-}" ;;
  *) echo "usage: $0 [start|status|stop|logs <service>]"; exit 1 ;;
esac
