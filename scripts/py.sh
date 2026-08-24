#!/usr/bin/env bash
# Run a Python tool (ruff / mypy / pytest) against the two sidecars.
#
# The system interpreter on most distros is PEP 668 "externally managed", so a plain
# `pip install ruff` fails — and forcing it with --break-system-packages is exactly the
# kind of thing that breaks a machine later. This bootstraps an isolated .venv-tools/
# instead (gitignored), reusing it on every subsequent run.
#
#   ./scripts/py.sh ruff check .
#   ./scripts/py.sh ruff format --check .
#   ./scripts/py.sh mypy
#   ./scripts/py.sh pytest
#
# Add --refresh as the first argument to reinstall the tools after editing
# requirements-dev.txt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv-tools"
STAMP="$VENV/.requirements-sha"
REQ="$ROOT/requirements-dev.txt"

REFRESH=0
if [[ "${1:-}" == "--refresh" ]]; then
  REFRESH=1
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "usage: scripts/py.sh [--refresh] <ruff|mypy|pytest> [args...]" >&2
  exit 2
fi

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "→ creating $VENV" >&2
  python3 -m venv "$VENV"
  REFRESH=1
fi

# Reinstall only when requirements-dev.txt actually changed — otherwise every lint run
# would pay for a dependency resolution it does not need.
WANT="$(sha256sum "$REQ" | cut -d' ' -f1)"
HAVE="$(cat "$STAMP" 2>/dev/null || echo none)"
if [[ $REFRESH -eq 1 || "$WANT" != "$HAVE" ]]; then
  echo "→ installing python tooling" >&2
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r "$REQ"
  echo "$WANT" > "$STAMP"
fi

TOOL="$1"
shift
exec "$VENV/bin/$TOOL" "$@"
