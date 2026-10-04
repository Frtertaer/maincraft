#!/usr/bin/env python3
"""Laya decision-model sidecar for the maincraft agent.

Wraps convaiinnovations/laya in a tiny stdlib HTTP server so the Node bot
can query it without depending on a Python runtime inside the agent.

  POST /decide  {"state": {...}, "questions": {...}}
      -> {"answers": {"action": {"choice": ..., "confidence": ..., "probabilities": ...},
                      "safe": {"noul": ...}, "urgency": {"score": ...}},
          "model": "...", "device": "..."}
  GET  /health  -> {"ok": true, "model": ..., "device": ...}

Env:
  LAYA_MODEL   HF checkpoint (default convaiinnovations/laya)
  LAYA_DEVICE  cpu | cuda | auto (default cpu)
  LAYA_HOST    bind host (default 127.0.0.1)
  LAYA_PORT    bind port (default 8091)
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL = os.environ.get("LAYA_MODEL", "convaiinnovations/laya")
DEVICE = os.environ.get("LAYA_DEVICE", "cpu")
HOST = os.environ.get("LAYA_HOST", "127.0.0.1")
PORT = int(os.environ.get("LAYA_PORT", "8091"))

_agent = None
_lock = threading.Lock()


def get_agent():
    global _agent
    if _agent is None:
        import laya  # noqa: imported lazily so /health can report boot state

        _agent = laya.load(MODEL, device=DEVICE)
    return _agent


class Handler(BaseHTTPRequestHandler):
    server_version = "laya-sidecar/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("[laya] " + fmt % args + "\n")

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": _agent is not None, "model": MODEL, "device": DEVICE})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/decide":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= 512 * 1024:
                self._send(400, {"error": "bad content length"})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            state = payload.get("state")
            questions = payload.get("questions")
            if not isinstance(state, dict) or not isinstance(questions, dict):
                self._send(400, {"error": "need {state: object, questions: object}"})
                return
            started = time.time()
            with _lock:  # laya sessions are not thread-safe per docs
                agent = get_agent()
                result = agent.predict(state, questions)
            elapsed_ms = round((time.time() - started) * 1000)
            answers = result.get("answers") if isinstance(result, dict) else result
            self._send(
                200,
                {
                    "answers": answers,
                    "routing": result.get("routing") if isinstance(result, dict) else None,
                    "model": MODEL,
                    "device": DEVICE,
                    "elapsed_ms": elapsed_ms,
                },
            )
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid JSON"})
        except Exception as exc:  # noqa: BLE001 - surface model errors to caller
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})


def main():
    # Eagerly load so the first /decide is fast; kill the server if the
    # model cannot load at all.
    print(f"[laya] loading {MODEL} on {DEVICE} ...", flush=True)
    try:
        get_agent()
    except Exception as exc:  # noqa: BLE001
        print(f"[laya] model load failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("[laya] starting anyway; /decide will retry on demand", file=sys.stderr)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[laya] listening on http://{HOST}:{PORT} (POST /decide, GET /health)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
