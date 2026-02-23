#!/usr/bin/env bash
# start-tei.sh — Auto-detect GPU and start TEI with the optimal backend.
#
# Usage:
#   ./start-tei.sh            # auto-detect (NVIDIA GPU → Docker, Apple Silicon → Metal native, else CPU Docker)
#   ./start-tei.sh --metal    # force native Metal build (macOS Apple Silicon)
#   ./start-tei.sh --cpu      # force CPU Docker
#   ./start-tei.sh --tag 89-1.9  # force a specific TEI Docker image tag
#   ./start-tei.sh --stop     # stop all running TEI (Docker + native)
#
# NVIDIA architecture → optimized TEI Docker image:
#   12.x  Blackwell  RTX 50x0          → 120-1.9
#   10.x  Blackwell  B200              → 100-1.9  (experimental)
#    9.x  Hopper     H100/H200         → hopper-1.9
#    8.9  Ada        RTX 40x0 / L4     → 89-1.9
#    8.6  Ampere     RTX 30x0 / A10    → 86-1.9
#    8.0  Ampere     A100              → 1.9
#    7.5  Turing     T4 / RTX 20x0    → turing-1.9 (experimental)
#    *    fallback                      → cuda-1.9
#
# Apple Silicon → native Metal build via cargo (no Docker)

set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=".tei-pids"
TEI_REPO="https://github.com/huggingface/text-embeddings-inference"
TEI_CLONE_DIR="${TEI_CLONE_DIR:-/tmp/text-embeddings-inference}"

# ── Arg parsing ──────────────────────────────────────────────────────
MODE=""         # auto | metal | cpu | tag | stop
FORCE_TAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --metal) MODE="metal"; shift ;;
    --cpu)   MODE="cpu"; shift ;;
    --tag)   MODE="tag"; FORCE_TAG="$2"; shift 2 ;;
    --stop)  MODE="stop"; shift ;;
    *)       echo "Unknown option: $1"; exit 1 ;;
  esac
done

[ -z "$MODE" ] && MODE="auto"

# ── Stop all TEI processes ───────────────────────────────────────────
stop_tei() {
  local stopped=false

  # Stop native processes
  if [ -f "$PID_FILE" ]; then
    echo "Stopping native TEI processes..."
    while IFS= read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        stopped=true
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi

  # Stop Docker containers
  if docker compose -f docker-compose.yml -f docker-compose.nvidia.yml ps -q 2>/dev/null | grep -q .; then
    echo "Stopping Docker TEI containers..."
    docker compose -f docker-compose.yml -f docker-compose.nvidia.yml down 2>/dev/null || true
    stopped=true
  elif docker compose ps -q 2>/dev/null | grep -q .; then
    echo "Stopping Docker TEI containers..."
    docker compose down 2>/dev/null || true
    stopped=true
  fi

  if $stopped; then
    echo "Stopped."
  else
    echo "No running TEI processes found."
  fi
}

if [ "$MODE" = "stop" ]; then
  stop_tei
  exit 0
fi

# Stop any existing TEI before starting new ones
stop_tei 2>/dev/null || true

# ── Detect best TEI tag for NVIDIA GPU ───────────────────────────────
detect_nvidia_tag() {
  local cc major minor
  cc=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '[:space:]') || return 1
  [ -z "$cc" ] && return 1

  major="${cc%%.*}"
  minor="${cc#*.}"

  case "$major" in
    12) echo "120-1.9" ;;      # Blackwell RTX 50x0
    10) echo "100-1.9" ;;      # Blackwell B200
     9) echo "hopper-1.9" ;;   # Hopper
     8) case "$minor" in
          9) echo "89-1.9" ;;  # Ada Lovelace
          6) echo "86-1.9" ;;  # Ampere A10/A40
          0) echo "1.9" ;;     # Ampere A100
          *) echo "cuda-1.9" ;;
        esac ;;
     7) echo "turing-1.9" ;;   # Turing
     *) echo "cuda-1.9" ;;     # Unknown — generic CUDA
  esac
}

