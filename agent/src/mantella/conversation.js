/**
 * Mantella-inspired conversation controller for Minecraft companion.
 * Manages turn-taking text dialogue + hooks for optional STT/TTS later.
 *
 * Mantella pipeline: STT → LLM → TTS (+ game actions).
 * Minecraft v1: Chat → LLM → Chat(say) + Mineflayer actions.
 * STT/TTS slots are stubs so we can plug Whisper/Piper like Mantella without rewriting.
 */
import { MantellaMemory } from "./memory.js";
import { buildMantellaContext, formatMantellaPromptBlock } from "./context.js";
import { createVoiceTts, VoiceClient } from "./voiceClient.js";

export class MantellaConversation {
  constructor({ bot, cfg, log, llm } = {}) {
    this.bot = bot;
    this.cfg = cfg;
    this.log = log || console.log;
    this.llm = llm || null;
    this.characterId = cfg.agent?.botName || "Opus";
    this.worldId = cfg.mantella?.worldId || "local";
    this.memory = new MantellaMemory({
      worldId: this.worldId,
      characterId: this.characterId,
      maxChatLines: cfg.mantella?.maxChatLines ?? 200,
    });
    this.chatTurns = 0;
    this.lastPlayerName = null;
    /** Optional: async (text) => … */
    this.tts = null;
    this.stt = null;
    this.voiceClient = null;
    this.summaryEvery = Number(cfg.mantella?.summaryEveryTurns ?? 6);
    this._summaryBusy = false;

    // Wire voice sidecar if tts is not none/sapi-local-only
    const ttsMode = String(cfg.mantella?.tts || "none").toLowerCase();
    if (ttsMode === "edge" || ttsMode === "silero" || ttsMode === "voice" || ttsMode === "whisper") {
      const { client, speak } = createVoiceTts(
        {
          mantella: {
            ...cfg.mantella,
            ttsEngine: ttsMode === "voice" || ttsMode === "whisper" ? "edge" : ttsMode,
          },
        },
        this.log
      );
      this.voiceClient = client;
      this.tts = speak;
    } else if (ttsMode === "sapi") {
      this.tts = createWindowsSapiTts(this.log);
    }
  }

  setLlm(llm) {
    this.llm = llm;
  }

  setTts(fn) {
    this.tts = typeof fn === "function" ? fn : null;
  }

  setStt(fn) {
    this.stt = typeof fn === "function" ? fn : null;
  }

  /** Player typed in MC chat (or STT result). */
  onPlayerChat(username, text) {
    const clean = String(text || "").trim().slice(0, 500);
    if (!clean) return;
    this.lastPlayerName = username;
    this.chatTurns += 1;
    this.memory.appendChat("player", clean, { username });
    if (this.summaryEvery > 0 && this.chatTurns % this.summaryEvery === 0) {
      void this.maybeSummarize(username);
    }
  }

  async maybeSummarize(playerName) {
    if (this._summaryBusy) return;
    this._summaryBusy = true;
    try {
      if (this.llm) {
        await this.memory.rollSummaryLlm(this.llm, {
          playerName: playerName || this.lastPlayerName,
          companionName: this.characterId,
          log: this.log,
        });
        this.log("[mantella] LLM summary updated");
      } else {
        this.memory.rollSummary({
          playerName: playerName || this.lastPlayerName,
          companionName: this.characterId,
        });
      }
    } catch (err) {
      this.log(`[mantella] summarize error: ${err?.message || err}`);
    } finally {
      this._summaryBusy = false;
    }
  }

  /** Companion replied (spoken line). */
  onCompanionSay(text) {
    const clean = String(text || "").trim().slice(0, 500);
    if (!clean) return;
    this.memory.appendChat("companion", clean, { name: this.characterId });
    if (this.tts) {
      Promise.resolve(this.tts(clean)).catch((err) => {
        this.log(`[mantella-tts] ${err?.message || err}`);
      });
    }
  }

  /** Push-to-talk style: record on voice server, return text. */
  async listenMic(seconds = 5) {
    if (!this.voiceClient) {
      this.voiceClient = new VoiceClient({ log: this.log, baseUrl: this.cfg.mantella?.voiceUrl });
    }
    return this.voiceClient.sttMic({ seconds, language: "ru" });
  }

  noteWorldEvent(text) {
    this.memory.noteEvent(text);
  }

  /** Extra block for brain system/user prompt. */
  buildPromptExtras(bot, agentState = {}) {
    const ctx = buildMantellaContext(bot, {
      ...agentState,
      botName: this.characterId,
      persona: this.cfg.agent?.persona,
      chatTurns: this.chatTurns,
      lastPlayerName: this.lastPlayerName,
    }, this.memory);
    return {
      ctx,
      text: formatMantellaPromptBlock(ctx),
    };
  }

  /** If STT is wired, capture mic → text (Mantella-style). */
  async listenOnce() {
    if (!this.stt) return null;
    try {
      return await this.stt();
    } catch (err) {
      this.log(`[mantella-stt] ${err?.message || err}`);
      return null;
    }
  }
}

/**
 * Optional Windows SAPI TTS (no extra deps). Best-effort; silent if fails.
 * Not as good as Mantella's Piper/xVASynth — but unblocks "voice companion".
 */
export function createWindowsSapiTts(log = console.log) {
  return async function windowsSapiTts(text) {
    const safe = String(text || "")
      .replace(/"/g, "'")
      .replace(/[`$]/g, "")
      .slice(0, 280);
    if (!safe) return;
    const { spawn } = await import("child_process");
    const ps = `
Add-Type -AssemblyName System.Speech;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$s.Rate = 1;
$s.Speak([string]@'
${safe}
'@);
`;
    await new Promise((resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { windowsHide: true }
      );
      child.on("error", (err) => {
        log(`[sapi-tts] ${err.message}`);
        resolve();
      });
      child.on("close", () => resolve());
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 20000);
    });
  };
}
