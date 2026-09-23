/**
 * Local combat reflex — ~50ms loop, no LLM.
 * PvE focus: kite creepers, shield vs projectiles, equip weapon, crit/sprint-hit, eat, multi-threat priority.
 */
import pkgPathfinder from "mineflayer-pathfinder";
import { isHostileMobName } from "./world.js";
import {
  selectNearestCombatTarget,
  equipBestWeapon,
  equipBestShield,
  pickBestFood,
} from "./actions.js";
import { bossCombatTick, isBossMobName, mobName as bossMobName } from "./boss-combat.js";

const { goals } = pkgPathfinder;

const DEFAULTS = {
  enabled: true,
  intervalMs: 40,
  engageDistance: 48,
  meleeDistance: 3.15,
  maxDistance: 80,
  cooldownMs: 520,
  fleeAtHealth: 4,
  eatBelowHealth: 14,
  eatBelowFood: 16,
  autoEngageHostiles: true,
  attackAllLiving: false,
  allowPlayers: false,
  holdMsAfterHit: 8000,
  equipEveryMs: 2500,
  shieldVsProjectile: true,
  kiteCreeperDistance: 5.5,
  prioritizeExploders: true,
  strafe: true,
  jumpCrit: true,
  sprintHit: true,
};

/** Never auto-farm these even in attackAllLiving (armor stands / display junk). */
const NEVER_ATTACK = new Set([
  "item",
  "experience_orb",
  "xp_orb",
  "arrow",
  "spectral_arrow",
  "trident",
  "area_effect_cloud",
  "armor_stand",
  "item_frame",
  "glow_item_frame",
  "painting",
  "minecart",
  "chest_minecart",
  "hopper_minecart",
  "tnt_minecart",
  "furnace_minecart",
  "boat",
  "chest_boat",
  "falling_block",
  "tnt",
  "firework_rocket",
  "snowball",
  "egg",
  "ender_pearl",
  "eye_of_ender",
  "potion",
  "llama_spit",
  "shulker_bullet",
  "wither_skull",
  "dragon_fireball",
  "small_fireball",
  "fireball",
  "evoker_fangs",
  "marker",
  "text_display",
  "block_display",
  "item_display",
  "interaction",
]);

/** Higher = kill first */
const THREAT_WEIGHT = {
  creeper: 100,
  charged_creeper: 120,
  skeleton: 80,
  stray: 80,
  bogged: 80,
  wither_skeleton: 85,
  pillager: 75,
  witch: 70,
  blaze: 90,
  ghast: 70,
  phantom: 65,
  drowned: 55,
  guardian: 70,
  elder_guardian: 90,
  enderman: 60,
  spider: 50,
  cave_spider: 65,
  zombie: 40,
  husk: 40,
  zombie_villager: 40,
  zombified_piglin: 45,
  piglin_brute: 75,
  hoglin: 70,
  ravager: 95,
  vindicator: 80,
  evoker: 85,
  vex: 70,
  warden: 150,
  wither: 140,
  ender_dragon: 130,
  silverfish: 30,
  endermite: 30,
  slime: 35,
  magma_cube: 40,
  shulker: 60,
};

const RANGED = new Set([
  "skeleton",
  "stray",
  "bogged",
  "pillager",
  "blaze",
  "ghast",
  "witch",
  "piglin",
  "wither_skeleton",
]);

const EXPLODER = new Set(["creeper"]);

export class CombatReflex {
  constructor({ bot, cfg = {}, log = console.log }) {
    this.bot = bot;
    this.log = log;
    this.cfg = { ...DEFAULTS, ...(cfg.combat || {}) };
    this.running = false;
    this._timer = null;
    this._lastHitAt = 0;
    this._lastEquipAt = 0;
    this._lastEatAt = 0;
    this._engagedUntil = 0;
    this._lockedId = null;
    this._blocking = false;
    this._strafeDir = 1;
    this._strafeFlipAt = 0;
    this._stats = {
      ticks: 0,
      hits: 0,
      engages: 0,
      flees: 0,
      kites: 0,
      blocks: 0,
      eats: 0,
      kills: 0,
      lastTickMs: 0,
      maxTickMs: 0,
      sumTickMs: 0,
      lastTarget: null,
    };
    this.mode = this.cfg.mode || "auto";
    this._onEntityGone = null;
    this._onHurt = null;
    this._bossState = { allowStickTp: false };
  }

