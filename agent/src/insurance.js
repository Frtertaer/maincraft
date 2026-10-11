// Insurance architecture: progress must survive a death, and risky work must
// wait until the bot can afford to lose it. Four pieces, all pure where
// possible so selftest can pin them:
//   - capital ledger: what every stash chest holds → phase by capital, not pocket
//   - risk governor: one danger score from time/light/mobs/hp/armor/heatmap
//   - strategy ledger: per (goal, site) failure budget → relocate / switch method
//   - readiness gates: checklists before dimension jumps
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.resolve(__dirname, "../../logs");
const LEDGER_FILE = path.join(LOGS, "ledger.json");
const STRATEGY_FILE = path.join(LOGS, "strategy.json");

export const PHASE_ORDER = [
  "wood", "stone", "iron", "food_armor", "diamond", "portal", "nether",
  "blaze", "pearls", "eyes", "stronghold", "end", "dragon", "clear",
];
export const phaseRank = (p) => {
  const i = PHASE_ORDER.indexOf(p);
  return i < 0 ? 0 : i;
};

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return dflt;
  }
}
function writeJson(file, v) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(v));
  } catch { /* best-effort */ }
}
const sameWorld = (bot, e) => {
  const sp = bot?.spawnPoint;
  return !sp || e.sx == null || Math.hypot(e.sx - sp.x, e.sz - sp.z) < 32;
};

// ---------- capital ledger ----------

export function itemsToMap(items) {
  const m = {};
  for (const i of items || []) if (i?.name) m[i.name] = (m[i.name] || 0) + (i.count || 0);
  return m;
}

export function ledgerLoad(bot) {
  const a = readJson(LEDGER_FILE, []);
  return (Array.isArray(a) ? a : []).filter((e) => e && Number.isFinite(e.x) && sameWorld(bot, e));
}

export function ledgerRecord(bot, pos, items) {
  if (!pos) return;
  const all = readJson(LEDGER_FILE, []);
  const list = (Array.isArray(all) ? all : []).filter(
    (e) => !(e && Math.abs(e.x - pos.x) < 1 && Math.abs(e.y - pos.y) < 1 && Math.abs(e.z - pos.z) < 1)
  );
  const map = itemsToMap(items);
  if (Object.keys(map).length) {
    const sp = bot?.spawnPoint;
    list.push({
      x: pos.x, y: pos.y, z: pos.z,
      dim: String(bot?.game?.dimension || ""),
      sx: sp?.x ?? null, sz: sp?.z ?? null,
      items: map, t: Date.now(),
    });
  }
  writeJson(LEDGER_FILE, list.slice(-64));
}

export function ledgerTotals(entries, from = null, maxDist = 300, dim = null) {
  const m = {};
  for (const e of entries || []) {
    if (dim && e.dim && !String(e.dim).includes(dim) && !String(dim).includes(e.dim)) continue;
    if (from && Math.hypot(e.x - from.x, e.z - from.z) > maxDist) continue;
    for (const [k, v] of Object.entries(e.items || {})) m[k] = (m[k] || 0) + v;
  }
  return m;
}

export function mergeMaps(...maps) {
  const m = {};
  for (const x of maps) for (const [k, v] of Object.entries(x || {})) m[k] = (m[k] || 0) + v;
  return m;
}

