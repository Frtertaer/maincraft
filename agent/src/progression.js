/**
 * Deterministic survival progression toward "beat Minecraft".
 * No /give gear. Uses Mineflayer skills; Opus can advise but skills drive the path.
 */
import pkgPathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { executeAction, equipBestWeapon } from "./actions.js";
import { bossCombatTick, isBossMobName, mobName } from "./boss-combat.js";

const { goals } = pkgPathfinder;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// While a container window is open the server sends slot updates to that
// window — bot.inventory (window 0) silently drifts (crafts look like they
// produce nothing, items appear missing). The open window's inventory
// range is the fresh view; prefer it for counting.
export function inventoryItems(bot) {
  const win = bot.currentWindow;
  if (
    win &&
    win !== bot.inventory &&
    typeof win.inventoryStart === "number" &&
    win.inventoryStart < (win.slots?.length || 0)
  ) {
    return win.slots.slice(win.inventoryStart).filter(Boolean);
  }
  return bot.inventory.items();
}

export function countItem(bot, pred) {
  let n = 0;
  for (const it of inventoryItems(bot)) {
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
    // drowning first — nothing else matters while the air bar empties:
    // progression steps keep running (strip spins, flee paths) as the bot
    // stands underwater. Swim for air before any phase logic. Head-cell
    // only: feet-deep wading is normal travel, not drowning.
    {
      const headW = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0));
      if (/water|bubble_column|kelp|seagrass/.test(String(headW?.name || ""))) {
        const wasDeep = bot.entity.position.y < 48;
        const sw = await surfaceForAir(bot, mcData, log);
        if (sw.ok && wasDeep) {
          // a flooded aquifer just refills the same column — hop laterally so
          // the next descend digs dry ground
          const p = bot.entity.position.floored();
          const dirs = [
            [24, 0],
            [-24, 0],
            [0, 24],
            [0, -24],
          ];
          const [wx, wz] = dirs[Math.floor(Math.random() * dirs.length)];
          await executeAction(
            bot,
            { type: "goto", x: p.x + wx, y: p.y, z: p.z + wz, range: 3, timeoutMs: 12000 },
            mcData
          ).catch(() => {});
        }
        return { ok: true, phase, message: sw.ok ? "surfaced for air" : "still submerged" };
      }
    }
    // Wood is the universal prerequisite for the surface toolchain — a
    // leftover pick can push detectPhase past wood with zero logs in
    // inventory, and then nothing craftable is ever reachable.
    if (["stone", "iron", "diamond", "food_armor"].includes(phase)) {
      const logs = countItem(bot, CRAFTABLE_LOG);
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
          } else {
            // nothing visible either — walk to a remembered productive log
            // site (dead cells/camp zones skipped). Underground the path
            // never reaches a surface site, so ascend to daylight first.
            const p0 = bot.entity.position.floored();
            const underground = (() => {
              try {
                return (bot.blockAt(p0)?.skyLight ?? 15) < 4;
              } catch {
                return false;
              }
            })();
            if (underground) {
              // the pathfinder can't leave a sealed cave — staircase up
              // through rock until sky, then walk the log sites
              await stairwayUp(bot, mcData, 14, log);
            }
            await gotoLogSite(bot, mcData, state, bot.entity.position.floored());
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

// stripped logs can't be crafted into planks in vanilla — they must not
// count as craft material (they still count as solid blocks for pillaring)
const CRAFTABLE_LOG = (i) =>
  (i.name.endsWith("_log") || i.name.endsWith("_stem") || i.name.endsWith("_wood")) &&
  !i.name.startsWith("stripped_");

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

// best pickaxe the inventory supports: stone when the cobble-family is
// around, wooden otherwise. Without one every stone column reads undiggable
// and the whole burrow/descend machinery stalls — recraft on the spot.
async function ensurePickaxe(bot, mcData) {
  if (hasPickaxe(bot)) return { ok: true, message: "pickaxe held" };
  const hasStone = bot.inventory.items().some((i) => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name) && i.count >= 3);
  await ensurePlanks(bot, mcData, 3);
  if (countItem(bot, "stick") < 2) await ensureCraft(bot, mcData, "stick", 4).catch(() => null);
  if (hasStone) {
    const r = await ensureCraft(bot, mcData, "stone_pickaxe", 1).catch((e) => ({ ok: false, message: String(e?.message || e) }));
    if (r.ok) return r;
  }
  return ensureCraft(bot, mcData, "wooden_pickaxe", 1);
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
      e.kind === "Hostile mobs" && e.name !== "enderman" ||
      /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
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
  const logItem = bot.inventory.items().find((i) => CRAFTABLE_LOG(i));
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
    // dig leaves the table as a drop — walk onto the cell to vacuum it, or it
    // despawns and the next stop re-crafts a new table (the litter the
    // stream showed: dig without collect is exactly how tables multiply)
    await executeAction(
      bot,
      { type: "goto", x: t.position.x, y: t.position.y, z: t.position.z, range: 1.5, timeoutMs: 5000 },
      mcData
    ).catch(() => {});
  } catch {
    /* keep it for the next craft */
  }
}

// ── stash: a chest with spare progression gear ────────────────────────────
// Deaths wipe inventory but not the world — surplus beyond a survival keep-
// set goes into a chest; after a death the bot walks back and withdraws it.
const STASH_KEEP_COUNT = [
  [/_pickaxe$/, 1],
  [/_sword$/, 1],
  [/_axe$/, 1],
  [/_shovel$/, 1],
  [/^(crafting_table|furnace|chest|shield|torch|bucket|water_bucket|compass)$/, 1],
  [/^(stick|bone|arrow|string|feather|flint)$/, 4],
  [/_log$|_stem$/, 8],
  [/_planks$/, 8],
  [/^(cobblestone|cobbled_deepslate|dirt|sand|gravel|netherrack|blackstone)$/, 24],
  [/^(raw_iron|iron_ingot|raw_gold|gold_ingot|coal|charcoal|raw_copper|copper_ingot)$/, 4],
  [/^(diamond|emerald|lapis_lazuli|redstone|quartz|obsidian|ender_pearl|blaze_rod|blaze_powder)$/, 1],
  [/^(bread|cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|cooked_cod|cooked_salmon|baked_potato|golden_carrot)$/, 6],
];

function stashKeepCount(name) {
  for (const [re, n] of STASH_KEEP_COUNT) if (re.test(name)) return n;
  return 0; // unlisted junk → fully storable
}

// stash chests outlive the process (the world persists) — keep their
// positions on disk so a restart/respawn can still find them
const STASH_FILE = path.resolve(__dirname, "../../logs/stash.json");

export function stashLoadFile(bot) {
  try {
    const a = JSON.parse(fs.readFileSync(STASH_FILE, "utf8"));
    const all = Array.isArray(a) ? a.filter((p) => p && Number.isFinite(p.x)) : [];
    // entries are tagged with the world-spawn they were recorded under —
    // a world swap keeps the file but moves every coordinate meaning, so
    // foreign-spawn entries get dropped instead of walked-to-nowhere
    const sp = bot?.spawnPoint;
    if (!sp || !all.some((p) => p.sx != null)) return all;
    return all.filter((p) => p.sx == null || Math.hypot(p.sx - sp.x, p.sz - sp.z) < 32);
  } catch {
    return [];
  }
}

// remembered productive log grounds — persisted like stash sites so a
// process restart keeps the compass instead of re-blind-wandering
const LOG_SITE_FILE = path.resolve(__dirname, "../../logs/log-sites.json");

export function logSitesLoadFile(bot) {
  try {
    const a = JSON.parse(fs.readFileSync(LOG_SITE_FILE, "utf8"));
    const all = Array.isArray(a) ? a.filter((p) => p && Number.isFinite(p.x)) : [];
    const sp = bot?.spawnPoint;
    if (!sp || !all.some((p) => p.sx != null)) return all;
    return all.filter((p) => p.sx == null || Math.hypot(p.sx - sp.x, p.sz - sp.z) < 32);
  } catch {
    return [];
  }
}

function logSiteRecord(pos, bot, state) {
  try {
    state.logSites = state.logSites || [];
    if (state.logSites.some((s) => Math.hypot(s.x - pos.x, s.z - pos.z) < 24)) return;
    state.logSites.push({ x: pos.x, y: pos.y, z: pos.z });
    if (state.logSites.length > 8) state.logSites.shift();
    const list = logSitesLoadFile(bot);
    if (!list.some((p) => Math.hypot(p.x - pos.x, p.z - pos.z) < 24)) {
      const sp = bot?.spawnPoint;
      list.push({ x: pos.x, y: pos.y, z: pos.z, ...(sp ? { sx: Math.round(sp.x), sz: Math.round(sp.z) } : {}) });
      fs.mkdirSync(path.dirname(LOG_SITE_FILE), { recursive: true });
      fs.writeFileSync(LOG_SITE_FILE, JSON.stringify(list.slice(-16)));
    }
  } catch {
    /* non-fatal */
  }
}

// remembered death spots + the mob camp they cluster around — persisted
// like log sites so a process restart keeps steering clear of the kill
// ring instead of wandering back into it
const DEATH_ZONE_FILE = path.resolve(__dirname, "../../logs/death-zones.json");
const DEATH_ZONE_FRESH_MS = 30 * 60 * 1000;

export function deathZonesLoadFile(bot) {
  try {
    const o = JSON.parse(fs.readFileSync(DEATH_ZONE_FILE, "utf8"));
    const sp = bot?.spawnPoint;
    const same = (p) => !sp || p.sx == null || Math.hypot(p.sx - sp.x, p.sz - sp.z) < 32;
    const live = (p) => same(p) && Date.now() - p.t < DEATH_ZONE_FRESH_MS;
    const pts = Array.isArray(o?.pts) ? o.pts.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.t) && live(p)) : [];
    const camp = o?.camp && Number.isFinite(o.camp.x) && Number.isFinite(o.camp.t) && live(o.camp) ? o.camp : null;
    return { pts, camp };
  } catch {
    return { pts: [], camp: null };
  }
}

export function deathZonesSaveFile(bot, pts, camp) {
  try {
    const sp = bot?.spawnPoint;
    const tag = sp ? { sx: Math.round(sp.x), sz: Math.round(sp.z) } : {};
    fs.mkdirSync(path.dirname(DEATH_ZONE_FILE), { recursive: true });
    fs.writeFileSync(DEATH_ZONE_FILE, JSON.stringify({
      pts: (pts || []).slice(-24).map((p) => ({ x: Math.round(p.x), z: Math.round(p.z), t: p.t, ...tag })),
      ...(camp ? { camp: { x: Math.round(camp.x), z: Math.round(camp.z), t: camp.t || Date.now(), ...tag } } : {}),
    }));
  } catch {
    /* non-fatal */
  }
}

function stashRecord(pos, bot) {
  try {
    const list = stashLoadFile(bot);
    if (!list.some((p) => Math.abs(p.x - pos.x) < 2 && Math.abs(p.y - pos.y) < 2 && Math.abs(p.z - pos.z) < 2)) {
      const sp = bot?.spawnPoint;
      list.push({ x: pos.x, y: pos.y, z: pos.z, t: Date.now(), ...(sp ? { sx: Math.round(sp.x), sz: Math.round(sp.z) } : {}) });
      fs.mkdirSync(path.dirname(STASH_FILE), { recursive: true });
      fs.writeFileSync(STASH_FILE, JSON.stringify(list.slice(-40)));
    }
  } catch {
    /* non-fatal */
  }
}

async function stashFindOrPlaceChest(bot, mcData, state) {
  // recorded stash position first — verify it still holds a chest
  if (state?.stash) {
    const b = bot.blockAt(new Vec3(state.stash.x, state.stash.y, state.stash.z));
    if (b && b.name === "chest") return b;
    state.stash = null; // chest is gone — forget and re-place below
  }
  // a chest from an earlier run near enough to inspect (blockAt needs loaded chunks)
  const feet0 = bot.entity.position.floored();
  for (const p of stashLoadFile(bot)) {
    const d = Math.hypot(p.x - feet0.x, p.z - feet0.z);
    if (d > 24) continue;
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
    if (b?.name === "chest") {
      if (state) state.stash = b.position;
      return b;
    }
  }
  const near = bot.findBlock?.({ matching: (b) => b?.name === "chest", maxDistance: 8 });
  if (near) {
    if (state) state.stash = near.position.floored();
    stashRecord(near.position.floored(), bot);
    return near;
  }
  if (countItem(bot, "chest") < 1) {
    await ensurePlanks(bot, mcData, 8);
    // a chest needs a full ring of 8 — ensurePlanks reports ok for a partial
    // convert, so trust the real count or ensureCraft throws missing-ingredient
    if (countItem(bot, (i) => i.name.includes("planks")) < 8) return null;
    const cr = await ensureCraft(bot, mcData, "chest", 1);
    if (!cr.ok) return null;
  }
  // place adjacent on a solid support, like the table does
  const feet = bot.entity.position.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const support = bot.blockAt(feet.offset(dx, -1, dz));
    const cell = bot.blockAt(feet.offset(dx, 0, dz));
    if (!support || support.name === "air" || !cell || !/air|snow|grass$/.test(cell.name)) continue;
    const r = await executeAction(
      bot,
      { type: "place", item: "chest", x: cell.position.x, y: cell.position.y, z: cell.position.z, face: "top", timeoutMs: 8000 },
      mcData
    );
    if (r.ok) {
      await sleep(200);
      const b = bot.blockAt(cell.position);
      if (b?.name === "chest") {
        if (state) state.stash = b.position;
        stashRecord(b.position, bot);
        return b;
      }
    }
  }
  return null;
}

const STASH_FOOD = /^(bread|cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|cooked_cod|cooked_salmon|baked_potato|golden_carrot)$/;

export async function stashDeposit(bot, mcData, log, state) {
  try {
    const surplus = bot.inventory.items().filter((i) => i.count > stashKeepCount(i.name));
    // one-time "restart kit" per world: planks+sticks+table+food in the chest
    // is enough to re-craft the whole wood toolkit standing at the chest —
    // a death then costs a walk home, not a naked forest trek with fists
    const items = bot.inventory.items();
    const countOf = (re) => items.filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0);
    const kitDue =
      state &&
      !state.stashKitDone &&
      countOf(/_planks$/) + countOf(/_log$|_stem$/) * 4 >= 16 &&
      countOf(/^stick$/) >= 4 &&
      items.some((i) => i.name === "crafting_table") &&
      countOf(STASH_FOOD) >= 6;
    if (!surplus.length && !kitDue) return { ok: true, message: "nothing to stash" };
    const chestBlock = await stashFindOrPlaceChest(bot, mcData, state);
    if (!chestBlock) return { ok: false, message: "no chest" };
    const chest = await pt(bot.openChest(chestBlock), 8000, "open chest");
    let moved = 0;
    try {
      for (const item of surplus) {
        const keep = stashKeepCount(item.name);
        const give = item.count - keep;
        if (give <= 0) continue;
        await pt(chest.deposit(item.type, item.metadata, give), 8000, "deposit");
        moved += give;
      }
      if (kitDue) {
        // the kit needs real planks — convert logs first if the stack is thin
        if (countOf(/_planks$/) < 8) await ensurePlanks(bot, mcData, 16).catch(() => {});
        let kitMoved = 0;
        for (const [re, want] of [
          [/_planks$/, 8],
          [/^stick$/, 4],
          [/^crafting_table$/, 1],
          [STASH_FOOD, 4],
        ]) {
          let left = want;
          for (const it of bot.inventory.items().filter((i) => re.test(i.name))) {
            if (left <= 0) break;
            const g = Math.min(left, it.count);
            if (g <= 0) continue;
            await pt(chest.deposit(it.type, it.metadata, g), 8000, "kit deposit");
            left -= g;
            kitMoved += g;
            moved += g;
          }
        }
        if (kitMoved >= 12) state.stashKitDone = `${chestBlock.position.x},${chestBlock.position.z}`;
      }
    } finally {
      chest.close();
    }
    log?.(`[stash] stored ${moved} items @${chestBlock.position.x},${chestBlock.position.y},${chestBlock.position.z}`);
    return { ok: true, message: `stashed ${moved}` };
  } catch (err) {
    return { ok: false, message: `stash: ${err?.message || err}` };
  }
}

