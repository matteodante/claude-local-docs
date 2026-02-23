#!/usr/bin/env bash
# ensure-tei.sh — SessionStart hook: check if TEI containers are running, start if not.
# This script is idempotent and fast when containers are already up.
#
# Output: JSON with additionalContext for Claude's context window.

set -euo pipefail

PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# ── Check if Docker is available ─────────────────────────────────────
if ! command -v docker &>/dev/null; then
  cat <<'EOF'
{"additionalContext": "WARNING: Docker is not installed. TEI inference containers are not running. The search_docs and store_and_index_doc tools will fail. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and run ./start-tei.sh to start the TEI containers."}
EOF
  exit 0
fi

if ! docker info &>/dev/null 2>&1; then
  cat <<'EOF'
{"additionalContext": "WARNING: Docker daemon is not running. TEI inference containers are not available. Start Docker Desktop, then run ./start-tei.sh to start the TEI containers."}
EOF
  exit 0
fi

# ── Check if TEI containers are already healthy ──────────────────────
embed_ok=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:39281/health 2>/dev/null || echo "000")
rerank_ok=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:39282/health 2>/dev/null || echo "000")

if [ "$embed_ok" = "200" ] && [ "$rerank_ok" = "200" ]; then
  cat <<'EOF'
{"additionalContext": "TEI inference containers are running and healthy (embed :39281, rerank :39282)."}
EOF
  exit 0
fi

# ── Check if native TEI (Metal) is running via PID file ──────────────
if [ -f "$PLUGIN_DIR/.tei-pids" ]; then
  all_alive=true
  while IFS= read -r pid; do
    if ! kill -0 "$pid" 2>/dev/null; then
      all_alive=false
      break
    fi
  done < "$PLUGIN_DIR/.tei-pids"

  if $all_alive; then
    # PIDs alive but health check failed — still starting up, don't restart
    cat <<'EOF'
{"additionalContext": "TEI native processes are running but not yet healthy. They may still be loading models. Wait a moment and try again."}
EOF
    exit 0
  fi
fi

# ── Try to start containers ──────────────────────────────────────────
if [ -f "$PLUGIN_DIR/start-tei.sh" ]; then
  echo "Starting TEI containers..." >&2
  bash "$PLUGIN_DIR/start-tei.sh" >&2 2>&1 && {
    cat <<'EOF'
{"additionalContext": "TEI inference containers started successfully (embed :39281, rerank :39282). Ready for indexing and search."}
EOF
    exit 0
  }
fi

# ── Fallback: containers not running, can't auto-start ───────────────
cat <<'EOF'
{"additionalContext": "WARNING: TEI inference containers are not running. Run ./start-tei.sh in the claude-local-docs plugin directory to start them. Without TEI, search_docs and store_and_index_doc will fail."}
EOF
exit 0