# ── Metal: native macOS build ────────────────────────────────────────
start_metal() {
  local TEI_BIN
  TEI_BIN=$(command -v text-embeddings-router 2>/dev/null || echo "")

  if [ -z "$TEI_BIN" ]; then
    echo "text-embeddings-router not found. Building with Metal support..."

    if ! command -v cargo &>/dev/null; then
      echo "Error: Rust is required. Install from https://rustup.rs"
      exit 1
    fi

    if [ -d "$TEI_CLONE_DIR" ]; then
      echo "Updating TEI source..."
      git -C "$TEI_CLONE_DIR" pull --ff-only
    else
      echo "Cloning TEI..."
      git clone "$TEI_REPO" "$TEI_CLONE_DIR"
    fi

    echo "Building text-embeddings-router with Metal (this may take a few minutes)..."
    cargo install --path "$TEI_CLONE_DIR/router" --features metal
    TEI_BIN=$(command -v text-embeddings-router)
  fi

  echo "┌─────────────────────────────────────────────┐"
  echo "│  Backend: Metal (native macOS)"
  echo "│  Binary:  $TEI_BIN"
  echo "└─────────────────────────────────────────────┘"

  rm -f "$PID_FILE"

  echo "Starting TEI embed (Metal) on :39281..."
  "$TEI_BIN" --model-id nomic-ai/nomic-embed-text-v1.5 --port 39281 --max-client-batch-size 64 &
  echo $! >> "$PID_FILE"

  echo "Starting TEI rerank (Metal) on :39282..."
  "$TEI_BIN" --model-id cross-encoder/ms-marco-MiniLM-L-6-v2 --port 39282 &
  echo $! >> "$PID_FILE"

  wait_for_health
}

# ── Docker: NVIDIA or CPU ────────────────────────────────────────────
start_docker() {
  local COMPOSE_FILES=("-f" "docker-compose.yml")
  local GPU_NAME=""
  local TEI_TAG

  if [ "$MODE" = "tag" ]; then
    TEI_TAG="$FORCE_TAG"
    if [[ "$TEI_TAG" != cpu-* ]]; then
      COMPOSE_FILES+=("-f" "docker-compose.nvidia.yml")
    fi
  elif [ "$MODE" = "cpu" ]; then
    TEI_TAG="cpu-1.9"
  elif command -v nvidia-smi &>/dev/null; then
    local TAG
    TAG=$(detect_nvidia_tag) || TAG=""
    if [ -n "$TAG" ]; then
      TEI_TAG="$TAG"
      GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | xargs)
      COMPOSE_FILES+=("-f" "docker-compose.nvidia.yml")
    else
      TEI_TAG="cpu-1.9"
    fi
  else
    TEI_TAG="cpu-1.9"
  fi

  export TEI_TAG

  echo "┌─────────────────────────────────────────────┐"
  if [ -n "$GPU_NAME" ]; then
    echo "│  GPU:      $GPU_NAME"
  fi
  echo "│  Backend:  Docker"
  echo "│  Tag:      $TEI_TAG"
  echo "│  Compose:  ${COMPOSE_FILES[*]}"
  echo "└─────────────────────────────────────────────┘"

  docker compose "${COMPOSE_FILES[@]}" up -d

  wait_for_health
}

# ── Health check loop ────────────────────────────────────────────────
wait_for_health() {
  echo ""
  echo "Waiting for TEI to be ready..."
  for i in $(seq 1 120); do
    embed=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:39281/health 2>/dev/null || true)
    rerank=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:39282/health 2>/dev/null || true)
    if [ "$embed" = "200" ] && [ "$rerank" = "200" ]; then
      printf "\n"
      echo "Ready! embed=OK rerank=OK"
      return 0
    fi
    printf "\r  [%3d] embed=%s rerank=%s" "$i" "$embed" "$rerank"
    sleep 3
  done

  printf "\n"
  echo "Warning: TEI did not become healthy within 6 minutes."
  return 1
}

# ── Main ─────────────────────────────────────────────────────────────
case "$MODE" in
  metal)
    start_metal
    ;;
  auto)
    # Auto-detect: NVIDIA → Docker GPU, Apple Silicon → Metal native, else → Docker CPU
    if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
      start_docker
    elif [[ "$(uname -s)" == "Darwin" ]] && [[ "$(uname -m)" == "arm64" ]]; then
      echo "Detected Apple Silicon — using native Metal backend"
      start_metal
    else
      start_docker
    fi
    ;;
  *)
    start_docker
    ;;
esac
