import pkgPathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";

const { goals, Movements } = pkgPathfinder;

const CONTAINER_BLOCKS = new Set([
  "chest",
  "trapped_chest",
  "barrel",
  "ender_chest",
  "shulker_box",
  "hopper",
  "dispenser",
  "dropper",
]);

const FURNACE_BLOCKS = new Set(["furnace", "blast_furnace", "smoker"]);

const FUEL_CAPACITY = [
  [/lava_bucket$/, 100],
  [/coal_block$/, 80],
  [/dried_kelp_block$/, 20],
  [/blaze_rod$/, 12],
  [/^(coal|charcoal)$/, 8],
  [/(?:_log|_wood|_planks)$/, 1.5],
  [/stick$/, 0.5],
  [/bamboo$/, 0.25],
];

/** Normalize an LLM-provided item/action count without accepting NaN or negatives. */
export function normalizeActionCount(value, defaultValue = 1, max = 64) {
  const n = Number(value ?? defaultValue);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), max);
}

/** Mineflayer craft() expects recipe repetitions, not the desired result count. */
export function computeCraftPlan(recipe, requestedCount) {
  const requested = normalizeActionCount(requestedCount, 1, 64);
  if (!requested) return null;
  const outputPerCraft = normalizeActionCount(recipe?.result?.count, 1, 64) || 1;
  const repetitions = Math.ceil(requested / outputPerCraft);
  return {
    requested,
    outputPerCraft,
    repetitions,
    expectedOutput: repetitions * outputPerCraft,
  };
}

/** Pure target selector used by the bounded combat action and unit tests. */
export function selectNearestCombatTarget(entities, origin, options = {}) {
  const wanted = normalizeEntityName(options.name);
  const maxDistance = finiteNumber(options.maxDistance, 16, 2, 64);
  const allowPlayers = options.allowPlayers === true;
  const selfUsername = options.selfUsername;
  let best = null;
  let bestDistance = Infinity;

  for (const entity of Object.values(entities || {})) {
    if (!entity || !entity.position || entity.username === selfUsername) continue;
    const isPlayer = entity.type === "player" || Boolean(entity.username);
    const isMob = entity.type === "mob" || /mob/i.test(String(entity.kind || ""));
    const isAttackableObject = /end(?:er)?_?crystal/i.test(String(entity.name || entity.displayName || ""));
    if ((!isMob && !isAttackableObject && !isPlayer) || (isPlayer && !allowPlayers)) continue;

    const labels = [entity.username, entity.name, entity.displayName].map(normalizeEntityName).filter(Boolean);
    if (wanted && !labels.includes(wanted)) continue;
    const distance = distanceBetween(origin, entity.position);
    if (!Number.isFinite(distance) || distance > maxDistance || distance >= bestDistance) continue;
    best = entity;
    bestDistance = distance;
  }
  return best;
}

function normalizeEntityName(value) {
  return String(value || "").trim().toLowerCase().replaceAll(" ", "_");
}

/**
 * Execute one high-level action. Returns { ok, message }.
 */
