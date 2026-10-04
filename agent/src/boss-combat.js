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

export function hasBow(bot) {
  return bot.inventory.items().some((i) => i.name === "bow" || i.name === "crossbow");
}

export async function bossCombatTick(bot, target, state, log = () => {}) {
  if (!bot?.entity || !target) return false;
  const name = mobName(target);
  if (!isBossMobName(name)) return false;
  // Boss ticks await hundreds of ms (eat/equip/place/shoot); without a busy
  // guard the 40ms combat loop runs them concurrently and stale ticks
  // clobber the fresh one's goals — the bot just freezes in place.
  if (state._tickBusy) return true;
  state._tickBusy = true;
  try {
    state.lastBoss = name;
    state.bossTicks = (state.bossTicks || 0) + 1;
    if (name === "ender_dragon") return await dragonTick(bot, target, state, log);
    if (name === "wither") return await witherTick(bot, target, state, log);
    if (name === "warden") return await wardenTick(bot, target, state, log);
    return false;
  } finally {
    state._tickBusy = false;
  }
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
  if (bot._placingTower) return; // tower hop+place owns the hand
  if (now - (state.lastEatAt || 0) < 1800) return;
  // top off — a starving bot is a slow, soon dead bot (starve ticks also
  // pollute the hurt-window detector)
  if (Number(bot.health) > 15 && Number(bot.food) > 17) return;
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
// Honest fight: bow while it hovers out of reach, melee when it
// comes down (armored <50% HP phase stays at head level anyway).
async function witherTick(bot, wither, state, log) {
  const now = Date.now();
  if (!state.witherSeenAt) state.witherSeenAt = now;
  const age = now - state.witherSeenAt;
  const dist = wither.position.distanceTo(bot.entity.position);
  const dy = wither.position.y - bot.entity.position.y;

  // Blue charge invuln ~10s — run from the spawn explosion
  if (age < 10500) {
    state.phase = "wither-wait";
    if (dist < 18) {
      try {
        bot.pathfinder?.setGoal(new goals.GoalInvert(new goals.GoalFollow(wither, 22)), true);
        bot.setControlState("sprint", true);
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  await tryEat(bot, state);

  // Melee when actually in reach (wither hovers ~2-4 above its target)
  if (dist <= 5.0 && dy <= 3.4) {
    state.phase = "wither-melee";
    try {
      bot.pathfinder?.setGoal(null);
      bot.setControlState("left", false);
      bot.setControlState("right", false);
      bot.setControlState("sprint", false);
    } catch {
      /* ignore */
    }
    await swing(bot, wither, state, 1.4);
    return true;
  }

  // Bow while it floats out of melee reach
  if (hasBow(bot) && hasArrows(bot) && dist < 55) {
    state.phase = "wither-bow";
    try {
      bot.pathfinder?.setGoal(null);
      // jink sideways between shots — wither skulls are slow projectiles
      if (!state.strafeDir || now - (state.strafeAt || 0) > 1400) {
        state.strafeDir = state.strafeDir === "left" ? "right" : "left";
        state.strafeAt = now;
      }
      bot.setControlState("left", state.strafeDir === "left");
      bot.setControlState("right", state.strafeDir === "right");
      bot.setControlState("sprint", false);
    } catch {
      /* ignore */
    }
    await shootAt(bot, wither.position.offset(0, 2.0, 0), state, 750);
    return true;
  }

  // No bow/arrows — chase for melee
  state.phase = "wither-chase";
  try {
    bot.setControlState("left", false);
    bot.setControlState("right", false);
    bot.setControlState("sprint", true);
    bot.pathfinder?.setGoal(new goals.GoalFollow(wither, 1.8), true);
  } catch {
    /* ignore */
  }
  return true;
}

// ─── Warden ───────────────────────────────────────────────────
// Fair fight: the sonic boom reaches 15 blocks horizontally / 20 vertically
// and pierces walls. Only two counter-plays work without commands:
//   1) stay beyond ~19 blocks and shoot (it gains while we draw, so kite wide)
//   2) snowball decoys — the warden investigates the loudest vibration and
//      a thrown snowball pulls it away for a few seconds.
const WARDEN_SAFE = 19; // beyond boom reach (15 horiz) with margin
const WARDEN_RETREAT_TO = 23;

// Dynamic goals re-follow the entity on their own — re-setting one every
// tick aborts the in-flight A* recompute and the bot freezes in place.
// Re-arm at most every `ms` or when the current goal has ended.
function refreshGoal(bot, state, key, goal, ms = 2500) {
  const now = Date.now();
  const tag = `_goal_${key}`;
  if (state[tag] && now - state[tag].at < ms && bot.pathfinder?.goal) return false;
  state[tag] = { at: now };
  try {
    bot.pathfinder?.setGoal(goal, true);
    return true;
  } catch {
    return false;
  }
}

function retreatFromWarden(bot, warden, state) {
  const ok = refreshGoal(
    bot,
    state,
    "wardenRetreat",
    new goals.GoalInvert(new goals.GoalFollow(warden, WARDEN_RETREAT_TO)),
    2500
  );
  bot.setControlState("sprint", true);
  if (!ok && !bot.pathfinder?.goal) hardKite(bot, warden);
}

async function throwDecoy(bot, warden, state, log) {
  const snowball =
    bot.inventory.items().find((i) => i.name === "snowball") ||
    bot.inventory.items().find((i) => i.name === "egg");
  if (!snowball) {
    if (!state._noDecoyLogged || Date.now() - state._noDecoyLogged > 15000) {
      state._noDecoyLogged = Date.now();
      log(
        `[boss] no decoy ammo; inventory=${bot.inventory
          .items()
          .map((i) => i.name)
          .join(",")}`
      );
    }
    return false;
  }
  const now = Date.now();
  if (now - (state.lastDecoyAt || 0) < 2000) return false;
  try {
    // toss a decoy ~12m to the side — the warden inspects the vibration
    const p = bot.entity.position;
    const wx = warden.position.x - p.x;
    const wz = warden.position.z - p.z;
    const side = { x: -wz, z: wx };
    const len = Math.hypot(side.x, side.z) || 1;
    const aim = { x: p.x + (side.x / len) * 14, y: p.y, z: p.z + (side.z / len) * 14 };
    await bot.equip(snowball, "hand");
    await bot.lookAt(new Vec3(aim.x, aim.y + 1, aim.z), true);
    bot.activateItem();
    state.lastDecoyAt = now;
    state.decoys = (state.decoys || 0) + 1;
    log(`[boss] decoy throw #${state.decoys}`);
    return true;
  } catch (err) {
    if (!state._decoyErrLogged || Date.now() - state._decoyErrLogged > 15000) {
      state._decoyErrLogged = Date.now();
      log(`[boss] decoy throw failed: ${err?.message || err}`);
    }
    return false;
  }
}

// A snowball aimed at an exact position — used from the perch to vibrate
// the column base so the warden walks under the drop zone. Its own scent
// lock won't break, but the noise pulls its investigation point over.
async function throwDecoyAt(bot, target, state, log) {
  const snowball =
    bot.inventory.items().find((i) => i.name === "snowball") ||
    bot.inventory.items().find((i) => i.name === "egg");
  if (!snowball || !target) return false;
  const now = Date.now();
  if (now - (state.lastBaseDecoyAt || 0) < 4000) return false;
  try {
    await Promise.race([bot.equip(snowball, "hand"), sleep(800)]);
    await Promise.race([bot.lookAt(target, true), sleep(600)]);
    bot.activateItem();
    state.lastBaseDecoyAt = now;
    state.decoys = (state.decoys || 0) + 1;
    log(`[boss] base decoy #${state.decoys}`);
    return true;
  } catch {
    return false;
  }
}

function climbBest(bot, state, targetY, log, warden) {
  // Dirt pillar first: the bot rides its own column — no pearls, no
  // click-reach cap, no roof problem. The scaffold fast-stack only wins
  // when a column is already half-built or solid blocks ran out.
  const mat = towerMaterial(bot);
  const scaf = bot.inventory.items().find((i) => i.name === "scaffolding");
  if (mat && !state.scaffoldTop) return towerClimbStep(bot, state, targetY + 2, log, 8, warden);
  if (scaf || state.scaffoldTop) return scaffoldClimb(bot, state, targetY, log, warden);
  return towerClimbStep(bot, state, targetY + 2, log, 8, warden);
}

// Distance from point p to segment a->b — used to keep the use_item_on
// ray clear of the warden's hitbox (entities intercept block clicks).
function segPointDist(a, b, p) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const t = Math.max(0, Math.min(1,
    ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) /
    (abx * abx + aby * aby + abz * abz || 1)));
  const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
}

// Scaffolding column: the warden can't break blocks and the bot climbs
// INSIDE the column at ~4-6 blocks/s — the whole ascent fits inside one
// boom window, and a knockback just bounces it off the column walls or
// drops it beside an intact structure it can re-enter.
// Server-side placement ack tracking + raw block_place writer. Raw
// packets fire in <5ms (placeBlock's internal aim+blockUpdate wait costs
// 200ms+ and misses the mid-air placement window) — but the server
// silently drops any use_on whose sequence is <= the last block_changed
// ack, so every raw write bumps the shared counter past the newest ack.
function ensureBlockAckHooks(bot, state, log) {
  if (!state._scafAckHooked && bot._client?.on) {
    state._scafAckHooked = true;
    try {
      bot._client.on("acknowledge_player_digging", (data) => {
        state._scafLastAckSeq = Math.max(state._scafLastAckSeq || 0, data?.sequenceId || 0);
        if (!state._scafAckLogAt || Date.now() - state._scafAckLogAt > 1500) {
          state._scafAckLogAt = Date.now();
          log(`[boss] block_ack seq=${data?.sequenceId}`);
        }
      });
      bot._client.on("block_change", (data) => {
        if (!state._scafBclog) state._scafBclog = [];
        state._scafBclog.push(`${data.location.x},${data.location.y},${data.location.z}=${data.type}`);
        if (state._scafBclog.length > 60) state._scafBclog.shift();
      });
      // Packet spy: count every outbound packet type during the climb —
      // something else may be stealing interacts or the hand slot.
      const origWrite = bot._client.write.bind(bot._client);
      const counts = {};
      bot._client.write = (name, params) => {
        counts[name] = (counts[name] || 0) + 1;
        return origWrite(name, params);
      };
      state._scafPacketCounts = counts;
      // Incoming spy: does the server ever send block_change near the
      // column? Silence = the packet is being ignored wholesale.
      bot._client.on("block_change", (data) => {
        const cell = state.scaffoldCell;
        if (!cell || !data?.location) return;
        const dx = data.location.x - cell.x, dz = data.location.z - cell.z;
        if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2) {
          log(`[boss] block_change @(${data.location.x},${data.location.y},${data.location.z}) type=${data.type}`);
        }
      });
      // Desync spy: the server pushes container_set_slot when it thinks
      // our inventory differs — catch slot syncs near the held slot.
      for (const pkt of ["container_set_slot", "container_set_content", "held_item_slot"]) {
        try {
          bot._client.on(pkt, (data) => {
            state._scafPktLog = state._scafPktLog || {};
            state._scafPktLog[pkt] = (state._scafPktLog[pkt] || 0) + 1;
          });
        } catch { /* ignore */ }
      }
      // Revert spy: a rejected use_on comes back as block_change or a
      // multi_block_change restoring the old state — log the names the
      // client emits for whatever arrives right after our writes.
      bot._client.on("packet", (data, meta) => {
        if (!/block_change|section_block|multi_block/i.test(meta?.name || "")) return;
        const fp = bot.entity?.position?.floored();
        if (!fp) return;
        const p = data?.location || data?.positions?.[0];
        if (p && Math.abs(p.x - fp.x) <= 3 && Math.abs(p.z - fp.z) <= 3 && Math.abs(p.y - fp.y) <= 4) {
          log(`[boss-dbg] IN ${meta.name} @(${p.x},${p.y},${p.z}) type=${data.type ?? "?"} n=${data?.positions?.length || 1}`);
        }
      });
    } catch { /* ignore */ }
  }
}

// Face vector → use_on direction index (0=-y,1=+y,2=-z,3=+z,4=-x,5=+x).
function faceToDir(f) {
  if (f.y > 0) return 1;
  if (f.y < 0) return 0;
  if (f.z < 0) return 2;
  if (f.z > 0) return 3;
  if (f.x < 0) return 4;
  return 5;
}

// Fire a use_on straight at the wire — no aim, no blockUpdate wait.
function rawPlace(bot, refPos, dir, state, cursor = [0.5, 0.5, 0.5]) {
  state._scafSeq = Math.max((state._scafSeq || 0) + 1, (state._scafLastAckSeq || 0) + 1);
  bot._client.write("block_place", {
    location: refPos, direction: dir, hand: 0,
    cursorX: cursor[0], cursorY: cursor[1], cursorZ: cursor[2],
    insideBlock: false, sequence: state._scafSeq, worldBorderHit: false,
  });
}

async function scaffoldClimb(bot, state, targetY, log, warden) {
  const scaf = bot.inventory.items().find((i) => i.name === "scaffolding");
  if (!scaf) return false;
  ensureBlockAckHooks(bot, state, log);
  // Stack the column from the ground — activateItem on any scaffold
  // redirects the new block to the column top (verified on Paper 1.21.1:
  // placeBlock(top,UP) is rejected, side-faces and activateItem stack).
  // Then one pearl puts the bot on the standable top — the whole ascent
  // fits inside one or two boom windows.
  for (let i = 0; i < 18; i++) {
    const p = bot.entity.position;
    if (p.y >= targetY) break;
    // Stationary while stacking — a leftover pathfinder goal walks the
    // bot off the aim and every activateItem whiffs.
    try {
      bot.pathfinder?.setGoal(null);
      bot.setControlState("forward", false);
      bot.setControlState("sprint", false);
      bot.setControlState("jump", false);
    } catch { /* ignore */ }
    // An old column >8m away horizontally is a liability: walking back
    // to it drags the bot through the warden's melee. Forget it and sow
    // a fresh base where the fight actually is. (Vertical offset is
    // ignored — on the tower itself dxz stays ~0.)
    if (state.scaffoldCell) {
      const fxz = bot.entity.position;
      const dxzCell = Math.hypot(fxz.x - (state.scaffoldCell.x + 0.5), fxz.z - (state.scaffoldCell.z + 0.5));
      if (dxzCell > 8) { state.scaffoldCell = null; state.scaffoldTop = null; }
    }
    if (!state.scaffoldTop) {
      // If we already planted a column, rescan it — do NOT keep sowing
      // new bases every time the top pointer goes stale.
      const c0 = state.scaffoldCell;
      if (c0) {
        for (let y = 30; y >= 0; y--) {
          const b = bot.blockAt(c0.offset(0, y, 0));
          if (b?.name === "scaffolding") { state.scaffoldTop = b.position; break; }
        }
        if (state.scaffoldTop) continue;
        state.scaffoldCell = null; // column truly gone
      }
      // A fresh tower >~22m from the warden is dead weight — it can't
      // smell or hear the stack, wanders off mid-fight, and the whole
      // fight is wasted. Refuse; the caller approaches first instead.
      if (warden && warden.position.distanceTo(bot.entity.position) > 22) return false;
      // Place the base in an ADJACENT cell — inside its own cell the
      // use_item_on ray never hits a face and stacking silently fails.
      // Pick the cell FARTHEST from the warden: when it presses the base
      // it must not stand between the bot's ray and the column's faces —
      // entity bodies intercept use_item_on rays and silently fail stacks.
      const feet = bot.entity.position.floored();
      const candidates = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
        new Vec3(2, 0, 0), new Vec3(-2, 0, 0), new Vec3(0, 0, 2), new Vec3(0, 0, -2),
        new Vec3(1, 0, 1), new Vec3(1, 0, -1), new Vec3(-1, 0, 1), new Vec3(-1, 0, -1),
      ];
      let cell = null, ground = null, bestScore = -1;
      for (const d of candidates) {
        const c = feet.offset(d.x, 0, d.z);
        const cBlock = bot.blockAt(c);
        const g = bot.blockAt(c.offset(0, -1, 0));
        if (cBlock?.name !== "air" || !g || g.name === "air") continue;
        // The column needs a clear vertical shaft to targetY — a roofed
        // cell (tunnel ceiling, overhang) caps the stack at the ceiling
        // and every redirect target is rejected.
        let clear = true;
        for (let dy = 1; dy <= 26 && c.y + dy < targetY + 2; dy++) {
          const b = bot.blockAt(c.offset(0, dy, 0));
          if (b && b.name !== "air" && b.name !== "scaffolding") { clear = false; break; }
        }
        if (!clear) continue;
        const score = warden ? warden.position.distanceTo(c.offset(0.5, 0, 0.5)) : 0;
        if (score > bestScore) { bestScore = score; cell = c; ground = g; }
      }
      if (!cell) {
        // Every candidate is under a roof — walk out of the shadow toward
        // open sky before sowing the base. Pick the exit direction with
        // the longest clear horizontal run (away from the warden).
        const exits = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
        let bestDir = null, bestScore2 = -1;
        for (const d of exits) {
          // Walk away in this direction until a cell has an open shaft —
          // reuse the same clearance rule the base pick applies.
          let clearAt = 0;
          for (let s = 3; s <= 10; s++) {
            const c = feet.offset(d.x * s, 0, d.z * s);
            const g = bot.blockAt(c.offset(0, -1, 0));
            if (!g || g.name === "air") break;
            let clear = true;
            for (let dy = 1; dy <= 24; dy++) {
              const b = bot.blockAt(c.offset(0, dy, 0));
              if (b && b.name !== "air" && b.name !== "scaffolding") { clear = false; break; }
            }
            if (clear) { clearAt = s; break; }
          }
          if (!clearAt) continue;
          const score = (10 - clearAt) * 10 + (warden ? warden.position.distanceTo(feet.offset(d.x * clearAt, 0, d.z * clearAt)) : 0);
          if (score > bestScore2) { bestScore2 = score; bestDir = d; }
        }
        if (bestDir) {
          const dest = feet.offset(bestDir.x * 5, 0, bestDir.z * 5);
          refreshGoal(bot, state, "scafReposition", new goals.GoalNear(dest.x, dest.y, dest.z, 1), 1500);
        }
        if (!state._scafAbortLog || Date.now() - state._scafAbortLog > 3000) {
          state._scafAbortLog = Date.now();
          log(`[boss] scaffold aborted: no clear cell (repositioning ${bestDir ? `${feet.x + bestDir.x * 6},${feet.z + bestDir.z * 6}` : "none"})`);
        }
        return false;
      }
      try { await Promise.race([bot.equip(scaf, "hand"), sleep(700)]); } catch { /* ignore */ }
      try {
        await bot.lookAt(cell.offset(0.5, -0.01, 0.5), true);
        const pl = bot.placeBlock(ground, new Vec3(0, 1, 0));
        pl.catch(() => {});
        await Promise.race([pl, sleep(700)]);
      } catch { /* ignore */ }
      const placed = bot.blockAt(cell);
      if (placed?.name === "scaffolding") {
        state.scaffoldTop = placed.position;
        state.scaffoldCell = placed.position;
        log(`[boss] scaffold base placed @${placed.position}`);
      } else {
        log("[boss] scaffold base place failed");
        return false;
      }
      continue;
    }
    const top = state.scaffoldTop;
    const topBlock = bot.blockAt(top);
    if (!topBlock || topBlock.name !== "scaffolding") {
      // top fell off (kb'd bot sees stale pos) — rescan the column
      state.scaffoldTop = null;
      const c = state.scaffoldCell;
      if (c) {
        for (let y = 30; y >= 0; y--) {
          const b = bot.blockAt(c.offset(0, y, 0));
          if (b?.name === "scaffolding") { state.scaffoldTop = b.position; break; }
        }
      }
      continue;
    }
    const pearl = bot.inventory.items().find((j) => j.name === "ender_pearl");
    if (top.y - p.y > 3.6) {
      // Column top beyond click reach (the server drops use_on past
      // ~4.5m) — pearl onto it and keep stacking from the top. This is
      // the mid-climb AND the final perch: the loop re-scans after
      // landing and continues placing while on top.
      if (!pearl) {
        log("[boss] scaffold out of reach but no pearls left");
        return false;
      }
      if (Date.now() - (state.lastPearlAt || 0) > 1500) {
        try {
          await Promise.race([bot.equip(pearl, "hand"), sleep(500)]);
          await bot.lookAt(top.offset(0.5, 1.1, 0.5), true);
          bot.activateItem();
          state.lastPearlAt = Date.now();
          state.pearls = (state.pearls || 0) + 1;
          log(`[boss] pearl->scaffoldTop #${state.pearls}`);
        } catch { /* ignore */ }
      }
      await sleep(450);
      continue;
    }
    if (top.y < targetY + 0.5 && process.env.BOSS_STACK_MIN === "1") {
      // Bisect mode — exact probe8 loop: no equip, no swing, no poll.
      if (bot.heldItem?.name !== "scaffolding") {
        try { await bot.equip(scaf, "hand"); } catch { /* */ }
      }
      if (bot.heldItem?.name !== "scaffolding") {
        // Combat code keeps re-equipping weapons over the scaffold —
        // force the server-side hotbar slot AND re-select it.
        try { bot.chat(`/item replace entity @s hotbar.8 with scaffolding 32`); } catch { /* */ }
        try { bot.setQuickBarSlot(8); } catch { /* */ }
        if (!state._scafHeldLog || Date.now() - state._scafHeldLog > 3000) {
          state._scafHeldLog = Date.now();
          log(`[boss] scafMIN held=${bot.heldItem?.name}`);
        }
        await sleep(250);
        continue;
      }
      // Rescan the real column top every iteration — the placement lands
      // at clickedPos.above(), NOT the column top, so the click must be
      // the TOP block itself (probe-verified: clicking the base targets
      // the occupied cell 81 and is rejected forever).
      let topNow = null;
      if (state.scaffoldCell) {
        for (let y = 30; y >= 0; y--) {
          const b = bot.blockAt(state.scaffoldCell.offset(0, y, 0));
          if (b?.name === "scaffolding") { topNow = b; break; }
        }
      }
      if (topNow) state.scaffoldTop = topNow.position;
      const aimBlock = topNow ? topNow.position : top;
      const relX = p.x - (aimBlock.x + 0.5), relZ = p.z - (aimBlock.z + 0.5);
      const face = Math.abs(relX) > Math.abs(relZ) ? new Vec3(Math.sign(relX), 0, 0) : new Vec3(0, 0, Math.sign(relZ));
      const placeTarget = aimBlock.offset(0, 1, 0);
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
      const clickReach = eye.distanceTo(aimBlock.offset(0.5, 0.5, 0.5));
      // Standing on the top mid-climb: hop FIRST so the +1 lands in a
      // cell the bot's box has vacated, then land on the new top.
      const onTop = p.y >= aimBlock.y - 0.5;
      if (!onTop && clickReach > 4.0) {
        // Walked too far from the column to click it — head back to the
        // base (pearling from horizontal distance undershoots).
        const c = state.scaffoldCell;
        if (c) refreshGoal(bot, state, "scafReturn", new goals.GoalNear(c.x + 0.5, c.y, c.z + 0.5, 1.5), 1200);
        await sleep(350);
      } else {
        if (onTop && bot.blockAt(placeTarget)?.name === "air") {
          try { bot.setControlState("jump", true); } catch { /* */ }
          await sleep(230);
          try { bot.setControlState("jump", false); } catch { /* */ }
        }
        if (bot.blockAt(placeTarget)?.name === "air" && clickReach <= 4.1) {
        // Authoritative server-side hotbar slot: other code's equips
        // keep swapping the scaffold OUT of the held slot, so re-assert
        // slot 8 = scaffolding server-side every few iterations and
        // re-select the slot every iteration.
        if (!state._scafHotbarSynced || Date.now() - state._scafHotbarSynced > 2000) {
          try { bot.chat(`/item replace entity @s hotbar.8 with scaffolding 32`); } catch { /* */ }
          state._scafHotbarSynced = Date.now();
          await sleep(150);
        }
        try { bot.setQuickBarSlot(8); } catch { /* */ }
        // Force server-side sneak OFF: if the flag desynced ON, the server
        // treats every use_on as secondary-use and places at clickedPos
        // (the occupied base) instead of redirecting to the column top.
        try { bot._client.write("entity_action", { entityId: bot.entity.id, actionId: 1, jumpBoost: 0 }); } catch { /* */ }
        await sleep(100);
        const aim = aimBlock.offset(0.5 + face.x * 0.51, 0.5, 0.5 + face.z * 0.51);
        try { await bot.lookAt(aim, true); } catch { /* */ }
        const dir = face.x === 1 ? 5 : face.x === -1 ? 4 : face.z === 1 ? 3 : 2;
        // Vanilla rejects use_on when sequence < last block_changed_ack —
        // echo the newest ack (plus one) or every place after the first
        // is silently dropped. This was the stack-stall all along.
        state._scafSeq = Math.max((state._scafSeq || 0) + 1, (state._scafLastAckSeq || 0) + 1);
        bot._client.write("block_place", {
          location: aimBlock, direction: dir, hand: 0,
          cursorX: 0.5 + face.x * 0.5, cursorY: 0.5, cursorZ: 0.5 + face.z * 0.5,
          insideBlock: false, sequence: state._scafSeq, worldBorderHit: false,
        });
        }
      }
      await sleep(400);
      if (!state._scafActLog || Date.now() - state._scafActLog > 3000) {
        state._scafActLog = Date.now();
        const c = state._scafPacketCounts || {};
        const inb = state._scafPktLog || {};
        const interesting = ["block_place","use_item","held_item_slot","window_click","entity_action"].map(k=>`${k}=${c[k]||0}`).join(" ");
        const incoming = `cSlot=${inb.container_set_slot||0} cCont=${inb.container_set_content||0} hSlot=${inb.held_item_slot||0}`;
        const ctrl = `sneak=${bot.getControlState?.("sneak")} sprint=${bot.getControlState?.("sprint")} fwd=${bot.getControlState?.("forward")}`;
        const bc = (state._scafBclog || []).slice(-14).join(" ");
        log(`[boss] scafMIN attempt top=${top.y} held=${bot.heldItem?.name} qbs=${bot.quickBarSlot} ack=${state._scafLastAckSeq || 0} aim=${aimBlock?.toString()} tgtName=${bot.blockAt(placeTarget)?.name} reach=${clickReach?.toFixed(2)} ${ctrl} | ${interesting} | ${incoming} | bchg: ${bc}`);
      }
      continue;
    }
    if (top.y < targetY + 0.5) {
      // keep stacking — each activation adds one level at the top.
      // Aim low on the column: any scaffold face redirects the placement
      // to the top, and the base face is always within reach.
      try { await Promise.race([bot.equip(scaf, "hand"), sleep(400)]); } catch (e) { log(`[boss] scaf equip err ${e.message}`); }
      if (bot.heldItem?.name !== "scaffolding") {
        if (!state._scafHeldLog || Date.now() - state._scafHeldLog > 3000) {
          state._scafHeldLog = Date.now();
          log(`[boss] scaf stack skip: held=${bot.heldItem?.name}`);
        }
        continue;
      }
      try {
        // Raw block_place on a SIDE face — placeBlock waits for a
        // blockUpdate at the use_on position, but the server redirects
        // the scaffold to the column top so the promise hangs and the
        // call silently never places again. The raw packet is verified
        // to stack ~8/10 at ~2.6/s. The face CENTER must sit outside
        // the warden's hitbox (0.9w x ~3.5h) — the server raycasts
        // entities before blocks, so a face whose center the warden
        // covers rejects the use_on (this was the stack-stall).
        const eye = p.offset(0, 1.62, 0);
        const faceClear = (aimBlock, f) => {
          const fc = aimBlock.offset(0.5 + f.x * 0.5, 0.5, 0.5 + f.z * 0.5);
          if (!warden) return 10;
          const wMinY = warden.position.y - 0.5, wMaxY = warden.position.y + 3.5;
          if (fc.y < wMinY || fc.y > wMaxY) return 10; // above/below the box
          const dx = fc.x - warden.position.x, dz = fc.z - warden.position.z;
          return Math.hypot(dx, dz) - 0.75; // horizontal gap to box edge
        };
        // Prefer the TOP block's faces (they clear the warden box
        // earliest); fall back to the base when the top is out of reach.
        let face = null, bestClear = -1, aimBlock = top;
        for (const cand of [top, state.scaffoldCell].filter(Boolean)) {
          if (eye.distanceTo(cand.offset(0.5, 0.5, 0.5)) > 4.2) continue;
          for (const f of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
            const tgt = cand.offset(f.x, f.y, f.z);
            if (bot.blockAt(tgt)?.name !== "air") continue;
            const clear = faceClear(cand, f);
            if (clear > bestClear) { bestClear = clear; face = f; aimBlock = cand; }
          }
        }
        if (bestClear < 0.25 && warden) {
          // Every face sits inside the warden's box — step the bot to
          // the column's far side so the warden stops shading it.
          const cell = state.scaffoldCell;
          if (cell) {
            const away = cell.offset(0.5, 0, 0.5).minus(warden.position).normalize().scale(2.6);
            const stand = cell.offset(0.5, 0, 0.5).plus(away);
            refreshGoal(bot, state, "scafReposition", new goals.GoalNear(stand.x, stand.y, stand.z, 0.8), 1500);
            await sleep(500);
            continue;
          }
        }
        if (face) {
          const aim = aimBlock.offset(0.5 + face.x * 0.51, 0.5, 0.5 + face.z * 0.51);
          await bot.lookAt(aim, true);
          const dir = face.x === 1 ? 5 : face.x === -1 ? 4 : face.z === 1 ? 3 : 2;
          // sequence must be >= the last block_changed_ack or the server
          // silently drops the place (see scafMIN path).
          state._scafSeq = Math.max((state._scafSeq || 0) + 1, (state._scafLastAckSeq || 0) + 1);
          bot._client.write("block_place", {
            location: aimBlock,
            direction: dir,
            hand: 0,
            cursorX: 0.5 + face.x * 0.5,
            cursorY: 0.5,
            cursorZ: 0.5 + face.z * 0.5,
            insideBlock: false,
            sequence: state._scafSeq,
            worldBorderHit: false,
          });
          try { bot.swingArm("right"); } catch { /* ignore */ }
        }
        if (!state._scafActLog || Date.now() - state._scafActLog > 3000) {
          state._scafActLog = Date.now();
          log(`[boss] scaf stack attempt top=${top.y} face=${face ? face.toString() : "none"} clear=${bestClear.toFixed(1)}`);
        }
      } catch (e) { log(`[boss] scaf act err ${e.message}`); }
      await sleep(340);
      for (let s = 0; s < 5; s++) {
        const nb = bot.blockAt(top.offset(0, 1, 0));
        if (nb?.name === "scaffolding") {
          state.scaffoldTop = nb.position;
          break;
        }
        await sleep(80);
      }
      // Debug: are placements landing somewhere else? Scan a 3x3x2
      // around the top for stray scaffolding.
      if (!state._scafScanLog || Date.now() - state._scafScanLog > 4000) {
        state._scafScanLog = Date.now();
        const around = [];
        for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) for (let dy = -1; dy < 2; dy++) {
          const b = bot.blockAt(top.offset(dx, dy, dz));
          if (b?.name === "scaffolding" && !(dx === 0 && dz === 0)) around.push(`${b.position.x},${b.position.y},${b.position.z}`);
        }
        log(`[boss] scaf scan top=${top.y} stray=[${around.join(";")}]`);
      }
      continue;
    }
    await sleep(250);
  }
  return true;
}

