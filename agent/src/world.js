import pkgPathfinder from "mineflayer-pathfinder";

const { goals } = pkgPathfinder;

const HAZARD_BLOCK_PATTERNS = [
  /^lava$/,
  /^fire$/,
  /^soul_fire$/,
  /_campfire$/,
  /^cactus$/,
  /^magma_block$/,
  /^sweet_berry_bush$/,
  /^powder_snow$/,
  /^pointed_dripstone$/,
  /^wither_rose$/,
];

const HOSTILE_MOB_PATTERN = new RegExp(
  [
    "blaze",
    "bogged",
    "breeze",
    "cave_spider",
    "creeper",
    "drowned",
    "elder_guardian",
    "ender_dragon",
    "enderman",
    "endermite",
    "evoker",
    "ghast",
    "guardian",
    "hoglin",
    "husk",
    "magma_cube",
    "phantom",
    "piglin_brute",
    "pillager",
    "ravager",
    "shulker",
    "silverfish",
    "skeleton",
    "slime",
    "spider",
    "stray",
    "vex",
    "vindicator",
    "warden",
    "witch",
    "wither",
    "wither_skeleton",
    "zoglin",
    "zombie",
    "zombie_villager",
    "zombified_piglin",
  ].join("|"),
  "i"
);

const INTERESTING_BLOCKS = new Set([
  "crafting_table",
  "furnace",
  "blast_furnace",
  "smoker",
  "chest",
  "trapped_chest",
  "barrel",
  "ender_chest",
  "water",
  "lava",
  "sand",
  "gravel",
  "dirt",
  "stone",
  "cobblestone",
  "grass_block",
  "obsidian",
  "crying_obsidian",
  "nether_portal",
  "end_portal",
  "end_portal_frame",
  "spawner",
  "ancient_debris",
  "nether_bricks",
  "lodestone",
  "wheat",
  "carrots",
  "potatoes",
  "hay_block",
]);

function itemSummary(bot) {
  const counts = new Map();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) || 0) + item.count);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 32)
    .map(([name, count]) => `${name} x${count}`);
}

export function spatialSnapshot(origin, position) {
  const pos = roundedPosition(position);
  const delta = {
    x: round1(Number(position.x) - Number(origin.x)),
    y: round1(Number(position.y) - Number(origin.y)),
    z: round1(Number(position.z) - Number(origin.z)),
  };
  return {
    pos,
    delta,
    dist: round1(Math.hypot(delta.x, delta.y, delta.z)),
  };
}

export function isHazardBlockName(name) {
  return HAZARD_BLOCK_PATTERNS.some((pattern) => pattern.test(String(name || "")));
}

export function isHostileMobName(name) {
  return HOSTILE_MOB_PATTERN.test(String(name || "").replaceAll(" ", "_"));
}

function nearbyPlayers(bot, radius = 32) {
  return Object.values(bot.entities)
    .filter((entity) => entity?.position && entity.type === "player" && entity.username !== bot.username)
    .map((entity) => ({
      id: entity.id,
      name: entity.username,
      ...spatialSnapshot(bot.entity.position, entity.position),
      visible: canSee(bot, entity),
    }))
    .filter((player) => player.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 8);
}

function nearbyMobs(bot, radius = 24) {
  return Object.values(bot.entities)
    .filter(
      (entity) =>
        entity?.position &&
        (entity.type === "mob" || entity.kind === "Hostile mobs" || entity.kind === "Passive mobs")
    )
    .map((entity) => {
      const name = entityName(entity);
      return {
        id: entity.id,
        name,
        kind: entity.kind || null,
        hostile: entity.kind === "Hostile mobs" || isHostileMobName(name),
        ...spatialSnapshot(bot.entity.position, entity.position),
        visible: canSee(bot, entity),
      };
    })
    .filter((mob) => mob.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 16);
}

function nearbyDroppedItems(bot, radius = 16) {
  const result = [];
  for (const entity of Object.values(bot.entities)) {
    if (!entity?.position || typeof entity.getDroppedItem !== "function") continue;
    let item = null;
    try {
      item = entity.getDroppedItem();
    } catch {
      continue;
    }
    if (!item) continue;
    const spatial = spatialSnapshot(bot.entity.position, entity.position);
    if (spatial.dist > radius) continue;
    result.push({ id: entity.id, name: item.name, count: item.count, ...spatial });
  }
  return result.sort((a, b) => a.dist - b.dist).slice(0, 16);
}