// Exactly the detectPhase ladder, over a name→count map so the same rules
// can run on pocket, on chests, or on both (capital).
export function phaseFromItems(m, dim = "", dragonPresent = false) {
  const c = (n) => (typeof n === "function"
    ? Object.entries(m).filter(([k]) => n(k)).reduce((s, [, v]) => s + v, 0)
    : m[n] || 0);
  const has = (names) => names.some((n) => (m[n] || 0) > 0);
  const d = String(dim || "");
  if (/end/i.test(d)) return dragonPresent ? "dragon" : "clear";
  const rods = c("blaze_rod") + c("blaze_powder");
  if (/nether/i.test(d)) {
    if (c("blaze_rod") >= 6 || c("blaze_powder") >= 6) return c("ender_pearl") >= 12 ? "eyes" : "pearls";
    return "blaze";
  }
  // thrown eyes shatter (~20%): a run that lost 2 of 12 must stay in the
  // stronghold/eyes nodes, not fall back to the overworld ladder
  const eyes = c("ender_eye");
  const pearls = c("ender_pearl");
  const powder = c("blaze_rod") * 2 + c("blaze_powder");
  if (eyes >= 12 || (eyes >= 8 && pearls === 0)) return "stronghold";
  if (pearls + eyes >= 12 && powder + eyes >= 12) return "eyes";
  if (rods >= 6 || powder + eyes >= 12 || eyes > 0) return "pearls";
  if (c((k) => k.includes("obsidian")) >= 10 && has(["flint_and_steel", "fire_charge"])) return "nether";
  if (has(["diamond_pickaxe"]) || (c("diamond") >= 3 && has(["iron_pickaxe", "diamond_pickaxe"]))) return "portal";
  if (has(["iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"])) return "diamond";
  const picks = Object.keys(m).filter((k) => k.includes("pickaxe") && m[k] > 0);
  if (picks.some((k) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(k)) || c("iron_ingot") > 0 || c("raw_iron") > 0) return "iron";
  if (picks.length) return "stone";
  return "wood";
}

// Capital phase only counts the overworld ladder (chests sit in the
// overworld); dimension phases stay pocket-driven.
export function capitalGap(invMap, chestMap) {
  const pocket = phaseFromItems(invMap);
  const capital = phaseFromItems(mergeMaps(invMap, chestMap));
  return { pocket, capital, gap: phaseRank(capital) - phaseRank(pocket) };
}

// ---------- risk governor ----------

const RANGED = /skeleton|stray|bogged|pillager|witch|drowned|blaze|ghast|shulker|phantom/;
const NEUTRAL_BY_DAY = /spider/;
export const RISK_LEVELS = ["safe", "low", "mid", "high"];

export function armorPoints(items) {
  const pts = {
    leather_helmet: 1, leather_chestplate: 3, leather_leggings: 2, leather_boots: 1,
    golden_helmet: 2, golden_chestplate: 5, golden_leggings: 3, golden_boots: 1,
    chainmail_helmet: 2, chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_boots: 1,
    iron_helmet: 2, iron_chestplate: 6, iron_leggings: 5, iron_boots: 2,
    diamond_helmet: 3, diamond_chestplate: 8, diamond_leggings: 6, diamond_boots: 3,
    netherite_helmet: 3, netherite_chestplate: 8, netherite_leggings: 6, netherite_boots: 3,
  };
  let s = 0;
  for (const i of items || []) if (i && pts[i.name]) s += pts[i.name];
  return Math.min(20, s);
}

export const isNightTod = (tod) => tod != null && tod >= 12541 && tod < 23460;

// ctx: { tod, surface, hostiles:[{name,d}], hp, food, armor, weapon, shield, heat }
export function assessRisk(ctx) {
  const reasons = [];
  let danger = 0;
  const armor = ctx.armor || 0;
  const mitig = 1 - Math.min(0.6, armor / 20 * 0.6) - (ctx.shield ? 0.1 : 0);
  const night = isNightTod(ctx.tod);
  if (night && ctx.surface !== false) {
    const v = armor >= 10 ? 0.12 : 0.35;
    danger += v;
    reasons.push("night");
  }
  let mob = 0;
  for (const h of ctx.hostiles || []) {
    const n = String(h.name || "");
    if (NEUTRAL_BY_DAY.test(n) && !night) continue;
    const d = Math.max(1, h.d || 99);
    let w = 0;
    if (/creeper/.test(n)) w = d < 6 ? 0.45 : d < 12 ? 0.15 : 0;
    else if (RANGED.test(n)) w = d < 24 ? 0.18 : 0;
    else w = d < 6 ? 0.16 : d < 14 ? 0.08 : 0;
    mob += w;
  }
  if (mob > 0) {
    danger += Math.min(0.6, mob) * mitig;
    reasons.push(`mobs${(ctx.hostiles || []).length}`);
  }
  if (ctx.hp != null) {
    if (ctx.hp <= 6) { danger += 0.4; reasons.push("hp-crit"); }
    else if (ctx.hp <= 12) { danger += 0.15; reasons.push("hp-low"); }
  }
  if (ctx.food != null && ctx.food <= 6) { danger += 0.12; reasons.push("hungry"); }
  if (!ctx.weapon) { danger += 0.08; reasons.push("unarmed"); }
  if (ctx.heat) {
    danger += Math.min(0.35, ctx.heat * 0.1);
    reasons.push(`heat${ctx.heat}`);
  }
  danger = Math.max(0, Math.min(1, danger));
  const level = danger < 0.25 ? "safe" : danger < 0.45 ? "low" : danger < 0.65 ? "mid" : "high";
  return { danger: Math.round(danger * 100) / 100, level, reasons };
}

