/**
 * Deterministic survival progression toward "beat Minecraft".
 * No /give gear. Uses Mineflayer skills; Opus can advise but skills drive the path.
 */
import pkgPathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { executeAction, equipBestWeapon } from "./actions.js";
import { bossCombatTick, isBossMobName, mobName } from "./boss-combat.js";

const { goals } = pkgPathfinder;

export const PHASES = [
  "wood",
  "stone",
  "iron",
  "food_armor",
  "diamond",
  "portal",
  "nether",
  "blaze",
  "pearls",
  "eyes",
  "stronghold",
  "end",
  "dragon",
  "clear",
];

export function countItem(bot, pred) {
  let n = 0;
  for (const it of bot.inventory.items()) {
    if (typeof pred === "string") {
      if (it.name === pred || it.name.includes(pred)) n += it.count;
    } else if (pred(it)) n += it.count;
  }
  return n;
}

export function hasAny(bot, names) {
  return names.some((n) => countItem(bot, n) > 0);
}

export function detectPhase(bot) {
  const dim = String(bot.game?.dimension || "");
  if (/end/i.test(dim)) {
    const dragon = Object.values(bot.entities).find((e) => /dragon/i.test(mobName(e)));
    if (!dragon) return "clear";
    return "dragon";
  }
  if (/nether/i.test(dim)) {
    if (countItem(bot, "blaze_rod") >= 6 || countItem(bot, "blaze_powder") >= 6) {
      if (countItem(bot, "ender_pearl") >= 12) return "eyes";
      return "pearls"; // still need pearls often from overworld endermen
    }
    return "blaze";
  }

  const eyes = countItem(bot, "ender_eye");
  const pearls = countItem(bot, "ender_pearl");
  const rods = countItem(bot, "blaze_rod") + countItem(bot, "blaze_powder");
  if (eyes >= 12) return "stronghold";
  if (pearls >= 12 && rods >= 6) return "eyes";
  if (rods >= 6) return "pearls";
  if (countItem(bot, (i) => i.name.includes("obsidian")) >= 10 && hasAny(bot, ["flint_and_steel", "fire_charge"])) {
    // portal may be built
    return "nether";
  }
  // Portal only with diamond pick (obsidian) or enough diamonds already
  if (hasAny(bot, ["diamond_pickaxe"]) || (countItem(bot, "diamond") >= 3 && hasAny(bot, ["iron_pickaxe", "diamond_pickaxe"]))) {
    return "portal";
  }
  // Mine diamonds only with at least iron pick
  if (hasAny(bot, ["iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"])) {
    return "diamond";
  }
  // Iron phase: stone pick + need iron tools/ingots/ore
  const picks = bot.inventory.items().filter((i) => i.name.includes("pickaxe"));
  if (
    picks.some((i) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name)) ||
    countItem(bot, "iron_ingot") > 0 ||
    countItem(bot, "raw_iron") > 0
  ) {
    return "iron";
  }
  // only advance past wood when inventory actually holds a pickaxe
  if (picks.length > 0) {
    return "stone";
  }
  return "wood";
}

/**
 * Run one progression step. Returns { ok, phase, message, milestone? }
 */
export async function progressionStep(bot, mcData, state, log = () => {}) {
  if (!bot?.entity) return { ok: false, phase: "?", message: "no entity" };
  const phase = detectPhase(bot);
  state.phase = phase;
  state.steps = (state.steps || 0) + 1;

  // Always tick boss if present
  const boss = Object.values(bot.entities).find((e) => e && e !== bot.entity && isBossMobName(mobName(e)));
  if (boss) {
    state.allowStickTp = false; // fair clear: no op stick
    await bossCombatTick(bot, boss, state.boss || (state.boss = { allowStickTp: false }), log);
    return { ok: true, phase, message: `boss fight ${mobName(boss)}` };
  }

  try {
    switch (phase) {
      case "wood":
        return await phaseWood(bot, mcData, state, log);
      case "stone":
        return await phaseStone(bot, mcData, state, log);
      case "iron":
        return await phaseIron(bot, mcData, state, log);
      case "food_armor":
      case "diamond":
        return await phaseDiamond(bot, mcData, state, log);
      case "portal":
        return await phasePortal(bot, mcData, state, log);
      case "nether":
      case "blaze":
        return await phaseNetherBlaze(bot, mcData, state, log);
      case "pearls":
        return await phasePearls(bot, mcData, state, log);
      case "eyes":
        return await phaseEyes(bot, mcData, state, log);
      case "stronghold":
        return await phaseStronghold(bot, mcData, state, log);
      case "end":
      case "dragon":
        return await phaseDragon(bot, mcData, state, log);
      case "clear":
        return { ok: true, phase: "clear", message: "DRAGON DOWN / clear", milestone: "CLEAR" };
      default:
        return { ok: false, phase, message: `unknown phase ${phase}` };
    }
  } catch (err) {
    return { ok: false, phase, message: err?.message || String(err) };
  }
}

function plankNameFromLog(logName) {
  const n = String(logName || "");
  if (n.includes("spruce")) return "spruce_planks";
  if (n.includes("birch")) return "birch_planks";
  if (n.includes("jungle")) return "jungle_planks";
  if (n.includes("acacia")) return "acacia_planks";
  if (n.includes("dark_oak")) return "dark_oak_planks";
  if (n.includes("mangrove")) return "mangrove_planks";
  if (n.includes("cherry")) return "cherry_planks";
  if (n.includes("pale_oak")) return "pale_oak_planks";
  return "oak_planks";
}