// Drop-anvil counter for a base-hugging warden: it stays within ~1-2m of
// the column smelling the bot, so an anvil mounted on the column's side
// face falls straight onto it for a flat ~40 — the canonical counter.
// TNT+flint is the fallback (same drop, ~10-65 by proximity).
async function dropHeavy(bot, warden, state, log) {
  const anvil = bot.inventory.items().find((i) => i.name === "anvil");
  const tnt = bot.inventory.items().find((i) => i.name === "tnt");
  const flint = bot.inventory.items().find((i) => i.name === "flint_and_steel");
  // TNT first: primed TNT is an ENTITY — it falls past the anvil pile that
  // shields the warden from later drops, and lands on its head for ~50-65.
  // The blast can't reach the perch (21m) and a broken column base leaves
  // the rest floating — no structural cost.
  const useTnt = !!(tnt && flint);
  if (!useTnt && !anvil) return false;
  const now = Date.now();
  const cooldown = useTnt ? 5500 : 1600; // TNT needs its fuse to burn
  if (process.env.BOSS_DEBUG && now - (state._dbgDrop || 0) > 5000) {
    state._dbgDrop = now;
    log(`[boss-dbg] dropHeavy enter: tnt=${tnt?.count || 0} anvil=${anvil?.count || 0} flint=${!!flint} cdLeft=${Math.max(0, cooldown - (now - (state.lastDropAt || 0))).toFixed(0)}`);
  }
  if (now - (state.lastDropAt || 0) < cooldown) return true;
  try {
    const p = bot.entity.position;
    const colTop = bot.blockAt(p.offset(0, -1, 0));
    if (!colTop || colTop.name === "air") return false;
    // face toward the warden along the dominant axis — the drop mounts the
    // column's side and falls past the lip onto it
    // Predict where the warden will be when the drop lands (~1.5s of
    // place+fall): only release when it's heading inside the drop cell,
    // otherwise we just carpet the floor around it.
    const vel = warden.velocity || { x: 0, y: 0, z: 0 };
    const px = warden.position.x + vel.x * 1.5 - p.x;
    const pz = warden.position.z + vel.z * 1.5 - p.z;
    // The warden wanders a ring of ~1.5-2.5m around the column. Build a
    // scaffold: four axial ledge blocks at colTop level, so drop cells can
    // sit at ±1, ±2 and the corners — covering its whole wander band
    // instead of the 4 cells at 1.2m that all miss it.
    const AX = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const mat = bot.inventory.items().find((i) => TOWER_MATS.has(i.name));
    if (!state.scaffoldDone && mat) {
      for (const [ax, az] of AX) {
        if (bot.blockAt(colTop.position.offset(ax, 0, az))?.name !== "air") continue;
        await Promise.race([bot.equip(mat, "hand"), sleep(400)]).catch(() => {});
        const scaf = bot.placeBlock(colTop, new Vec3(ax, 0, az));
        scaf.catch(() => {});
        await Promise.race([scaf, sleep(450)]);
      }
      state.scaffoldDone = true;
    }
    // Candidate mounts: { ref block to click, face, drop cell } — direct
    // column faces (±1), scaffold outer faces (±2) and tangential (corners).
    const mounts = [];
    for (const [ax, az] of AX) {
      mounts.push({ ref: colTop, face: new Vec3(ax, 0, az), cell: colTop.position.offset(ax, 0, az) });
      const ring = bot.blockAt(colTop.position.offset(ax, 0, az));
      if (!ring || ring.name === "air") continue;
      mounts.push({ ref: ring, face: new Vec3(ax, 0, az), cell: ring.position.offset(ax, 0, az) });
      for (const s of [1, -1]) {
        mounts.push({ ref: ring, face: new Vec3(az * s, 0, ax * s), cell: ring.position.offset(az * s, 0, ax * s) });
      }
    }
    let mount = null, best = Infinity;
    const feetCell = p.floored();
    for (const m of mounts) {
      if (bot.blockAt(m.cell)?.name !== "air") continue; // already a block there
      // Never drop into a cell our hitbox actually spans (feet..feet+1.8):
      // the placed block collides with the body and shoves the bot off the
      // 1-wide ledge. Cells below the feet can't collide — we're standing
      // on the column, not beside it.
      if (m.cell.y >= feetCell.y && m.cell.y <= feetCell.y + 1 && Math.abs(m.cell.x - feetCell.x) <= 1 && Math.abs(m.cell.z - feetCell.z) <= 1) continue;
      const dd = Math.hypot(px + p.x - m.cell.x - 0.5, pz + p.z - m.cell.z - 0.5);
      if (dd < best) { best = dd; mount = m; }
    }
    if (!mount && useTnt) {
      // Mounts clogged with unprimed TNT (activateBlock raced and missed):
      // ignite one now — the cell frees AND the charge falls on the warden.
      for (const m of mounts) {
        const b = bot.blockAt(m.cell);
        if (b?.name !== "tnt") continue;
        await Promise.race([bot.equip(flint, "hand"), sleep(400)]).catch(() => {});
        if (bot.heldItem?.name !== flint.name) continue;
        await Promise.race([bot.activateBlock(b), sleep(1200)]).catch(() => {});
        if (bot.blockAt(m.cell)?.name === "air") {
          state.lastDropAt = now;
          state.drops = (state.drops || 0) + 1;
          log(`[boss] tnt drop #${state.drops} (re-prime)`);
          return true;
        }
      }
    }
    if (!mount) {
      if (Date.now() - (state._dbgNoMount || 0) > 5000) {
        state._dbgNoMount = Date.now();
        const cells = mounts.map((m) => bot.blockAt(m.cell)?.name || "?").join(",");
        log(`[boss-dbg] drop: no mount (scaffold=${!!state.scaffoldDone} mounts=${mounts.length} cells=${cells})`);
      }
      return false;
    }
    // TNT's blast reaches ~4-5m — a drop landing within that still
    // damages a warden hovering just outside the ±2 cell ring. Anvils
    // get ~2.8: a miss is still a hard vibration AT the base that pulls
    // the warden toward the pile — waiting for a 1.5m bullseye starved
    // runs where it hovered at 1.6-3.4m forever.
    if (best > (useTnt ? 4.2 : 2.8)) {
      if (Date.now() - (state._dbgWait || 0) > 5000) {
        state._dbgWait = Date.now();
        log(`[boss-dbg] drop wait: best=${best.toFixed(2)} wvel=${Math.hypot(vel.x, vel.z).toFixed(2)} mounts=${mounts.length}`);
      }
      return "wait"; // warden not under any drop cell — hold ammo
    }
    await Promise.race([bot.equip(useTnt ? tnt : anvil, "hand"), sleep(400)]).catch(() => {});
    if (bot.heldItem?.name !== (useTnt ? tnt : anvil).name) return false;
    rawPlace(bot, mount.ref.position, faceToDir(mount.face), state, [0.5, 0.5, 0.5]);
    let landed = null;
    for (let i = 0; i < 10; i++) {
      await sleep(60);
      landed = bot.blockAt(mount.cell);
      if (landed && landed.name !== "air") break;
    }
    if (useTnt) {
      if (!landed || landed.name !== "tnt") {
        log(`[boss] tnt place failed (got ${landed?.name || "air"})`);
        return false;
      }
      await Promise.race([bot.equip(flint, "hand"), sleep(400)]).catch(() => {});
      await Promise.race([bot.activateBlock(landed), sleep(600)]).catch(() => {});
    }
    state.lastDropAt = now;
    state.drops = (state.drops || 0) + 1;
    log(`[boss] ${useTnt ? "tnt" : "anvil"} drop #${state.drops}`);
    return true;
  } catch (err) {
    if (!state._dropErrLogged || now - state._dropErrLogged > 15000) {
      state._dropErrLogged = now;
      log(`[boss] ${useTnt ? "tnt" : "anvil"} drop failed: ${err?.message || err}`);
    }
    return false;
  }
}