// deaths near a point inside a recency window — the heatmap term
export function deathHeat(pts, pos, radius = 24, windowMs = 2 * 3600e3, now = Date.now()) {
  if (!pos) return 0;
  let n = 0;
  for (const p of pts || []) {
    if (!p || !Number.isFinite(p.x)) continue;
    if (p.t && now - p.t > windowMs) continue;
    if (Math.hypot(p.x - pos.x, p.z - pos.z) <= radius) n += 1;
  }
  return n;
}

// ---------- strategy ledger ----------

export const siteKey = (pos, cell = 48) =>
  pos ? `${Math.floor(pos.x / cell)},${Math.floor(pos.z / cell)}` : "?";

export function strategyLoad(bot) {
  const s = readJson(STRATEGY_FILE, {});
  const sp = bot?.spawnPoint;
  if (sp && s.sx != null && Math.hypot(s.sx - sp.x, s.sz - sp.z) >= 32) return { sx: sp.x, sz: sp.z, rec: {} };
  return { sx: s.sx ?? sp?.x ?? null, sz: s.sz ?? sp?.z ?? null, rec: s.rec || {} };
}
export function strategySave(s) {
  writeJson(STRATEGY_FILE, s);
}

// outcome: "ok" | "death" | "timeout" | "fail"
export function strategyRecord(s, goal, method, site, outcome, now = Date.now()) {
  const k = `${goal}|${method}|${site}`;
  const r = s.rec[k] || (s.rec[k] = { ok: 0, death: 0, fail: 0, t: 0 });
  if (outcome === "ok") r.ok += 1;
  else if (outcome === "death") r.death += 1;
  else r.fail += 1;
  r.t = now;
  return r;
}

// a site is spent for a goal once deaths outweigh progress: 3 deaths with
// no success there, or 6 fails. This is what stops "15 deaths in one spot".
export function siteSpent(s, goal, site) {
  let death = 0, fail = 0, ok = 0;
  for (const [k, r] of Object.entries(s.rec || {})) {
    const [g, , st] = k.split("|");
    if (g !== goal || st !== site) continue;
    death += r.death; fail += r.fail; ok += r.ok;
  }
  return death >= 3 + ok * 2 || fail >= 6 + ok * 3;
}

// expected-cost pick: base cost × (1 + penalty per recorded failure),
// skipping methods whose preconditions fail
export function pickMethod(s, goal, methods) {
  let best = null;
  for (const m of methods) {
    if (m.available === false) continue;
    let death = 0, fail = 0, ok = 0;
    for (const [k, r] of Object.entries(s?.rec || {})) {
      const [g, meth] = k.split("|");
      if (g !== goal || meth !== m.name) continue;
      death += r.death; fail += r.fail; ok += r.ok;
    }
    const cost = (m.cost || 1) * (1 + death * 0.8 + fail * 0.3) / (1 + ok * 0.5);
    if (!best || cost < best.cost) best = { name: m.name, cost };
  }
  return best;
}

// ---------- readiness gates ----------