function hasPickaxe(bot) {
  return bot.inventory.items().some((i) => /_pickaxe$/.test(i.name) || i.name.includes("pickaxe"));
}

async function ensureCraft(bot, mcData, item, count = 1) {
  return executeAction(bot, { type: "craft", item, count }, mcData);
}

async function ensurePlanks(bot, mcData, min = 8) {
  if (countItem(bot, (i) => i.name.includes("planks")) >= min) return { ok: true };
  const logItem = bot.inventory.items().find((i) => i.name.includes("log") || i.name.endsWith("_wood"));
  if (!logItem) return { ok: false, message: "no logs for planks" };
  const plank = plankNameFromLog(logItem.name);
  // 1 log → 4 planks; craft enough
  const need = Math.max(1, Math.ceil((min - countItem(bot, (i) => i.name.includes("planks"))) / 4));
  return ensureCraft(bot, mcData, plank, Math.min(need * 4, 32));
}

async function ensureTable(bot, mcData) {
  // Reachable table is enough (mineflayer craft range ~4)
  const near = bot.findBlock({ matching: (b) => b?.name === "crafting_table", maxDistance: 5 });
  if (near) return { ok: true, message: "table nearby", block: near };

  // Try walking to a farther table; if path fails, place a new one at feet
  const mid = bot.findBlock({ matching: (b) => b?.name === "crafting_table", maxDistance: 24 });
  if (mid) {
    const walk = await executeAction(
      bot,
      {
        type: "goto",
        x: mid.position.x,
        y: mid.position.y,
        z: mid.position.z,
        range: 2,
        timeoutMs: 12000,
      },
      mcData
    );
    const again = bot.findBlock({ matching: (b) => b?.name === "crafting_table", maxDistance: 5 });
    if (again) return { ok: true, message: "reached table", block: again };
    // fall through: place a local table if far one is blocked
  }

  if (countItem(bot, "crafting_table") < 1) {
    const pl = await ensurePlanks(bot, mcData, 4);
    if (!pl.ok && countItem(bot, (i) => i.name.includes("planks")) < 4) {
      return { ok: false, message: pl.message || "need planks for table" };
    }
    const cr = await ensureCraft(bot, mcData, "crafting_table", 1);
    if (!cr.ok) return { ok: false, message: `craft table: ${cr.message}` };
  }

  // Place on top of a solid block adjacent to feet (not floating air)
  const feet = bot.entity.position.floored();
  const under = bot.blockAt(feet.offset(0, -1, 0));
  const supportCandidates = [];
  if (under && under.name !== "air") supportCandidates.push(under);
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ]) {
    for (const dy of [0, -1, 1, -2]) {
      const solid = bot.blockAt(feet.offset(dx, dy, dz));
      if (!solid || solid.name === "air" || solid.name === "cave_air") continue;
      if (solid.boundingBox && solid.boundingBox !== "block") continue;
      const abovePos = solid.position.offset(0, 1, 0);
      const above = bot.blockAt(abovePos);
      if (above && (above.name === "air" || above.name === "cave_air" || above.name === "snow")) {
        supportCandidates.push(solid);
      }
    }
  }

  let lastMsg = "no solid support";
  for (const solid of supportCandidates) {
    const target = solid.position.offset(0, 1, 0);
    // skip placing inside the bot's feet cell if possible
    if (target.x === feet.x && target.y === feet.y && target.z === feet.z) continue;
    const r = await executeAction(
      bot,
      {
        type: "place",
        item: "crafting_table",
        x: target.x,
        y: target.y,
        z: target.z,
        face: "top",
      },
      mcData
    );
    lastMsg = r.message;
    // place may report success even if findBlock lags a tick
    if (r.ok || /placed crafting_table/i.test(String(r.message || ""))) {
      await sleep(200);
      const b = bot.findBlock({ matching: (bl) => bl?.name === "crafting_table", maxDistance: 6 });
      if (b) return { ok: true, message: r.message, block: b };
    }
  }

  // last resort: let actions.js auto-pick a neighbor of feet
  const auto = await executeAction(bot, { type: "place", item: "crafting_table" }, mcData);
  await sleep(200);
  const b =
    bot.findBlock({ matching: (bl) => bl?.name === "crafting_table", maxDistance: 6 }) ||
    null;
  if (auto.ok || b) return { ok: true, message: auto.message, block: b };
  return { ok: false, message: `place table failed: ${lastMsg || auto.message}` };
}

async function punchNearbyLogs(bot, mcData, need = 6) {
  const logNames = [
    "oak_log",
    "spruce_log",
    "birch_log",
    "jungle_log",
    "dark_oak_log",
    "acacia_log",
    "cherry_log",
    "mangrove_log",
    "pale_oak_log",
  ];
  // Prefer small collect batches (less pathfinder thrash / OOM)
  for (const b of logNames) {
    const rr = await executeAction(bot, { type: "collect", block: b, count: 4, maxDistance: 32 }, mcData);
    if (rr.ok) return rr;
  }
  // Fallback: dig one log block by coords
  const block = bot.findBlock({
    matching: (b) => b && (b.name.endsWith("_log") || b.name.endsWith("_stem")),
    maxDistance: 32,
  });
  if (!block) return { ok: false, message: "no log block nearby" };
  return executeAction(
    bot,
    { type: "dig", x: block.position.x, y: block.position.y, z: block.position.z },
    mcData
  );
}