// Pour lava onto the column's outer side face a few blocks below the top:
// the ray at ~80° stays inside the column's own cell until the face, so it
// never clips the ledge, and the lava spawned on the face cascades down the
// wall straight onto the warden hugging the base.
async function pourLavaDown(bot, faceTarget, state, log) {
  const lava = bot.inventory.items().find((i) => i.name === "lava_bucket");
  if (!lava) return false;
  const now = Date.now();
  if (now - (state.lastLavaAt || 0) < 2600) return true;
  try {
    await bot.equip(lava, "hand");
    await bot.lookAt(faceTarget, true);
    bot.activateItem();
    await sleep(450);
    state.lastLavaAt = now;
    state.lavaPours = (state.lavaPours || 0) + 1;
    log(`[boss] lava pour #${state.lavaPours}`);
    return true;
  } catch (err) {
    log(`[boss] lava pour failed: ${err?.message || err}`);
    return false;
  }
}

// Ground-game kill: prime a TNT block on the warden's chase path and
// step away — the 4s fuse ends right as it crosses the spot (wardens
// chase at ~3-4m/s; the primed TNT's own ignition vibration even pulls
// it toward the blast). Unlike the 25s-exposed tower climb this keeps
// the bot at 10m+ the whole fight.
async function tntTrailStep(bot, warden, state, log) {
  const tnt = bot.inventory.items().find((i) => i.name === "tnt");
  const flint = bot.inventory.items().find((i) => i.name === "flint_and_steel");
  if (!tnt || !flint || tnt.count <= 8) return false; // keep perch ammo
  const now = Date.now();
  if (now - (state.lastDropAt || 0) < 4600) return false;
  try {
    const p = bot.entity.position;
    const dir = warden.position.minus(p);
    dir.y = 0;
    const len = Math.hypot(dir.x, dir.z) || 1;
    // ~2.5m in front of us on the approach line: inside use_on reach,
    // and far enough ahead that the warden crosses it as the fuse ends
    // (it covers ~12-14m in the 4s fuse when chasing from 15m out).
    const cell = p.offset(dir.x / len * 2.5, 0, dir.z / len * 2.5).floored();
    if (cell.distanceTo(p.floored()) > 4.0) return false;
    if (bot.blockAt(cell)?.name !== "air") return false;
    const ground = bot.blockAt(cell.offset(0, -1, 0));
    if (!ground || ground.name === "air" || ground.boundingBox !== "block") return false;
    await bot.lookAt(cell.offset(0.5, -0.2, 0.5), true);
    await Promise.race([bot.equip(tnt, "hand"), sleep(400)]).catch(() => {});
    if (bot.heldItem?.name !== tnt.name) return false;
    rawPlace(bot, ground.position, 1, state, [0.5, 1.0, 0.5]);
    let landed = null;
    for (let i = 0; i < 8; i++) {
      await sleep(60);
      landed = bot.blockAt(cell);
      if (landed && landed.name === "tnt") break;
    }
    if (!landed || landed.name !== "tnt") return false;
    await Promise.race([bot.equip(flint, "hand"), sleep(400)]).catch(() => {});
    if (bot.heldItem?.name !== flint.name) return false;
    // activateBlock's 800ms race misses often — retry until the TNT cell
    // vanishes (turned into the primed entity) before giving up.
    let primed = false;
    for (let i = 0; i < 3 && !primed; i++) {
      await Promise.race([bot.activateBlock(landed), sleep(700)]).catch(() => {});
      primed = bot.blockAt(cell)?.name === "air";
    }
    state.lastDropAt = now;
    state.drops = (state.drops || 0) + 1;
    log(`[boss] tnt trail #${state.drops} primed=${primed}`);
    return primed;
  } catch {
    return false;
  }
}

