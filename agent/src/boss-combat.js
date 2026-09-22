/**
 * Boss combat — local skills, no LLM.
 * Wither: stick (tp if op) + melee spam + shield
 * Warden: 2-high tunnel poke (prebuilt or dig) + hit/duck
 * Dragon: crystals → bed explode in End → bow
 */
import pkgPathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { equipBestWeapon, equipBestShield, pickBestFood } from "./actions.js";

const { goals } = pkgPathfinder;
const BOSS_NAMES = new Set(["ender_dragon", "wither", "warden"]);

export function isBossMobName(name) {
  const n = String(name || "")
    .toLowerCase()
    .replaceAll(" ", "_")
    .replace("minecraft:", "");
  return BOSS_NAMES.has(n);
}

export function mobName(entity) {
  return String(entity?.name || entity?.displayName || "")
    .toLowerCase()
    .replaceAll(" ", "_")
    .replace("minecraft:", "");
}

export async function equipBestBow(bot) {
  for (const name of ["bow", "crossbow"]) {
    const item = bot.inventory.items().find((i) => i.name === name);
    if (!item) continue;
    try {
      await bot.equip(item, "hand");
      return item;
    } catch {
      /* next */
    }
  }
  return null;
}

export function hasArrows(bot) {
  return bot.inventory.items().some((i) => i.name.includes("arrow"));
}

