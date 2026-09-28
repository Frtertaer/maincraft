import pkgPathfinder from "mineflayer-pathfinder";
import { Vec3 } from "vec3";

const { goals, Movements } = pkgPathfinder;

// While a container window is open the server addresses slot updates to it,
// not window 0 — bot.inventory drifts (crafted items look missing). The open
// window's inventory range is the fresh view.
function invItems(bot) {
  const win = bot.currentWindow;
  // the cursor-held item lives on window.selectedItem, outside slots — a
  // crafted result sits there until its placement confirms, so count it or
  // "did not increase inventory" false-negatives fire on every slow ack
  const cursor = win?.selectedItem ? [win.selectedItem] : (bot.inventory?.selectedItem ? [bot.inventory.selectedItem] : []);
  if (
    win &&
    win !== bot.inventory &&
    typeof win.inventoryStart === "number" &&
    win.inventoryStart < (win.slots?.length || 0)
  ) {
    return win.slots.slice(win.inventoryStart).filter(Boolean).concat(cursor);
  }
  return bot.inventory.items().concat(cursor);
}

// A craft aborted mid-click (timeout, thrown error) strands ingredients in
// the grid slots and on the cursor — invisible to findInventoryItem and to
// every later craft. Drag every grid slot and the cursor item back into the
// inventory range before the next attempt.
async function cleanCraftArea(bot) {
  const win = bot.currentWindow || bot.inventory;
  const gridEnd = win === bot.inventory ? 4 : Math.min(9, (win.inventoryStart || 10) - 1);
  for (let s = 1; s <= gridEnd; s += 1) {
    if (win.slots?.[s]) {
      try {
        // mineflayer's clickWindow awaits a server transaction ack — a
        // dropped confirm hangs the whole run, so bound every click
        await withTimeout(bot.clickWindow(s, 0, 1), 6000, "click timeout"); // shift-click → moves to inventory range
      } catch {
        /* slot already moved */
      }
    }
  }
  // cursor may still hold an item — drop it onto any inventory slot it fits in
  for (let tries = 0; tries < 4 && win.selectedItem; tries += 1) {
    const empty = win.firstEmptyInventorySlot?.() ?? win.slots.findIndex((s, i) => !s && i >= (win.inventoryStart || 0));
    const target = empty >= 0 ? empty : win.slots.findIndex((s, i) => s && i >= (win.inventoryStart || 0) && s.type === win.selectedItem.type && s.count < 64);
    if (target < 0) break;
    try {
      await withTimeout(bot.simpleClick.leftMouse(target), 6000, "click timeout");
    } catch {
      break;
    }
  }
}