export async function stashRecover(bot, mcData, log, state) {
  try {
    // candidates: the live state's stash, plus every disk-recorded chest —
    // restarts drop state.stash but the chests are still in the world
    const me = bot.entity.position;
    const cands = [];
    if (state?.stash) cands.push({ x: state.stash.x, y: state.stash.y, z: state.stash.z });
    for (const p of stashLoadFile(bot)) {
      if (!cands.some((c) => Math.abs(c.x - p.x) < 2 && Math.abs(c.z - p.z) < 2)) cands.push(p);
    }
    const near = cands
      .map((p) => ({ p, d: Math.hypot(p.x - me.x, p.z - me.z) }))
      .filter((e) => e.d <= 300)
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    if (!near.length) return { ok: false, message: "no stash" };
    let took = 0;
    for (const { p } of near) {
      try {
        await executeAction(
          bot,
          { type: "goto", x: p.x + 0.5, y: p.y, z: p.z + 0.5, range: 2, timeoutMs: 30000 },
          mcData
        );
      } catch {
        continue; // unreachable — try the next chest
      }
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
      if (!b || b.name !== "chest") continue;
      const chest = await pt(bot.openChest(b), 8000, "open chest");
      try {
        for (const item of chest.containerItems()) {
          await pt(chest.withdraw(item.type, item.metadata, item.count), 8000, "withdraw");
          took += item.count;
        }
      } finally {
        chest.close();
      }
    }
    if (state?.stash) {
      const b = bot.blockAt(new Vec3(state.stash.x, state.stash.y, state.stash.z));
      if (!b || b.name !== "chest") state.stash = null;
    }
    if (took > 0) log?.(`[stash] recovered ${took} items`);
    return took > 0 ? { ok: true, message: `recovered ${took}` } : { ok: false, message: "stashes empty" };
  } catch (err) {
    return { ok: false, message: `recover: ${err?.message || err}` };
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

  // standing on a lone pillar/log/edge with no neighbor support — step off
  // to a random nearby cell and rescan once
  if (supportCandidates.length === 0) {
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2]]) {
      const spot = feet.offset(dx, -1, dz);
      await executeAction(
        bot,
        { type: "goto", x: spot.x, y: spot.y, z: spot.z, range: 1, timeoutMs: 5000 },
        mcData
      ).catch(() => {});
      const f2 = bot.entity.position.floored();
      const u2 = bot.blockAt(f2.offset(0, -1, 0));
      if (u2 && u2.name !== "air") {
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const solid = bot.blockAt(f2.offset(ax, -1, az));
          if (!solid || solid.name === "air" || solid.name === "cave_air") continue;
          if (solid.boundingBox && solid.boundingBox !== "block") continue;
          const above = bot.blockAt(solid.position.offset(0, 1, 0));
          if (above && (above.name === "air" || above.name === "cave_air" || above.name === "snow")) {
            supportCandidates.push(solid);
          }
        }
        if (supportCandidates.length) break;
      }
    }
  }
  // still nothing — a ±3m hop never leaves water or a cliff face; jump to
  // real ground ~12m out and rescan once more
  if (supportCandidates.length === 0) {
    const f0 = bot.entity.position.floored();
    const [hx, hz] = pickDryDir(bot, [[12, 0], [-12, 0], [0, 12], [0, -12]]);
    await executeAction(
      bot,
      { type: "goto", x: f0.x + hx, y: f0.y, z: f0.z + hz, range: 3, timeoutMs: 15000 },
      mcData
    ).catch(() => {});
    const f2 = bot.entity.position.floored();
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const solid = bot.blockAt(f2.offset(ax, -1, az));
      if (!solid || solid.name === "air" || solid.name === "cave_air") continue;
      if (solid.boundingBox && solid.boundingBox !== "block") continue;
      const above = bot.blockAt(solid.position.offset(0, 1, 0));
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

  // sealed-pocket fallback: a sealed 1x1 has no top-face spot anywhere — the
  // only free cells are air gaps BEHIND walls (below floor level, beside the
  // feet). A table can still hang on a side or bottom face into such a gap:
  // scan nearby air cells and place against any solid neighbor face.
  // face = direction from the reference block TO the target cell
  const FACE_NAMES = [
    [[0, -1, 0], "top"],
    [[0, 1, 0], "bottom"],
    [[1, 0, 0], "west"],
    [[-1, 0, 0], "east"],
    [[0, 0, 1], "north"],
    [[0, 0, -1], "south"],
  ];
  for (const dx of [-1, 0, 1, -2, 2]) {
    for (const dz of [-1, 0, 1, -2, 2]) {
      if (dx === 0 && dz === 0) continue;
      for (const dy of [-1, -2, 1]) {
        const cell = bot.blockAt(feet.offset(dx, dy, dz));
        if (!cell || !/^(air|cave_air|void_air|snow)$/.test(cell.name)) continue;
        if (cell.position.x === feet.x && cell.position.y === feet.y && cell.position.z === feet.z) continue;
        for (const [off, faceName] of FACE_NAMES) {
          const ref = bot.blockAt(cell.position.offset(off[0], off[1], off[2]));
          if (!ref || /^(air|cave_air|void_air|water|lava|snow|tall_grass)$/.test(ref.name)) continue;
          if (ref.boundingBox && ref.boundingBox !== "block") continue;
          const r = await executeAction(
            bot,
            { type: "place", item: "crafting_table", x: cell.position.x, y: cell.position.y, z: cell.position.z, face: faceName },
            mcData
          );
          lastMsg = r.message;
          if (r.ok || /placed crafting_table/i.test(String(r.message || ""))) {
            await sleep(200);
            const b = bot.findBlock({ matching: (bl) => bl?.name === "crafting_table", maxDistance: 5 });
            if (b) return { ok: true, message: r.message, block: b };
          }
        }
      }
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
          (e.kind === "Hostile mobs" && e.name !== "enderman" ||
            /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n)) &&
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
          .find((i) => !!mcData.blocksByName[i.name]);
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
      // overhang trap: every direction is a cliff — dig straight down through
      // the block under our feet (guarded: never into lava/water/deep falls)
      const under = bot.blockAt(p.offset(0, -1, 0));
      if (under && under.name !== "air" && !dangerous(under) && diggableBlock(bot, under)) {
        let landY = null;
        let landDangerous = false;
        for (let dy = -2; dy >= -5; dy--) {
          const b = bot.blockAt(p.offset(0, dy, 0));
          if (b && b.name !== "air") {
            if (dangerous(b)) landDangerous = true;
            else landY = b.position.y;
            break;
          }
        }
        if (landY != null && !landDangerous && !findHostile(bot, 8)) {
          // gravel/sand above or below invalidates the target mid-swing —
          // retry "Digging aborted" like the burrow shaft dig does
          let dig = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            dig = await executeAction(
              bot,
              { type: "dig", x: under.position.x, y: under.position.y, z: under.position.z, timeoutMs: 10000 },
              mcData
            );
            if (dig.ok || !/abort/i.test(String(dig?.message || ""))) break;
            await sleep(250);
          }
          if (dig?.ok) {
            await sleep(400); // let gravity settle the drop
            dug += 1;
            log?.(`[stairDown] vertical dig at ${p.x},${p.y},${p.z} → y~${landY}`);
            continue;
          }
          why.push(`vert:dig=${dig?.message}`);
        } else {
          why.push(`vert:${landY == null ? "deep" : landDangerous ? "danger" : "mob"}`);
        }
      } else {
        why.push(`vert:${under?.name ?? "air"}`);
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
// Swim up out of a flooded cave/mine: hold jump (rises straight up in water)
// and drift toward an adjacent column when the cell overhead is solid — the
// water column going up is the way out. Air = head cell reads non-water.
async function surfaceForAir(bot, mcData, log) {
  const t0 = Date.now();
  let dirIdx = 0;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  try {
    while (Date.now() - t0 < 25000) {
      const feet = bot.entity.position.floored();
      const head = bot.blockAt(feet.offset(0, 1, 0));
      if (!/water|bubble_column|kelp|seagrass/.test(String(head?.name || ""))) {
        return { ok: true };
      }
      const above = bot.blockAt(feet.offset(0, 2, 0));
      if (above && !/water|bubble_column|air|cave_air|kelp|seagrass/.test(above.name)) {
        // ceiling overhead — drift toward the next side hoping the water
        // column continues past this lip
        const [dx, dz] = dirs[dirIdx % 4];
        dirIdx += 1;
        bot.look(Math.atan2(-dx, -dz), -1.2, true);
      } else {
        // open above — rise straight up
        bot.look(bot.entity.yaw, -1.4, true);
      }
      bot.setControlState("jump", true);
      bot.setControlState("forward", true);
      await sleep(280);
    }
    return { ok: false };
  } finally {
    bot.setControlState("jump", false);
    bot.setControlState("forward", false);
  }
}

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
        (e.kind === "Hostile mobs" && e.name !== "enderman" ||
          /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n)) &&
        e.position.distanceTo(cell) < 10
      );
    });
  const nearestHostile = (maxD) => {
    let best = null;
    let bd = maxD;
    for (const e of Object.values(bot.entities || {})) {
      if (!e?.position || e === bot.entity) continue;
      const n = String(e.name || e.displayName || "").toLowerCase();
      if (
        !(e.kind === "Hostile mobs" && e.name !== "enderman" ||
          /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n))
      )
        continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  };
  // wall off the tunnel mouth between us and the mob: two stacked blocks
  // in the adjacent open cell on the mob's side. The strip then digs away
  // from it instead of spinning on the ambush forever
  const sealToward = async (mobPos) => {
    const f = bot.entity.position.floored();
    const vx = mobPos.x - (f.x + 0.5);
    const vz = mobPos.z - (f.z + 0.5);
    const order = [
      [Math.sign(vx), 0],
      [0, Math.sign(vz)],
      [Math.sign(vx), Math.sign(vz)],
      [-Math.sign(vx), 0],
      [0, -Math.sign(vz)],
    ];
    const isSolidItem = (i) => mcData.blocksByName[i.name]?.boundingBox === "block";
    for (const [sx, sz] of order) {
      if (!sx && !sz) continue;
      const cell = bot.blockAt(f.offset(sx, 0, sz));
      const below = bot.blockAt(f.offset(sx, -1, sz));
      if (!cell || !below || below.name === "air") continue;
      if (cell.name !== "air") continue; // already walled
      const solid = bot.inventory.items().find(isSolidItem);
      if (!solid) return false;
      try {
        await pt(bot.equip(solid, "hand"), 6000, "equip-seal");
        await pt(bot.placeBlock(below, new Vec3(0, 1, 0)), 8000, "seal");
        const above = bot.blockAt(f.offset(sx, 1, sz));
        const base = bot.blockAt(f.offset(sx, 0, sz));
        if (above?.name === "air" && base && base.name !== "air") {
          const solid2 = bot.inventory.items().find(isSolidItem);
          if (solid2) {
            await pt(bot.equip(solid2, "hand"), 6000, "equip-seal2").catch(() => {});
            await pt(bot.placeBlock(base, new Vec3(0, 1, 0)), 8000, "seal2").catch(() => {});
          }
        }
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };
  let sealTried = 0;
  for (let i = 0; i < steps; i++) {
    const p = bot.entity.position.floored();
    // submerged head = drowning — a flooded aquifer returns mined=0 on every
    // direction and the caller loop spins while the air bar empties. Bail so
    // the iron phase can swim for air and relocate the mine
    const headB = bot.blockAt(p.offset(0, 1, 0));
    if (/water|bubble_column/.test(String(headB?.name || ""))) {
      log?.("[stripMine] submerged — bailing for air");
      break;
    }
    // the strip killer is a mob walking up the 1x2 shaft from behind while
    // the digger faces a wall — check the tunnel, not just the next cell:
    // wall it off at distance, swing when it's already in melee
    const close = nearestHostile(7);
    if (close) {
      if (close.position.distanceTo(bot.entity.position) > 2.6) {
        if (await sealToward(close.position)) {
          log?.(`[stripMine] walled ${close.name} mid-tunnel @${Math.round(close.position.distanceTo(bot.entity.position))}m`);
          continue;
        }
      } else {
        const w = bot.inventory.items().find((it) => /sword|_axe/.test(it.name));
        if (w) {
          try {
            await pt(bot.equip(w, "hand"), 5000, "eq");
            await pt(bot.attack(close), 6000, "atk");
          } catch {
            /* swung and missed — reflex/night cycle handles the rest */
          }
        }
      }
    }
    // a pickaxe broke mid-strip — stop hand-tapping stone and recraft one
    // on the spot (log+sticks or cobble+sticks are usually in the bag);
    // bail only when even that fails
    if (!hasPickaxe(bot)) {
      const pk = await ensurePickaxe(bot, mcData).catch(() => null);
      if (!pk?.ok) {
        log?.("[stripMine] pickaxe gone and not recraftable — bailing");
        break;
      }
    }
    const floor = bot.blockAt(p.offset(dx, -1, dz));
    const f1 = bot.blockAt(p.offset(dx, 0, dz));
    const h1 = bot.blockAt(p.offset(dx, 1, dz));
    // bad() treats air/liquid as bad — an open cell ahead is a cave mouth,
    // and a mob standing near the step cell is an ambush; both rotate
    if (bad(f1) || bad(h1) || !floor || /lava|water|air/.test(floor.name) || mobNear(p.offset(dx, 0, dz))) {
      // fissure traverse: if the cells ahead are open air but each has a
      // solid floor and a diggable wall resumes within 12 blocks, walk
      // across and keep stripping on the far side — a 4-cell cap spun
      // forever inside a wide cave room where every direction was air
      if ((bad(f1) || bad(h1)) && !mobNear(p.offset(dx, 0, dz))) {
        let gapLen = 0;
        let farSide = null;
        for (let k = 1; k <= 12; k++) {
          const cf = bot.blockAt(p.offset(dx * k, -1, dz * k));
          const c0 = bot.blockAt(p.offset(dx * k, 0, dz * k));
          const c1 = bot.blockAt(p.offset(dx * k, 1, dz * k));
          if (!cf || /lava|water|air/.test(cf.name)) break; // no floor — don't walk
          // same-level crossing only — a floor 3+ lower is a ravine slope:
          // crossing those walked the strip down into deep-dark territory
          if (Math.abs(cf.position.y - (p.y - 1)) > 2) break;
          if (!bad(c0) || !bad(c1)) {
            farSide = k; // wall resumes at cell k
            break;
          }
          gapLen = k;
        }
        if (farSide && gapLen >= 1 && !mobNear(p.offset(dx * gapLen, 0, dz * gapLen))) {
          const tx = p.x + dx * gapLen + 0.5;
          const tz = p.z + dz * gapLen + 0.5;
          const hop = await executeAction(
            bot,
            { type: "goto", x: tx, y: p.y, z: tz, range: 0.7, timeoutMs: 6000 + gapLen * 2000 },
            mcData
          );
          if (hop.ok) {
            i -= 1;
            continue;
          }
        }
      }
      dirIdx = (dirIdx + 1) % 4;
      [dx, dz] = dirs[dirIdx];
      i -= 1;
      spins += 1;
      if (spins > 12) {
        // every direction is an open mouth or a camper — wall the mob's
        // side once and give the strip a few more rotations in the rest
        const mob = nearestHostile(12);
        if (mob && sealTried < 2 && (await sealToward(mob.position))) {
          sealTried += 1;
          log?.(`[stripMine] walled off ${mob.name} @${Math.round(mob.position.distanceTo(bot.entity.position))}m — digging away`);
          spins = 6;
          continue;
        }
        break;
      }
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
  const feet = bot.entity.position.floored();
  let best = dirs[0];
  let bestScore = Infinity;
  for (const [dx, dz] of dirs) {
    const sx = Math.sign(dx);
    const sz = Math.sign(dz);
    const leg = Math.max(Math.abs(dx), Math.abs(dz));
    // measure the dry runway: how far this leg stays out of water. Legs now
    // scale past 200m and drowned kill in any river the sprint crosses, so
    // score = distance to the first water cell along the whole leg (all-wet
    // picks the longest dry stretch instead of blindly diving in)
    let runway = leg + 1;
    for (let step = 6; step <= Math.min(leg, 90); step += 6) {
      let wet = false;
      for (const dy of [-3, -2, -1, 0]) {
        const b = bot.blockAt(feet.offset(sx * step, dy, sz * step));
        if (b && /water|kelp|seagrass|ice|bubble/.test(b.name)) {
          wet = true;
          break;
        }
      }
      if (wet) {
        runway = step;
        break;
      }
    }
    // dense forest slows the sprint — prefer open water-free ground
    let trees = 0;
    for (const step of [8, 16, 24]) {
      const b = bot.blockAt(feet.offset(sx * step, -1, sz * step));
      if (b && /_log$|_stem$|leaves$/.test(b.name)) trees += 1;
    }
    const score = -runway * 10 + trees;
    if (score < bestScore) {
      bestScore = score;
      best = [dx, dz];
    }
  }
  return best;
}

export async function burrowForNight(bot, mcData, log, force = false, _depth = 0, state = null) {
  const tod = bot.time?.timeOfDay;
  if (!force && (tod == null || tod < 12541)) return false;
  // a failed dig leaves the bot standing exposed — relocate to a different
  // patch of ground and try the whole burrow again instead of giving up
  let triedLogs = false;
  const retryElsewhere = async (why) => {
    if (_depth >= 4) return false;
    log?.(`[burrow] ${why} — relocating`);
    const p = bot.entity.position.floored();
    // empty-handed on hard ground: nothing diggable and no blocks to
    // pillar with — every relocate repeats the same failure. Punch a few
    // logs once: logs count as solid for the pillar fallback and craft
    // into planks/sticks on the spot.
    if (!triedLogs) {
      triedLogs = true;
      const hasMat = bot.inventory
        .items()
        .some((i) => !!mcData.blocksByName[i.name]);
      if (!hasMat) {
        try {
          await punchNearbyLogs(bot, mcData, 4, null);
        } catch {
          /* no tree in reach — fall through to the relocate */
        }
      }
    }
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
          if (a1?.name !== "air" || a2?.name !== "air") return false;
          // two diggable cells below too — grass-over-stone tops dig one
          // layer then stall on the same mountain that just failed
          if (!(diggable(bb) && diggable(bot.blockAt(bb.position.offset(0, -1, 0))) && diggable(bot.blockAt(bb.position.offset(0, -2, 0))))) return false;
          // and at least one side carves a depth-2 pocket — a diggable
          // column ringed by stone walls is a guaranteed seal(undiggable)
          // fail that just burns another relocate hop
          return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) =>
            [1, 2].every((i) =>
              [1, 2].every((dy) =>
                diggable(bot.blockAt(bb.position.offset(dx * i, dy, dz * i)))
              )
            )
          );
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
      // memory beats a blind hop: spots where logs were punched before
      // grew on diggable dirt — walk toward the closest one when in reach
      const site = (state?.logSites || [])
        .map((s) => ({ s, d: Math.hypot(s.x - p.x, s.z - p.z) }))
        .filter((e) => e.d > 24 && e.d < 160)
        .sort((a, b) => a.d - b.d)[0]?.s;
      if (site) {
        try {
          await executeAction(
            bot,
            { type: "goto", x: site.x + 0.5, y: site.y, z: site.z + 0.5, range: 3, timeoutMs: 12000 + _depth * 8000 },
            mcData
          );
        } catch {
          /* move didn't land — try the burrow from wherever we are */
        }
      } else {
        // a bare-handed bot on rock has no shelter option but soft ground —
        // 18m hops never leave a mountain ridge; escalate the wander with
        // depth so each failure travels meaningfully farther
        const hop = 18 + _depth * 24;
        const dirs = [
          [hop, 0],
          [-hop, 0],
          [0, hop],
          [0, -hop],
        ];
        const [rx, rz] = pickDryDir(bot, dirs);
        try {
          await executeAction(
            bot,
            { type: "goto", x: p.x + rx + 0.5, y: p.y, z: p.z + rz + 0.5, range: 3, timeoutMs: 12000 + _depth * 8000 },
            mcData
          );
        } catch {
          /* move didn't land — try the burrow from wherever we are */
        }
      }
    }
    // the landing spot matters more than the dig attempt: a hostile standing
    // at the new site kills the bot mid-carve every time. Keep hopping
    // instead of burrowing under the camper — bounded: a camper that
    // follows forever must not recurse forever
    state = state || {};
    state._camperHops = state._camperHops || 0;
    const camperNow = findHostile(bot, 12);
    if (camperNow && state._camperHops < 3) {
      state._camperHops += 1;
      log?.("[burrow] camper followed — keep hopping");
      return retryElsewhere("camper at site");
    }
    // hops never lose a follower — the only way to break contact is to
    // out-sprint it (zombie 2.3m/s vs sprint ~5.6). Hard sprint, then try
    // the burrow again at the far site; digging in place with a mob inside
    // reach is exactly the mid-carve death loop
    if (camperNow && !state._camperFled) {
      state._camperFled = true;
      log?.("[burrow] camper sticky — hard sprint to break contact");
      try {
        const away = bot.entity.position.minus(camperNow.position);
        const yaw = Math.atan2(-away.x, -away.z);
        bot.setControlState("sprint", true);
        bot.setControlState("forward", true);
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
          bot.look(yaw, 0, true);
          bot.setControlState("jump", Date.now() % 800 < 400);
          await sleep(160);
        }
        bot.setControlState("forward", false);
        bot.setControlState("sprint", false);
        bot.setControlState("jump", false);
      } catch {
        /* best effort — retry wherever we landed */
      }
      state._camperHops = 0;
      return retryElsewhere("fled camper");
    }
    if (camperNow && state._camperFled) {
      return { ok: false, reason: "camper kept up through the flee" };
    }
    return burrowForNight(bot, mcData, log, force, _depth + 1, state);
  };
  // re-fetched lazily — a bare-handed start has nothing, but digging the
  // pocket itself drops dirt/blocks that can then seal the doorway
  // only full-cube blocks can carry a pillar or a doorway wall — torches,
  // saplings and other "empty" bounding-box items place but support nothing
  const isCube = (i) => mcData.blocksByName[i.name]?.boundingBox === "block";
  // seal/pillar material: prefer real terrain blocks. Tile entities and
  // interactables (furnace, chest, workbenches, bed, tnt) are full cubes but
  // place unreliably — oriented placement gets refused or silently dropped
  const SEAL_BAD =
    /furnace|chest|barrel|table|bed$|sign|skull|_head$|banner|campfire|piston|observer|dispenser|dropper|hopper|jukebox|note_block|beehive|bee_nest|spawner|shulker|ender|tnt|lectern|lodestone|respawn_anchor|bell|grindstone|stonecutter|loom|smithing|fletching|cartography|command_block|structure|jigsaw|portal|chorus|slime_block|honey|magma|ice$|snow$|pointed|conduit|beacon|composter|cauldron|brewing|enchanting|sculk|frame|soul_campfire|decorated_pot|trial|vault|crafter/;
  const SEAL_RANK = [
    /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|clay|sand|red_sand|gravel)$/,
    /^(cobblestone|cobbled_deepslate|stone|deepslate|andesite|diorite|granite|tuff|netherrack|blackstone|basalt|sandstone|red_sandstone|dirt_path)$/,
    /_log$|_stem$|_wood$|_hyphae$|planks|bricks?$|wool$|terracotta|concrete$/,
  ];
  const refreshSolid = () => {
    // always re-find: items() hands out fresh objects, the old ref's count
    // never updates — a fully-consumed stack would still look usable
    const items = bot.inventory.items().filter(isCube);
    for (const re of SEAL_RANK) {
      const m = items.find((i) => re.test(i.name) && !SEAL_BAD.test(i.name));
      if (m) {
        solid = m;
        return solid;
      }
    }
    solid = items.find((i) => !SEAL_BAD.test(i.name)) || items[0] || null;
    return solid;
  };
  let solid = null;
  refreshSolid();
  const danger = (b) => !b || /air|lava|water|magma_block|bedrock/.test(b.name);
  // diggable = terrain the bot can actually break with what it carries —
  // mineflayer's b.diggable doesn't account for harvestTools, so check by
  // name class: a small set is always hand-breakable, everything else
  // (stone/ore/bricks) needs a pickaxe in inventory
  const diggable = (b) => diggableBlock(bot, b);
  // safe() = daylight and no hostile within 28 (creepers/spiders don't burn,
  // spawn-campers outlast sunrise; a crawler at ~20m still sprints in and
  // kills the exit — 16m was too small to hold through)
  const safe = () => {
    const t = bot.time?.timeOfDay;
    // null time = unread clock, not daytime — a stale time read once let
    // the bot unseal at true night straight into the camper it hid from
    if (t == null || t >= 12541) return false;
    return !Object.values(bot.entities || {}).some((e) => {
      if (!e?.position || e === bot.entity) return false;
      const n = String(e.name || e.displayName || "").toLowerCase();
      const hostile =
        e.kind === "Hostile mobs" && e.name !== "enderman" ||
        /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
      return hostile && e.position.distanceTo(bot.entity.position) < 40;
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
  // Bare-handed respawn: nothing to cap/brim/pillar with — every downstream
  // shelter dies mid-build (solids<8 and no pick means stone ground is
  // untouchable too). One bounded log punch buys all of it back — run it
  // BEFORE the pickaxe recraft so the wood can become planks+sticks+pick.
  const solidsHere = () =>
    bot.inventory.items().reduce((n, i) => n + (mcData.blocksByName[i.name] ? i.count : 0), 0);
  if (solidsHere() < 8) {
    const trunk = bot.findBlock({
      matching: (b) => b && /_log$|_stem$/.test(b.name || ""),
      maxDistance: 40,
    });
    if (trunk) {
      log?.("[burrow] bare-handed — punching a log for shelter material");
      await pt(punchNearbyLogs(bot, mcData, 4, state), 25000, "log punch").catch(() => null);
    }
  }
  // a broken pickaxe makes every stone column undiggable underground —
  // recraft before scanning so y<0 depth isn't mistaken for unworkable ground
  if (!hasPickaxe(bot)) {
    const pk = await ensurePickaxe(bot, mcData).catch(() => null);
    if (pk?.ok) log?.("[burrow] recrafted pickaxe — stone diggable again");
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
    // the shaft digs only 3 cells (-1..-3) and lands on a floor at -4 —
    // demanding diggable to -6 rejected most plains columns (stone starts
    // at -4/-5) and forced the slow pillar path. -1..-3 must be diggable;
    // -4 must merely exist and be non-dangerous. Logs/leaves are a tree
    // trunk, not ground.
    let solidCol = true;
    for (let dy = -1; dy >= -4; dy--) {
      const b = bot.blockAt(p.offset(0, dy, 0));
      const ok = dy >= -3 ? diggable(b) : b && b.name !== "air" && !danger(b);
      if (!ok || /_log$|_stem$|leaves$/.test(b?.name || "")) {
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
  // wall-carve only works when a diggable wall actually exists next to the
  // bot — on open rocky ground (bare hands vs stone) every carve cell is
  // air or undiggable and the pocket is guaranteed to fail; in that case the
  // pillar fallback is the only shelter that needs no digging
  const wallViable = () => {
    const p = bot.entity.position.floored();
    for (const [px, pz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let ok = true;
      for (let i = 1; i <= 2; i++) {
        if (
          !diggable(bot.blockAt(p.offset(px * i, 0, pz * i))) ||
          !diggable(bot.blockAt(p.offset(px * i, 1, pz * i)))
        ) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
  let dug = 0;
  let needsShaft = true;
  if (!spot && refreshSolid() && wallViable()) {
    // no diggable column — we're deep in a tunnel or on undiggable floor.
    // The tunnel wall itself is the burrow: carve a sideways pocket at
    // ground level (all diggable stone) instead of digging a shaft first
    spot = bot.entity.position.floored();
    needsShaft = false;
    log?.("[burrow] no safe column — carving into tunnel wall");
  }
  if (!spot) {
    // a pillar is NOT cover from a ranged camper — a skeleton shoots you off
    // the top before it finishes. With a shooter in range the only working
    // move is to keep sprinting and break line of sight (arrows whiff a
    // sprint-jumping target past ~25m); a melee-only camp is what pillars beat
    const rangedNear = Object.values(bot.entities || {}).some(
      (e) =>
        e?.position &&
        (e.kind === "Hostile mobs" && e.name !== "enderman" || /skeleton|stray|witch|pillager|drowned|phantom|blaze|ghast|shulker/.test(String(e.name || ""))) &&
        /skeleton|stray|witch|pillager|drowned|phantom|blaze|ghast|shulker/.test(String(e.name || "")) &&
        e.position.distanceTo(bot.entity.position) < 36
    );
    if (rangedNear) {
      // A wall on the shooter's bearing breaks its line of sight in ~2s —
      // cheap enough to try before fleeing (which loses on open plains: the
      // skeleton just tracks and shoots the running target). If the wall
      // can't go up we keep the old answer and stay mobile.
      const shooter = Object.values(bot.entities || {}).find(
        (e) =>
          e?.position &&
          /skeleton|stray|witch|pillager|drowned|phantom|blaze|ghast|shulker/.test(String(e.name || "")) &&
          e.position.distanceTo(bot.entity.position) < 36
      );
      let walled = false;
      if (shooter) {
        const feet0 = bot.entity.position.floored();
        const vx = shooter.position.x - bot.entity.position.x;
        const vz = shooter.position.z - bot.entity.position.z;
        const [bx, bz] = Math.abs(vx) >= Math.abs(vz) ? [Math.sign(vx) || 1, 0] : [0, Math.sign(vz) || 1];
        const solid0 = refreshSolid();
        if (solid0) {
          try {
            await pt(bot.equip(solid0, "hand"), 6000, "equip-wall");
            for (let t = 0; t < 10 && !bot.heldItem; t += 1) await sleep(80);
            if (bot.heldItem) {
              for (let dy = 0; dy < 3; dy += 1) {
                const ref = bot.blockAt(feet0.offset(bx * 2, dy - 1, bz * 2));
                const dst = bot.blockAt(feet0.offset(bx * 2, dy, bz * 2));
                if (!ref || ref.name === "air" || !dst || dst.name !== "air") continue;
                const okPlace = await executeAction(
                  bot,
                  { type: "place", item: solid0.name, x: dst.position.x, y: dst.position.y, z: dst.position.z, timeoutMs: 3000 },
                  mcData
                ).catch(() => ({ ok: false }));
                if (!okPlace.ok) break;
                walled = true;
              }
            }
          } catch {
            /* wall best-effort */
          }
        }
      }
      log?.(
        walled
          ? "[burrow] LOS wall up vs ranged camper — pillaring behind it"
          : "[burrow] no wall vs ranged camper — pillaring anyway, open-plain flight is a death sentence"
      );
    }
    // last resort: pillar up where we stand — mobs can't climb 6+ blocks
    // (skeletons can still shoot; still better than standing on the ground)
    log?.("[burrow] no safe column — pillaring up");
    // refuge takes ~12 solids; raw logs are 1 block each. Crafting them to
    // planks (2x2, no table) quadruples the build budget on the spot
    const solidsCount = () =>
      bot.inventory.items().reduce((n, i) => n + (mcData.blocksByName[i.name] ? i.count : 0), 0);
    if (solidsCount() < 12 && countItem(bot, CRAFTABLE_LOG) >= 1) {
      try {
        await ensurePlanks(bot, mcData, 12);
      } catch {
        /* craft desync — pillar on raw logs if it comes to that */
      }
    }
    // a naked bot (post-death, fresh spawn) owns nothing to place — mine a
    // few hand-diggable terrain blocks right here and pillar with those
    if (solidsCount() < 12) {
      const SOFT = /^(dirt|grass_block|sand|red_sand|gravel|farmland|dirt_path|mycelium|podzol|snow_block|clay|mud|coarse_dirt|rooted_dirt|soul_sand|soul_soil|mangrove_roots)$|leaves$/;
      const feet = bot.entity.position.floored();
      const cands = [];
      for (let dx = -3; dx <= 3; dx += 1) {
        for (let dz = -3; dz <= 3; dz += 1) {
          for (let dy = -2; dy <= 1; dy += 1) {
            const b = bot.blockAt(feet.offset(dx, dy, dz));
            if (b && SOFT.test(b.name)) cands.push(b);
          }
        }
      }
      // prefer blocks NOT under our feet (digging the ground out drops us)
      cands.sort((a, b) => {
        const ua = a.position.y >= feet.y ? 1 : 0;
        const ub = b.position.y >= feet.y ? 1 : 0;
        return ub - ua || a.position.distanceSquared(feet) - b.position.distanceSquared(feet);
      });
      for (const b of cands.slice(0, 14)) {
        if (solidsCount() >= 14) break;
        try {
          await pt(bot.dig(b), 8000, "dig-soft");
        } catch {
          /* keep grabbing the rest */
        }
        await sleep(250); // let the drop land in the pickup radius
      }
    }
    let raised = 0;
    for (let i = 0; i < 7 && refreshSolid(); i++) {
      let ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
      if (!ref || ref.name === "air") {
        // burrow can trigger mid-hop/mid-knockback — the cell under the feet
        // is air until we land; wait briefly for grounding before giving up
        const waitGround = Date.now();
        while ((!ref || ref.name === "air") && Date.now() - waitGround < 2500) {
          await sleep(150);
          ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        }
      }
      if (!ref || ref.name === "air") {
        log?.(`[burrow] pillar err: no ground under feet (inWater=${Boolean(bot.entity.isInWater)})`);
        break;
      }
      try {
        await pt(bot.equip(solid, "hand"), 8000, "equip");
        // equip resolves on the client switch — the held slot can still read
        // null server-side for a beat (or the chosen stack ran dry). Verify
        // the hand really holds a block before offering the place packet.
        for (let t = 0; t < 12 && !bot.heldItem; t += 1) await sleep(100);
        if (!bot.heldItem) {
          const solid2 = refreshSolid();
          if (solid2) await pt(bot.equip(solid2, "hand"), 6000, "re-equip").catch(() => {});
          for (let t = 0; t < 12 && !bot.heldItem; t += 1) await sleep(100);
        }
        if (!bot.heldItem) {
          log?.(`[burrow] pillar err: held slot empty after equip`);
          break;
        }
        // the server refuses a placement whose cell our body still
        // intersects — legal only once feet clear the destination block's
        // top (ref.y+2). Jump, place at apex, retry while the hop window
        // stays open instead of giving up on a single mistimed attempt
        // can't pillar where there's no room to clear the destination cell —
        // a ceiling (or tree canopy over water) pins the body inside it.
        // Sidestep to open sky inside this same attempt instead of burning
        // a whole relocate on a site that's 2 blocks from clear.
        const PASSABLE = /air|cave_air|water|bubble_column|snow|tall_grass|grass|fern|vine|ladder/;
        const headroom = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
        if (headroom && !PASSABLE.test(headroom.name)) {
          // a soft lid overhead (dirt/gravel/leaves) — dig through it
          // instead of relocating: two digs open the shaft the pillar needs
          let foundSky = false;
          if (diggable(headroom)) {
            try {
              await pt(bot.dig(headroom), 9000, "dig-lid");
              const h3 = bot.blockAt(bot.entity.position.floored().offset(0, 3, 0));
              if (h3 && !PASSABLE.test(h3.name) && diggable(h3)) {
                await pt(bot.dig(h3), 9000, "dig-lid2");
              }
              const h2 = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
              foundSky = PASSABLE.test(h2?.name || "");
            } catch {
              /* dig refused — fall through to the sidestep scan */
            }
          }
          for (const [sx, sz] of foundSky ? [] : [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0]]) {
            const f = bot.entity.position.floored();
            try {
              await executeAction(
                bot,
                { type: "goto", x: f.x + sx + 0.5, y: f.y, z: f.z + sz + 0.5, range: 0.8, timeoutMs: 5000 },
                mcData
              );
            } catch {
              /* blocked — try the next side */
            }
            const f2 = bot.entity.position.floored();
            const clear =
              PASSABLE.test(bot.blockAt(f2.offset(0, 2, 0))?.name || "") &&
              PASSABLE.test(bot.blockAt(f2.offset(0, 3, 0))?.name || "");
            if (clear) {
              ref = bot.blockAt(f2.offset(0, -1, 0));
              if (ref && ref.name !== "air") {
                foundSky = true;
                break;
              }
            }
          }
          if (!foundSky) {
            log?.(`[burrow] pillar err: no headroom (${headroom.name} overhead)`);
            break;
          }
        }
        // swimming up in water is a slow constant float (~0.25 m/s), not a
        // ballistic hop — the lift needs far longer and never reaches
        // velocity~0, so the apex wait doesn't apply in water. At the surface
        // the feet cell reads air — check the entity flag, not the block
        const inWater = Boolean(bot.entity.isInWater) ||
          /water|bubble_column/.test(
            String(bot.blockAt(bot.entity.position.floored())?.name || "") +
              " " +
              String(bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))?.name || "")
          );
        let placed = false;
        // a mob within melee lands knockback mid-hop and the razor window
        // never lands — skip the timed place entirely and staircase instead
        const mobAdjacent = Object.values(bot.entities || {}).some(
          (e) =>
            e?.position &&
            e !== bot.entity &&
            (e.kind === "Hostile mobs" && e.name !== "enderman" ||
              /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex|piglin/.test(
                String(e.name || "")
              )) &&
            e.position.distanceTo(bot.entity.position) < 5
        );
        for (let attempt = 0; attempt < (mobAdjacent ? 0 : 3) && !placed; attempt++) {
          // keep hopping and offer the place on EVERY tick the body is legal:
          // the clear window (feet ≥ ref.y+2) is ~0.15s per jump and offer
          // latency lands most single-shot attempts below it — polling each
          // hop gives several windows per attempt instead of one
          bot.setControlState("jump", true);
          const liftCap = inWater ? 8000 : 2600;
          const lift = Date.now();
          let gaveUp = false;
          while (Date.now() - lift < liftCap) {
            // predictive window: vel is blocks/tick and the server applies
            // the entity-intersection check ~2-3 ticks after the packet —
            // offer when the apply-time position (feet + vel*2.5 minus
            // ~0.25 of gravity decay) clears the destination cell's top
            const vy = bot.entity.velocity?.y ?? 0;
            const feetAtApply = bot.entity.position.y + vy * 2.5 - 0.25;
            if (vy > 0.08 && feetAtApply >= ref.position.y + 2.02) {
              try {
                await pt(bot.placeBlock(ref, new Vec3(0, 1, 0)), 8000, "placeBlock");
                placed = true;
                break;
              } catch (pe) {
                const feetB = bot.blockAt(bot.entity.position.floored());
                log?.(
                  `[burrow] place refused: ref=${ref.name}@${ref.position.y} dest=${bot.blockAt(ref.position.offset(0, 1, 0))?.name} ` +
                    `feet=${feetB?.name}@${bot.entity.position.y.toFixed(2)} vel=${bot.entity.velocity?.y?.toFixed(2)} ` +
                    `held=${bot.heldItem?.name} eye=${bot.entity.eyeHeight?.toFixed(2)} (${pe?.message || pe})`
                );
                if (!inWater) gaveUp = true; // refusal mid-air — re-hop next attempt
                break;
              }
            }
            await sleep(40);
          }
          bot.setControlState("jump", false);
          if (placed) break;
          if (gaveUp || bot.entity.position.y < ref.position.y + 1.5) {
            if (bot.entity.position.y < ref.position.y + 1.5) break; // never lifted
          }
          await sleep(150);
        }
        if (!placed) {
          // straight pillar keeps hitting the razor-window refusal — switch
          // to a staircase: bridge+riser placements are all ADJACENT cells,
          // which the body can never intersect, so no timing is involved.
          // Each iteration is +1 height / +1 horizontal.
          const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          let climbed = 0;
          let stairWhy = "";
          const stairTrail = [];
          // the fallback runs right after failed jump attempts — the bot can
          // still be airborne with the cell under its feet reading air. Wait
          // to land, then use the column we were pillaring on as the stand
          const grounded = Date.now();
          while (Date.now() - grounded < 2000) {
            const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
            if (below && below.name !== "air" && !bot.entity.velocity?.y) break;
            if (below && below.name !== "air") break;
            await sleep(120);
          }
          for (let level = 0; level + raised < 5 && refreshSolid(); level++) {
            let done = false;
            for (let di = 0; di < 4 && !done; di++) {
              const [dx, dz] = dirs[(di + level) % 4];
              const feet = bot.entity.position.floored();
              let stand = bot.blockAt(feet.offset(0, -1, 0));
              if ((!stand || stand.name === "air") && ref && ref.name !== "air") {
                // drifted off the column edge mid-hop — pillar on from the ref
                stand = ref;
              }
              if (!stand || stand.name === "air") {
                stairWhy = "no-stand";
                break;
              }
              const bridgePos = stand.position.offset(dx, 0, dz);
              const bridgeCell = bot.blockAt(bridgePos);
              let riserCell = bot.blockAt(bridgePos.offset(0, 1, 0));
              // on slopes the riser cell is often terrain — clear it by hand
              // instead of skipping the direction outright
              if (riserCell && riserCell.name !== "air" && diggable(riserCell)) {
                try {
                  await pt(bot.dig(riserCell), 8000, "stair-clear");
                  await sleep(150);
                  riserCell = bot.blockAt(bridgePos.offset(0, 1, 0));
                } catch {
                  /* leave blocked */
                }
              }
              if (!bridgeCell || !riserCell || riserCell.name !== "air") {
                stairWhy = `riser-blocked(${riserCell?.name || "?"})`;
                continue;
              }
              if (
                bridgeCell.name === "air" ||
                /^(cave_air|void_air|water|bubble_column|tall_grass|short_grass|grass|fern|large_fern|snow|vine|seagrass|dead_bush|fire|soul_fire)$|_bush$|_flower$|_sapling$|dandelion|poppy|cornflower|daisy|mushroom/.test(
                  bridgeCell.name
                )
              ) {
                const s1 = refreshSolid();
                if (!s1) {
                  stairWhy = "no-solid";
                  break;
                }
                await pt(bot.equip(s1, "hand"), 6000, "equip").catch(() => {});
                try {
                  await pt(bot.placeBlock(stand, new Vec3(dx, 0, dz)), 7000, "stair-bridge");
                  stairTrail.push(bridgePos.clone());
                } catch (be) {
                  stairWhy = `bridge-refused(${be?.message || be})`;
                  continue;
                }
                await sleep(150);
              }
              const riserBase = bot.blockAt(bridgePos);
              if (!riserBase || riserBase.name === "air") {
                stairWhy = "bridge-missing";
                continue;
              }
              const s2 = refreshSolid();
              if (!s2) {
                stairWhy = "no-solid2";
                break;
              }
              await pt(bot.equip(s2, "hand"), 6000, "equip").catch(() => {});
              try {
                await pt(bot.placeBlock(riserBase, new Vec3(0, 1, 0)), 7000, "stair-riser");
                stairTrail.push(riserBase.position.offset(0, 1, 0));
              } catch (re) {
                stairWhy = `riser-refused(${re?.message || re})`;
                continue;
              }
              // hop onto the riser (+1 y, +1 toward dx,dz)
              for (let h = 0; h < 4 && !done; h++) {
                try {
                  await bot.lookAt(bridgePos.offset(0.5, 1.2, 0.5), true);
                } catch {
                  /* look is best-effort */
                }
                bot.setControlState("jump", true);
                bot.setControlState("forward", true);
                await sleep(420);
                bot.setControlState("jump", false);
                bot.setControlState("forward", false);
                done = bot.entity.position.y >= feet.y + 0.9;
              }
              if (!done) stairWhy = `hop-fail(y=${bot.entity.position.y.toFixed(1)} want≥${feet.y + 0.9})`;
            }
            if (!done) break;
            climbed += 1;
          }
          raised += climbed;
          if (climbed === 0) {
            log?.(`[burrow] pillar err: place refused (stair: ${stairWhy || "no dirs"})`);
            break;
          }
          log?.(`[burrow] staircase +${climbed}`);
          // a staircase is WALKABLE — zombies climb it (the on-pillar death).
          // Break the bottom steps: the column top stays unreachable
          const topY = bot.entity.position.floored().y;
          for (const p of stairTrail) {
            if (p.y > topY - 2) continue;
            const b = bot.blockAt(p);
            if (!b || b.name === "air" || !diggable(b)) continue;
            try {
              await pt(bot.dig(b), 8000, "stair-cut");
            } catch {
              /* unreachable from here — leave it */
            }
            await sleep(150);
          }
          continue;
        }
        raised += 1;
      } catch (e) {
        bot.setControlState("jump", false);
        log?.(`[burrow] pillar err: ${e?.message || e}`);
        break;
      }
      await sleep(250);
    }
    if (raised >= 4) {
      // sheltered on the pillar: the reflex would pathfinder-walk off the
      // edge to reach a mob it sees below — park it until we climb down
      bot._inShelter = true;
      try {
        // upgrade the bare pillar into a refuge when materials allow —
        // a naked pillar still loses to skeleton arrows (LoS) and spiders
        // (they climb). Brim lip stops climbers; wall+roof on the camper's
        // side blocks arrows. All parts need non-falling blocks.
        const NONGRAV = /^(?!.*(sand|gravel|concrete_powder|anvil|scaffold|snow$|snow_layer|tnt|red_sand)).*$/;
        const refugeSolid = () =>
          bot.inventory.items().find((i) => isCube(i) && NONGRAV.test(i.name));
        const topCol = () => bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        const hasTop = () => {
          const t = topCol();
          return t && t.name !== "air" ? t : null;
        };
        try {
          // brim ring on the column's top block side faces — spiders climbing
          // the column hit the lip and can't wrap around it
          const colB = hasTop();
          if (colB) {
            for (const [bx, bz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const s = refugeSolid();
              if (!s) break;
              const cell = bot.blockAt(colB.position.offset(bx, 0, bz));
              if (cell && cell.name !== "air") continue;
              try {
                await pt(bot.equip(s, "hand"), 6000, "equip");
                await pt(bot.placeBlock(colB, new Vec3(bx, 0, bz)), 6000, "placeBlock");
              } catch {
                /* refused/occupied — skip this side */
              }
              await sleep(120);
            }
          }
          // wall+roof toward the nearest camper — a 3-high stack on one brim
          // cell, then a roof block on the top wall's inward face (lands
          // directly overhead at feet+2). Cover BOTH dominant axes: a mob
          // strafing off-axis keeps LOS through a single 1-wide wall
          const raiseWall = async (wx, wz) => {
            if (!wx && !wz) return false;
            const brim = bot.blockAt(bot.entity.position.floored().offset(wx, -1, wz));
            if (!brim || brim.name === "air") return false;
            let wall = brim;
            for (let w = 0; w < 3; w++) {
              const s = refugeSolid();
              if (!s) break;
              try {
                await pt(bot.equip(s, "hand"), 6000, "equip");
                await pt(bot.placeBlock(wall, new Vec3(0, 1, 0)), 6000, "placeBlock");
                wall = bot.blockAt(wall.position.offset(0, 1, 0));
              } catch {
                break;
              }
              await sleep(120);
            }
            if (wall && wall.position.y >= bot.entity.position.floored().y + 2) {
              const s = refugeSolid();
              if (s) {
                try {
                  await pt(bot.equip(s, "hand"), 6000, "equip");
                  await pt(bot.placeBlock(wall, new Vec3(-wx, 0, -wz)), 6000, "placeBlock");
                } catch {
                  /* roof refused — wall alone still blocks arrows */
                }
              }
              return true;
            }
            return false;
          };
          const wallDirs = (h) => {
            const ddx = Math.sign(h.position.x - bot.entity.position.x);
            const ddz = Math.sign(h.position.z - bot.entity.position.z);
            const axes = [];
            if (Math.abs(h.position.x - bot.entity.position.x) >=
                Math.abs(h.position.z - bot.entity.position.z) * 0.5 && ddx) axes.push([ddx, 0]);
            if (Math.abs(h.position.z - bot.entity.position.z) >=
                Math.abs(h.position.x - bot.entity.position.x) * 0.5 && ddz) axes.push([0, ddz]);
            return axes;
          };
          const walled = new Set();
          const wallToward = async (h) => {
            for (const [wx, wz] of wallDirs(h)) {
              const key = `${wx},${wz}`;
              if (walled.has(key)) continue;
              if (await raiseWall(wx, wz)) {
                walled.add(key);
                log?.("[burrow] refuge wall +roof up");
              }
            }
          };
          const h = findHostile(bot, 40);
          if (h) await wallToward(h);
        } catch {
          /* refuge dressing failed — the pillar itself still stands */
        }
        // a shooter that strafes or wanders in later beats the reactive
        // single-axis wall — with any ranged mob in the area, wall ALL four
        // axes up front so no angle stays open while they close
        try {
          const anyRanged = Object.values(bot.entities || {}).some((e) => {
            if (!e?.position || e === bot.entity) return false;
            const n = String(e.name || "").toLowerCase();
            return (e.kind === "Hostile mobs" && e.name !== "enderman" || /skeleton|stray|pillager|witch|drowned|blaze|ghast/.test(n)) &&
              /skeleton|stray|pillager|witch|drowned|blaze|ghast/.test(n) &&
              e.position.distanceTo(bot.entity.position) < 40;
          });
          if (anyRanged) {
            for (const [wx, wz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              if (walled.has(`${wx},${wz}`)) continue;
              if (await raiseWall(wx, wz)) {
                walled.add(`${wx},${wz}`);
                log?.("[burrow] refuge ring wall up");
              }
            }
          }
        } catch {
          /* ring build best-effort — walls raised so far still cover */
        }
        const t0 = Date.now();
        let lastBeat = 0;
        while (!safe() && Date.now() - t0 < 620000) {
          if (state?._diedAt && Date.now() - state._diedAt < 6000) {
            log?.("[burrow] died on the pillar — aborting shelter");
            return false;
          }
          // a ranged mob that arrives (or strafes onto an unwalled axis)
          // mid-wait still shoots through — extend the wall toward it
          const shooter = Object.values(bot.entities || {})
            .filter((e) => {
              if (!e?.position || e === bot.entity) return false;
              const n = String(e.name || "").toLowerCase();
              return /skeleton|stray|pillager|witch|drowned|blaze/.test(n) &&
                e.position.distanceTo(bot.entity.position) < 26;
            })
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
          if (shooter) {
            try {
              await wallToward(shooter);
            } catch {
              /* wall extension best-effort */
            }
          }
          if (Date.now() - lastBeat > 90000) {
            lastBeat = Date.now();
            log?.(`[burrow] on pillar — ${Math.round((620000 - (Date.now() - t0)) / 60000)}min to dawn`);
          }
          await sleep(4000);
        }
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
      } finally {
        bot._inShelter = false;
      }
      // same blind-surface kill as the pocket exit — a camper waiting at the
      // pillar base hits before the reflex reparks; sprint away first
      try {
        const waiter = Object.values(bot.entities || {})
          .filter((e) => {
            if (!e?.position || e === bot.entity) return false;
            const n = String(e.name || "").toLowerCase();
            return /zombie|creeper|spider|husk|vex|slime|skeleton|stray|pillager|drowned/.test(n);
          })
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (waiter && waiter.position.distanceTo(bot.entity.position) < 26) {
          const away = bot.entity.position.minus(waiter.position);
          const yaw = Math.atan2(-away.x, -away.z);
          log?.(`[burrow] exit sprint away from ${waiter.name}`);
          bot.setControlState("sprint", true);
          bot.setControlState("forward", true);
          bot.setControlState("jump", false);
          const t0 = Date.now();
          while (Date.now() - t0 < 2000) {
            bot.look(yaw, 0, true);
            await sleep(140);
          }
          bot.setControlState("forward", false);
          bot.setControlState("sprint", false);
        }
      } catch {
        /* exit sprint is best-effort */
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
    // digging a falling block (sand/gravel) just refills the cell from the
    // column above — every dig resets until timeout while mobs walk up
    if (/sand$|gravel|concrete_powder/.test(under.name)) break;
    // don't break a cave ceiling — landing cell must be solid ground
    if (!below || /air|lava|water|magma_block|bedrock/.test(below.name)) {
      log?.(`[burrow] cave below at dy=-2 — stopping on ceiling`);
      break;
    }
    // a falling block (gravel/sand) invalidates the dig target mid-swing —
    // "Digging aborted" — but the settled block at the same cell is a fine
    // target, so retry a few times before giving up on the shaft
    let d = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      d = await executeAction(
        bot,
        { type: "dig", x: under.position.x, y: under.position.y, z: under.position.z, timeoutMs: 10000 },
        mcData
      );
      if (d.ok || !/abort/i.test(String(d?.message || ""))) break;
      await sleep(250);
    }
    if (!d?.ok) {
      log?.(`[burrow] dig fail: ${d?.message}`);
      break;
    }
    dug += 1;
    // the dig resolves on block-break but the fall lands a physics tick
    // later — re-reading feet immediately sees the hole's air and breaks
    // the loop at dug=1. Wait for the landing (or the neighbouring-cell
    // catch) before evaluating the next block down.
    for (let w = 0; w < 10; w += 1) {
      await sleep(120);
      const f2 = bot.entity.position.floored();
      if (f2.y < feet.y) break; // fell into the dug cell
      const u2 = bot.blockAt(f2.offset(0, -1, 0));
      if (u2 && u2.name !== "air") break; // landed on neighbour ground
    }
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
  let pocketDeep = null;
  const sealWhy = {};
  const sealMiss = (why) => {
    sealWhy[why] = (sealWhy[why] || 0) + 1;
  };
  if (refreshSolid() && (dug >= 3 || !needsShaft)) {
    // GRAVE: a hostile already on top of us converges mid-carve — the full
    // pocket takes ~20-30s, capping the 3-deep shaft takes ~2s and a capped
    // 1x1 is unreachable (mobs don't dig). Only when the shaft dug fully
    // (head below the mouth cell), the cap material isn't a falling block,
    // and nothing is already inside the shaft with us.
    if (needsShaft && dug >= 3 && !sealedCells) {
      const urgent = findHostile(bot, 20);
      const mouthY = feet.y + dug - 1;
      const mouth = bot.blockAt(new Vec3(feet.x, mouthY, feet.z));
      const capSolid = bot.inventory
        .items()
        .find(
          (i) =>
            isCube(i) &&
            !SEAL_BAD.test(i.name) &&
            !/sand$|gravel|concrete_powder|anvil|scaffold|snow$|snow_layer|tnt|red_sand/.test(i.name)
        );
      const shaftMate = Object.values(bot.entities || {}).find((e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || e.displayName || "").toLowerCase();
        if (
          !(
            (e.kind === "Hostile mobs" && e.name !== "enderman") ||
            /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n)
          )
        )
          return false;
        return (
          Math.abs(e.position.x - (feet.x + 0.5)) < 1.3 &&
          Math.abs(e.position.z - (feet.z + 0.5)) < 1.3 &&
          e.position.y > feet.y - 0.5 &&
          e.position.y < mouthY + 1.5
        );
      });
      if (urgent && capSolid && mouth && mouth.name === "air" && !shaftMate) {
        // bank climb-out material first: cap costs 1 and the pillar-up exit
        // needs ~dug solids — a naked bot only got ~dug drops from the shaft.
        // Dig head-level side cells into the shaft for the shortfall.
        const cubes = () => bot.inventory.items().reduce((n, i) => n + (isCube(i) ? i.count : 0), 0);
        for (let m = 0; m < dug + 2 - cubes() && m < 6; m += 1) {
          const [mx, mz] = [[1, 0], [-1, 0], [0, 1], [0, -1]][m % 4];
          const mat = bot.blockAt(new Vec3(feet.x + mx, feet.y + 1, feet.z + mz));
          if (!mat || !diggable(mat)) continue;
          const md = await executeAction(
            bot,
            { type: "dig", x: mat.position.x, y: mat.position.y, z: mat.position.z, timeoutMs: 8000 },
            mcData
          );
          if (!md.ok) continue;
          await sleep(200);
        }
        // place the cap through a shaft wall at mouth level — each face name
        // selects the adjacent wall on the opposite side (west → wall at +x)
        for (const [wx, wz, face] of [
          [1, 0, "west"],
          [-1, 0, "east"],
          [0, 1, "north"],
          [0, -1, "south"],
        ]) {
          const wall = bot.blockAt(new Vec3(feet.x + wx, mouthY, feet.z + wz));
          if (!wall || danger(wall)) continue;
          const cap = await executeAction(
            bot,
            { type: "place", item: capSolid.name, x: feet.x, y: mouthY, z: feet.z, face, timeoutMs: 8000 },
            mcData
          );
          if (cap.ok) {
            sealedCells = [{ x: feet.x, y: mouthY, z: feet.z }];
            pocketDeep = { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
            log?.(`[burrow] capped shaft — grave (${urgent.name}@${Math.round(urgent.position.distanceTo(bot.entity.position))}m)`);
            break;
          }
          sealMiss(`cap: ${String(cap.message || "").slice(0, 40)}`);
        }
      }
    }
    // pocket depth: a mob pressed against the single doorway wall reaches
    // ~3m — a 2-deep pocket leaves the bot in melee range. 4-deep puts it
    // out of reach; shallower pockets are carved only as a fallback
    for (const [px, pz] of sealedCells ? [] : [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let carvedDepth = 0;
      for (const depth of [4, 3, 2]) {
        const cells = [];
        for (let i = 1; i <= depth; i += 1) {
          cells.push(bot.blockAt(feet.offset(px * i, 0, pz * i)));
          cells.push(bot.blockAt(feet.offset(px * i, 1, pz * i)));
        }
        // every pocket cell must be a diggable solid — an air cell means a
        // cave pocket, and a cave means mobs
        if (cells.some((c) => !diggable(c))) {
          sealMiss("undiggable");
          continue;
        }
        const doorwayFloor = bot.blockAt(feet.offset(px, -1, pz));
        const doorwayCell = bot.blockAt(feet.offset(px, 0, pz));
        // water in the doorway can't take a plug — the place gets refused
        // and water keeps flowing into the pocket anyway
        if (doorwayCell && /water|lava/.test(doorwayCell.name)) {
          sealMiss("doorway-fluid");
          continue;
        }
        const farFloor = bot.blockAt(feet.offset(px * depth, -1, pz * depth));
        if (!doorwayFloor || doorwayFloor.name === "air") {
          sealMiss("doorway-floor-air");
          continue;
        }
        if (!farFloor || /air|lava|water|bedrock|magma_block/.test(farFloor.name)) {
          sealMiss("far-floor-open");
          continue;
        }
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
        if (!carved) {
          sealMiss("dig-fail");
          continue;
        }
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
      if (!step.ok) {
        sealMiss("step-in-fail");
        continue;
      }
      // never seal a hostile inside the pocket with us — check the corridor
      // (a mob walled into a 1x2 burrow kills us point-blank before dawn)
      const inside = Object.values(bot.entities || {}).some((e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || e.displayName || "").toLowerCase();
        if (
          !(
            e.kind === "Hostile mobs" && e.name !== "enderman" ||
            /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n)
          )
        )
          return false;
        const ex = e.position.x - feet.x;
        const ez = e.position.z - feet.z;
        const fwd = px * ex + pz * ez;
        const lat = Math.abs(px * ez - pz * ex);
        return fwd >= -0.5 && fwd < carvedDepth + 3 && lat < 1.5;
      });
      if (inside) {
        const armed3 = bot.inventory.items().some((i) => /sword|_axe/.test(i.name));
        if (armed3) {
          const t = findHostile(bot, 6);
          if (t) {
            try {
              await pt(bot.attack(t), 8000, "attack");
            } catch {
              /* swung and missed — next pocket dir may be clean anyway */
            }
          }
          sealMiss("mob-inside");
          continue;
        }
        sealMiss("mob-inside");
        continue; // bare hands — this pocket is a coffin, try the next dir
      }
      // wall the doorway: feet cell via floor ref, head cell via the new block
      const p1 = await executeAction(
        bot,
        { type: "place", item: solid.name, x: feet.x + px, y: feet.y, z: feet.z + pz, face: "top", timeoutMs: 8000 },
        mcData
      );
      if (!p1.ok) {
        sealMiss(`place1: ${String(p1.message || "").slice(0, 40)}`);
        continue;
      }
      // place1 resolves on the client echo — the head plug fires against a
      // reference block the server may not have confirmed yet. Give it a beat
      // so place2's face sees the new wall block, not stale air
      await sleep(180);
      const p2 = await executeAction(
        bot,
        { type: "place", item: solid.name, x: feet.x + px, y: feet.y + 1, z: feet.z + pz, face: "top", timeoutMs: 8000 },
        mcData
      );
      if (!p2.ok) {
        sealMiss(`place2: ${String(p2.message || "").slice(0, 40)}`);
        continue;
      }
      sealedCells = [
        { x: feet.x + px, y: feet.y, z: feet.z + pz },
        { x: feet.x + px, y: feet.y + 1, z: feet.z + pz },
      ];
      // a mob chasing in DURING the carve gets sealed inside with us — the
      // pre-seal check ran before the plug went up. Recheck now: fight it if
      // armed, otherwise break back out — a sealed-in mob is a coffin
      const intruder = Object.values(bot.entities || {}).find((e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || e.displayName || "").toLowerCase();
        if (
          !(
            e.kind === "Hostile mobs" && e.name !== "enderman" ||
            /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n)
          )
        )
          return false;
        const ex = e.position.x - feet.x;
        const ez = e.position.z - feet.z;
        const fwd = px * ex + pz * ez;
        const lat = Math.abs(px * ez - pz * ex);
        return fwd >= -0.5 && fwd < carvedDepth + 3 && lat < 1.5;
      });
      if (intruder) {
        const wpn = bot.inventory.items().find((i) => /sword|_axe/.test(i.name));
        let killed = false;
        if (wpn) {
          try {
            await pt(bot.equip(wpn, "hand"), 5000, "eq");
            for (let s = 0; s < 8 && bot.entities[intruder.id]; s += 1) {
              await pt(bot.attack(bot.entities[intruder.id]), 5000, "atk");
              await sleep(350);
            }
            killed = !bot.entities[intruder.id];
          } catch {
            killed = false;
          }
        }
        if (!killed) {
          // couldn't finish it — open the plug back up and abandon the pocket
          for (const c of sealedCells) {
            await executeAction(bot, { type: "dig", x: c.x, y: c.y, z: c.z, timeoutMs: 8000 }, mcData).catch(() => {});
          }
          sealedCells = null;
          sealMiss("mob-sealed-in");
          continue;
        }
      }
      // far end of the pocket — the wait loop re-pins the bot here so it
      // never drifts into melee reach of the doorway plug
      pocketDeep = { x: feet.x + px * carvedDepth + 0.5, y: feet.y, z: feet.z + pz * carvedDepth + 0.5 };
      // depth-3 fallback pockets still sit inside melee reach of a mob
      // hugging the plug (~3m) — deepen from inside once sealed. Digging
      // further straight ahead is safe: sealed in, worst case the cells are
      // undiggable and the pocket stays shallow.
      if (carvedDepth < 4) {
        let ext = carvedDepth;
        while (ext < 5) {
          const nxt = [
            bot.blockAt(feet.offset(px * (ext + 1), 0, pz * (ext + 1))),
            bot.blockAt(feet.offset(px * (ext + 1), 1, pz * (ext + 1))),
          ];
          if (nxt.some((c) => !diggable(c))) break;
          let okAll = true;
          for (const c of nxt) {
            const d = await executeAction(
              bot,
              { type: "dig", x: c.position.x, y: c.position.y, z: c.position.z, timeoutMs: 10000 },
              mcData
            );
            if (!d.ok) {
              okAll = false;
              break;
            }
          }
          if (!okAll) break;
          ext += 1;
        }
        if (ext > carvedDepth) {
          pocketDeep = { x: feet.x + px * ext + 0.5, y: feet.y, z: feet.z + pz * ext + 0.5 };
          log?.(`[burrow] pocket deepened ${carvedDepth}→${ext}`);
        }
      }
      log?.(`[burrow] sealed pocket ${px},${pz} depth=${carvedDepth}`);
      break;
    }
    if (!sealedCells) {
      const why = Object.entries(sealWhy)
        .map(([k, n]) => `${k}x${n}`)
        .join(",");
      log?.(`[burrow] no seal${why ? ` (${why})` : ""}${!solid ? " — no blocks" : ""}`);
      return retryElsewhere("no seal");
    }
  }
  // sealed in: hostiles outside the wall are unreachable — the reflex
  // seeing them anyway just pathfinds against the seal (and a creeper at
  // the wall blowing up means fighting was already lost). Park it.
  bot._inShelter = true;
  try {
    const t0 = Date.now();
    // daytime hide (force): skeletons/zombies burn in ~30-60s — 90s covers
    // it. A non-burning camper (creeper/spider) keeps safe() false for the
    // whole day otherwise, turning one mob into a 570s sit-out; the caller
    // sprints out instead
    const waitCap = force ? 150000 : 570000;
    // exit needs the day to HOLD: one good read then back to night/hostile
    // is the tod flap that unsealed the bot into a creeper — two consecutive
    // safe reads (each loop is ~4-16s) means the day is real
    let safeStreak = 0;
    while (Date.now() - t0 < waitCap) {
      if (safe()) {
        safeStreak += 1;
        if (safeStreak >= 2) break;
      } else {
        safeStreak = 0;
      }
    // died inside the pocket and respawned somewhere else — the shelter is
    // gone with the corpse; abort so the runner can flee/re-gear instead of
    // standing naked on open ground for the rest of the night
    if (state?._diedAt && Date.now() - state._diedAt < 6000) {
      log?.("[burrow] died mid-wait — aborting shelter");
      return false;
    }
    await sleep(4000);
    // vanilla melee reaches through a 1-block face when the target hugs it —
    // a mob standing on the plug hits a bot pressed at the doorway. Keep the
    // bot pinned at the pocket's far end for the whole wait
    if (pocketDeep) {
      const away = bot.entity.position.distanceTo(
        new Vec3(pocketDeep.x, pocketDeep.y, pocketDeep.z)
      );
      if (away > 1.2) {
        await executeAction(
          bot,
          { type: "goto", x: pocketDeep.x, y: pocketDeep.y, z: pocketDeep.z, range: 0.4, timeoutMs: 6000 },
          mcData
        ).catch(() => {});
      }
    }
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
  // campers re-close during the ~15s climb-out — hold the pocket until the
  // mouth is clear (or ~2min passes) before breaking the seal
  const tHold = Date.now();
  while (findHostile(bot, 10) && Date.now() - tHold < (force ? 30000 : 120000)) {
    if (state?._diedAt && Date.now() - state._diedAt < 6000) return false;
    const camper = findHostile(bot, 5);
    const armed2 = bot.inventory.items().some((i) => /sword|_axe/.test(i.name));
    if (camper && armed2) {
      try {
        await pt(bot.attack(camper), 6000, "attack");
      } catch {
        /* out of reach — keep waiting */
      }
    }
    await sleep(3000);
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
  } finally {
    bot._inShelter = false;
  }
  // surface straight into a camper is the recurring exit death — sprint a
  // short separation burst away from any hostile already in melee range
  try {
    // sprint away on EVERY exit, and keep sprinting while any hostile is
    // within bow range (50m) — a camper at ~35m lands arrows 6s after a
    // short burst ends, so the sprint only ends on real separation
    const hostileNear = () =>
      Object.values(bot.entities || {}).some((e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || "").toLowerCase();
        return (
          /zombie|creeper|spider|husk|vex|slime|skeleton|stray|pillager|drowned/.test(n) &&
          e.position.distanceTo(bot.entity.position) < 50
        );
      });
    const nearest = () =>
      Object.values(bot.entities || {})
        .filter((e) => {
          if (!e?.position || e === bot.entity) return false;
          const n = String(e.name || "").toLowerCase();
          return /zombie|creeper|spider|husk|vex|slime|skeleton|stray|pillager|drowned/.test(n);
        })
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    bot.setControlState("sprint", true);
    bot.setControlState("forward", true);
    bot.setControlState("jump", false);
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      const w = nearest();
      let yaw = bot.entity.yaw;
      if (w) {
        const away = bot.entity.position.minus(w.position);
        yaw = Math.atan2(-away.x, -away.z);
      }
      bot.look(yaw, 0, true);
      await sleep(140);
      if (Date.now() - t0 > 2500 && !hostileNear()) break;
    }
    bot.setControlState("forward", false);
    bot.setControlState("sprint", false);
  } catch {
    /* exit sprint is best-effort */
  }
  log?.("[burrow] dawn — back out");
  return true;
}

// Food management: starvation is what actually kills the marathon run —
// at foodLevel 0 the bot can't sprint and sits at ~0.5hp where any damage
// is fatal. Eat carried food first; when empty, hunt farm animals and eat
// the drops raw (safe raw: beef/pork/mutton/rabbit/cod/salmon — raw
// chicken's hunger effect makes it a last resort).
const EDIBLE_FOOD =
  /cooked|beef|pork|bread|apple|carrot|potato|baked|cod|salmon|cookie|melon|pie|stew|soup|berries|mutton|rabbit(?!_foot|_hide)|beetroot(?!_seeds)|dried_kelp|honey_bottle|chorus_fruit/;
const SAFE_RAW = /beef|porkchop|mutton|^rabbit$|raw_rabbit|cod|salmon/;

function stockFoodCount(bot) {
  return bot.inventory
    .items()
    .reduce((n, i) => n + (EDIBLE_FOOD.test(i.name) || SAFE_RAW.test(i.name) || i.name === "rotten_flesh" ? i.count : 0), 0);
}

// bank carried food for a descent: hunts prey but KEEPS the drops instead
// of topping the meter — the strip mine at y<=16 offers no food for ~10+
// min, and descending empty-handed is how the underground starving loop starts
async function stockFood(bot, mcData, state, log, want = 6) {
  const carried = () => stockFoodCount(bot);
  // free calories first: an edible drop on the ground costs a walk, not a chase
  const drop = droppedItemEntity(bot, mcData, [
    "rotten_flesh", "beef", "porkchop", "mutton", "rabbit",
    "bread", "potato", "carrot", "apple",
  ]);
  if (drop && drop.position.distanceTo(bot.entity.position) <= 12) {
    await executeAction(
      bot,
      { type: "goto", x: Math.floor(drop.position.x), y: Math.floor(drop.position.y), z: Math.floor(drop.position.z), range: 1, timeoutMs: 10000 },
      mcData
    ).catch(() => ({ ok: false }));
  }
  // raw chicken carries the hunger effect and isn't counted edible — skip it
  for (const prey of ["cow", "pig", "sheep", "rabbit"]) {
    for (let i = 0; i < 2 && carried() < want; i++) {
      const r = await executeAction(
        bot,
        { type: "attack", name: prey, maxDurationMs: 14000, maxDistance: 48 },
        mcData
      ).catch(() => ({ ok: false }));
      if (!r.ok) break;
      await sleep(400);
    }
  }
  return { ok: carried() >= want, stocked: carried() };
}

export async function ensureFed(bot, mcData, log, state = null) {
  if (bot.food == null || bot.food >= 14) return { ok: true, ate: false };
  let ate = false;
  // eat whatever's edible, preferring cooked/carried food
  for (let i = 0; i < 6 && bot.food < 19; i++) {
    const f =
      bot.inventory.items().find((i) => EDIBLE_FOOD.test(i.name)) ||
      bot.inventory.items().find((i) => SAFE_RAW.test(i.name)) ||
      (bot.food <= 8 ? bot.inventory.items().find((i) => /chicken/.test(i.name)) : null);
    if (!f) break;
    const r = await executeAction(bot, { type: "eat", item: f.name, timeoutMs: 12000 }, mcData).catch((e) => ({
      ok: false,
      message: e?.message || String(e),
    }));
    if (r.ok) {
      ate = true;
      log?.(`[food] ate ${f.name} (food=${bot.food})`);
    } else break;
  }
  if (bot.food >= 10) return { ok: true, ate };
  // Cook raw meat before hunting for more: a raw porkchop is 3 food, cooked
  // is 8 — with a furnace and any fuel, smelting what's in hand triples the
  // yield and beats another chase. Any furnace-type block counts (the iron
  // phase carries one), any burnable item fuels it.
  try {
    const raw = bot.inventory.items().find((i) => /^(beef|porkchop|mutton|rabbit|chicken|cod|salmon|potato)$/.test(i.name));
    let furnaceBlock = null;
    try {
      furnaceBlock = bot.findBlock?.({ matching: (b) => b?.name === "furnace", maxDistance: 24 });
    } catch {
      /* keep null */
    }
    if (!furnaceBlock && bot.inventory.items().some((i) => i.name === "furnace")) {
      const feet0 = bot.entity.position.floored();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cell = bot.blockAt(feet0.offset(dx, 0, dz));
        const under = bot.blockAt(feet0.offset(dx, -1, dz));
        if (!cell || cell.name !== "air" || !under || under.name === "air") continue;
        const pl = await executeAction(
          bot,
          { type: "place", item: "furnace", x: cell.position.x, y: cell.position.y, z: cell.position.z, timeoutMs: 8000 },
          mcData
        ).catch(() => ({ ok: false }));
        if (pl.ok) break;
      }
    }
    const fuel = bot.inventory.items().find((i) => /coal|charcoal|_log$|_planks$|stick|blaze_rod|lava_bucket/.test(i.name));
    if (raw && fuel && bot.food < 10) {
      const sm = await executeAction(
        bot,
        { type: "smelt", item: raw.name, fuel: fuel.name, count: Math.min(raw.count, 4), timeoutMs: 30000 },
        mcData
      ).catch(() => ({ ok: false }));
      if (sm.ok) log?.(`[food] cooked ${raw.name}`);
      // eat the freshly cooked batch
      for (let i = 0; i < 4 && bot.food < 19; i++) {
        const f = bot.inventory.items().find((i) => EDIBLE_FOOD.test(i.name));
        if (!f) break;
        const r = await executeAction(bot, { type: "eat", item: f.name, timeoutMs: 12000 }, mcData).catch(() => ({ ok: false }));
        if (r.ok) {
          ate = true;
          log?.(`[food] ate ${f.name} (food=${bot.food})`);
        } else break;
      }
      if (bot.food >= 10) return { ok: true, ate };
    }
  } catch {
    /* cook is best-effort — fall through to the hunt */
  }
  // hunt: chase down farm animals within 48 — each kill ~1-3 raw meat.
  // Zombies count when starving: rotten_flesh restores 4 food (the 30%
  // hunger-effect risk beats guaranteed starvation at food=0). But at
  // one-hit hp, meleeing a zombie barehanded is suicide — animals don't
  // fight back, so at hp<=4 only prey that can't retaliate counts.
  const starving = bot.food <= 4;
  const fragile = (bot.health ?? 20) <= 4;
  // dawn cleanup: burned zombies leave rotten_flesh on the ground — free
  // calories with zero melee risk, grab any edible drop lying within 12m
  const drop = droppedItemEntity(bot, mcData, [
    "rotten_flesh", "beef", "porkchop", "mutton", "chicken", "rabbit",
    "bread", "potato", "carrot", "apple", "cooked_beef", "cooked_porkchop",
    "cooked_mutton", "cooked_chicken", "baked_potato",
  ]);
  if (drop && drop.position.distanceTo(bot.entity.position) <= 12) {
    await executeAction(
      bot,
      { type: "goto", x: Math.floor(drop.position.x), y: Math.floor(drop.position.y), z: Math.floor(drop.position.z), range: 1, timeoutMs: 10000 },
      mcData
    ).catch(() => ({ ok: false }));
    const got = bot.inventory.items().find((i) => EDIBLE_FOOD.test(i.name) || SAFE_RAW.test(i.name) || i.name === "rotten_flesh");
    if (got && bot.food < 19) {
      const e = await executeAction(bot, { type: "eat", item: got.name, timeoutMs: 12000 }, mcData).catch(() => ({ ok: false }));
      if (e.ok) {
        ate = true;
        log?.(`[food] scavenged ${got.name} (food=${bot.food})`);
      }
    }
    if (bot.food >= 10) return { ok: true, ate };
  }
  const preyList = starving && !fragile ? ["cow", "pig", "sheep", "rabbit", "chicken", "zombie"] : ["cow", "pig", "sheep", "rabbit", "chicken"];
  for (const prey of preyList) {
    if (bot.food >= 12) break;
    for (let i = 0; i < 3 && bot.food < 12; i++) {
      const r = await executeAction(
        bot,
        { type: "attack", name: prey, maxDurationMs: 14000, maxDistance: 48 },
        mcData
      ).catch(() => ({ ok: false }));
      if (!r.ok) break;
      await sleep(400);
      const got = bot.inventory
        .items()
        .find((i) => SAFE_RAW.test(i.name) || EDIBLE_FOOD.test(i.name) || (starving && i.name === "rotten_flesh"));
      if (got && bot.food < 19) {
        const e = await executeAction(bot, { type: "eat", item: got.name, timeoutMs: 12000 }, mcData).catch(() => ({
          ok: false,
        }));
        if (e.ok) ate = true;
      }
    }
  }
  // nothing edible in range — starve-walk: animals render within a few
  // chunks, so keep moving along one heading until something spawns.
  // Underground it can only time out — no animals spawn below ground, and a
  // wander goto just crashes into rock; keep working hungry instead.
  const canSeeSky = (() => {
    try {
      const feet = bot.entity.position.floored();
      for (let dy = 0; dy < 3; dy++) {
        const b = bot.blockAt(feet.offset(0, dy, 0));
        if (b && (b.skyLight ?? 0) > 4) return true;
      }
    } catch {
      /* unknown — assume indoor */
    }
    return bot.entity.position.y > 58;
  })();
  if (bot.food <= 4 && state && canSeeSky) {
    const p = bot.entity.position.floored();
    if (!state.foodWanderDir) {
      state.foodWanderDir = pickDryDir(bot, [
        [60, 0],
        [-60, 0],
        [0, 60],
        [0, -60],
      ]);
      state.foodWanderLeg = 0;
    }
    // same expanding square spiral as the log wander — a fixed heading can
    // starve-walk a biome strip away from every herd
    if (state.foodWanderLeg > 0) {
      const a = Math.atan2(state.foodWanderDir[1], state.foodWanderDir[0]) + Math.PI / 2;
      state.foodWanderDir = [Math.round(Math.cos(a)) * 60, Math.round(Math.sin(a)) * 60];
    }
    state.foodWanderLeg = (state.foodWanderLeg || 0) + 1;
    const hop = Math.min(60 + Math.floor((state.foodWanderLeg - 1) / 4) * 40, 200);
    await executeAction(
      bot,
      {
        type: "goto",
        x: p.x + Math.sign(state.foodWanderDir[0]) * hop,
        y: p.y,
        z: p.z + Math.sign(state.foodWanderDir[1]) * hop,
        range: 8,
        timeoutMs: 20000,
      },
      mcData
    ).catch(() => {
      state.foodWanderDir = null;
    });
    return { ok: true, ate, message: "starve-walk" };
  }
  // starving underground: nothing edible spawns below the surface — climb
  // back up the stair toward daylight where animals/hunts actually exist,
  // instead of grinding on at 0.5hp until something touches us
  if (bot.food <= 4 && !canSeeSky && state && Date.now() - (state.foodClimbFailAt || 0) > 300000) {
    const p0 = bot.entity.position.floored();
    log?.(`[food] starving underground — staircasing for surface (y=${Math.floor(bot.entity.position.y)})`);
    const up = await stairwayUp(bot, mcData, 14, log);
    if (up.ok || bot.entity.position.y > p0.y + 4) return { ok: true, ate, message: "ascend for food" };
    // staircase can't route from a sealed pocket — dig a straight 1x1 shaft:
    // every target is adjacent so pathfinding isn't needed, and the overhead
    // hazard scan keeps lava/water/gravel off our 1hp head
    log?.(`[food] staircase stuck — shaft straight up (y=${Math.floor(bot.entity.position.y)})`);
    const sh = await shaftUp(bot, mcData, 56, log);
    if (sh.ok || bot.entity.position.y > p0.y + 4) return { ok: true, ate, message: "shaft for food" };
    state.foodClimbFailAt = Date.now();
  }
  if (state) state.foodWanderDir = null;
  return { ok: bot.food > 4, ate };
}

// Bed-first night survival: a placed bed + sleep skips the whole night in
// seconds instead of ~9 minutes sealed in a pocket. Order: sleep in a bed
// already placed → craft one from hunted wool + planks → caller falls back
// to burrowing. Kills the respawn-at-night death spiral on open terrain.
export async function ensureBedAndSleep(bot, mcData, log, state = null) {
  const tod = bot.time?.timeOfDay;
  // Not night: still worth claiming the spawn point — a placed+activated bed
  // moves every future respawn here and ends the world-spawn death camp.
  const dayClaimOnly = tod != null && tod < 12541;
  const woolCount = () => countItem(bot, (i) => /(?:^|_)wool$/.test(i.name));
  const bedItem = () =>
    bot.inventory.items().find((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name));
  const bedBlock = () =>
    bot.findBlock({
      matching: (b) => b && (bot.isABed?.(b) || b.name.endsWith("_bed")),
      maxDistance: 12,
    });

  if (!bedBlock()) {
    if (!bedItem()) {
      // hunt sheep until 3 wool — fists work, a few hits each. persistent:
      // a sheep sprints when hit and the default 36m leash ends every chase
      // with zero wool — hold the same target until it's dead or truly gone
      for (let i = 0; i < 5 && woolCount() < 3; i++) {
        const r = await executeAction(
          bot,
          { type: "attack", name: "sheep", maxDurationMs: 25000, maxDistance: 64, persistent: true },
          mcData
        ).catch((e) => ({ ok: false, message: e?.message || String(e) }));
        if (!r.ok) {
          log?.(`[bed] sheep attack #${i}: ${r.message}`);
          break; // no sheep in range — give up early
        }
        log?.(`[bed] sheep down — wool=${woolCount()}`);
        // the kill lands but the wool item just sits there — a dropped item
        // is an entity, not a block, so collect() can't see it. Walk over it
        const drop = Object.values(bot.entities || {}).find(
          (e) =>
            e?.position &&
            e !== bot.entity &&
            (e.item ? /wool/.test(String(e.item.name || "")) : /wool|item/.test(String(e.name || ""))) &&
            e.position.distanceTo(bot.entity.position) < 14
        );
        if (drop) {
          await executeAction(
            bot,
            { type: "goto", x: drop.position.x, y: drop.position.y, z: drop.position.z, range: 1, timeoutMs: 6000 },
            mcData
          ).catch(() => {});
        }
      }
      if (woolCount() >= 3) {
        if (countItem(bot, (i) => i.name.endsWith("_planks")) < 3 && countItem(bot, CRAFTABLE_LOG) > 0) {
          const logName =
            bot.inventory
              .items()
              .find((i) => CRAFTABLE_LOG(i))
              ?.name.replace("_log", "_planks") || "oak_planks";
          await ensureCraft(bot, mcData, logName, 4).catch(() => {});
        }
        if (countItem(bot, (i) => i.name.endsWith("_planks")) >= 3) {
          const wool =
            bot.inventory.items().find((i) => /wool$/.test(i.name) && i.count >= 3) ||
            bot.inventory.items().find((i) => /wool$/.test(i.name));
          const color = wool ? wool.name.replace("_wool", "") : "white";
          const t = await ensureTable(bot, mcData);
          if (t.ok) await ensureCraft(bot, mcData, `${color}_bed`, 1).catch(() => {});
        }
      }
    }
    const bi = bedItem();
    if (bi && !bedBlock()) {
      const p = bot.entity.position.floored();
      for (const [px, pz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [2, 0],
        [0, 2],
      ]) {
        const ground = bot.blockAt(p.offset(px, -1, pz));
        const spot = bot.blockAt(p.offset(px, 0, pz));
        const head = bot.blockAt(p.offset(px, 1, pz));
        if (ground && !/air|water|lava/.test(ground.name) && spot?.name === "air" && head?.name === "air") {
          const placed = await executeAction(
            bot,
            { type: "place", item: bi.name, x: p.x + px, y: p.y, z: p.z + pz, face: "top", timeoutMs: 8000 },
            mcData
          ).catch(() => ({ ok: false }));
          if (placed.ok) break;
        }
      }
    }
  }
  if (!bedBlock()) return { ok: false, message: "no bed" };
  // Claim the spawn point: right-clicking a bed sets respawn even in
  // daylight ("You can sleep only at night" still sets the point). Every
  // later death then lands at the bed instead of the camped world-spawn.
  const bb = bedBlock();
  try {
    await pt(Promise.resolve(bot.activateBlock(bb)), 6000, "activate bed");
    log?.(`[bed] spawn point claimed @${bb.position.x},${bb.position.y},${bb.position.z}`);
  } catch {
    /* claim is best-effort */
  }
  if (dayClaimOnly) return { ok: false, message: "bed placed — spawn claimed (day)" };
  // sleep — fails fast if monsters nearby (vanilla rule), caller burrows then
  const s = await executeAction(
    bot,
    { type: "sleep", maxDistance: 16, timeoutMs: 20000 },
    mcData
  ).catch((e) => ({ ok: false, message: e?.message || String(e) }));
  if (s.ok) {
    log?.("[bed] sleeping — skipping night");
    const t1 = Date.now();
    while ((bot.time?.timeOfDay ?? 0) >= 12541 && Date.now() - t1 < 60000) await sleep(1000);
    return { ok: true, message: "slept through the night" };
  }
  return { ok: false, message: s.message || "sleep failed" };
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
  const logCount = () => countItem(bot, CRAFTABLE_LOG);
  for (const b of logNames) {
    const before = logCount();
    const rr = await executeAction(bot, { type: "collect", block: b, count: 4, maxDistance: 32 }, mcData);
    // collect resolves ok even when it gathered nothing — a 0-gain 'ok'
    // must not early-return or the tree-less spot never triggers a wander
    if (rr.ok && logCount() > before) {
      // remember productive ground — a treeless streak walks back here
      if (state) logSiteRecord(bot.entity.position.floored(), bot, state);
      return rr;
    }
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
    maxDistance: 72,
  });
  if (!block) {
    // nothing in scan range — wander toward new ground instead of stalling.
    // Keep one heading and grow the leap each streak: a tree-poor basin
    // can span 200m+, and random 40m hops just ping-pong inside it.
    if (state) {
      state.noLogStreak = (state.noLogStreak || 0) + 1;
      if (state.noLogStreak >= 3) {
        const p = bot.entity.position.floored();
        // ground that produced logs before beats a blind heading
        if (await gotoLogSite(bot, mcData, state, p)) {
          state.noLogStreak = 1;
          return { ok: true, message: "back to log site" };
        }
        if (!state.wanderDir) {
          const dirs = [
            [60, 0],
            [-60, 0],
            [0, 60],
            [0, -60],
          ];
          state.wanderDir = pickDryDir(bot, dirs);
          state.wanderLeg = 0;
        }
        // a fixed heading can walk a treeless basin away from every forest —
        // rotate the heading a quarter-turn per hop and grow the radius each
        // revolution, an expanding square spiral covering all bearings
        if (state.wanderLeg > 0) {
          const a = Math.atan2(state.wanderDir[1], state.wanderDir[0]) + Math.PI / 2;
          state.wanderDir = [Math.round(Math.cos(a)) * 60, Math.round(Math.sin(a)) * 60];
        }
        state.wanderLeg = (state.wanderLeg || 0) + 1;
        const hop = Math.min(60 + Math.floor((state.wanderLeg - 1) / 4) * 40, 200);
        const wx = Math.sign(state.wanderDir[0]) * hop;
        const wz = Math.sign(state.wanderDir[1]) * hop;
        try {
          await executeAction(
            bot,
            { type: "goto", x: p.x + wx, y: p.y, z: p.z + wz, range: 5, timeoutMs: 25000 },
            mcData
          );
        } catch {
          /* wander blocked — try the next heading */
          state.wanderDir = null;
        }
        state.noLogStreak = 1;
        return { ok: true, message: `exploring for trees (${hop}m)` };
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

// walk to the nearest remembered productive log site — a plain that
// churned for 200m beats any blind heading. Sites already visited with
// zero gain are skipped (dead cells) so the same stump field is never
// re-walked — that was the gather(0)/no-log ping-pong.
async function gotoLogSite(bot, mcData, state, p) {
  const dead = state?.deadLogCells || {};
  const cellOf = (x, z) => `${Math.round(x / 32)},${Math.round(z / 32)}`;
  const site = (state?.logSites || [])
    .map((s) => ({ s, d: Math.hypot(s.x - p.x, s.z - p.z) }))
    .filter(
      (e) =>
        e.d > 30 &&
        e.d < 400 &&
        !dead[cellOf(e.s.x, e.s.z)] &&
        !(state?.campZone && Math.hypot(e.s.x - state.campZone.x, e.s.z - state.campZone.z) < 150)
    )
    .sort((a, b) => a.d - b.d)[0];
  if (!site) return false;
  if (state) state.lastSiteCell = cellOf(site.s.x, site.s.z);
  try {
    await executeAction(
      bot,
      { type: "goto", x: site.s.x, y: site.s.y, z: site.s.z, range: 6, timeoutMs: 40000 },
      mcData
    );
    return true;
  } catch {
    return false;
  }
}

async function phaseWood(bot, mcData, state, log) {
  const logs = countItem(bot, CRAFTABLE_LOG);
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
    const now = countItem(bot, CRAFTABLE_LOG);
    if (rr.ok && now <= logs) {
      // zero-gain streak: collect keeps resolving ok while grabbing nothing —
      // escalate a real wander after a few rounds or the run churns forever
      state.woodZeroGain = (state.woodZeroGain || 0) + 1;
      // a remembered site we were just walked to produced nothing — it is
      // chopped ground; mark the cell dead now instead of streak-waiting
      if (state && state.lastSiteCell) {
        (state.deadLogCells = state.deadLogCells || {})[state.lastSiteCell] = true;
        state.lastSiteCell = null;
      }
      // a dig/collect that "succeeded" but dropped nothing reachable leaves
      // the stump unmarked — badDig only counts path failures — so the
      // fallback re-picks the same dead trunk forever (gather(0)/no-log
      // ping-pong). Mark standing logs near us so the matcher drops them.
      try {
        state.badDig = state.badDig || new Map();
        const feet2 = bot.entity.position;
        const stumps = bot
          .findBlocks({
            matching: (b) => b && typeof b.name === "string" && b.name.endsWith("_log"),
            maxDistance: 24,
            count: 4,
          })
          .filter((pos) => pos.distanceTo(feet2) < 24);
        for (const pos of stumps) {
          const k = `${pos.x},${pos.y},${pos.z}`;
          state.badDig.set(k, (state.badDig.get(k) || 0) + 2);
        }
      } catch {}
      if (state.woodZeroGain >= 4) {
        state.woodZeroGain = 0;
        const p = bot.entity.position.floored();
        if (await gotoLogSite(bot, mcData, state, p)) {
          return { ok: true, phase: "wood", message: "zero-gain — back to log site" };
        }
        // a remembered-site scan came back empty — the local basin is cut out.
        // A random 80m hop just ping-pongs inside a ~200m dead zone: trek one
        // heading far enough to actually leave it, biased toward directions
        // with trees (the target) and away from water and camp rings.
        const dzFile = deathZonesLoadFile(bot) || { pts: [], camp: null };
        const campZones = [
          ...(state?._deathPts || []),
          state?.campZone,
          ...(dzFile.pts || []),
          dzFile.camp,
        ].filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.z));
        // nearest visible trunk wins over a sampled heading — direction
        // sampling only checks 3 points per axis and misses off-axis trees
        const nearTrunk = bot.findBlock({
          matching: (b) => {
            const bp = b?.position ?? b;
            if (!bp || !/(_log|_stem)$/.test(b?.name || "")) return false;
            return !state?.deadLogCells?.[`${Math.round(bp.x / 32)},${Math.round(bp.z / 32)}`];
          },
          maxDistance: 96,
        });
        if (nearTrunk) {
          const tp = nearTrunk.position ?? nearTrunk;
          const camped = campZones.some((c) => Math.hypot(c.x - tp.x, c.z - tp.z) < 120);
          if (!camped) {
            await executeAction(
              bot,
              { type: "goto", x: tp.x, y: tp.y, z: tp.z, range: 6, timeoutMs: 45000 },
              mcData
            ).catch(() => null);
            return { ok: true, phase: "wood", message: "zero-gain — to visible trunk" };
          }
        }
        let trek = null;
        let trekScore = -Infinity;
        for (const [dx, dz] of [
          [180, 0],
          [-180, 0],
          [0, 180],
          [0, -180],
          [128, 128],
          [-128, 128],
          [128, -128],
          [-128, -128],
        ]) {
          const sx = Math.sign(dx);
          const sz = Math.sign(dz);
          const tx = p.x + dx;
          const tz = p.z + dz;
          if (campZones.some((c) => Math.hypot(c.x - tx, c.z - tz) < 150)) continue;
          let trees = 0;
          let wet = false;
          for (const step of [10, 25, 40]) {
            const b = bot.blockAt(p.offset(sx * step, -1, sz * step));
            if (b && /_log$|_stem$|leaves$/.test(b.name)) trees += 1;
            const w = bot.blockAt(p.offset(sx * step, -1, sz * step));
            if (w && /water|kelp|ice|bubble/.test(w.name)) wet = true;
          }
          const score = trees * 3 - (wet ? 5 : 0) + Math.random();
          if (score > trekScore) {
            trekScore = score;
            trek = [dx, dz];
          }
        }
        if (!trek) trek = pickDryDir(bot, [[180, 0], [-180, 0], [0, 180], [0, -180]]);
        await executeAction(
          bot,
          { type: "goto", x: p.x + trek[0], y: p.y, z: p.z + trek[1], range: 6, timeoutMs: 45000 },
          mcData
        ).catch(() => null);
        return { ok: true, phase: "wood", message: "zero-gain — trekking for forest" };
      }
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
    if (countItem(bot, "stick") < 2) {
      const st = await ensureCraft(bot, mcData, "stick", 4);
      if (!st.ok && countItem(bot, "stick") < 2) {
        return { ok: false, phase: "wood", message: `sticks before pick: ${st.message}` };
      }
    }
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
      // never descend hungry: nothing edible spawns underground — eat/hunt at
      // the surface while there is still sky, or the whole mine runs at 0.5hp
      if (bot.food != null && bot.food < 10) {
        const fed = await ensureFed(bot, mcData, log, state);
        if (fed.ate) return { ok: true, phase: "iron", message: "pre-descend food" };
      }
      // never descend on an empty pack either: the meter refills above ground
      // but the ~10min strip mine drains it with nothing edible below — bank
      // ~6 raw meals while prey still renders, or the mine ends in the
      // starving-staircase loop at 0.5hp
      const foodStock = stockFoodCount(bot);
      if (foodStock < 6) {
        const sf = await stockFood(bot, mcData, state, log, 6);
        if (sf.stocked > foodStock) return { ok: true, phase: "iron", message: `pre-descend food stock (${sf.stocked})` };
      }
      // never descend wood-poor: at y≤16 there are no trees — sticks for iron
      // tools and table/table-fuel must come down with us
      const woodStock =
        countItem(bot, CRAFTABLE_LOG) + countItem(bot, (i) => i.name.endsWith("_planks"));
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
          } else {
            // no tree in reach — walk to a remembered log site instead of
            // no-oping here forever (the ok:true loop was the stuck=∞ bug)
            const pp = bot.entity.position.floored();
            const dead = state?.deadLogCells || {};
            const site = (state?.logSites || [])
              .map((s) => ({ s, d: Math.hypot(s.x - pp.x, s.z - pp.z) }))
              .filter((e) => e.d > 24 && e.d < 400 && !dead[`${Math.round(e.s.x / 32)},${Math.round(e.s.z / 32)}`])
              .sort((a, b) => a.d - b.d)[0]?.s;
            if (site) {
              const moved = await executeAction(
                bot,
                { type: "goto", x: site.x, y: site.y, z: site.z, range: 6, timeoutMs: 60000 },
                mcData
              ).then(() => true).catch(() => false);
              // an unreachable remembered site used to return ok:true each
              // ~2s — the "pre-descend wood (N)" stuck loop. Track fails and
              // demote the site so the next iteration walks the next one;
              // after 3 failed sites, fall through to the forest trek below.
              if (!moved && state) {
                state.siteGotoFails = state.siteGotoFails || new Map();
                const k = `${Math.round(site.x / 32)},${Math.round(site.z / 32)}`;
                state.siteGotoFails.set(k, (state.siteGotoFails.get(k) || 0) + 1);
                (state.deadLogCells = state.deadLogCells || {})[k] = true;
              }
            } else {
              // no site and nothing in scan: trek out of the basin — the same
              // deforested-band problem the wood-phase trek solves
              const tr = bot.findBlock({
                matching: (b) => b && /_log$|_stem$/.test(b.name || ""),
                maxDistance: 96,
              });
              const pp2 = bot.entity.position.floored();
              if (tr) {
                await executeAction(
                  bot,
                  { type: "goto", x: tr.position.x, y: tr.position.y, z: tr.position.z, range: 6, timeoutMs: 45000 },
                  mcData
                ).catch(() => null);
              } else {
                const tdir = pickDryDir(bot, [[180, 0], [-180, 0], [0, 180], [0, -180], [128, 128], [-128, -128]]);
                await executeAction(
                  bot,
                  { type: "goto", x: pp2.x + tdir[0], y: pp2.y, z: pp2.z + tdir[1], range: 6, timeoutMs: 45000 },
                  mcData
                ).catch(() => null);
              }
              return { ok: true, phase: "iron", message: `trek for wood (stock=${woodStock})` };
            }
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
          // lava/water blocking every direction — walk somewhere else and retry.
          // Repeated strikes mean a flooded/lava cavern, not a pocket: hop 14m
          // at first, then jump ~48m to leave the whole region behind
          state.fluidStrikes = (state.fluidStrikes || 0) + 1;
          const hop = state.fluidStrikes >= 3 ? 48 : 14;
          const p = bot.entity.position.floored();
          const dirs = [[hop, 0], [-hop, 0], [0, hop], [0, -hop]];
          const [wx, wz] = dirs[Math.floor(Math.random() * dirs.length)];
          await executeAction(
            bot,
            { type: "goto", x: p.x + wx, y: p.y, z: p.z + wz, range: 3, timeoutMs: 12000 },
            mcData
          ).catch(() => {});
          return { ok: true, phase: "iron", message: `descend stuck y=${y} ${s.message || ""} — relocating` };
        }
        state.fluidStrikes = 0;
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
      countItem(bot, CRAFTABLE_LOG) + countItem(bot, (i) => i.name.endsWith("_planks"));
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
      // a dry stretch keeps tunneling through plain stone forever — after 4
      // oreless strips shift ~24m sideways into a fresh vein field; iron is
      // vein-clustered so the same tunnel can stay barren for whole days
      if (state) {
        if (oreHits === 0 && gained === 0) state.stripDry = (state.stripDry || 0) + 1;
        else state.stripDry = 0;
        if (state.stripDry >= 4) {
          state.stripDry = 0;
          const p0 = bot.entity.position.floored();
          const dirs = [[24, 0], [-24, 0], [0, 24], [0, -24]];
          const [rx, rz] = dirs[Math.floor(Math.random() * dirs.length)];
          await executeAction(
            bot,
            { type: "goto", x: p0.x + rx, y: p0.y, z: p0.z + rz, range: 3, timeoutMs: 15000 },
            mcData
          ).catch(() => {});
          return { ok: true, phase: "iron", message: `strip dry — relocating ${rx},${rz} @y=${p0.y}` };
        }
      }
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
      // in a 1-wide tunnel every adjacent cell is solid rock — carve a
      // feet-level niche, then place the furnace into it
      if (!bot.findBlock({ matching: (b) => b?.name === "furnace", maxDistance: 8 })) {
        const feet2 = bot.entity.position.floored();
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const cell = bot.blockAt(feet2.offset(dx, 0, dz));
          const floor = bot.blockAt(feet2.offset(dx, -1, dz));
          if (
            cell &&
            !["air", "cave_air", "void_air"].includes(cell.name) &&
            diggableBlock(bot, cell) &&
            floor &&
            !["air", "cave_air", "void_air"].includes(floor.name)
          ) {
            await executeAction(bot, { type: "dig", x: cell.position.x, y: cell.position.y, z: cell.position.z }, mcData).catch(() => {});
            const now = bot.blockAt(feet2.offset(dx, 0, dz));
            if (now && ["air", "cave_air", "void_air"].includes(now.name)) {
              await executeAction(
                bot,
                { type: "place", item: "furnace", x: now.position.x, y: now.position.y, z: now.position.z, face: "top" },
                mcData
              ).catch(() => {});
              break;
            }
          }
        }
      }
    }

    // Fuel: pick the inventory stack with the most total burn energy and size
    // the batch to what that ONE stack can smelt — smeltItems only inserts a
    // single fuel stack, so a batch bigger than its capacity can never start.
    // Logs convert to planks first (1 log -> 4 planks at the same 1.5 rate).
    const capOf = (n) =>
      /lava_bucket$/.test(n) ? 100
      : /coal_block$/.test(n) ? 80
      : /^(coal|charcoal)$/.test(n) ? 8
      : /(_log|_wood|_planks)$/.test(n) ? 1.5
      : /stick$/.test(n) ? 0.5
      : 0;
    const bestFuel = () =>
      bot.inventory
        .items()
        .map((i) => ({ name: i.name, count: i.count, cap: capOf(i.name) }))
        .filter((x) => x.cap > 0)
        .sort((a, b) => b.cap * b.count - a.cap * a.count)[0] || null;
    let bf = bestFuel();
    if ((!bf || bf.cap * bf.count < 1) && countItem(bot, (i) => /(_log|_wood)$/.test(i.name)) > 0) {
      await ensurePlanks(bot, mcData, 8);
      bf = bestFuel();
    }
    if (!bf || bf.cap * bf.count < 1) {
      const coal = bot.findBlock({ matching: (b) => /^(coal_ore|deepslate_coal_ore)$/.test(b?.name || ""), maxDistance: 40 });
      if (coal) {
        const dg = await executeAction(
          bot,
          { type: "dig", x: coal.position.x, y: coal.position.y, z: coal.position.z, timeoutMs: 15000 },
          mcData
        ).catch(() => ({ ok: false }));
        return { ok: dg.ok, phase: "iron", message: `fuel run: coal ore ${dg.ok ? "dug" : "unreachable"}` };
      }
      const went = await gotoLogSite(bot, mcData, state, bot.entity.position.floored());
      if (went.ok) return { ok: true, phase: "iron", message: "fuel run: to log site" };
      return { ok: false, phase: "iron", message: "no fuel for smelt and no coal/log site known" };
    }
    const fuel = bf.name;
    const need = Math.min(8 - ingots, raw, 8, Math.max(1, Math.floor(bf.cap * bf.count)));
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
      if (cand.name === "lava") return { ok: false, message: "lava below", digs, y: feet.y };
      if (cand.name === "water") {
        // plug water pockets instead of relocating: place a solid into each
        // water cell bottom-up — every plug displaces one cell and becomes
        // the reference face for the one above it
        let floor = null;
        for (let sy = dy + 1; sy <= dy + 4; sy++) {
          const below = bot.blockAt(feet.offset(0, -sy, 0));
          if (!below || /^(air|cave_air|void_air)$/.test(below.name)) continue;
          if (below.name === "lava" || below.name === "bedrock") {
            return { ok: false, message: `${below.name} below`, digs, y: feet.y };
          }
          if (below.name === "water") continue;
          floor = sy;
          break;
        }
        if (floor == null) return { ok: false, message: "water column too deep", digs, y: feet.y };
        let plugged = 0;
        for (let wy = floor - 1; wy >= dy; wy--) {
          const wcell = bot.blockAt(feet.offset(0, -wy, 0));
          if (!wcell || wcell.name !== "water") continue;
          const solid = bot.inventory
            .items()
            .find(
              (i) =>
                mcData.blocksByName[i.name]?.boundingBox === "block" &&
                !/pickaxe|sword|_axe|shovel|_hoe|bucket|torch|sign|bed|chest|crafting|furnace|boat|ladder|door|slab|stairs|fence|wall|glass|pane|leaf|leaves|wool|carpet/.test(
                  i.name
                )
            );
          const refCell = bot.blockAt(feet.offset(0, -(wy + 1), 0));
          if (!solid || !refCell || refCell.name === "water" || /air/.test(refCell.name)) break;
          try {
            if (bot.heldItem?.name !== solid.name) await pt(bot.equip(solid, "hand"), 6000, "equip");
            await pt(bot.placeBlock(refCell, new Vec3(0, 1, 0)), 7000, "plug");
            plugged++;
            digs++;
            await sleep(250);
          } catch {
            break;
          }
        }
        if (plugged === 0) return { ok: false, message: "water below (unpluggable)", digs, y: feet.y };
        continue;
      }
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

// Staircase up through rock: for each step, clear the 3 cells above a
// notch in direction d (step floor at y, body at y+1, headroom y+2..3),
// place a floor if the step cell is hollow, then walk onto it. Rotates
// direction when a step is undiggable (lava/bedrock). Returns when sky
// appears or steps run out — the only way out of a sealed dead-end cave,
// where the pathfinder has no route.
// Vertical escape shaft: when stairwayUp can't route (sealed pocket where
// every stair target is beyond dig reach), mine straight up a 1x1 column —
// every dig is an adjacent cell so no pathfinding is needed. Scans 5 cells
// overhead for lava/water/gravel/sand BEFORE each dig (one drop is death at
// 1hp); a blocked column shifts the shaft one cell sideways instead.
async function shaftUp(bot, mcData, maxRise = 56, log = null) {
  const isAir = (b) => !b || /^(air|cave_air|void_air)$/.test(b.name);
  const hazard = (b) => b && /lava|water|bubble|gravel|sand|obsidian|bedrock|magma/.test(b.name);
  const placeable = () =>
    bot.inventory
      .items()
      .find(
        (i) =>
          mcData.blocksByName[i.name]?.boundingBox === "block" &&
          !/pickaxe|sword|_axe|shovel|_hoe|bucket|torch|sign|bed|chest|crafting|furnace|boat|ladder|door|slab|stairs|fence|wall|glass|pane|leaf|leaves|wool|carpet/.test(i.name)
      );
  const digCell = async (b) => {
    if (!b || isAir(b)) return true;
    const r = await executeAction(
      bot,
      { type: "dig", x: b.position.x, y: b.position.y, z: b.position.z, timeoutMs: 12000 },
      mcData
    ).catch(() => ({ ok: false }));
    return r.ok;
  };
  let rise = 0;
  while (rise < maxRise) {
    const feet = bot.entity.position.floored();
    try {
      if ((bot.blockAt(feet.offset(0, 2, 0))?.skyLight ?? 0) >= 4) return { ok: true, rise };
    } catch {
      /* keep digging */
    }
    // hazard scan before opening the column: anything that falls or burns
    // overhead must move the shaft sideways, not get dug under our own head
    let columnBlocked = false;
    for (const dy of [1, 2, 3, 4, 5]) {
      if (hazard(bot.blockAt(feet.offset(0, dy, 0)))) {
        columnBlocked = true;
        break;
      }
    }
    if (columnBlocked) {
      let shifted = false;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        let sideOk = true;
        for (const dy of [1, 2, 3, 4, 5]) {
          if (hazard(bot.blockAt(feet.offset(dx, dy, dz)))) {
            sideOk = false;
            break;
          }
        }
        if (!sideOk) continue;
        for (const dy of [0, 1]) {
          const c = bot.blockAt(feet.offset(dx, dy, dz));
          if (c && !isAir(c)) {
            if (!(await digCell(c))) {
              sideOk = false;
              break;
            }
            await sleep(150);
          }
        }
        if (!sideOk) continue;
        const step = await executeAction(
          bot,
          { type: "goto", x: feet.x + dx, y: feet.y, z: feet.z + dz, range: 0, timeoutMs: 6000 },
          mcData
        ).catch(() => ({ ok: false }));
        if (step.ok) {
          shifted = true;
          break;
        }
      }
      if (!shifted) return { ok: false, rise, message: "column blocked overhead" };
      continue;
    }
    // clear the two cells overhead (adjacent — no pathfinding involved)
    let dug = true;
    for (const dy of [1, 2]) {
      const c = bot.blockAt(feet.offset(0, dy, 0));
      if (c && !isAir(c)) {
        if (!(await digCell(c))) {
          dug = false;
          break;
        }
        await sleep(150);
      }
    }
    if (!dug) return { ok: false, rise, message: "dig failed" };
    // stand on a new block under our own feet: same predictive window as the
    // refuge pillar — offer the place only while the apply-time feet
    // position clears the destination cell's top
    const s = placeable();
    if (!s) return { ok: false, rise, message: "no block to stand on" };
    try {
      if (bot.heldItem?.name !== s.name) await pt(bot.equip(s, "hand"), 6000, "equip");
    } catch {
      return { ok: false, rise, message: "equip failed" };
    }
    let placed = false;
    for (let attempt = 0; attempt < 3 && !placed; attempt++) {
      const ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
      if (!ref || isAir(ref)) break;
      bot.setControlState("jump", true);
      const lift = Date.now();
      while (Date.now() - lift < 2600) {
        const vy = bot.entity.velocity?.y ?? 0;
        const feetAtApply = bot.entity.position.y + vy * 2.5 - 0.25;
        if (vy > 0.08 && feetAtApply >= ref.position.y + 2.02) {
          try {
            await pt(bot.placeBlock(ref, new Vec3(0, 1, 0)), 8000, "shaft place");
            placed = true;
          } catch {
            /* refused mid-air — re-hop */
          }
          break;
        }
        await sleep(40);
      }
      bot.setControlState("jump", false);
    }
    if (!placed) return { ok: false, rise, message: "pillar place failed" };
    rise += 1;
  }
  return { ok: true, rise, message: "max rise" };
}

async function stairwayUp(bot, mcData, maxSteps = 14, log) {
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let di = 0;
  const placeable = () =>
    bot.inventory
      .items()
      .find(
        (i) =>
          mcData.blocksByName[i.name]?.boundingBox === "block" &&
          !/pickaxe|sword|_axe|shovel|_hoe|bucket|torch|sign|bed|chest|crafting|furnace|boat|ladder|door|slab|stairs|fence|wall|glass|pane|leaf|leaves|wool|carpet/.test(i.name)
      );
  for (let step = 0; step < maxSteps; step++) {
    const feet = bot.entity.position.floored();
    try {
      if ((bot.blockAt(feet.offset(0, 2, 0))?.skyLight ?? 0) >= 4) return { ok: true, steps: step };
    } catch {
      /* keep digging */
    }
    const [dx, dz] = dirs[di % 4];
    let rotated = false;
    // clear body + headroom cells of the next stair position
    for (const dy of [1, 2, 3]) {
      const cell = bot.blockAt(feet.offset(dx, dy, dz));
      if (!cell || /^(air|cave_air|void_air)$/.test(cell.name)) continue;
      if (/bedrock|lava|water|obsidian/.test(cell.name)) {
        rotated = true;
        break;
      }
      const dig = await executeAction(
        bot,
        { type: "dig", x: cell.position.x, y: cell.position.y, z: cell.position.z, timeoutMs: 12000 },
        mcData
      );
      if (!dig.ok) {
        rotated = true;
        break;
      }
      await sleep(150);
    }
    if (rotated) {
      di += 1;
      continue;
    }
    // the stair floor at (x+dx, y, z+dz) must be solid — place one if not
    const base = bot.blockAt(feet.offset(dx, 0, dz));
    if (!base || /^(air|cave_air|void_air|water|lava)$/.test(base.name)) {
      const s = placeable();
      const under = bot.blockAt(feet.offset(dx, -1, dz));
      if (!s || !under || /^(air|cave_air|void_air|water|lava)$/.test(under.name)) {
        di += 1;
        continue;
      }
      try {
        if (bot.heldItem?.name !== s.name) await pt(bot.equip(s, "hand"), 6000, "equip");
        await pt(bot.placeBlock(under, new Vec3(0, 1, 0)), 7000, "stair floor");
      } catch {
        di += 1;
        continue;
      }
    }
    const w = await executeAction(
      bot,
      { type: "goto", x: feet.x + dx, y: feet.y + 1, z: feet.z + dz, range: 0, timeoutMs: 8000 },
      mcData
    ).catch(() => ({ ok: false }));
    if (!w.ok) di += 1;
  }
  return { ok: false, y: Math.floor(bot.entity.position.y) };
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