// Boat-trap is the clean kill: a warden that touches a boat climbs in and
// is immobilized permanently — arrows then land every shot from >16m.
// Ground-trail ammo check: while >8 TNT remain the fight stays on the
// ground (trails kill without the 25s tower exposure); the perch game
// only runs once the trail budget is spent.
function trailReady(bot) {
  const t = bot.inventory.items().find((i) => i.name === "tnt");
  const f = bot.inventory.items().find((i) => i.name === "flint_and_steel");
  return !!(t && f && t.count > 8);
}

function wardenBoated(bot, warden) {
  try {
    if (warden.vehicle) return true;
    // fallback: a boat within ~1.6m with the warden aboard
    const boats = Object.values(bot.entities).filter(
      (e) => e.name === "boat" || e.name === "chest_boat"
    );
    // riding means the hull is basically under it, not just nearby
    return boats.some((b) => b.position.distanceTo(warden.position) < 0.9);
  } catch {
    return false;
  }
}

async function placeBoatAt(bot, warden, state, log) {
  const boat = bot.inventory.items().find((i) => i.name === "oak_boat" || /_boat$/.test(i.name));
  if (!boat) return false;
  const now = Date.now();
  if (now - (state.lastBoatAt || 0) < 1500) return true;
  try {
    if (wardenBoated(bot, warden)) return true;
    const p = bot.entity.position;
    // Placement reach is ~4.2m — a spot 2.2m ahead of the warden sits
    // 5m+ out and the server silently rejects it. Under its feet when
    // close (instant board), else on the approach line ~3m from us.
    const dir = warden.position.minus(p);
    dir.y = 0;
    const len = Math.hypot(dir.x, dir.z) || 1;
    // Boat spawn is rejected if its AABB collides with any entity — so a
    // spot 3m ahead of us dies inside the approaching warden's hitbox.
    // Drop it just ahead of the warden's own path (1.2m toward us) where
    // nothing stands; it walks aboard within a second. Far wardens get
    // the old midpoint on the approach line.
    const spot = len < 5.4
      ? warden.position.offset(dir.x / len * -1.2, 0, dir.z / len * -1.2)
      : p.offset(dir.x / len * 3.0, 0, dir.z / len * 3.0);
    const cell = spot.floored();
    if (cell.distanceTo(p.floored()) > 4.2) return false;
    const cellBlock = bot.blockAt(cell);
    if (!cellBlock || cellBlock.name !== "air") return false;
    const ground = bot.blockAt(cell.offset(0, -1, 0));
    if (!ground || ground.name === "air" || ground.boundingBox !== "block") return false;
    const target = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
    await bot.lookAt(target, true);
    await bot.equip(boat, "hand");
    if (bot.heldItem?.name !== boat.name) return false;
    // Boats spawn via BoatItem.use (use_item packet) raycasting along
    // the look direction — aim at the ground cell first, then fire;
    // placeEntity is broken on 1.21.1 (writes use_item without the
    // rotation field) and raw use_on never spawns boats (probe-verified).
    bot.activateItem();
    await sleep(300);
    const spawned = Object.values(bot.entities).some(
      (e) => (e.name === "boat" || e.name === "chest_boat") &&
        e.position.distanceTo(spot) < 3
    );
    state.lastBoatAt = now;
    state.boats = (state.boats || 0) + 1;
    log(`[boss] boat place #${state.boats} spawned=${spawned} boated=${wardenBoated(bot, warden)}`);
    return spawned;
  } catch (err) {
    log(`[boss] boat place failed: ${err?.message || err}`);
    return false;
  }
}

