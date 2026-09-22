#!/usr/bin/env python3
"""
Mantella-style voice sidecar for maincraft companion.

STT: faster-whisper (excellent Russian)
TTS primary: edge-tts Neural RU (most natural free Russian)
TTS offline: Silero (optional, if torch installed)
TTS fallback: Windows SAPI via powershell (last resort)

LLM summarization stays in Node (Opus/cheat-ai) — this service is audio only.

Run:
  cd D:\\maincraft\\voice
  .\\.venv\\Scripts\\activate
  python server.py
"""
from __future__ import annotations

import asyncio
import base64
import io
import os
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Literal, Optional

import numpy as np

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)

HOST = os.environ.get("VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_PORT", "8765"))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")  # tiny|base|small|medium|large-v3
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")  # cpu|cuda
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")  # int8|float16|float32
DEFAULT_TTS = os.environ.get("TTS_ENGINE", "edge")  # edge|silero|sapi
DEFAULT_EDGE_VOICE = os.environ.get(
    "EDGE_VOICE", "ru-RU-SvetlanaNeural"
)  # or ru-RU-DmitryNeural
SILERO_SPEAKER = os.environ.get("SILERO_SPEAKER", "xenia")  # aidar|baya|kseniya|xenia|eugene

# ---------------------------------------------------------------------------
# Lazy models
# ---------------------------------------------------------------------------
_whisper = None
_silero = None
_silero_sample_rate = 48000


def get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        print(f"[voice] loading faster-whisper model={WHISPER_MODEL} device={WHISPER_DEVICE}…")
        _whisper = WhisperModel(
            WHISPER_MODEL,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE,
        )
        print("[voice] whisper ready")
    return _whisper


def get_silero():
    global _silero, _silero_sample_rate
    if _silero is None:
        import torch

        print("[voice] loading Silero TTS (ru)…")
        model, example = torch.hub.load(
            repo_or_dir="snakers4/silero-models",
            model="silero_tts",
            language="ru",
            speaker="v5_ru",
            trust_repo=True,
        )
        _silero = model
        _silero_sample_rate = 48000
        print("[voice] silero ready")
    return _silero


