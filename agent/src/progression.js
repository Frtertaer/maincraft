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
    // stands underwater. Swim for air before any phase logic. Deep water
    // = under-feet is water too (can't stand) — 1-deep wading is normal
    // travel. The head-only check missed the real trap: treading at the
    // surface with no ledge — head in air, feet swimming, nowhere to land.
    {
      const feetP = bot.entity.position.floored();
      const headW = bot.blockAt(feetP.offset(0, 1, 0));
      const underW = bot.blockAt(feetP.offset(0, -1, 0));
      const wetCell = (b) => /water|bubble_column|kelp|seagrass/.test(String(b?.name || ""));
      if (!bot.entity.vehicle && (wetCell(headW) || wetCell(underW))) {
        const wasDeep = bot.entity.position.y < 48;
        const sw = await surfaceForAir(bot, mcData, log);
        // head above water but still treading an open lake = the next wander
        // step just steers around the water until a drowned arrives. Route to
        // a dry shore cell while the air is full — the drowned@(-18,62,31)
        // kill came from exactly this resurface-then-wander cycle
        if (sw.ok) {
          const f2 = bot.entity.position.floored();
          if (wetCell(bot.blockAt(f2.offset(0, -1, 0)))) {
            await swimToLand(bot, mcData, log, 10000).catch(() => {});
          }
        }
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
        if (!sw.ok) {
          state.submergedFails = (state.submergedFails || 0) + 1;
          if (state.submergedFails >= 3) {
            // repeated surface failures = a flooded REGION, not a column:
            // swim hard for land and mark the basin so descends and
            // relocations stop probing columns into it
            const fz = bot.entity.position.floored();
            state.floodZone = { x: fz.x, z: fz.z, r: 60 };
            const landed = await swimToLand(bot, mcData, log, 45000).catch(() => false);
            if (landed) {
              state.submergedFails = 0;
              return { ok: true, phase, message: "flood basin — swam to land" };
            }
          }
        } else {
          state.submergedFails = 0;
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
          // nearest log so the next attempt searches a different space.
          // Never toward one inside the death ring — that pull is how the
          // bot re-walks into the camp that killed it
          const cz = campZonesFor(bot, state);
          const t = bot.findBlock({
            matching: (b) => {
              const bp = b?.position ?? b;
              return b && b.name.endsWith("_log") && bp && !posInCamp(bp, cz);
            },
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
  // a pickaxe head costs 3 planks and the 2 sticks cost 2 more — topping up
  // to 3 first leaves 1 plank after the stick craft (missing materials)
  const needSticks = countItem(bot, "stick") < 2;
  // the whole ladder is planks: head 3 + sticks 2 + a fresh table 4 when
  // none is near. Counting only planks lies when logs are gone (the naked
  // respawn at 4 planks: sticks eat 2 -> pickaxe and table both impossible
  // forever) — forage a log first when total wood can't cover the chain.
  // Sealed pockets can't forage, so they skip straight to the craft attempt
  const needTable =
    countItem(bot, "crafting_table") < 1 &&
    !bot.findBlock?.({ matching: (b) => b?.name === "crafting_table", maxDistance: 8 });
  const plankNeed = 3 + (needSticks ? 2 : 0) + (needTable ? 4 : 0);
  const wood = countItem(bot, (i) => i.name.includes("planks")) + countItem(bot, CRAFTABLE_LOG) * 4;
  if (!bot._inShelter && wood < plankNeed) await punchNearbyLogs(bot, mcData, 3).catch(() => null);
  await ensurePlanks(bot, mcData, Math.max(needSticks ? 5 : 3, plankNeed));
  if (needSticks) await ensureCraft(bot, mcData, "stick", 4).catch(() => null);
  if (hasStone) {
    const r = await ensureCraft(bot, mcData, "stone_pickaxe", 1).catch((e) => ({ ok: false, message: String(e?.message || e) }));
    if (r.ok) return r;
  }
  return ensureCraft(bot, mcData, "wooden_pickaxe", 1);
}

// mineflayer calls that wait on server acks (equip/placeBlock) can hang
// forever when the ack packet is lost — race every such call against a timer
function pt(promise, timeoutMs, what, onTimeout = null) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout?.();
        } catch {
          /* cleanup best-effort */
        }
        reject(new Error(`${what} timeout`));
      }, timeoutMs);
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

// Potential-field escape heading: every hostile within 40m pushes an
// away-vector weighted by closeness, so the sprint curves around the whole
// pack — sprinting directly away from the NEAREST hostile aims you into
// the second-nearest (the skeleton that killed on a pillar exit while the
// flee bore off the zombie)
function fleeYaw(bot) {
  const p = bot.entity.position;
  let ax = 0;
  let az = 0;
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e === bot.entity) continue;
    const n = String(e.name || e.displayName || "").toLowerCase();
    const hostile =
      (e.kind === "Hostile mobs" && e.name !== "enderman") ||
      /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
    if (!hostile) continue;
    const dx = p.x - e.position.x;
    const dz = p.z - e.position.z;
    const d = Math.hypot(dx, dz);
    if (d > 40 || d < 0.001) continue;
    const w = (40 - d) / d;
    ax += (dx / d) * w;
    az += (dz / d) * w;
  }
  if (!ax && !az) return bot.entity.yaw;
  return Math.atan2(-ax, -az);
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
  const r = await executeAction(bot, { type: "craft", item, count }, mcData);
  // a 3x3 craft only fails on "no table in world" — the caller usually
  // carries a crafting_table in the bag. Place one through ensureTable
  // (walks to an existing table or hangs one on any solid face, sealed
  // pockets included) and retry the craft once
  if (!r.ok && /need crafting_table in world/i.test(String(r.message || "")) && item !== "crafting_table") {
    const t = await ensureTable(bot, mcData).catch(() => ({ ok: false }));
    if (t.ok) return executeAction(bot, { type: "craft", item, count }, mcData);
    return { ok: false, message: `${r.message} (place table: ${t.message || "failed"})` };
  }
  return r;
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

// merged camp ring: in-memory death points + camp + the persisted set —
// every gather/pull target inside it is a re-death trap, so navigation and
// collection reject them uniformly instead of re-walking the kill ring
export function campZonesFor(bot, state) {
  const dzFile = deathZonesLoadFile(bot) || { pts: [], camp: null };
  return [
    ...(state?._deathPts || []),
    state?.campZone,
    ...(dzFile.pts || []),
    dzFile.camp,
  ].filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.z));
}

