/**
 * Bounded verb catalog for the fast controller (Jev / Laya / local).
 * The model picks ONE verb id per tick; code resolves it to a concrete
 * executeAction() action. World-affecting verbs never accept free-form
 * model parameters — every argument comes from world state.
 */

const AIR = new Set(["air", "cave_air", "void_air"]);

const FOOD_PATTERN =
  /(beef|pork|bread|apple|carrot|potato|chicken|cod|salmon|cookie|melon|pie|stew|berries|mutton|rabbit|beetroot|chorus|honey)/i;

const CONTAINER_PATTERN = /^(chest|trapped_chest|barrel|ender_chest|shulker_box|.*_shulker_box|hopper)$/;

const BED_PATTERN = /_bed$/;

// Items the bot can smelt -> output. Fuel is chosen by smeltItems().
const SMELT_MAP = {
  raw_iron: "iron_ingot",
  raw_gold: "gold_ingot",
  raw_copper: "copper_ingot",
  iron_ore: "iron_ingot",
  gold_ore: "gold_ingot",
  copper_ore: "copper_ingot",
  deepslate_iron_ore: "iron_ingot",
  deepslate_gold_ore: "gold_ingot",
  cobblestone: "stone",
  sand: "glass",
  clay_ball: "brick",
  raw_beef: "cooked_beef",
  raw_porkchop: "cooked_porkchop",
  raw_chicken: "cooked_chicken",
  raw_mutton: "cooked_mutton",
  raw_cod: "cooked_cod",
  raw_salmon: "cooked_salmon",
  potato: "baked_potato",
  kelp: "dried_kelp",
};

const TOOL_FOR_TARGET = [
  { pattern: /(_ore|ancient_debris|obsidian|stone|cobblestone|netherrack|deepslate)/, kind: "_pickaxe" },
  { pattern: /_log$/, kind: "_axe" },
  { pattern: /(dirt|grass_block|sand|gravel|clay|snow)/, kind: "_shovel" },
];

const TOOL_TIERS = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];

const JUNK_PATTERN = /^(cobblestone|cobbled_deepslate|dirt|gravel|netherrack|andesite|diorite|granite|tuff|rotten_flesh)$/;

export function parseInventory(world) {
  const map = new Map();
  for (const line of world?.inventory || []) {
    const m = String(line).match(/^(.*)\sx(\d+)$/);
    if (m) map.set(m[1], (map.get(m[1]) || 0) + Number(m[2]));
  }
  return map;
}

function nearestByName(list, names) {
  let best = null;
  for (const entry of list || []) {
    if (!names.has(entry.name)) continue;
    if (!best || entry.dist < best.dist) best = entry;
  }
  return best;
}

function firstTargetMatch(targets, candidates) {
  const wanted = new Set((targets || []).map((t) => String(t).toLowerCase()));
  if (!wanted.size) return null;
  return nearestByName(candidates, wanted);
}

function bestToolFor(inventory, kindSuffix) {
  for (const tier of TOOL_TIERS) {
    const name = `${tier}${kindSuffix}`;
    if (inventory.has(name)) return name;
  }
  return null;
}

function bestWeapon(inventory) {
  for (const tier of TOOL_TIERS) {
    for (const kind of ["_sword", "_axe"]) {
      const name = `${tier}${kind}`;
      if (inventory.has(name)) return name;
    }
  }
  return null;
}

function pickSmeltable(inventory) {
  for (const [input, output] of Object.entries(SMELT_MAP)) {
    if (inventory.has(input)) return { input, output };
  }
  return null;
}

function needsTool(ctx) {
  // Prefer a tool matching the current plan targets, then any upgrade over held.
  const inv = ctx.inventory;
  const held = ctx.world?.me?.held || "";
  for (const entry of TOOL_FOR_TARGET) {
    const targetHit = (ctx.targets || []).some((t) => entry.pattern.test(String(t))) ||
      (ctx.world?.blocksNearby || []).some((b) => entry.pattern.test(b.name) && b.dist < 12);
    if (!targetHit) continue;
    const tool = bestToolFor(inv, entry.kind);
    if (tool && tool !== held) return tool;
  }
  if (ctx.world?.hazards?.hostileMobs?.length) {
    const weapon = bestWeapon(inv);
    if (weapon && weapon !== held) return weapon;
  }
  return null;
}