  getBossState() {
    return { ...this._bossState };
  }

  getStats() {
    const n = Math.max(1, this._stats.ticks);
    return {
      ...this._stats,
      avgTickMs: Number((this._stats.sumTickMs / n).toFixed(2)),
      intervalMs: this.cfg.intervalMs,
      mode: this.mode,
      enabled: this.cfg.enabled,
      blocking: this._blocking,
      lockedId: this._lockedId,
      boss: this._bossState,
    };
  }

  setMode(mode) {
    const allowed = ["auto", "hold", "off"];
    if (!allowed.includes(mode)) throw new Error(`combat mode must be ${allowed.join("|")}`);
    this.mode = mode;
    if (mode === "off") {
      this._lockedId = null;
      this._engagedUntil = 0;
      this._stopBlock();
      this._clearMotion();
    }
  }

  engage(options = {}) {
    const target = options.entity || this._pickBestThreat(options);
    if (!target) return false;
    this._lockedId = target.id;
    this._engagedUntil = Date.now() + (options.holdMs ?? this.cfg.holdMsAfterHit);
    this._stats.engages += 1;
    this._stats.lastTarget = this._mobName(target);
    return true;
  }

  start() {
    if (this.running || !this.cfg.enabled) return;
    this.running = true;

    this._onHurt = (entity) => {
      if (!this.running || this.mode === "off") return;
      if (entity === this.bot.entity) {
        this.engage({ holdMs: this.cfg.holdMsAfterHit * 2 });
        void this._tryEat(true);
      }
    };
    this.bot.on("entityHurt", this._onHurt);

    this._onEntityGone = (entity) => {
      if (!entity || entity.id !== this._lockedId) return;
      if (this._isHostile(entity)) {
        this._stats.kills += 1;
        this.log(`[combat] kill? target gone id=${entity.id} name=${this._mobName(entity)}`);
      }
      this._lockedId = null;
    };
    this.bot.on("entityGone", this._onEntityGone);

    const tick = () => {
      if (!this.running) return;
      const t0 = performance.now();
      try {
        void this._tick();
      } catch (err) {
        this.log(`[combat] tick error: ${err?.message || err}`);
      }
      const dt = performance.now() - t0;
      this._stats.ticks += 1;
      this._stats.lastTickMs = Number(dt.toFixed(2));
      this._stats.sumTickMs += dt;
      if (dt > this._stats.maxTickMs) this._stats.maxTickMs = Number(dt.toFixed(2));
      this._timer = setTimeout(tick, this.cfg.intervalMs);
    };
    tick();
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (this._onHurt) this.bot.removeListener("entityHurt", this._onHurt);
    if (this._onEntityGone) this.bot.removeListener("entityGone", this._onEntityGone);
    this._stopBlock();
    this._clearMotion();
    try {
      this.bot.pathfinder?.setGoal(null);
    } catch {
      /* ignore */
    }
  }

  _mobName(entity) {
    return String(entity?.name || entity?.displayName || entity?.username || "unknown")
      .toLowerCase()
      .replaceAll(" ", "_");
  }

  _isHostile(entity) {
    if (!entity) return false;
    if (entity.type === "player" || entity.username) {
      return this.cfg.allowPlayers === true && entity.username !== this.bot.username;
    }
    const name = this._mobName(entity);
    if (NEVER_ATTACK.has(name)) return false;
    if (isBossMobName(name)) return true;
    if (entity.kind === "Hostile mobs") return true;
    // berserk: cows, sheep, villagers, iron golems — anything living/mob
    if (this.cfg.attackAllLiving === true) {
      if (entity.type === "mob" || entity.kind === "Passive mobs" || entity.kind === "Neutral mobs") {
        return true;
      }
      // some versions tag farm animals without kind
      if (/^(cow|mooshroom|sheep|pig|chicken|rabbit|horse|donkey|mule|llama|trader_llama|cat|wolf|fox|goat|frog|tadpole|axolotl|sniffer|camel|panda|parrot|bee|turtle|dolphin|cod|salmon|tropical_fish|pufferfish|squid|glow_squid|bat|allay|villager|wandering_trader|iron_golem|snow_golem|strider|hoglin|piglin|zombified_piglin)$/i.test(name)) {
        return true;
      }
    }
    // piglin neutral until provoked — treat brute as hostile always
    if (name === "piglin" || name === "zombified_piglin") {
      return this.cfg.attackAllLiving === true;
    }
    return isHostileMobName(name);
  }