// Cobweb the warden's feet cell — it moves at ~15% speed inside webs, so
// once trapped arrows land nearly every shot. The canonical warden cheese.
function wardenInWeb(bot, warden) {
  try {
    const feet = warden.position.floored();
    const cells = [feet, feet.offset(0, -1, 0), feet.offset(0, 1, 0)];
    return cells.some((c) => bot.blockAt(c)?.name === "cobweb");
  } catch {
    return false;
  }
}

async function placeWebAt(bot, warden, state, log) {
  const web = bot.inventory.items().find((i) => i.name === "cobweb");
  if (!web) return false;
  const now = Date.now();
  if (now - (state.lastWebAt || 0) < 900) return true;
  try {
    const dist = warden.position.distanceTo(bot.entity.position);
    if (dist > 4.3) return false; // out of reach
    const feet = warden.position.floored();
    const below = bot.blockAt(feet.offset(0, -1, 0));
    if (!below || below.name === "air") return false;
    if (bot.blockAt(feet)?.name !== "air") return wardenInWeb(bot, warden);
    await bot.equip(web, "hand");
    const placing = bot.placeBlock(below, new Vec3(0, 1, 0));
    placing.catch(() => {});
    await Promise.race([placing, sleep(450)]);
    state.lastWebAt = now;
    state.webs = (state.webs || 0) + 1;
    log(`[boss] cobweb place #${state.webs}`);
    return true;
  } catch (err) {
    log(`[boss] cobweb place failed: ${err?.message || err}`);
    return false;
  }
}

// Pour lava into the air cell beside the column's top — it flows down the
// side face and pools at the base where the warden stands. ~4hp/s burn plus
// fire damage keeps it engaged — the main DoT of the tower tactic.
async function pourLava(bot, warden, state, log) {
  const lava = bot.inventory.items().find((i) => i.name === "lava_bucket");
  if (!lava || state.lavaPoured) return false;
  try {
    const p = bot.entity.position;
    const colTop = bot.blockAt(p.offset(0, -1, 0));
    if (!colTop || colTop.name === "air") return false;
    const wx = warden.position.x - p.x;
    const wz = warden.position.z - p.z;
    const face = Math.abs(wx) >= Math.abs(wz)
      ? new Vec3(Math.sign(wx) || 1, 0, 0)
      : new Vec3(0, 0, Math.sign(wz) || 1);
    // Aim 2.5 blocks BELOW the lip on the side face — pouring at the top
    // lets the lava flow back over the lip into the bot's own cell.
    const mount = colTop.position.offset(0, -2, 0).plus(face);
    const target = colTop.position
      .offset(0.5, -1.5, 0.5)
      .plus(face.scaled(0.5));
    await bot.lookAt(target, true);
    await bot.equip(lava, "hand");
    bot.activateItem();
    await sleep(400);
    const landed = bot.blockAt(mount);
    const above = bot.blockAt(mount.offset(0, 1, 0));
    state.lavaPoured = /lava/.test(landed?.name || "") || /lava/.test(above?.name || "");
    log(`[boss] lava pour ${state.lavaPoured ? "landed" : "missed (" + (landed?.name || "air") + ")"}`);
    return state.lavaPoured;
  } catch (err) {
    log(`[boss] lava pour failed: ${err?.message || err}`);
    return false;
  }
}

// A 2-block wall on the warden's melee path: it can't break blocks and
// won't jump-walk over two-high — the detour buys the ~4s the first
// tower levels need under pressure.
async function wallOffWarden(bot, warden, state) {
  const mat = towerMaterial(bot);
  if (!mat) return false;
  if (state._wallOffAt && Date.now() - state._wallOffAt < 1800) return false;
  const p = bot.entity.position;
  const w = warden.position;
  const dxz = Math.hypot(p.x - w.x, p.z - w.z);
  if (dxz < 3.5 || dxz > 9) return false;
  const dirx = p.x - w.x;
  const dirz = p.z - w.z;
  const t = Math.max(0.35, Math.min(0.85, 1 - 2.8 / dxz));
  const cx = Math.floor(w.x + dirx * t);
  const cz = Math.floor(w.z + dirz * t);
  const cy = Math.floor(w.y) - 1;
  const base = bot.blockAt(new Vec3(cx, cy, cz));
  if (!base || base.name === "air") return false;
  const cell = base.position.offset(0, 1, 0);
  if (bot.blockAt(cell)?.name !== "air") return false;
  state._wallOffAt = Date.now();
  try {
    await Promise.race([bot.equip(mat, "hand"), sleep(400)]);
    const first = bot.placeBlock(base, new Vec3(0, 1, 0));
    first.catch(() => {});
    await Promise.race([first, sleep(400)]);
    const b1 = bot.blockAt(cell);
    if (b1 && b1.name !== "air") {
      const second = bot.placeBlock(b1, new Vec3(0, 1, 0));
      second.catch(() => {});
      await Promise.race([second, sleep(400)]);
    }
    return true;
  } catch {
    return false;
  }
}

async function throwPearl(bot, warden, state, log) {
  const pearl = bot.inventory.items().find((i) => i.name === "ender_pearl");
  if (!pearl) return false;
  const now = Date.now();
  if (now - (state.lastPearlAt || 0) < 6000) return false;
  try {
    // Knocked down next to a started tower: the tower top IS the escape —
    // a pearl onto it skips the whole re-climb and beats melee range.
    const p = bot.entity.position;
    // Never pearl while elevated: it would throw the bot OFF its own
    // tower mid-climb — up high the climb itself is the escape.
    if (p.y - warden.position.y > 3) return false;
    // …nor mid-fall — a pearl fired while dropping lands wherever the
    // arc happens to end, which under melee is usually the warden's feet.
    if (bot.entity.velocity.y < -0.5) return false;
    let aim;
    // Scaffold column top is the preferred escape target — it's built
    // fast and the warden can't reach anything on it.
    const sTop = state.scaffoldTop;
    const tTop = state.towerTop;
    const nearScaf = sTop
      && Math.hypot(p.x - sTop.x, p.z - sTop.z) < 10
      && sTop.y - p.y > 1;
    const nearTop = !nearScaf && tTop
      && Math.hypot(p.x - tTop.x, p.z - tTop.z) < 10
      && tTop.y - p.y > 2 && tTop.y - p.y < 20;
    if (nearScaf) {
      aim = sTop.offset(0.5, 4.0, 0.5);
    } else if (nearTop) {
      // steep arc so the pearl drops ONTO the 1x1 top instead of
      // smacking the side face and teleporting beside it.
      aim = tTop.offset(0.5, 3.5, 0.5);
    } else {
      // throw back away from the warden, slight upward arc — instant ~20m gap
      const away = { x: p.x - warden.position.x, z: p.z - warden.position.z };
      const len = Math.hypot(away.x, away.z) || 1;
      aim = new Vec3(p.x + (away.x / len) * 20, p.y + 4, p.z + (away.z / len) * 20);
    }
    await bot.equip(pearl, "hand");
    await bot.lookAt(aim, true);
    bot.activateItem();
    state.lastPearlAt = now;
    state.pearls = (state.pearls || 0) + 1;
    log(`[boss] pearl throw #${state.pearls}`);
    return true;
  } catch {
    return false;
  }
}

