/**
 * Mantella-inspired long-term memory for the Minecraft companion.
 * Pattern from Mantella (AGPL-3.0): conversation summaries on disk per character/world.
 * Reimplemented for Node/Minecraft — not a copy of Mantella Python sources.
 *
 * Layout:
 *   logs/mantella-memory/<worldId>/<characterId>/summary.txt
 *   logs/mantella-memory/<worldId>/<characterId>/chat.jsonl
 */
import fs from "fs";
import path from "path";
import { LOGS_DIR } from "../config.js";

const DEFAULT_ROOT = path.join(LOGS_DIR, "mantella-memory");

export function sanitizeId(value) {
  return String(value || "default")
    .replace(/[^\w\-]+/g, "_")
    .slice(0, 64) || "default";
}

export class MantellaMemory {
  constructor({ rootDir = DEFAULT_ROOT, worldId = "world", characterId = "Opus", maxChatLines = 200 } = {}) {
    this.rootDir = rootDir;
    this.worldId = sanitizeId(worldId);
    this.characterId = sanitizeId(characterId);
    this.maxChatLines = maxChatLines;
    this.dir = path.join(this.rootDir, this.worldId, this.characterId);
    this.summaryPath = path.join(this.dir, "summary.txt");
    this.chatPath = path.join(this.dir, "chat.jsonl");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Load prior relationship summary for the system/user prompt. */
  loadSummary() {
    try {
      if (!fs.existsSync(this.summaryPath)) return "";
      return fs.readFileSync(this.summaryPath, "utf8").trim();
    } catch {
      return "";
    }
  }

  /** Append a chat turn to jsonl (player / companion). */
  appendChat(role, text, meta = {}) {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      role,
      text: String(text || "").slice(0, 2000),
      ...meta,
    });
    try {
      fs.appendFileSync(this.chatPath, line + "\n", "utf8");
      this._trimChatFile();
    } catch {
      /* ignore disk errors */
    }
  }

  /** Recent chat lines for context (last N). */
  loadRecentChat(limit = 24) {
    try {
      if (!fs.existsSync(this.chatPath)) return [];
      const raw = fs.readFileSync(this.chatPath, "utf8");
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const recent = lines.slice(-limit);
      const out = [];
      for (const line of recent) {
        try {
          out.push(JSON.parse(line));
        } catch {
          /* skip bad line */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  writeSummary(text) {
    const next = String(text || "").trim().slice(0, 3000);
    if (!next) return this.loadSummary();
    try {
      fs.writeFileSync(this.summaryPath, next + "\n", "utf8");
    } catch {
      /* ignore */
    }
    return next;
  }

  /**
   * Cheap local rollup (no LLM) — fallback when API fails.
   */
  rollSummary({ playerName, companionName, extraNote } = {}) {
    const recent = this.loadRecentChat(40);
    if (!recent.length && !extraNote) return this.loadSummary();
    const prev = this.loadSummary();
    const snippets = recent
      .slice(-16)
      .map((e) => `${e.role}: ${String(e.text || "").slice(0, 120)}`)
      .join("\n");
    const header = `Память ${companionName || this.characterId} ↔ ${playerName || "player"} (${new Date().toISOString().slice(0, 10)})`;
    const body = [
      prev ? `Было:\n${prev.slice(0, 800)}` : "",
      snippets ? `Недавний диалог:\n${snippets}` : "",
      extraNote ? `Событие: ${extraNote}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 2500);
    return this.writeSummary(`${header}\n${body}`);
  }

  /**
   * Mantella-style LLM summary (pass LlmClient). Falls back to rollSummary.
   */
  async rollSummaryLlm(llm, { playerName, companionName, log } = {}) {
    const { summarizeConversationWithLlm } = await import("./summarize.js");
    const recent = this.loadRecentChat(40);
    const prev = this.loadSummary();
    const r = await summarizeConversationWithLlm(llm, {
      recentChat: recent,
      prevSummary: prev,
      playerName,
      companionName: companionName || this.characterId,
      log,
    });
    if (r.ok && r.summary) {
      return this.writeSummary(r.summary);
    }
    log?.(`[memory] LLM summary failed (${r.error}), local rollup`);
    return this.rollSummary({ playerName, companionName });
  }

  noteEvent(text) {
    this.appendChat("event", text);
    return this.rollSummary({ extraNote: text });
  }

  _trimChatFile() {
    try {
      const raw = fs.readFileSync(this.chatPath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      if (lines.length <= this.maxChatLines) return;
      fs.writeFileSync(this.chatPath, lines.slice(-this.maxChatLines).join("\n") + "\n", "utf8");
    } catch {
      /* ignore */
    }
  }
}