// Zombie-free shaped craft. mineflayer's bot.craft parks forever inside
// waitForWindowUpdate (no timeout) when a grid click is swallowed; an external
// timeout then abandons a pending updateSlot:0 listener that resolves inside
// the NEXT craft's window and corrupts it — the recurring "did not increase"
// desync chain. Here every await is bounded, the window is opened fresh per
// call and closed at the end, and the result slot is verified server-side
// before it is taken.
async function craftDirect(bot, recipe, count, craftingTable) {
  const CLICK_MS = 8000;
  let win = null;
  try {
    if (recipe.requiresTable) {
      if (!craftingTable) throw new Error("recipe requires craftingTable");
      win = await withTimeout(bot.openBlock(craftingTable), 10000, "open table");
      if (!win || !String(win.type || "").startsWith("minecraft:crafting")) {
        throw new Error(`non-crafting window: ${win?.type || "none"}`);
      }
      // re-anchor stateId: a stale counter makes the server silently drop
      // every ingredient click — the whole craft then never happens
      if (bot._syncWindow) await withTimeout(bot._syncWindow(win), 6000, "sync table").catch(() => {});
    } else {
      win = bot.inventory;
    }
    const w = recipe.requiresTable ? 3 : 2;
    const slotAt = (x, y) => 1 + x + w * y;
    const pick = async (ing) => {
      if (
        !win.selectedItem ||
        win.selectedItem.type !== ing.id ||
        (ing.metadata != null && win.selectedItem.metadata !== ing.metadata)
      ) {
        // ingredients stranded in the crafting grid/result slots by an
        // aborted earlier craft count in inventory totals but sit outside
        // findInventoryItem's range — check those cells too before failing
        const src =
          win.findInventoryItem(ing.id, ing.metadata) ||
          win.findItemRange(0, win.inventoryStart, ing.id, ing.metadata);
        if (!src) throw new Error("missing ingredient");
        await withTimeout(bot.clickWindow(src.slot, 0, 0), CLICK_MS, "pick");
      }
    };
    // place with verification: a stale stateId makes the server silently
    // reject a grid click — the cell stays empty while the cursor keeps the
    // stack, and the whole recipe then fails as an "empty grid". Confirm
    // each cell actually fills; resync + re-pick once when it doesn't.
    const placeAt = async (dest, ing) => {
      for (let t = 0; t < 2; t++) {
        await pick(ing);
        await withTimeout(bot.clickWindow(dest, 1, 0), CLICK_MS, "place");
        for (let w2 = 0; w2 < 8; w2++) {
          await sleep(120);
          const s = win.slots[dest];
          if (s && (ing.id == null || ing.id === -1 || s.type === ing.id)) return;
        }
        if (bot._syncWindow) await withTimeout(bot._syncWindow(win), 6000, "sync").catch(() => {});
      }
      const got = win.slots[dest]?.name || "air";
      throw new Error(`craft place rejected @${dest} want=${ing.id} got=${got}`);
    };
    for (let rep = 0; rep < count; rep += 1) {
      if (recipe.inShape) {
        for (let y = 0; y < recipe.inShape.length; y += 1) {
          const row = recipe.inShape[y];
          for (let x = 0; x < row.length; x += 1) {
            const ing = row[x];
            if (!ing || ing.id === -1) continue;
            await placeAt(slotAt(x, y), ing);
          }
        }
      } else if (recipe.ingredients) {
        const free = [];
        for (let y = 0; y < w; y += 1) for (let x = 0; x < w; x += 1) free.push(slotAt(x, y));
        for (const ing of recipe.ingredients) {
          const dest = free.pop();
          if (dest == null) throw new Error("grid full");
          await placeAt(dest, ing);
        }
      }
      // verify the server really produced the result — never click empty air
      for (let t = 0; t < 24 && !win.slots[0]; t += 1) await sleep(150);
      if (!win.slots[0]) throw new Error("craft result slot empty — server rejected the recipe");
      // take the result — but a stale stateId makes the server reject the
      // click and send a full-window correction that restores slots[0].
      // Confirm the item landed in the inventory section, resync+retry once.
      const want = win.slots[0].name;
      const secCount = () =>
        win.slots.slice(win.inventoryStart).reduce((n, s) => n + (s && s.name === want ? s.count : 0), 0) +
        (win.selectedItem?.name === want ? win.selectedItem.count : 0);
      const baseSec = secCount();
      let taken = false;
      for (let tries = 0; tries < 2 && !taken; tries += 1) {
        await withTimeout(bot.clickWindow(0, 0, 1), CLICK_MS, "result"); // shift-click → inventory
        for (let t = 0; t < 10 && !taken; t += 1) {
          await sleep(130);
          // decide only after ~1 RTT: optimistic slot edits are indistinguishable
          // from a confirmed take until the server's answer lands
          if (t < 4) continue;
          if (secCount() > baseSec) taken = true;                        // item really landed
          else if (win.slots[0]?.name === want) break;                   // preview restored = rejected
        }
        if (!taken && bot._syncWindow) {
          await withTimeout(bot._syncWindow(win), 6000, "sync").catch(() => {});
        }
      }
      if (!taken) {
        const desc = recipe.inShape ? "shape" : "shapeless";
        const grid = win.slots
          .slice(1, 1 + w * w)
          .map((s) => (s ? s.name : null))
          .join("|");
        throw new Error(`craft take rejected: ${want} [${desc}${recipe.requiresTable ? "+table" : ""} grid=${grid}]`);
      }
    }
    if (win.selectedItem) {
      await bot.putSelectedItemRange(win.inventoryStart, win.inventoryEnd, win, null).catch(() => {});
    }
    if (win !== bot.inventory) {
      await bot._syncWindow(win).catch(() => {});
      bot.closeWindow(win);
    }
  } catch (err) {
    try {
      if (win && win !== bot.inventory) bot.closeWindow(win);
    } catch {
      /* already closed */
    }
    throw err;
  }
}

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

  // mineflayer-collectblock swaps in its own bare Movements for the duration
  // of a collect — afterwards every pathfind runs with wrong config. Restore
  // our configured movements whenever that happened (tagged via _ours).
  if (mcData && bot.pathfinder && !bot.pathfinder.movements?._ours) {
    try {
      setupMovements(bot, mcData);
    } catch {
      /* ignore */
    }
  }

  // a leaked container/craft window remaps slot numbering — equip/moveSlotItem
  // then silently hit the WRONG slots (e.g. place keeps the pickaxe held and
  // the server refuses every block). Close anything left open before acting.
  if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
    try {
      bot.closeWindow(bot.currentWindow);
      await sleep(120);
    } catch {
      /* already closed */
    }
  }

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

      case "look_at_player": {
        const name = action.player || action.username || action.name;
        const player = name ? bot.players[name]?.entity : nearestPlayer(bot);
        if (!player) return { ok: false, message: `player not found: ${name || "?"}` };
        await bot.lookAt(player.position.offset(0, player.height ?? 1.6, 0));
        return { ok: true, message: `looking at ${player.username || name}` };
      }

      case "emote": {
        // Social gesture: wave/point/bow → arm swing; sit/crouch → brief sneak.
        const kind = String(action.kind || "wave").toLowerCase();
        const name = action.player || action.username;
        const player = name ? bot.players[name]?.entity : nearestPlayer(bot);
        if (player) {
          try {
            await bot.lookAt(player.position.offset(0, player.height ?? 1.6, 0));
          } catch {
            /* ignore */
          }
        }
        if (kind === "sit" || kind === "crouch" || kind === "sneak") {
          bot.setControlState("sneak", true);
          await sleep(1200);
          bot.setControlState("sneak", false);
        } else if (kind === "jump") {
          bot.setControlState("jump", true);
          await sleep(350);
          bot.setControlState("jump", false);
        } else {
          bot.swingArm("right");
        }
        return { ok: true, message: `emote ${kind}` };
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
        // equip can park forever on a dropped window-transaction ack — bound
        // it; the harvest check below still gates digging with the wrong tool
        await withTimeout(equipBestTool(bot, block), 9000, "equip tool timeout").catch(() => {});
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
        for (const target of dropVacuumTargets(bot, block.position)) {
          try {
            await goto(bot, new goals.GoalNear(target.x, target.y, target.z, 1), 5000);
          } catch {
            /* drop unreachable; leave it */
          }
        }
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
          count: Math.max(count, 24),
        });
        if (!targets.length) return { ok: false, message: `no ${blockName} nearby` };
        const invTypes = [null, ...bot.inventory.items().map((i) => i.type)];
        const canHarvest = (b) => {
          try {
            return invTypes.some((t) => b.canHarvest(t));
          } catch {
            return true;
          }
        };
        const exposed = (b) => {
          for (const [dx, dy, dz] of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ]) {
            const nb = bot.blockAt(b.position.offset(dx, dy, dz));
            if (nb && (nb.boundingBox === "empty" || /air|water|grass|fern|flower|sapling|snow|vine/.test(nb.name))) {
              return true;
            }
          }
          return false;
        };
        // targets that already returned ok with zero gain keep winning the
        // scan — after two misses each is skipped so collect moves to
        // genuinely different blocks instead of ping-ponging the same stump
        const badK = (p) => `${p.x},${p.y},${p.z}`;
        const blocks = targets
          .map((p) => bot.blockAt(p))
          .filter(
            (b) =>
              b &&
              canHarvest(b) &&
              exposed(b) &&
              (bot._badCollect?.get(badK(b.position)) || 0) < 2 &&
              (typeof action.filter !== "function" || action.filter(b))
          );
        if (!blocks.length) {
          return { ok: false, message: `no reachable ${blockName} (buried or missing tool)` };
        }
        // Collect pathfinds internally — mark the window so the combat reflex
        // can't steal the pathfinder to chase (it may still hit/kite/flee).
        bot._phaseMove = true;
        const nameRe = new RegExp(blockName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const countNamed = () =>
          bot.inventory
            .items()
            .filter((i) => nameRe.test(i.name))
            .reduce((n, i) => n + i.count, 0);
        const before = countNamed();
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
        } finally {
          if (bot._phaseMove === true) bot._phaseMove = null;
        }
        if (countNamed() <= before) {
          bot._badCollect = bot._badCollect || new Map();
          for (const b of blocks.slice(0, 6)) {
            const k = badK(b.position);
            bot._badCollect.set(k, (bot._badCollect.get(k) || 0) + 1);
          }
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

        // Prefer a table within 6 for EVERY recipe — 2x2 crafts work in the
        // 3x3 grid too, and the table gives us the resync-retry path (a
        // reopened window forces the server to resend all slots). Inventory
        // 2x2 is the fallback when no table is in reach.
        let craftingTable =
          typeof bot.findBlock === "function"
            ? bot.findBlock({
                matching: (b) => b && b.name === "crafting_table",
                maxDistance: 6,
              })
            : null;
        let recipes = craftingTable ? bot.recipesFor(item.id, null, 1, craftingTable) : [];
        if (!recipes.length) {
          craftingTable = null;
          recipes = bot.recipesFor(item.id, null, 1, null);
        }
        if (!recipes.length) {
          // Prefer closest table within 6, then 16 — avoid pathing across map to stale tables
          bot._badTables = bot._badTables || new Set();
          // the palette-level matcher gets a Block with position=null —
          // guard it; the per-block matcher sees the real position
          const reach = (b) =>
            b && b.name === "crafting_table" &&
            !(b.position && bot._badTables.has(`${b.position.x},${b.position.y},${b.position.z}`));
          craftingTable =
            bot.findBlock({ matching: reach, maxDistance: 6 }) ||
            bot.findBlock({ matching: reach, maxDistance: 16 });
          if (!craftingTable) {
            return {
              ok: false,
              message: `no recipe for ${itemName} (need crafting_table in world for 3x3)`,
            };
          }
          craftingTable = bot.blockAt(craftingTable.position) || craftingTable;
          recipes = bot.recipesFor(item.id, null, 1, craftingTable);
          if (!recipes.length) {
            return {
              ok: false,
              message: `no craftable recipe for ${itemName} at table (missing materials?)`,
            };
          }
        } else if (!craftingTable) {
          // even for a 2x2 recipe, prefer a nearby real table: its window
          // opens with server-authoritative slots, while the always-open
          // player inventory can carry stale state (the desync class that
          // produces phantom "missing ingredient" failures)
          const nearby = bot.findBlock?.({ matching: (b) => b && b.name === "crafting_table" &&
            !(b.position && (bot._badTables || new Set()).has(`${b.position.x},${b.position.y},${b.position.z}`)), maxDistance: 16 });
          if (nearby) {
            craftingTable = bot.blockAt(nearby.position) || nearby;
            const tableRecipes = bot.recipesFor(item.id, null, 1, craftingTable);
            if (tableRecipes.length) recipes = tableRecipes;
          }
        }

        if (craftingTable) {
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
                // unreachable table (sealed pocket, cliff): blacklist it so the
                // next craft call walks to a different table instead of stalling
                // on this same one forever
                (bot._badTables = bot._badTables || new Set()).add(
                  `${craftingTable.position.x},${craftingTable.position.y},${craftingTable.position.z}`
                );
                return { ok: false, message: `path to table: ${err.message || err}` };
              }
            }
          }
          craftingTable = bot.blockAt(craftingTable.position) || craftingTable;
        }

        // prefer a recipe whose concrete ingredient ids are actually in the
        // inventory — tag-based recipes can carry placeholder ids that pass
        // the delta check but fail findInventoryItem at click time
        const recipeFits = (r) => {
          const need = {};
          const add = (ing) => {
            if (ing && ing.id != null && ing.id !== -1) need[ing.id] = (need[ing.id] || 0) + 1;
          };
          if (r.inShape) r.inShape.forEach((row) => row.forEach(add));
          if (r.ingredients) r.ingredients.forEach(add);
          return Object.entries(need).every(([id, n]) => bot.inventory.count(+id, null) >= n);
        };
        const recipe = recipes.find(recipeFits) || recipes[0];
        const plan = computeCraftPlan(recipe, count);
        if (!plan) return { ok: false, message: `bad craft plan for ${itemName}` };

        const before = invItems(bot).reduce((n, i) => (i.name === itemName ? n + i.count : n), 0);
        // One resync-retry for "missing ingredient": a desynced client can
        // think it lacks items the server knows it has. Reopening the table
        // forces a full slot resend, then the craft goes through.
        let craftErr = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          craftErr = null;
          // a stale half-open table window from an aborted prior craft makes
          // every later click land in the wrong window — close it first
          if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
            try {
              bot.closeWindow(bot.currentWindow);
              await sleep(200);
            } catch {
              /* already closed */
            }
          }
          // a previous aborted craft may have left ingredients in the grid or
          // on the cursor — evacuate before every attempt
          await cleanCraftArea(bot).catch(() => {});
          await craftDirect(bot, recipe, plan.repetitions, craftingTable).catch((err) => {
            craftErr = err;
          });
          if (!craftErr) break;
          if (attempt === 0) {
            try {
              await cleanCraftArea(bot);
              if (craftingTable) {
                const w = await withTimeout(bot.openBlock(craftingTable), 8000, "open table timeout");
                if (bot._syncWindow) await withTimeout(bot._syncWindow(w), 6000, "sync table").catch(() => {});
                await sleep(300);
                if (w) bot.closeWindow(w);
              } else {
                // no table for 2x2 — a pick+drop click forces the server to
                // resend the player-window slots, repairing desynced state
                const inv = bot.inventory;
                const slot = inv.slots.findIndex((s) => s);
                if (slot >= 0) {
                  await withTimeout(bot.clickWindow(slot, 0, 0), 6000, "click timeout");
                  await withTimeout(bot.clickWindow(slot, 0, 0), 6000, "click timeout");
                }
              }
              await sleep(300);
              continue;
            } catch {
              /* resync failed — report the original craft error */
            }
          }
        }
        if (craftErr) {
          const inv = invItems(bot)
            .map((i) => `${i.name}x${i.count}`)
            .join(",");
          throw new Error(`${craftErr?.message || craftErr} | inv=[${inv}] table=${craftingTable ? "yes" : "no"}`);
        }
        // Server-side inventory sync lags table crafts: every set_slot went
        // to the table window while it was open, so bot.inventory only
        // catches up on the next resend. For a table craft, force that
        // resend NOW — reopen+close so every later countItem reads truth.
        if (!craftErr && craftingTable) {
          try {
            const w = await withTimeout(bot.openBlock(craftingTable), 8000, "resync open");
            if (bot._syncWindow) await withTimeout(bot._syncWindow(w), 6000, "sync table").catch(() => {});
            await sleep(350);
            if (w) bot.closeWindow(w);
            await sleep(250);
          } catch {
            /* resync best-effort — the poll below still gets a chance */
          }
        }
        let after = before;
        for (let i = 0; i < 60 && after <= before; i++) {
          await sleep(150);
          after = invItems(bot).reduce((n, it) => (it.name === itemName ? n + it.count : n), 0);
        }
        // Still no change: the client may have dropped window packets entirely.
        // Re-opening the crafting table forces the server to resend all slots,
        // which repairs a desynced inventory before we declare failure.
        if (after <= before) {
          try {
            if (craftingTable) {
              const win = await withTimeout(bot.openBlock(craftingTable), 8000, "open table timeout");
              await sleep(400);
              if (win) bot.closeWindow(win);
            } else {
              const slot = bot.inventory.slots.findIndex((s) => s);
              if (slot >= 0) {
                await withTimeout(bot.clickWindow(slot, 0, 0), 6000, "click timeout");
                await withTimeout(bot.clickWindow(slot, 0, 0), 6000, "click timeout");
              }
            }
            for (let i = 0; i < 30 && after <= before; i++) {
              await sleep(150);
              after = invItems(bot).reduce((n, it) => (it.name === itemName ? n + it.count : n), 0);
            }
          } catch {
            /* resync failed — fall through to the failure verdict */
          }
        }
        if (after <= before) {
          // final grace: the server's set_slot burst can land well after the
          // resync — one long sleep + recount catches stragglers before a
          // false-negative verdict burns a retry and a stuck tick
          await sleep(2500);
          after = invItems(bot).reduce((n, it) => (it.name === itemName ? n + it.count : n), 0);
        }
        if (after <= before) {
          const win = bot.currentWindow;
          const winDump = win
            ? ` win=${win.type} slots=[${(win.slots || [])
                .map((s, i) => (s ? `${i}:${s.name}x${s.count}` : null))
                .filter(Boolean)
                .join(",")}]`
            : " win=none";
          return {
            ok: false,
            message: `craft ${itemName} did not increase inventory (before=${before} after=${after})${winDump}`,
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
        await withTimeout(bot.equip(item, dest), 8000, "equip timeout");
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
        const FOOD =
          /cooked|beef|pork|bread|apple|carrot|potato|baked|chicken|cod|salmon|cookie|melon|pie|stew|soup|berries|mutton|rabbit(?!_foot|_hide)|beetroot(?!_seeds)|dried_kelp|honey_bottle|chorus_fruit|rotten_flesh/;
        const wanted = action.item ? String(action.item) : null;
        const foods = bot.inventory
          .items()
          .filter((i) => bot.food < 20 && FOOD.test(i.name) && (!wanted || i.name === wanted));
        const food = foods[0];
        if (!food) return { ok: false, message: "no food" };
        await withTimeout(bot.equip(food, "hand"), 8000, "equip timeout");
        await withTimeout(bot.consume(), 10000, "consume timeout");
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
        // tools/weapons aren't placeable — a confused caller (LLM) picking a
        // sword as filler gets a readable failure, not a server refuse. Use the
        // bot's own registry — always present — not the caller-supplied mcData
        const blocksByName = bot.registry?.blocksByName || mcData?.blocksByName;
        if (blocksByName && !blocksByName[item.name]) {
          return { ok: false, message: `${item.name} is not a placeable block` };
        }
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
        await withTimeout(bot.equip(item, "hand"), 6000, "equip timeout");
        // equip resolves before the server swaps the held slot — placing
        // with a stale item (e.g. wooden_sword in hand) makes the server
        // refuse, and mineflayer's error names heldItem, not our item
        if (bot.heldItem?.name !== item.name) {
          await sleep(120);
          if (bot.heldItem?.name !== item.name) {
            try {
              await withTimeout(bot.equip(item, "hand"), 6000, "equip timeout");
              await sleep(120);
            } catch {
              /* fall through to the desync check */
            }
          }
        }
        // equip resolved but the held slot never changed — the move was
        // silently rejected (stale window state, leaked container). Bail with
        // the real cause instead of a guaranteed server refuse.
        if (bot.heldItem?.name !== item.name) {
          return { ok: false, message: `equip desync: held=${bot.heldItem?.name || "empty"} want=${item.name}` };
        }
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
    if (err?.stack) console.error(`[actions] ${type} crash: ${err.stack}`);
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

function dropVacuumTargets(bot, origin) {
  const targets = [origin.floored().offset(0.5, 0, 0.5)];
  for (const entity of Object.values(bot.entities)) {
    if (!entity?.position || typeof entity.getDroppedItem !== "function") continue;
    try {
      if (!entity.getDroppedItem()) continue;
    } catch {
      continue;
    }
    if (entity.position.distanceTo(origin) > 7) continue;
    targets.push(entity.position.floored().offset(0.5, 0, 0.5));
    if (targets.length >= 4) break;
  }
  return targets;
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
      // passive prey sprints when hit — the ~36m escape leash is how every
      // sheep hunt ends with zero wool. persistent hunts hold the chase and
      // only give up when the target is truly gone (despawned / 60m out)
      const leash = action.persistent ? 60 : maxDistance + 4;
      if (!Number.isFinite(distance) || distance > leash) {
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
    await withTimeout(bot.equip(item, action.offHand ? "off-hand" : "hand"), 6000, "equip timeout");
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
    await withTimeout(bot.equip(item, action.offHand ? "off-hand" : "hand"), 6000, "equip timeout");
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
  if (weapon) await withTimeout(bot.equip(weapon, "hand"), 6000, "equip timeout");
  return weapon || null;
}

export async function equipBestShield(bot) {
  const shield = bot.inventory.items().find((item) => item.name === "shield");
  if (!shield) return null;
  try {
    await withTimeout(bot.equip(shield, "off-hand"), 6000, "equip timeout");
    return shield;
  } catch {
    return null;
  }
}

export function pickBestFood(bot) {
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
  const items = bot.inventory.items();
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
      await withTimeout(bot.tool.equipForBlock(block, { requireHarvest: true }), 8000, "equipForBlock timeout");
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
      await withTimeout(bot.equip(tool, "hand"), 6000, "equip timeout");
    } catch {
      /* ignore */
    }
  }
}

function setupMovements(bot, mcData) {
  const movements = new Movements(bot, mcData);
  movements.canDig = true;
  movements.allowSprinting = true;
  movements._ours = true;
  bot.pathfinder.setMovements(movements);
  // mineflayer-tool bug: equipForBlock recurses forever when the bot owns no
  // item that can harvest the target and getFromChest is set — retrieveTools
  // resolves instantly on an empty chest list, so each recursion level leaves a
  // suspended async frame until the process OOMs. Strip getFromChest when no
  // chests are configured so it errors out instead of recursing.
  if (bot.tool?.equipForBlock && !bot.tool._equipPatched) {
    const orig = bot.tool.equipForBlock.bind(bot.tool);
    bot.tool.equipForBlock = (block, options = {}, cb) => {
      if (options.getFromChest && !(bot.tool.chestLocations?.length)) {
        const { getFromChest, ...rest } = options;
        options = rest;
      }
      return orig(block, options, cb);
    };
    bot.tool._equipPatched = true;
  }
  // Unbounded A* search in dense 3D terrain (jungle canopy, caves) explodes the
  // node space until the process OOMs — cap cost radius and think time; all our
  // goals are local.
  bot.pathfinder.searchRadius = 48;
  bot.pathfinder.thinkTimeout = 2500;
}

async function goto(bot, goal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    let poll = null;
    const finish = (fn) => {
      if (done) return;
      done = true;
      if (bot._phaseMove === goal) bot._phaseMove = null;
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
    // goal_reached fires for ANY goal that completes — resolve only on ours,
    // or a combat-reflex goal finishing masquerades as our move succeeding.
    const onReached = (g) => {
      if (g === goal) finish(() => resolve());
    };
    const onPath = (r) => {
      if (r?.status === "noPath" && bot.pathfinder.goal === goal) {
        bot.pathfinder.setGoal(null);
        finish(() => reject(new Error("no path")));
      }
    };
    bot.on("goal_reached", onReached);
    bot.on("path_update", onPath);
    // Mark a phase-owned move in flight: the combat reflex must not steal the
    // pathfinder to chase while one is active (it may still hit/kite/flee).
    bot._phaseMove = goal;
    bot.pathfinder.setGoal(goal);
    poll = setInterval(() => {
      // Our goal was cleared or replaced (combat reflex, stop, another goto)
      if (bot.pathfinder.goal !== goal) finish(() => reject(new Error("goal superseded")));
    }, 250);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { setupMovements };