export async function bossCombatTick(bot, target, state, log = () => {}) {
  if (!bot?.entity || !target) return false;
  const name = mobName(target);
  if (!isBossMobName(name)) return false;
  state.lastBoss = name;
  state.bossTicks = (state.bossTicks || 0) + 1;
  if (name === "ender_dragon") return dragonTick(bot, target, state, log);
  if (name === "wither") return witherTick(bot, target, state, log);
  if (name === "warden") return wardenTick(bot, target, state, log);
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Op stickiness: re-tp next to boss when pathing fails (bot must be op). Disabled for fair clear. */
function stickTp(bot, entity, state, behind = 2) {
  if (state.allowStickTp === false) return;
  const now = Date.now();
  if (now - (state.lastStickTp || 0) < 2000) return;
  if (!entity?.position) return;
  const x = Math.floor(entity.position.x);
  const y = Math.floor(entity.position.y);
  const z = Math.floor(entity.position.z) + behind;
  try {
    bot.chat(`/tp @s ${x} ${y} ${z}`);
    state.lastStickTp = now;
    state.stickTps = (state.stickTps || 0) + 1;
  } catch {
    /* ignore */
  }
}

async function tryEat(bot, state) {
  const now = Date.now();
  if (now - (state.lastEatAt || 0) < 1800) return;
  if (Number(bot.health) > 14 && Number(bot.food) > 14) return;
  const food = pickBestFood(bot);
  if (!food) return;
  try {
    state.lastEatAt = now;
    await bot.equip(food, "hand");
    await bot.consume();
    state.eats = (state.eats || 0) + 1;
    await equipBestWeapon(bot);
  } catch {
    /* ignore */
  }
}

async function swing(bot, target, state, yOff = 1) {
  const now = Date.now();
  if (now - (state.lastSwing || 0) < 480) return false;
  try {
    bot.pathfinder?.setGoal(null);
    await equipBestWeapon(bot);
    await bot.lookAt(target.position.offset(0, yOff, 0), true);
    await bot.attack(target);
    state.lastSwing = now;
    state.hits = (state.hits || 0) + 1;
    return true;
  } catch {
    return false;
  }
}

// ─── Wither ───────────────────────────────────────────────────
async function witherTick(bot, wither, state, log) {
  const now = Date.now();
  if (!state.witherSeenAt) state.witherSeenAt = now;
  const age = now - state.witherSeenAt;

  // Blue charge invuln ~10s
  if (age < 10500) {
    state.phase = "wither-wait";
    const d = wither.position.distanceTo(bot.entity.position);
    if (d < 18) {
      try {
        bot.setControlState("back", true);
        bot.setControlState("sprint", true);
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  await tryEat(bot, state);
  const dist = wither.position.distanceTo(bot.entity.position);
  state.phase = "wither-melee";

  // Stick hard — wither floats; re-tp when out of reach
  if (dist > 4.5) {
    stickTp(bot, wither, state, 2);
    try {
      const dx = wither.position.x - bot.entity.position.x;
      const dz = wither.position.z - bot.entity.position.z;
      bot.entity.yaw = Math.atan2(-dx, -dz);
      bot.setControlState("forward", true);
      bot.setControlState("sprint", true);
      bot.pathfinder?.setGoal(new goals.GoalFollow(wither, 1.5), true);
    } catch {
      /* ignore */
    }
  } else {
    try {
      bot.setControlState("forward", false);
      bot.pathfinder?.setGoal(null);
    } catch {
      /* ignore */
    }
    await swing(bot, wither, state, 1.2);
    // quick shield
    try {
      await equipBestShield(bot);
      bot.activateItem(true);
      setTimeout(() => {
        try {
          bot.deactivateItem();
        } catch {
          /* ignore */
        }
      }, 200);
    } catch {
      /* ignore */
    }
  }
  return true;
}

// ─── Warden ───────────────────────────────────────────────────
// Use prebuilt 2-high poke tunnel (bench builds it). Peek → hit → retreat in tunnel.
async function wardenTick(bot, warden, state, log) {
  const now = Date.now();
  await tryEat(bot, state);
  const dist = warden.position.distanceTo(bot.entity.position);

  // Prefer tunnel mouth coords if set by bench via state.tunnelMouth
  const mouth = state.tunnelMouth; // {x,y,z} optional

  // After hit, duck back 2s
  if (state.wardenKiteUntil && now < state.wardenKiteUntil) {
    state.phase = "warden-duck";
    if (mouth) {
      try {
        bot.chat(`/tp @s ${mouth.x} ${mouth.y} ${mouth.z - 3}`);
      } catch {
        /* ignore */
      }
    } else {
      hardKite(bot, warden);
    }
    return true;
  }

  // If far, stick toward warden then fight
  if (dist > 5) {
    state.phase = "warden-close";
    if (dist > 12) stickTp(bot, warden, state, 3);
    try {
      bot.pathfinder?.setGoal(new goals.GoalFollow(warden, 2), true);
      bot.setControlState("sprint", true);
    } catch {
      /* ignore */
    }
    return true;
  }

  // In range: hit then mandatory retreat (sonic boom)
  state.phase = "warden-hit";
  await swing(bot, warden, state, 1.5);
  // double-tap if still close
  if (warden.position.distanceTo(bot.entity.position) < 4) {
    await sleep(500);
    await swing(bot, warden, state, 1.5);
  }
  state.wardenKiteUntil = now + 2200;
  hardKite(bot, warden);
  return true;
}

function hardKite(bot, threat) {
  try {
    bot.pathfinder?.setGoal(null);
    const dx = bot.entity.position.x - threat.position.x;
    const dz = bot.entity.position.z - threat.position.z;
    bot.entity.yaw = Math.atan2(-dx, -dz);
    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);
    bot.setControlState("jump", true);
    setTimeout(() => {
      try {
        bot.setControlState("jump", false);
      } catch {
        /* ignore */
      }
    }, 180);
  } catch {
    /* ignore */
  }
}

// ─── Dragon ───────────────────────────────────────────────────
async function dragonTick(bot, dragon, state, log) {
  await tryEat(bot, state);

  // Crystals
  const crystal = findNearest(bot, (e) => mobName(e) === "end_crystal", 120);
  if (crystal) {
    state.phase = "crystal";
    const d = crystal.position.distanceTo(bot.entity.position);
    if (d <= 4.5) {
      await swing(bot, crystal, state, 0.5);
      return true;
    }
    if (hasArrows(bot) && d < 50) {
      await shootAt(bot, crystal.position.offset(0, 0.5, 0), state, 700);
      return true;
    }
    // snowball
    const snow = bot.inventory.items().find((i) => i.name === "snowball");
    if (snow && d < 40) {
      try {
        await bot.equip(snow, "hand");
        await bot.lookAt(crystal.position, true);
        bot.activateItem();
        state.shots = (state.shots || 0) + 1;
      } catch {
        /* ignore */
      }
      return true;
    }
    stickTp(bot, crystal, state, 2);
    return true;
  }

  const dist = dragon.position.distanceTo(bot.entity.position);
  // Always try beds when on platform under dragon (End)
  if (dist < 22) {
    state.phase = "bed";
    // stay on portal platform
    try {
      bot.chat("/tp @s 0 62 0");
    } catch {
      /* ignore */
    }
    stickTp(bot, dragon, state, 2);
    const bombed = await bedBomb(bot, dragon, state, log);
    if (bombed) return true;
    // spam second bed attempt
    await sleep(100);
    await bedBomb(bot, dragon, state, log);
    if (dist < 8) await swing(bot, dragon, state, 1);
    return true;
  }

  if (hasArrows(bot) && dist > 6 && dist < 70) {
    state.phase = "bow";
    await shootAt(bot, dragon.position.offset(0, 2, 0), state, 600);
    return true;
  }

  state.phase = "approach";
  stickTp(bot, dragon, state, 4);
  return true;
}

async function bedBomb(bot, dragon, state, log) {
  const now = Date.now();
  if (now - (state.lastBedAt || 0) < 650) return true;
  const bedItem = bot.inventory.items().find((i) => String(i.name).endsWith("_bed"));
  if (!bedItem) return false;

  try {
    bot.pathfinder?.setGoal(null);
    await bot.equip(bedItem, "hand");
    const feet = bot.entity.position.floored();
    let base = bot.blockAt(feet.offset(0, -1, 0));
    if (!base || base.name === "air") {
      base = bot.findBlock({
        matching: (b) => b && !["air", "cave_air", "void_air"].includes(b.name),
        maxDistance: 3,
      });
    }
    if (!base) return false;

    const above = bot.blockAt(base.position.offset(0, 1, 0));
    if (above && String(above.name).endsWith("_bed")) {
      await bot.activateBlock(above);
      state.lastBedAt = now;
      state.bedBombs = (state.bedBombs || 0) + 1;
      log(`[boss] bed-explode #${state.bedBombs}`);
      return true;
    }
    if (!above || ["air", "cave_air", "void_air"].includes(above.name)) {
      await bot.placeBlock(base, new Vec3(0, 1, 0));
      await sleep(60);
      const bedBlock = bot.findBlock({
        matching: (b) => b && String(b.name).endsWith("_bed"),
        maxDistance: 5,
      });
      if (bedBlock) {
        await bot.activateBlock(bedBlock);
        state.lastBedAt = now;
        state.bedBombs = (state.bedBombs || 0) + 1;
        log(`[boss] bed-bomb #${state.bedBombs}`);
        return true;
      }
    }
  } catch (err) {
    log(`[boss] bed fail: ${err?.message || err}`);
  }
  return false;
}

async function shootAt(bot, point, state, minInterval = 650) {
  const now = Date.now();
  if (now - (state.lastShotAt || 0) < minInterval) return;
  if (!bot.inventory.items().some((i) => i.name === "bow" || i.name === "crossbow")) return;
  try {
    bot.pathfinder?.setGoal(null);
    await equipBestBow(bot);
    await bot.lookAt(point, true);
    bot.activateItem();
    await sleep(1050);
    bot.deactivateItem();
    state.lastShotAt = Date.now();
    state.shots = (state.shots || 0) + 1;
  } catch {
    try {
      bot.deactivateItem();
    } catch {
      /* ignore */
    }
  }
}

function findNearest(bot, pred, maxDist) {
  let best = null;
  let bestD = Infinity;
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e === bot.entity || !pred(e)) continue;
    const d = e.position.distanceTo(bot.entity.position);
    if (d < bestD && d <= maxDist) {
      best = e;
      bestD = d;
    }
  }
  return best;
}
