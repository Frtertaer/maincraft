/**
 * Parse player chat / console into agent control.
 * Prefixes: !  or  Opus,  or  @Opus  or  bot name
 */
/** Canonical form of a trigger phrase: lowercase, ё→е, no leading "!", no punctuation. */
export function normalizeTrigger(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/^[!/\s]+/, "")
    .replace(/[.,!?;:«»"'()\[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the user-defined command whose trigger starts the message (longest trigger wins).
 * Plain, un-addressed chat only matches commands that opted in with matchPlain.
 */
export function matchCustomCommand(body, customCommands = [], { addressed = true } = {}) {
  const norm = normalizeTrigger(body);
  if (!norm) return null;
  let best = null;
  for (const command of customCommands || []) {
    if (!command || command.enabled === false) continue;
    if (!addressed && !command.matchPlain) continue;
    for (const trigger of command.triggers || []) {
      if (!trigger) continue;
      if (norm !== trigger && !norm.startsWith(`${trigger} `)) continue;
      if (best && trigger.length <= best.trigger.length) continue;
      const words = String(body).trim().replace(/^[!/\s]+/, "").split(/\s+/);
      const args = words.slice(trigger.split(" ").length).join(" ").trim().slice(0, 300);
      best = { command, trigger, args };
    }
  }
  return best;
}

export function parseCommand(message, botName = "Opus", customCommands = []) {
  if (!message || typeof message !== "string") return null;
  const raw = message.trim();
  if (!raw) return null;

  const name = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const addressed =
    raw.startsWith("!") ||
    new RegExp(`^@?${name}[,:]?\\s+`, "i").test(raw) ||
    new RegExp(`^${name}\\s*,\\s*`, "i").test(raw);

  // allow bare commands that start with known verbs when whispered later
  let body = raw;
  if (raw.startsWith("!")) body = raw.slice(1).trim();
  else {
    body = raw
      .replace(new RegExp(`^@?${name}[,:]?\\s*`, "i"), "")
      .replace(new RegExp(`^${name}\\s*,\\s*`, "i"), "")
      .trim();
  }

  if (customCommands?.length) {
    const hit = matchCustomCommand(body, customCommands, { addressed });
    if (hit) return { type: "custom", ...hit };
  }

  if (!addressed && !raw.startsWith("!")) {
    // still accept if whole message is a slash-like control
    if (!/^(stop|pause|resume|status|help|follow|come|mode|goal|vision|combat|auto|listen|observe|hybrid)\b/i.test(raw)) {
      return null;
    }
    body = raw;
  }

  const lower = body.toLowerCase();

  if (/^(help|\?|помощь)$/i.test(body)) {
    return { type: "help" };
  }
  if (/^(stop|стоп|стой|остановись)$/i.test(body)) {
    return { type: "stop" };
  }
  if (/^(pause|пауза)$/i.test(body)) {
    return { type: "pause" };
  }
  if (/^(resume|продолжай|давай)$/i.test(body)) {
    return { type: "resume" };
  }
  if (/^(status|статус)$/i.test(body)) {
    return { type: "status" };
  }
  if (/^(follow|за мной|следуй)/i.test(body)) {
    const m = body.match(/(?:follow|следуй(?:\s+за)?)\s+(\S+)/i);
    return { type: "follow", player: m?.[1] || null };
  }
  if (/^(come|иди ко мне|сюда)/i.test(body)) {
    return { type: "come", player: null };
  }
  if (/^(unfollow|отстань|не следуй|стоп след)/i.test(body)) {
    return { type: "stop" };
  }
  if (/^mode\s+(\w+)/i.test(body) || /^режим\s+(\w+)/i.test(body)) {
    const m = body.match(/^(?:mode|режим)\s+(\w+)/i);
    return { type: "mode", mode: normalizeMode(m[1]) };
  }
  if (/^(auto|hybrid|listen|observe)$/i.test(body)) {
    return { type: "mode", mode: normalizeMode(body) };
  }
  if (/^goal\s+/i.test(body) || /^цель\s+/i.test(body)) {
    const text = body.replace(/^(goal|цель)\s+/i, "");
    return { type: "goal", goal: text };
  }
  if (/^vision\s+(on|off|вкл|выкл)/i.test(body) || /^зрение\s+(on|off|вкл|выкл)/i.test(body)) {
    const m = body.match(/(on|off|вкл|выкл)/i);
    const on = /^(on|вкл)$/i.test(m[1]);
    return { type: "vision", enabled: on };
  }
  if (/^combat\s+(\w+)/i.test(body) || /^бой\s+(\w+)/i.test(body)) {
    const m = body.match(/^(?:combat|бой)\s+(\w+)/i);
    const mode = String(m[1] || "").toLowerCase();
    const normalized =
      mode === "off" || mode === "выкл"
        ? "off"
        : mode === "hold" || mode === "держать"
          ? "hold"
          : mode === "auto" || mode === "авто"
            ? "auto"
            : mode;
    return { type: "combat", mode: normalized };
  }
  // voice: listen N seconds (Whisper STT via voice server)
  if (/^(listen|слух|голос|stt)\b/i.test(body)) {
    const m = body.match(/(\d+(?:[.,]\d+)?)/);
    const seconds = m ? Number(String(m[1]).replace(",", ".")) : 5;
    return { type: "listen", seconds: Number.isFinite(seconds) ? seconds : 5 };
  }
  if (/^(summary|память|summarize)$/i.test(body)) {
    return { type: "summary" };
  }

  // free-form order for the LLM
  return { type: "direct", text: body };
}

function normalizeMode(m) {
  const x = String(m || "").toLowerCase();
  if (["auto", "авто"].includes(x)) return "auto";
  if (["hybrid", "гибрид", "coop", "вместе"].includes(x)) return "hybrid";
  if (["listen", "слушать", "команды"].includes(x)) return "listen";
  if (["observe", "watch", "смотр", "наблюдать"].includes(x)) return "observe";
  return x;
}

export const HELP_TEXT =
  "Команды: !help | !stop | !pause | !resume | !status | !follow | !come | " +
  "!mode auto|hybrid|listen|observe | !combat auto|hold|off | !goal <текст> | !vision on|off | " +
  "!listen [сек] (Whisper STT) | !summary (LLM-память) | " +
  "или: Opus, добудь дерево / построй дом / иди за мной";