export async function executeAction(bot, action, mcData) {
  if (!action || typeof action !== "object") {
    return { ok: false, message: "empty action" };
  }
  const type = String(action.type || "").toLowerCase();

  try {
    switch (type) {
      case "chat":
      case "say": {
        const text = String(action.text || action.message || "").slice(0, 256);
        if (!text) return { ok: false, message: "chat empty" };
        bot.chat(text);
        return { ok: true, message: `said: ${text}` };
      }

      case "wait": {
        const ms = finiteNumber(action.ms ?? (action.seconds != null ? Number(action.seconds) * 1000 : null), 1000, 200, 15000);
        await sleep(ms);
        return { ok: true, message: `waited ${ms}ms` };
      }

      case "stop": {
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        return { ok: true, message: "stopped movement" };
      }

      case "look": {
        if (action.yaw != null && action.pitch != null) {
          await bot.look(Number(action.yaw), Number(action.pitch), true);
        } else if (action.x != null) {
          await bot.lookAt(new Vec3(Number(action.x), Number(action.y), Number(action.z)));
        }
        return { ok: true, message: "looked" };
      }

      case "goto":
      case "go": {
        const x = Number(action.x);
        const y = action.y != null ? Number(action.y) : bot.entity.position.y;
        const z = Number(action.z);
        const range = finiteNumber(action.range, 1, 0.5, 16);
        if (![x, y, z].every(Number.isFinite)) return { ok: false, message: "goto needs finite x,y,z" };
        await goto(bot, new goals.GoalNear(x, y, z, range), action.timeoutMs ?? 45000);
        return { ok: true, message: `went near ${x} ${y} ${z}` };
      }

      case "follow": {
        const name = action.player || action.username || action.name;
        const player = name ? bot.players[name]?.entity : nearestPlayer(bot);
        if (!player) return { ok: false, message: `player not found: ${name || "?"}` };
        const dist = Number(action.distance ?? 3);
        bot.pathfinder.setGoal(new goals.GoalFollow(player, dist), true);
        return { ok: true, message: `following ${player.username || name}` };
      }

      case "come": {
        const name = action.player || action.username || action.name;
        const player = name ? bot.players[name]?.entity : nearestPlayer(bot);
        if (!player) return { ok: false, message: "no player to come to" };
        const p = player.position;
        await goto(bot, new goals.GoalNear(p.x, p.y, p.z, 2), 45000);
        return { ok: true, message: `came to ${player.username || name}` };
      }

      case "dig":
      case "mine": {
        const blockName = action.block || action.name;
        const maxDistance = Number(action.maxDistance ?? 32);
        const timeoutMs = finiteNumber(action.timeoutMs, 20000, 3000, 120000);
        let block = null;
        if (action.x != null) {
          block = bot.blockAt(new Vec3(Number(action.x), Number(action.y), Number(action.z)));
        } else if (blockName) {
          block = bot.findBlock({
            matching: (b) => b && (b.name === blockName || b.name.includes(blockName)),
            maxDistance,
          });
        }
        if (!block) return { ok: false, message: `block not found: ${blockName || "coords"}` };
        await equipBestTool(bot, block);
        const dist = bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5));
        if (dist > 4.2) {
          try {
            await goto(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3), Math.min(timeoutMs, 15000));
          } catch (err) {
            return { ok: false, message: `path to dig: ${err.message || err}` };
          }
        }
        block = bot.blockAt(block.position);
        if (!block || block.name === "air") return { ok: false, message: "block gone" };
        if (!block.canHarvest(bot.heldItem?.type ?? null)) {
          return { ok: false, message: `cannot harvest ${block.name} with ${bot.heldItem?.name || "hand"}` };
        }
        const beforeType = block.type;
        try {
          await withTimeout(bot.dig(block), timeoutMs, `dig ${block.name} timeout`);
        } catch (err) {
          try {
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
          } catch {
            /* ignore */
          }
          return { ok: false, message: err.message || String(err) };
        }
        const after = bot.blockAt(block.position);
        if (after?.type === beforeType) return { ok: false, message: `${block.name} was not broken` };
        return { ok: true, message: `dug ${block.name}` };
      }

      case "collect": {
        const blockName = action.block || action.name;
        const count = normalizeActionCount(action.count, 8, 64);
        const maxDistance = finiteNumber(action.maxDistance, 48, 2, 64);
        const timeoutMs = finiteNumber(action.timeoutMs, 45000, 5000, 180000);
        if (!blockName) return { ok: false, message: "collect needs block name" };
        if (!count) return { ok: false, message: "collect count must be a positive integer" };
        if (!bot.collectBlock) return { ok: false, message: "collectBlock plugin missing" };
        const targets = bot.findBlocks({
          matching: (b) => b && (b.name === blockName || b.name.includes(blockName)),
          maxDistance,
          count,
        });
        if (!targets.length) return { ok: false, message: `no ${blockName} nearby` };
        const blocks = targets.map((p) => bot.blockAt(p)).filter(Boolean);
        try {
          await withTimeout(bot.collectBlock.collect(blocks), timeoutMs, `collect ${blockName} timeout`);
        } catch (err) {
          // cancel pathfinder so next step is not stuck mid-goal
          try {
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
          } catch {
            /* ignore */
          }
          return { ok: false, message: err.message || String(err) };
        }
        return { ok: true, message: `collected ~${blocks.length} ${blockName}` };
      }

      case "craft": {
        const itemName = action.item || action.name;
        const count = normalizeActionCount(action.count, 1, 64);
        if (!itemName) return { ok: false, message: "craft needs item" };
        if (!count) return { ok: false, message: "craft count must be a positive integer" };
        const item = mcData.itemsByName[itemName];
        if (!item) return { ok: false, message: `unknown item ${itemName}` };

        // Prefer inventory 2x2 first; fall back to nearby crafting_table (3x3).
        let craftingTable = null;
        let recipes = bot.recipesFor(item.id, null, 1, null);
        if (!recipes.length) {
          // Prefer closest table within 6, then 16 — avoid pathing across map to stale tables
          craftingTable =
            bot.findBlock({ matching: (b) => b && b.name === "crafting_table", maxDistance: 6 }) ||
            bot.findBlock({ matching: (b) => b && b.name === "crafting_table", maxDistance: 16 });
          if (!craftingTable) {
            return {
              ok: false,
              message: `no recipe for ${itemName} (need crafting_table in world for 3x3)`,
            };
          }
          const dist = bot.entity.position.distanceTo(craftingTable.position.offset(0.5, 0.5, 0.5));
          if (dist > 3.2) {
            try {
              await goto(
                bot,
                new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2),
                12000
              );
            } catch (err) {
              // If already reasonably close, try craft anyway (open table range ~4)
              if (bot.entity.position.distanceTo(craftingTable.position) > 4.5) {
                return { ok: false, message: `path to table: ${err.message || err}` };
              }
            }
          }
          craftingTable = bot.blockAt(craftingTable.position) || craftingTable;
          recipes = bot.recipesFor(item.id, null, 1, craftingTable);
          if (!recipes.length) {
            return {
              ok: false,
              message: `no craftable recipe for ${itemName} at table (missing materials?)`,
            };
          }
        }

        const recipe = recipes[0];
        const plan = computeCraftPlan(recipe, count);
        if (!plan) return { ok: false, message: `bad craft plan for ${itemName}` };

        const before = bot.inventory.items().reduce((n, i) => (i.name === itemName ? n + i.count : n), 0);
        await bot.craft(recipe, plan.repetitions, craftingTable);
        // Wait a tick for inventory sync
        await sleep(150);
        const after = bot.inventory.items().reduce((n, i) => (i.name === itemName ? n + i.count : n), 0);
        if (after <= before) {
          return {
            ok: false,
            message: `craft ${itemName} did not increase inventory (before=${before} after=${after})`,
          };
        }
        return {
          ok: true,
          message: `crafted ${itemName}: +${after - before} (have ${after})`,
        };
      }

      case "equip": {
        const itemName = action.item || action.name;
        const dest = action.destination || "hand";
        const item = bot.inventory.items().find((i) => i.name === itemName || i.name.includes(itemName));
        if (!item) return { ok: false, message: `no item ${itemName}` };
        await bot.equip(item, dest);
        return { ok: true, message: `equipped ${item.name} -> ${dest}` };
      }

      case "toss":
      case "drop": {
        const itemName = action.item || action.name;
        const count = Number(action.count ?? 1);
        const item = bot.inventory.items().find((i) => i.name === itemName || i.name.includes(itemName));
        if (!item) return { ok: false, message: `no item ${itemName}` };
        await bot.toss(item.type, null, Math.min(count, item.count));
        return { ok: true, message: `tossed ${item.name}` };
      }

      case "eat": {
        if (bot.food >= 20) return { ok: false, message: "not hungry" };
        const wanted = action.item || action.name;
        const food = wanted
          ? bot.inventory.items().find((i) => i.name === wanted)
          : pickBestFood(bot);
        if (!food) {
          const onlyHated = bot.inventory.items().some((i) => isHatedFood(i.name));
          return { ok: false, message: onlyHated ? "only food I hate; will eat it only when starving" : "no food" };
        }
        if (isHatedFood(food.name) && bot.food > 6) {
          return { ok: false, message: `refused ${food.name}: the character hates it` };
        }
        await bot.equip(food, "hand");
        await bot.consume();
        return { ok: true, message: `ate ${food.name}` };
      }

      case "attack": {
        return await boundedCombat(bot, action);
      }

      case "smelt":
      case "furnace": {
        return await smeltItems(bot, action);
      }

      case "use_item":
      case "activate_item": {
        return await useHeldItem(bot, action);
      }

      case "use_block":
      case "activate_block": {
        return await useWorldBlock(bot, action);
      }

      case "sleep": {
        return await sleepInBed(bot, action);
      }

      case "wake": {
        if (typeof bot.wake !== "function") return { ok: false, message: "wake is unavailable" };
        await withTimeout(Promise.resolve(bot.wake()), 8000, "wake timeout");
        return { ok: true, message: "woke up" };
      }

      case "container_list":
      case "container_take":
      case "container_withdraw":
      case "container_put":
      case "container_deposit": {
        return await useContainer(bot, action, type);
      }

      case "place": {
        const itemName = action.item || action.block || action.name;
        const item = bot.inventory.items().find((i) => i.name === itemName || i.name.includes(itemName));
        if (!item) return { ok: false, message: `no block ${itemName}` };
        const direction = faceVec(action.face || "top");
        const target = placementTarget(bot, action, direction);
        if (!target) return { ok: false, message: "no safe placement target; provide x,y,z" };
        const existing = bot.blockAt(target);
        if (existing && !["air", "cave_air", "void_air"].includes(existing.name)) {
          return { ok: false, message: `placement target occupied by ${existing.name}` };
        }
        const ref = bot.blockAt(target.minus(direction));
        if (!ref) return { ok: false, message: "no reference block" };
        if (ref.name === "air") return { ok: false, message: "reference block is air" };
        if (ref.position.distanceTo(bot.entity.position) > 4.2) {
          await goto(bot, new goals.GoalNear(ref.position.x, ref.position.y, ref.position.z, 3), 30000);
        }
        await bot.equip(item, "hand");
        await bot.placeBlock(ref, direction);
        const placed = bot.blockAt(target);
        if (!placed || ["air", "cave_air", "void_air"].includes(placed.name)) {
          return { ok: false, message: `${item.name} placement was not confirmed` };
        }
        return { ok: true, message: `placed ${placed.name} at ${formatPos(target)}` };
      }

      case "set_goal": {
        return { ok: true, message: "goal handled by brain", meta: { goal: action.goal || action.text } };
      }

      case "none":
      case "idle":
        bot.pathfinder.setGoal(null);
        return { ok: true, message: "idle" };

      default:
        return { ok: false, message: `unknown action type: ${type}` };
    }
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