function escapeWaypoint(ctx) {
  const me = ctx.world?.me?.pos;
  if (!me) return null;
  const threats = [
    ...(ctx.world?.hazards?.hostileMobs || []),
    ...(ctx.world?.hazards?.blocks || []).filter((b) => b.dist <= 4),
  ];
  if (!threats.length) return null;
  let dx = 0;
  let dz = 0;
  for (const t of threats) {
    const d = Math.max(t.dist || 1, 0.5);
    dx -= ((t.pos?.x ?? me.x) - me.x) / d;
    dz -= ((t.pos?.z ?? me.z) - me.z) / d;
  }
  const len = Math.hypot(dx, dz) || 1;
  return {
    x: Math.round(me.x + (dx / len) * 12),
    y: Math.round(me.y),
    z: Math.round(me.z + (dz / len) * 12),
  };
}

function craftableTargets(ctx) {
  const inv = ctx.inventory;
  return (ctx.targets || []).filter((name) => {
    const n = String(name).toLowerCase();
    if (!n || inv.has(n)) return false;
    if (!ctx.mcData?.itemsByName?.[n]) return false;
    // Blocks that are only found in the world are resolved by collect/goto, not craft.
    return Boolean(ctx.mcData.blocksByName?.[n] == null || CRAFTABLE_BLOCKS.has(n));
  });
}

const CRAFTABLE_BLOCKS = new Set([
  "crafting_table",
  "furnace",
  "chest",
  "barrel",
  "torch",
  "ladder",
  "door",
  "trapdoor",
  "bed",
  "white_bed",
  "campfire",
  "smoker",
  "blast_furnace",
  "cartography_table",
  "fletching_table",
  "smithing_table",
  "loom",
  "composter",
  "barrel",
]);

const PLACEABLE_TARGETS = new Set([
  "crafting_table",
  "furnace",
  "blast_furnace",
  "smoker",
  "chest",
  "barrel",
  "torch",
  "campfire",
]);

function containerItems(ctx) {
  return ctx.container?.items instanceof Map ? ctx.container.items : new Map();
}

