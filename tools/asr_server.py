#!/usr/bin/env python3
"""Local ASR endpoint backed by Qwen3-ASR on MLX.

    python3 tools/asr_server.py

POST /v1/audio/transcriptions?language=Chinese
    body: raw WAV bytes (16 kHz mono is what the web client records)
  -> {"text": "...", "seconds": 1.2, "elapsed": 0.35}

GET /health -> {"ok": true, "model": ..., "language": ...}

The web client speaks this shape directly, so the plugin needs no Harness
speech provider and no `remote.speech` namespace.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {
    "model": None,
    "model_id": None,
    "language": "Chinese",
    "lock": threading.Lock(),
}

LANGUAGES = {
    "zh": "Chinese",
    "chinese": "Chinese",
    "中文": "Chinese",
    "en": "English",
    "english": "English",
    "ja": "Japanese",
    "japanese": "Japanese",
    "ko": "Korean",
    "korean": "Korean",
}


def log(message: str) -> None:
    print(f"[asr] {message}", flush=True)


def load_model(model_id: str) -> None:
    from mlx_audio.stt import load

    log(f"loading {model_id} ...")
    STATE["model"] = load(model_id)
    STATE["model_id"] = model_id
    log("model ready")


def transcribe(wav_bytes: bytes, language: str) -> dict:
    model = STATE["model"]
    if model is None:
        raise RuntimeError("model is not loaded")

    # mlx-audio reads from a path; a temp file keeps the model API untouched.
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as handle:
        handle.write(wav_bytes)
        handle.flush()
        started = time.time()
        with STATE["lock"]:
            result = model.generate(handle.name, language=language)
        elapsed = time.time() - started

    text = getattr(result, "text", None)
    if text is None:
        text = str(result)

    try:
        with wave.open(__import__("io").BytesIO(wav_bytes)) as wav:
            seconds = wav.getnframes() / float(wav.getframerate() or 1)
    except Exception:
        seconds = 0.0

    return {"text": text.strip(), "seconds": round(seconds, 2), "elapsed": round(elapsed, 2)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "qwen3-asr-local/0.1"

    def log_message(self, fmt: str, *args) -> None:
        if "health" in (fmt % args):
            return
        log(fmt % args)

    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/health":
            self.send_json(404, {"error": "not found"})
            return
        self.send_json(
            200,
            {"ok": True, "model": STATE["model_id"], "language": STATE["language"]},
        )

    def do_POST(self) -> None:  # noqa: N802
        path, _, query = self.path.partition("?")
        if path != "/v1/audio/transcriptions":
            self.send_json(404, {"error": "not found"})
            return

        language = STATE["language"]
        for pair in query.split("&"):
            key, _, value = pair.partition("=")
            if key == "language" and value:
                language = LANGUAGES.get(value.lower(), STATE["language"])

        try:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0:
                self.send_json(400, {"error": "empty body"})
                return
            body = self.rfile.read(length)
        except Exception as exc:
            self.send_json(400, {"error": f"bad request: {exc}"})
            return

        try:
            value = transcribe(body, language)
        except Exception as exc:
            log(f"transcription failed: {exc}")
            traceback.print_exc()
            self.send_json(500, {"error": f"transcription failed: {exc}"})
            return

        self.send_json(200, value)


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Qwen3-ASR endpoint")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8031)
    parser.add_argument("--model", default="mlx-community/Qwen3-ASR-0.6B-8bit")
    parser.add_argument("--language", default="Chinese")
    args = parser.parse_args()

    STATE["language"] = LANGUAGES.get(args.language.lower(), args.language)

    try:
        load_model(args.model)
    except Exception as exc:
        log(f"cannot load the model: {exc}")
        log("install it with: pip install -U mlx-audio")
        return 1

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"listening on http://{args.host}:{args.port}")
    log(f"endpoint  POST http://{args.host}:{args.port}/v1/audio/transcriptions")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