function faceVec(face) {
  switch (face) {
    case "bottom":
      return new Vec3(0, -1, 0);
    case "north":
      return new Vec3(0, 0, -1);
    case "south":
      return new Vec3(0, 0, 1);
    case "west":
      return new Vec3(-1, 0, 0);
    case "east":
      return new Vec3(1, 0, 0);
    default:
      return new Vec3(0, 1, 0);
  }
}

function nearestPlayer(bot) {
  let best = null;
  let bestD = Infinity;
  for (const p of Object.values(bot.players)) {
    if (!p.entity || p.username === bot.username) continue;
    const d = p.entity.position.distanceTo(bot.entity.position);
    if (d < bestD) {
      bestD = d;
      best = p.entity;
    }
  }
  return best;
}

async function boundedCombat(bot, action) {
  const maxDistance = finiteNumber(action.maxDistance, 16, 3, 32);
  const maxDurationMs = finiteNumber(action.maxDurationMs ?? action.timeoutMs, 12000, 1000, 30000);
  const cooldownMs = finiteNumber(action.cooldownMs, 700, 450, 1500);
  const fleeAtHealth = finiteNumber(action.fleeAtHealth, 6, 1, 19);
  const options = {
    name: action.name || action.mob || action.entity,
    maxDistance,
    allowPlayers: action.allowPlayers === true,
    selfUsername: bot.username,
  };
  let target = selectNearestCombatTarget(bot.entities, bot.entity.position, options);
  if (!target) return { ok: false, message: `no safe target nearby: ${options.name || "mob"}` };
  if (Number(bot.health) <= fleeAtHealth) {
    return { ok: false, message: `combat refused at low health (${bot.health})` };
  }

  await equipBestWeapon(bot, action.weapon);
  const targetId = target.id;
  const label = target.username || target.name || String(target.displayName || "mob");
  const deadline = Date.now() + maxDurationMs;
  let hits = 0;

  try {
    while (Date.now() < deadline) {
      if (Number(bot.health) <= fleeAtHealth) {
        return { ok: false, message: `retreated from ${label}: health=${bot.health}, hits=${hits}` };
      }
      target = bot.entities[targetId];
      if (!target || target.isValid === false) {
        return hits > 0
          ? { ok: true, message: `target ${label} gone after ${hits} hit(s)` }
          : { ok: false, message: `target ${label} disappeared before attack` };
      }

      const distance = distanceBetween(bot.entity.position, target.position);
      if (!Number.isFinite(distance) || distance > maxDistance + 4) {
        return { ok: false, message: `target ${label} escaped (${round1(distance)}m)` };
      }
      if (distance > 3.1) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2.4), true);
        await sleep(150);
        continue;
      }

      bot.pathfinder.setGoal(null);
      const aim = target.position.offset(0, Math.max(0.5, (target.height || 1.6) * 0.7), 0);
      await bot.lookAt(aim, true);
      await Promise.resolve(bot.attack(target));
      hits += 1;
      await sleep(cooldownMs);
    }
    return { ok: false, message: `combat timeout against ${label} after ${hits} hit(s)` };
  } finally {
    bot.pathfinder.setGoal(null);
  }
}