export const VERBS = [
  {
    id: "wait",
    description: "Do nothing this tick; safest option when unsure",
    legal: () => true,
    resolve: () => ({ type: "wait", ms: 900 }),
  },
  {
    id: "eat",
    description: "Eat food to restore hunger/health",
    legal: (ctx) =>
      !ctx.passive &&
      Number(ctx.world?.me?.food) < 20 &&
      [...ctx.inventory.keys()].some((name) => FOOD_PATTERN.test(name)),
    resolve: () => ({ type: "eat" }),
  },
  {
    id: "sleep",
    description: "Sleep through the night if a bed is usable",
    legal: (ctx) =>
      !ctx.passive &&
      ctx.world?.environment?.isDay === false &&
      !ctx.world?.me?.sleeping &&
      ([...ctx.inventory.keys()].some((n) => BED_PATTERN.test(n)) ||
        (ctx.world?.blocksNearby || []).some((b) => BED_PATTERN.test(b.name))),
    resolve: () => ({ type: "sleep" }),
  },
  {
    id: "wake",
    description: "Get out of bed",
    legal: (ctx) => !ctx.passive && Boolean(ctx.world?.me?.sleeping),
    resolve: () => ({ type: "wake" }),
  },
  {
    id: "flee",
    description: "Run away from nearby hostiles or hazards",
    legal: (ctx) =>
      !ctx.passive &&
      Boolean(
        ctx.world?.hazards?.lowHealth ||
          ctx.world?.hazards?.lowOxygen ||
          ctx.world?.hazards?.hostileMobs?.length ||
          (ctx.world?.hazards?.blocks || []).some((b) => b.dist <= 3)
      ),
    resolve: (ctx) => {
      const wp = escapeWaypoint(ctx);
      if (!wp) return { type: "wait", ms: 600 };
      return { type: "goto", ...wp, range: 3, timeoutMs: 15000 };
    },
  },
  {
    id: "attack",
    description: "Fight the nearest hostile mob",
    legal: (ctx) =>
      !ctx.passive && (ctx.world?.mobs || []).some((m) => m.hostile && m.dist <= 16),
    resolve: (ctx) => {
      const target = (ctx.world?.mobs || [])
        .filter((m) => m.hostile && m.dist <= 16)
        .sort((a, b) => a.dist - b.dist)[0];
      if (!target) return { type: "wait", ms: 600 };
      return { type: "attack", name: target.name, maxDistance: 16, maxDurationMs: 12000 };
    },
  },
  {
    id: "equip",
    description: "Equip the best tool/weapon for current targets",
    legal: (ctx) => !ctx.passive && Boolean(needsTool(ctx)),
    resolve: (ctx) => {
      const tool = needsTool(ctx);
      return tool ? { type: "equip", item: tool, destination: "hand" } : { type: "wait", ms: 600 };
    },
  },
  {
    id: "pickup",
    description: "Walk to the nearest dropped item",
    legal: (ctx) => !ctx.passive && (ctx.world?.droppedItems || []).some((d) => d.dist <= 14),
    resolve: (ctx) => {
      const drop = [...(ctx.world?.droppedItems || [])].sort((a, b) => a.dist - b.dist)[0];
      if (!drop?.pos) return { type: "wait", ms: 600 };
      return { type: "goto", x: drop.pos.x, y: drop.pos.y, z: drop.pos.z, range: 1, timeoutMs: 15000 };
    },
  },
  {
    id: "collect",
    description: "Gather a target block/resource in bulk (logs, ores)",
    legal: (ctx) => !ctx.passive && Boolean(collectCandidate(ctx)),
    resolve: (ctx) => {
      const block = collectCandidate(ctx);
      return block ? { type: "collect", block: block.name, count: 8 } : { type: "wait", ms: 600 };
    },
  },
  {
    id: "dig",
    description: "Break one target block (workstation, single block)",
    legal: (ctx) => !ctx.passive && Boolean(firstTargetMatch(ctx.targets, ctx.world?.blocksNearby || [])),
    resolve: (ctx) => {
      const block = firstTargetMatch(ctx.targets, ctx.world?.blocksNearby || []);
      return block ? { type: "dig", block: block.name } : { type: "wait", ms: 600 };
    },
  },
  {
    id: "goto_target",
    description: "Walk toward the nearest plan-relevant block or target",
    legal: (ctx) => {
      if (ctx.passive) return false;
      const hit =
        firstTargetMatch(ctx.targets, ctx.world?.blocksNearby || []) ||
        firstTargetMatch(ctx.targets, ctx.world?.players || []) ||
        collectCandidate(ctx);
      return Boolean(hit && hit.dist > 4);
    },
    resolve: (ctx) => {
      const hit =
        firstTargetMatch(ctx.targets, ctx.world?.blocksNearby || []) ||
        firstTargetMatch(ctx.targets, ctx.world?.players || []) ||
        collectCandidate(ctx);
      if (!hit?.pos) return { type: "wait", ms: 600 };
      return { type: "goto", x: hit.pos.x, y: hit.pos.y, z: hit.pos.z, range: 3, timeoutMs: 30000 };
    },
  },
  {
    id: "goto_waypoint",
    description: "Travel to the planner's waypoint",
    legal: (ctx) => !ctx.passive && Boolean(ctx.waypoint),
    resolve: (ctx) =>
      ctx.waypoint
        ? { type: "goto", x: ctx.waypoint.x, y: ctx.waypoint.y, z: ctx.waypoint.z, range: 2, timeoutMs: 45000 }
        : { type: "wait", ms: 600 },
  },
  {
    id: "craft",
    description: "Craft the next missing item/tool the plan needs",
    legal: (ctx) => !ctx.passive && craftableTargets(ctx).length > 0,
    resolve: (ctx) => {
      const item = craftableTargets(ctx)[0];
      return item ? { type: "craft", item, count: 1 } : { type: "wait", ms: 600 };
    },
  },
  {
    id: "place",
    description: "Place a held workstation block nearby (table, furnace, chest)",
    legal: (ctx) =>
      !ctx.passive &&
      [...ctx.inventory.keys()].some((n) => PLACEABLE_TARGETS.has(n)) &&
      (ctx.targets || []).some((t) => PLACEABLE_TARGETS.has(String(t).toLowerCase())),
    resolve: (ctx) => {
      const wanted = new Set((ctx.targets || []).map((t) => String(t).toLowerCase()));
      const item = [...ctx.inventory.keys()].find((n) => PLACEABLE_TARGETS.has(n) && wanted.has(n));
      return item ? { type: "place", item } : { type: "wait", ms: 600 };
    },
  },
  {
    id: "smelt",
    description: "Smelt ore/food at a nearby furnace",
    legal: (ctx) =>
      !ctx.passive &&
      Boolean(pickSmeltable(ctx.inventory)) &&
      (ctx.world?.blocksNearby || []).some((b) => /furnace|smoker/.test(b.name) && b.dist <= 16),
    resolve: (ctx) => {
      const job = pickSmeltable(ctx.inventory);
      if (!job) return { type: "wait", ms: 600 };
      return { type: "smelt", input: job.input, output: job.output, count: Math.min(ctx.inventory.get(job.input) || 1, 8) };
    },
  },
  {
    id: "follow",
    description: "Follow a nearby player",
    legal: (ctx) => !ctx.passive && (ctx.world?.players || []).length > 0,
    resolve: (ctx) => {
      const player = [...(ctx.world?.players || [])].sort((a, b) => a.dist - b.dist)[0];
      return player ? { type: "follow", player: player.name, distance: 3 } : { type: "wait", ms: 600 };
    },
  },
  {
    id: "come",
    description: "Go to a nearby player's position once",
    legal: (ctx) => !ctx.passive && (ctx.world?.players || []).some((p) => p.dist > 5),
    resolve: (ctx) => {
      const player = [...(ctx.world?.players || [])].sort((a, b) => a.dist - b.dist)[0];
      return player ? { type: "come", player: player.name } : { type: "wait", ms: 600 };
    },
  },
  {
    id: "container_list",
    description: "Open a nearby chest and list its contents",
    legal: (ctx) =>
      !ctx.passive && (ctx.world?.blocksNearby || []).some((b) => CONTAINER_PATTERN.test(b.name) && b.dist <= 10),
    resolve: (ctx) => {
      const box = nearestByName(
        ctx.world?.blocksNearby || [],
        new Set((ctx.world?.blocksNearby || []).filter((b) => CONTAINER_PATTERN.test(b.name)).map((b) => b.name))
      );
      return box ? { type: "container_list", block: box.name } : { type: "wait", ms: 600 };
    },
  },
  {
    id: "container_take",
    description: "Withdraw a plan-relevant item from the last listed container",
    legal: (ctx) => {
      if (ctx.passive || !ctx.container?.block) return false;
      const wanted = new Set((ctx.targets || []).map((t) => String(t).toLowerCase()));
      return [...containerItems(ctx).keys()].some((n) => wanted.has(n));
    },
    resolve: (ctx) => {
      const wanted = new Set((ctx.targets || []).map((t) => String(t).toLowerCase()));
      const item = [...containerItems(ctx).entries()].find(([n]) => wanted.has(n));
      if (!item) return { type: "wait", ms: 600 };
      return { type: "container_take", block: ctx.container.block, item: item[0], count: Math.min(item[1], 16) };
    },
  },
  {
    id: "container_put",
    description: "Deposit junk/bulk items into a nearby container",
    legal: (ctx) =>
      !ctx.passive &&
      (ctx.world?.blocksNearby || []).some((b) => CONTAINER_PATTERN.test(b.name) && b.dist <= 10) &&
      [...ctx.inventory.entries()].some(([n, c]) => JUNK_PATTERN.test(n) && c >= 16),
    resolve: (ctx) => {
      const junk = [...ctx.inventory.entries()].find(([n, c]) => JUNK_PATTERN.test(n) && c >= 16);
      const box = (ctx.world?.blocksNearby || []).find((b) => CONTAINER_PATTERN.test(b.name));
      if (!junk || !box) return { type: "wait", ms: 600 };
      return { type: "container_put", block: box.name, item: junk[0], count: Math.min(junk[1], 32) };
    },
  },
];