async function phaseWood(bot, mcData, state, log) {
  const logs = countItem(bot, (i) => i.name.includes("log") || i.name.endsWith("_stem"));
  const planks = countItem(bot, (i) => i.name.includes("planks"));
  const sticks = countItem(bot, "stick");
  const woodMat = logs * 4 + planks; // rough planks-equivalent

  // Gather only if we lack materials for table+pick (table 4 + pick 3 + sticks from 2 planks ≈ 12 planks-eq)
  if (woodMat < 12 && logs < 3) {
    const rr = await punchNearbyLogs(bot, mcData, 6);
    const now = countItem(bot, (i) => i.name.includes("log") || i.name.endsWith("_stem"));
    return {
      ok: rr.ok || now > logs,
      phase: "wood",
      message: rr.ok || now > logs ? `gather logs (${now})` : rr.message || "no logs nearby",
      milestone: now >= 3 || planks >= 4 ? "WOOD_GATHER" : undefined,
    };
  }
  if (logs >= 1 && planks < 8) {
    // convert some logs → planks but keep path short
    const pl = await ensurePlanks(bot, mcData, 12);
    if (!pl.ok && countItem(bot, (i) => i.name.includes("planks")) < 4) {
      return { ok: false, phase: "wood", message: `planks: ${pl.message}` };
    }
  } else if (woodMat < 8) {
    const rr = await punchNearbyLogs(bot, mcData, 4);
    return {
      ok: rr.ok,
      phase: "wood",
      message: rr.ok ? "gather more wood" : rr.message || "need more wood",
      milestone: "WOOD_GATHER",
    };
  }

  // sticks (2x2)
  if (countItem(bot, "stick") < 4) {
    if (countItem(bot, (i) => i.name.includes("planks")) < 2) {
      await ensurePlanks(bot, mcData, 4);
    }
    const st = await ensureCraft(bot, mcData, "stick", 8);
    if (!st.ok && countItem(bot, "stick") < 2) {
      return { ok: false, phase: "wood", message: `sticks: ${st.message}` };
    }
  }

  // table IN WORLD for 3x3 pickaxe
  const tableRes = await ensureTable(bot, mcData);
  const nearTable =
    tableRes.block ||
    bot.findBlock({ matching: (b) => b?.name === "crafting_table", maxDistance: 5 });
  if (!tableRes.ok || !nearTable) {
    return { ok: false, phase: "wood", message: `table: ${tableRes?.message || "not reachable"}` };
  }

  if (!hasPickaxe(bot)) {
    await ensurePlanks(bot, mcData, 3);
    if (countItem(bot, "stick") < 2) await ensureCraft(bot, mcData, "stick", 4);
    const cr = await ensureCraft(bot, mcData, "wooden_pickaxe", 1);
    if (!cr.ok) {
      return { ok: false, phase: "wood", message: `craft pick failed: ${cr.message}` };
    }
  }

  if (!hasAny(bot, ["wooden_axe", "stone_axe", "iron_axe", "diamond_axe"])) {
    await ensureCraft(bot, mcData, "wooden_axe", 1);
  }

  if (!hasPickaxe(bot)) {
    return { ok: false, phase: "wood", message: "still no pickaxe after craft" };
  }

  try {
    const pick = bot.inventory.items().find((i) => i.name.includes("pickaxe"));
    if (pick) await bot.equip(pick, "hand");
  } catch {
    /* ignore */
  }

  return { ok: true, phase: "wood", message: "wood tools ready", milestone: "WOOD_TOOLS" };
}

async function phaseStone(bot, mcData, state, log) {
  if (!hasPickaxe(bot)) {
    // should not be in stone phase without pick — fall back
    return { ok: false, phase: "stone", message: "stone phase without pickaxe" };
  }
  try {
    const pick = bot.inventory.items().find((i) => i.name.includes("pickaxe"));
    if (pick) await bot.equip(pick, "hand");
  } catch {
    /* ignore */
  }

  await ensureTable(bot, mcData);
  const cobble = countItem(bot, "cobblestone");
  if (cobble < 12) {
    // Prefer digging a few nearby stone blocks (bounded) over open-ended collect
    const stonePos = bot.findBlocks({
      matching: (b) => b && (b.name === "stone" || b.name === "cobblestone" || b.name === "deepslate"),
      maxDistance: 16,
      count: 6,
    });
    let dug = 0;
    for (const pos of stonePos) {
      const dig = await executeAction(bot, { type: "dig", x: pos.x, y: pos.y, z: pos.z }, mcData);
      if (dig.ok) dug += 1;
      if (dug >= 4) break;
    }
    if (dug === 0) {
      let r = await executeAction(
        bot,
        { type: "collect", block: "stone", count: 4, maxDistance: 16, timeoutMs: 30000 },
        mcData
      );
      if (!r.ok) {
        r = await executeAction(
          bot,
          { type: "collect", block: "cobblestone", count: 4, maxDistance: 16, timeoutMs: 30000 },
          mcData
        );
      }
      if (!r.ok) {
        // Dig straight down a few blocks to hit stone
        const p = bot.entity.position.floored();
        for (let dy = 0; dy <= 5; dy++) {
          const blk = bot.blockAt(p.offset(0, -1 - dy, 0));
          if (!blk || blk.name === "air" || blk.name === "bedrock") break;
          const dig = await executeAction(
            bot,
            { type: "dig", x: blk.position.x, y: blk.position.y, z: blk.position.z },
            mcData
          );
          if (dig.ok && /stone|cobble|deepslate/.test(blk.name)) break;
        }
      }
    }
    // pick up drops
    try {
      await executeAction(bot, { type: "wait", ms: 400 }, mcData);
    } catch {
      /* ignore */
    }
    const now = countItem(bot, "cobblestone");
    return {
      ok: true,
      phase: "stone",
      message: `mine stone (${now} cobble)`,
      milestone: now > cobble ? "STONE_GATHER" : undefined,
    };
  }

  // sticks required for tools
  if (countItem(bot, "stick") < 4) {
    await ensurePlanks(bot, mcData, 4);
    await ensureCraft(bot, mcData, "stick", 8);
  }
  if (countItem(bot, "stick") < 2) {
    return { ok: false, phase: "stone", message: "need sticks for stone tools" };
  }
  await ensureTable(bot, mcData);

  if (!hasAny(bot, ["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe"])) {
    const cr = await ensureCraft(bot, mcData, "stone_pickaxe", 1);
    if (!cr.ok) return { ok: false, phase: "stone", message: `stone pick: ${cr.message}` };
  }
  if (!hasAny(bot, ["stone_sword", "iron_sword", "diamond_sword"])) {
    await ensureCraft(bot, mcData, "stone_sword", 1);
  }
  if (!hasAny(bot, ["stone_axe", "iron_axe", "diamond_axe"])) {
    await ensureCraft(bot, mcData, "stone_axe", 1);
  }
  if (countItem(bot, "furnace") < 1) {
    await ensureCraft(bot, mcData, "furnace", 1);
  }
  if (!hasAny(bot, ["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe"])) {
    return { ok: false, phase: "stone", message: "still no stone pickaxe" };
  }
  return { ok: true, phase: "stone", message: "stone tools", milestone: "STONE_TOOLS" };
}

