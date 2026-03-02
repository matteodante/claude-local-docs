#!/usr/bin/env bash
# ensure-tei.sh — SessionStart hook: ensure TEI is running with GPU acceleration.
# Supports NVIDIA GPU (Docker) and Apple Silicon Metal (native).
# No CPU fallback — GPU is mandatory.
#
# Output: JSON with additionalContext for Claude's context window.

set -euo pipefail

PLUGIN_DIR="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PID_FILE="$PLUGIN_DIR/.tei-pids"

PORTS=(39281 39282 39283)
PORT_NAMES=("embed" "rerank" "code-embed")
SERVICE_NAMES=("tei-embed" "tei-rerank" "tei-code-embed")

# ── Health check ─────────────────────────────────────────────────────
check_health() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$1/health" 2>/dev/null) || code="000"
  echo "$code"
}

# ── Step 1: Early exit if all 3 healthy ──────────────────────────────
embed_ok=$(check_health 39281)
rerank_ok=$(check_health 39282)
code_embed_ok=$(check_health 39283)

if [ "$embed_ok" = "200" ] && [ "$rerank_ok" = "200" ] && [ "$code_embed_ok" = "200" ]; then
  cat <<'EOF'
{"additionalContext": "TEI inference backends are running and healthy (embed :39281, rerank :39282, code-embed :39283)."}
EOF
  exit 0
fi

# ── Step 2: Detect platform ─────────────────────────────────────────
BACKEND=""

if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
  BACKEND="docker-nvidia"
elif [[ "$(uname -s 2>/dev/null)" == "Darwin" ]] && [[ "$(uname -m 2>/dev/null)" == "arm64" ]]; then
  BACKEND="metal"
fi

if [ -z "$BACKEND" ]; then
  cat <<'EOF'
{"additionalContext": "ERROR: No supported GPU detected. claude-local-docs requires an NVIDIA GPU (Docker) or Apple Silicon Mac (native Metal). CPU mode is not supported. If you have a supported GPU, ensure nvidia-smi is in PATH (NVIDIA) or that you're on an Apple Silicon Mac."}
EOF
  exit 0
fi

# ── Determine which ports are unhealthy ──────────────────────────────
HEALTH=("$embed_ok" "$rerank_ok" "$code_embed_ok")
UNHEALTHY_PORTS=()
UNHEALTHY_INDICES=()

for i in 0 1 2; do
  if [ "${HEALTH[$i]}" != "200" ]; then
    UNHEALTHY_PORTS+=("${PORTS[$i]}")
    UNHEALTHY_INDICES+=("$i")
  fi
done

# ── Step 3: Port conflict detection ──────────────────────────────────
# If health check returned non-000 and non-200, something is listening but not healthy.
# Could be TEI still loading (503) or a foreign process. Check if it's ours.
CONFLICTS=()

is_port_ours() {
  local port="$1"
  if [ "$BACKEND" = "docker-nvidia" ]; then
    # Check if our compose project has containers
    docker compose -f "$PLUGIN_DIR/docker-compose.yml" ps -q 2>/dev/null | grep -q . && return 0
    return 1
  elif [ "$BACKEND" = "metal" ]; then
    # Check if PID file exists with live processes
    [ -f "$PID_FILE" ] || return 1
    while IFS= read -r pid; do
      kill -0 "$pid" 2>/dev/null && return 0
    done < "$PID_FILE"
    return 1
  fi
  return 1
}

for i in "${UNHEALTHY_INDICES[@]}"; do
  port="${PORTS[$i]}"
  health="${HEALTH[$i]}"

  # 000 = connection refused (nothing listening) → port is free, no conflict
  [ "$health" = "000" ] && continue

  # Non-200, non-000 → something is listening. Is it our TEI?
  if ! is_port_ours "$port"; then
    CONFLICTS+=("$port")
  fi
done

if [ ${#CONFLICTS[@]} -gt 0 ]; then
  cat <<EOF
{"additionalContext": "ERROR: Port conflict detected. Ports ${CONFLICTS[*]} are in use by another process (not TEI). Free these ports and restart, or run ./start-tei.sh --stop first."}
EOF
  exit 0
fi

# ── Step 4: Backend-specific startup ─────────────────────────────────

# ── Detect optimal TEI Docker tag from NVIDIA GPU ────────────────────
detect_nvidia_tag() {
  local cc major minor
  cc=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '[:space:]') || return 1
  [ -z "$cc" ] && return 1

  major="${cc%%.*}"
  minor="${cc#*.}"

  case "$major" in
    12) echo "120-1.9" ;;
    10) echo "100-1.9" ;;
     9) echo "hopper-1.9" ;;
     8) case "$minor" in
          9) echo "89-1.9" ;;
          6) echo "86-1.9" ;;
          0) echo "1.9" ;;
          *) echo "cuda-1.9" ;;
        esac ;;
     7) echo "turing-1.9" ;;
     *) echo "cuda-1.9" ;;
  esac
}

start_time=$(date +%s)
MAX_WAIT=170  # 170s max, leaving 10s buffer before 180s hook timeout