export function posInCamp(pos, zones, r = 120) {
  return zones.some((c) => Math.hypot(c.x - pos.x, c.z - pos.z) < r);
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

// a stash that opened empty is dead weight: starving raids re-walked the
// same chest 50m+ twice in 6min because nothing retires the point
function stashRemove(pos, bot) {
  try {
    const list = stashLoadFile(bot).filter(
      (p) => !(Math.abs(p.x - pos.x) < 2 && Math.abs(p.z - pos.z) < 2)
    );
    fs.mkdirSync(path.dirname(STASH_FILE), { recursive: true });
    fs.writeFileSync(STASH_FILE, JSON.stringify(list.slice(-40)));
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
      items.some((i) => i.name === "crafting_table");
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
        // food is the point of the starvation raid — bank up to 4 portions
        // whenever ≥2 are held (keep the rest to eat). Requiring ≥6 before
        // depositing meant most chests held tools but zero food
        const foodWant = Math.min(4, Math.max(0, countOf(STASH_FOOD) - 2));
        for (const [re, want] of [
          [/_planks$/, 8],
          [/^stick$/, 4],
          [/^crafting_table$/, 1],
          [STASH_FOOD, foodWant],
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

// The only food source that is self-sufficient on ANY seed: a wheat row
// tilled beside water. Every other pipeline needs mobs, a village, or a
// stocked chest — a barren basin fails all three at once (speedrun6 sat
// at food=0 for hours with seeds and dirt in reach). Tending is cheap:
// harvest mature → replant → bread → eat; lay out a plot only when seeds
// and water are already close.
async function farmTend(bot, mcData, log, state) {
  let ate = false;
  // 1) harvest mature crops in reach (wheat/carrots/potatoes age 7,
  //    beetroots 3 — same maturity rule as the village raid)
  try {
    const mature = (bot.findBlocks({
      matching: (b) => {
        if (!b) return false;
        const age = b._properties?.age;
        if (b.name === "wheat" || b.name === "carrots" || b.name === "potatoes") return age >= 7;
        if (b.name === "beetroots") return age >= 3;
        return false;
      },
      maxDistance: 45,
      count: 10,
    }) || []).map((p) => bot.blockAt(p)).filter(Boolean);
    const seedFor = { wheat: "wheat_seeds", carrots: "carrot", potatoes: "potato", beetroots: "beetroot_seeds" };
    for (const cb of mature) {
      const g = await executeAction(
        bot,
        { type: "goto", x: cb.position.x, y: cb.position.y, z: cb.position.z, range: 2, timeoutMs: 12000 },
        mcData
      ).catch(() => ({ ok: false }));
      if (!g.ok) continue;
      const seedName = seedFor[cb.name];
      await executeAction(
        bot,
        { type: "dig", x: cb.position.x, y: cb.position.y, z: cb.position.z, timeoutMs: 6000 },
        mcData
      ).catch(() => null);
      await sleep(350);
      // replant on the same spot — a farm only pays once it stays planted
      const seed = bot.inventory.items().find((i) => i.name === seedName);
      const soil = bot.blockAt(cb.position.offset(0, -1, 0));
      if (seed && soil && soil.name === "farmland") {
        try {
          await bot.equip(seed, "hand");
          await pt(bot.activateBlock(soil), 4000);
        } catch { /* replant best-effort */ }
      }
    }
    if (mature.length) log?.(`[food] farm harvest x${mature.length}`);
  } catch { /* scan best-effort */ }
  // 2) wheat → bread → eat (a table is needed — ensureCraft places one)
  try {
    const hayHeld = countItem(bot, (i) => i.name === "hay_block");
    if (hayHeld > 0) {
      await ensureCraft(bot, mcData, "wheat", hayHeld).catch(() => ({ ok: false }));
    }
    const wheat = countItem(bot, (i) => i.name === "wheat");
    if (wheat >= 3 && bot.food < 18) {
      const bc = await ensureCraft(bot, mcData, "bread", Math.floor(wheat / 3)).catch(() => ({ ok: false }));
      if (bc.ok) {
        const f = bot.inventory.items().find((i) => i.name === "bread");
        if (f) {
          const e = await executeAction(bot, { type: "eat", item: "bread", timeoutMs: 12000 }, mcData).catch(() => ({ ok: false }));
          if (e.ok) {
            ate = true;
            log?.(`[food] farm bread (food=${bot.food})`);
          }
        }
      }
    }
  } catch { /* bread best-effort */ }
  // 3) seed collection: grass in reach drops wheat_seeds ~1/8 of the time —
  //    cheap to strip while starving near the plot (60s cooldown)
  if (!bot.inventory.items().some((i) => /_seeds$/.test(i.name)) && Date.now() - (state.farmSeedAt || 0) > 60000) {
    try {
      const grass = bot.findBlocks({
        matching: (b) => b && /^(short_grass|tall_grass|grass)$/.test(b.name),
        maxDistance: 24,
        count: 10,
      }) || [];
      if (grass.length) {
        state.farmSeedAt = Date.now();
        for (const gp of grass.slice(0, 8)) {
          await executeAction(bot, { type: "goto", x: gp.x, y: gp.y, z: gp.z, range: 2, timeoutMs: 8000 }, mcData).catch(() => ({ ok: false }));
          await executeAction(bot, { type: "dig", x: gp.x, y: gp.y, z: gp.z, timeoutMs: 4000 }, mcData).catch(() => null);
        }
        if (bot.inventory.items().some((i) => /_seeds$/.test(i.name))) log?.(`[food] farm: seeds gathered`);
      }
    } catch { /* grass best-effort */ }
  }
  // 4) plant: seeds in hand + a tillable block within 4 of water. Hoeing
  //    and planting both go through activateBlock with the item held.
  const seeds = bot.inventory.items().find((i) => /_seeds$/.test(i.name));
  if (seeds && Date.now() - (state.farmPlantAt || 0) > 120000) {
    try {
      const water = bot.findBlocks({ matching: (b) => b && b.name === "water", maxDistance: 40, count: 1 })?.[0];
      const soils = (bot.findBlocks({
        matching: (b) => b && /^(dirt|grass_block|coarse_dirt|rooted_dirt|farmland)$/.test(b.name),
        maxDistance: 40,
        count: 60,
      }) || []).map((p) => bot.blockAt(p)).filter(Boolean);
      const plantable = (b) =>
        b.name !== "farmland" &&
        /air|short_grass|tall_grass|fern/.test(bot.blockAt(b.position.offset(0, 1, 0))?.name || "") &&
        (bot.blockAt(b.position.offset(0, 1, 0))?.skyLight ?? 15) > 8; // crops need light
      const site =
        (water
          ? soils.find(
              (b) =>
                plantable(b) &&
                Math.abs(b.position.x - water.x) <= 4 &&
                Math.abs(b.position.z - water.z) <= 4 &&
                b.position.y >= water.y - 1 &&
                b.position.y <= water.y + 1
            )
          : null) || soils.find(plantable); // dry farmland grows too — slower, but a starving bot takes it
      {
        if (site) {
          state.farmPlantAt = Date.now();
          const g = await executeAction(
            bot,
            { type: "goto", x: site.position.x, y: site.position.y, z: site.position.z, range: 3, timeoutMs: 12000 },
            mcData
          ).catch(() => ({ ok: false }));
          if (g.ok) {
            if (!bot.inventory.items().some((i) => /_hoe$/.test(i.name))) {
              await ensurePlanks(bot, mcData, 2).catch(() => null);
              await ensureCraft(bot, mcData, "wooden_hoe", 1).catch(() => ({ ok: false }));
            }
            const hoe = bot.inventory.items().find((i) => /_hoe$/.test(i.name));
            if (hoe) {
              try {
                await bot.equip(hoe, "hand");
                await pt(bot.activateBlock(site), 5000);
              } catch { /* till best-effort */ }
            }
            const tilled = bot.blockAt(site.position);
            if (tilled && tilled.name === "farmland") {
              try {
                const s = bot.inventory.items().find((i) => /_seeds$/.test(i.name));
                if (s) {
                  await bot.equip(s, "hand");
                  await pt(bot.activateBlock(tilled), 5000);
                  state.farm = { x: site.position.x, y: site.position.y, z: site.position.z };
                  log?.(`[food] farm plot tilled @${site.position.x},${site.position.z}`);
                }
              } catch { /* plant best-effort */ }
            }
          }
        }
      }
    } catch { /* site scan best-effort */ }
  }
  return { ate };
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
    // an unreachable chest keeps its point and gets re-raided every food
    // window forever — two consecutive reach/open failures retires it the
    // same way an empty chest does (the @33,184 kit re-raided 4x in 25min)
    if (state) state._stashMiss = state._stashMiss || {};
    const stashKey = (p) => `${Math.round(p.x)},${Math.round(p.z)}`;
    const kill = (p) => {
      stashRemove(p, bot);
      if (!state) return;
      delete state._stashMiss[stashKey(p)];
      if (state.stash && Math.abs(state.stash.x - p.x) < 2 && Math.abs(state.stash.z - p.z) < 2) state.stash = null;
    };
    const miss = (p) => {
      if (!state) return;
      const k = stashKey(p);
      state._stashMiss[k] = (state._stashMiss[k] || 0) + 1;
      if (state._stashMiss[k] >= 2) kill(p);
    };
    for (const { p } of near) {
      try {
        await executeAction(
          bot,
          { type: "goto", x: p.x + 0.5, y: p.y, z: p.z + 0.5, range: 2, timeoutMs: 30000 },
          mcData
        );
      } catch {
        // sealed inside a burrow plug: the chest is OURS, buried in soft
        // ground — tunnel toward it cell by cell instead of calling the
        // stash empty (the @0,-219 kit 10m away that read "stashes empty")
        if (Math.hypot(p.x - me.x, p.z - me.z) < 24) {
          for (let i = 0; i < 14; i++) {
            const mm = bot.entity.position.floored();
            const tx = Math.abs(p.x - mm.x) >= Math.abs(p.z - mm.z) ? Math.sign(p.x - mm.x) : 0;
            const tz = tx ? 0 : Math.sign(p.z - mm.z);
            if (!tx && !tz) break;
            let dug = true;
            for (const c of [mm.offset(tx, 1, tz), mm.offset(tx, 0, tz), mm.offset(tx, 2, tz)]) {
              const b = bot.blockAt(c);
              if (!b || /air|cave_air|void_air/.test(b.name)) continue;
              if (!diggableBlock(bot, b)) {
                dug = false;
                break;
              }
              const d = await executeAction(bot, { type: "dig", x: c.x, y: c.y, z: c.z, timeoutMs: 6000 }, mcData).catch(() => ({ ok: false }));
              if (!d.ok) {
                dug = false;
                break;
              }
            }
            if (!dug) break;
            const g = await executeAction(
              bot,
              { type: "goto", x: mm.x + tx, y: mm.y, z: mm.z + tz, range: 0, timeoutMs: 4000 },
              mcData
            ).catch(() => ({ ok: false }));
            if (!g.ok) break;
          }
        }
        try {
          await executeAction(
            bot,
            { type: "goto", x: p.x + 0.5, y: p.y, z: p.z + 0.5, range: 2, timeoutMs: 12000 },
            mcData
          );
        } catch {
          miss(p);
          continue; // unreachable — try the next chest
        }
      }
      try {
        const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
        if (!b || b.name !== "chest") {
          kill(p); // chest itself is gone — the point is provably dead
          continue;
        }
        // a chest sealed behind rock reads via blockAt but the server
        // refuses the open (no LOS/reach) — pt() times it out, and without
        // this inner catch ONE bad chest aborted the whole raid (the
        // "open chest timeout" that killed two starvation raids in a row,
        // each 90s+ at food=0)
        const chest = await pt(bot.openChest(b), 8000, "open chest");
        try {
          const items = chest.containerItems();
          for (const item of items) {
            await pt(chest.withdraw(item.type, item.metadata, item.count), 8000, "withdraw");
            took += item.count;
          }
          // empty or drained — retire the point. Without this the next
          // starvation raid re-walks 50m+ to the same proven-empty chest
          // (the @-54,-94 stash was raided twice in 6min, both empty)
          stashRemove(p, bot);
        } finally {
          chest.close();
        }
      } catch {
        miss(p);
        continue; // unreadable chest — next candidate
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
  let fluidStuck = false;
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
      // don't dig into a mob's lap. Entities load through walls, so a naive
      // radius counts every pack sealed behind stone — in a dense cave all
      // four dirs stay "mob"-flagged forever while the bot is actually safe.
      // Only block on mobs THROUGH the doorway (forward-projected) or close
      // enough to be standing inside the door cell itself.
      const door = p.offset(dx, 0, dz);
      const ambush = Object.values(bot.entities || {}).some((e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || e.displayName || "").toLowerCase();
        const hostile =
          (e.kind === "Hostile mobs" && e.name !== "enderman") ||
          /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
        if (!hostile) return false;
        const dist = e.position.distanceTo(door);
        if (dist < 4) return true; // inside/near the door cell itself
        if (dist > 10) return false;
        // forward-projected: the mob is on the far side of the doorway wall —
        // opening this dir connects our corridor to its airspace
        const fwd = (e.position.x - door.x) * dx + (e.position.z - door.z) * dz;
        return fwd > 0.5;
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
        // a safe column over a lava-FLUSH floor is still a death pit — the
        // drop lands one step from magma and the first walk in is the kill
        // (iron death @13,60,-52 after a clean vertical dig into a lava ring)
        if (landY != null && !landDangerous) {
          // feet AND head level: a lava face seeping at landY+2 never shows
          // up in the feet scan — the drop lands the bot's head inside it
          // (the unmarked death at (101,61,159) 4s after a clean dig)
          for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            for (const hy of [1, 2]) {
              const nb = bot.blockAt(new Vec3(p.x + nx, landY + hy, p.z + nz));
              if (nb && dangerous(nb)) {
                landDangerous = true;
                break;
              }
            }
            if (landDangerous) break;
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
      // water/lava named in any direction's failure means the staircase sits
      // in a flooded region — the caller escalates relocation distance for
      // this, digs>0 or not (digging 'progress' in a swamp still drowns)
      fluidStuck = why.some((w) => /water|lava/.test(w));
      log?.(`[stairDown] stuck at ${p.x},${p.y},${p.z} k=${k} dug=${dug} :: ${why.join(" | ")}`);
      break;
    }
  }
  return { digs: dug, fluid: fluidStuck };
}

// Place a shore step into the water beside a wall face so a treading bot
// gets a landing to climb onto. executeAction's place refuses water targets
// (its occupied check only allows air cells), but vanilla allows waterlog
// placement — go through bot.placeBlock directly.
async function placeShoreStep(bot, mcData) {
  const isCube = (i) => mcData.blocksByName[i.name]?.boundingBox === "block";
  const SEAL_BAD =
    /furnace|chest|barrel|table|bed$|sign|skull|_head$|banner|campfire|piston|observer|dispenser|dropper|hopper|jukebox|note_block|beehive|bee_nest|spawner|shulker|ender|tnt|lectern|lodestone|respawn_anchor|bell|grindstone|stonecutter|loom|smithing|fletching|cartography|command_block|structure|jigsaw|portal|chorus|slime_block|honey|magma|ice$|snow$|pointed|conduit|beacon|composter|cauldron|brewing|enchanting|sculk|frame|soul_campfire|decorated_pot|trial|vault|crafter/;
  const item = bot.inventory.items().find(
    (i) =>
      isCube(i) &&
      !SEAL_BAD.test(i.name) &&
      // gravity blocks sink through the column instead of holding the step
      !/sand$|gravel|concrete_powder|anvil|scaffold|snow$|snow_layer|tnt|red_sand/.test(i.name)
  );
  if (!item) return false;
  const p = bot.entity.position.floored();
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const target = p.offset(dx, 0, dz);
    const tB = bot.blockAt(target);
    if (!/water|bubble_column/.test(String(tB?.name || ""))) continue;
    for (const [ox, oy, oz, fx, fy, fz] of [
      [0, -1, 0, 0, 1, 0],
      [1, 0, 0, -1, 0, 0],
      [-1, 0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0, -1],
      [0, 0, -1, 0, 0, 1],
    ]) {
      const ref = bot.blockAt(target.offset(ox, oy, oz));
      if (!ref || ref.boundingBox !== "block") continue;
      if (ref.position.distanceTo(bot.entity.position) > 4.0) continue;
      try {
        await pt(bot.equip(item, "hand"), 4000, "equip");
        if (bot.heldItem?.name !== item.name) continue;
        await pt(bot.placeBlock(ref, new Vec3(fx, fy, fz)), 5000, "shore place");
        const placed = bot.blockAt(target);
        if (placed && placed.name !== "air") return true;
      } catch {
        /* next face */
      }
    }
  }
  return false;
}

// Swim up out of water: hold jump to rise, and once the head is out seek a
// climbable lip (a solid top at the water line). No lip = a flooded pocket
// or deep pool — place a shore step against a wall face, or drift toward
// the next probe direction until a shore scan finds land.
async function surfaceForAir(bot, mcData, log) {
  const t0 = Date.now();
  let dirIdx = 0;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const WET = /water|bubble_column|kelp|seagrass/;
  const PASS = /air|cave_air|void_air|water|bubble_column|kelp|seagrass|snow|snow_layer|grass|fern|vine|tall_grass|short_grass/;
  // climbable lip: a solid block whose top is at or ~1 above the water line
  // with passable room for the body — a jump from the surface grabs it
  const findShore = () => {
    const p = bot.entity.position.floored();
    let best = null;
    let bestD = 1e9;
    for (let dx = -4; dx <= 4; dx += 1) {
      for (let dz = -4; dz <= 4; dz += 1) {
        if (!dx && !dz) continue;
        for (let dy = -2; dy <= 1; dy += 1) {
          const b = bot.blockAt(p.offset(dx, dy, dz));
          if (!b || b.boundingBox !== "block" || WET.test(b.name)) continue;
          const a1 = bot.blockAt(b.position.offset(0, 1, 0));
          const a2 = bot.blockAt(b.position.offset(0, 2, 0));
          if (!a1 || !a2 || !PASS.test(a1.name) || !PASS.test(a2.name)) continue;
          // the lip can't be a wall — reject tops the swim can't mount
          if (b.position.y + 1 - bot.entity.position.y > 1.4) continue;
          const d = Math.hypot(dx, dz);
          if (d < bestD) {
            bestD = d;
            best = b.position;
          }
        }
      }
    }
    return best;
  };
  try {
    while (Date.now() - t0 < 30000) {
      const feet = bot.entity.position.floored();
      const head = bot.blockAt(feet.offset(0, 1, 0));
      const under = bot.blockAt(feet.offset(0, -1, 0));
      const headWet = WET.test(String(head?.name || ""));
      const swimming = WET.test(String(under?.name || ""));
      if (!headWet && !swimming) return { ok: true };
      const shore = findShore();
      if (shore) {
        // a lip exists — swim at it; close in with a sprint-jump to mount
        const cx = shore.x + 0.5;
        const cz = shore.z + 0.5;
        const dx = cx - bot.entity.position.x;
        const dz = cz - bot.entity.position.z;
        bot.look(Math.atan2(-dx, -dz), 0, true);
        bot.setControlState("jump", true);
        bot.setControlState("forward", true);
        bot.setControlState("sprint", Math.hypot(dx, dz) < 2.4);
        await sleep(280);
        continue;
      }
      if (!headWet) {
        // head in air, no lip — try a placed step into the water beside a
        // wall face, else drift toward the next probe direction
        if (await placeShoreStep(bot, mcData)) {
          await sleep(200);
          continue;
        }
        // the shore is past this scan's 4m reach — a lake can span 30m+.
        // Treading + blind direction probes is the drowning-pool death
        // (three "still submerged" timeouts on speedrun6): steer for the
        // wide-ring dry-column scan instead, same target swimToLand uses
        const landed = await swimToLand(bot, mcData, log, 8000).catch(() => false);
        if (landed) continue;
        const [dx, dz] = dirs[dirIdx % 4];
        dirIdx += 1;
        bot.look(Math.atan2(-dx, -dz), 0, true);
        bot.setControlState("forward", true);
        bot.setControlState("jump", false);
        bot.setControlState("sprint", false);
        await sleep(400);
        continue;
      }
      const above = bot.blockAt(feet.offset(0, 2, 0));
      if (above && !/water|bubble_column|air|cave_air|kelp|seagrass/.test(above.name)) {
        // ceiling overhead — a flooded cavity roofs onto dry rock more often
        // than it opens to a shore, so dig straight through when the block
        // gives; only drift sideways for bedrock/lava
        if (diggableBlock(bot, above)) {
          const dg = await executeAction(
            bot,
            { type: "dig", x: above.position.x, y: above.position.y, z: above.position.z, timeoutMs: 8000 },
            mcData
          ).catch(() => ({ ok: false }));
          if (dg.ok) continue;
        }
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
    bot.setControlState("sprint", false);
  }
}

// Strip-mine a 1x2 tunnel `steps` long: dig head+feet cells ahead, step in,
// collect any ore vein now visible in the tunnel walls. Never opens into
// caves — a bad cell ahead rotates the tunnel 90° instead.
async function stripMine(bot, mcData, steps = 20, log = null, preferDir = null) {
  let dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  if (preferDir) dirs = [preferDir, ...dirs.filter(([x, z]) => !(x === preferDir[0] && z === preferDir[1]))];
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
      const pk = await ensurePickaxe(bot, mcData).catch((e) => ({ ok: false, message: String(e?.message || e) }));
      if (!pk?.ok) {
        log?.(`[stripMine] pickaxe gone and not recraftable (${pk?.message || "?"}) — bailing`);
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
    // picks the longest dry stretch instead of blindly diving in). The scan
    // must follow the column DOWN to the real walk surface — lakes sit at
    // y≈62 while plateau ground runs y≈70-93, so a fixed -3..0 band sees air
    // on the rim and calls a lake basin dry (every drowned flee-death)
    let runway = leg + 1;
    // scan the whole flee leg, not just the first 90m: legs run 210m and a
    // lake at ~100-150m scored 'dry' until the bot was already descending
    // into it with the spider behind (spawn-basin kills #3-5)
    const scanCap = Math.min(leg, 170);
    for (let step = 6; step <= scanCap; step += 6) {
      let wet = false;
      for (let dy = 0; dy >= -20; dy--) {
        const b = bot.blockAt(feet.offset(sx * step, dy, sz * step));
        if (!b) continue;
        if (/water|kelp|seagrass|ice|bubble/.test(b.name)) {
          wet = true;
          break;
        }
        if (dy < 0 && b.boundingBox === "block") break; // walk surface — deeper is under it
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
    // a dry leg that runs through a mob cluster re-aggros mid-sprint — the
    // zombie waiting at (111,-50) scored zero on water but killed anyway.
    // Cap the runway at the first hostile standing in this leg's corridor,
    // same as water: proj = distance along the leg, blocked when the mob is
    // within ~7m of the leg line
    const ul = Math.hypot(dx, dz) || 1;
    const ux = dx / ul;
    const uz = dz / ul;
    for (const e of Object.values(bot.entities || {})) {
      if (!e?.position || e === bot.entity) continue;
      const n = String(e.name || "").toLowerCase();
      if (!/zombie|skeleton|creeper|spider|husk|drowned|stray|pillager|vex|slime|witch|zoglin|zombified/.test(n)) continue;
      const rx = e.position.x - bot.entity.position.x;
      const rz = e.position.z - bot.entity.position.z;
      const proj = rx * ux + rz * uz;
      if (proj < 4 || proj > scanCap) continue;
      const perp = Math.abs(rx * uz - rz * ux);
      if (perp > 7) continue;
      if (proj < runway) runway = Math.max(1, Math.floor(proj));
    }
    const score = -runway * 10 + trees;
    if (score < bestScore) {
      bestScore = score;
      best = [dx, dz];
    }
  }
  return best;
}

// Out in open water every shelter is impossible — a riser cell is water,
// a shaft is water, a pocket wall is water. Scan outward rings for the
// nearest column whose surface is dry solid with air above, then swim at it
// with the same look+jump+forward steering surfaceForAir uses on lips
async function swimToLand(bot, mcData, log, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = bot.entity.position.floored();
    const inCell = bot.blockAt(p);
    const underCell = bot.blockAt(p.offset(0, -1, 0));
    // bobbing at the surface reads feet=air while still swimming — "landed"
    // only when the cell below the feet is dry solid too
    if (
      inCell &&
      inCell.name !== "water" &&
      !/kelp|seagrass|bubble/.test(inCell.name) &&
      underCell &&
      underCell.name !== "water" &&
      !/kelp|seagrass|bubble/.test(underCell.name)
    )
      return true;
    let best = null;
    let bestD = 1e9;
    for (let dx = -8; dx <= 8; dx += 1) {
      for (let dz = -8; dz <= 8; dz += 1) {
        if (!dx && !dz) continue;
        for (let dy = -3; dy <= 4; dy += 1) {
          const b = bot.blockAt(p.offset(dx * 5, dy, dz * 5));
          if (!b || b.boundingBox !== "block" || /water|kelp|seagrass|bubble/.test(b.name)) continue;
          const a1 = bot.blockAt(b.position.offset(0, 1, 0));
          const a2 = bot.blockAt(b.position.offset(0, 2, 0));
          if (!a1 || !a2 || !/air|cave_air|void_air|snow|grass|fern|tall_grass|short_grass/.test(a1.name)) continue;
          const d = Math.hypot(dx * 5, dz * 5);
          if (d < bestD) {
            bestD = d;
            best = b.position;
          }
        }
      }
    }
    if (!best) {
      // nothing dry in scan range — keep swimming in the same heading
      bot.setControlState("jump", true);
      bot.setControlState("forward", true);
      await sleep(400);
      continue;
    }
    const dx = best.x + 0.5 - bot.entity.position.x;
    const dz = best.z + 0.5 - bot.entity.position.z;
    bot.look(Math.atan2(-dx, -dz), 0, true);
    bot.setControlState("jump", true);
    bot.setControlState("forward", true);
    bot.setControlState("sprint", Math.hypot(dx, dz) > 3);
    await sleep(320);
  }
  bot.setControlState("jump", false);
  bot.setControlState("sprint", false);
  return false;
}

// Steer to a point on/under water the way swimToLand steers for shore —
// item drops float on the surface, so look+jump+forward+sprint closes on
// them where the pathfinder refuses to enter water at all
async function steerSwimTo(bot, x, z, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const dx = x + 0.5 - bot.entity.position.x;
    const dz = z + 0.5 - bot.entity.position.z;
    if (Math.hypot(dx, dz) < 1.6) break;
    bot.look(Math.atan2(-dx, -dz), 0, true);
    bot.setControlState("jump", true);
    bot.setControlState("forward", true);
    bot.setControlState("sprint", Math.hypot(dx, dz) > 3);
    await sleep(220);
  }
  bot.setControlState("jump", false);
  bot.setControlState("sprint", false);
}

export async function burrowForNight(bot, mcData, log, force = false, _depth = 0, state = null) {
  const tod = bot.time?.timeOfDay;
  if (!force && (tod == null || tod < 12541)) return false;
  // sheltering is impossible while swimming — every riser cell is water.
  // Get to shore first; only then does the column/pocket search mean anything
  const inCell = bot.blockAt(bot.entity.position.floored());
  if (inCell?.name === "water" || /kelp|seagrass/.test(inCell?.name || "")) {
    // surfaceForAir, not swimToLand: underground a flooded cave has no
    // shore within reach — the land swim drowned the bot at y=13. Climb a
    // ceiling/air pocket first; the land scan stays as its fallback
    log?.("[burrow] in open water — surfacing for air");
    await surfaceForAir(bot, mcData, log).catch(() => {});
  }
  // a creeper inside ~16m outranges the whole prep window: the separation
  // sprint buys ~4s, then the bot stands still punching logs for 60s while
  // it re-approaches. Abort prep so the loop sprints again instead of
  // building into the blast — two spawn-camp deaths came from exactly this.
  const creeperClose = () =>
    Object.values(bot.entities || {}).some((e) => {
      if (!e?.position || e === bot.entity) return false;
      return /creeper/.test(String(e.name || "").toLowerCase()) &&
        e.position.distanceTo(bot.entity.position) < 16;
    });
  if (creeperClose()) {
    log?.("[burrow] creeper closing — aborting prep");
    return false;
  }
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
    // bare-handed underground in an all-stone cave nothing can ever seal:
    // every wall is undiggable and no soft site scans. After repeated
    // failures climb to a skylit block — surface dirt is the only ground
    // a bare hand can still burrow into
    const climbToDaylight = async () => {
      const sky = bot.findBlocks({
        matching: (b) => {
          const bb = b?.position ? b : bot.blockAt(b);
          return bb && (bb.skyLight ?? 0) >= 8;
        },
        maxDistance: 56,
        count: 1,
      });
      if (!sky.length) return false;
      try {
        await executeAction(
          bot,
          { type: "goto", x: sky[0].x + 0.5, y: sky[0].y + 1, z: sky[0].z + 0.5, range: 2, timeoutMs: 20000 },
          mcData
        );
        return true;
      } catch {
        return false;
      }
    };
    const bareHands = !bot.inventory.items().some((i) => /pickaxe/.test(i.name));
    const headSky =
      bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))?.skyLight ?? 0;
    if (
      _depth >= 2 &&
      bareHands &&
      headSky < 4 &&
      Date.now() - (state?._burrowSurfacedAt || 0) > 600000
    ) {
      if (state) state._burrowSurfacedAt = Date.now();
      log?.("[burrow] bare-handed underground — climbing to daylight");
      await climbToDaylight();
    }
    // a bare-handed bot can only shelter in soft ground — head for the
    // nearest diggable surface block instead of wandering blindly
    let target = null;
    try {
      const campsHere = state ? campZonesFor(bot, state) : [];
      const hostilesNear = Object.values(bot.entities || {}).filter((e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || "").toLowerCase();
        return (
          (e.kind === "Hostile mobs" && e.name !== "enderman") ||
          /zombie|skeleton|creeper|spider|husk|drowned|stray|slime|phantom|pillager|vex|witch/.test(n)
        );
      });
      const soft = bot.findBlocks({
        matching: (b) => {
          const bb = b?.position ? b : bot.blockAt(b);
          if (!bb || bb.name === "air" || /leaves|_log|water|lava/.test(bb.name)) return false;
          // a diggable site inside a kill ring or within trident/bow range of a
          // camper is the relocate-death: the build spends ~15-30s in the open
          // where it landed. Only seal where the ground is diggable AND quiet
          if (campsHere.length && posInCamp(bb.position, campsHere)) return false;
          if (hostilesNear.some((h) => h.position.distanceTo(bb.position) < 26)) return false;
          const a1 = bot.blockAt(bb.position.offset(0, 1, 0));
          const a2 = bot.blockAt(bb.position.offset(0, 2, 0));
          if (a1?.name !== "air" || a2?.name !== "air") return false;
          // two diggable cells below too — grass-over-stone tops dig one
          // layer then stall on the same mountain that just failed
          if (!(diggable(bb) && diggable(bot.blockAt(bb.position.offset(0, -1, 0))) && diggable(bot.blockAt(bb.position.offset(0, -2, 0))))) return false;
          // at least one side carves a depth-2 pocket — a diggable column
          // ringed by stone walls is a guaranteed seal(undiggable) fail —
          // OR one staircase direction for the pillar fallback: bridge cell
          // walkable, riser air-or-clearable. Bare-handed on a stone hillside
          // every riser is stone and the pillar looped "riser-blocked" forever
          const pocketDir = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) =>
            [1, 2].every((i) =>
              [1, 2].every((dy) =>
                diggable(bot.blockAt(bb.position.offset(dx * i, dy, dz * i)))
              )
            )
          );
          if (pocketDir) return true;
          return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
            const fl = bot.blockAt(bb.position.offset(dx, -1, dz));
            const br = bot.blockAt(bb.position.offset(dx, 0, dz));
            const ri = bot.blockAt(bb.position.offset(dx, 1, dz));
            if (!fl || fl.name === "air" || /water|lava/.test(fl.name)) return false;
            if (!br || !/air|short_grass|tall_grass|snow_layer/.test(br.name)) return false;
            return ri && (ri.name === "air" || diggable(ri));
          });
        },
        maxDistance: 40,
        count: 6,
      });
      if (soft.length) target = soft[0];
    } catch {
      /* find failed — fall back to directional wander */
    }
    if (target) {
      // a pathfinder goto while a shooter is in range is the relocate death —
      // it stands still planning then walks at 4.3m/s. Sprint the leg instead:
      // instant, ~5.6m/s, and slides off obstacles. Only when clear is the
      // (slower, precise) walk worth it
      const danger = Object.values(bot.entities || {}).some((e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || "").toLowerCase();
        const hostile =
          e.kind === "Hostile mobs" && e.name !== "enderman" ||
          /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
        return hostile && e.position.distanceTo(bot.entity.position) < 34;
      });
      if (danger) {
        const yaw = Math.atan2(-(target.x - bot.entity.position.x), -(target.z - bot.entity.position.z));
        bot.setControlState("sprint", true);
        bot.setControlState("forward", true);
        const ts = Date.now();
        while (Date.now() - ts < 5000) {
          bot.look(yaw + (Math.random() - 0.5) * 0.5, 0, true);
          bot.setControlState("jump", Date.now() % 700 < 350);
          await sleep(260);
        }
        bot.setControlState("jump", false);
        bot.setControlState("forward", false);
        bot.setControlState("sprint", false);
      } else {
        try {
          await executeAction(
            bot,
            { type: "goto", x: target.x + 0.5, y: target.y + 1, z: target.z + 0.5, range: 1, timeoutMs: 15000 },
            mcData
          );
        } catch {
          /* move didn't land — try the burrow from wherever we are */
        }
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
  // safe() = usable daylight and no hostile within 28 (creepers/spiders
  // don't burn, spawn-campers outlast sunrise; a crawler at ~20m still
  // sprints in and kills the exit — 16m was too small to hold through)
  const safe = () => {
    const t = bot.time?.timeOfDay;
    // null time = unread clock, not daytime — a stale time read once let
    // the bot unseal at true night straight into the camper it hid from.
    // tod 9500-12541 is the last ~2.5min of day: unsealing there buys
    // seconds of light then throws the bot into the dusk mob wave — hold
    // the shelter through the night and release at the real dawn instead
    if (t == null || t >= 9500) return false;
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
    // soft ground is its own shelter material: the grave digs 3 dirt out of
    // the column it stands on and caps with one of them — zero inventory.
    // A stone-surfaced respawn can't do that, so only there does the bare
    // fist go punch a log while the camper closes (the spawn-camp deaths
    // all died standing in the punch, not the dig)
    const SOFTGROUND =
      /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|clay|sand|red_sand|gravel|farmland|dirt_path|mycelium|snow_block|soul_sand|soul_soil|mangrove_roots|moss_block)$|leaves$/;
    const fp = bot.entity.position.floored();
    const softNear = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dz]) => {
      try {
        return SOFTGROUND.test(bot.blockAt(fp.offset(dx, -1, dz))?.name || "");
      } catch {
        return false;
      }
    });
    if (!softNear) {
      const trunk = bot.findBlock({
        matching: (b) => b && /_log$|_stem$/.test(b.name || ""),
        // one log is the whole recovery ladder (table→planks→sticks→pick), so
        // scan far — a 90m walk beats sealing forever naked when the basin
        // around spawn has been logged out
        maxDistance: 90,
      });
      if (trunk) {
        if (creeperClose()) {
          log?.("[burrow] creeper closing — aborting prep");
          return false;
        }
        log?.("[burrow] bare-handed — punching a log for shelter material");
        await pt(punchNearbyLogs(bot, mcData, 4, state), 25000, "log punch").catch(() => null);
      }
    }
  }
  // a broken pickaxe makes every stone column undiggable underground —
  // recraft before scanning so y<0 depth isn't mistaken for unworkable ground
  if (creeperClose()) {
    log?.("[burrow] creeper closing — aborting prep");
    return false;
  }
  if (!hasPickaxe(bot)) {
    const pk = await ensurePickaxe(bot, mcData).catch((e) => ({ ok: false, message: String(e?.message || e) }));
    if (pk?.ok) log?.("[burrow] recrafted pickaxe — stone diggable again");
    else log?.(`[burrow] pickaxe recraft failed: ${pk?.message || "?"}`);
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
    // the shaft is capped only on top — an open cell beside it at depth is a
    // sideways doorway: a cave sharing the shaft wall lets mobs melee through
    // it. The zombie that killed inside a 'sealed' shelter dropped in exactly
    // this way — every lateral cell down the shaft must stay solid
    if (solidCol) {
      const LAT_OPEN = /air|cave_air|void_air|water|bubble|kelp|seagrass|lava/;
      for (const [qx, qz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [-1, -2, -3]) {
          const s = bot.blockAt(p.offset(qx, dy, qz));
          if (!s || LAT_OPEN.test(s.name)) {
            solidCol = false;
            break;
          }
        }
        if (!solidCol) break;
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
        let solid0 = refreshSolid();
        if (!solid0) {
          // empty hands can't wall — but a bare hand still breaks dirt in
          // ~1s, so harvest a few cells at our feet for wall material first
          // (the skeleton-shot pillar deaths all had solid0=null here)
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
            if (refreshSolid()) break;
            const c = bot.blockAt(feet0.offset(ox, -1, oz));
            if (!c || !HAND_DIGGABLE.test(c.name)) continue;
            await executeAction(
              bot,
              { type: "dig", x: c.position.x, y: c.position.y, z: c.position.z, timeoutMs: 4000 },
              mcData
            ).catch(() => ({ ok: false }));
          }
          solid0 = refreshSolid();
        }
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
    // a pillar needs open sky — under a solid lid every riser comes back
    // "no headroom" and each relocate just finds another roofed column.
    // Bare-handed the lid can't be dug through either (stone-tier needs a
    // pickaxe), so the only shelter left is the surface: climb to daylight
    // first instead of looping doomed pillar attempts underground
    {
      const feetC = bot.entity.position.floored();
      let lid = null;
      for (let dy = 2; dy <= 7 && !lid; dy += 1) {
        const b = bot.blockAt(feetC.offset(0, dy, 0));
        if (b && !/air|cave_air|void_air|water|bubble_column|snow|tall_grass|grass|fern|vine|ladder/.test(b.name)) lid = b;
      }
      const pickless = !bot.inventory.items().some((i) => /pickaxe/.test(i.name));
      if (lid && pickless && !diggable(lid)) {
        log?.(`[burrow] ${lid.name} lid overhead — pillar impossible, climbing out`);
        if (await climbToDaylight()) return retryElsewhere("surfaced to daylight");
        log?.("[burrow] no way to the surface — no shelter possible here");
        return false;
      }
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
          await pt(bot.dig(b), 8000, "dig-soft", () => bot.stopDigging());
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
      if (ref.name === "water" || /bubble_column|kelp|seagrass/.test(ref.name)) {
        // treading water: nothing stacks on a water surface — swim for a dry
        // column first, then the retry pillars on real ground. Bare-handed on
        // a lake under a camper this was burning 20s+ per refused attempt
        log?.("[burrow] feet in water — swimming for land before pillar");
        await swimToLand(bot, mcData, log, 20000).catch(() => {});
        break;
      }
      try {
        // fences/walls/panes seal a doorway fine, but their collision tops sit
        // ~1.5 blocks up — the jump-place window (feet ≥ ref+2) can't clear it
        // and every riser comes back "still air". Swap to a real cube first;
        // if nothing stackable remains the pillar would only burn the hop cap
        const NO_PILLAR = /_fence$|_fence_gate$|_wall$|_pane$|_bars$|_door$/;
        if (solid && NO_PILLAR.test(solid.name)) {
          const alt = bot.inventory
            .items()
            .find((i) => isCube(i) && !SEAL_BAD.test(i.name) && !NO_PILLAR.test(i.name));
          if (alt) solid = alt;
          else {
            log?.(`[burrow] pillar err: only ${solid.name} left — not stackable`);
            break;
          }
        }
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
              await pt(bot.dig(headroom), 9000, "dig-lid", () => bot.stopDigging());
              const h3 = bot.blockAt(bot.entity.position.floored().offset(0, 3, 0));
              if (h3 && !PASSABLE.test(h3.name) && diggable(h3)) {
                await pt(bot.dig(h3), 9000, "dig-lid2", () => bot.stopDigging());
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
          if (creeperClose()) {
            // a bomb walked up mid-build — bail so the reflex can kite it;
            // resuming here is just placing into the blast
            log?.("[burrow] creeper closing — abandoning the pillar");
            return false;
          }
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
            const feetNow = bot.entity.position.y;
            // the server applies the place 1-3 ticks after the packet: the
            // real feet must already clear the new block's top or it lands
            // inside the body and the server silently refuses ("still air").
            // The old prediction (feet+vy*2.5) offered mid-rise — the bot
            // fell back into the cell before apply and ate 3 refusals/riser
            if (vy > 0.05 && feetNow >= ref.position.y + 2.0) {
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
          for (let level = 0; level + raised < 6; level++) {
            if (creeperClose()) {
              log?.("[burrow] creeper closing — abandoning the staircase");
              return false;
            }
            if (!refreshSolid()) {
              // out of blocks mid-climb: the staircase's own lower steps are
              // slated for cutting anyway — dig one back and re-place it one
              // level up. Free height; stops the "ran dry at +4" abort that
              // leaves the bot in melee reach. Never touch steps within 2
              // of the feet: the block under us must not drop out
              let got = false;
              const fy = bot.entity.position.floored().y;
              for (const tp of stairTrail) {
                if (tp.y > fy - 2) continue;
                const tb = bot.blockAt(tp);
                if (!tb || tb.name === "air" || !diggable(tb)) continue;
                try {
                  await pt(bot.dig(tb), 7000, "trail-harvest", () => bot.stopDigging());
                  got = true;
                } catch {
                  /* unreachable from up here — try the next step */
                }
                if (got) break;
              }
              if (!got) break;
              await sleep(250); // let the drop land in the pickup radius
              if (!refreshSolid()) break;
            }
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
                  await pt(bot.dig(riserCell), 8000, "stair-clear", () => bot.stopDigging());
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
          // Break all but the top step: a gap a mob can't jump up through
          const topY = bot.entity.position.floored().y;
          for (const p of stairTrail) {
            if (p.y > topY - 3) continue;
            const b = bot.blockAt(p);
            if (!b || b.name === "air" || !diggable(b)) continue;
            try {
              await pt(bot.dig(b), 8000, "stair-cut", () => bot.stopDigging());
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
    if (raised >= 5) {
      // sheltered on the pillar: the reflex would pathfinder-walk off the
      // edge to reach a mob it sees below — park it until we climb down.
      // +4 is NOT safe: a mob on a 1-block mound beside the base still melees
      // the top (zombie reach ~2.5 — the on-pillar death at y55 ran exactly
      // this). Require +5; short material -> relocate and gather instead of
      // waiting inside reach
      // launchpad clear: a solid lateral cell at top level (or one below) is
      // a step a mob jumps from onto the refuge — the y69 on-pillar zombie
      // death came off a same-height hillside/wall. Dig each bridge-in cell;
      // capped so a cliff face doesn't turn this into a mining session
      {
        const tf = bot.entity.position.floored();
        let cut = 0;
        for (let lo = 1; lo <= 2 && cut < 10; lo += 1) {
          for (const [lx, lz] of [
            [lo, 0],
            [-lo, 0],
            [0, lo],
            [0, -lo],
            [lo, lo],
            [lo, -lo],
            [-lo, lo],
            [-lo, -lo],
          ]) {
            for (const dy of [-1, -2]) {
              const lb = bot.blockAt(tf.offset(lx, dy, lz));
              if (!lb || lb.name === "air" || !diggable(lb)) continue;
              try {
                await pt(bot.dig(lb), 8000, "launchpad-cut", () => bot.stopDigging());
                cut += 1;
              } catch {
                /* out of reach — leave it */
              }
              await sleep(120);
            }
          }
        }
        if (cut) log?.(`[burrow] cleared ${cut} launchpad cells beside the top`);
      }
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
          // the column hit the lip and can't wrap around it. Cardinals sit on
          // the column face; diagonals hang off a cardinal brim face — the
          // corner cells are what keep diagonal shooter angles closed
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
            for (const [bx, bz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
              const cell = bot.blockAt(colB.position.offset(bx, 0, bz));
              if (cell && cell.name !== "air") continue;
              for (const [ax, az] of [
                [bx, 0],
                [0, bz],
              ]) {
                const base = bot.blockAt(colB.position.offset(ax, 0, az));
                if (!base || base.name === "air") continue;
                const s = refugeSolid();
                if (!s) break;
                try {
                  await pt(bot.equip(s, "hand"), 6000, "equip");
                  await pt(bot.placeBlock(base, new Vec3(bx - ax, 0, bz - az)), 6000, "placeBlock");
                  break;
                } catch {
                  /* refused — try the other cardinal base */
                }
                await sleep(120);
              }
            }
          }
          // brim verify: a refused cardinal cell usually means a spider is
          // climbing THAT face (its body occupies the cell). Knock it off,
          // retry — a gap here is exactly the on-pillar spider death.
          {
            const colNow = hasTop();
            const spiderNear = Object.values(bot.entities || {}).some(
              (e) =>
                e?.position &&
                e !== bot.entity &&
                /spider/.test(String(e.name || "").toLowerCase()) &&
                e.position.distanceTo(bot.entity.position) < 40
            );
            if (colNow && spiderNear) {
              for (let pass = 0; pass < 3; pass++) {
                let open = 0;
                for (const [bx, bz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                  const cell = bot.blockAt(colNow.position.offset(bx, 0, bz));
                  if (cell && cell.name !== "air") continue;
                  open += 1;
                  // clear the climber occupying the gap before retrying
                  const hugger = Object.values(bot.entities || {}).find(
                    (e) =>
                      e?.position &&
                      e !== bot.entity &&
                      /spider/.test(String(e.name || "").toLowerCase()) &&
                      e.position.distanceTo(colNow.position.offset(bx, 0, bz)) < 2.2
                  );
                  if (hugger) {
                    try {
                      await bot.attack(hugger);
                    } catch {
                      /* out of reach — place anyway */
                    }
                    await sleep(350);
                  }
                  const s = refugeSolid();
                  if (!s) break;
                  try {
                    await pt(bot.equip(s, "hand"), 6000, "equip");
                    await pt(bot.placeBlock(colNow, new Vec3(bx, 0, bz)), 6000, "placeBlock");
                  } catch {
                    /* still refused */
                  }
                  await sleep(150);
                }
                if (!open) break;
              }
              const gaps = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([bx, bz]) => {
                const c = bot.blockAt(colNow.position.offset(bx, 0, bz));
                return !c || c.name === "air";
              }).length;
              log?.(`[burrow] brim ${gaps ? `gap x${gaps}` : "sealed"} vs spider`);
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
              // roof only on cardinal walls — the diagonal inward face lands
              // on the column the bot stands on and gets refused anyway
              if (!wx || !wz) {
                const s = refugeSolid();
                if (s) {
                  try {
                    await pt(bot.equip(s, "hand"), 6000, "equip");
                    await pt(bot.placeBlock(wall, new Vec3(-wx, 0, -wz)), 6000, "placeBlock");
                  } catch {
                    /* roof refused — wall alone still blocks arrows */
                  }
                }
              }
              return true;
            }
            return false;
          };
          const wallDirs = (h) => {
            const dx = h.position.x - bot.entity.position.x;
            const dz = h.position.z - bot.entity.position.z;
            const ddx = Math.sign(dx);
            const ddz = Math.sign(dz);
            const axes = [];
            // a host sitting on the diagonal plinks through the corner gap
            // between cardinal walls — wall the corner cell itself first,
            // then the two cardinals flanking it
            if (
              ddx &&
              ddz &&
              Math.min(Math.abs(dx), Math.abs(dz)) > Math.max(Math.abs(dx), Math.abs(dz)) * 0.5
            ) {
              axes.push([ddx, ddz]);
            }
            if (Math.abs(dx) >= Math.abs(dz) * 0.5 && ddx) axes.push([ddx, 0]);
            if (Math.abs(dz) >= Math.abs(dx) * 0.5 && ddz) axes.push([0, ddz]);
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
            for (const [wx, wz] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
              [1, 1],
              [1, -1],
              [-1, 1],
              [-1, -1],
            ]) {
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
        // phantom cap: a block directly overhead at feet+2 breaks canSeeSky —
        // phantoms neither spawn against a covered player nor dive through it.
        // Any cardinal raiseWall already drops a roof inward, so only build
        // when the cell above is still open sky
        try {
          const over = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
          if (!over || over.name === "air") {
            for (const [wx, wz] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              if (await raiseWall(wx, wz)) {
                walled.add(`${wx},${wz}`);
                log?.("[burrow] refuge roof up — phantom cap");
                break;
              }
            }
          }
        } catch {
          /* cap best-effort — the pillar itself still stands */
        }
        const t0 = Date.now();
        let lastBeat = 0;
        const refugeTop = bot.entity.position.clone();
        // the cap is an escape valve, not an unseal trigger: when it lands
        // inside dusk/night, climbing down dumps the bot into the mob pack
        // below — hold the pillar until real dawn (safe() only passes at
        // tod<9500), same rule as the pocket wait
        while (
          !safe() &&
          (Date.now() - t0 < 620000 ||
            ((bot.time?.timeOfDay ?? 0) >= 9500 && Date.now() - t0 < 800000))
        ) {
          if (state?._diedAt && Date.now() - state._diedAt < 6000) {
            log?.("[burrow] died on the pillar — aborting shelter");
            return false;
          }
          // died mid-wait past the 6s window (loop was mid-await at respawn)
          // or got knocked off: a bot >8m from the refuge top is no longer in
          // its shelter — bail instead of holding till dawn at spawn
          if (bot.entity.position.distanceTo(refugeTop) > 8) {
            log?.("[burrow] off the pillar — aborting shelter");
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
          // a mob that reaches the top column — climbed a mound/leftover
          // stair — is inside melee; hit it back before it knocks us off
          const camper = findHostile(bot, 4.5);
          if (camper) {
            try {
              const wpn = bot.inventory.items().find((i) => /sword|_axe/.test(i.name));
              if (wpn && !/sword|_axe/.test(bot.heldItem?.name || "")) {
                await pt(bot.equip(wpn, "hand"), 4000, "eq");
              }
              await pt(bot.attack(camper), 6000, "attack");
            } catch {
              /* out of reach — keep waiting */
            }
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
          log?.(`[burrow] exit sprint away from ${waiter.name}`);
          bot.setControlState("sprint", true);
          bot.setControlState("forward", true);
          bot.setControlState("jump", false);
          const t0 = Date.now();
          while (Date.now() - t0 < 2000) {
            bot.look(fleeYaw(bot), 0, true);
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
    // a hostile that can reach the mouth before the cap lands simply paths
    // down the open shaft and shares the 1x1 — unwinnable. Bail while the
    // hole is still shallow enough to step out of (dug<=1) and let the
    // reflex make space before the next shelter attempt
    if (dug <= 1) {
      const close = Object.values(bot.entities || {}).find((e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || "").toLowerCase();
        if (!/zombie|creeper|spider|husk|drowned|vex|slime|skeleton|stray|witch|pillager/.test(n)) return false;
        const dx = e.position.x - (feet.x + 0.5);
        const dz = e.position.z - (feet.z + 0.5);
        return Math.abs(dx) < 7 && Math.abs(dz) < 7 && e.position.y > feet.y - 1;
      });
      if (close) {
        log?.(`[burrow] ${close.name} too close to shaft mouth — aborting dig`);
        return false;
      }
    }
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
    // ranged cover for the carve: a skeleton with line of sight shoots
    // through the whole ~20-30s pocket dig — the repeated mid-carve kills at
    // one site. Same answer as the pillar path: a 3-high wall on the
    // shooter's bearing, then carve behind it.
    if (!sealedCells) {
      const carveShooter = Object.values(bot.entities || {})
        .filter(
          (e) =>
            e?.position &&
            /skeleton|stray|witch|pillager|drowned|phantom|blaze|ghast|shulker/.test(String(e.name || "")) &&
            e.position.distanceTo(bot.entity.position) < 32
        )
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (carveShooter) {
        const feet0 = bot.entity.position.floored();
        const vx = carveShooter.position.x - bot.entity.position.x;
        const vz = carveShooter.position.z - bot.entity.position.z;
        const [bx, bz] = Math.abs(vx) >= Math.abs(vz) ? [Math.sign(vx) || 1, 0] : [0, Math.sign(vz) || 1];
        const solid0 = refreshSolid();
        if (solid0) {
          try {
            await pt(bot.equip(solid0, "hand"), 6000, "equip-wall");
            for (let t = 0; t < 10 && !bot.heldItem; t += 1) await sleep(80);
            if (bot.heldItem) {
              let up = false;
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
                up = true;
              }
              if (up) log?.("[burrow] LOS wall vs ranged camper — carving behind it");
            }
          } catch {
            /* wall best-effort */
          }
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
        // side-leak: the corridor's LATERAL walls and the cell behind the
        // far end must be solid too. A pocket carved through a thin ridge
        // (tunnel wall) exits into a cave/open air at its back or sides —
        // an unplugged doorway the front seal never covers. The skeleton
        // that killed inside a "sealed" depth-4 pocket shot through exactly
        // this gap. Null blocks (unloaded) count as leaks — conservative.
        const perp = px !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
        const OPEN = /air|cave_air|void_air|water|bubble|kelp|seagrass|lava/;
        let leak = false;
        for (let i = 2; i <= depth + 1 && !leak; i += 1) {
          const ends = i === depth + 1 ? [[0, 0]] : perp;
          for (const [qx, qz] of ends) {
            for (const dy of [0, 1]) {
              const s = bot.blockAt(feet.offset(px * i + qx, dy, pz * i + qz));
              if (!s || OPEN.test(s.name)) {
                leak = true;
                break;
              }
            }
            if (leak) break;
          }
          // corridor floor under interior cells: never carved, assumed solid
          // — a hidden cave below opens a trapdoor in the middle of the pocket
          if (!leak && i <= depth) {
            const fl = bot.blockAt(feet.offset(px * i, -1, pz * i));
            if (!fl || OPEN.test(fl.name)) leak = true;
          }
          // ceiling cap at dy+2: never carved either, so hillside terrain
          // keeps it solid — but where a cave/hollow crosses overhead it is
          // an open chimney: a zombie fell through exactly this gap into a
          // sealed depth-4 pocket and killed inside
          if (!leak && i <= depth) {
            const cl = bot.blockAt(feet.offset(px * i, 2, pz * i));
            if (!cl || OPEN.test(cl.name)) leak = true;
          }
        }
        if (leak) {
          sealMiss("side-leak");
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
          if (creeperClose()) {
            // a bomb walked up mid-carve — bail before the next dig so the
            // reflex can kite it; carving into the blast is the spawn-camp
            // death loop
            log?.("[burrow] creeper closing — abandoning the carve");
            return false;
          }
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
        const extPerp = px !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
        const EXT_OPEN = /air|cave_air|void_air|water|bubble|kelp|seagrass|lava/;
        while (ext < 5) {
          const nxt = [
            bot.blockAt(feet.offset(px * (ext + 1), 0, pz * (ext + 1))),
            bot.blockAt(feet.offset(px * (ext + 1), 1, pz * (ext + 1))),
          ];
          if (nxt.some((c) => !diggable(c))) break;
          // deepening digs past the corridor the carve-time leak check
          // verified — an unchecked side/back hole is how a skeleton shot
          // into a 'sealed' pocket. Each extension cell must keep solid
          // lateral walls, a solid floor, and a solid-or-diggable cell
          // beyond it (the future far-end wall)
          let extLeak = false;
          for (const [qx, qz] of extPerp) {
            for (const dy of [0, 1]) {
              const s = bot.blockAt(feet.offset(px * (ext + 1) + qx, dy, pz * (ext + 1) + qz));
              if (!s || EXT_OPEN.test(s.name)) {
                extLeak = true;
                break;
              }
            }
            if (extLeak) break;
          }
          if (!extLeak) {
            const fl = bot.blockAt(feet.offset(px * (ext + 1), -1, pz * (ext + 1)));
            if (!fl || EXT_OPEN.test(fl.name)) extLeak = true;
          }
          // same chimney rule as the carve check: the dy+2 cap above the
          // extension must stay solid, or a cave overhead drops mobs in
          if (!extLeak) {
            const cl = bot.blockAt(feet.offset(px * (ext + 1), 2, pz * (ext + 1)));
            if (!cl || EXT_OPEN.test(cl.name)) extLeak = true;
          }
          if (!extLeak) {
            for (const dy of [0, 1]) {
              const s = bot.blockAt(feet.offset(px * (ext + 2), dy, pz * (ext + 2)));
              if (!s || EXT_OPEN.test(s.name)) {
                extLeak = true;
                break;
              }
            }
          }
          if (extLeak) break;
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
      // a depth-2 pocket leaves the far end ~2m off the single plug — inside
      // a zombie's swing (speedrun6 death #2: zombie@2m killed it mid-wait).
      // When the far wall couldn't be deepened, lay a SECOND wall on the
      // threshold cell — two full blocks between the mob and the bot's last
      // cell is geometrically out of melee reach
      const deepY = pocketDeep ? Math.hypot(pocketDeep.x - (feet.x + 0.5), pocketDeep.z - (feet.z + 0.5)) : carvedDepth;
      if (carvedDepth <= 2 && deepY <= 2.5 && solid?.name) {
        try {
          const mouth = feet.offset(0, 0, 0);
          const m1 = bot.blockAt(mouth);
          const m2 = bot.blockAt(mouth.offset(0, 1, 0));
          if (
            m1 && /air|cave_air|void_air/.test(m1.name) &&
            m2 && /air|cave_air|void_air/.test(m2.name)
          ) {
            const w1 = await executeAction(
              bot,
              { type: "place", item: solid.name, x: mouth.x, y: mouth.y, z: mouth.z, face: "top", timeoutMs: 6000 },
              mcData
            ).catch(() => ({ ok: false }));
            await sleep(180);
            const w2 = w1.ok
              ? await executeAction(
                  bot,
                  { type: "place", item: solid.name, x: mouth.x, y: mouth.y + 1, z: mouth.z, face: "top", timeoutMs: 6000 },
                  mcData
                ).catch(() => ({ ok: false }))
              : { ok: false };
            if (w2.ok) {
              sealedCells.push({ x: mouth.x, y: mouth.y, z: mouth.z }, { x: mouth.x, y: mouth.y + 1, z: mouth.z });
              log?.("[burrow] second wall on threshold — shallow pocket hardened");
            }
          }
        } catch {
          /* best-effort — shallow pocket still better than open ground */
        }
      }
      log?.(`[burrow] sealed pocket ${px},${pz} depth=${carvedDepth}`);
      // a dark sealed pocket is a legal vanilla spawn cell — anything can
      // materialize inside during the wait (death #1 on speedrun6 was a
      // zombie that spawned inside and beat the bot to death mid-wait).
      // Craft+place a torch inside when materials allow; the wait loop's
      // spawn-in fight covers the unlit case
      try {
        if (
          !bot.inventory.items().some((i) => i.name === "torch") &&
          countItem(bot, (i) => i.name === "coal" || i.name === "charcoal") > 0 &&
          countItem(bot, (i) => i.name === "stick") > 0
        ) {
          await ensureCraft(bot, mcData, "torch", 1).catch(() => {});
        }
        const torch = bot.inventory.items().find((i) => i.name === "torch");
        if (torch) {
          const mid = Math.max(1, Math.floor(carvedDepth / 2));
          const tp = await executeAction(
            bot,
            { type: "place", item: "torch", x: feet.x + px * mid, y: feet.y, z: feet.z + pz * mid, face: "top", timeoutMs: 6000 },
            mcData
          ).catch(() => ({ ok: false }));
          if (tp.ok) log?.("[burrow] pocket lit — spawn-proofed");
        }
      } catch {
        /* lighting best-effort */
      }
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
    // safe reads (each loop is ~4-16s) means the day is real.
    // A day-hide (or proactive dusk burrow) whose cap lands inside dusk or
    // night must NOT release at the cap — the exit would drop the bot into
    // the mob wave it dug in to avoid. The night-hold ceiling has to exceed
    // a full night measured from any seal phase: a day-hide that caps at
    // tod~23000 still needs ~10min to reach dawn, so share a generous
    // absolute ceiling (~one day-night cycle). safe() only releases on
    // real daylight — at night it can never fire, so the loop holds until
    // dawn unless the ceiling is hit (an escape valve for a broken safe()).
    let safeStreak = 0;
    // set when the camper-lockdown tunnel let us surface away from the seal
    // — the unseal/pillar exit below must NOT run: it would walk back into
    // the shaft the camper is sitting on.
    let tunnelEscape = false;
    while (
      Date.now() - t0 < waitCap ||
      (!safe() && (bot.time?.timeOfDay ?? 0) >= 9500 && Date.now() - t0 < 1200000)
    ) {
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
      // >8m out can't still be inside a ≤4-deep pocket — the bot died and
      // respawned elsewhere (the 6s diedAt check misses when the loop was
      // mid-await), or it got ejected. The pin-back goto would retry "no
      // path" on an unreachable sealed cell until the 20min ceiling
      if (away > 8) {
        log?.(`[burrow] left the pocket (${away.toFixed(0)}m away) — aborting shelter`);
        return false;
      }
      if (away > 1.2) {
        await executeAction(
          bot,
          { type: "goto", x: pocketDeep.x, y: pocketDeep.y, z: pocketDeep.z, range: 0.4, timeoutMs: 6000 },
          mcData
        ).catch(() => {});
      }
    }
    // a camper at the open shaft mouth is in melee reach of the bottom —
    // swing at it every loop instead of turtling forever. And a sealed dark
    // pocket is a legal vanilla spawn cell: anything that materializes
    // inside is within reach, so swing even bare-handed — cornered beats
    // standing still while it kills us
    const camper = findHostile(bot, 5);
    const wpn = bot.inventory.items().find((i) => /sword|_axe/.test(i.name));
    if (camper) {
      try {
        if (wpn && !/sword|_axe/.test(bot.heldItem?.name || "")) {
          await pt(bot.equip(wpn, "hand"), 4000, "eq");
        }
        await pt(bot.attack(camper), 6000, "attack");
      } catch {
        /* out of reach — keep waiting */
      }
    }
    // pocket greenhouse: a sealed pocket is the only guaranteed-safe grow
    // space this world offers — till a floor cell, drop the seeds the
    // gather pass already collected, and let the night hold itself grow
    // food. Torch light inside the pocket meets the crop's 9+ requirement
    if (bot.food != null && bot.food <= 4 && !state._pocketFarmTried) {
      state._pocketFarmTried = true;
      const seeds2 = bot.inventory.items().find((i) => /_seeds$/.test(i.name));
      if (seeds2) {
        const fp3 = bot.entity.position.floored();
        outer: for (let dx = -2; dx <= 2; dx += 1) {
          for (let dz = -2; dz <= 2; dz += 1) {
            const soilCell = bot.blockAt(fp3.offset(dx, -1, dz));
            const cropCell = soilCell && bot.blockAt(fp3.offset(dx, 0, dz));
            if (!soilCell || !cropCell) continue;
            if (!/^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|farmland)$/.test(soilCell.name)) continue;
            if (cropCell.name !== "air") continue;
            // crops need light 9+ — torch light or daylight both count
            if ((cropCell.light ?? 0) < 9 && (cropCell.skyLight ?? 0) < 9) continue;
            if (soilCell.name !== "farmland") {
              let hoe = bot.inventory.items().find((i) => /_hoe$/.test(i.name));
              if (!hoe) {
                await ensureCraft(bot, mcData, "wooden_hoe", 1).catch(() => null);
                hoe = bot.inventory.items().find((i) => /_hoe$/.test(i.name));
              }
              if (!hoe) continue;
              try {
                await bot.equip(hoe, "hand");
                await pt(bot.activateBlock(soilCell), 4000, "till");
              } catch {
                continue;
              }
            }
            const tilledNow = bot.blockAt(soilCell.position);
            if (tilledNow?.name !== "farmland") continue;
            try {
              await bot.equip(seeds2, "hand");
              await pt(bot.activateBlock(tilledNow), 4000, "plant");
              state.pocketFarm = true;
              log?.(`[burrow] pocket farm planted @${soilCell.position.x},${soilCell.position.z}`);
              break outer;
            } catch {
              /* plant best-effort */
            }
          }
        }
      }
    }
    // camper lockdown: a non-burning mob parked on the plug keeps safe()
    // false for the whole day — the loop would hold to the 20min ceiling
    // and release at NIGHT straight on top of it. In real daylight, tunnel
    // out the side instead: strip a 1x2 away from the camper and stair up
    // to the surface ~10m off. The cap/seal stays intact above, so the
    // camper can't follow through the shaft it is camping.
    const todNow = bot.time?.timeOfDay ?? -1;
    const lockdownMob = findHostile(bot, 14);
    if (
      pocketDeep &&
      lockdownMob &&
      todNow > 1000 &&
      todNow < 11000 &&
      Date.now() - t0 > 200000
    ) {
      const fp = bot.entity.position;
      const cp = lockdownMob.position;
      const awayDir =
        Math.abs(cp.x - fp.x) > Math.abs(cp.z - fp.z)
          ? [-Math.sign(cp.x - fp.x), 0]
          : [0, -Math.sign(cp.z - fp.z)];
      log?.(`[burrow] camper lockdown (${lockdownMob.name}) — tunneling out`);
      const mined = await stripMine(bot, mcData, 10, log, awayDir).catch(() => 0);
      const up = mined > 2 && (await stairwayUp(bot, mcData, 10, log).catch(() => false));
      if (up) {
        log?.("[burrow] tunneled out clear of the camper");
        tunnelEscape = true;
        break;
      }
      // tunnel failed — the seal above is intact, keep holding
    }
  }
  // campers re-close during the ~15s climb-out — hold the pocket until the
  // mouth is clear (or ~2min passes) before breaking the seal
  const tHold = Date.now();
  while (!tunnelEscape && findHostile(bot, 10) && Date.now() - tHold < (force ? 30000 : 120000)) {
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
  if (sealedCells?.length && !tunnelEscape) {
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
  if (solid && !tunnelEscape) {
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
      const yaw = w ? fleeYaw(bot) : bot.entity.yaw;
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
  // raw chicken carries the hunger effect and isn't counted edible — skip it.
  // Same walk-chase ceiling as the hunt: food<=6 can't sprint, and fleeing
  // livestock outruns a walk — only the chicken is catchable on foot.
  const stockPrey = bot.food > 6 ? ["cow", "pig", "sheep", "rabbit"] : ["chicken"];
  for (const prey of stockPrey) {
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
      (bot.food <= 8 ? bot.inventory.items().find((i) => /chicken/.test(i.name)) : null) ||
      // last resort: rotten flesh restores 4 — the 80% hunger effect still nets
      // positive when the alternative is food=0 at 1hp (it was counted edible
      // for stock/scavenge but the eat loop never touched the carried stack)
      (bot.food <= 8 ? bot.inventory.items().find((i) => i.name === "rotten_flesh") : null);
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
    // wool is bed material — a scavenge walk that also banks wool turns the
    // next dusk burrow into a bed-claim instead of a 9.5min pocket sit-out.
    // string converts 4:1 into wool — spiders are everywhere a sheep isn't
    "string",
    ...Object.keys(mcData.itemsByName || {}).filter((n) => /_wool$/.test(n)),
  ]);
  // starving widens the scavenge net: dawn-burned zombies drop rotten_flesh
  // within ~30m of a night spot, and 12m misses all of it — free calories
  // rotting on the ground while the bot starved at food=0.
  const dropReach = starving ? 30 : 12;
  if (drop && drop.position.distanceTo(bot.entity.position) <= dropReach) {
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
  // farm: the only food source that is self-sufficient on ANY seed — a
  // wheat row beside water. Harvest/bread are cheap when the plot exists;
  // laying it out costs a hoe when seeds+water are already close.
  if (state) {
    const farm = await farmTend(bot, mcData, log, state).catch(() => null);
    if (farm?.ate) return { ok: true, ate: true, message: "farm" };
  }
  // surface check first: every hunt target is a surface animal — chasing one
  // from y=35 means pathing through 40m of rock until the 26s timeout (the
  // underground "combat timeout 0 hits" loop). Underground hunts always miss.
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
  // zombie meat only pays off when a real weapon ends the fight in a few
  // swings — bare fists need 20 hits while it deals ~3/hit back (the
  // starving-bare-handed "hunt zombie, lose to 6hp, skeleton finishes" loop).
  // And only when a zombie is actually close and near our level: tracking
  // range means a stalker walks to us anyway, while a zombie 30m below in a
  // cave just burns the 26s timeout at 0 hits (the starving-in-pocket loop —
  // four straight zombie timeouts while the stash sat 57m away).
  const meForZombie = bot.entity.position;
  const zombieReachable = Object.values(bot.entities || {}).some((e) => {
    if (!e?.position || e === bot.entity || e.name !== "zombie") return false;
    const d = e.position.distanceTo(meForZombie);
    return d < 28 && Math.abs(e.position.y - meForZombie.y) < 10;
  });
  const armedForZombie =
    zombieReachable && bot.inventory.items().some((i) => /sword|_axe/.test(i.name));
  // sprint needs food>6, so a starving bot can only walk-chase. Livestock
  // panic-flees in bursts then pauses — the walk closes during pauses, so a
  // single bounded chase is worth it when nothing else is huntable. Rabbits
  // juke continuously and stay pointless at walk speed.
  const canSprint = bot.food > 6;
  // cod/salmon are shore-only prey: the attack can't path to a fish below
  // the waterline from land, so from a dry spawn they are guaranteed 0-hit
  // timeouts (two 26s burns per food window on speedrun6). Keep them only
  // when the bot is already in/near water depth.
  const feetWet = (() => {
    try {
      return bot.blockAt(bot.entity.position.floored())?.name === "water";
    } catch {
      return false;
    }
  })();
  const sitters = feetWet ? ["chicken", "cod", "salmon"] : ["chicken"];
  // livestock panic-flees ~5m/s — a starving walk (4.3m/s) never closes:
  // three straight 26s chases on speedrun6 landed 0 hits. Without sprint
  // the fleet list is pure burn; only a chicken's ~3m/s flee is walkable.
  // Rabbits stay sprint-only: their jukes never end inside a walk budget.
  const fleet = canSprint ? ["cow", "pig", "sheep", "rabbit"] : [];
  const preyList = [...sitters, ...fleet].concat(
    starving && !fragile && armedForZombie ? ["zombie"] : []
  );
  // day only: night hunting is walking through the spawn field at the one
  // hour it's full — a chicken at 55m is not worth the zombie at 14m
  const surfaceDaylight = (bot.time?.timeOfDay ?? 0) < 12541;
  for (const prey of canSeeSky && surfaceDaylight ? preyList : []) {
    if (bot.food >= 12) break;
    // rabbits are a lottery ticket, not a strategy — they juke faster than a
    // hungry walk catches, so one shorter chase is the whole attempt
    // (speedrun6 burned ~2.5min on five straight 26s rabbit timeouts, 0 hits)
    const tries = prey === "rabbit" ? 1 : canSprint ? 3 : sitters.includes(prey) ? 3 : 1;
    // a starving walk catches sitters only when they stop — the chase is
    // marginal, so cap it short and let the loop try the next food source.
    // Except a chicken 50m out takes ~12s of walk just to reach — 14s
    // budgets timed out at 0 hits twice on speedrun6
    // bare-handed kills take ~10 swings — a cow/pig lands 8 hits inside
    // 14s then times out mid-kill (speedrun6 pig hunt). Starving chases
    // get the full 26s; rabbits keep the short lottery ticket.
    const chaseMs = prey === "rabbit" ? 12000 : 26000;
    for (let i = 0; i < tries && bot.food < 12; i++) {
      const r = await executeAction(
        bot,
        // a hungry bot can't sprint — walking the 40m gap takes ~20s of
        // chase. maxDistance=60: entity render range is ~64m, so animals at
        // 48-60m are the ONLY prey a starving basin bot ever sees — the
        // food=0 pocket loop logged "no safe target nearby: chicken" while
        // four chickens sat at ~55m.
        { type: "attack", name: prey, maxDurationMs: chaseMs, maxDistance: 60, persistent: true },
        mcData
      ).catch(() => ({ ok: false }));
      if (!r.ok) {
        log?.(`[food] hunt ${prey} failed: ${r?.message || "no target"}`);
        break;
      }
      await sleep(400);
      // a sheep kill drops wool beside the mutton — walk over it so the next
      // burrow call has the 3 wool for a bed (skips the whole night)
      if (prey === "sheep") {
        const wd = droppedItemEntity(
          bot,
          mcData,
          Object.keys(mcData.itemsByName || {}).filter((n) => /_wool$/.test(n))
        );
        if (wd && wd.position.distanceTo(bot.entity.position) < 16) {
          await executeAction(
            bot,
            { type: "goto", x: Math.floor(wd.position.x), y: Math.floor(wd.position.y), z: Math.floor(wd.position.z), range: 1, timeoutMs: 6000 },
            mcData
          ).catch(() => ({ ok: false }));
        }
      }
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
  // underground starving: same zombie hunt without the sky gate — in a
  // mob-dense cave the mob IS the pantry (zombies drop rotten_flesh, +4
  // food each). Walled-off zombies fail the pathing fast; still needs a
  // real weapon and hp, same gates as the surface hunt
  if (starving && !fragile && armedForZombie && !canSeeSky && bot.food < 12) {
    const r = await executeAction(
      bot,
      { type: "attack", name: "zombie", maxDurationMs: 26000, maxDistance: 60, persistent: true },
      mcData
    ).catch(() => ({ ok: false }));
    if (r.ok) {
      await sleep(400);
      const fl = droppedItemEntity(bot, mcData, ["rotten_flesh"]);
      if (fl && fl.position.distanceTo(bot.entity.position) < 16) {
        await executeAction(
          bot,
          { type: "goto", x: Math.floor(fl.position.x), y: Math.floor(fl.position.y), z: Math.floor(fl.position.z), range: 1, timeoutMs: 6000 },
          mcData
        ).catch(() => {});
      }
      return { ok: true, ate, message: "underground zombie hunt" };
    }
    log?.(`[food] underground zombie hunt failed: ${r?.message || "no target"}`);
  }
  // mushroom stew: red+brown mushrooms grow in the dark — the caves this
  // bot keeps descending through are full of them, and a stew is +6 food
  // with no chase and no daylight needed. Two digs + table + 3 planks is
  // the whole pipeline; it works starving on the surface too
  if (bot.food < 12) {
    const want = ["red_mushroom", "brown_mushroom"];
    const found = {};
    try {
      const mbs =
        bot.findBlocks?.({
          matching: (b) => b && /^(red|brown)_mushroom$/.test(b.name || ""),
          maxDistance: 40,
          count: 20,
        }) || [];
      for (const v of mbs) {
        const nm = bot.blockAt?.(v)?.name;
        if (nm && !found[nm]) found[nm] = v;
      }
    } catch {
      /* scan failed */
    }
    if (found.red_mushroom && found.brown_mushroom) {
      log?.("[food] mushroom pair — brewing stew");
      for (const nm of want) {
        const v = found[nm];
        await executeAction(bot, { type: "dig", x: v.x, y: v.y, z: v.z, timeoutMs: 12000 }, mcData).catch(() => ({ ok: false }));
      }
      if (countItem(bot, "red_mushroom") >= 1 && countItem(bot, "brown_mushroom") >= 1) {
        await ensurePlanks(bot, mcData, 3).catch(() => {});
        if (countItem(bot, "bowl") < 1) await ensureCraft(bot, mcData, "bowl", 4).catch(() => ({ ok: false }));
        if (countItem(bot, "bowl") >= 1) {
          const stew = await ensureCraft(bot, mcData, "mushroom_stew", 1).catch(() => ({ ok: false }));
          if (stew.ok) {
            const e = await executeAction(bot, { type: "eat", item: "mushroom_stew", timeoutMs: 12000 }, mcData).catch(() => ({ ok: false }));
            if (e.ok) {
              ate = true;
              return { ok: true, ate, message: "mushroom stew" };
            }
          }
        }
      }
    }
  }
  // nothing edible in range — starve-walk: animals render within a few
  // chunks, so keep moving along one heading until something spawns.
  // Underground it can only time out — no animals spawn below ground, and a
  // wander goto just crashes into rock; keep working hungry instead.
  if (bot.food <= 4 && state && canSeeSky && (bot.time?.timeOfDay ?? 0) < 12541) {
    // a stash chest IS food — the restart kit stocks bread/meat. Raid the
    // nearest recorded chest before wandering blind for a herd (speedrun6
    // starved in a shelter loop at food=0 for ~40min with a full kit 60m away).
    // DAY ONLY: the tod<12541 gate keeps the 135m night raid (skeleton death
    // #4) from walking through dark hostile terrain — at night starving's
    // answer is a burrow, not a hike
    if (Date.now() - (state.stashFoodAt || 0) > 300000) {
      const me = bot.entity.position;
      const camps = campZonesFor(bot, state);
      const nearStash = stashLoadFile(bot)
        .map((p) => ({ p, d: Math.hypot(p.x - me.x, p.z - me.z) }))
        // a chest inside a kill ring is bait only when the WALK crosses the
        // camp — a near stash (<45m) is at the pocket's own door where the
        // run already lives; at hp=1 that hop is nearly free (death-zones
        // sit exactly where burrows get sealed, so the camp filter was
        // blacklisting every stash the starving run could actually reach)
        .filter((e) => e.d > 12 && e.d < 160 && (e.d < 45 || !posInCamp(e.p, camps)))
        .sort((a, b) => a.d - b.d)[0];
      if (nearStash) {
        state.stashFoodAt = Date.now();
        log?.(`[food] starving — raiding stash @${nearStash.p.x},${nearStash.p.z} (${Math.round(nearStash.d)}m)`);
        const rec = await stashRecover(bot, mcData, log, state);
        log?.(`[food] stash raid: ${rec.message || rec.ok}`);
        if (rec.ok) return { ok: true, ate, message: "stash raid" };
      }
    }
    // village raid: a village signature (villager/hay bale/workstation block)
    // is a guaranteed bread basket — free wheat, no fighting, no sprint
    // needed. At food=0 the hunt is dead anyway (can't chase without sprint),
    // so this is the only pipeline that still works at hp=1
    {
      let villPos = null;
      for (const e of Object.values(bot.entities || {})) {
        if (!e?.position || e === bot.entity) continue;
        const n = String(e.name || e.displayName || "").toLowerCase();
        // exact names only: "zombie_villager" contains "villager" and a
        // wandering_trader isn't a bread basket either — both dragged raids
        // onto hostile ground (the deep-cave zombie_villager at 93m that
        // read as "village signature 100m" for hours)
        if ((n === "villager" || n === "iron_golem") && e.position.distanceTo(bot.entity.position) < 130) {
          villPos = e.position;
          break;
        }
      }
      if (!villPos) {
        try {
          const vb = bot.findBlocks?.({
            matching: (b) => b && /hay_block|composter|bell|lectern|fletching_table|cartography_table|smithing_table|brewing_stand/.test(b.name || ""),
            maxDistance: 96,
            count: 1,
          });
          if (vb?.length) villPos = vb[0];
        } catch {
          /* scan failed — no village */
        }
      }
      // a signature inside a proven-empty village's ring is bait, not a lead:
      // drop it so it neither sets a steer hint nor re-triggers a raid
      if (
        villPos &&
        (state.villageDead || []).some((v) => Date.now() - v.at < 1800000 && Math.hypot(v.x - villPos.x, v.z - villPos.z) < 80)
      ) {
        villPos = null;
      }
      // remember the last signature — the starve-walk steers toward it so
      // wandering isn't blind (a raid needs the signature back in range)
      if (villPos) state.villageHint = { x: villPos.x, z: villPos.z, at: Date.now() };
      if (villPos && Date.now() - (state.villageRaidAt || 0) > 300000) {
        state.villageRaidAt = Date.now();
        state.villageHint = null; // raid settles it — don't magnet the wander back
        const vd = villPos.distanceTo ? Math.round(villPos.distanceTo(bot.entity.position)) : "?";
        log?.(`[food] village signature ${vd}m — raiding for bread`);
        await executeAction(
          bot,
          { type: "goto", x: Math.floor(villPos.x), y: Math.floor(villPos.y), z: Math.floor(villPos.z), range: 10, timeoutMs: 30000 },
          mcData
        ).catch(() => ({ ok: false }));
        // villages have beds in houses — steal one here even when the hay
        // hunt finds nothing: a claimed bed moves respawn out of the death
        // camp for good, which is worth more than the bread at food=0
        if (!bot.inventory.items().some((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name))) {
          try {
            const vb2 = bot.findBlock?.({
              matching: (b) => b && (bot.isABed?.(b) || b.name.endsWith("_bed")),
              maxDistance: 48,
            });
            if (vb2) {
              await executeAction(
                bot,
                { type: "goto", x: vb2.position.x, y: vb2.position.y, z: vb2.position.z, range: 3, timeoutMs: 15000 },
                mcData
              ).catch(() => {});
              const vb3 = bot.blockAt(vb2.position);
              if (vb3 && vb3.name.endsWith("_bed")) {
                await bot.dig(vb3).catch(() => {});
                await executeAction(
                  bot,
                  { type: "goto", x: vb2.position.x, y: vb2.position.y, z: vb2.position.z, range: 1, timeoutMs: 5000 },
                  mcData
                ).catch(() => {});
                if (bot.inventory.items().some((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name))) {
                  log?.("[food] village raid: stole a bed");
                }
              }
            }
          } catch {
            /* bed theft is best-effort */
          }
        }
        let hayDug = 0;
        for (let i = 0; i < 6; i++) {
          let hay = null;
          try {
            hay = bot.findBlock?.({ matching: (b) => b && b.name === "hay_block", maxDistance: 56 });
          } catch {
            /* none visible */
          }
          if (!hay) break;
          const d = await executeAction(
            bot,
            { type: "dig", x: hay.position.x, y: hay.position.y, z: hay.position.z, timeoutMs: 12000 },
            mcData
          ).catch(() => ({ ok: false }));
          if (!d.ok) break;
          hayDug++;
        }
        // village farms: mature crops drop the food items directly, so a
        // farm-only village still feeds a raid that found no hay at all
        const matureCrop = (b) => {
          if (!b) return false;
          const age = b._properties?.age;
          if (age == null) return false;
          if (b.name === "wheat" || b.name === "carrots" || b.name === "potatoes") return age >= 7;
          if (b.name === "beetroots" || b.name === "sweet_berry_bush") return age >= 3;
          return false;
        };
        let cropsDug = 0;
        for (let i = 0; i < 10; i++) {
          let crop = null;
          try {
            crop = bot.findBlock?.({ matching: matureCrop, maxDistance: 56 });
          } catch {
            /* none visible */
          }
          if (!crop) break;
          const d = await executeAction(
            bot,
            { type: "dig", x: crop.position.x, y: crop.position.y, z: crop.position.z, timeoutMs: 12000 },
            mcData
          ).catch(() => ({ ok: false }));
          if (!d.ok) break;
          cropsDug++;
          await sleep(150);
        }
        // village house chests carry bread/potatoes/apples — farmers keep
        // fields immature by replanting, so crops alone can leave a raid
        // empty; the chests are the guaranteed stock
        if (!state.villageLooted) state.villageLooted = new Set();
        let chestFood = 0;
        const lootKey = (pos) => `${pos.x},${pos.y},${pos.z}`;
        for (let c = 0; c < 3; c++) {
          let chs = [];
          try {
            chs =
              bot.findBlocks?.({
                matching: (b) => b && b.name === "chest" && !state.villageLooted.has(lootKey(b.position)),
                maxDistance: 48,
                count: 1,
              }) || [];
          } catch {
            /* scan failed */
          }
          if (!chs.length) break;
          const chPos = chs[0];
          state.villageLooted.add(lootKey(chPos));
          await executeAction(
            bot,
            { type: "goto", x: chPos.x, y: chPos.y, z: chPos.z, range: 3, timeoutMs: 10000 },
            mcData
          ).catch(() => {});
          const cb = bot.blockAt?.(chPos);
          if (!cb || cb.name !== "chest") continue;
          try {
            const cw = await pt(bot.openChest(cb), 8000, "village chest");
            let took = 0;
            for (const it of cw.containerItems()) {
              if (!EDIBLE_FOOD.test(it.name) && it.name !== "rotten_flesh") continue;
              await pt(cw.withdraw(it.type, it.metadata, it.count), 8000, "loot").catch(() => {});
              took += it.count;
            }
            cw.close();
            if (took) {
              chestFood += took;
              log?.(`[food] village raid: looted ${took} food from a house chest`);
            }
          } catch {
            /* unopenable — skip */
          }
        }
        // hay bales uncraft to 9 wheat each — the raid's real payload
        const hayHeld = countItem(bot, (i) => i.name === "hay_block");
        if (hayHeld > 0) {
          await ensureCraft(bot, mcData, "wheat", hayHeld).catch(() => ({ ok: false }));
        }
        if (countItem(bot, "wheat") >= 3) {
          const bc = await ensureCraft(bot, mcData, "bread", Math.floor(countItem(bot, "wheat") / 3)).catch(() => ({ ok: false }));
          if (bc.ok) log?.(`[food] baked bread — village raid paid`);
        }
        let raidFood = 0;
        for (let i = 0; i < 4 && bot.food < 19; i++) {
          const f = bot.inventory.items().find((i) => EDIBLE_FOOD.test(i.name));
          if (!f) break;
          const r = await executeAction(bot, { type: "eat", item: f.name, timeoutMs: 12000 }, mcData).catch(() => ({ ok: false }));
          if (r.ok) {
            ate = true;
            raidFood++;
          }
        }
        if (bot.food >= 8) return { ok: true, ate, message: "village raid" };
        // silent aborts hide the why — report what the raid actually found
        const inv = bot.inventory
          .items()
          .filter((i) => /wheat|hay|carrot|potato|bread|beetroot|apple|melon|cookie|berries/.test(i.name))
          .map((i) => `${i.name}x${i.count}`)
          .join(",");
        log?.(`[food] village raid empty — hay=${hayDug} crops=${cropsDug} chestFood=${chestFood} ate=${raidFood} inv=[${inv || "none"}]`);
        // a signature that yields nothing is bait: remember it as dead so
        // the next scan neither re-raids nor re-magnets the walk toward the
        // same empty field (speedrun6 steered to the same raided village 3x
        // right after an empty raid)
        state.villageDead = (state.villageDead || []).filter((v) => Date.now() - v.at < 1800000);
        state.villageDead.push({ x: Math.floor(villPos.x), z: Math.floor(villPos.z), at: Date.now() });
        if (state.villageDead.length > 6) state.villageDead.shift();
      }
    }
    const p = bot.entity.position.floored();
    // steer toward a remembered village signature: a blind spiral walks AWAY
    // from the one guaranteed food source half the time, while the walk to
    // the hint is what puts the signature back into raid range
    if (state.villageHint && Date.now() - state.villageHint.at < 1800000) {
      const hd = Math.hypot(state.villageHint.x - p.x, state.villageHint.z - p.z);
      if (hd < 60) state.villageHint = null; // signature itself re-fires inside raid range
      else {
        // pathfinder can't route a 90m target through unloaded chunks — walk
        // the direction in 40m legs, and give up on a hint that never yields
        const leg = Math.min(hd, 40);
        const r = await executeAction(
          bot,
          {
            type: "goto",
            x: Math.floor(p.x + ((state.villageHint.x - p.x) / hd) * leg),
            y: p.y,
            z: Math.floor(p.z + ((state.villageHint.z - p.z) / hd) * leg),
            range: 6,
            timeoutMs: 20000,
          },
          mcData
        ).catch(() => ({ ok: false }));
        if (!r.ok && (state.villageHintFails = (state.villageHintFails || 0) + 1) >= 3) {
          state.villageHint = null;
          state.villageHintFails = 0;
        }
        return { ok: true, ate, message: `starve-walk to village (${Math.round(hd)}m)` };
      }
    }
    // committed trek: after ~5 fruitless spiral legs the basin is proven
    // stripped — stop circling and run ONE bearing ~300m, same escape rule
    // the log wander uses. Bearings landing inside a death camp or a
    // proven-empty village are dropped, then the driest survivor wins.
    if ((state.foodWanderLeg || 0) >= 5 && !state.foodTrekDir) {
      const camps = campZonesFor(bot, state);
      const deadVills = state.villageDead || [];
      const bearings = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [-1, 1], [1, -1], [-1, -1],
      ];
      const safe = bearings.filter(([bx, bz]) => {
        const tx = p.x + bx * 300;
        const tz = p.z + bz * 300;
        if (camps.some((c) => Math.hypot(tx - c.x, tz - c.z) < 150)) return false;
        if (deadVills.some((v) => Date.now() - v.at < 1800000 && Math.hypot(tx - v.x, tz - v.z) < 120)) return false;
        return true;
      });
      const pick = pickDryDir(
        bot,
        (safe.length ? safe : bearings).map(([bx, bz]) => [bx * 300, bz * 300])
      );
      state.foodTrekDir = [Math.sign(pick[0]), Math.sign(pick[1])];
      state.foodTrekLegs = 5;
      state.foodWanderDir = null;
      log?.(`[food] basin stripped — trekking ${state.foodTrekDir} for ~300m`);
    }
    if (state.foodTrekLegs > 0) {
      const [bx, bz] = state.foodTrekDir;
      state.foodTrekLegs -= 1;
      if (!state.foodTrekLegs) {
        state.foodTrekDir = null;
        // arrived: spiral the NEW area first — another immediate trek would
        // ballistic-hop past whatever herd lives right here
        state.foodWanderLeg = 0;
        state.foodWanderDir = null;
      }
      const r = await executeAction(
        bot,
        { type: "goto", x: p.x + bx * 60, y: p.y, z: p.z + bz * 60, range: 6, timeoutMs: 30000 },
        mcData
      ).catch(() => ({ ok: false }));
      if (!r?.ok) {
        const moved = Math.hypot(bot.entity.position.x - p.x, bot.entity.position.z - p.z);
        if (moved < 24) {
          state.foodTrekLegs = 0;
          state.foodTrekDir = null;
        }
      }
      return { ok: true, ate, message: `food trek (leg ${state.foodTrekLegs})` };
    }
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
    // legs must COMPLETE inside the timeout: a 200m hop in 20s covers ~86m,
    // times out, and the catch below wipes the direction — the "spiral"
    // degenerated into direction-reset ping-pong inside the stripped basin.
    // 75m legs finish at walk speed and still expand the ring every 4 calls.
    const hop = Math.min(60 + Math.floor((state.foodWanderLeg - 1) / 4) * 20, 75);
    const r = await executeAction(
      bot,
      {
        type: "goto",
        x: p.x + Math.sign(state.foodWanderDir[0]) * hop,
        y: p.y,
        z: p.z + Math.sign(state.foodWanderDir[1]) * hop,
        range: 8,
        timeoutMs: 30000,
      },
      mcData
    ).catch(() => ({ ok: false }));
    // a leg that covered most of its ground is progress even when the goto
    // itself timed out — keep the spiral heading. Only a real stall (<40%
    // traveled: wall, water, unreachable) re-picks the direction.
    if (!r?.ok) {
      const moved = Math.hypot(bot.entity.position.x - p.x, bot.entity.position.z - p.z);
      if (moved < hop * 0.4) state.foodWanderDir = null;
    }
    return { ok: true, ate, message: "starve-walk" };
  }
  // starving underground: nothing edible spawns below the surface — climb
  // back up the stair toward daylight where animals/hunts actually exist,
  // instead of grinding on at 0.5hp until something touches us
  // day only: climbing out of a sealed pocket into the night mob field is
  // worse than starving below — the pocket holds until dawn, the field
  // doesn't (speedrun6 surfaced at tod=20727 into it)
  if (bot.food <= 4 && !canSeeSky && state && (bot.time?.timeOfDay ?? 0) < 12541 && Date.now() - (state.foodClimbFailAt || 0) > 120000) {
    const p0 = bot.entity.position.floored();
    log?.(`[food] starving underground — staircasing for surface (y=${Math.floor(bot.entity.position.y)})`);
    // breadcrumbs first: the corridor the bot came down through is already
    // open, so the newest sky-lit waypoint on the trail is walkable without
    // a single pickaxe swing — re-digging a staircase burned whole days
    {
      const skyWp = (state.trail || [])
        .slice()
        .reverse()
        .find((w) => w.sky);
      if (skyWp) {
        const w2 = await executeAction(
          bot,
          { type: "goto", x: skyWp.x, y: skyWp.y, z: skyWp.z, range: 4, timeoutMs: 16000 },
          mcData
        ).catch(() => ({ ok: false }));
        if (w2.ok || bot.entity.position.y > p0.y + 6)
          return { ok: true, ate, message: "climbed out along the trail" };
      }
    }
    // walking beats digging: the descent left a staircase behind it, and a
    // goto toward open air lets pathfinder reuse it — under a water cap the
    // diggers below can never finish, while the walked path is already
    // proven. Only a real climb counts; a 12s no-path timeout falls through
    // to the diggers
    const w = await executeAction(
      bot,
      { type: "goto", x: p0.x, y: p0.y + 18, z: p0.z, range: 4, timeoutMs: 12000 },
      mcData
    ).catch(() => ({ ok: false }));
    if (w.ok || bot.entity.position.y > p0.y + 6)
      return { ok: true, ate, message: "walked back up for food" };
    const up = await stairwayUp(bot, mcData, 14, log);
    if (up.ok || bot.entity.position.y > p0.y + 4) return { ok: true, ate, message: "ascend for food" };
    // staircase can't route from a sealed pocket — dig a straight 1x1 shaft:
    // every target is adjacent so pathfinding isn't needed, and the overhead
    // hazard scan keeps lava/water/gravel off our 1hp head. A shaft fail is
    // positional (gravel/water/lava overhead) — hop ~7m sideways and retry a
    // fresh column instead of idling the cooldown exposed at 1hp
    for (const [rdx, rdz] of [
      [0, 0],
      [7, 0],
      [-7, 0],
      [0, 7],
      [0, -7],
    ]) {
      if (rdx || rdz) {
        const q = bot.entity.position.floored();
        await executeAction(
          bot,
          { type: "goto", x: q.x + rdx, y: q.y, z: q.z + rdz, range: 2, timeoutMs: 9000 },
          mcData
        ).catch(() => {});
      }
      log?.(`[food] staircase stuck — shaft straight up (y=${Math.floor(bot.entity.position.y)})`);
      const sh = await shaftUp(bot, mcData, 56, log);
      if (sh.ok || bot.entity.position.y > p0.y + 4)
        return { ok: true, ate, message: "shaft for food" };
      // a hostile overhead-adjacent spot isn't worth a second column — keep hopping
      if (findHostile(bot, 8)) break;
    }
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
      // steal one first: a placed bed (village house) digs up as the item in
      // ~2s — the whole wool→planks→table→craft chain is ~90s and dies under
      // camper fire (three skeleton deaths mid-chain in the spawn basin).
      // Range mirrors the hunt reach — a bed 40m away beats crafting one.
      try {
        const steal = bot.findBlock({
          matching: (b) => b && (bot.isABed?.(b) || b.name.endsWith("_bed")),
          maxDistance: 48,
        });
        if (steal) {
          await executeAction(
            bot,
            { type: "goto", x: steal.position.x, y: steal.position.y, z: steal.position.z, range: 3, timeoutMs: 20000 },
            mcData
          ).catch(() => {});
          const b2 = bot.blockAt(steal.position);
          if (b2 && b2.name.endsWith("_bed")) {
            await bot.dig(b2).catch(() => {});
            // walk over the bed drop so it lands in inventory
            await executeAction(
              bot,
              { type: "goto", x: steal.position.x, y: steal.position.y, z: steal.position.z, range: 1, timeoutMs: 6000 },
              mcData
            ).catch(() => {});
            if (bedItem()) log?.("[bed] stole a placed bed");
          }
        }
      } catch {
        /* theft is best-effort — fall through to the wool chain */
      }
      // string is wool too: 4 string crafts 1 wool on the 2x2 grid, no table
      // needed — spiders are everywhere a sheep isn't (this basin had 18
      // zombies and zero sheep inside 140m)
      for (let s = 0; s < 6 && woolCount() < 3; s++) {
        const stringCt = countItem(bot, (i) => i.name === "string");
        if (stringCt < 4) break;
        const c = await ensureCraft(bot, mcData, "white_wool", 1).catch(() => ({ ok: false }));
        if (!c?.ok || countItem(bot, (i) => i.name === "string") >= stringCt) break;
        log?.(`[bed] string→wool (${woolCount()}/3)`);
      }
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
        // the drops spawn a tick or two AFTER the kill lands — an instant
        // scan sees an empty field and the wool sits there forever. Wait for
        // the drops, then walk over every item near the corpse (the mutton
        // beside the wool is free food anyway)
        await sleep(700);
        const drops = Object.values(bot.entities || {}).filter(
          (e) =>
            e?.position &&
            e !== bot.entity &&
            (e.item || /wool|item|mutton/.test(String(e.name || ""))) &&
            e.position.distanceTo(bot.entity.position) < 14
        );
        for (const drop of drops.slice(0, 4)) {
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
      // a bed placed inside the death camp anchors every future respawn to
      // the kill ring — the (50,-194) claim put respawns ~50m from two
      // recorded deaths and the night loop kept landing in the same bowl.
      // Carrying the bed out of the zone beats claiming it here
      const bedZones = campZonesFor(bot, state);
      if (posInCamp(p, bedZones, 100)) {
        log?.(`[bed] inside a death camp — carrying the bed out instead of claiming`);
        return { ok: false, message: "bed carried out of camp" };
      }
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
        // the bed's foot half lands one cell past the head, in the facing
        // direction — if that cell isn't air the place leaves "only half
        // bed" and sleep/claim both fail on it
        const foot = bot.blockAt(p.offset(px + Math.sign(px || 0), 0, pz + Math.sign(pz || 0)));
        const footUp = bot.blockAt(p.offset(px + Math.sign(px || 0), 1, pz + Math.sign(pz || 0)));
        if (foot?.name !== "air" || footUp?.name !== "air") continue;
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
  // a malformed bed ("only half bed") can never be slept in — break it so the
  // next ensureBed pass re-places it on a verified two-cell spot instead of
  // failing on the same broken block every night
  if (/half bed/i.test(s.message || "")) {
    try {
      const bb2 = bedBlock();
      if (bb2) await bot.dig(bb2);
      log?.("[bed] broke a malformed half-bed");
    } catch {
      /* leave it — next pass retries the place */
    }
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
  // Prefer small collect batches (less pathfinder thrash / OOM). Targets
  // inside a death camp are never collected — a visible trunk in the kill
  // ring is exactly what drags the bot back to its death site
  const campZones = campZonesFor(bot, state);
  const campFree = (b) => !posInCamp(b.position, campZones);
  const logCount = () => countItem(bot, CRAFTABLE_LOG);
  for (const b of logNames) {
    const before = logCount();
    const rr = await executeAction(
      bot,
      { type: "collect", block: b, count: 4, maxDistance: 32, filter: campFree },
      mcData
    );
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
      if (!campFree(blk)) return false;
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
        // committed trek: after enough fruitless spiral hops a rotating
        // 60m wander just ping-pongs inside the same treeless basin — run
        // ONE bearing ~300m instead. Direction = the bearing that lands
        // farthest from every dead log cell and death camp.
        state.exploreHops = state.exploreHops || 0;
        if (state.exploreHops >= 5 && !state.trekDir) {
          const camps = campZonesFor(bot, state);
          const deadCells = Object.keys(state.deadLogCells || {})
            .map((k) => k.split(",").map(Number))
            .filter((a) => a.length === 2);
          const bearings = [
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [-1, 1], [1, -1], [-1, -1],
          ];
          let bestScore = -1e9;
          for (const [bx, bz] of bearings) {
            const tx = p.x + bx * 300;
            const tz = p.z + bz * 300;
            let score = 0;
            for (const c of camps) {
              const d = Math.hypot(tx - c.x, tz - c.z);
              if (d < 150) score -= 10000;
            }
            for (const [dx, dz] of deadCells) {
              score += Math.min(Math.hypot(tx - dx * 32, tz - dz * 32), 400) / 400;
            }
            if (score > bestScore) {
              bestScore = score;
              state.trekDir = [bx, bz];
            }
          }
          if (!state.trekDir) state.trekDir = [1, 0];
          state.trekLegs = 5;
          state.wanderDir = null;
        }
        if (state.trekLegs > 0) {
          const [bx, bz] = state.trekDir;
          state.trekLegs -= 1;
          if (!state.trekLegs) state.trekDir = null;
          try {
            await executeAction(
              bot,
              { type: "goto", x: p.x + bx * 60, y: p.y, z: p.z + bz * 60, range: 5, timeoutMs: 25000 },
              mcData
            );
          } catch {
            state.trekLegs = 0;
            state.trekDir = null;
          }
          state.exploreHops += 1;
          state.noLogStreak = 1;
          return { ok: true, message: `trek for forest (leg ${state.trekLegs})` };
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
        // legs must fit the timeout: 200m in 25s covers ~107m then throws,
        // and the old catch wiped the heading — every late spiral leg ended
        // in a direction reset, so the "spiral" ping-ponged in place.
        const hop = Math.min(60 + Math.floor((state.wanderLeg - 1) / 4) * 20, 75);
        const wx = Math.sign(state.wanderDir[0]) * hop;
        const wz = Math.sign(state.wanderDir[1]) * hop;
        try {
          await executeAction(
            bot,
            { type: "goto", x: p.x + wx, y: p.y, z: p.z + wz, range: 5, timeoutMs: 30000 },
            mcData
          );
        } catch {
          /* blocked — re-pick only on a real stall, keep the heading if most of the leg still traveled */
          const moved = Math.hypot(bot.entity.position.x - p.x, bot.entity.position.z - p.z);
          if (moved < hop * 0.4) state.wanderDir = null;
        }
        state.noLogStreak = 1;
        state.exploreHops = (state.exploreHops || 0) + 1;
        return { ok: true, message: `exploring for trees (${hop}m)` };
      }
    }
    return { ok: false, message: "no log block nearby" };
  }
  if (state) {
    state.noLogStreak = 0;
    state.exploreHops = 0;
    state.trekDir = null;
    state.trekLegs = 0;
  }
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
      // visible but unreachable until the approach changes the space. A
      // trunk inside the death ring is a re-kill pull, never a gather target
      const cz = campZonesFor(bot, state);
      const t = bot.findBlock({
        matching: (b) => {
          const bp = b?.position ?? b;
          return b && b.name.endsWith("_log") && bp && !posInCamp(bp, cz);
        },
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
        // retrievable by walking — chasing it traps progression underground.
        // Floating drops get slack: they bob on the surface and are swim-to
        // retrievable well past the cave cutoff
        try {
          const wcell = bot.blockAt(e.position.floored());
          const floating = wcell && /water|kelp|seagrass|bubble/.test(wcell.name);
          if (e.position.y < bot.entity.position.y - (floating ? 20 : 8)) return false;
          const d = e.getDroppedItem?.();
          if (!d || !/log|planks|stick/.test(String(d.name || ""))) return false;
          return e.position.distanceTo(bot.entity.position) < 20;
        } catch {
          return false;
        }
      });
      if (drop) {
        const dcell = bot.blockAt(drop.position.floored());
        if (dcell && /water|kelp|seagrass|bubble/.test(dcell.name)) {
          // pathfinder won't path into water — swim steer over the drop
          await steerSwimTo(bot, drop.position.x, drop.position.z, 9000).catch(() => {});
        } else {
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
      if (state.floodZone) {
        const p = bot.entity.position.floored();
        if (Math.hypot(p.x - state.floodZone.x, p.z - state.floodZone.z) < state.floodZone.r) {
          // don't dig a staircase in a drowned basin — every column probed
          // here flooded. March to the zone edge first
          const dirs = [
            [80, 0],
            [-80, 0],
            [0, 80],
            [0, -80],
          ];
          const away = dirs
            .map(([dx, dz]) => [
              dx,
              dz,
              Math.hypot(p.x + dx - state.floodZone.x, p.z + dz - state.floodZone.z),
            ])
            .sort((a, b) => b[2] - a[2])[0];
          await executeAction(
            bot,
            { type: "goto", x: p.x + away[0], y: p.y, z: p.z + away[1], range: 4, timeoutMs: 15000 },
            mcData
          ).catch(() => {});
          return { ok: true, phase: "iron", message: "exiting flood basin" };
        }
      }
      const d = await stairDown(bot, mcData, 8, log);
      if (d.digs > 0) state.mobRelocates = 0;
      if (d.fluid) {
        // staircase drowned in a water/lava region even with digs>0 — count it
        // as a fluid strike so relocation escalates 14m → 48m. The iron death
        // at (-205,60,-147) was digs>0 'progress' through a swamp until a
        // drowned arrived
        state.fluidStrikes = (state.fluidStrikes || 0) + 1;
        const hop = state.fluidStrikes >= 3 ? 48 : 14;
        const p = bot.entity.position.floored();
        let dirs = [[hop, 0], [-hop, 0], [0, hop], [0, -hop]];
        // keep relocates out of a marked flood basin — it drowns every
        // column probed into it
        if (state.floodZone) {
          const out = dirs.filter(
            ([dx, dz]) =>
              Math.hypot(p.x + dx - state.floodZone.x, p.z + dz - state.floodZone.z) >=
              state.floodZone.r
          );
          if (out.length) dirs = out;
        }
        const [wx, wz] = dirs[Math.floor(Math.random() * dirs.length)];
        await executeAction(
          bot,
          { type: "goto", x: p.x + wx, y: p.y, z: p.z + wz, range: 3, timeoutMs: 12000 },
          mcData
        ).catch(() => {});
        return { ok: true, phase: "iron", message: `descend fluid — relocating ${wx},${wz} @y=${Math.floor(p.y)}` };
      }
      if (d.digs === 0) {
        // every direction may be mob-blocked — end the step so the combat
        // reflex clears the doorway before we try to dig through again
        const doorBlock = findHostile(bot, 10);
        if (doorBlock) {
          // a camper in melee reach — kill it instead of waiting on the
          // ~6m combat reflex; mobs inside the breached cave never wander
          // off the dig site on their own
          const near = findHostile(bot, 4);
          if (near) {
            try {
              const wpn = bot.inventory.items().find((i) => /sword|_axe/.test(i.name));
              if (wpn && !/sword|_axe/.test(bot.heldItem?.name || "")) {
                await pt(bot.equip(wpn, "hand"), 4000, "eq");
              }
              await pt(bot.attack(near), 6000, "attack");
            } catch {
              /* keep digging attempts going */
            }
          }
          state.mobDoorBlocks = (state.mobDoorBlocks || 0) + 1;
          if (state.mobDoorBlocks >= 4) {
            // every direction blocked for several steps means the stairway
            // opened into a mobbed cave — hop ~20m away from the hostile
            // centroid and restart the staircase there. Digging deeper here
            // (digStaircaseDown) just descends into the cluster.
            state.mobDoorBlocks = 0;
            const p = bot.entity.position;
            state.mobRelocates = (state.mobRelocates || 0) + 1;
            if (state.mobRelocates >= 3) {
              // every 20m hop lands back inside the same mob field — the whole
              // cave system is a spawn factory. Bail straight up to daylight
              // and let a fresh descent site start somewhere disconnected;
              // shaftUp now tunnels out from under water/gravel caps.
              state.mobRelocates = 0;
              const sh = await shaftUp(bot, mcData, 64, log);
              if (sh.ok || bot.entity.position.y > p.y + 20) {
                return {
                  ok: true,
                  phase: "iron",
                  message: `descend mob-field — bailed to surface @y=${Math.floor(bot.entity.position.y)}`,
                };
              }
            }
            const mobList = Object.values(bot.entities || {}).filter(
              (e) =>
                e?.position &&
                e !== bot.entity &&
                e.position.distanceTo(p) < 14 &&
                ((e.kind === "Hostile mobs" && e.name !== "enderman") ||
                  /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(
                    String(e.name || e.displayName || "").toLowerCase()
                  ))
            );
            if (mobList.length) {
              const cx = mobList.reduce((s, e) => s + e.position.x, 0) / mobList.length;
              const cz = mobList.reduce((s, e) => s + e.position.z, 0) / mobList.length;
              const vx = p.x - cx;
              const vz = p.z - cz;
              const [wx, wz] =
                Math.abs(vx) >= Math.abs(vz) ? [Math.sign(vx) || 1, 0] : [0, Math.sign(vz) || 1];
              await executeAction(
                bot,
                { type: "goto", x: p.x + wx * 20, y: p.y, z: p.z + wz * 20, range: 3, timeoutMs: 15000 },
                mcData
              ).catch(() => {});
              return {
                ok: true,
                phase: "iron",
                message: `descend mobbed — relocating ${wx * 20},${wz * 20} @y=${Math.floor(p.y)}`,
              };
            }
          }
          return { ok: true, phase: "iron", message: `descend door-blocked y=${y}` };
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
      if (!shifted) {
        // every adjacent column is capped too — the bot is under a water ring
        // or gravel bed; the only way up is sideways under land first. Dig a
        // 1x2 horizontal tunnel, re-scanning overhead after each cell; stop the
        // moment a clean column appears and let the main loop take the shaft.
        tunnel: for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          for (let t = 0; t < 10; t++) {
            const f = bot.entity.position.floored();
            for (const dy of [0, 1]) {
              const c = bot.blockAt(f.offset(dx, dy, dz));
              if (!c || isAir(c)) continue;
              // a hazard-faced wall (water/gravel) in this direction floods or
              // buries the tunnel — try the next direction
              if (hazard(c)) continue tunnel;
              if (!(await digCell(c))) continue tunnel;
              await sleep(150);
            }
            const st = await executeAction(
              bot,
              { type: "goto", x: f.x + dx, y: f.y, z: f.z + dz, range: 0, timeoutMs: 6000 },
              mcData
            ).catch(() => ({ ok: false }));
            if (!st.ok) continue tunnel;
            const f2 = bot.entity.position.floored();
            let clean = true;
            for (const dy of [1, 2, 3, 4, 5]) {
              if (hazard(bot.blockAt(f2.offset(0, dy, 0)))) {
                clean = false;
                break;
              }
            }
            if (clean) {
              shifted = true;
              break tunnel;
            }
          }
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

function hostileNear(bot, maxD) {
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
}

// two stacked solids in the adjacent open cell on the mob's side — same shape
// as stripMine's sealToward, hoisted so the stair climber can wall the shaft
async function sealCellToward(bot, mcData, mobPos) {
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
    if (cell.name !== "air") continue;
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
    // a cave shooter tracks the climb and picks the bot off mid-step (the
    // starving-staircase death): wall the shaft-side cell toward it first.
    // Sealing the stair's own cell forces a rotate — that IS the point, the
    // staircase turns away from the shooter behind the fresh wall
    const stalker = hostileNear(bot, 10);
    if (stalker && stalker.position.distanceTo(bot.entity.position) > 2.6) {
      await sealCellToward(bot, mcData, stalker.position);
    }
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