async function phaseIron(bot, mcData, state, log) {
  // Equip best pick always
  try {
    const pick =
      bot.inventory.items().find((i) => i.name === "iron_pickaxe") ||
      bot.inventory.items().find((i) => i.name === "stone_pickaxe") ||
      bot.inventory.items().find((i) => i.name.includes("pickaxe"));
    if (pick) await bot.equip(pick, "hand");
  } catch {
    /* ignore */
  }

  const ingots = countItem(bot, "iron_ingot");
  const raw = countItem(bot, "raw_iron") + countItem(bot, "iron_ore") + countItem(bot, "deepslate_iron_ore");

  // Need enough iron material for pick (3) + sword (2) + shield (1) ≈ 6; aim 8
  if (ingots < 8 && raw < 8) {
    let r = await executeAction(
      bot,
      { type: "collect", block: "iron_ore", count: 6, maxDistance: 32, timeoutMs: 45000 },
      mcData
    );
    if (!r.ok) {
      r = await executeAction(
        bot,
        { type: "collect", block: "deepslate_iron_ore", count: 6, maxDistance: 32, timeoutMs: 45000 },
        mcData
      );
    }
    // also grab coal for smelting
    await executeAction(bot, { type: "collect", block: "coal_ore", count: 4, maxDistance: 24, timeoutMs: 25000 }, mcData);
    return { ok: true, phase: "iron", message: "mine iron", milestone: "IRON_ORE" };
  }

  // Craft/place furnace before smelt
  if (ingots < 8 && raw > 0) {
    await ensureTable(bot, mcData);
    if (countItem(bot, "furnace") < 1 && !bot.findBlock({ matching: (b) => b?.name === "furnace", maxDistance: 12 })) {
      if (countItem(bot, "cobblestone") >= 8) {
        await ensureCraft(bot, mcData, "furnace", 1);
      }
    }
    if (!bot.findBlock({ matching: (b) => b?.name === "furnace", maxDistance: 12 }) && countItem(bot, "furnace") > 0) {
      // place on solid support like table
      const feet = bot.entity.position.floored();
      const under = bot.blockAt(feet.offset(0, -1, 0));
      if (under) {
        const t = under.position.offset(1, 1, 0);
        await executeAction(bot, { type: "place", item: "furnace", x: t.x, y: t.y, z: t.z, face: "top" }, mcData);
      }
      if (!bot.findBlock({ matching: (b) => b?.name === "furnace", maxDistance: 8 })) {
        await executeAction(bot, { type: "place", item: "furnace" }, mcData);
      }
    }

    // fuel preference: coal > charcoal > log > planks
    let fuel = "coal";
    if (countItem(bot, "coal") < 1 && countItem(bot, "charcoal") > 0) fuel = "charcoal";
    else if (countItem(bot, "coal") < 1) {
      const logItem = bot.inventory.items().find((i) => i.name.includes("log"));
      fuel = logItem?.name || "oak_planks";
    }
    const need = Math.min(8 - ingots, raw, 8);
    await executeAction(
      bot,
      { type: "smelt", input: "raw_iron", output: "iron_ingot", fuel, count: need },
      mcData
    );
    if (countItem(bot, "iron_ingot") < 3) {
      await executeAction(
        bot,
        { type: "smelt", input: "iron_ore", output: "iron_ingot", fuel, count: Math.min(5, raw) },
        mcData
      );
    }
    return {
      ok: true,
      phase: "iron",
      message: `smelt iron (ingots=${countItem(bot, "iron_ingot")})`,
      milestone: countItem(bot, "iron_ingot") > ingots ? "IRON_SMELT" : undefined,
    };
  }

  // Craft iron tools — pick first (gate to diamond phase)
  await ensureTable(bot, mcData);
  if (!hasAny(bot, ["iron_pickaxe", "diamond_pickaxe"])) {
    if (countItem(bot, "stick") < 2) await ensureCraft(bot, mcData, "stick", 4);
    const cr = await ensureCraft(bot, mcData, "iron_pickaxe", 1);
    if (!cr.ok) return { ok: false, phase: "iron", message: `iron pick: ${cr.message}` };
  }
  if (!hasAny(bot, ["iron_sword", "diamond_sword"])) {
    await ensureCraft(bot, mcData, "iron_sword", 1);
  }
  if (!hasAny(bot, ["shield"])) {
    await ensureCraft(bot, mcData, "shield", 1);
  }
  // armor if enough leftover iron
  if (countItem(bot, "iron_ingot") >= 5 && !hasAny(bot, ["iron_chestplate"])) {
    await ensureCraft(bot, mcData, "iron_chestplate", 1);
  }
  if (countItem(bot, "iron_ingot") >= 5 && !hasAny(bot, ["iron_helmet"])) {
    await ensureCraft(bot, mcData, "iron_helmet", 1);
  }
  try {
    const pick = bot.inventory.items().find((i) => i.name === "iron_pickaxe");
    if (pick) await bot.equip(pick, "hand");
    await equipBestWeapon(bot);
  } catch {
    /* ignore */
  }
  if (!hasAny(bot, ["iron_pickaxe", "diamond_pickaxe"])) {
    return { ok: false, phase: "iron", message: "still no iron pickaxe" };
  }
  return { ok: true, phase: "iron", message: "iron gear", milestone: "IRON_GEAR" };
}

