#!/usr/bin/env python3
"""OpenAI-compatible TTS endpoint for Qwen3-TTS, tuned for Apple Silicon.

    pip install -U qwen-tts
    python3 tools/tts_server.py --dry-run          # tone only, no model
    python3 tools/tts_server.py                     # real synthesis

POST /v1/audio/speech
    {"input": "...", "voice": "Vivian", "language": "Chinese", "response_format": "pcm"}
  -> raw signed-16-bit little-endian mono PCM, sample rate in the X-Sample-Rate header

GET /health -> {"ok": true, "model": ..., "sampleRate": ..., "dryRun": ...}

The endpoint sets permissive CORS headers because the Harness Web UI calls it
from http://127.0.0.1:<port>, a different origin from this server.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {
    "model": None,
    "model_id": None,
    "sample_rate": 24000,
    "device": None,
    "backend": "torch",
    "dry_run": False,
    "temperature": 0.55,
    "streaming_interval": 0.5,
    "stream_audio": False,
    "lock": threading.Lock(),
}

LANGUAGES = {
    "chinese": "Chinese",
    "zh": "Chinese",
    "中文": "Chinese",
    "english": "English",
    "en": "English",
    "japanese": "Japanese",
    "ja": "Japanese",
    "korean": "Korean",
    "ko": "Korean",
    "auto": "Auto",
}


def log(message: str) -> None:
    print(f"[tts] {message}", flush=True)


def load_model(model_id: str, device: str, dtype: str) -> None:
    import torch
    from qwen_tts import Qwen3TTSModel

    torch_dtype = getattr(torch, dtype)
    log(f"loading {model_id} on {device} ({dtype}) ...")
    try:
        model = Qwen3TTSModel.from_pretrained(
            model_id,
            device_map=device,
            dtype=torch_dtype,
        )
    except Exception as exc:  # device_map may reject 'mps' on older accelerate
        log(f"load with device_map={device!r} failed ({exc}); retrying on cpu")
        device = "cpu"
        model = Qwen3TTSModel.from_pretrained(
            model_id,
            device_map="cpu",
            dtype=torch_dtype,
        )
        try:
            model.to("cpu")
        except Exception:
            pass

    STATE["model"] = model
    STATE["model_id"] = model_id
    STATE["device"] = device
    log("model ready")


def load_mlx(model_id: str) -> None:
    from mlx_audio.tts.utils import load_model as mlx_load

    log(f"loading {model_id} with MLX ...")
    STATE["model"] = mlx_load(model_id)
    STATE["model_id"] = model_id
    STATE["backend"] = "mlx"
    STATE["device"] = "mlx"
    log("model ready (MLX)")


def to_numpy(wave):
    try:
        import numpy as np
    except ImportError as exc:  # qwen-tts pulls numpy in, so this is a real problem
        raise RuntimeError("numpy is required") from exc

    if hasattr(wave, "detach"):
        wave = wave.detach().cpu().float().numpy()
    array = np.asarray(wave, dtype="float32")
    return np.squeeze(array)


def trim_pcm(pcm: bytes, rate: int, keep_ms: float = 0.03, thresh: float = 0.006) -> bytes:
    """Drop the leading/trailing silence the model pads each segment with.

    Without this every sentence is separated by ~0.5s of nothing, which reads as
    an unnatural pause at each full stop.
    """
    import numpy as np

    samples = np.frombuffer(pcm, dtype="<i2")
    if samples.size == 0:
        return pcm
    loud = np.abs(samples) > int(thresh * 32767)
    if not loud.any():
        return pcm
    index = np.nonzero(loud)[0]
    pad = int(rate * keep_ms / 1000)
    start = max(0, int(index[0]) - pad)
    end = min(samples.size, int(index[-1]) + pad)
    return samples[start:end].tobytes()


def iter_pcm(text: str, voice: str, language: str, instruct: str | None, stream_audio=None):
    """Yield (sample_rate, raw_pcm) as soon as each piece is ready."""
    import numpy as np

    if STATE["dry_run"]:
        rate = STATE["sample_rate"]
        seconds = max(0.35, min(2.0, len(text) / 9.0))
        total = int(rate * seconds)
        frames = bytearray()
        for i in range(total):
            envelope = min(1.0, i / (rate * 0.05), (total - i) / (rate * 0.08))
            value = int(9000 * envelope * math.sin(2 * math.pi * 440 * i / rate))
            frames += struct.pack("<h", value)
        yield rate, bytes(frames)
        return

    model = STATE["model"]
    if model is None:
        raise RuntimeError("model is not loaded")

    def to_pcm(array) -> bytes:
        pcm = np.clip(np.asarray(array, dtype="float32").reshape(-1), -1.0, 1.0)
        return (pcm * 32767.0).astype("<i2").tobytes()

    if STATE["backend"] == "mlx":
        # Chunked *decode* is what makes a single sentence sound like several
        # speakers: every streaming boundary leaves a seam. Only enable it when
        # first-sound latency matters more than one continuous voice.
        use_stream = STATE["stream_audio"] if stream_audio is None else bool(stream_audio)
        with STATE["lock"]:
            results = model.generate(
                text=text,
                voice=voice,
                lang_code=language,
                instruct=instruct or None,
                temperature=STATE["temperature"],
                stream=use_stream,
                streaming_interval=STATE["streaming_interval"],
            )
            for result in results:
                rate = int(getattr(result, "sample_rate", STATE["sample_rate"]) or 24000)
                STATE["sample_rate"] = rate
                pcm = to_pcm(result.audio)
                if not use_stream:
                    pcm = trim_pcm(pcm, rate)
                yield rate, pcm
        return

    with STATE["lock"]:
        wavs, sample_rate = model.generate_custom_voice(
            text=text,
            language=language,
            speaker=voice,
            **({"instruct": instruct} if instruct else {}),
        )
    STATE["sample_rate"] = int(sample_rate)
    yield int(sample_rate), to_pcm(to_numpy(wavs[0]))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "qwen3-tts-local/0.1"

    def log_message(self, fmt: str, *args) -> None:  # quieter access log
        if "health" in (fmt % args):
            return
        log(fmt % args)

    def cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
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
            {
                "ok": True,
                "model": STATE["model_id"],
                "device": STATE["device"],
                "backend": STATE["backend"],
                "sampleRate": STATE["sample_rate"],
                "dryRun": STATE["dry_run"],
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/v1/audio/speech":
            self.send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception as exc:
            self.send_json(400, {"error": f"bad request body: {exc}"})
            return

        text = str(payload.get("input") or "").strip()
        if not text:
            self.send_json(400, {"error": "input is required"})
            return

        voice = str(payload.get("voice") or "Vivian")
        language = LANGUAGES.get(str(payload.get("language") or "Chinese").lower(), "Chinese")
        instruct = payload.get("instruct")
        instruct = str(instruct) if instruct else None

        rate = STATE["sample_rate"]
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "audio/L16")
        self.send_header("X-Sample-Rate", str(rate))
        self.send_header("X-Channels", "1")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        try:
            for chunk_rate, pcm in iter_pcm(
                text, voice, language, instruct, payload.get("stream_audio")
            ):
                if not pcm:
                    continue
                self.wfile.write(b"%x\r\n" % len(pcm))
                self.wfile.write(pcm)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            log("client went away mid-stream")
        except Exception as exc:
            log(f"synthesis failed mid-stream: {exc}")
            traceback.print_exc()
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Qwen3-TTS OpenAI-compatible endpoint")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8020)
    parser.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    parser.add_argument("--device", default="mps", help="mps, cpu, cuda:0 (torch backend)")
    parser.add_argument("--dtype", default="float32", help="float32, float16, bfloat16 (torch backend)")
    parser.add_argument(
        "--backend",
        default="torch",
        choices=["torch", "mlx"],
        help="mlx is several times faster on Apple Silicon; torch is the reference path",
    )
    parser.add_argument("--temperature", type=float, default=0.55, help="sampling temperature; lower = steadier voice")
    parser.add_argument("--streaming-interval", type=float, default=0.5, help="seconds of audio per streamed chunk")
    parser.add_argument(
        "--stream-audio",
        action="store_true",
        help="decode in chunks for the earliest first sound; leaves a seam at each boundary",
    )
    parser.add_argument("--dry-run", action="store_true", help="return a tone instead of speech")
    args = parser.parse_args()

    STATE["dry_run"] = args.dry_run
    STATE["temperature"] = args.temperature
    STATE["streaming_interval"] = args.streaming_interval
    STATE["stream_audio"] = args.stream_audio
    if args.dry_run:
        log("dry-run mode: returning a tone, no model will be loaded")
    elif args.backend == "mlx":
        try:
            load_mlx(args.model)
        except Exception as exc:
            log(f"cannot load the MLX model: {exc}")
            log("install it with: pip install -U mlx-audio")
            return 1
    else:
        try:
            load_model(args.model, args.device, args.dtype)
        except Exception as exc:
            log(f"cannot load the model: {exc}")
            log("install it with: pip install -U qwen-tts")
            return 1

    server = ThreadingHTTPServer((args.host, args.port), Handler)

    if not args.dry_run and STATE["backend"] == "mlx":
        try:
            started = time.time()
            for _ in iter_pcm("你好。", "Vivian", "Chinese", None):
                pass
            log(f"warmup complete in {time.time() - started:.2f}s")
        except Exception as exc:
            log(f"warmup skipped: {exc}")

    log(f"listening on http://{args.host}:{args.port}")
    log(f"endpoint  POST http://{args.host}:{args.port}/v1/audio/speech")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
