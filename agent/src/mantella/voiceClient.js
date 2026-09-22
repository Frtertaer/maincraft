/**
 * HTTP client to D:\maincraft\voice Python sidecar (Whisper STT + edge-tts/Silero TTS).
 */
const DEFAULT_BASE = process.env.VOICE_URL || "http://127.0.0.1:8765";

export class VoiceClient {
  constructor({ baseUrl = DEFAULT_BASE, log = console.log, timeoutMs = 120000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.available = null;
  }

  async health() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        this.available = false;
        return { ok: false, status: res.status };
      }
      const data = await res.json();
      this.available = true;
      return data;
    } catch (err) {
      this.available = false;
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async ensure() {
    if (this.available === true) return true;
    const h = await this.health();
    return Boolean(h?.ok);
  }

  /**
   * Speak text. engine: edge|silero|sapi
   * voice: ru-RU-SvetlanaNeural | ru-RU-DmitryNeural | silero speaker
   */
  async tts(text, { engine = "edge", voice = null, play = true } = {}) {
    if (!(await this.ensure())) {
      return { ok: false, error: "voice server offline (start D:\\maincraft\\voice\\start-voice.ps1)" };
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: String(text || "").slice(0, 500), engine, voice, play }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        return { ok: false, error: data.error || `tts http ${res.status}` };
      }
      return data;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    } finally {
      clearTimeout(t);
    }
  }

  /** Record mic on the machine running the voice server, return transcript. */
  async sttMic({ seconds = 5, language = "ru" } = {}) {
    if (!(await this.ensure())) {
      return { ok: false, error: "voice server offline" };
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/stt/mic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seconds, language }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        return { ok: false, error: data.error || `stt http ${res.status}` };
      }
      return data;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    } finally {
      clearTimeout(t);
    }
  }
}

/** Build TTS callback for MantellaConversation from cfg. */
export function createVoiceTts(cfg, log) {
  const client = new VoiceClient({
    baseUrl: cfg.mantella?.voiceUrl || process.env.VOICE_URL || "http://127.0.0.1:8765",
    log,
  });
  const engine = cfg.mantella?.ttsEngine || cfg.mantella?.tts || "edge";
  const voice = cfg.mantella?.ttsVoice || null;
  return {
    client,
    async speak(text) {
      const r = await client.tts(text, { engine: engine === "sapi" ? "sapi" : engine, voice, play: true });
      if (!r.ok) log(`[voice-tts] ${r.error}`);
      return r;
    },
  };
}