if [ "$BACKEND" = "docker-nvidia" ]; then
  # ── Docker NVIDIA path ───────────────────────────────────────────
  if ! command -v docker &>/dev/null; then
    cat <<'EOF'
{"additionalContext": "ERROR: NVIDIA GPU detected but Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ then run ./start-tei.sh"}
EOF
    exit 0
  fi

  if ! docker info &>/dev/null 2>&1; then
    cat <<'EOF'
{"additionalContext": "ERROR: NVIDIA GPU detected but Docker daemon is not running. Start Docker Desktop, then run ./start-tei.sh"}
EOF
    exit 0
  fi

  TEI_TAG=$(detect_nvidia_tag) || TEI_TAG="cuda-1.9"
  export TEI_TAG

  COMPOSE_ARGS=("-f" "$PLUGIN_DIR/docker-compose.yml" "-f" "$PLUGIN_DIR/docker-compose.nvidia.yml")

  # Start only missing services
  MISSING_SERVICES=()
  for i in "${UNHEALTHY_INDICES[@]}"; do
    MISSING_SERVICES+=("${SERVICE_NAMES[$i]}")
  done

  echo "Starting TEI (Docker NVIDIA, tag=$TEI_TAG): ${MISSING_SERVICES[*]}..." >&2
  if ! docker compose "${COMPOSE_ARGS[@]}" up -d "${MISSING_SERVICES[@]}" >&2 2>&1; then
    cat <<'EOF'
{"additionalContext": "ERROR: docker compose up failed. Check Docker logs with: docker compose -f docker-compose.yml -f docker-compose.nvidia.yml logs. You may need to run ./start-tei.sh manually."}
EOF
    exit 0
  fi

elif [ "$BACKEND" = "metal" ]; then
  # ── Metal native path ────────────────────────────────────────────

  # Check if PIDs are alive — if so, TEI may still be loading
  if [ -f "$PID_FILE" ]; then
    all_alive=true
    while IFS= read -r pid; do
      if ! kill -0 "$pid" 2>/dev/null; then
        all_alive=false
        break
      fi
    done < "$PID_FILE"

    if $all_alive; then
      # All processes alive but not all healthy — still loading
      cat <<'EOF'
{"additionalContext": "TEI native Metal processes are running but not yet healthy. Models are still loading — search tools will work once ready. This is normal on first run (~1-2 minutes)."}
EOF
      exit 0
    fi
    # Some/all dead — need to restart the dead ones
  fi

  # Check binary exists
  TEI_BIN=$(command -v text-embeddings-router 2>/dev/null || echo "")
  if [ -z "$TEI_BIN" ]; then
    cat <<'EOF'
{"additionalContext": "ERROR: text-embeddings-router binary not found. Run ./start-tei.sh --metal once to build it (requires Rust from https://rustup.rs). The build takes a few minutes but only needs to happen once."}
EOF
    exit 0
  fi

  # Determine which Metal processes need (re)starting
  # Read existing PIDs if available
  EXISTING_PIDS=("" "" "")
  if [ -f "$PID_FILE" ]; then
    idx=0
    while IFS= read -r pid && [ $idx -lt 3 ]; do
      EXISTING_PIDS[$idx]="$pid"
      idx=$((idx + 1))
    done < "$PID_FILE"
  fi

  # Start missing services with nohup
  NEW_PIDS=("${EXISTING_PIDS[@]}")
  MODELS=("nomic-ai/nomic-embed-text-v1.5" "cross-encoder/ms-marco-MiniLM-L-6-v2" "Qodo/Qodo-Embed-1-1.5B")
  BATCH_ARGS=("--max-client-batch-size 64" "" "--max-client-batch-size 8")
  STARTED=()

  for i in "${UNHEALTHY_INDICES[@]}"; do
    port="${PORTS[$i]}"
    existing_pid="${EXISTING_PIDS[$i]}"

    # Kill dead process if it exists
    if [ -n "$existing_pid" ]; then
      kill "$existing_pid" 2>/dev/null || true
    fi

    echo "Starting TEI ${PORT_NAMES[$i]} (Metal) on :${port}..." >&2
    # shellcheck disable=SC2086
    nohup "$TEI_BIN" --model-id "${MODELS[$i]}" --port "$port" ${BATCH_ARGS[$i]} \
      > "$PLUGIN_DIR/.tei-${PORT_NAMES[$i]}.log" 2>&1 &
    NEW_PIDS[$i]=$!
    STARTED+=("${PORT_NAMES[$i]}")
  done

  # Write updated PID file
  printf "%s\n" "${NEW_PIDS[@]}" > "$PID_FILE"

  echo "Started Metal TEI: ${STARTED[*]}" >&2
fi

# ── Step 5: Wait for health ──────────────────────────────────────────
while true; do
  elapsed=$(( $(date +%s) - start_time ))
  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    break
  fi

  all_ok=true
  for i in "${UNHEALTHY_INDICES[@]}"; do
    if [ "$(check_health "${PORTS[$i]}")" != "200" ]; then
      all_ok=false
      break
    fi
  done

  if $all_ok; then
    cat <<'EOF'
{"additionalContext": "TEI inference backends started successfully (embed :39281, rerank :39282, code-embed :39283). Ready for indexing and search."}
EOF
    exit 0
  fi

  sleep 3
done

# ── Timeout — non-alarming message ───────────────────────────────────
cat <<'EOF'
{"additionalContext": "TEI is still starting up. On first run, models need to download (~3GB total) which can take a few minutes. Search tools will work once TEI is ready. Run ./start-tei.sh to check status."}
EOF
exit 0
