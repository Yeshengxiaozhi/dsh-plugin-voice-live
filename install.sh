#!/usr/bin/env bash
# One-shot setup for dsh-plugin-voice-live.
#
#   ./install.sh                 # create the venv and install deps
#   ./install.sh --run           # ...then start the local TTS server in the background
#   ./install.sh --run --model mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit
#
# The plugin itself is installed through Harness (Plugin Manager), not from this
# script: the profile owns its own package.json and patch layer, and writing
# those by hand leaves the profile in a state Harness did not produce.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

MODEL="${MODEL:-mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16}"
PORT="${PORT:-8020}"
ASR_PORT="${ASR_PORT:-8031}"
RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run) RUN=1; shift ;;
    --model) MODEL="${2:?--model needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "warning: MLX needs Apple Silicon; this will probably fail on $(uname -m)" >&2
fi

PY="${PYTHON:-}"
if [[ -z "$PY" ]]; then
  if command -v python3.12 >/dev/null 2>&1; then PY=python3.12; else PY=python3; fi
fi

# Keep every cache inside the checkout so nothing lands in $HOME by surprise.
export PIP_CACHE_DIR="$HERE/.pip-cache"
export HF_HOME="${HF_HOME:-$HERE/.hf-cache}"

if [[ ! -d .venv ]]; then
  echo "==> creating .venv with $("$PY" --version 2>&1)"
  "$PY" -m venv .venv
fi

# A venv made by `uv venv` has no pip; bootstrap it rather than assuming.
ensure_pip() {
  if .venv/bin/python -m pip --version >/dev/null 2>&1; then
    return 0
  fi
  echo "==> bootstrapping pip in .venv"
  if .venv/bin/python -m ensurepip --upgrade >/dev/null 2>&1 && \
     .venv/bin/python -m pip --version >/dev/null 2>&1; then
    return 0
  fi
  if command -v uv >/dev/null 2>&1; then
    echo "==> ensurepip unavailable, falling back to uv"
    UV_PIP=1
    return 0
  fi
  echo "error: cannot find pip or uv; install one and retry" >&2
  exit 1
}

echo "==> installing python dependencies (first run downloads a few hundred MB)"
ensure_pip
if [[ "${UV_PIP:-0}" == "1" ]]; then
  export UV_CACHE_DIR="$HERE/.uv-cache"
  uv pip install --python .venv/bin/python --quiet -r tools/requirements.txt
else
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -r tools/requirements.txt
fi

if ! .venv/bin/python -c "import mlx_audio" 2>/dev/null; then
  echo "error: mlx_audio did not install correctly" >&2
  exit 1
fi
echo "==> dependencies ready"

if [[ "$RUN" == "1" ]]; then
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "error: port $PORT is already in use; stop that process or pass --port" >&2
    exit 1
  fi
  echo "==> starting ASR server on 127.0.0.1:$ASR_PORT (log: asr.log)"
  nohup .venv/bin/python tools/asr_server.py --port "$ASR_PORT" > asr.log 2>&1 &
  echo "==> starting TTS server on 127.0.0.1:$PORT (log: tts.log)"
  nohup .venv/bin/python tools/tts_server.py --backend mlx --model "$MODEL" --port "$PORT" \
    > tts.log 2>&1 &
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "==> server ready: http://127.0.0.1:$PORT"
      break
    fi
    sleep 2
  done
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 \
    || { echo "error: server did not come up; see tts.log" >&2; exit 1; }
fi

cat <<EOF

Next:
  1. In Harness, open Settings -> Plugins and install this folder as a bundle:
     $HERE
     (the agent can also run: plugin_manager install_bundle $HERE)
  2. Refresh the Harness page and click the blue "Voice" pill under the composer.
     Settings in that panel let you point at a different TTS/ASR address.

EOF
