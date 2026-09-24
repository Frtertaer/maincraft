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
    // Wood is the universal prerequisite for the surface toolchain — a
    // leftover pick can push detectPhase past wood with zero logs in
    // inventory, and then nothing craftable is ever reachable.
    if (["stone", "iron", "diamond", "food_armor"].includes(phase)) {
      const logs = countItem(bot, (i) => i.name.includes("log") || i.name.endsWith("_stem"));
      const planks = countItem(bot, (i) => i.name.includes("planks"));
      if (logs + planks < 4) {
        const rr = await punchNearbyLogs(bot, mcData, 4, state);
        if (!rr.ok) {
          // tree visible but unreachable (cliff/lava spawn) — walk toward the
          // nearest log so the next attempt searches a different space
          const t = bot.findBlock({
            matching: (b) => b && b.name.endsWith("_log"),
            maxDistance: 48,
          });
          if (t) {
            await executeAction(
              bot,
              { type: "goto", x: t.position.x, y: t.position.y, z: t.position.z, range: 6, timeoutMs: 15000 },
              mcData
            ).catch(() => {});
          }
        }
        return {
          ok: rr.ok,
          phase,
          message: rr.ok ? "wood prereq" : `wood prereq: ${rr.message || "no logs"}`,
        };
      }
    }
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
        return await phaseExitPortal(bot, mcData, state, log);
      default:
        return { ok: false, phase, message: `unknown phase ${phase}` };
    }
  } catch (err) {
    log?.(`[progression] ${phase} crash: ${err?.stack || err}`);
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

// mineflayer calls that wait on server acks (equip/placeBlock) can hang
// forever when the ack packet is lost — race every such call against a timer
function pt(promise, timeoutMs, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timeout`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function findHostile(bot, range) {
  return Object.values(bot.entities || {}).find((e) => {
    if (!e?.position || e === bot.entity) return false;
    const n = String(e.name || e.displayName || "").toLowerCase();
    const hostile =
      e.kind === "Hostile mobs" ||
      /zombie|skeleton|creeper|spider|enderman|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
    return hostile && e.position.distanceTo(bot.entity.position) < range;
  });
}

const HAND_DIGGABLE =
  /^(dirt|coarse_dirt|rooted_dirt|dirt_path|grass_block|farmland|podzol|mycelium|sand|red_sand|gravel|clay|mud|muddy_mangrove_roots|snow|snow_block|soul_soil|soul_sand|moss_block|pale_moss_block|.*_log|.*_planks|.*_leaves)$/;

// terrain the bot can actually break with what it carries — mineflayer's
// b.diggable doesn't account for harvestTools, so check by name class: a
// small set is always hand-breakable, everything else needs a pickaxe
function diggableBlock(bot, b) {
  if (!b || /air|lava|water|magma_block|bedrock|cave_air|void_air/.test(b.name)) return false;
  if (HAND_DIGGABLE.test(b.name)) return true;
  return bot.inventory.items().some((i) => /pickaxe/.test(i.name)) && isDiggableStone(b.name);
}

async function ensureCraft(bot, mcData, item, count = 1) {
  return executeAction(bot, { type: "craft", item, count }, mcData);
}

async function ensureSticks(bot, mcData, min = 4) {
  if (countItem(bot, "stick") >= min) return { ok: true, message: "have sticks" };
  if (countItem(bot, (i) => i.name.includes("planks")) < 2) {
    const pl = await ensurePlanks(bot, mcData, 4);
    if (!pl.ok && countItem(bot, (i) => i.name.includes("planks")) < 2) {
      return { ok: false, message: pl.message || "need planks for sticks" };
    }
  }
  const cr = await ensureCraft(bot, mcData, "stick", Math.max(4, min));
  if (!cr.ok && countItem(bot, "stick") < 2) return { ok: false, message: `sticks: ${cr.message}` };
  return { ok: true, message: "sticks ready" };
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

// pick the table back up — a speedrun carries its station; leaving it
// behind means every later 3x3 craft hunts a stale unreachable table
async function pullTable(bot, mcData) {
  const t = bot.findBlock({ matching: (b) => b?.name === "crafting_table", maxDistance: 6 });
  if (!t) return;
  try {
    await executeAction(
      bot,
      { type: "dig", x: t.position.x, y: t.position.y, z: t.position.z, timeoutMs: 8000 },
      mcData
    );
  } catch {
    /* keep it for the next craft */
  }
}

async function ensureTable(bot, mcData) {
  // Reachable table is enough (mineflayer craft range ~4)
  const near = bot.findBlock({ matching: (b) => b?.name === "crafting_table", maxDistance: 4 });
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
    const again = bot.findBlock({ matching: (b) => b?.name === "crafting_table", maxDistance: 4 });
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
      const b = bot.findBlock({ matching: (bl) => bl?.name === "crafting_table", maxDistance: 4 });
      if (b) return { ok: true, message: r.message, block: b };
    }
  }

  // last resort: let actions.js auto-pick a neighbor of feet
  const auto = await executeAction(bot, { type: "place", item: "crafting_table" }, mcData);
  await sleep(200);
  const b =
    bot.findBlock({ matching: (bl) => bl?.name === "crafting_table", maxDistance: 4 }) ||
    null;
  if (auto.ok || b) return { ok: true, message: auto.message, block: b };
  return { ok: false, message: `place table failed: ${lastMsg || auto.message}` };
}

const FACES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function isExposedFace(bot, pos) {
  if (!pos) return false;
  return FACES.some(([dx, dy, dz]) => {
    const nb = bot.blockAt(pos.offset(dx, dy, dz));
    return nb && (nb.boundingBox === "empty" || /air|water|grass|fern|flower|sapling|snow|vine/.test(nb.name));
  });
}

// Mines a walkable staircase down `levels` — each step clears the 2-cell doorway
// of the cell one block ahead-and-below (in any of 4 horizontal dirs, skipping
// lava/water and ≥4-block drops) then steps down into it.
async function stairDown(bot, mcData, levels = 9, log = null, path = null) {
  const dirs = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ];
  const dangerous = (b) => b && /lava|water|magma_block|bedrock/.test(b.name);
  let dug = 0;
  let supersededRetries = 0;
  for (let k = 0; k < levels; k++) {
    const p = bot.entity.position.floored();
    let stepped = false;
    let superseded = false;
    const why = [];
    for (const [dx, dz] of dirs) {
      // reject if the landing floor is dangerous or a ≥4-block drop
      const floor1 = bot.blockAt(p.offset(dx, -2, dz));
      const floor2 = bot.blockAt(p.offset(dx, -3, dz));
      const floor3 = bot.blockAt(p.offset(dx, -4, dz));
      const tag = `d${dx},${dz}`;
      if (dangerous(floor1) || dangerous(floor2) || dangerous(floor3)) {
        why.push(`${tag}:lava@${floor1?.name === "air" ? "f2" : "f1"}`);
        continue;
      }
      if (floor1?.name === "air" && floor2?.name === "air" && floor3?.name === "air") {
        why.push(`${tag}:drop`);
        continue;
      }
      // don't dig into a mob's lap: hostile entities load through walls, so
      // anything within 12 of the door cell is a real ambush risk
      const door = p.offset(dx, 0, dz);
      const ambush = Object.values(bot.entities || {}).some((e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || e.displayName || "").toLowerCase();
        return (
          (e.kind === "Hostile mobs" ||
            /zombie|skeleton|creeper|spider|enderman|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n)) &&
          e.position.distanceTo(door) < 12
        );
      });
      if (ambush) {
        why.push(`${tag}:mob`);
        continue;
      }
      // Reject a dir whose doorway is a hole ≥3 deep — door and two cells
      // below it all air means a cliff edge or cave mouth, not a slope.
      // Flat ground has a solid cell at -1 and is fine to step.
      const doorAir = (dy) => {
        const c = bot.blockAt(p.offset(dx, dy, dz));
        return !c || /air|cave_air|void_air/.test(c.name);
      };
      if (doorAir(0) && doorAir(-1) && doorAir(-2)) {
        why.push(`${tag}:open`);
        continue;
      }
      // clear the doorway column: headroom (+1), feet (0), floor (-1) —
      // without +1 a solid ceiling leaves a 1-high slot the pathfinder
      // can never enter (the goto-timeout loop seen on mountain slopes)
      let blocked = false;
      for (const dy of [1, 0, -1]) {
        const blk = bot.blockAt(p.offset(dx, dy, dz));
        if (!blk || blk.name === "air") continue;
        if (dangerous(blk)) {
          blocked = true;
          why.push(`${tag}:cell${dy}=${blk.name}`);
          break;
        }
        const dig = await executeAction(
          bot,
          { type: "dig", x: blk.position.x, y: blk.position.y, z: blk.position.z, timeoutMs: 10000 },
          mcData
        );
        if (!dig.ok) {
          blocked = true;
          why.push(`${tag}:dig${dy}=${dig.message}`);
          break;
        }
      }
      if (blocked) continue;
      // target the actual landing cell: first solid floor below the doorway
      // (a GoalNear at the doorway mid-air cell is unreachable when the floor
      // drops 2+, which is exactly what "pathfinder timeout" was)
      let landY = null;
      for (let dy = -2; dy >= -4; dy--) {
        const b = bot.blockAt(p.offset(dx, dy, dz));
        if (b && b.name !== "air" && !/lava|water|magma_block|bedrock/.test(b.name)) {
          landY = b.position.y + 1;
          break;
        }
      }
      if (landY == null) {
        why.push(`${tag}:no-floor`);
        continue;
      }
      const stepIn = await executeAction(
        bot,
        { type: "goto", x: p.x + dx + 0.5, y: landY, z: p.z + dz + 0.5, range: 0.7, timeoutMs: 6000 },
        mcData
      );
      if (stepIn.ok) {
        stepped = true;
        dug += 1;
        path?.push({ x: p.x + dx, y: p.y - 1, z: p.z + dz });
        // landed in a mob's lap — bail the staircase so the step ends and the
        // combat reflex fights before we dig the next level down
        if (findHostile(bot, 7)) {
          log?.(`[stairDown] ambush at landing ${p.x + dx},${landY},${p.z + dz} — breaking`);
          break;
        }
        // seal the stair behind us — a 1-high doorway slot is a walkable
        // path mobs follow down (the skeleton-at-y29 lesson). Hang a block
        // on the ceiling face of the doorway head cell. Fire-and-forget:
        // placeBlock's 5s blockUpdate wait stalls every step while the
        // placement itself usually lands anyway.
        const filler = bot.inventory
          .items()
          .find((i) => /dirt|cobblestone|stone|netherrack|sand|gravel|deepslate|andesite|diorite|granite|tuff|blackstone|mud|clay/.test(i.name));
        const ceil = bot.blockAt(p.offset(dx, 2, dz));
        if (filler && ceil && ceil.name !== "air") {
          try {
            await pt(bot.equip(filler, "hand"), 8000, "equip");
            await Promise.race([bot.placeBlock(ceil, new Vec3(0, -1, 0)).catch(() => {}), sleep(900)]);
          } catch {
            /* sealing is best-effort */
          }
        }
        break;
      }
      if (/superseded/i.test(String(stepIn.message || ""))) superseded = true;
      why.push(`${tag}:goto=${stepIn.message}`);
    }
    if (!stepped) {
      if (superseded && supersededRetries < 4) {
        // Combat (or another mover) stole the pathfinder — yield a moment and
        // retry this level instead of giving up the staircase.
        supersededRetries += 1;
        log?.(`[stairDown] superseded at ${p.x},${p.y},${p.z} k=${k} — yielding (retry ${supersededRetries})`);
        await new Promise((r) => setTimeout(r, 700));
        k -= 1;
        continue;
      }
      log?.(`[stairDown] stuck at ${p.x},${p.y},${p.z} k=${k} dug=${dug} :: ${why.join(" | ")}`);
      break;
    }
  }
  return dug;
}

// Strip-mine a 1x2 tunnel `steps` long: dig head+feet cells ahead, step in,
// collect any ore vein now visible in the tunnel walls. Never opens into
// caves — a bad cell ahead rotates the tunnel 90° instead.
async function stripMine(bot, mcData, steps = 20, log = null) {
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  let dirIdx = 0;
  let [dx, dz] = dirs[dirIdx];
  const bad = (b) => !b || /air|lava|water|magma_block|bedrock/.test(b.name);
  let mined = 0;
  let oreHits = 0;
  let spins = 0;
  const mobNear = (cell) =>
    Object.values(bot.entities || {}).some((e) => {
      if (!e?.position || e === bot.entity) return false;
      const n = String(e.name || e.displayName || "").toLowerCase();
      return (
        (e.kind === "Hostile mobs" ||
          /zombie|skeleton|creeper|spider|enderman|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n)) &&
        e.position.distanceTo(cell) < 10
      );
    });
  for (let i = 0; i < steps; i++) {
    const p = bot.entity.position.floored();
    const floor = bot.blockAt(p.offset(dx, -1, dz));
    const f1 = bot.blockAt(p.offset(dx, 0, dz));
    const h1 = bot.blockAt(p.offset(dx, 1, dz));
    // bad() treats air/liquid as bad — an open cell ahead is a cave mouth,
    // and a mob standing near the step cell is an ambush; both rotate
    if (bad(f1) || bad(h1) || !floor || /lava|water|air/.test(floor.name) || mobNear(p.offset(dx, 0, dz))) {
      dirIdx = (dirIdx + 1) % 4;
      [dx, dz] = dirs[dirIdx];
      i -= 1;
      spins += 1;
      if (spins > 12) break;
      continue;
    }
    spins = 0;
    let dug = true;
    for (const dy of [0, 1]) {
      const c = bot.blockAt(p.offset(dx, dy, dz));
      if (c && c.name !== "air") {
        const d = await executeAction(
          bot,
          { type: "dig", x: c.position.x, y: c.position.y, z: c.position.z, timeoutMs: 10000 },
          mcData
        );
        if (!d.ok) {
          dug = false;
          break;
        }
      }
    }
    if (!dug) {
      dirIdx = (dirIdx + 1) % 4;
      [dx, dz] = dirs[dirIdx];
      i -= 1;
      spins += 1;
      if (spins > 12) break;
      continue;
    }
    const step = await executeAction(
      bot,
      { type: "goto", x: p.x + dx + 0.5, y: p.y, z: p.z + dz + 0.5, range: 0.7, timeoutMs: 6000 },
      mcData
    );
    if (!step.ok) break;
    mined += 1;
    // collect ore veins visible in the freshly dug tunnel walls — tight
    // radius so it only mines into stone, never walks into open caves
    for (const ore of [
      "iron_ore",
      "deepslate_iron_ore",
      "coal_ore",
      "deepslate_coal_ore",
      "copper_ore",
      "gold_ore",
      "deepslate_gold_ore",
      "redstone_ore",
      "deepslate_redstone_ore",
      "lapis_ore",
      "deepslate_lapis_ore",
      "diamond_ore",
      "deepslate_diamond_ore",
    ]) {
      const vein = bot.findBlock({ matching: (b) => b?.name === ore, maxDistance: 4 });
      if (vein) {
        const r = await executeAction(
          bot,
          { type: "collect", block: ore, count: 4, maxDistance: 5, timeoutMs: 15000 },
          mcData
        );
        if (r.ok) oreHits += 1;
      }
    }
  }
  log?.(`[stripMine] mined=${mined} oreHits=${oreHits} y=${Math.floor(bot.entity.position.y)}`);
  return { mined, oreHits };
}

// Night survival: dig a straight 1x1 shaft down (~8s, no walkable path for
// mobs to follow), cap the opening with one block, wait for dawn, then pillar
// back out. Returns true when it burrowed.
// pick the flee direction with the least water and jungle canopy along the
// path — drowned rivers and tree trunks are where flee-and-burrow dies
export function pickDryDir(bot, dirs) {
  let best = dirs[0];
  let bestScore = Infinity;
  const feet = bot.entity.position.floored();
  for (const [dx, dz] of dirs) {
    const sx = Math.sign(dx);
    const sz = Math.sign(dz);
    let score = 0;
    for (const step of [6, 12, 18, 24]) {
      for (const dy of [-1, 0]) {
        const b = bot.blockAt(feet.offset(sx * step, dy, sz * step));
        if (!b) continue;
        if (/water|kelp|seagrass|ice|bubble/.test(b.name)) score += 3;
        else if (/_log$|_stem$|leaves$/.test(b.name)) score += 1;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = [dx, dz];
    }
  }
  return best;
}

export async function burrowForNight(bot, mcData, log, force = false, _depth = 0) {
  const tod = bot.time?.timeOfDay;
  if (!force && (tod == null || tod < 12541)) return false;
  // a failed dig leaves the bot standing exposed — relocate to a different
  // patch of ground and try the whole burrow again instead of giving up
  const retryElsewhere = async (why) => {
    if (_depth >= 4) return false;
    log?.(`[burrow] ${why} — relocating`);
    const p = bot.entity.position.floored();
    // a bare-handed bot can only shelter in soft ground — head for the
    // nearest diggable surface block instead of wandering blindly
    let target = null;
    try {
      const soft = bot.findBlocks({
        matching: (b) => {
          const bb = b?.position ? b : bot.blockAt(b);
          if (!bb || bb.name === "air" || /leaves|_log|water|lava/.test(bb.name)) return false;
          const a1 = bot.blockAt(bb.position.offset(0, 1, 0));
          const a2 = bot.blockAt(bb.position.offset(0, 2, 0));
          return a1?.name === "air" && a2?.name === "air" && diggable(bb);
        },
        maxDistance: 40,
        count: 6,
      });
      if (soft.length) target = soft[0];
    } catch {
      /* find failed — fall back to directional wander */
    }
    if (target) {
      try {
        await executeAction(
          bot,
          { type: "goto", x: target.x + 0.5, y: target.y + 1, z: target.z + 0.5, range: 1, timeoutMs: 15000 },
          mcData
        );
      } catch {
        /* move didn't land — try the burrow from wherever we are */
      }
    } else {
      const dirs = [[18, 0], [-18, 0], [0, 18], [0, -18]];
      const [rx, rz] = pickDryDir(bot, dirs);
      try {
        await executeAction(
          bot,
          { type: "goto", x: p.x + rx + 0.5, y: p.y, z: p.z + rz + 0.5, range: 3, timeoutMs: 12000 },
          mcData
        );
      } catch {
        /* move didn't land — try the burrow from wherever we are */
      }
    }
    return burrowForNight(bot, mcData, log, force, _depth + 1);
  };
  const solid = bot.inventory
    .items()
    .find((i) => /dirt|cobblestone|stone|netherrack|sand|gravel|planks|_log|blackstone/.test(i.name));
  const danger = (b) => !b || /air|lava|water|magma_block|bedrock/.test(b.name);
  // diggable = terrain the bot can actually break with what it carries —
  // mineflayer's b.diggable doesn't account for harvestTools, so check by
  // name class: a small set is always hand-breakable, everything else
  // (stone/ore/bricks) needs a pickaxe in inventory
  const diggable = (b) => diggableBlock(bot, b);
  // safe() = daylight and no hostile within 16 (creepers/spiders don't burn,
  // spawn-campers outlast sunrise)
  const safe = () => {
    const t = bot.time?.timeOfDay;
    if (t != null && t >= 12541) return false;
    return !Object.values(bot.entities || {}).some((e) => {
      if (!e?.position || e === bot.entity) return false;
      const n = String(e.name || e.displayName || "").toLowerCase();
      const hostile =
        e.kind === "Hostile mobs" ||
        /zombie|skeleton|creeper|spider|enderman|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
      return hostile && e.position.distanceTo(bot.entity.position) < 16;
    });
  };
  // Standing on jungle canopy: every candidate column below is leaves —
  // drop through the foliage to the real ground first (leaves break
  // instantly even by hand)
  for (let i = 0; i < 18; i++) {
    const p = bot.entity.position.floored();
    const under = bot.blockAt(p.offset(0, -1, 0));
    if (!under || !/leaves$/.test(under.name)) break;
    const d = await executeAction(
      bot,
      { type: "dig", x: under.position.x, y: under.position.y, z: under.position.z, timeoutMs: 4000 },
      mcData
    );
    if (!d.ok) break;
    await sleep(120);
  }
  // Try up to 9 candidate spots for a dig-down column: here, then east, west,
  // south, north at 3 and 6 blocks — the ground must be solid to -6.
  let entry = bot.entity.position.floored();
  let spot = null;
  for (const [mx, mz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [6, 0], [-6, 0], [0, 6], [0, -6]]) {
    const p = bot.entity.position.floored();
    const under = bot.blockAt(p.offset(0, -1, 0));
    if (danger(under)) {
      if (mx || mz) {
        try {
          await executeAction(
            bot,
            { type: "goto", x: p.x + mx + 0.5, y: p.y, z: p.z + mz + 0.5, range: 0.6, timeoutMs: 5000 },
            mcData
          );
        } catch {
          /* can't move — next candidate */
        }
      }
      continue;
    }
    // whole column down to -6 must be solid AND diggable — an open cell
    // means a cave (mobs), an undiggable cell means we can't get in.
    // Logs/stems/leaves are a tree trunk or canopy, not ground — digging
    // them drops the bot inside a giant trunk it can't time out of
    let solidCol = true;
    for (let dy = -1; dy >= -6; dy--) {
      const b = bot.blockAt(p.offset(0, dy, 0));
      if (!diggable(b) || /_log$|_stem$|leaves$/.test(b?.name || "")) {
        solidCol = false;
        break;
      }
    }
    if (solidCol) {
      spot = bot.entity.position.floored();
      break;
    }
    if (mx || mz) {
      try {
        await executeAction(
          bot,
          { type: "goto", x: p.x + mx + 0.5, y: p.y, z: p.z + mz + 0.5, range: 0.6, timeoutMs: 5000 },
          mcData
        );
      } catch {
        /* next candidate */
      }
    }
  }
  let dug = 0;
  let needsShaft = true;
  if (!spot && solid) {
    // no diggable column — we're deep in a tunnel or on undiggable floor.
    // The tunnel wall itself is the burrow: carve a sideways pocket at
    // ground level (all diggable stone) instead of digging a shaft first
    spot = bot.entity.position.floored();
    needsShaft = false;
    log?.("[burrow] no safe column — carving into tunnel wall");
  }
  if (!spot) {
    // last resort: pillar up where we stand — mobs can't climb 6+ blocks
    // (skeletons can still shoot; still better than standing on the ground)
    log?.("[burrow] no safe column — pillaring up");
    let raised = 0;
    for (let i = 0; i < 7 && solid; i++) {
      const ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
      if (!ref || ref.name === "air") break;
      try {
        await pt(bot.equip(solid, "hand"), 8000, "equip");
        bot.setControlState("jump", true);
        await pt(bot.placeBlock(ref, new Vec3(0, 1, 0)), 8000, "placeBlock");
        bot.setControlState("jump", false);
        raised += 1;
      } catch {
        bot.setControlState("jump", false);
        break;
      }
      await sleep(250);
    }
    if (raised >= 4) {
      const t0 = Date.now();
      while (!safe() && Date.now() - t0 < 480000) await sleep(4000);
      // dig back down through our own pillar
      for (let i = 0; i < raised + 2; i++) {
        const b = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        if (!b || b.name === "air" || /bedrock|lava|water/.test(b.name)) break;
        try {
          await executeAction(
            bot,
            { type: "dig", x: b.position.x, y: b.position.y, z: b.position.z, timeoutMs: 10000 },
            mcData
          );
        } catch {
          break;
        }
        await sleep(200);
      }
      log?.("[burrow] dawn — down from pillar");
      return true;
    }
    log?.("[burrow] pillar failed — staying up");
    return retryElsewhere("pillar failed");
  }
  entry = spot;
  if (needsShaft) for (let i = 0; i < 3; i++) {
    const feet = bot.entity.position.floored();
    const under = bot.blockAt(feet.offset(0, -1, 0));
    const below = bot.blockAt(feet.offset(0, -2, 0));
    if (danger(under) || !diggable(under)) break;
    // don't break a cave ceiling — landing cell must be solid ground
    if (!below || /air|lava|water|magma_block|bedrock/.test(below.name)) {
      log?.(`[burrow] cave below at dy=-2 — stopping on ceiling`);
      break;
    }
    const d = await executeAction(
      bot,
      { type: "dig", x: under.position.x, y: under.position.y, z: under.position.z, timeoutMs: 10000 },
      mcData
    );
    if (!d.ok) {
      log?.(`[burrow] dig fail: ${d.message}`);
      break;
    }
    dug += 1;
  }
  if (needsShaft && dug < 2) {
    log?.(`[burrow] only dug ${dug}`);
    return retryElsewhere(`only dug ${dug}`);
  }
  // seal the shelter: carve a 2-deep pocket sideways and wall its doorway
  // shut — works even when the shaft's top cell has no solid walls (cliff
  // lips). Returns sealed cells for the exit dig.
  const feet = bot.entity.position.floored();
  let sealedCells = null;
  if (solid && (dug >= 3 || !needsShaft)) {
    // pocket depth: a mob pressed against the single doorway wall reaches
    // ~3m — a 2-deep pocket leaves the bot in melee range. 4-deep puts it
    // out of reach; shallower pockets are carved only as a fallback
    for (const [px, pz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let carvedDepth = 0;
      for (const depth of [4, 3, 2]) {
        const cells = [];
        for (let i = 1; i <= depth; i += 1) {
          cells.push(bot.blockAt(feet.offset(px * i, 0, pz * i)));
          cells.push(bot.blockAt(feet.offset(px * i, 1, pz * i)));
        }
        // every pocket cell must be a diggable solid — an air cell means a
        // cave pocket, and a cave means mobs
        if (cells.some((c) => !diggable(c))) continue;
        const doorwayFloor = bot.blockAt(feet.offset(px, -1, pz));
        const farFloor = bot.blockAt(feet.offset(px * depth, -1, pz * depth));
        if (!doorwayFloor || doorwayFloor.name === "air") continue;
        if (!farFloor || /air|lava|water|bedrock|magma_block/.test(farFloor.name)) continue;
        let carved = true;
        for (const c of cells) {
        const d = await executeAction(
          bot,
          { type: "dig", x: c.position.x, y: c.position.y, z: c.position.z, timeoutMs: 10000 },
          mcData
        );
          if (!d.ok) {
            carved = false;
            break;
          }
        }
        if (!carved) continue;
        carvedDepth = depth;
        break;
      }
      if (!carvedDepth) continue;
      const step = await executeAction(
        bot,
        {
          type: "goto",
          x: feet.x + px * carvedDepth + 0.5,
          y: feet.y,
          z: feet.z + pz * carvedDepth + 0.5,
          range: 0.5,
          timeoutMs: 6000,
        },
        mcData
      );
      if (!step.ok) continue;
      // wall the doorway: feet cell via floor ref, head cell via the new block
      const p1 = await executeAction(
        bot,
        { type: "place", item: solid.name, x: feet.x + px, y: feet.y, z: feet.z + pz, face: "top", timeoutMs: 8000 },
        mcData
      );
      if (!p1.ok) continue;
      const p2 = await executeAction(
        bot,
        { type: "place", item: solid.name, x: feet.x + px, y: feet.y + 1, z: feet.z + pz, face: "top", timeoutMs: 8000 },
        mcData
      );
      if (!p2.ok) continue;
      sealedCells = [
        { x: feet.x + px, y: feet.y, z: feet.z + pz },
        { x: feet.x + px, y: feet.y + 1, z: feet.z + pz },
      ];
      log?.(`[burrow] sealed pocket ${px},${pz} depth=${carvedDepth}`);
      break;
    }
    if (!sealedCells) {
      log?.("[burrow] no seal");
      return retryElsewhere("no seal");
    }
  }
  const t0 = Date.now();
  while (!safe() && Date.now() - t0 < 570000) {
    await sleep(4000);
    // a camper at the open shaft mouth is in melee reach of the bottom —
    // swing at it every loop instead of turtling forever. Bare fists lose
    // trades to zombies, so only fight back with a real weapon
    const camper = findHostile(bot, 5);
    const armed = bot.inventory.items().some((i) => /sword|_axe/.test(i.name));
    if (camper && armed) {
      try {
        await pt(bot.attack(camper), 6000, "attack");
      } catch {
        /* out of reach — keep waiting */
      }
    }
  }
  // dig out the sealed doorway, step back into the open shaft, then pillar
  // up the shaft to the surface (can't pillar inside the pocket — ceiling)
  if (sealedCells?.length) {
    for (const c of sealedCells) {
      try {
        await executeAction(
          bot,
          { type: "dig", x: c.x, y: c.y, z: c.z, timeoutMs: 10000 },
          mcData
        );
      } catch {
        /* seal gone — climb anyway */
      }
    }
    try {
      await executeAction(
        bot,
        { type: "goto", x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5, range: 0.5, timeoutMs: 8000 },
        mcData
      );
    } catch {
      /* pillar wherever we are */
    }
  }
  if (solid) {
    for (let i = 0; i < dug + 3 && bot.entity.position.floored().y < entry.y; i++) {
      const ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
      if (!ref || ref.name === "air") break;
      try {
        await pt(bot.equip(solid, "hand"), 8000, "equip");
        bot.setControlState("jump", true);
        await pt(bot.placeBlock(ref, new Vec3(0, 1, 0)), 8000, "placeBlock");
        bot.setControlState("jump", false);
        await sleep(250);
      } catch {
        bot.setControlState("jump", false);
        break;
      }
    }
  }
  log?.("[burrow] dawn — back out");
  return true;
}

export async function punchNearbyLogs(bot, mcData, need = 6, state = null) {
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
  // Fallback: dig one log block by coords — skip targets this spot already
  // failed to path to and anything far below (cave-visible trunks the
  // pathfinder can never reach from the surface)
  const feet = bot.entity.position.floored();
  const block = bot.findBlock({
    matching: (b) => {
      const blk = b && b.position ? b : b && bot.blockAt(b);
      if (!blk || !(blk.name.endsWith("_log") || blk.name.endsWith("_stem"))) return false;
      if (blk.position.y <= feet.y - 12) return false;
      return (state?.badDig?.get?.(`${blk.position.x},${blk.position.y},${blk.position.z}`) || 0) < 3;
    },
    maxDistance: 32,
  });
  if (!block) {
    // nothing in scan range — wander toward new ground instead of stalling
    if (state) {
      state.noLogStreak = (state.noLogStreak || 0) + 1;
      if (state.noLogStreak >= 3) {
        const p = bot.entity.position.floored();
        const dirs = [[40, 0], [-40, 0], [0, 40], [0, -40]];
        const [wx, wz] = pickDryDir(bot, dirs);
        try {
          await executeAction(
            bot,
            { type: "goto", x: p.x + wx, y: p.y, z: p.z + wz, range: 5, timeoutMs: 20000 },
            mcData
          );
        } catch {
          /* wander blocked — retry from here */
        }
        state.noLogStreak = 0;
        return { ok: true, message: "exploring for trees" };
      }
    }
    return { ok: false, message: "no log block nearby" };
  }
  if (state) state.noLogStreak = 0;
  const dig = await executeAction(
    bot,
    { type: "dig", x: block.position.x, y: block.position.y, z: block.position.z },
    mcData
  );
  if (!dig.ok && /no path|timeout/i.test(String(dig.message || "")) && state) {
    state.badDig = state.badDig || new Map();
    const k = `${block.position.x},${block.position.y},${block.position.z}`;
    state.badDig.set(k, (state.badDig.get(k) || 0) + 1);
  }
  return dig;
}

async function phaseWood(bot, mcData, state, log) {
  const logs = countItem(bot, (i) => i.name.includes("log") || i.name.endsWith("_stem"));
  const planks = countItem(bot, (i) => i.name.includes("planks"));
  const sticks = countItem(bot, "stick");
  const woodMat = logs * 4 + planks; // rough planks-equivalent

  // Gather only if we lack materials for table+pick (table 4 + pick 3 + sticks from 2 planks ≈ 12 planks-eq)
  if (woodMat < 12 && logs < 3) {
    const rr = await punchNearbyLogs(bot, mcData, 6, state);
    if (!rr.ok && /no path/i.test(String(rr.message || ""))) {
      // every visible log is an unreachable cliff/water tree — walk to new
      // ground instead of retrying the same target forever
      state.woodNoPath = (state.woodNoPath || 0) + 1;
      if (state.woodNoPath >= 5) {
        state.woodNoPath = 0;
        await wander(bot, mcData, 56);
      }
    } else if (rr.ok) {
      state.woodNoPath = 0;
    }
    if (!rr.ok) {
      // walk toward the nearest visible log — cliff spawns leave trees
      // visible but unreachable until the approach changes the space
      const t = bot.findBlock({
        matching: (b) => b && b.name.endsWith("_log"),
        maxDistance: 48,
      });
      if (t) {
        await executeAction(
          bot,
          { type: "goto", x: t.position.x, y: t.position.y, z: t.position.z, range: 6, timeoutMs: 15000 },
          mcData
        ).catch(() => {});
      }
    }
    const now = countItem(bot, (i) => i.name.includes("log") || i.name.endsWith("_stem"));
    if (rr.ok && now <= logs) {
      // dug logs but the drops landed somewhere unreachable — walk onto the
      // nearest dropped log/plank item and let the pickup radius grab it
      const drop = Object.values(bot.entities || {}).find((e) => {
        if (!e?.position) return false;
        // a drop far below the bot (its own death pile in a cave) is not
        // retrievable by walking — chasing it traps progression underground
        if (e.position.y < bot.entity.position.y - 8) return false;
        try {
          const d = e.getDroppedItem?.();
          if (!d || !/log|planks|stick/.test(String(d.name || ""))) return false;
          return e.position.distanceTo(bot.entity.position) < 20;
        } catch {
          return false;
        }
      });
      if (drop) {
        await executeAction(
          bot,
          {
            type: "goto",
            x: drop.position.x,
            y: drop.position.y,
            z: drop.position.z,
            range: 1.2,
            timeoutMs: 12000,
          },
          mcData
        ).catch(() => {});
      }
    }
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
    const rr = await punchNearbyLogs(bot, mcData, 4, state);
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

  // a bare-handed bot loses every mob trade — a wooden sword costs 2 planks
  // + 1 stick and turns early zombie fights winnable
  if (!hasAny(bot, ["wooden_sword", "stone_sword", "iron_sword", "diamond_sword"])) {
    await ensureCraft(bot, mcData, "wooden_sword", 1);
  }

  if (!hasPickaxe(bot)) {
    return { ok: false, phase: "wood", message: "still no pickaxe after craft" };
  }

  try {
    const pick = bot.inventory.items().find((i) => i.name.includes("pickaxe"));
    if (pick) await pt(bot.equip(pick, "hand"), 8000, "equip");
  } catch {
    /* ignore */
  }

  await pullTable(bot, mcData);
  return { ok: true, phase: "wood", message: "wood tools ready", milestone: "WOOD_TOOLS" };
}

async function phaseStone(bot, mcData, state, log) {
  if (!hasPickaxe(bot)) {
    // should not be in stone phase without pick — fall back
    return { ok: false, phase: "stone", message: "stone phase without pickaxe" };
  }
  try {
    const pick = bot.inventory.items().find((i) => i.name.includes("pickaxe"));
    if (pick) await pt(bot.equip(pick, "hand"), 8000, "equip");
  } catch {
    /* ignore */
  }

  await ensureTable(bot, mcData);
  const cobble = countItem(bot, (i) => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name));
  if (cobble < 8) {
    // Only target stone with an exposed face — buried blocks can't be dug from outside
    const stonePos = bot
      .findBlocks({
        matching: (b) => b && /^(stone|cobblestone|cobbled_deepslate|deepslate|blackstone)$/.test(b.name),
        maxDistance: 20,
        count: 10,
      })
      .filter((pos) => isExposedFace(bot, pos));
    let dug = 0;
    for (const pos of stonePos) {
      const dig = await executeAction(bot, { type: "dig", x: pos.x, y: pos.y, z: pos.z, timeoutMs: 10000 }, mcData);
      if (dig.ok) dug += 1;
      if (dug >= 4) break;
    }
    if (dug === 0) {
      await stairDown(bot, mcData, 9, log);
    }
    // pick up drops
    try {
      await executeAction(bot, { type: "wait", ms: 400 }, mcData);
    } catch {
      /* ignore */
    }
    const now = countItem(bot, (i) => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name));
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
  const tbl = await ensureTable(bot, mcData);
  if (!tbl.ok) return { ok: false, phase: "stone", message: `table: ${tbl.message}` };

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
  await pullTable(bot, mcData);
  return { ok: true, phase: "stone", message: "stone tools", milestone: "STONE_TOOLS" };
}

async function phaseIron(bot, mcData, state, log) {
  // Equip best pick always
  try {
    const pick =
      bot.inventory.items().find((i) => i.name === "iron_pickaxe") ||
      bot.inventory.items().find((i) => i.name === "stone_pickaxe") ||
      bot.inventory.items().find((i) => i.name.includes("pickaxe"));
    if (pick) await pt(bot.equip(pick, "hand"), 8000, "equip");
  } catch {
    /* ignore */
  }

  // iron ore needs stone+ — a broken pick underground means rebuild one
  // right here instead of strip-mining with a wooden pick forever
  if (!hasAny(bot, ["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"])) {
    const st = await ensureSticks(bot, mcData, 2);
    if (!st.ok) return { ok: false, phase: "iron", message: `pick remake sticks: ${st.message}` };
    const t = await ensureTable(bot, mcData);
    if (!t.ok) return { ok: false, phase: "iron", message: `pick remake table: ${t.message}` };
    const cr = await ensureCraft(bot, mcData, "stone_pickaxe", 1);
    if (!cr.ok) return { ok: false, phase: "iron", message: `pick remake: ${cr.message}` };
    await pullTable(bot, mcData);
  }

  const ingots = countItem(bot, "iron_ingot");
  const raw = countItem(bot, "raw_iron") + countItem(bot, "iron_ore") + countItem(bot, "deepslate_iron_ore");

  // Need enough iron material for pick (3) + sword (2) + shield (1) ≈ 6; aim 8
  if (ingots < 8 && raw < 8) {
    // get to iron depth first — surface collect wanders into open caves and
    // that's been the death loop all night
    const y = Math.floor(bot.entity.position.y);
    if (y > 16) {
      // never descend wood-poor: at y≤16 there are no trees — sticks for iron
      // tools and table/table-fuel must come down with us
      const woodStock =
        countItem(bot, (i) => i.name.includes("log")) + countItem(bot, (i) => i.name.endsWith("_planks"));
      if (woodStock < 8) {
        const w = await punchNearbyLogs(bot, mcData, 10, state);
        if (!w.ok) {
          const t = bot.findBlock({ matching: (b) => b && b.name.endsWith("_log"), maxDistance: 48 });
          if (t) {
            await executeAction(
              bot,
              { type: "goto", x: t.position.x, y: t.position.y, z: t.position.z, range: 6, timeoutMs: 15000 },
              mcData
            ).catch(() => {});
          }
        }
        return { ok: true, phase: "iron", message: `pre-descend wood (${woodStock})` };
      }
      // mountains are iron-rich ABOVE ground in 1.18+: exposed ore on cliff
      // faces beats a staircase through a mob cave — grab any visible iron
      // ore first (exposed check = has an air-adjacent face, i.e. cliff wall)
      const surfaceOre = bot.findBlock({
        matching: (b) => {
          if (!b) return false;
          const blk = b.position ? b : bot.blockAt(b);
          return blk && /iron_ore/.test(blk.name) && isExposedFace(bot, blk.position);
        },
        maxDistance: 24,
      });
      if (surfaceOre) {
        const got = await executeAction(
          bot,
          { type: "collect", block: "iron_ore", count: 6, maxDistance: 24, timeoutMs: 25000 },
          mcData
        );
        if (got.ok) return { ok: true, phase: "iron", message: `surface iron @y=${y}` };
      }
      const d = await stairDown(bot, mcData, 8, log);
      if (d === 0) {
        // every direction may be mob-blocked — end the step so the combat
        // reflex clears the doorway before we try to dig through again
        const doorBlock = findHostile(bot, 10);
        if (doorBlock) {
          state.mobDoorBlocks = (state.mobDoorBlocks || 0) + 1;
          if (state.mobDoorBlocks < 4) {
            return { ok: true, phase: "iron", message: `descend door-blocked y=${y}` };
          }
          state.mobDoorBlocks = 0;
        }
        // cave floor — nothing to staircase into; drop straight down instead
        const s = await digStaircaseDown(bot, mcData, 14, 8);
        if (s.digs === 0) {
          // lava/water blocking every direction — walk somewhere else and retry
          const p = bot.entity.position.floored();
          const dirs = [[14, 0], [-14, 0], [0, 14], [0, -14]];
          const [wx, wz] = dirs[Math.floor(Math.random() * dirs.length)];
          await executeAction(
            bot,
            { type: "goto", x: p.x + wx, y: p.y, z: p.z + wz, range: 3, timeoutMs: 12000 },
            mcData
          ).catch(() => {});
          return { ok: true, phase: "iron", message: `descend stuck y=${y} ${s.message || ""} — relocating` };
        }
        return { ok: true, phase: "iron", message: `descend y=${y}→${s.y}` };
      }
      // landings can drop into open caves full of mobs — end the step so the
      // combat reflex gets a clean turn before we dig deeper
      const danger = findHostile(bot, 8);
      if (danger) return { ok: true, phase: "iron", message: `descend pause (mob @${y})` };
      return { ok: true, phase: "iron", message: `descend y=${y}` };
    }
    // wood-starved underground: sticks/table-fuel need planks — climb back up
    // the staircase we dug (pathfinder walks it like a corridor) to re-gear
    const woodStock =
      countItem(bot, (i) => i.name.includes("log")) + countItem(bot, (i) => i.name.endsWith("_planks"));
    if (woodStock < 4) {
      const p0 = bot.entity.position.floored();
      const up = await executeAction(
        bot,
        { type: "goto", x: p0.x, y: p0.y + 24, z: p0.z, range: 4, timeoutMs: 25000 },
        mcData
      ).catch((e) => ({ ok: false, message: e?.message || String(e) }));
      if (Math.floor(bot.entity.position.y) > 16) {
        return { ok: true, phase: "iron", message: "ascend for wood" };
      }
      // stair unreachable (sealed/mobbed) — keep strip-mining: coal still
      // works as furnace fuel, it just can't make sticks
    }
    // quick surface-adjacent grab: tight collect only if ore is right there
    const before = raw;
    const close = await executeAction(
      bot,
      { type: "collect", block: "iron_ore", count: 6, maxDistance: 10, timeoutMs: 20000 },
      mcData
    );
    let gained = countItem(bot, "raw_iron") + countItem(bot, "iron_ore") + countItem(bot, "deepslate_iron_ore") - before;
    if (!close.ok || gained <= 0) {
      // strip-mine: tunnel through stone at depth, ore shows in the walls —
      // no open-cave exposure
      const { mined, oreHits } = await stripMine(bot, mcData, 22, log);
      gained = countItem(bot, "raw_iron") + countItem(bot, "iron_ore") + countItem(bot, "deepslate_iron_ore") - before;
      return {
        ok: gained > 0 || mined > 4,
        phase: "iron",
        message: `strip y=${Math.floor(bot.entity.position.y)} mined=${mined} iron+${gained}`,
        milestone: gained > 0 ? "IRON_ORE" : undefined,
      };
    }
    return { ok: gained > 0 || close.ok, phase: "iron", message: `mine iron (+${gained})`, milestone: gained > 0 ? "IRON_ORE" : undefined };
  }

  // Craft/place furnace before smelt
  if (ingots < 8 && raw > 0) {
    await ensureTable(bot, mcData);
    if (countItem(bot, "furnace") < 1 && !bot.findBlock({ matching: (b) => b?.name === "furnace", maxDistance: 12 })) {
      if (countItem(bot, (i) => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name)) >= 8) {
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
    const sm = await executeAction(
      bot,
      { type: "smelt", input: "raw_iron", output: "iron_ingot", fuel, count: need },
      mcData
    );
    if (!sm.ok) return { ok: false, phase: "iron", message: `smelt: ${sm.message}` };
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

  if (ingots < 3) {
    // smelt gate above should have caught this — surface it instead of
    // spinning on an uncraftable pick every step
    return { ok: false, phase: "iron", message: `need ingots for tools (${ingots}/3)` };
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
    if (pick) await pt(bot.equip(pick, "hand"), 8000, "equip");
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
    // dig ONLY the floor cell directly under us: a gap of air between feet
    // and the next solid is a cave — digging into it drops us onto a mob
    // ledge (the y=59→58 death loop). Stop above caves and let the caller
    // relocate instead of falling in.
    let blk = null;
    const gap = bot.blockAt(feet.offset(0, -1, 0));
    const under = bot.blockAt(feet.offset(0, -2, 0));
    if (gap && (gap.name === "air" || gap.name === "cave_air" || gap.name === "void_air") && !under) {
      return { ok: true, message: "cave below — stopping", digs, y: feet.y };
    }
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
      await pt(bot.equip(pick, "hand"), 8000, "equip");
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
    if (pick) await pt(bot.equip(pick, "hand"), 8000, "equip");
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
        await pt(bot.equip(eye, "hand"), 8000, "equip");
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

/**
 * Post-dragon: the run is only complete once the bot has gone through the
 * exit portal (credits roll) and respawned in the overworld. Walks to the
 * end fountain's `end_portal` blocks and drops in; the runner watches the
 * dimension flip for the CREDITS milestone.
 */
async function phaseExitPortal(bot, mcData, state, log) {
  const dim = String(bot.game?.dimension || "");
  if (!/end/i.test(dim)) {
    return { ok: true, phase: "credits", message: "respawned overworld — credits done", milestone: "CREDITS" };
  }
  state.exit = state.exit || {};
  const portal = bot.findBlock({ matching: (b) => b && b.name === "end_portal", maxDistance: 96 });
  if (!portal) {
    // The exit fountain sits at the island center — get it in render range.
    const p = bot.entity.position;
    if (Math.hypot(p.x, p.z) > 14) {
      await executeAction(bot, { type: "goto", x: 0, y: p.y, z: 0, range: 10, timeoutMs: 90000 }, mcData);
    }
    return { ok: true, phase: "exit_portal", message: "seeking exit portal" };
  }
  const pp = portal.position;
  state.exit.portalPos = { x: pp.x, y: pp.y, z: pp.z };
  const center = new Vec3(pp.x + 0.5, pp.y + 0.5, pp.z + 0.5);
  const d = bot.entity.position.distanceTo(center);
  if (d < 2.2) {
    // Pathfinder refuses standing inside a portal cell — hop into the mouth.
    state.exitTouched = Date.now();
    await bot.lookAt(center.offset(0, -0.4, 0), true);
    bot.setControlState("jump", true);
    bot.setControlState("forward", true);
    await new Promise((r) => setTimeout(r, 1100));
    bot.setControlState("jump", false);
    bot.setControlState("forward", false);
    return { ok: true, phase: "exit_portal", message: "entering exit portal" };
  }
  const r = await executeAction(
    bot,
    { type: "goto", x: pp.x, y: pp.y, z: pp.z, range: 1.5, timeoutMs: 90000 },
    mcData
  );
  return { ok: r.ok, phase: "exit_portal", message: r.ok ? "at exit portal rim" : `goto portal: ${r.message || "?"}` };
}

/* ---------------------------------------------------------------------------
 * Post-dragon epilogue: optional boss objectives (wither, warden).
 * Each is a small state machine driven one step per call. The actual fight
 * reuses bossCombatTick — same machinery as the dragon phase.
 * ------------------------------------------------------------------------ */

export const BOSS_OBJECTIVES = new Set(["dragon", "wither", "warden"]);

function bossEntity(bot, name) {
  return Object.values(bot.entities).find((e) => e && e !== bot.entity && mobName(e) === name);
}

/** Dropped-item entity by item name — proof-of-kill for boss drops. */
function droppedItemEntity(bot, mcData, names) {
  const set = new Set(names);
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || e.name !== "item") continue;
    const metas = Array.isArray(e.metadata) ? e.metadata : Object.values(e.metadata || {});
    for (const m of metas) {
      const id = m?.itemId ?? m?.item_id;
      if (id == null) continue;
      const n = mcData.itemsById?.[id]?.name || mcData.items?.[id]?.name || "";
      if (set.has(n)) return e;
    }
  }
  return null;
}

async function enterPortal(bot, mcData) {
  const portal = bot.findBlock({ matching: (b) => b?.name === "nether_portal", maxDistance: 96 });
  if (!portal) return { ok: false, message: "no portal" };
  await executeAction(
    bot,
    { type: "goto", x: portal.position.x, y: portal.position.y, z: portal.position.z, range: 1, timeoutMs: 60000 },
    mcData
  );
  await sleep(5000); // dimension transfer
  return { ok: true, message: "portal crossed" };
}

async function wander(bot, mcData, radius = 48, dy = 0) {
  const p = bot.entity.position;
  const ang = Math.random() * Math.PI * 2;
  return executeAction(
    bot,
    {
      type: "goto",
      x: p.x + Math.cos(ang) * radius,
      y: p.y + dy,
      z: p.z + Math.sin(ang) * radius,
      range: 3,
      timeoutMs: 60000,
    },
    mcData
  );
}

/* --- Wither: 3 skulls + 4 soul sand → T-shape summon → fight ----------- */

async function witherPrepStep(bot, mcData, state, prep, log) {
  const skulls = countItem(bot, "wither_skeleton_skull");
  const souls = countItem(bot, "soul_sand") + countItem(bot, "soul_soil");
  const dim = String(bot.game?.dimension || "");
  const inNether = /nether/i.test(dim);

  // Proof of kill: the nether star must exist — a wither drifting out of
  // entity range is NOT a win.
  const star = droppedItemEntity(bot, mcData, ["nether_star"]) || countItem(bot, "nether_star") > 0;
  if (star) return { ok: true, done: true, message: "wither down", milestone: "WITHER_DOWN" };

  const wither = bossEntity(bot, "wither");
  if (wither) {
    prep.spawned = true;
    prep.lastPos = wither.position.clone();
    state.boss = state.boss || { allowStickTp: false };
    await bossCombatTick(bot, wither, state.boss, log);
    return { ok: true, message: "wither fight", milestone: "WITHER_FIGHT" };
  }
  if (prep.spawned && prep.lastPos) {
    // Out of tracking range, no star: it escaped — go back and re-engage
    const lp = prep.lastPos;
    const d = Math.hypot(lp.x - bot.entity.position.x, lp.z - bot.entity.position.z);
    if (d > 10) {
      await executeAction(
        bot,
        { type: "goto", x: lp.x, y: lp.y, z: lp.z, range: 6, timeoutMs: 60000 },
        mcData
      );
      return { ok: true, message: "return to wither" };
    }
    await wander(bot, mcData, 32);
    return { ok: true, message: "search escaped wither" };
  }

  if (skulls < 3) {
    if (!inNether) {
      const r = await enterPortal(bot, mcData);
      return { ok: r.ok, message: `skulls ${skulls}/3 — to nether (${r.message})` };
    }
    const skel = bossEntity(bot, "wither_skeleton") || Object.values(bot.entities).find((e) => mobName(e) === "wither_skeleton");
    if (skel) {
      await executeAction(bot, { type: "attack", name: "wither_skeleton", maxDurationMs: 25000, maxDistance: 24 }, mcData);
      return { ok: true, message: `hunt wither_skeleton (skulls ${skulls}/3)`, milestone: "WITHER_SKELETON" };
    }
    const brick = bot.findBlock({
      matching: (b) => b && (b.name === "nether_bricks" || b.name === "nether_brick_fence"),
      maxDistance: 64,
    });
    if (brick) {
      await executeAction(
        bot,
        { type: "goto", x: brick.position.x, y: brick.position.y, z: brick.position.z, range: 3, timeoutMs: 90000 },
        mcData
      );
      return { ok: true, message: `goto fortress (skulls ${skulls}/3)`, milestone: "FORTRESS" };
    }
    await wander(bot, mcData, 48);
    return { ok: true, message: `search fortress (skulls ${skulls}/3)` };
  }

  if (souls < 4) {
    if (!inNether) {
      const r = await enterPortal(bot, mcData);
      return { ok: r.ok, message: `soul sand ${souls}/4 — to nether (${r.message})` };
    }
    const sand = bot.findBlock({
      matching: (b) => b && (b.name === "soul_sand" || b.name === "soul_soil"),
      maxDistance: 64,
    });
    if (sand) {
      await executeAction(
        bot,
        { type: "goto", x: sand.position.x, y: sand.position.y, z: sand.position.z, range: 2, timeoutMs: 60000 },
        mcData
      );
      await executeAction(bot, { type: "dig", block: "soul_sand", maxDistance: 8 }, mcData).catch(() => {});
      return { ok: true, message: `dig soul sand ${souls}/4`, milestone: "SOUL_SAND" };
    }
    await wander(bot, mcData, 48);
    return { ok: true, message: `search soul sand ${souls}/4` };
  }

  // Summon: go to overworld open ground, then build T + skulls
  if (inNether) {
    const r = await enterPortal(bot, mcData);
    return { ok: r.ok, message: `to overworld for summon (${r.message})`, milestone: "WITHER_MATERIALS" };
  }

  if (!prep.summonPos) {
    const p = bot.entity.position.floored();
    // build at +3x from bot on ground level
    prep.summonPos = { x: p.x + 3, y: p.y, z: p.z };
    // make sure there's air above ground
    for (let dy = 0; dy <= 3; dy++) {
      const b = bot.blockAt(new Vec3(prep.summonPos.x, prep.summonPos.y + 1 + dy, prep.summonPos.z));
      if (b && !["air", "cave_air", "void_air", "grass", "short_grass", "tall_grass", "snow"].includes(b.name)) {
        prep.summonPos.x += 4;
        dy = -1;
        if (prep.summonPos.x > p.x + 20) {
          prep.summonPos.x = p.x - 3;
          prep.summonPos.z += 4;
        }
      }
    }
    prep.placed = 0;
  }

  const sp = prep.summonPos;
  // T-shape: bottom center + top row of 3, skulls on the top 3
  const layout = [
    { item: "soul_sand", x: sp.x, y: sp.y, z: sp.z },
    { item: "soul_sand", x: sp.x - 1, y: sp.y + 1, z: sp.z },
    { item: "soul_sand", x: sp.x, y: sp.y + 1, z: sp.z },
    { item: "soul_sand", x: sp.x + 1, y: sp.y + 1, z: sp.z },
    { item: "wither_skeleton_skull", x: sp.x - 1, y: sp.y + 2, z: sp.z },
    { item: "wither_skeleton_skull", x: sp.x, y: sp.y + 2, z: sp.z },
    { item: "wither_skeleton_skull", x: sp.x + 1, y: sp.y + 2, z: sp.z },
  ];
  const wantName = (l) => (l.item === "soul_sand" ? ["soul_sand", "soul_soil"] : ["wither_skeleton_skull"]);
  let missing = null;
  for (const l of layout) {
    const b = bot.blockAt(new Vec3(l.x, l.y, l.z));
    if (!b || !wantName(l).includes(b.name)) {
      missing = l;
      break;
    }
  }
  if (!missing) {
    prep.spawned = true; // last skull placed → wither spawns next tick
    return { ok: true, message: "wither summoned!", milestone: "WITHER_SUMMON" };
  }
  const cur = bot.blockAt(new Vec3(missing.x, missing.y, missing.z));
  if (cur && !["air", "cave_air", "void_air", "short_grass", "tall_grass", "snow"].includes(cur.name)) {
    await executeAction(bot, { type: "dig", x: missing.x, y: missing.y, z: missing.z }, mcData).catch(() => {});
  }
  const r = await executeAction(
    bot,
    { type: "place", item: missing.item, x: missing.x, y: missing.y, z: missing.z, face: "top" },
    mcData
  );
  return { ok: r.ok, message: `summon ${missing.item} @${missing.x},${missing.y},${missing.z}: ${r.message}` };
}

/* --- Warden: find deep dark sculk, trigger shrieker → fight ------------ */

async function wardenPrepStep(bot, mcData, state, prep, log) {
  // Proof of kill: warden always drops a sculk catalyst.
  const catalyst =
    droppedItemEntity(bot, mcData, ["sculk_catalyst"]) || countItem(bot, "sculk_catalyst") > 0;
  if (catalyst) return { ok: true, done: true, message: "warden down", milestone: "WARDEN_DOWN" };

  const warden = bossEntity(bot, "warden");
  if (warden) {
    prep.spawned = true;
    prep.lastPos = warden.position.clone();
    state.boss = state.boss || { allowStickTp: false };
    await bossCombatTick(bot, warden, state.boss, log);
    return { ok: true, message: "warden fight", milestone: "WARDEN_FIGHT" };
  }
  if (prep.spawned && prep.lastPos) {
    // Out of range without a kill drop: it burrowed away — re-approach.
    const lp = prep.lastPos;
    const d = Math.hypot(lp.x - bot.entity.position.x, lp.z - bot.entity.position.z);
    if (d > 10) {
      await executeAction(
        bot,
        { type: "goto", x: lp.x, y: lp.y, z: lp.z, range: 6, timeoutMs: 60000 },
        mcData
      );
      return { ok: true, message: "return to warden" };
    }
    await wander(bot, mcData, 32, -6);
    return { ok: true, message: "search burrowed warden" };
  }

  // Find a sculk shrieker/sensor — deep dark markers
  const shrieker = bot.findBlocks({
    matching: (b) => b && (b.name === "sculk_shrieker" || b.name === "sculk_sensor" || b.name === "sculk_catalyst"),
    maxDistance: 64,
    count: 4,
  });
  if (shrieker.length) {
    const t = shrieker[0];
    const d = t.distanceTo(bot.entity.position);
    if (d > 6) {
      await executeAction(bot, { type: "goto", x: t.x, y: t.y, z: t.z, range: 4, timeoutMs: 90000 }, mcData);
      return { ok: true, message: "approach sculk", milestone: "DEEP_DARK" };
    }
    // Agitate: stomp/jump on/near the sensor — vibrations shriek the shrieker;
    // ~4 shrieks summon the warden.
    prep.agitations = (prep.agitations || 0) + 1;
    bot.setControlState("sprint", true);
    bot.setControlState("jump", true);
    await sleep(1500);
    bot.setControlState("jump", false);
    // step back and forth over the sculk
    await executeAction(bot, { type: "goto", x: t.x, y: t.y + 1, z: t.z, range: 1, timeoutMs: 10000 }, mcData).catch(() => {});
    const p = bot.entity.position;
    await executeAction(
      bot,
      { type: "goto", x: p.x + (prep.agitations % 2 ? 3 : -3), y: p.y, z: p.z + (prep.agitations % 2 ? -3 : 3), range: 1, timeoutMs: 10000 },
      mcData
    ).catch(() => {});
    bot.setControlState("sprint", false);
    await sleep(3500);
    const w = bossEntity(bot, "warden");
    if (w) {
      prep.spawned = true;
      return { ok: true, message: "warden summoned!", milestone: "WARDEN_SUMMON" };
    }
    return { ok: true, message: `agitate sculk (x${prep.agitations})` };
  }

  // Descend + wander: deep dark lives under mountains below y≈0
  prep.searchSteps = (prep.searchSteps || 0) + 1;
  const y = bot.entity.position.y;
  const dy = y > -8 && prep.searchSteps % 3 === 1 ? -16 : 0;
  await wander(bot, mcData, 56, dy);
  return { ok: true, message: `search deep dark (y=${Math.floor(y)}, try ${prep.searchSteps})`, milestone: prep.searchSteps === 1 ? "DEEP_DARK_SEARCH" : null };
}

/**
 * One step toward an epilogue boss objective ("wither" | "warden").
 * Returns { ok, done?, message, milestone? }. Call once per loop AFTER the
 * dragon is down; the function also drives the boss fight itself.
 */
export async function bossObjectiveStep(bot, mcData, state, objective, log = () => {}) {
  if (!bot?.entity) return { ok: false, message: "no entity" };
  state.bossPrep = state.bossPrep || {};
  const prep = state.bossPrep[objective] || (state.bossPrep[objective] = {});
  try {
    if (objective === "wither") return await witherPrepStep(bot, mcData, state, prep, log);
    if (objective === "warden") return await wardenPrepStep(bot, mcData, state, prep, log);
    return { ok: false, message: `unknown boss objective ${objective}` };
  } catch (err) {
    return { ok: false, message: `${objective} crash: ${err?.message || err}` };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