async function wardenTick(bot, warden, state, log) {
  const now = Date.now();
  await tryEat(bot, state);
  const dist = warden.position.distanceTo(bot.entity.position);
  const dxz = Math.hypot(warden.position.x - bot.entity.position.x, warden.position.z - bot.entity.position.z);
  const dy = bot.entity.position.y - warden.position.y;
  const armed = hasBow(bot) && hasArrows(bot);

  // Boom detector: any self damage marks the last hit — the sonic boom has a
  // ~5-6s cooldown, so the window right after eating one is the safe time
  // to climb through its 20-block vertical range.
  if (!state.hurtHooked) {
    state.hurtHooked = true;
    state.hurtAt = 0;
    try {
      bot.on("entityHurt", (e) => {
        if (e === bot.entity) state.hurtAt = Date.now();
        // Anything hurting the warden here is one of our arrows — this is
        // the real hit counter (shots alone can whiff).
        else if (e?.name === "warden") state.wardenArrowHits = (state.wardenArrowHits || 0) + 1;
      });
    } catch {
      /* ignore */
    }
  }
  const postBoom = state.hurtAt && now - state.hurtAt < 5200;

  // Closed-loop sniper aim: every landed arrow near the warden tells us
  // the miss vector — shift the aim by -0.85*miss so the next shot
  // converges on the target. The old fixed-lead model whiffs ~4m at
  // perch ranges because a stationary warden needs ~zero lead.
  if (!state.snipeCorr) state.snipeCorr = { x: 0, y: 0, z: 0 };
  let dbgArrMin = "";
  let dbgArrLand = "";
  for (const e of Object.values(bot.entities)) {
    if (e.name !== "arrow" && e.name !== "spectral_arrow") continue;
    const d = e.position.distanceTo(warden.position);
    if (!dbgArrMin || d < dbgArrMin.d) dbgArrMin = { d, y: e.position.y - warden.position.y };
    const v = e.velocity;
    if (v && Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) < 0.5 && d < 12) {
      const dx = e.position.x - warden.position.x;
      const dy2 = e.position.y - warden.position.y;
      const dz = e.position.z - warden.position.z;
      dbgArrLand = ` ${dx.toFixed(1)},${dy2.toFixed(1)},${dz.toFixed(1)}`;
      if (state._lastLandArrow !== e.uuid && state.lastShotTarget === "warden") {
        state._lastLandArrow = e.uuid;
        const c = state.snipeCorr;
        c.x = Math.max(-6, Math.min(6, c.x - dx * 0.85));
        c.y = Math.max(-6, Math.min(6, c.y - dy2 * 0.85));
        c.z = Math.max(-6, Math.min(6, c.z - dz * 0.85));
        if (process.env.BOSS_DEBUG) log(`[boss-dbg] snipeCorr ${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}`);
      }
    }
  }

  if (process.env.BOSS_DEBUG && now - (state._dbgAt || 0) > 1500) {
    state._dbgAt = now;
    const pfGoal = bot.pathfinder?.goal ? "Y" : "N";
    const moving = bot.pathfinder?.isMoving?.() ? "Y" : "N";
    const arrMin = dbgArrMin;
    const arrLand = dbgArrLand;
    log(
      `[boss-dbg] d=${dist.toFixed(1)} dxz=${dxz.toFixed(1)} dy=${dy.toFixed(1)} ` +
        `armed=${armed} postBoom=${!!postBoom} phase=${state.phase} shots=${state.shots || 0} ` +
        `whits=${state.wardenArrowHits || 0} ` +
        `ls=${state.ledgeShots || 0} ` +
        `arr=${arrMin ? arrMin.d.toFixed(1) + "@" + arrMin.y.toFixed(1) : "-"}${arrLand ? " land" + arrLand : ""} ` +
        `hp=${bot.health?.toFixed?.(1)} food=${bot.food} pfGoal=${pfGoal} mov=${moving}`
    );
  }

  // ── Sniper tower: at dy > 20 the boom can't reach vertically. The tower
  // must go up CLOSE (~18-22m): footsteps + place noise are the vibrations
  // that pull the warden to the base, where it stays angry and hittable.
  if (armed) {
    // Ground traps were tried and abandoned: boats don't spawn via
    // activateItem/activateBlock/useOn on Paper 1.21.1, and cobwebs hold it
    // ~1-2s per web — the web loop just feeds it booms. The kill path is
    // tower -> perch -> ledge snipe + anvils.
    if (dy < 3 && state.perchTop) state.perchTop = null;
    if (dy < 21) {
      try { bot.setControlState("sneak", false); } catch { /* ignore */ }
    }
    if (dy >= 21) {
      state.phase = "warden-snipe";
      // Remember the column top cell: once the bot steps onto a ledge the
      // block under its feet is no longer the column center.
      if (!state.perchTop) {
        const under = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (under && under.name !== "air") state.perchTop = under.position.clone();
      }
      try {
        bot.pathfinder?.setGoal(null);
        bot.setControlState("jump", false);
        bot.setControlState("sprint", false);
        // Sneak while perched: placing the drop mounts means stepping
        // toward 1-wide ring ledges — sneak makes walking off an edge
        // physically impossible (21m falls were ending runs).
        bot.setControlState("sneak", true);
      } catch {
        /* ignore */
      }
      // Warden hugging the base: arrows spawn-dive into the column itself
      // at ~80°+ and every other steep vector failed — primed TNT drops
      // are the kill: entity falls past the pile, explodes on its head.
      if (dxz < 7) {
        // Bounded: a stuck equip/place must not pin _tickBusy forever.
        const r = await Promise.race([dropHeavy(bot, warden, state, log), sleep(3000)]);
        if (r === "wait") {
          // Hovering at the edge of the blast radius — vibrate the column
          // base so it walks all the way under the perch.
          const base = state.towerTop
            ? new Vec3(state.towerTop.x + 0.5, warden.position.y + 1, state.towerTop.z + 0.5)
            : null;
          if (base) await throwDecoyAt(bot, base, state, log);
        }
        return true;
      }
      if (dxz <= 14) {
        // In smell/vibration range but not under the perch: vibrate the
        // column base — the warden investigates the noise and walks into
        // the drop zone. Throwing AT it would pull it away instead.
        // Never widen this band past ~14: a warden beyond hearing range
        // of the base decoy just parks — arrows (which re-aggro on hit)
        // are the only pull at 15m+ and decoy-only here = stalemate.
        // Parked wardens: ~15s of unheard decoys -> shoot it, the hit
        // re-aggros it toward the perch (same stalemate break as 15m+).
        if (dxz > 10) {
          state._parkedSince = state._parkedSince || now;
        } else {
          state._parkedSince = 0;
        }
        const parked = state._parkedSince && now - state._parkedSince > 15000;
        const base = !parked && state.towerTop
          ? new Vec3(state.towerTop.x + 0.5, warden.position.y + 1, state.towerTop.z + 0.5)
          : null;
        if (base) {
          await throwDecoyAt(bot, base, state, log);
          return true;
        }
      }
      // Parked or de-aggro'd far off — an arrow hit re-aggros it hard and
      // drags it back to the perch. From a high perch the shot is mostly
      // DOWNHILL: gravity barely acts across the flight path, so the
      // level-shot lead (3.0 + dxz*0.18) overshoots by ~6m and the misses
      // landing behind the warden walk it away. Perch shots need ~+2.
      // Empirically tuned: land data showed arrows ending +11y past the
      // warden — downhill shots need nearly a flat aim at the feet.
      const snipeAimY = 0.4 + dxz * 0.01;
      const c = state.snipeCorr;
      state.lastShotTarget = "warden";
      await shootAt(bot, warden.position.offset(c.x, snipeAimY + c.y, c.z), state, 850);
      return true;
    }

    // Already up on a tower mid-climb: keep rising no matter where the
    // warden is — dropping back down is the losing move. Past ~45m even
    // a perched snipe can't reach it, so abandon the tower and close in.
    if (dy >= 4) {
      if (dxz > 45) {
        state.phase = "warden-approach";
        refreshGoal(bot, state, "wardenApproach", new goals.GoalFollow(warden, 15), 3000);
        return true;
      }
      state.phase = "warden-climb-mid";
      const climbing = await climbBest(bot, state, warden.position.y + 22, log, warden);
      if (climbing) return true;
    }

    // ── Ground plan: get into the 14-24m sweet spot, decoy past it, and
    // climb — every kill vector lives on the perch (TNT/anvil drops).
    // Web-trapped warden is the one exception worth pausing to shoot.
    if (wardenBoated(bot, warden) || wardenInWeb(bot, warden)) {
      state.phase = "warden-trapped";
      // The trap holds ~10-20s — that IS the climb window. Use it for
      // the tower instead of a couple of arrows: a trapped warden at
      // the base is exactly where the perch needs it.
      if (towerMaterial(bot)) {
        const climbing = await climbBest(bot, state, warden.position.y + 22, log, warden);
        if (climbing) return true;
      }
      if (dxz < 15.5) {
        refreshGoal(bot, state, "wardenTrappedAway",
          new goals.GoalInvert(new goals.GoalFollow(warden, 16)), 3000);
        return true;
      }
      try {
        bot.pathfinder?.setGoal(null);
        bot.setControlState("sprint", false);
      } catch { /* ignore */ }
      { const c = state.snipeCorr; state.lastShotTarget = "warden";
        await shootAt(bot, warden.position.offset(c.x, 2.3 + c.y, c.z), state, 800); }
      return true;
    }
    // Knocked back off a started tower: get back on it and keep rising —
    // escaping on foot against the warden is a guaranteed death anyway.
    if (state.towerBlocks > 0 || state.scaffoldTop) {
      state.phase = "warden-reclimb";
      if (dxz < 8) {
        // Melee juggling makes placeBlock never land — a hop+place
        // mid-combo just burns blocks. Get range FIRST: pearl onto the
        // tower top when it's tall enough, else pearl away and climb
        // at distance; only build under melee when pearls are spent.
        const pearl = bot.inventory.items().find((i) => i.name === "ender_pearl");
        if (pearl && Date.now() - (state.lastPearlAt || 0) > 3500) {
          const pearled = await throwPearl(bot, warden, state, log);
          if (pearled) return true;
        }
        const climbing = await climbBest(bot, state, warden.position.y + 22, log, warden);
        if (climbing) return true;
        refreshGoal(bot, state, "wardenReclimbAway", new goals.GoalInvert(new goals.GoalFollow(warden, 10)), 2500);
        return true;
      }
      if (dxz > 26) {
        // A tower the warden can't smell or hear is worthless — leave it
        // standing and close in to drag it back to the base.
        state.phase = "warden-approach";
        refreshGoal(bot, state, "wardenApproach", new goals.GoalFollow(warden, 15), 3000);
        return true;
      }
      const climbing = await climbBest(bot, state, warden.position.y + 22, log, warden);
      if (climbing) return true;
    }
    // TNT trail first: a primed TNT on the chase path lands ~50-65 dmg
    // while the bot stays at 10m+ — the whole kill happens in the band
    // where the tower climb would normally be feeding it booms.
    if (dxz > 5 && dxz < 26 && dy < 4 && !wardenBoated(bot, warden)) {
      const wvelG = warden.velocity ? Math.hypot(warden.velocity.x, warden.velocity.z) : 0;
      const trailed = (wvelG > 0.4 || dxz < 10)
        ? await tntTrailStep(bot, warden, state, log)
        : false;
      if (trailed) {
        // Fuse is burning — pull the warden across it while backing off.
        retreatFromWarden(bot, warden, state);
        return true;
      }
    }
    // Boat-trap first: a warden chasing on open ground walks into the
    // boat in ~1-2s and is permanently immobilized — the kill then runs
    // on OUR clock (bow it from beyond the 15m sonic reach). Way more
    // reliable than a 30s tower under melee pressure.
    if (!wardenBoated(bot, warden) && dxz > 3 && dxz < 26 && dy < 4) {
      const boated = await placeBoatAt(bot, warden, state, log);
      if (boated || wardenBoated(bot, warden)) {
        refreshGoal(bot, state, "wardenBoatedAway",
          new goals.GoalInvert(new goals.GoalFollow(warden, 17)), 2500);
        return true;
      }
    }
    // Emergency escape only: inside ~8m under boom threat. Outside it
    // (or right after a boom) we always climb instead of kiting —
    // ground kiting dies because the warden outruns the pathfinder.
    if (dxz < 8 && !postBoom) {
      state.phase = "warden-escape";
      if (dist < 6.5) await placeWebAt(bot, warden, state, log);
      if (dist < 4.5) {
        const pearled = await throwPearl(bot, warden, state, log);
        if (pearled) return true;
      }
      // The tower is the escape, but not AT melee: a place can't land
      // mid-combo. Pearl away first, wall the approach, then climb at
      // range; under-melee builds only happen with pearls spent.
      if (towerMaterial(bot) || bot.inventory.items().find((i) => i.name === "scaffolding")) {
        const pearl = bot.inventory.items().find((i) => i.name === "ender_pearl");
        if (pearl && Date.now() - (state.lastPearlAt || 0) > 5500) {
          const pearled = await throwPearl(bot, warden, state, log);
          if (pearled) return true;
        }
        await wallOffWarden(bot, warden, state);
        const climbing = await climbBest(bot, state, warden.position.y + 22, log, warden);
        if (climbing) return true;
      }
      retreatFromWarden(bot, warden, state);
      return true;
    }
    // Sweet spot is ~8-18m: close enough that the warden's base-press
    // lands it in drop range, far enough to get the column started
    // before it closes. Inside ~18m the scaffold stacking starts now —
    // every second of approach distance is stack time.
    if (dxz > 18) {
      state.phase = "warden-approach";
      refreshGoal(bot, state, "wardenApproach", new goals.GoalFollow(warden, 14), 3000);
      return true;
    }
    state.phase = "warden-climb";
    // First-contact melee (postBoom path): same juggling problem —
    // pearl out for the runway, then climb.
    if (dxz < 8) {
      const pearl = bot.inventory.items().find((i) => i.name === "ender_pearl");
      if (pearl && Date.now() - (state.lastPearlAt || 0) > 5500) {
        const pearled = await throwPearl(bot, warden, state, log);
        if (pearled) return true;
      }
    }
    // Web the chaser early: a webbed warden crawls at ~15% speed — that
    // IS the uninterrupted ~30s the 21-block climb needs (this was the
    // difference between the wins and every melee-interrupted loss).
    if (dist < 11) await placeWebAt(bot, warden, state, log);
    // No sideways decoy — its noise pulls the warden OFF the tower base.
    const climbing = await climbBest(bot, state, warden.position.y + 22, log, warden);
    if (climbing) return true;
    // No tower mats or no water — fallback kite bands.
    if (dxz > 21.5) {
      state.phase = "warden-kite-in";
      refreshGoal(bot, state, "wardenKiteIn", new goals.GoalFollow(warden, 18.5), 2500);
      return true;
    }
    if (dxz < 13.5) {
      state.phase = "warden-kite-out";
      if (dist < 6.5) await placeWebAt(bot, warden, state, log);
      if (dist < 4.5 && !postBoom) {
        const pearled = await throwPearl(bot, warden, state, log);
        if (pearled) return true;
      }
      retreatFromWarden(bot, warden, state);
      // Post-boom window (~5s): safe to turn and punish the chase.
      if (postBoom) {
        { const c = state.snipeCorr; state.lastShotTarget = "warden";
          await shootAt(bot, warden.position.offset(c.x, 1.6 + dxz * 0.1 + c.y, c.z), state, 750); }
      }
      return true;
    }
    // Shooting band 13.5-21.5m.
    state.phase = "warden-kite";
    try {
      bot.pathfinder?.setGoal(null);
      bot.setControlState("sprint", false);
    } catch {
      /* ignore */
    }
    if (dist < 9) await placeWebAt(bot, warden, state, log);
    const kiteAimY = 1.5 + dxz * 0.12;
    { const c = state.snipeCorr; state.lastShotTarget = "warden";
      await shootAt(bot, warden.position.offset(c.x, kiteAimY + c.y, c.z), state, 780); }
    return true;
  }

  // No bow: hit once, decoy, then get out of boom range before it charges
  if (state.wardenKiteUntil && now < state.wardenKiteUntil) {
    state.phase = "warden-duck";
    retreatFromWarden(bot, warden, state);
    return true;
  }
  if (dist > 4.5) {
    state.phase = "warden-close";
    try {
      bot.pathfinder?.setGoal(new goals.GoalFollow(warden, 1.5), true);
      bot.setControlState("sprint", true);
    } catch {
      /* ignore */
    }
    return true;
  }
  state.phase = "warden-hit";
  await swing(bot, warden, state, 1.5);
  await throwDecoy(bot, warden, state, log);
  state.wardenKiteUntil = now + 4500;
  retreatFromWarden(bot, warden, state);
  return true;
}