/** Dig straight down a few blocks toward targetY (1.21 diamonds ~ y=-59). */
async function digStaircaseDown(bot, mcData, targetY, maxDigs = 8) {
  let digs = 0;
  const startY = Math.floor(bot.entity.position.y);
  while (Math.floor(bot.entity.position.y) > targetY + 1 && digs < maxDigs) {
    const feet = bot.entity.position.floored();
    // Scan down a few blocks for solid ground to dig (player may float / stand in air cell)
    let blk = null;
    for (let dy = 1; dy <= 4; dy++) {
      const cand = bot.blockAt(feet.offset(0, -dy, 0));
      if (!cand || cand.name === "air" || cand.name === "cave_air" || cand.name === "void_air") continue;
      if (cand.name === "bedrock") return { ok: false, message: "bedrock", digs, y: feet.y };
      if (/lava|water/.test(cand.name)) return { ok: false, message: `${cand.name} below`, digs, y: feet.y };
      blk = cand;
      break;
    }
    if (!blk) break;
    const dig = await executeAction(
      bot,
      { type: "dig", x: blk.position.x, y: blk.position.y, z: blk.position.z, timeoutMs: 12000 },
      mcData
    );
    if (!dig.ok) return { ok: false, message: dig.message, digs, y: Math.floor(bot.entity.position.y) };
    digs += 1;
    await sleep(400);
  }
  return { ok: true, digs, y: Math.floor(bot.entity.position.y), from: startY };
}

function isDiggableStone(name) {
  if (!name || name === "air" || name === "bedrock" || name === "cave_air" || name === "void_air") return false;
  if (/lava|water|portal|torch|ladder|rail|button|lever|sign|carpet|snow|fire/.test(name)) return false;
  return true; // any solid-ish terrain block
}

/** Dig a block in reach without pathfinder (used for strip mining). */
async function digInReach(bot, block, timeoutMs = 10000, combat = null) {
  if (!block || !bot.entity) return { ok: false, message: "no block" };
  const dist = bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5));
  if (dist > 4.5) return { ok: false, message: `too far ${dist.toFixed(1)}` };
  const prevCombat = combat?.mode;
  try {
    // combat-reflex aborts digs every tick — park it while mining
    if (combat?.setMode) combat.setMode("off");
  } catch {
    /* ignore */
  }
  try {
    const pick =
      bot.inventory.items().find((i) => i.name.includes("diamond_pickaxe")) ||
      bot.inventory.items().find((i) => i.name.includes("iron_pickaxe")) ||
      bot.inventory.items().find((i) => i.name.includes("pickaxe"));
    if (pick && bot.heldItem?.name !== pick.name) {
      await bot.equip(pick, "hand");
    }
  } catch {
    /* ignore equip */
  }
  if (!block.canHarvest(bot.heldItem?.type ?? null)) {
    try {
      if (combat?.setMode && prevCombat) combat.setMode(prevCombat);
    } catch {
      /* ignore */
    }
    return { ok: false, message: `cannot harvest ${block.name} with ${bot.heldItem?.name || "hand"}` };
  }
  try {
    bot.pathfinder?.setGoal?.(null);
    bot.clearControlStates();
  } catch {
    /* ignore */
  }
  let lastErr = "dig failed";
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const live = bot.blockAt(block.position);
        if (!live || live.name === "air") return { ok: true, message: "already air" };
        await bot.lookAt(live.position.offset(0.5, 0.5, 0.5), true);
        const before = live.type;
        await Promise.race([
          bot.dig(live),
          new Promise((_, rej) => setTimeout(() => rej(new Error("dig timeout")), timeoutMs)),
        ]);
        const after = bot.blockAt(block.position);
        if (after?.type === before) {
          lastErr = "not broken";
          continue;
        }
        return { ok: true, message: `dug ${live.name}` };
      } catch (err) {
        lastErr = err?.message || String(err);
        try {
          bot.stopDigging?.();
          bot.clearControlStates();
        } catch {
          /* ignore */
        }
        await sleep(150);
      }
    }
    return { ok: false, message: lastErr };
  } finally {
    try {
      if (combat?.setMode) combat.setMode(prevCombat || "auto");
    } catch {
      /* ignore */
    }
  }
}