export const VERB_BY_ID = new Map(VERBS.map((v) => [v.id, v]));

function collectCandidate(ctx) {
  const wanted = new Set((ctx.targets || []).map((t) => String(t).toLowerCase()));
  const nearby = ctx.world?.blocksNearby || [];
  // Planner targets first; otherwise fall back to common gatherables so early game moves.
  const hit = nearestByName(nearby, wanted);
  if (hit) return hit;
  const fallback = new Set(
    nearby
      .filter((b) => /_log$|_ore$|^(wheat|carrots|potatoes|sugar_cane|sweet_berry_bush)$/.test(b.name))
      .map((b) => b.name)
  );
  if (!fallback.size) return null;
  return nearestByName(nearby, fallback);
}

/** Verbs the model may pick from this tick (id + description for the API). */
export function legalVerbs(ctx) {
  return VERBS.filter((v) => {
    try {
      return v.legal(ctx);
    } catch {
      return false;
    }
  }).map((v) => ({ id: v.id, description: v.description }));
}

/** Turn a chosen verb id into an executeAction action. Unknown/illegal → wait. */
export function resolveVerb(id, ctx) {
  const verb = VERB_BY_ID.get(id);
  if (!verb) return { type: "wait", ms: 600, note: `illegal verb ${id}` };
  try {
    if (!verb.legal(ctx)) return { type: "wait", ms: 600, note: `verb ${id} not legal now` };
    const action = verb.resolve(ctx);
    if (!action || typeof action !== "object" || !action.type) return { type: "wait", ms: 600 };
    return action;
  } catch {
    return { type: "wait", ms: 600, note: `verb ${id} resolve failed` };
  }
}