// Placeable tower material — exact block names only (a `stone` substring
// would match stone_axe/pickaxe, which are items, not blocks).
const TOWER_MATS = new Set([
  "dirt", "cobblestone", "stone", "end_stone", "netherrack", "deepslate",
  "cobbled_deepslate", "obsidian", "basalt", "blackstone",
  "tuff", "diorite", "andesite", "granite", "smooth_stone", "soul_sand",
  "soul_soil", "oak_planks", "spruce_planks", "birch_planks",
  "coarse_dirt", "rooted_dirt", "mud", "packed_mud", "stone_bricks",
]);

function towerMaterial(bot) {
  return bot.inventory.items().find((i) => TOWER_MATS.has(i.name));
}

/**
 * Hop+place blocks under our feet until feet.y >= targetY.
 * Returns true while climbing/at top; false if impossible (no material).
 */
async function towerClimbStep(bot, state, targetY, log, maxIter = 30, warden = null) {
  // Loop hop+place inside one call — one block per tick call is far too
  // slow (22 blocks ≈ 44s vs a ~5s boom cooldown).
  const mat = towerMaterial(bot);
  if (!mat) {
    log("[boss] tower aborted: no building material");
    return false;
  }
  // Raw block_place needs the server's last ack seq or packets get dropped.
  ensureBlockAckHooks(bot, state, log);
  try {
    bot.pathfinder?.setGoal(null);
    bot.setControlState("sprint", false);
    bot.setControlState("forward", false);
    bot.setControlState("back", false);
    bot.setControlState("left", false);
    bot.setControlState("right", false);
    await bot.equip(mat, "hand");
  } catch (err) {
    log(`[boss] tower aborted: equip failed (${err?.message || err})`);
    return false;
  }
  for (let iter = 0; iter < maxIter; iter++) {
    const feet = bot.entity.position.floored();
    if (feet.y >= targetY) return true;
    if (!towerMaterial(bot)) {
      log("[boss] tower aborted: out of material mid-climb");
      return false;
    }
    // Stuck inside our own column (knocked into an old tower): sidestep to a
    // clear cell instead of placing a block into our own body forever.
    // NB: an entity rests ~0.001 into the floor top (y=79.999…) — the block
    // at that point IS the floor, not a wedge. Check the cell 0.35 up too.
    const feetBlock = bot.blockAt(bot.entity.position);
    const aboveFeet = bot.blockAt(bot.entity.position.offset(0, 0.35, 0));
    // Only SOLID blocks count as a wedge — fern/grass/ladders report
    // non-air but never trap the body.
    const solid = (b) => b && b.name !== "air" && b.boundingBox === "block";
    const wedged = solid(feetBlock) && solid(aboveFeet);
    if (wedged) {
      if (process.env.BOSS_DEBUG) {
        const p = bot.entity.position;
        log(`[boss-dbg] wedged: pos=${p.x.toFixed(1)},${p.y.toFixed(3)},${p.z.toFixed(1)} feet=${feetBlock.name}@${feetBlock.position} above=${aboveFeet.name}@${aboveFeet.position}`);
      }
      // Inside a block (edge-overlap from a self-placed platform cell).
      // First try to just walk out — collision pushes the body up onto the
      // block; a real dig is the fallback and gets one long budget on the
      // same target (restarting the dig every 5s never finishes stone).
      if (!state._wedgeWalkAt || Date.now() - state._wedgeWalkAt > 1400) {
        state._wedgeWalkAt = Date.now();
        try {
          const fb = feetBlock.position;
          await bot.lookAt(new Vec3(fb.x + 0.5, bot.entity.position.y + 0.5, fb.z + 0.5), true);
        } catch { /* ignore */ }
        bot.setControlState("forward", true);
        bot.setControlState("sprint", true);
        bot.setControlState("jump", true);
        await sleep(900);
        bot.setControlState("forward", false);
        bot.setControlState("sprint", false);
        bot.setControlState("jump", false);
        return true;
      }
      const pick = bot.inventory.items().find((i) => i.name.endsWith("_pickaxe"));
      try {
        if (pick && bot.heldItem?.name !== pick.name) {
          await Promise.race([bot.equip(pick, "hand"), sleep(600)]);
        }
        if (Date.now() - (state._wedgeDigAt || 0) > 16000) {
          state._wedgeDigAt = Date.now();
          await Promise.race([bot.dig(feetBlock), sleep(15000)]);
        } else {
          await sleep(400); // let the in-flight dig finish
        }
      } catch (err) {
        state._wedgeDigAt = 0;
        log(`[boss] tower aborted: dig-out failed (${err?.message || err})`);
      }
      return true; // next tick re-enters the climb on clear ground
    }
    state._wedgeWalkAt = 0;
    state._wedgeDigAt = 0;
    // Don't try to place mid-hop or mid-drift — the column lookup only
    // makes sense from a grounded position.
    if (!bot.entity.onGround) return true;
    // Progress watchdog: a pathfinder goal can be set-but-unreachable
    // (ledge, wall ring, cave) and we'd sit here forever returning
    // silent true. Six seconds without vertical or horizontal progress
    // means the climb is stuck — return false so callers walk out and
    // re-approach instead of standing in place until boomed to death.
    {
      const pp = bot.entity.position;
      const pr = state._climbProg;
      if (!pr || Math.abs(pp.y - pr.y) > 0.5 || Math.hypot(pp.x - pr.x, pp.z - pr.z) > 1.2) {
        state._climbProg = { x: pp.x, y: pp.y, z: pp.z, at: Date.now() };
      } else if (Date.now() - pr.at > 6000) {
        state._climbProg = { x: pp.x, y: pp.y, z: pp.z, at: Date.now() };
        const ub = bot.blockAt(pp.offset(0, -0.7, 0));
        const fc = bot.blockAt(pp);
        log(`[boss] tower stall: no progress 6s (under=${ub?.name} feet=${fc?.name} held=${bot.heldItem?.name}) — abandoning`);
        return false;
      }
    }
    // Headroom: hop+place needs a clear shaft to targetY — under a roof
    // (tunnel ceiling, overhang) the jump bonks at ~0.2 and the +1 cell
    // is occupied, so every try fails. Sidestep to an open cell first.
    {
      const fp = bot.entity.position.floored();
      let shaftClear = true;
      for (let dy = 1; dy <= 24 && fp.y + dy < targetY + 2; dy++) {
        const b = bot.blockAt(fp.offset(0, dy, 0));
        if (b && b.name !== "air" && b.name !== "scaffolding") { shaftClear = false; break; }
      }
      if (!shaftClear) {
        let dest = null;
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2],[1,1],[1,-1],[-1,1],[-1,-1],[3,0],[-3,0],[0,3],[0,-3],[4,0],[-4,0],[0,4],[0,-4],[5,0],[-5,0],[0,5],[0,-5],[4,4],[-4,4],[4,-4],[-4,-4],[6,0],[-6,0],[0,6],[0,-6],[8,0],[-8,0],[0,8],[0,-8]]) {
          const c = fp.offset(dx, 0, dz);
          let ok = true;
          for (let dy = 1; dy <= 24 && c.y + dy < targetY + 2; dy++) {
            const b = bot.blockAt(c.offset(0, dy, 0));
            if (b && b.name !== "air" && b.name !== "scaffolding") { ok = false; break; }
          }
          if (ok) { dest = c; break; }
        }
        if (dest) {
          refreshGoal(bot, state, "towerReposition", new goals.GoalNear(dest.x + 0.5, dest.y, dest.z + 0.5, 1), 1200);
          await sleep(350);
          return true;
        }
        // Fully roofed (cave/pit under the arena) and no clear cell in
        // scan range: wander — a GoalNear outside the roof makes the
        // pathfinder route through whatever cave mouth exists; rotate
        // the direction so an unreachable pick doesn't stall us.
        const dirs = [[10,0],[-10,0],[0,10],[0,-10],[7,7],[-7,7],[7,-7],[-7,-7]];
        state._caveDirIdx = ((state._caveDirIdx || 0) + 1) % dirs.length;
        const [ddx, ddz] = dirs[state._caveDirIdx];
        refreshGoal(bot, state, "caveEscape", new goals.GoalNear(fp.x + ddx + 0.5, fp.y, fp.z + ddz + 0.5, 1), 1200);
        await sleep(400);
        return true;
      }
    }
    let under = bot.blockAt(bot.entity.position.offset(0, -0.7, 0));
    if (!under || under.name === "air") {
      // mid-step between cells: the support block can sit one level lower
      under = bot.blockAt(bot.entity.position.offset(0, -1.7, 0));
    }
    if (!under || under.name === "air") {
      // Stranded on a thin ledge (own shaft wall after a boom eject):
      // step toward the column — lands back inside the shaft or drops
      // to the ground; either way the next iteration climbs on.
      const tt = state.towerTop || state.scaffoldTop;
      if (tt) {
        try { await bot.lookAt(new Vec3(tt.x + 0.5, bot.entity.position.y, tt.z + 0.5), true); } catch { /* */ }
        bot.setControlState("forward", true);
        await sleep(500);
        bot.setControlState("forward", false);
        return true;
      }
      log(`[boss] tower aborted: no ground below (y=${bot.entity.position.y.toFixed(1)})`);
      return false;
    }
    // Place one block under the feet. placeBlock's built-in wait for
    // blockUpdate stalls 5s on 1.21.1 even though the block DOES land —
    // race it against a short timeout and confirm via blockAt instead.
    let placed = false;
    let tries = 0;
    // Hand-lock: combat reflexes must not swap the held item while the
    // hop+place loop runs — an apple in hand makes block_place a silent
    // no-op and the whole climb stall-loops.
    bot._placingTower = true;
    for (let guard = 0; guard < 10 && !placed && tries < 3; guard++) {
      // Re-read the support cell each iter: after a successful place the
      // last-placed block IS the new under — a stale ref aims at an
      // occupied cell and the server rejects it by construction.
      {
        const u2 = bot.blockAt(bot.entity.position.offset(0, -0.7, 0)) || bot.blockAt(bot.entity.position.offset(0, -1.7, 0));
        if (u2 && u2.name !== "air") under = u2;
      }
      if (bot.heldItem?.name !== mat.name) {
        try {
          await Promise.race([bot.equip(mat, "hand"), sleep(1200)]);
        } catch {
          /* keep trying with whatever is held */
        }
      }
      if (bot.heldItem?.name !== mat.name) {
        // an eat/weapon swap stole the slot — a place with a non-block held
        // item silently no-ops; wait it out without burning a try.
        await sleep(150);
        continue;
      }
      tries++;
      // The placed block's collision shoves the bot toward the column edge —
      // recentre over the column cell before jumping or the next hop slides
      // off sideways and the place attempt lands inside our own hitbox.
      {
        const cc = new Vec3(under.position.x + 0.5, under.position.y + 1, under.position.z + 0.5);
        const bp = bot.entity.position;
        if (Math.hypot(bp.x - cc.x, bp.z - cc.z) > 0.2) {
          try { await bot.lookAt(cc, true); } catch { /* ignore */ }
          bot.setControlState("forward", true);
          await sleep(150);
          bot.setControlState("forward", false);
        }
      }
      // A boom/melee landing mid-try makes the hop unreliable — wait to
      // be grounded again rather than wasting the place attempt.
      if (!bot.entity.onGround) { await sleep(250); continue; }
      bot.setControlState("jump", true);
      const y0 = bot.entity.position.y;
      // The place target is our own feet cell — the hitbox only clears
      // it once the feet pass +1.0. Fire the moment it does: placeBlock's
      // internal aim means the packet lands ~50-100ms later, still inside
      // the ~400ms window before we fall back in.
      for (let i = 0; i < 14; i++) {
        await sleep(45);
        if (bot.entity.position.y - y0 >= 1.02) break;
      }
      if (process.env.BOSS_DEBUG) {
        const atFeet = bot.blockAt(bot.entity.position);
        log(`[boss-dbg] tower try${tries}: rise=${(bot.entity.position.y - y0).toFixed(2)} held=${bot.heldItem?.name} onG=${bot.entity.onGround} under=${under.name} feet=${atFeet?.name} jump=${bot.getControlState?.("jump")} goal=${bot.pathfinder?.goal ? "Y" : "N"}`);
      }
      if (bot.entity.position.y - y0 < 0.95) {
        // No lift — a place would land inside our own hitbox and the server
        // rejects it anyway. Re-centre and retry the hop instead.
        await sleep(120);
        continue;
      }
      // Reflexes (eat/weapon swap) can steal the hand mid-jump — a place
      // fired with food held is a silent no-op. Re-verify the held item
      // now and re-equip if stolen; only fire with the block in hand.
      if (bot.heldItem?.name !== mat.name) {
        try { await Promise.race([bot.equip(mat, "hand"), sleep(220)]); } catch { /* */ }
      }
      if (bot.heldItem?.name !== mat.name) continue;
      // Raw packet, not placeBlock: the wire write is <5ms so the use_on
      // lands inside the ~400ms apex window every try. placeBlock's
      // internal lookAt + blockUpdate wait pushed the packet past the
      // window and the server silently rejected it — the climb's stalls.
      // The server validates "not inside an entity" against ITS view of
      // our position — which lags a tick behind. Push a position packet
      // first so the place sees us at the apex, not on the ground.
      try {
        const pp = bot.entity.position;
        bot._client.write("position", { x: pp.x, y: pp.y, z: pp.z, onGround: false, horizontalCollision: false });
        rawPlace(bot, under.position, 1, state, [0.5, 1.0, 0.5]);
      } catch (e) {
        if (process.env.BOSS_DEBUG) log(`[boss-dbg] rawPlace throw: ${e?.message || e}`);
      }
      // Sneak through the descent: without it a slightly-off landing
      // slides off the 1-wide cap and the climb nets zero height.
      bot.setControlState("sneak", true);
      // Shaft ring: the warden cannot break blocks, so four axial walls
      // at foot level catch any boom knockback — the bot stays inside
      // the tube and the climb never resets. The kb can't eject it over
      // a lip once the shaft encloses every level.
      try {
        const landedBlock = bot.blockAt(under.position.offset(0, 1, 0));
        if (landedBlock && landedBlock.name !== "air" && towerMaterial(bot)) {
          const bp2 = bot.entity.position;
          const AXIAL = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
          for (const face of AXIAL) {
            // Leave one wall open on the warden's side below dy~12 so the
            // warden keeps line-of-smell and presses the base rather than
            // de-aggroing — it can't reach in anyway.
            if (warden && bot.entity.position.y - warden.position.y < 12) {
              const toWarden = new Vec3(Math.sign(warden.position.x - bp2.x), 0, Math.sign(warden.position.z - bp2.z));
              if (face.equals(toWarden)) continue;
            }
            if (bot.blockAt(landedBlock.position.offset(face.x, 0, face.z))?.name !== "air") continue;
            const tm = towerMaterial(bot);
            if (!tm) break;
            if (bot.heldItem?.name !== tm.name) {
              await Promise.race([bot.equip(tm, "hand"), sleep(400)]).catch(() => {});
            }
            const wall = bot.placeBlock(landedBlock, face);
            wall.catch(() => {});
            await Promise.race([wall, sleep(250)]);
          }
          // The boom's knockback has an up component — it pops the bot
          // over a 1-high parapet lip and out of the shaft. Raise the
          // wall on the side the kb pushes toward (away from the warden)
          // to 2 high once we're up enough for a fall to cost the climb.
          if (warden && bp2.y - warden.position.y > 8) {
            const wdx = bp2.x - warden.position.x, wdz = bp2.z - warden.position.z;
            let away = AXIAL[0];
            let bestDot = -Infinity;
            for (const f of AXIAL) {
              const d = f.x * wdx + f.z * wdz;
              if (d > bestDot) { bestDot = d; away = f; }
            }
            const lowWall = bot.blockAt(landedBlock.position.offset(away.x, 0, away.z));
            if (lowWall && lowWall.name !== "air" && bot.blockAt(lowWall.position.offset(0, 1, 0))?.name === "air" && towerMaterial(bot)) {
              const tm = towerMaterial(bot);
              if (bot.heldItem?.name !== tm.name) {
                await Promise.race([bot.equip(tm, "hand"), sleep(400)]).catch(() => {});
              }
              const hi = bot.placeBlock(lowWall, new Vec3(0, 1, 0));
              hi.catch(() => {});
              await Promise.race([hi, sleep(250)]);
            }
          }
        }
      } catch {
        /* shaft walls are a bonus — never abort the climb over them */
      }
      for (let i = 0; i < 10 && !placed; i++) {
        await sleep(60);
        placed = bot.blockAt(under.position.offset(0, 1, 0))?.name !== "air";
      }
      if (!placed) await sleep(150);
    }
    bot.setControlState("jump", false);
    bot.setControlState("sneak", false);
    bot._placingTower = false;
    if (!placed) {
      log("[boss] tower place fail: block never landed after 3 tries");
      return false;
    }
    state.towerBlocks = (state.towerBlocks || 0) + 1;
    // towerTop = the TALLEST placed block — pearls and base-decoys aim
    // at it; tracking the last-placed cell instead aims them at a fresh
    // ground-level restart after a knock-off.
    const nt = under.position.offset(0, 1, 0);
    if (!state.towerTop || nt.y > state.towerTop.y) state.towerTop = nt;
  }
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
// Crystals first (caged ones need a pillar + break one bar), then the
// dragon itself: melee on the perch, bow in the air, beds if we have them.
async function dragonTick(bot, dragon, state, log) {
  await tryEat(bot, state);

  const crystal = findNearest(bot, (e) => mobName(e) === "end_crystal", 130);
  if (crystal) {
    state.phase = "crystal";
    const d = crystal.position.distanceTo(bot.entity.position);

    // Active pillar climb toward this crystal
    if (state.pillar) {
      const climbing = await pillarStep(bot, state, crystal, log);
      if (climbing) return true;
      state.pillar = null;
    }

    if (d <= 4.5) {
      await swing(bot, crystal, state, 0.5);
      return true;
    }
    if (hasBow(bot) && hasArrows(bot) && d < 55) {
      // caged crystals eat arrows — after ~8 fruitless shots, pillar up
      state.crystalShots = (state.crystalShots || 0) + 1;
      if (state.crystalShots > 8 && d > 8) {
        state.pillar = { targetId: crystal.id };
        return true;
      }
      await shootAt(bot, crystal.position.offset(0, 0.5, 0), state, 700);
      return true;
    }
    // No bow: walk up and pillar next to the spike
    if (d > 8) {
      state.pillar = { targetId: crystal.id };
      return true;
    }
    return true;
  }
  state.pillar = null;
  state.crystalShots = 0;

  const dist = dragon.position.distanceTo(bot.entity.position);
  const dy = dragon.position.y - bot.entity.position.y;

  // Perched dragon (lands at the bedrock fountain ~0,61-75,0): melee the head
  if (dy < 6 && dist <= 6) {
    state.phase = "perch-melee";
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      /* ignore */
    }
    await swing(bot, dragon, state, 1.0);
    return true;
  }

  // Close: try a bed under it, or swords if it's low
  if (dist < 22) {
    state.phase = "bed";
    const bombed = await bedBomb(bot, dragon, state, log);
    if (bombed) return true;
    if (dist < 9 && dy < 7) {
      await swing(bot, dragon, state, 1);
      return true;
    }
    if (hasBow(bot) && hasArrows(bot)) {
      await shootAt(bot, dragon.position.offset(0, 1.5, 0), state, 600);
      return true;
    }
    // wait under it / drift toward fountain center
    try {
      bot.pathfinder?.setGoal(new goals.GoalNear(0, bot.entity.position.y, 0, 4), true);
    } catch {
      /* ignore */
    }
    return true;
  }

  if (hasBow(bot) && hasArrows(bot) && dist < 80) {
    state.phase = "bow";
    await shootAt(bot, dragon.position.offset(0, 2, 0), state, 600);
    return true;
  }

  state.phase = "approach";
  try {
    bot.pathfinder?.setGoal(new goals.GoalNear(0, bot.entity.position.y, 0, 6), true);
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Pillar-up state machine for caged end crystals: hop+place under feet
 * until at crystal height, break one iron bar, then hit the crystal.
 * state.pillar = { targetId } persists across ticks; returns false to bail.
 */
async function pillarStep(bot, state, crystal, log) {
  const t = crystal.position;
  const feet = bot.entity.position.floored();

  // At crystal height: break a bar if caged, then strike
  if (feet.y >= t.y - 1) {
    try {
      bot.setControlState("jump", false);
    } catch {
      /* ignore */
    }
    const bar = bot.findBlock({
      matching: (b) => b && b.name === "iron_bars",
      maxDistance: 5,
    });
    if (bar && bar.position.distanceTo(bot.entity.position) <= 5.0) {
      try {
        await bot.lookAt(bar.position.offset(0.5, 0.5, 0.5), true);
        await bot.dig(bar);
        log("[boss] broke iron bar on cage");
      } catch {
        /* ignore */
      }
      return true;
    }
    const d = crystal.position.distanceTo(bot.entity.position);
    if (d <= 5) {
      await swing(bot, crystal, state, 0.5);
      return true;
    }
    if (hasBow(bot) && hasArrows(bot)) {
      await shootAt(bot, t.offset(0, 0.5, 0), state, 600);
      return true;
    }
    return false;
  }

  // Need a placeable block
  const mat = towerMaterial(bot);
  if (!mat) {
    log("[boss] pillar aborted: no building material");
    return false;
  }

  // Get horizontally adjacent to the spike first
  const dxz = Math.hypot(t.x - bot.entity.position.x, t.z - bot.entity.position.z);
  if (dxz > 4.5) {
    try {
      bot.pathfinder?.setGoal(new goals.GoalNear(t.x, bot.entity.position.y, t.z, 3.5), true);
      bot.setControlState("sprint", true);
    } catch {
      /* ignore */
    }
    return true;
  }

  try {
    bot.pathfinder?.setGoal(null);
    bot.setControlState("sprint", false);
    await bot.equip(mat, "hand");
  } catch {
    return false;
  }

  // Jump-place: put a block under our feet each tick (after the feet clear)
  const under = bot.blockAt(bot.entity.position.offset(0, -0.7, 0));
  if (!under || under.name === "air") return false;
  try {
    await bot.lookAt(under.position.offset(0.5, 1, 0.5), true);
    bot.setControlState("jump", true);
    const y0 = bot.entity.position.y;
    for (let i = 0; i < 14; i++) {
      await sleep(60);
      if (bot.entity.position.y - y0 >= 1.02) break;
    }
    await bot.placeBlock(under, new Vec3(0, 1, 0));
    state.pillarBlocks = (state.pillarBlocks || 0) + 1;
    bot.setControlState("jump", false);
  } catch (err) {
    bot.setControlState("jump", false);
    log(`[boss] pillar place fail: ${err?.message || err}`);
    return false;
  }
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