async function stripMineTunnel(bot, mcData, state) {
  const feet = bot.entity.position.floored();
  let dug = 0;
  let lastErr = "";

  const combat = state.combat || null;

  // 1) Diamond ore in reach
  const diamondBlock = bot.findBlock({
    matching: (b) => b && b.name.includes("diamond"),
    maxDistance: 4,
  });
  if (diamondBlock) {
    const dig = await digInReach(bot, diamondBlock, 20000, combat);
    if (dig.ok) return { dug: 1, turned: false, target: "diamond" };
    lastErr = dig.message;
  }

  // 2) Dig solid blocks in a 3x3x3 shell around the bot
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const blk = bot.blockAt(feet.offset(dx, dy, dz));
        if (!blk || !isDiggableStone(blk.name)) continue;
        const dig = await digInReach(bot, blk, 8000, combat);
        if (dig.ok) {
          dug += 1;
          if (dug >= 5) break;
        } else {
          lastErr = dig.message;
        }
      }
      if (dug >= 5) break;
    }
    if (dug >= 5) break;
  }

  // 3) Farther solid via path dig
  if (dug === 0) {
    const solid = bot.findBlock({
      matching: (b) => b && isDiggableStone(b.name) && b.name !== "crafting_table" && b.name !== "furnace",
      maxDistance: 16,
    });
    if (solid) {
      const dig = await executeAction(
        bot,
        { type: "dig", x: solid.position.x, y: solid.position.y, z: solid.position.z, timeoutMs: 15000 },
        mcData
      );
      if (dig.ok) dug += 1;
      else lastErr = dig.message;
    } else {
      lastErr = lastErr || "no solid nearby";
    }
  }

  // 4) Move
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const di = state.diamondDirIndex || 0;
  const [dx, dz] = dirs[di % 4];
  const move = await executeAction(
    bot,
    {
      type: "goto",
      x: feet.x + dx * 3,
      y: feet.y,
      z: feet.z + dz * 3,
      range: 1,
      timeoutMs: 10000,
    },
    mcData
  );
  if (!move.ok) state.diamondDirIndex = di + 1;

  return { dug, turned: !move.ok, lastErr };
}

async function phaseDiamond(bot, mcData, state, log) {
  if (!hasAny(bot, ["iron_pickaxe", "diamond_pickaxe"])) {
    return { ok: false, phase: "diamond", message: "need iron pick for diamonds" };
  }
  try {
    const pick =
      bot.inventory.items().find((i) => i.name.includes("diamond_pickaxe")) ||
      bot.inventory.items().find((i) => i.name.includes("iron_pickaxe"));
    if (pick) await bot.equip(pick, "hand");
  } catch {
    /* ignore */
  }

  if (Number(bot.food) < 14) {
    await executeAction(bot, { type: "eat" }, mcData);
  }

  if (countItem(bot, "diamond") < 5 && !hasAny(bot, ["diamond_pickaxe"])) {
    const y = Math.floor(bot.entity.position.y);

    // First: any diamond already in range?
    let r = await executeAction(
      bot,
      { type: "collect", block: "deepslate_diamond_ore", count: 2, maxDistance: 32, timeoutMs: 40000 },
      mcData
    );
    if (!r.ok) {
      r = await executeAction(
        bot,
        { type: "collect", block: "diamond_ore", count: 2, maxDistance: 32, timeoutMs: 40000 },
        mcData
      );
    }
    if (r.ok || countItem(bot, "diamond") > 0) {
      const d = countItem(bot, "diamond");
      return {
        ok: true,
        phase: "diamond",
        message: `got diamond ore d=${d}`,
        milestone: d > 0 ? "DIAMOND_ORE" : undefined,
      };
    }

    // Get deeper if too high
    if (y > -52) {
      const shaft = await digStaircaseDown(bot, mcData, -58, 10);
      if (shaft.digs > 0) {
        return {
          ok: true,
          phase: "diamond",
          message: `shaft down y=${shaft.y} digs=${shaft.digs}`,
          milestone: "DIAMOND_SHAFT",
        };
      }
      // can't dig down (air/float) — strip at current depth instead
    }

    const tunnel = await stripMineTunnel(bot, mcData, state);
    const d = countItem(bot, "diamond");
    const held = bot.heldItem?.name || "hand";
    return {
      ok: true,
      phase: "diamond",
      message: `strip y=${Math.floor(bot.entity.position.y)} dug=${tunnel.dug} d=${d} held=${held}${tunnel.lastErr ? " err=" + tunnel.lastErr : ""}`,
      milestone: d > 0 ? "DIAMOND_ORE" : tunnel.dug > 0 ? "DIAMOND_STRIP" : undefined,
    };
  }
  await ensureTable(bot, mcData);
  if (countItem(bot, "diamond") >= 3 && !hasAny(bot, ["diamond_pickaxe"])) {
    if (countItem(bot, "stick") < 2) await ensureCraft(bot, mcData, "stick", 4);
    await ensureCraft(bot, mcData, "diamond_pickaxe", 1);
  }
  if (countItem(bot, "diamond") >= 2 && !hasAny(bot, ["diamond_sword"])) {
    await ensureCraft(bot, mcData, "diamond_sword", 1);
  }
  if (hasAny(bot, ["diamond_pickaxe"])) {
    return { ok: true, phase: "diamond", message: "diamond gear", milestone: "DIAMOND_GEAR" };
  }
  return { ok: true, phase: "diamond", message: "diamond gear attempt", milestone: "DIAMOND_ORE" };
}