async function smeltItems(bot, action) {
  const inputName = action.input || action.item || action.name;
  const requested = normalizeActionCount(action.count, 1, 16);
  if (!inputName) return { ok: false, message: "smelt needs input item" };
  if (!requested) return { ok: false, message: "smelt count must be 1..16" };

  const furnaceBlock = findActionBlock(bot, action, FURNACE_BLOCKS, action.furnace || "furnace", 32);
  if (!furnaceBlock) return { ok: false, message: "no furnace/blast_furnace/smoker nearby" };
  await approachBlock(bot, furnaceBlock, 30000);

  let furnace = null;
  try {
    furnace = await withTimeout(Promise.resolve(bot.openFurnace(furnaceBlock)), 8000, "open furnace timeout");

    // A retry should recover completed output before trying to add another batch.
    const ready = furnace.outputItem();
    if (ready) {
      const expected = String(action.output || "");
      if (expected && !itemNameMatches(ready.name, expected)) {
        return { ok: false, message: `furnace output is ${ready.name}, expected ${expected}` };
      }
      const taken = await withTimeout(furnace.takeOutput(), 8000, "take furnace output timeout");
      return { ok: true, message: `took smelted ${taken?.name || ready.name} x${taken?.count || ready.count}` };
    }

    const existingInput = furnace.inputItem();
    if (existingInput && !itemNameMatches(existingInput.name, inputName)) {
      return { ok: false, message: `furnace is busy with ${existingInput.name}` };
    }
    const inventoryInput = findInventoryItem(bot, inputName);
    const addCount = inventoryInput ? Math.min(requested, inventoryInput.count) : 0;
    const batchCount = addCount || Math.min(requested, existingInput?.count || 0);
    if (!batchCount) return { ok: false, message: `no ${inputName} to smelt` };

    const existingFuel = furnace.fuelItem();
    const fuel = chooseFuel(bot, action.fuel, existingFuel?.name);
    const capacity = fuelCapacity(existingFuel?.name || fuel?.name);
    const alreadyBurningFor = Math.max(0, Math.floor((Number(furnace.fuelSeconds) || 0) / 10));
    const remainingSmelts = Math.max(0, batchCount - alreadyBurningFor);
    const fuelNeeded = remainingSmelts > 0 ? Math.max(1, Math.ceil(remainingSmelts / Math.max(capacity, 0.25))) : 0;
    const fuelAlready = existingFuel?.count || 0;
    const fuelToAdd = Math.max(0, fuelNeeded - fuelAlready);
    if (fuelToAdd > 0 && (!fuel || fuel.count < fuelToAdd)) {
      return { ok: false, message: `not enough fuel for ${batchCount} ${inputName}` };
    }

    if (fuelToAdd > 0 && fuel?.count >= fuelToAdd) {
      await withTimeout(furnace.putFuel(fuel.type, fuel.metadata, fuelToAdd), 8000, "put fuel timeout");
    }
    if (addCount > 0) {
      await withTimeout(
        furnace.putInput(inventoryInput.type, inventoryInput.metadata, addCount),
        8000,
        "put furnace input timeout"
      );
    }

    const timeoutMs = finiteNumber(action.timeoutMs, batchCount * 11000 + 15000, 15000, 180000);
    await waitFor(
      () => {
        const output = furnace.outputItem();
        return output && output.count >= batchCount;
      },
      timeoutMs,
      500,
      `smelting timeout for ${inputName}`
    );
    const output = furnace.outputItem();
    const expected = String(action.output || "");
    if (expected && output && !itemNameMatches(output.name, expected)) {
      return { ok: false, message: `smelt produced ${output.name}, expected ${expected}` };
    }
    const taken = await withTimeout(furnace.takeOutput(), 8000, "take furnace output timeout");
    return { ok: true, message: `smelted ${inputName} -> ${taken?.name || output?.name} x${taken?.count || output?.count}` };
  } finally {
    try {
      furnace?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

async function useHeldItem(bot, action) {
  const itemName = action.item || action.name;
  if (itemName) {
    const item = findInventoryItem(bot, itemName);
    if (!item) return { ok: false, message: `no item ${itemName}` };
    await bot.equip(item, action.offHand ? "off-hand" : "hand");
  }
  if (!bot.heldItem && !action.offHand) return { ok: false, message: "no held item to use" };

  const target = vecFromAction(action);
  if (target) await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
  await Promise.resolve(bot.activateItem(Boolean(action.offHand)));
  const durationMs = finiteNumber(action.durationMs, 120, 50, 5000);
  await sleep(durationMs);
  bot.deactivateItem();
  return { ok: true, message: `used ${itemName || bot.heldItem?.name || "held item"}` };
}

async function useWorldBlock(bot, action) {
  const wanted = action.block || action.target || action.name;
  const block = findActionBlock(bot, action, null, wanted, finiteNumber(action.maxDistance, 32, 2, 64));
  if (!block || block.name === "air") return { ok: false, message: `block not found: ${wanted || "coords"}` };
  await approachBlock(bot, block, 30000);
  const itemName = action.item;
  if (itemName) {
    const item = findInventoryItem(bot, itemName);
    if (!item) return { ok: false, message: `no item ${itemName}` };
    await bot.equip(item, action.offHand ? "off-hand" : "hand");
  }
  const direction = faceVec(action.face || "top");
  await withTimeout(
    Promise.resolve(bot.activateBlock(block, direction, new Vec3(0.5, 0.5, 0.5))),
    8000,
    "use block timeout"
  );
  return {
    ok: true,
    message: `activated ${block.name} with ${itemName || "hand"} at ${formatPos(block.position)}; no placement is implied`,
  };
}

async function sleepInBed(bot, action) {
  let bed = null;
  const at = vecFromAction(action);
  if (at) bed = bot.blockAt(at);
  if (!bed) {
    bed = bot.findBlock({
      matching: (block) => block && (bot.isABed?.(block) || block.name.endsWith("_bed")),
      maxDistance: finiteNumber(action.maxDistance, 32, 2, 64),
    });
  }
  if (!bed || !(bot.isABed?.(bed) || bed.name.endsWith("_bed"))) {
    return { ok: false, message: "no bed nearby" };
  }
  await approachBlock(bot, bed, 30000);
  await withTimeout(Promise.resolve(bot.sleep(bed)), 10000, "sleep timeout");
  return { ok: true, message: `sleeping in ${bed.name} at ${formatPos(bed.position)}` };
}

async function useContainer(bot, action, type) {
  const wanted = action.container || action.block;
  const block = findActionBlock(
    bot,
    action,
    CONTAINER_BLOCKS,
    wanted,
    finiteNumber(action.maxDistance, 32, 2, 64)
  );
  if (!block) return { ok: false, message: `container not found: ${wanted || "nearest"}` };
  await approachBlock(bot, block, 30000);

  let window = null;
  try {
    window = await withTimeout(Promise.resolve(bot.openContainer(block)), 8000, "open container timeout");
    if (type === "container_list") {
      const contents = summarizeItems(window.containerItems());
      return {
        ok: true,
        message: `${block.name} contents: ${contents.length ? contents.join(", ") : "empty"}`,
        meta: { contents },
      };
    }

    const itemName = action.item || action.name;
    const count = normalizeActionCount(action.count, 1, 64);
    if (!itemName) return { ok: false, message: `${type} needs item` };
    if (!count) return { ok: false, message: `${type} count must be positive` };

    if (type === "container_take" || type === "container_withdraw") {
      const item = findNamedItem(window.containerItems(), itemName);
      if (!item) return { ok: false, message: `container has no ${itemName}` };
      const moved = Math.min(count, totalItemCount(window.containerItems(), item.type, item.metadata));
      await withTimeout(window.withdraw(item.type, item.metadata, moved, null), 10000, "container withdraw timeout");
      return { ok: true, message: `took ${item.name} x${moved} from ${block.name}` };
    }

    const item = findInventoryItem(bot, itemName);
    if (!item) return { ok: false, message: `inventory has no ${itemName}` };
    const moved = Math.min(count, totalItemCount(bot.inventory.items(), item.type, item.metadata));
    await withTimeout(window.deposit(item.type, item.metadata, moved, null), 10000, "container deposit timeout");
    return { ok: true, message: `put ${item.name} x${moved} into ${block.name}` };
  } finally {
    try {
      window?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

function findActionBlock(bot, action, allowedNames, wantedName, maxDistance) {
  const at = vecFromAction(action);
  if (at) return bot.blockAt(at);
  const wanted = String(wantedName || "").toLowerCase();
  return bot.findBlock({
    matching: (block) => {
      if (!block) return false;
      if (wanted && itemNameMatches(block.name, wanted)) return true;
      if (!allowedNames) return false;
      return allowedNames.has(block.name) || (allowedNames === CONTAINER_BLOCKS && block.name.endsWith("_shulker_box"));
    },
    maxDistance,
  });
}

async function approachBlock(bot, block, timeoutMs) {
  if (distanceBetween(bot.entity.position, block.position) <= 3.5) return;
  await goto(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3), timeoutMs);
}

function findInventoryItem(bot, wantedName) {
  return findNamedItem(bot.inventory.items(), wantedName);
}

function findNamedItem(items, wantedName) {
  const wanted = String(wantedName || "").toLowerCase();
  return (
    items.find((item) => String(item.name || "").toLowerCase() === wanted) ||
    items.find((item) => String(item.name || "").toLowerCase().includes(wanted)) ||
    null
  );
}

function totalItemCount(items, type, metadata) {
  return items
    .filter((item) => item.type === type && (metadata == null || item.metadata === metadata))
    .reduce((sum, item) => sum + item.count, 0);
}

function summarizeItems(items) {
  const counts = new Map();
  for (const item of items || []) counts.set(item.name, (counts.get(item.name) || 0) + item.count);
  return [...counts.entries()].slice(0, 24).map(([name, count]) => `${name} x${count}`);
}

function itemNameMatches(actual, wanted) {
  const a = String(actual || "").toLowerCase();
  const w = String(wanted || "").toLowerCase();
  return Boolean(w) && (a === w || a.includes(w));
}

function fuelCapacity(name) {
  for (const [pattern, capacity] of FUEL_CAPACITY) {
    if (pattern.test(String(name || ""))) return capacity;
  }
  return 0;
}

function chooseFuel(bot, requestedName, existingName) {
  if (requestedName) return findInventoryItem(bot, requestedName);
  if (existingName) {
    const same = findInventoryItem(bot, existingName);
    if (same) return same;
  }
  const preferred = ["coal", "charcoal", "coal_block", "dried_kelp_block", "blaze_rod"];
  for (const name of preferred) {
    const item = findInventoryItem(bot, name);
    if (item) return item;
  }
  return bot.inventory.items().find((item) => fuelCapacity(item.name) > 0) || null;
}

export async function equipBestWeapon(bot, requestedName) {
  const requested = requestedName ? findInventoryItem(bot, requestedName) : null;
  if (requestedName && !requested) throw new Error(`no weapon ${requestedName}`);
  const materialScore = { netherite: 60, diamond: 50, iron: 40, stone: 30, golden: 20, wooden: 10 };
  const candidates = bot.inventory.items().filter((item) => /_(sword|axe)$/.test(item.name));
  candidates.sort((a, b) => weaponScore(b.name, materialScore) - weaponScore(a.name, materialScore));
  const weapon = requested || candidates[0];
  if (weapon) await bot.equip(weapon, "hand");
  return weapon || null;
}

export async function equipBestShield(bot) {
  const shield = bot.inventory.items().find((item) => item.name === "shield");
  if (!shield) return null;
  try {
    await bot.equip(shield, "off-hand");
    return shield;
  } catch {
    return null;
  }
}

const EDIBLE = /^(cooked_[a-z_]+|bread|apple|golden_apple|enchanted_golden_apple|carrot|golden_carrot|potato|baked_potato|melon_slice|sweet_berries|glow_berries|beetroot|dried_kelp|cookie|pumpkin_pie|mushroom_stew|beetroot_soup|rabbit_stew|suspicious_stew|honey_bottle|beef|porkchop|mutton|chicken|rabbit|cod|salmon|tropical_fish|rotten_flesh|spider_eye|chorus_fruit)$/;
const foodPreferences = { favorite: new Set(), hated: new Set() };

/** Character taste set by the desktop app: favourites are eaten first, hated food only when starving. */
export function setFoodPreferences({ favorite = [], hated = [] } = {}) {
  foodPreferences.favorite = new Set(favorite.map(String));
  foodPreferences.hated = new Set(hated.map(String));
}

export function isHatedFood(name) {
  return foodPreferences.hated.has(String(name || ""));
}

export function pickBestFood(bot) {
  const items = bot.inventory.items();
  const starving = Number(bot.food) <= 6;
  const favourite = items.find((i) => foodPreferences.favorite.has(i.name));
  if (favourite) return favourite;
  const pick = pickBestFoodByQuality(items.filter((i) => !foodPreferences.hated.has(i.name)));
  if (pick) return pick;
  return starving ? items.find((i) => foodPreferences.hated.has(i.name) && EDIBLE.test(i.name)) || null : null;
}

function pickBestFoodByQuality(items) {
  const preferred = [
    "golden_apple",
    "enchanted_golden_apple",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_mutton",
    "cooked_chicken",
    "cooked_salmon",
    "cooked_cod",
    "bread",
    "baked_potato",
    "apple",
    "carrot",
    "cooked_rabbit",
  ];
  for (const name of preferred) {
    const hit = items.find((i) => i.name === name);
    if (hit) return hit;
  }
  return items.find((i) => /^(cooked_|bread|apple|carrot|potato|melon|berry|stew|soup)/.test(i.name)) || null;
}

function weaponScore(name, materialScore) {
  const material = Object.keys(materialScore).find((key) => name.startsWith(`${key}_`));
  return (materialScore[material] || 0) + (name.endsWith("_sword") ? 5 : 0);
}

function placementTarget(bot, action, direction) {
  const explicit = vecFromAction(action);
  if (explicit) return explicit;
  if (direction.x !== 0 || direction.y !== 1 || direction.z !== 0) return null;
  const base = bot.entity.position.floored();
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const target = base.offset(dx, 0, dz);
    const at = bot.blockAt(target);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (["air", "cave_air", "void_air"].includes(at?.name) && below && below.name !== "air") return target;
  }
  return null;
}

function vecFromAction(action) {
  if (action.x == null || action.y == null || action.z == null) return null;
  const x = Number(action.x);
  const y = Number(action.y);
  const z = Number(action.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
}

function finiteNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function distanceBetween(a, b) {
  if (!a || !b) return Infinity;
  if (typeof a.distanceTo === "function") return a.distanceTo(b);
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : "?";
}

function formatPos(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

async function waitFor(predicate, timeoutMs, intervalMs, timeoutMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(timeoutMessage);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function equipBestTool(bot, block) {
  try {
    if (bot.tool?.equipForBlock) {
      await bot.tool.equipForBlock(block, { requireHarvest: true });
      return;
    }
  } catch {
    /* fallthrough */
  }
  // best-effort: pickaxe / axe / shovel by name
  const name = block.name || "";
  let prefer = "pickaxe";
  if (/log|wood|plank|leaves|bamboo/.test(name)) prefer = "axe";
  if (/dirt|sand|gravel|clay|soul|grass|mud|snow|farmland/.test(name)) prefer = "shovel";
  const tool = bot.inventory.items().find((i) => i.name.includes(prefer));
  if (tool) {
    try {
      await bot.equip(tool, "hand");
    } catch {
      /* ignore */
    }
  }
}

function setupMovements(bot, mcData) {
  const movements = new Movements(bot, mcData);
  movements.canDig = true;
  movements.allowSprinting = true;
  bot.pathfinder.setMovements(movements);
}

async function goto(bot, goal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    let poll = null;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      bot.removeListener("goal_reached", onReached);
      bot.removeListener("path_update", onPath);
      fn();
    };
    timer = setTimeout(() => {
      bot.pathfinder.setGoal(null);
      finish(() => reject(new Error("pathfinder timeout")));
    }, finiteNumber(timeoutMs, 45000, 1000, 180000));
    const onReached = () => finish(() => resolve());
    const onPath = (r) => {
      if (r?.status === "noPath") {
        bot.pathfinder.setGoal(null);
        finish(() => reject(new Error("no path")));
      }
    };
    bot.once("goal_reached", onReached);
    bot.on("path_update", onPath);
    bot.pathfinder.setGoal(goal);
    poll = setInterval(() => {
      // goal completed / cancelled
      if (!bot.pathfinder.goal) finish(() => resolve());
    }, 500);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { setupMovements };