# ---------------------------------------------------------------------------
# STT
# ---------------------------------------------------------------------------
def stt_from_wav_bytes(data: bytes, language: str = "ru") -> dict[str, Any]:
    import soundfile as sf

    bio = io.BytesIO(data)
    audio, sr = sf.read(bio, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    # whisper expects 16k
    if sr != 16000:
        # simple resample
        duration = len(audio) / float(sr)
        target_len = int(duration * 16000)
        x_old = np.linspace(0, 1, num=len(audio), endpoint=False)
        x_new = np.linspace(0, 1, num=target_len, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
        sr = 16000

    model = get_whisper()
    segments, info = model.transcribe(
        audio,
        language=language or "ru",
        beam_size=5,
        vad_filter=True,
    )
    parts = []
    for seg in segments:
        parts.append(seg.text.strip())
    text = " ".join(parts).strip()
    return {
        "ok": True,
        "text": text,
        "language": getattr(info, "language", language),
        "duration": float(getattr(info, "duration", 0) or 0),
        "engine": f"faster-whisper:{WHISPER_MODEL}",
    }


def stt_from_mic(seconds: float = 5.0, language: str = "ru") -> dict[str, Any]:
    import sounddevice as sd
    import soundfile as sf

    sr = 16000
    seconds = max(1.0, min(float(seconds), 30.0))
    print(f"[voice] recording mic {seconds}s…")
    audio = sd.rec(int(seconds * sr), samplerate=sr, channels=1, dtype="float32")
    sd.wait()
    audio = audio.reshape(-1)
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    return stt_from_wav_bytes(buf.getvalue(), language=language)


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------
async def tts_edge(text: str, voice: str, out_path: Path) -> dict[str, Any]:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice=voice)
    await communicate.save(str(out_path))
    return {
        "ok": True,
        "path": str(out_path),
        "engine": "edge-tts",
        "voice": voice,
    }


def tts_silero(text: str, speaker: str, out_path: Path) -> dict[str, Any]:
    import torch
    import soundfile as sf

    model = get_silero()
    # Silero API: model.apply_tts(text=..., speaker=..., sample_rate=...)
    audio = model.apply_tts(
        text=text,
        speaker=speaker,
        sample_rate=_silero_sample_rate,
    )
    if hasattr(audio, "numpy"):
        wav = audio.numpy()
    else:
        wav = np.array(audio, dtype=np.float32)
    sf.write(str(out_path), wav, _silero_sample_rate)
    return {
        "ok": True,
        "path": str(out_path),
        "engine": "silero",
        "voice": speaker,
    }


def tts_sapi(text: str, out_path: Path) -> dict[str, Any]:
    """Windows SAPI → wav via PowerShell (last resort)."""
    safe = text.replace("'", "''")[:400]
    # Generate WAV with System.Speech
    ps = f"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile('{str(out_path).replace(chr(39), chr(39)+chr(39))}')
$s.Rate = 0
$s.Speak([string]@'
{safe}
'@)
$s.Dispose()
"""
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        check=False,
        capture_output=True,
        timeout=60,
    )
    if not out_path.exists() or out_path.stat().st_size < 44:
        return {"ok": False, "error": "sapi produced no audio"}
    return {"ok": True, "path": str(out_path), "engine": "sapi", "voice": "windows"}


async def synthesize(
    text: str,
    engine: str = DEFAULT_TTS,
    voice: Optional[str] = None,
) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "empty text"}
    # Minecraft chat is short; clamp for voice
    text = text[:500]
    stamp = int(time.time() * 1000)
    out_path = OUT_DIR / f"tts_{stamp}.wav"

    engines_try = []
    e = (engine or "edge").lower()
    if e == "edge":
        engines_try = ["edge", "silero", "sapi"]
    elif e == "silero":
        engines_try = ["silero", "edge", "sapi"]
    elif e == "sapi":
        engines_try = ["sapi"]
    else:
        engines_try = ["edge", "silero", "sapi"]

    errors = []
    for eng in engines_try:
        try:
            if eng == "edge":
                v = voice or DEFAULT_EDGE_VOICE
                return await tts_edge(text, v, out_path.with_suffix(".mp3"))
            if eng == "silero":
                v = voice or SILERO_SPEAKER
                return tts_silero(text, v, out_path)
            if eng == "sapi":
                return tts_sapi(text, out_path)
        except Exception as ex:
            errors.append(f"{eng}: {ex}")
            traceback.print_exc()
            continue
    return {"ok": False, "error": "; ".join(errors) or "all engines failed"}


def play_file(path: str) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        return {"ok": False, "error": "file missing"}
    try:
        import sounddevice as sd
        import soundfile as sf

        data, sr = sf.read(str(p), dtype="float32")
        sd.play(data, sr)
        sd.wait()
        return {"ok": True, "played": str(p)}
    except Exception as ex:
        # Windows fallback
        try:
            os.startfile(str(p))  # type: ignore[attr-defined]
            return {"ok": True, "played": str(p), "via": "startfile"}
        except Exception as ex2:
            return {"ok": False, "error": f"{ex}; {ex2}"}


# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------
def create_app():
    from fastapi import FastAPI, File, Form, UploadFile, Request
    from fastapi.responses import FileResponse, JSONResponse

    app = FastAPI(title="maincraft-voice", version="1.0.0")

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "whisper_model": WHISPER_MODEL,
            "default_tts": DEFAULT_TTS,
            "edge_voice": DEFAULT_EDGE_VOICE,
            "silero_speaker": SILERO_SPEAKER,
            "engines": {
                "stt": "faster-whisper",
                "tts": ["edge-tts (best RU neural)", "silero (offline RU)", "sapi (fallback)"],
            },
            "note": "Piper skipped as primary: weaker natural Russian. edge-tts = живой голос.",
        }

    @app.get("/voices")
    async def voices():
        """List edge-tts Russian voices."""
        try:
            import edge_tts

            all_v = await edge_tts.list_voices()
            ru = [v for v in all_v if str(v.get("Locale", "")).startswith("ru")]
            return {"ok": True, "russian": ru, "recommended": [
                "ru-RU-SvetlanaNeural",
                "ru-RU-DmitryNeural",
            ]}
        except Exception as ex:
            return {"ok": False, "error": str(ex)}

    @app.post("/tts")
    async def tts(data: dict):
        # plain dict body — avoids FastAPI Request/Form quirks on some versions
        text = str((data or {}).get("text") or "")
        engine = str((data or {}).get("engine") or DEFAULT_TTS)
        voice = (data or {}).get("voice")
        play = bool((data or {}).get("play", True))
        result = await synthesize(text, engine=engine, voice=voice)
        if not result.get("ok"):
            return JSONResponse(result, status_code=500)
        if play:
            play_file(result["path"])
        try:
            raw = Path(result["path"]).read_bytes()
            result["b64"] = base64.b64encode(raw).decode("ascii")
            result["bytes"] = len(raw)
        except Exception:
            pass
        return result

    @app.post("/stt/mic")
    async def stt_mic(data: dict | None = None):
        data = data or {}
        try:
            return stt_from_mic(
                seconds=float(data.get("seconds") or 5),
                language=str(data.get("language") or "ru"),
            )
        except Exception as ex:
            traceback.print_exc()
            return JSONResponse({"ok": False, "error": str(ex)}, status_code=500)

    @app.post("/stt/file")
    async def stt_file(
        file: UploadFile = File(...),
        language: str = Form("ru"),
    ):
        try:
            data = await file.read()
            return stt_from_wav_bytes(data, language=language)
        except Exception as ex:
            traceback.print_exc()
            return JSONResponse({"ok": False, "error": str(ex)}, status_code=500)

    @app.get("/file")
    def get_file(path: str):
        p = Path(path)
        if not p.exists() or OUT_DIR not in p.resolve().parents and p.parent != OUT_DIR:
            # only serve from OUT_DIR
            if p.parent.resolve() != OUT_DIR.resolve():
                return JSONResponse({"ok": False, "error": "forbidden"}, status_code=403)
        return FileResponse(p)

    return app


def main():
    import uvicorn

    print(
        f"""
╔══════════════════════════════════════════════════════════╗
║  maincraft voice sidecar                                 ║
║  STT: faster-whisper ({WHISPER_MODEL})                   ║
║  TTS: edge-tts RU neural (default) → silero → sapi       ║
║  http://{HOST}:{PORT}/health                             ║
╚══════════════════════════════════════════════════════════╝
"""
    )
    # warm whisper optionally
    if os.environ.get("VOICE_PRELOAD", "1") == "1":
        try:
            get_whisper()
        except Exception as ex:
            print(f"[voice] whisper preload failed (will retry on first STT): {ex}")

    app = create_app()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
