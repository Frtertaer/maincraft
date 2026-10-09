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
import { extractJsonObject } from "../llm.js";
import { executeAction } from "../actions.js";

/**
 * NeuroSkyrim/SkyrimNet-style dialogue: the companion answers player chat
 * as a character — one bounded LLM call, not a full planner turn.
 * Reply JSON: {say, action, task, mood} — say is spoken, action is a light
 * body gesture/move (SeverActions-style), task is real work handed to the
 * brain's command queue, mood is recorded into memory.
 */
const DIALOGUE_ACTIONS =
  "look | wave | point | bow | jump | sit | follow | come | stay | give:<item> | equip:<item> | attack | none";

function buildDialogueSystem({ name, persona }) {
  return (
    `Ты ${name} — живой персонаж-спутник в мире Minecraft (как NPC в нейроскайриме). ` +
    `Игрок пишет тебе в игровой чат; отвечай как персонаж, коротко и живо, по-русски.\n\n` +
    `Ответ — СТРОГО JSON без markdown: {"say": string|null, "action": string|null, "task": string|null, "mood": string|null}\n` +
    `say — реплика в чат (1-2 коротких предложения, максимум ~200 символов, без звёздочек и описаний действий). null, если лучше промолчать.\n` +
    `action — мгновенное действие тела, одно из: ${DIALOGUE_ACTIONS}. Только если уместно (игрок просит подойти/следовать/отдать предмет, приветствие → wave и т.п.). give — только если предмет есть в инвентаре (смотри контекст).\n` +
    `task — текст задачи ТОЛЬКО если игрок явно просит реальную работу (добудь X, построй дом, найди, пройди игру, убей дракона): тогда say = короткое согласие/комментарий, task = суть просьбы как команда. Иначе null.\n` +
    `mood — одно слово: neutral|happy|angry|sad|scared|excited.\n\n` +
    `Правила:\n` +
    `- Помни прошлые разговоры (память ниже) и учитывай обстановку (мир ниже).\n` +
    `- Не пересказывай контекст вслух и не повторяйся. Если спросили «что видишь/что есть» — отвечай по секции мира честно.\n` +
    `- Бой и сбор делают другие системы; в диалоге ты только говоришь, жестикулируешь и просишь задачу через task.` +
    (persona ? `\n\nХарактер:\n${String(persona).slice(0, 800)}` : "")
  );
}

/** Parse a dialogue LLM reply into {say, action, task, mood}. Pure — for tests. */
export function parseDialogueReply(text) {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    const say = String(text || "").trim().slice(0, 256);
    return { say: say || null, action: null, task: null, mood: null };
  }
  const cleanStr = (v, max) => {
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (!s || s.toLowerCase() === "null" || s === "-") return null;
    return s.slice(0, max);
  };
  const action = cleanStr(parsed.action, 64)?.toLowerCase();
  return {
    say: cleanStr(parsed.say, 256),
    action: action && !["none", "null", "idle", "нет"].includes(action) ? action : null,
    task: cleanStr(parsed.task, 300),
    mood: cleanStr(parsed.mood, 24)?.toLowerCase() || null,
  };
}

/** Map a dialogue action string to an executeAction payload. Pure — for tests. */
export function dialogueActionToAction(action, { playerName } = {}) {
  const a = String(action || "").trim().toLowerCase();
  if (!a || a === "none" || a === "null" || a === "idle") return null;
  const m = a.match(/^([a-z_]+)[\s:]*(.*)$/i);
  const verb = m ? m[1] : a;
  const arg = (m ? m[2] : "").trim();
  switch (verb) {
    case "look":
    case "look_at":
    case "face":
      return { type: "look_at_player", player: playerName };
    case "wave":
    case "point":
    case "bow":
    case "nod":
      return { type: "emote", kind: "wave", player: playerName };
    case "jump":
      return { type: "emote", kind: "jump", player: playerName };
    case "sit":
    case "crouch":
    case "sneak":
      return { type: "emote", kind: "sit", player: playerName };
    case "follow":
      return { type: "follow", player: playerName, distance: 3 };
    case "come":
    case "here":
      return { type: "come", player: playerName };
    case "stay":
    case "stop":
    case "wait":
      return { type: "stop" };
    case "give":
    case "hand":
    case "gift":
      return arg ? { type: "toss", item: arg } : null;
    case "equip":
    case "hold":
    case "wield":
      return arg ? { type: "equip", item: arg } : null;
    case "attack":
    case "fight":
      return { type: "attack", maxDistance: 12 };
    default:
      return null;
  }
}