export function readiness(goal, m, armor) {
  const c = (re) => Object.entries(m).filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0);
  const missing = [];
  const need = (cond, what) => { if (!cond) missing.push(what); };
  const food = c(/^(bread|cooked_\w+|baked_potato|golden_carrot|apple|carrot|melon_slice|pumpkin_pie|cookie)$/);
  const blocks = c(/^(cobblestone|cobbled_deepslate|dirt|netherrack|blackstone|stone|deepslate|andesite|diorite|granite|tuff)$/);
  const sword = c(/_(sword|axe)$/) > 0;
  const pick = c(/^(iron|diamond|netherite)_pickaxe$/) > 0;
  if (goal === "nether") {
    need(armor >= 7, "armor>=7");
    need(sword, "weapon");
    need(pick, "iron+pickaxe");
    need(food >= 10, "food>=10");
    need(blocks >= 32, "blocks>=32");
    need(c(/^golden_(helmet|chestplate|leggings|boots)$/) > 0 || c(/^gold_ingot$/) >= 5, "gold armor piece");
  } else if (goal === "end") {
    need(c(/^ender_eye$/) >= 2, "eyes>=2 spare");
    need(armor >= 10, "armor>=10");
    need(sword, "weapon");
    need(food >= 16, "food>=16");
    need(blocks >= 64, "blocks>=64");
    need((c(/^bow$/) > 0 && c(/^arrow$/) >= 32) || c(/_bed$/) >= 4, "bow+32 arrows or 4 beds");
  }
  return { ready: missing.length === 0, missing };
}

// ---------- stronghold triangulation ----------

// Two eye throws from separated points → stronghold xz. Rays nearly
// parallel (<~3°) or crossing behind a thrower are rejected: they put the
// estimate thousands of blocks off.
export function intersectRays(r1, r2) {
  if (!r1 || !r2) return null;
  const det = -r1.dx * r2.dz + r2.dx * r1.dz;
  if (Math.abs(det) < 0.05) return null;
  const bx = r2.x - r1.x;
  const bz = r2.z - r1.z;
  const t1 = (-bx * r2.dz + r2.dx * bz) / det;
  const t2 = (r1.dx * bz - r1.dz * bx) / det;
  if (t1 <= 0 || t2 <= 0) return null;
  return { x: r1.x + r1.dx * t1, z: r1.z + r1.dz * t1, t1, t2 };
}

// side step for the second throw: perpendicular to the first ray
export function perpendicularPoint(r, dist = 100) {
  return { x: r.x - r.dz * dist, z: r.z + r.dx * dist };
}

// ---------- structure memory ----------
// Found structures (fortress, bastion, stronghold fix) outlive death and
// restart: the corpse-run kit walks straight back instead of re-scouting.
const SITES_FILE = path.join(LOGS, "sites.json");
export function sitesLoad(bot, kind) {
  const a = readJson(SITES_FILE, []);
  return (Array.isArray(a) ? a : []).filter((e) => e && e.kind === kind && sameWorld(bot, e));
}
export function sitesAdd(bot, kind, pos) {
  if (!pos) return;
  const a = readJson(SITES_FILE, []);
  const list = Array.isArray(a) ? a : [];
  if (list.some((e) => e.kind === kind && Math.hypot(e.x - pos.x, e.z - pos.z) < 48)) return;
  const sp = bot?.spawnPoint;
  list.push({ kind, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), sx: sp?.x ?? null, sz: sp?.z ?? null, t: Date.now() });
  writeJson(SITES_FILE, list.slice(-100));
}

// Systematic scouting: spokes around an origin at growing radius instead of
// random 40-block hops (random walk covers area ~√t; spokes cover it ~t).
export function sweepTarget(origin, k, leg = 48, spokes = 8) {
  const ring = Math.floor(k / spokes) + 1;
  const ang = ((k % spokes) / spokes) * Math.PI * 2 + (ring % 2 ? 0 : Math.PI / spokes);
  return { x: Math.round(origin.x + Math.cos(ang) * ring * leg * 1.5), z: Math.round(origin.z + Math.sin(ang) * ring * leg * 1.5) };
}