async function phasePortal(bot, mcData, state, log) {
  // Need obsidian 10 + flint and steel
  if (countItem(bot, "obsidian") < 10) {
    // bucket method: water + lava
    if (countItem(bot, "water_bucket") < 1 && countItem(bot, "bucket") < 1) {
      if (countItem(bot, "iron_ingot") >= 3) await ensureCraft(bot, mcData, "bucket", 1);
    }
    // find lava lake
    const lava = bot.findBlock({ matching: (b) => b?.name === "lava", maxDistance: 48 });
    if (lava) {
      await executeAction(
        bot,
        { type: "goto", x: lava.position.x, y: lava.position.y, z: lava.position.z, range: 3 },
        mcData
      );
    }
    // dig for obsidian if already formed
    await executeAction(bot, { type: "collect", block: "obsidian", count: 10, maxDistance: 32 }, mcData);
    // if still low: mine more diamonds/iron for bucket and cast
    if (countItem(bot, "obsidian") < 10 && countItem(bot, "water_bucket") > 0) {
      // place water on lava source to make obsidian — simplified: look for lava and use_item
      await executeAction(bot, { type: "use_item", item: "water_bucket" }, mcData);
      await executeAction(bot, { type: "collect", block: "obsidian", count: 10, maxDistance: 16 }, mcData);
    }
    return { ok: true, phase: "portal", message: "obsidian", milestone: "OBSIDIAN" };
  }
  if (!hasAny(bot, ["flint_and_steel"])) {
    if (countItem(bot, "flint") < 1) {
      await executeAction(bot, { type: "collect", block: "gravel", count: 16, maxDistance: 32 }, mcData);
    }
    await ensureCraft(bot, mcData, "flint_and_steel", 1);
  }
  // Build 4x5 portal frame
  const base = bot.entity.position.floored();
  const ox = base.x + 2;
  const oy = base.y;
  const oz = base.z;
  // place vertical frame (simplified rectangle)
  const frame = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [0, 1],
    [3, 1],
    [0, 2],
    [3, 2],
    [0, 3],
    [3, 3],
    [0, 4],
    [1, 4],
    [2, 4],
    [3, 4],
  ];
  for (const [dx, dy] of frame) {
    await executeAction(
      bot,
      { type: "place", item: "obsidian", x: ox + dx, y: oy + dy, z: oz, face: "top" },
      mcData
    );
  }
  // light
  await executeAction(bot, { type: "use_block", block: "obsidian", item: "flint_and_steel", x: ox + 1, y: oy + 1, z: oz }, mcData);
  // enter portal
  await executeAction(bot, { type: "goto", x: ox + 1.5, y: oy + 1, z: oz, range: 0.5 }, mcData);
  await sleep(4000);
  return { ok: true, phase: "portal", message: "portal build/enter", milestone: "PORTAL" };
}

async function phaseNetherBlaze(bot, mcData, state, log) {
  // Explore nether: fight blazes if fortress nearby
  const blaze = Object.values(bot.entities).find((e) => mobName(e) === "blaze");
  if (blaze) {
    await executeAction(bot, { type: "attack", name: "blaze", maxDurationMs: 20000, maxDistance: 24 }, mcData);
    return { ok: true, phase: "blaze", message: "fight blaze", milestone: "BLAZE_FIGHT" };
  }
  // find nether bricks = fortress
  const brick = bot.findBlock({
    matching: (b) => b && (b.name === "nether_bricks" || b.name === "nether_brick_fence"),
    maxDistance: 64,
  });
  if (brick) {
    await executeAction(
      bot,
      { type: "goto", x: brick.position.x, y: brick.position.y, z: brick.position.z, range: 2, timeoutMs: 90000 },
      mcData
    );
    return { ok: true, phase: "blaze", message: "goto fortress", milestone: "FORTRESS" };
  }
  // random explore
  const p = bot.entity.position;
  const ang = Math.random() * Math.PI * 2;
  const nx = p.x + Math.cos(ang) * 40;
  const nz = p.z + Math.sin(ang) * 40;
  await executeAction(bot, { type: "goto", x: nx, y: p.y, z: nz, range: 3, timeoutMs: 60000 }, mcData);
  // fight piglins/ghasts if attacked
  await executeAction(bot, { type: "attack", maxDurationMs: 8000, maxDistance: 16 }, mcData);
  return { ok: true, phase: "nether", message: "explore nether", milestone: "NETHER_EXPLORE" };
}