  _threatScore(entity, dist) {
    const name = this._mobName(entity);
    let base = THREAT_WEIGHT[name] || (this._isHostile(entity) ? 40 : 0);
    if (isBossMobName(name)) base += 200;
    if (EXPLODER.has(name) && dist < 6) base += 80;
    if (RANGED.has(name) && dist < 14) base += 25;
    // closer = more urgent
    base += Math.max(0, 20 - dist);
    return base;
  }

  _pickBestThreat(options = {}) {
    const bot = this.bot;
    if (!bot?.entity) return null;
    // Bosses: look farther
    let maxD = options.maxDistance ?? this.cfg.engageDistance;
    const anyBoss = Object.values(bot.entities || {}).some(
      (e) => e && e !== bot.entity && isBossMobName(this._mobName(e))
    );
    if (anyBoss) maxD = Math.max(maxD, 80);
    const hostiles = Object.values(bot.entities || {}).filter(
      (e) => e && e.position && e !== bot.entity && (this._isHostile(e) || isBossMobName(this._mobName(e)))
    );
    let best = null;
    let bestScore = -Infinity;
    for (const e of hostiles) {
      if (options.name && this._mobName(e) !== String(options.name).toLowerCase()) continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (!Number.isFinite(d) || d > maxD) continue;
      const score = this._threatScore(e, d);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  _clearMotion() {
    try {
      const bot = this.bot;
      for (const s of ["forward", "back", "left", "right", "sprint", "jump", "sneak"]) {
        bot.setControlState(s, false);
      }
    } catch {
      /* ignore */
    }
  }

  _stopBlock() {
    if (!this._blocking) return;
    try {
      this.bot.deactivateItem();
    } catch {
      /* ignore */
    }
    this._blocking = false;
  }

  async _ensureGear(force = false, target = null) {
    const now = Date.now();
    if (this.bot._placingTower) return; // tower hop+place owns the hand
    if (!force && now - this._lastEquipAt < this.cfg.equipEveryMs) return;
    this._lastEquipAt = now;
    try {
      await equipBestWeapon(this.bot);
      const name = target ? this._mobName(target) : "";
      // Enderman: do NOT wear pumpkin — it makes them ignore us and never close for melee.
      // Look-at-feet + water + aggressive chase instead.
      // Prefer shield vs axe raiders / ranged; keep totem if no shield
      const needShield =
        !name ||
        RANGED.has(name) ||
        name === "vindicator" ||
        name === "ravager" ||
        name === "piglin_brute" ||
        EXPLODER.has(name);
      if (needShield) {
        await equipBestShield(this.bot);
      } else {
        const totem = this.bot.inventory.items().find((i) => i.name === "totem_of_undying");
        if (totem) {
          try {
            await this.bot.equip(totem, "off-hand");
          } catch {
            await equipBestShield(this.bot);
          }
        } else {
          await equipBestShield(this.bot);
        }
      }
    } catch {
      /* inventory race */
    }
  }

  async _tryEat(force = false) {
    const bot = this.bot;
    const now = Date.now();
    if (bot._placingTower) return false; // tower hop+place owns the hand
    if (now - this._lastEatAt < 2500 && !force) return false;
    const hp = Number(bot.health);
    const food = Number(bot.food);
    if (!force && hp > this.cfg.eatBelowHealth && food > this.cfg.eatBelowFood) return false;
    const item = pickBestFood(bot);
    if (!item) return false;
    this._lastEatAt = now;
    this._stopBlock();
    this._clearMotion();
    try {
      bot.pathfinder?.setGoal(null);
      await bot.equip(item, "hand");
      await bot.consume();
      this._stats.eats += 1;
      // Don't restore the weapon while a boss owns the hotbar — it
      // re-equips whatever its current step needs anyway.
      const locked = this._lockedId != null ? bot.entities[this._lockedId] : null;
      if (!locked || !isBossMobName(this._mobName(locked))) {
        await equipBestWeapon(bot);
      }
      return true;
    } catch {
      return false;
    }
  }

  async _startBlock() {
    if (this._blocking) return;
    const bot = this.bot;
    const shield =
      bot.inventory.slots[45] || // offhand slot index often 45
      bot.inventory.items().find((i) => i.name === "shield");
    if (!shield && !bot.inventory.items().some((i) => i.name === "shield")) return;
    try {
      if (!bot.inventory.slots[45] || bot.inventory.slots[45].name !== "shield") {
        await equipBestShield(bot);
      }
      bot.activateItem(true); // off-hand
      this._blocking = true;
      this._stats.blocks += 1;
    } catch {
      try {
        bot.activateItem(false);
        this._blocking = true;
      } catch {
        /* no shield */
      }
    }
  }

  _shouldBlock(target, dist) {
    if (!this.cfg.shieldVsProjectile || !target) return false;
    const name = this._mobName(target);
    if (RANGED.has(name) && dist > 2.5 && dist < 16) return true;
    if (EXPLODER.has(name) && dist < 4) return true;
    // incoming projectiles near bot
    for (const e of Object.values(this.bot.entities || {})) {
      if (!e?.position) continue;
      const n = this._mobName(e);
      if (n === "arrow" || n === "spectral_arrow" || n === "small_fireball" || n === "fireball") {
        if (e.position.distanceTo(this.bot.entity.position) < 8) return true;
      }
    }
    return false;
  }

  _kiteAway(fromEntity) {
    const bot = this.bot;
    try {
      bot.pathfinder?.setGoal(null);
      const dx = bot.entity.position.x - fromEntity.position.x;
      const dz = bot.entity.position.z - fromEntity.position.z;
      const yaw = Math.atan2(-dx, -dz);
      bot.entity.yaw = yaw;
      bot.setControlState("back", true);
      bot.setControlState("sprint", true);
      bot.setControlState("jump", true);
      this._stats.kites += 1;
      setTimeout(() => {
        try {
          bot.setControlState("back", false);
          bot.setControlState("jump", false);
        } catch {
          /* ignore */
        }
      }, 350);
    } catch {
      /* ignore */
    }
  }

  _strafeAround(target) {
    if (!this.cfg.strafe) return;
    const bot = this.bot;
    const now = Date.now();
    if (now > this._strafeFlipAt) {
      this._strafeDir *= -1;
      this._strafeFlipAt = now + 400 + Math.floor(Math.random() * 300);
    }
    try {
      bot.setControlState("left", this._strafeDir < 0);
      bot.setControlState("right", this._strafeDir > 0);
      bot.setControlState("forward", true);
      if (this.cfg.sprintHit) bot.setControlState("sprint", true);
    } catch {
      /* ignore */
    }
  }

  async _splashWaterNear(target) {
    const bot = this.bot;
    const bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
    if (!bucket) return;
    try {
      await bot.equip(bucket, "hand");
      const feet = bot.entity.position.offset(0, -1, 0).floored();
      const ref = bot.blockAt(feet) || bot.blockAt(bot.entity.position.floored());
      if (ref) {
        // place water on adjacent solid if possible
        await bot.lookAt(target.position.offset(0, 0.1, 0), true);
        bot.activateItem();
        this._stats.kites += 1;
      }
      await equipBestWeapon(bot);
    } catch {
      try {
        await equipBestWeapon(bot);
      } catch {
        /* ignore */
      }
    }
  }

  async _meleeHit(target) {
    const bot = this.bot;
    const now = Date.now();
    const name = this._mobName(target);
    // Vindicator / raiders: shorter cooldown if diamond+ gear present
    let cd = this.cfg.cooldownMs;
    if (name === "vindicator" || name === "ravager") cd = Math.min(cd, 480);
    if (now - this._lastHitAt < cd) return;
    this._stopBlock();

    const aimY = Math.max(0.4, (target.height || 1.6) * 0.55);
    // enderman: look at feet only (pumpkin also helps)
    const aim = target.position.offset(0, name === "enderman" ? 0.05 : aimY, 0);

    try {
      if (this.cfg.jumpCrit && bot.entity.onGround && name !== "enderman") {
        bot.setControlState("jump", true);
        setTimeout(() => {
          try {
            bot.setControlState("jump", false);
          } catch {
            /* ignore */
          }
        }, 120);
      }
      // sprint-reset for knockback
      if (this.cfg.sprintHit) {
        bot.setControlState("sprint", false);
      }
      // enderman: never look at head
      if (name === "enderman") {
        await bot.lookAt(aim, true);
      } else {
        await bot.lookAt(aim, true);
      }
      await Promise.resolve(bot.attack(target));
      if (this.cfg.sprintHit) {
        bot.setControlState("sprint", true);
      }
      // hit-and-block vs heavy melee
      if (name === "vindicator" || name === "ravager" || name === "piglin_brute") {
        setTimeout(() => {
          void this._startBlock();
        }, 80);
      }
      this._lastHitAt = now;
      this._stats.hits += 1;
    } catch {
      /* swing failed */
    }
  }

  async _tick() {
    if (this.mode === "off" || !this.cfg.enabled) return;
    const bot = this.bot;
    if (!bot?.entity || bot.health == null) return;

    // A boss tick is mid-await (climb/eat/shoot take seconds) — let it own
    // the bot exclusively or we'd stomp its gear and control states.
    if (this._bossState?._tickBusy) return;

    const now = Date.now();
    const hp = Number(bot.health);

    // Emergency flee only at very low HP after eat attempt
    if (hp <= this.cfg.fleeAtHealth) {
      await this._tryEat(true);
      if (Number(bot.health) <= this.cfg.fleeAtHealth) {
        if (this._lockedId != null) this._stats.flees += 1;
        this._lockedId = null;
        this._engagedUntil = 0;
        this._stopBlock();
        try {
          bot.pathfinder?.setGoal(null);
          bot.clearControlStates();
          bot.setControlState("back", true);
          bot.setControlState("sprint", true);
          setTimeout(() => {
            try {
              bot.setControlState("back", false);
              bot.setControlState("sprint", false);
            } catch {
              /* ignore */
            }
          }, 500);
        } catch {
          /* ignore */
        }
        return;
      }
    }

    if (hp <= this.cfg.eatBelowHealth || Number(bot.food) <= this.cfg.eatBelowFood) {
      // eat if not face-tanking (or force golden apple under heavy pressure)
      const near = this._pickBestThreat({ maxDistance: 3.5 });
      if (!near || hp <= 10) await this._tryEat(hp <= 10);
    }

    // gear refresh uses current lock for pumpkin/shield choice
    const lockedPreview = this._lockedId != null ? bot.entities[this._lockedId] : null;
    const previewName = lockedPreview ? this._mobName(lockedPreview) : "";
    // While a boss is engaged the boss tick owns the hotbar — a
    // void-launched gear swap from this gap window lands mid-place
    // and stomps the held block (the "diamond_sword place" fails).
    if (!isBossMobName(previewName)) void this._ensureGear(false, lockedPreview);

    let target = this._lockedId != null ? bot.entities[this._lockedId] : null;
    if (!target || target.isValid === false) {
      this._lockedId = null;
      target = null;
    }

    const engaged = now < this._engagedUntil || this.mode === "hold";
    if (!target && (engaged || (this.cfg.autoEngageHostiles && this.mode === "auto"))) {
      target = this._pickBestThreat();
      if (target) {
        this._lockedId = target.id;
        this._engagedUntil = Math.max(this._engagedUntil, now + this.cfg.holdMsAfterHit);
        this._stats.engages += 1;
        this._stats.lastTarget = this._mobName(target);
      }
    } else if (target && this.cfg.prioritizeExploders) {
      // retarget creeper if closer bomb appears
      const bomb = this._pickBestThreat({ maxDistance: 8 });
      if (bomb && EXPLODER.has(this._mobName(bomb)) && bomb.id !== target.id) {
        const dBomb = bomb.position.distanceTo(bot.entity.position);
        const dCur = target.position.distanceTo(bot.entity.position);
        if (dBomb < dCur || dBomb < 5) {
          target = bomb;
          this._lockedId = bomb.id;
          this._stats.lastTarget = this._mobName(bomb);
        }
      }
    }

    if (!target) {
      this._stopBlock();
      return;
    }

    const dist = target.position.distanceTo(bot.entity.position);
    const tName = this._mobName(target);
    const bossRange = isBossMobName(tName) ? 96 : this.cfg.maxDistance + 6;
    if (!Number.isFinite(dist) || dist > bossRange) {
      this._lockedId = null;
      this._stopBlock();
      return;
    }

    if (dist <= this.cfg.engageDistance || isBossMobName(tName)) {
      this._engagedUntil = Math.max(this._engagedUntil, now + this.cfg.holdMsAfterHit);
    }

    // Boss skills take over entirely
    if (isBossMobName(tName)) {
      this._stopBlock();
      try {
        const handled = await bossCombatTick(bot, target, this._bossState, this.log);
        if (handled) {
          this._stats.lastTarget = tName;
          return;
        }
      } catch (err) {
        this.log(`[combat] boss tick: ${err?.message || err}`);
      }
    }

    const name = tName;

    // Creeper kite
    if (EXPLODER.has(name) && dist < this.cfg.kiteCreeperDistance) {
      this._stopBlock();
      this._kiteAway(target);
      // still hit if slightly outside explosion sweet spot
      if (dist > 3.0 && dist < 4.8 && now - this._lastHitAt >= this.cfg.cooldownMs) {
        void this._meleeHit(target);
      }
      return;
    }

    // Shield vs ranged / heavy melee
    const heavyMelee = name === "vindicator" || name === "ravager" || name === "piglin_brute";
    if (this._shouldBlock(target, dist) || (heavyMelee && dist < 4.5 && now - this._lastHitAt < 200)) {
      void this._startBlock();
      if (dist > this.cfg.meleeDistance) {
        try {
          bot.pathfinder.setGoal(new goals.GoalFollow(target, heavyMelee ? 2.4 : 2.0), true);
        } catch {
          /* ignore */
        }
      }
    } else if (!(heavyMelee && dist <= this.cfg.meleeDistance)) {
      this._stopBlock();
    }

    // Enderman: always hard-chase (teleports), water when in range, look only at feet
    if (name === "enderman") {
      this._engagedUntil = Math.max(this._engagedUntil, now + 15000);
      if (dist <= 5) void this._splashWaterNear(target);
      if (dist > this.cfg.meleeDistance) {
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1), true);
          bot.setControlState("sprint", true);
          bot.setControlState("forward", true);
          bot.setControlState("jump", true);
        } catch {
          try {
            bot.pathfinder.setGoal(new goals.GoalFollow(target, 0.8), true);
          } catch {
            /* ignore */
          }
        }
        // swing if slightly out of range but line of sight
        if (dist < 4.2 && now - this._lastHitAt >= this.cfg.cooldownMs) {
          void this._meleeHit(target);
        }
        return;
      }
    }

    // Evoker: keep moving, never stand still for fangs
    if (name === "evoker") {
      this._strafeAround(target);
      if (dist < 3) this._kiteAway(target);
    }

    // Piglin brute: always shield between swings
    if (name === "piglin_brute" && dist < 5) {
      if (now - this._lastHitAt > 100) void this._startBlock();
    }

    if (dist > this.cfg.meleeDistance) {
      try {
        // ranged: close gap aggressively
        const range = RANGED.has(name) ? 1.8 : 2.2;
        bot.pathfinder.setGoal(new goals.GoalFollow(target, range), true);
        bot.setControlState("sprint", true);
      } catch {
        /* pathfinder not ready */
      }
      return;
    }

    // Melee range
    try {
      bot.pathfinder.setGoal(null);
    } catch {
      /* ignore */
    }

    this._strafeAround(target);
    void this._meleeHit(target);
  }
}