export class MantellaConversation {
  constructor({ bot, cfg, log, llm, mcData } = {}) {
    this.bot = bot;
    this.cfg = cfg;
    this.log = log || console.log;
    this.llm = llm || null;
    this.mcData = mcData || null;
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
    // Dialogue serialization: replies are chained so two chat lines never
    // interleave into one LLM call and never speak out of order.
    this._replyChain = Promise.resolve();
    this.lastChatAt = 0;
    this._ambientEvents = [];
    this.lastAmbientAt = 0;
    this.mood = "neutral";

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
    const clean = String(text || "").trim().slice(0, 200);
    if (clean) {
      this._ambientEvents.push(clean);
      if (this._ambientEvents.length > 8) this._ambientEvents.shift();
    }
  }

  /**
   * NeuroSkyrim-style reply to one player chat line: a single bounded LLM
   * call (not a planner turn). Replies are serialized through a chain.
   * Returns {say, action, task, mood} — the caller speaks say, executes
   * action via runDialogueAction, and routes task to the command queue.
   */
  respond(username, text, { agentState = {} } = {}) {
    const item = { username, text, agentState };
    const p = this._replyChain.then(() => this._respondOne(item));
    this._replyChain = p.catch(() => {});
    return p;
  }

  async _respondOne({ username, text, agentState }) {
    if (!this.llm) throw new Error("dialogue llm not ready");
    this.lastChatAt = Date.now();
    const ctx = buildMantellaContext(
      this.bot,
      {
        ...agentState,
        botName: this.characterId,
        persona: this.cfg.agent?.persona,
        chatTurns: this.chatTurns,
        lastPlayerName: username || this.lastPlayerName,
      },
      this.memory
    );
    const system = buildDialogueSystem({ name: this.characterId, persona: this.cfg.agent?.persona });
    const user = `${formatMantellaPromptBlock(ctx)}\n\n---\n${username}: ${String(text || "").slice(0, 400)}`;
    const result = await this.llm.messages({
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: Number(this.cfg.mantella?.dialogueMaxTokens ?? 420),
    });
    const reply = parseDialogueReply(result.text);
    if (reply.mood) this.mood = reply.mood;
    return reply;
  }

  /** Execute a dialogue body action (wave, give, follow…). Best-effort. */
  async runDialogueAction(actionStr, { playerName } = {}) {
    const action = dialogueActionToAction(actionStr, { playerName });
    if (!action) return { ok: false, message: "no action" };
    try {
      return await executeAction(this.bot, action, this.mcData);
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  }

  /**
   * IntelEngine-lite ambient line: if chat has been quiet and world events
   * piled up (death, joins, milestones), the companion may speak on its own.
   * Returns the reply ({say,...}) or null when it's not the moment.
   */
  async maybeAmbient({ agentState = {}, minGapMs = 120000 } = {}) {
    if (!this.llm) return null;
    if (!this._ambientEvents.length) return null;
    const quietMs = Date.now() - Math.max(this.lastChatAt, this.lastAmbientAt);
    if (quietMs < minGapMs) return null;
    const events = this._ambientEvents.splice(0, this._ambientEvents.length);
    this.lastAmbientAt = Date.now();
    const ctx = buildMantellaContext(
      this.bot,
      {
        ...agentState,
        botName: this.characterId,
        persona: this.cfg.agent?.persona,
        chatTurns: this.chatTurns,
        lastPlayerName: this.lastPlayerName,
      },
      this.memory
    );
    const system =
      buildDialogueSystem({ name: this.characterId, persona: this.cfg.agent?.persona }) +
      "\n\nСейчас никто не пишет в чат. Произошли события мира — можешь ОДИН раз коротко прокомментировать " +
      "как персонаж (или вернуть say=null, если не о чем). Никогда не отвечай как будто игрок что-то спросил.";
    const user =
      `${formatMantellaPromptBlock(ctx)}\n\n---\nСобытия: ${events.join("; ")}`;
    const result = await this.llm.messages({
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: Number(this.cfg.mantella?.dialogueMaxTokens ?? 420),
    });
    const reply = parseDialogueReply(result.text);
    if (reply.mood) this.mood = reply.mood;
    return reply;
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