function sampleBlocks(bot, radius = 16) {
  let positions = [];
  try {
    positions = bot.findBlocks({
      matching: (block) => block && isInterestingBlockName(block.name),
      maxDistance: radius,
      count: 96,
    });
  } catch {
    return [];
  }

  const nearestByName = new Map();
  for (const position of positions) {
    const block = bot.blockAt(position);
    if (!block) continue;
    const info = { name: block.name, ...spatialSnapshot(bot.entity.position, block.position) };
    const previous = nearestByName.get(block.name);
    if (!previous || info.dist < previous.dist) nearestByName.set(block.name, info);
  }
  return [...nearestByName.values()].sort((a, b) => a.dist - b.dist).slice(0, 40);
}

function nearbyBlockHazards(bot, radius = 10) {
  let positions = [];
  try {
    positions = bot.findBlocks({
      matching: (block) => block && isHazardBlockName(block.name),
      maxDistance: radius,
      count: 32,
    });
  } catch {
    return [];
  }
  return positions
    .map((position) => bot.blockAt(position))
    .filter(Boolean)
    .map((block) => ({ name: block.name, ...spatialSnapshot(bot.entity.position, block.position) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 16);
}

function bodyBlocks(bot) {
  const feet = bot.entity.position.floored();
  const sample = (position) => {
    const block = bot.blockAt(position);
    return block ? { name: block.name, pos: roundedPosition(block.position) } : null;
  };
  return {
    below: sample(feet.offset(0, -1, 0)),
    feet: sample(feet),
    head: sample(feet.offset(0, 1, 0)),
  };
}

export function buildWorldState(bot, agentState) {
  const p = bot.entity.position;
  const time = bot.time?.timeOfDay;
  const isDay = typeof bot.time?.isDay === "boolean" ? bot.time.isDay : typeof time === "number" ? time < 13000 : null;
  const mobs = nearbyMobs(bot);
  const blockHazards = nearbyBlockHazards(bot);
  return {
    me: {
      username: bot.username,
      pos: roundedPosition(p),
      yaw: round1(bot.entity.yaw),
      pitch: round1(bot.entity.pitch),
      velocity: roundedPosition(bot.entity.velocity || { x: 0, y: 0, z: 0 }),
      onGround: bot.entity.onGround,
      inWater: bot.entity.isInWater,
      health: bot.health,
      food: bot.food,
      oxygen: bot.oxygenLevel,
      held: bot.heldItem?.name || null,
      sleeping: Boolean(bot.isSleeping),
      gameMode: bot.game?.gameMode,
      dimension: bot.game?.dimension,
      bodyBlocks: bodyBlocks(bot),
    },
    environment: {
      timeOfDay: time,
      isDay,
      raining: bot.isRaining,
      biomeHint: biomeHint(bot),
    },
    inventory: itemSummary(bot),
    players: nearbyPlayers(bot),
    mobs,
    droppedItems: nearbyDroppedItems(bot),
    blocksNearby: sampleBlocks(bot),
    hazards: {
      blocks: blockHazards,
      hostileMobs: mobs.filter((mob) => mob.hostile && mob.dist <= 10),
      lowOxygen: Number(bot.oxygenLevel) < 10,
      lowHealth: Number(bot.health) <= 6,
    },
    agent: {
      mode: agentState.mode,
      goal: agentState.goal,
      plan: agentState.plan || [],
      lastThink: agentState.lastThink || null,
      activeCommand: agentState.activeCommand || null,
      commandQueueLength: agentState.commandQueueLength || 0,
      vision: agentState.visionEnabled,
      lastAction: agentState.lastAction,
      lastError: agentState.lastError,
      paused: agentState.paused,
      budget: agentState.budget || null,
    },
  };
}

function isInterestingBlockName(name) {
  return (
    INTERESTING_BLOCKS.has(name) ||
    name.endsWith("_log") ||
    name.endsWith("_ore") ||
    name.endsWith("_bed") ||
    name.endsWith("_shulker_box") ||
    isHazardBlockName(name)
  );
}

function biomeHint(bot) {
  try {
    const block = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
    const biome = block?.biome;
    if (biome && typeof biome === "object") return biome.name || biome.displayName || biome.id || null;
    return biome ?? null;
  } catch {
    return null;
  }
}

function entityName(entity) {
  return String(entity.name || entity.mobType || entity.displayName || "mob").toLowerCase().replaceAll(" ", "_");
}

function canSee(bot, entity) {
  try {
    return typeof bot.canSeeEntity === "function" ? Boolean(bot.canSeeEntity(entity)) : null;
  } catch {
    return null;
  }
}

function roundedPosition(position) {
  return {
    x: round1(Number(position?.x) || 0),
    y: round1(Number(position?.y) || 0),
    z: round1(Number(position?.z) || 0),
  };
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

export function stateToText(state) {
  return JSON.stringify(state, null, 2);
}

export { goals };