async function phasePearls(bot, mcData, state, log) {
  // Prefer overworld endermen
  const dim = String(bot.game?.dimension || "");
  if (/nether/i.test(dim)) {
    // go back through portal if we have enough rods
    const portal = bot.findBlock({ matching: (b) => b?.name === "nether_portal", maxDistance: 64 });
    if (portal) {
      await executeAction(
        bot,
        { type: "goto", x: portal.position.x, y: portal.position.y, z: portal.position.z, range: 1 },
        mcData
      );
      await sleep(4000);
    }
    return { ok: true, phase: "pearls", message: "return overworld for pearls" };
  }
  const enderman = Object.values(bot.entities).find((e) => mobName(e) === "enderman");
  if (enderman) {
    await executeAction(bot, { type: "attack", name: "enderman", maxDurationMs: 25000, maxDistance: 24 }, mcData);
    return { ok: true, phase: "pearls", message: "hunt enderman", milestone: "ENDERMAN" };
  }
  // wander night-ish
  const p = bot.entity.position;
  await executeAction(
    bot,
    { type: "goto", x: p.x + (Math.random() - 0.5) * 60, y: p.y, z: p.z + (Math.random() - 0.5) * 60, range: 2 },
    mcData
  );
  return { ok: true, phase: "pearls", message: "search endermen" };
}

async function phaseEyes(bot, mcData, state, log) {
  const pearls = countItem(bot, "ender_pearl");
  const powder = countItem(bot, "blaze_powder") || countItem(bot, "blaze_rod") * 2;
  if (powder < 1 && countItem(bot, "blaze_rod") > 0) {
    await ensureCraft(bot, mcData, "blaze_powder", Math.min(12, countItem(bot, "blaze_rod") * 2));
  }
  while (countItem(bot, "ender_eye") < Math.min(12, pearls) && countItem(bot, "ender_pearl") > 0) {
    const r = await ensureCraft(bot, mcData, "ender_eye", 1);
    if (!r.ok) break;
  }
  return {
    ok: true,
    phase: "eyes",
    message: `eyes=${countItem(bot, "ender_eye")}`,
    milestone: countItem(bot, "ender_eye") >= 12 ? "EYES_12" : "EYES_CRAFT",
  };
}

async function phaseStronghold(bot, mcData, state, log) {
  // Throw eye and path roughly — mineflayer eye throw is complex; use explore + locate if op
  // Fair: use ender eye item activate and follow
  if (countItem(bot, "ender_eye") > 0) {
    try {
      const eye = bot.inventory.items().find((i) => i.name === "ender_eye");
      if (eye) {
        await bot.equip(eye, "hand");
        // look up slightly and throw
        await bot.look(bot.entity.yaw, -0.4, true);
        bot.activateItem();
        await sleep(200);
        bot.deactivateItem();
        // chase nearest eye entity
        await sleep(1500);
        const flying = Object.values(bot.entities).find((e) => /eye/i.test(String(e.name || "")));
        if (flying) {
          await executeAction(
            bot,
            {
              type: "goto",
              x: flying.position.x,
              y: bot.entity.position.y,
              z: flying.position.z,
              range: 2,
              timeoutMs: 60000,
            },
            mcData
          );
        }
      }
    } catch {
      /* ignore */
    }
  }
  // look for stronghold blocks
  const portal = bot.findBlock({
    matching: (b) => b && (b.name === "end_portal_frame" || b.name === "end_portal" || b.name === "stone_bricks"),
    maxDistance: 48,
  });
  if (portal?.name === "end_portal_frame" || portal?.name === "end_portal") {
    await executeAction(
      bot,
      { type: "goto", x: portal.position.x, y: portal.position.y, z: portal.position.z, range: 2 },
      mcData
    );
    // fill eyes
    const frames = bot.findBlocks({
      matching: (b) => b?.name === "end_portal_frame",
      maxDistance: 16,
      count: 12,
    });
    for (const fp of frames) {
      if (countItem(bot, "ender_eye") < 1) break;
      await executeAction(
        bot,
        { type: "use_block", block: "end_portal_frame", item: "ender_eye", x: fp.x, y: fp.y, z: fp.z },
        mcData
      );
    }
    const open = bot.findBlock({ matching: (b) => b?.name === "end_portal", maxDistance: 12 });
    if (open) {
      await executeAction(bot, { type: "goto", x: open.position.x, y: open.position.y, z: open.position.z, range: 0.5 }, mcData);
      await sleep(5000);
      return { ok: true, phase: "stronghold", message: "entered end", milestone: "ENTER_END" };
    }
    return { ok: true, phase: "stronghold", message: "at frames", milestone: "STRONGHOLD" };
  }
  // wander
  const p = bot.entity.position;
  await executeAction(
    bot,
    { type: "goto", x: p.x + (Math.random() - 0.5) * 80, y: p.y, z: p.z + (Math.random() - 0.5) * 80, range: 3, timeoutMs: 90000 },
    mcData
  );
  return { ok: true, phase: "stronghold", message: "search stronghold" };
}

async function phaseDragon(bot, mcData, state, log) {
  const dragon = Object.values(bot.entities).find((e) => /dragon/i.test(mobName(e)));
  if (!dragon) {
    return { ok: true, phase: "clear", message: "no dragon — clear?", milestone: "CLEAR" };
  }
  state.boss = state.boss || { allowStickTp: false };
  state.boss.allowStickTp = false;
  await bossCombatTick(bot, dragon, state.boss, log);
  // crystals
  const crystal = Object.values(bot.entities).find((e) => mobName(e) === "end_crystal");
  if (crystal) {
    await executeAction(bot, { type: "attack", name: "end_crystal", maxDurationMs: 10000, maxDistance: 48 }, mcData);
  }
  return { ok: true, phase: "dragon", message: "fighting dragon", milestone: "DRAGON_FIGHT" };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
