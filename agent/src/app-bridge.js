/**
 * Optional IPC bridge to the Maincraft desktop app.
 *
 * When the agent is spawned by the app (stdio "ipc" channel), structured events
 * are sent with process.send() and control messages arrive via process.on("message").
 * Started from a terminal, the bridge is inert and the agent behaves as before.
 */
const enabled = typeof process.send === "function";

export function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

export const bridge = {
  enabled,

  emit(type, payload = {}) {
    if (!enabled || !process.connected) return;
    try {
      process.send({ type, ts: Date.now(), ...safeClone(payload) });
    } catch {
      // The app may be closing; never let telemetry break the agent.
    }
  },

  onMessage(handler) {
    if (!enabled) return;
    process.on("message", (message) => {
      if (!message || typeof message !== "object" || typeof message.type !== "string") return;
      try {
        handler(message);
      } catch {
        /* ignore malformed control messages */
      }
    });
  },

  onDisconnect(handler) {
    if (!enabled) return;
    process.once("disconnect", handler);
  },
};

/** Compact snapshot of the bot for the app dashboard. */
export function botSnapshot(bot, brain, combat) {
  if (!bot?.entity) return null;
  const pos = bot.entity.position;
  const items = new Map();
  try {
    for (const item of bot.inventory.items()) {
      items.set(item.name, (items.get(item.name) || 0) + item.count);
    }
  } catch {
    /* inventory not ready */
  }
  const inventory = [...items.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 36)
    .map(([name, count]) => ({ name, count }));
  let players = [];
  try {
    players = Object.values(bot.players || {})
      .filter((p) => p?.username && p.username !== bot.username)
      .map((p) => ({
        name: p.username,
        distance: p.entity ? Math.round(p.entity.position.distanceTo(pos)) : null,
      }));
  } catch {
    /* ignore */
  }
  const state = brain?.getState?.() || {};
  return {
    username: bot.username,
    health: Number(bot.health) || 0,
    food: Number(bot.food) || 0,
    xpLevel: Number(bot.experience?.level) || 0,
    position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
    dimension: String(bot.game?.dimension || "overworld").replace(/^minecraft:/, ""),
    timeOfDay: Number(bot.time?.timeOfDay) || 0,
    isDay: Boolean(bot.time?.isDay),
    gameMode: bot.game?.gameMode || null,
    mode: state.mode || null,
    goal: state.goal || null,
    plan: state.plan || [],
    paused: Boolean(state.paused),
    lastThink: state.lastThink || null,
    lastAction: state.lastAction
      ? {
          type: state.lastAction.action?.type || null,
          ok: Boolean(state.lastAction.result?.ok),
          message: String(state.lastAction.result?.message || "").slice(0, 200),
        }
      : null,
    lastError: state.lastError || null,
    activeCommand: state.activeCommand || null,
    budget: state.budget || null,
    combat: combat ? { mode: combat.mode || null } : null,
    inventory,
    players,
  };
}
