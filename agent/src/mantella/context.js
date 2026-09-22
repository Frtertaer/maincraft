/**
 * Mantella-inspired conversation context for Minecraft.
 * Injects location / time / weather-like / equipment / nearby actors into the LLM prompt
 * (same role as Mantella's Context + Character bio).
 */
import { buildWorldState } from "../world.js";

export function timeGroupFromMinecraft(timeOfDay) {
  const t = Number(timeOfDay);
  if (!Number.isFinite(t)) return "неизвестно";
  // 0–24000
  if (t < 1000 || t >= 23000) return "на рассвете";
  if (t < 6000) return "утром";
  if (t < 12000) return "днём";
  if (t < 13000) return "в полдень";
  if (t < 18000) return "вечером";
  return "ночью";
}

export function trustLabel(turnsWithPlayer) {
  const n = Number(turnsWithPlayer) || 0;
  if (n < 3) return "почти незнакомы";
  if (n < 15) return "знакомы";
  if (n < 40) return "приятели";
  return "близкие спутники";
}

/**
 * Build Mantella-style variables for the companion system/user prompt.
 */
export function buildMantellaContext(bot, agentState = {}, memory = null) {
  const world = buildWorldState(bot, agentState);
  const me = world.me || {};
  const inv = world.inventory || {};
  const env = world.environment || {};
  const pos = me.pos || {};
  const biome = env.biomeHint || "неизвестно";
  const dim = String(me.dimension || "overworld");
  const held = me.held || "пусто";
  const summary = memory?.loadSummary?.() || "";
  const recent = memory?.loadRecentChat?.(12) || [];
  const playerNearby = (world.players || [])[0];
  const playerName = playerNearby?.username || agentState.lastPlayerName || "Игрок";
  const hostiles = (world.hazards?.hostileMobs || []).map((m) => m.name).slice(0, 6);
  const interesting = (world.blocksNearby || [])
    .slice(0, 12)
    .map((b) => b.name || b)
    .filter(Boolean);

  const equipmentBits = [];
  if (held && held !== "пусто") equipmentBits.push(`в руке ${held}`);
  const armorKeys = ["helmet", "chestplate", "leggings", "boots"];
  for (const k of armorKeys) {
    if (inv[k]) equipmentBits.push(inv[k]);
  }

  return {
    game: "Minecraft Java",
    companion_name: agentState.botName || "Opus",
    player_name: playerName,
    bio: agentState.persona || "",
    trust: trustLabel(agentState.chatTurns || recent.length),
    location: `${dim} · биом≈${biome} · ~${Math.floor(pos.x ?? 0)},${Math.floor(pos.y ?? 0)},${Math.floor(pos.z ?? 0)}`,
    weather: env.raining ? "дождь" : "ясно",
    time: env.timeOfDay,
    time_group: timeGroupFromMinecraft(env.timeOfDay),
    is_day: env.isDay,
    equipment: equipmentBits.join(", ") || "почти ничего",
    health: me.health,
    food: me.food,
    hostiles: hostiles.join(", ") || "нет",
    interesting_blocks: interesting.join(", ") || "—",
    conversation_summary: summary,
    recent_chat: recent,
    world_raw: world,
  };
}

/** Render context as Russian prompt block (Mantella prompt variables style). */
export function formatMantellaPromptBlock(ctx) {
  return [
    `Игра: ${ctx.game}`,
    `Ты: ${ctx.companion_name}. Игрок: ${ctx.player_name}. Отношения: ${ctx.trust}.`,
    ctx.bio ? `Характер/bio: ${ctx.bio}` : "",
    `Место: ${ctx.location}. Погода: ${ctx.weather}. Время: ${ctx.time_group} (tod=${ctx.time}).`,
    `Снаряжение: ${ctx.equipment}. HP=${ctx.health} еда=${ctx.food}.`,
    `Угрозы рядом: ${ctx.hostiles}.`,
    `Заметные блоки: ${ctx.interesting_blocks}.`,
    ctx.conversation_summary ? `Память о прошлых разговорах:\n${ctx.conversation_summary.slice(0, 1200)}` : "Память: пока пусто.",
    ctx.recent_chat?.length
      ? `Недавний чат:\n${ctx.recent_chat.map((e) => `${e.role}: ${e.text}`).join("\n").slice(0, 1500)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
