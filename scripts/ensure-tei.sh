#!/usr/bin/env bash
# ensure-tei.sh — SessionStart hook: check if TEI containers are running, start if not.
# Starts only missing containers (does not restart healthy ones).
# Auto-detects NVIDIA GPU for compose file selection.
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
{"additionalContext": "WARNING: Docker daemon is not running. TEI inference containers are not available. Start Docker Desktop, then run ./start-tei.sh to start them."}
EOF
  exit 0
fi

# ── Check each TEI endpoint individually ─────────────────────────────
check_health() {
  curl -s -o /dev/null -w "%{http_code}" "http://localhost:$1/health" 2>/dev/null || echo "000"
}

embed_ok=$(check_health 39281)
rerank_ok=$(check_health 39282)
code_embed_ok=$(check_health 39283)

if [ "$embed_ok" = "200" ] && [ "$rerank_ok" = "200" ] && [ "$code_embed_ok" = "200" ]; then
  cat <<'EOF'
{"additionalContext": "TEI inference containers are running and healthy (embed :39281, rerank :39282, code-embed :39283)."}
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
    cat <<'EOF'
{"additionalContext": "TEI native processes are running but not yet healthy. They may still be loading models. Wait a moment and try again."}
EOF
    exit 0
  fi
fi

# ── Determine which services need starting ───────────────────────────
MISSING_SERVICES=()
if [ "$embed_ok" != "200" ]; then
  MISSING_SERVICES+=("tei-embed")
fi
if [ "$rerank_ok" != "200" ]; then
  MISSING_SERVICES+=("tei-rerank")
fi
if [ "$code_embed_ok" != "200" ]; then
  MISSING_SERVICES+=("tei-code-embed")
fi

if [ ${#MISSING_SERVICES[@]} -eq 0 ]; then
  exit 0
fi

# ── Detect GPU for compose file selection ────────────────────────────
detect_compose_args() {
  local compose_args=("-f" "$PLUGIN_DIR/docker-compose.yml")

  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
    compose_args+=("-f" "$PLUGIN_DIR/docker-compose.nvidia.yml")

    # Detect optimal TEI tag from GPU compute capability
    local cc
    cc=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '[:space:]') || cc=""
    local major="${cc%%.*}"
    local minor="${cc#*.}"

    case "$major" in
      12) export TEI_TAG="120-1.9" ;;
      10) export TEI_TAG="100-1.9" ;;
       9) export TEI_TAG="hopper-1.9" ;;
       8) case "$minor" in
            9) export TEI_TAG="89-1.9" ;;
            6) export TEI_TAG="86-1.9" ;;
            0) export TEI_TAG="1.9" ;;
            *) export TEI_TAG="cuda-1.9" ;;
          esac ;;
       7) export TEI_TAG="turing-1.9" ;;
       *) export TEI_TAG="cuda-1.9" ;;
    esac
  else
    export TEI_TAG="cpu-1.9"
  fi

  echo "${compose_args[@]}"
}

# ── Start only the missing services ──────────────────────────────────
COMPOSE_ARGS=($(detect_compose_args))

echo "Starting missing TEI services: ${MISSING_SERVICES[*]}..." >&2
docker compose "${COMPOSE_ARGS[@]}" up -d "${MISSING_SERVICES[@]}" >&2 2>&1

# ── Wait for the missing services to become healthy ──────────────────
for i in $(seq 1 60); do
  all_ok=true
  for svc in "${MISSING_SERVICES[@]}"; do
    case "$svc" in
      tei-embed)      [ "$(check_health 39281)" = "200" ] || all_ok=false ;;
      tei-rerank)     [ "$(check_health 39282)" = "200" ] || all_ok=false ;;
      tei-code-embed) [ "$(check_health 39283)" = "200" ] || all_ok=false ;;
    esac
  done

  if $all_ok; then
    cat <<EOF
{"additionalContext": "TEI inference containers started successfully (embed :39281, rerank :39282, code-embed :39283). Ready for indexing and search."}
EOF
    exit 0
  fi

  sleep 3
done

# ── Partial success or timeout ───────────────────────────────────────
embed_final=$(check_health 39281)
rerank_final=$(check_health 39282)
code_embed_final=$(check_health 39283)

cat <<EOF
{"additionalContext": "TEI containers partially ready after 3 minutes. embed=${embed_final} rerank=${rerank_final} code-embed=${code_embed_final}. Some services may still be loading models. Run ./start-tei.sh to check status."}
EOF
exit 0
