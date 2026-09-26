/**
 * In-session "beat the game" runner — the progression engine from
 * clear-run.js embedded in the live bot: deterministic phases
 * (wood → … → dragon → clear) drive the bot, combat-reflex fights,
 * the LLM brain advises when a phase stalls, milestones are surfaced
 * via onMilestone (chat + memory).
 *
 *   const runner = new ClearRunner({ bot, cfg, mcData, brain, combat, log });
 *   runner.start(); runner.stop(); runner.status();
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { progressionStep, detectPhase, countItem, PHASES, bossObjectiveStep, BOSS_OBJECTIVES, burrowForNight, pickDryDir, punchNearbyLogs, ensureBedAndSleep, ensureFed, stashDeposit, stashRecover, logSitesLoadFile } from "./progression.js";
import { executeAction } from "./actions.js";
import { Vec3 } from "vec3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULT_PATH = path.resolve(__dirname, "../../logs/clear-mode-result.md");

function inventorySnapshot(bot) {
  const keys = [
    "log",
    "cobblestone",
    "iron_ingot",
    "diamond",
    "obsidian",
    "blaze_rod",
    "ender_pearl",
    "ender_eye",
    "flint_and_steel",
    "crafting_table",
  ];
  const out = {};
  for (const k of keys) out[k] = countItem(bot, k);
  out.bestPick = bot.inventory.items().find((i) => i.name.includes("pickaxe"))?.name || null;
  out.bestSword = bot.inventory.items().find((i) => i.name.includes("sword"))?.name || null;
  out.dim = bot.game?.dimension || "?";
  out.hp = bot.health;
  out.food = bot.food;
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class ClearRunner {
  constructor({ bot, cfg, mcData, brain = null, combat = null, log = console.log, onMilestone = null } = {}) {
    this.bot = bot;
    this.cfg = cfg;
    this.mcData = mcData;
    this.brain = brain;
    this.combat = combat;
    this.log = log;
    this.onMilestone = onMilestone;
    this.maxMs = Number(cfg.clear?.maxMs ?? 120 * 60 * 1000);
    this.running = false;
    this.state = null;
    this.deaths = 0;
    this._deathHandler = null;
    this._respawnHandler = null;
  }

  status() {
    return {
      running: this.running,
      phase: this.state?.phase || (this.bot.entity ? detectPhase(this.bot) : "?"),
      objective: this.state?.objective || "dragon",
      objectivesDone: this.state?.objectivesDone || [],
      credits: !!this.state?.creditsDone,
      steps: this.state?.steps || 0,
      deaths: this.deaths,
      milestones: this.state?.milestones || [],
      elapsedMs: this.state ? Date.now() - this.state.t0 : 0,
    };
  }

  /**
   * objectives: ordered epilogue bosses, e.g. ["dragon"], ["dragon","wither","warden"],
   * or ["wither"] alone. "dragon" = normal progression; the rest run after clear.
   */
  async start(objectives = ["dragon"]) {
    if (this.running) return { ok: false, message: "clear already running" };
    this.objectives = [...new Set((objectives || []).filter((o) => BOSS_OBJECTIVES.has(o)))];
    if (!this.objectives.length) this.objectives = ["dragon"];
    this.running = true;
    this.deaths = 0;
    this.state = {
      phase: "wood",
      milestones: [],
      boss: { allowStickTp: false },
      bossPrep: {},
      steps: 0,
      t0: Date.now(),
      objective: this.objectives[0],
      objectivesDone: [],
      // productive log grounds remembered on disk — a restart (or a `!clear`
      // after deaths wiped in-memory state) keeps the compass
      logSites: logSitesLoadFile(this.bot).slice(-8),
    };
    this._deathHandler = () => {
      this.deaths += 1;
      this.state._diedAt = Date.now();
      const killer = this.combat?.getStats?.().lastTarget || "";
      const p = this.bot.entity?.position;
      const at = p ? ` @${p.x | 0},${p.y | 0},${p.z | 0}` : "";
      this._note(`Я погиб (смерть #${this.deaths}) — фаза ${this.state?.phase}${killer ? ` [${killer}]` : ""}${at}`);
      if (p) this.state._diedPos = { x: p.x, z: p.z };
    };
    this._respawnHandler = () => {
      try {
        const dim = String(this.bot.game?.dimension || "");
        // Credits: leaving the_end alive after the dragon fell — a respawn
        // with no recent death means the exit portal did it, not dying.
        const diedRecently = this.state._diedAt && Date.now() - this.state._diedAt < 4000;
        if (this.state._clearNoted && !this.state.creditsDone && !/end/i.test(dim) && !diedRecently) {
          this.state.creditsDone = true;
          this.state.milestones.push({ t: Date.now() - this.state.t0, milestone: "CREDITS", phase: "credits" });
          if (this.objectives.includes("dragon") && !this.state.objectivesDone.includes("dragon")) {
            this.state.objectivesDone.push("dragon");
          }
          this._note("ТИТРЫ ДОСМОТРЕНЫ — Майнкрафт пройден полностью!");
        }
        this._note(`Возродился. Фаза: ${detectPhase(this.bot)}`);
        // Spawn-camp escape: next loop iteration moves ~40 blocks away from
        // the respawn kill-zone before resuming progression. Bare-handed
        // reflex fights are suicide — park combat until the escape lands.
        this._needRetreat = true;
        // kick the sprint NOW — waiting for the next loop tick gives a
        // spawn-camping creeper its whole 1.5s fuse. Run away from the
        // death spot; the loop's own escape continues from there.
        try {
          const dp = this.state._diedPos;
          const me = this.bot.entity?.position;
          if (dp && me) {
            const dx = me.x - dp.x;
            const dz = me.z - dp.z;
            const len = Math.hypot(dx, dz) || 1;
            void sprintBurst((dx / len) * 40, (dz / len) * 40, 1500).catch(() => {});
          }
        } catch {
          /* ignore */
        }
        try {
          this.combat?.setMode?.("off");
        } catch {
          /* ignore */
        }
        try {
          this.bot.pathfinder?.setGoal(null);
          this.bot.clearControlStates?.();
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
    };
    this.bot.on("death", this._deathHandler);
    this.bot.on("respawn", this._respawnHandler);
    const objNames = { dragon: "дракон", wither: "визер", warden: "варден" };
    this._note(
      this.objectives.length > 1 || this.objectives[0] !== "dragon"
        ? `Начал прохождение — цели: ${this.objectives.map((o) => objNames[o] || o).join(" → ")}`
        : "Начал прохождение игры до дракона"
    );
    this.log(`[clear] started objectives=${this.objectives.join(",")}`);
    // Own the bot for the run: suspend the brain's planner loop so its
    // auto-goals and LLM actions can't fight phase actions over pathfinder.
    this.brain?.suspend();
    void this._loop();
    return { ok: true, message: "clear run started" };
  }

  stop() {
    if (!this.running) return { ok: false, message: "clear not running" };
    this.running = false;
    return { ok: true, message: "clear stopping" };
  }

  _note(text) {
    this.log(`[clear] ${text}`);
    try {
      this.onMilestone?.(text);
    } catch {
      /* never break the run on a hook */
    }
  }

  // sprintBurst: control-state movement starts in <100ms — pathfinder
  // goto needs ~1s to spin up, and skeletons lead shots on standing
  // targets. 1.5s of sprint+zigzag buys distance before planning.
  async _sprintBurst(fdx, fdz, ms = 1500) {
    const bot = this.bot;
    try {
      const yaw = Math.atan2(-fdx, -fdz);
      bot.setControlState("sprint", true);
      bot.setControlState("forward", true);
      const t0 = Date.now();
      let flip = false;
      while (Date.now() - t0 < ms) {
        flip = !flip;
        bot.look(yaw + (flip ? 0.5 : -0.5), 0, true);
        bot.setControlState("jump", Date.now() % 700 < 350);
        await sleep(280);
      }
    } catch {
      /* keep bursting best-effort */
    } finally {
      try {
        bot.setControlState("jump", false);
        bot.setControlState("forward", false);
        bot.setControlState("sprint", false);
      } catch {
        /* ignore */
      }
    }
  }

  async _loop() {
    const { bot, state } = this;
    let lastMilestone = null;
    let lastPhase = null;
    let samePhaseSteps = 0;
    let yieldCount = 0;

    try {
      while (this.running && bot.entity && Date.now() - state.t0 < this.maxMs) {
        state.boss.allowStickTp = false;
        // Yield while the combat reflex owns movement fighting a normal mob —
        // phase actions (staircases, collects) would otherwise fight it for
        // the pathfinder and their gotos resolve instantly on the wrong goal.
        // Capped: an unreachable aggroed mob can't yield-lock the run forever.
        // Post-death escape FIRST: inventory is empty on respawn, so fighting
        // the camping mob bare-handed is a loss. At night hide underground;
        // by day sprint far away. Must run before the combat yield.
        const sprintBurst = (fdx, fdz, ms = 1500) => this._sprintBurst(fdx, fdz, ms);
        // spawn-camp killer pattern was: one 70m goto → pathfinder timeout on
        // rocky terrain → stand still → mob walks up. Chain short hops instead:
        // instant sprint then a bounded goto, repeated until the camper is
        // genuinely out of reach (30m+) or hops run out
        const fleeUntilClear = async (fdx, fdz, hops = 8) => {
          // zombies walk ~2.3m/s and pathfind — a sustained sprint (~5.6m/s)
          // outruns them forever, while the old burst+goto hop walked at
          // 4.3m/s between bursts and let the swarm catch up on every stall.
          // Pure sprint chains with a slight heading drift each hop also
          // slide off obstacles the pathfinder used to stall on.
          // Creepers keep tracking a target past 30m and skeletons shoot at
          // ~25-30m — a camp isn't escaped until nothing hostile is within
          // ~52m, leaving ~20s of walk before the pack is back in range
          // while the ~12s pocket seals.
          let dirX = fdx;
          let dirZ = fdz;
          for (let h = 0; h < hops; h++) {
            const still = Object.values(bot.entities || {}).some((e) => {
              if (!e?.position || e === bot.entity) return false;
              const n = String(e.name || e.displayName || "").toLowerCase();
              const hostile =
                e.kind === "Hostile mobs" ||
                /zombie|skeleton|creeper|spider|enderman|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
              return hostile && e.position.distanceTo(bot.entity.position) < 52;
            });
            if (!still) return;
            await sprintBurst(dirX, dirZ, 3500).catch(() => {});
            // drift the heading ~30° each hop: keeps distance from the swarm
            // arc and bounces us around cliffs/water instead of dead-stalling
            const rot = (h % 2 === 0 ? 1 : -1) * 0.55;
            const cos = Math.cos(rot);
            const sin = Math.sin(rot);
            const nx = dirX * cos - dirZ * sin;
            const nz = dirX * sin + dirZ * cos;
            dirX = nx;
            dirZ = nz;
          }
        };
        const nightTod = bot.time?.timeOfDay;
        const isNight = nightTod != null && nightTod >= 12541;
        // burrow triggers on the EARLY threshold — a step takes 30-60s and
        // tod 12541 is already inside the hostile-spawn window; starting the
        // shelter at 11800 buys a step or two of slack before mobs can spawn
        const nightSoon = nightTod != null && nightTod >= 11800;
        if (this._needRetreat && bot.entity) {
          this._needRetreat = false;
          // died mid-shelter — flag lives on the bot object, reflex must be
          // free again at respawn
          bot._inShelter = false;
          // park the reflex for the WHOLE respawn sequence, not just the
          // burrow: with it live, the engage-goto turns the flee back into
          // the camping mob and a bare-handed fight is how each loop death
          // happens (zombie can't outrun sprint, but reflex never lets the
          // sprint finish)
          bot._burrowActive = true;
          try {
          if (isNight) {
            this.log(`[clear] night respawn — flee then burrow`);
            // respawning on a claimed bed puts the bed a few blocks away —
            // sleeping skips the whole night AND keeps the spawn anchor;
            // sprinting 70m away from it is exactly how the bed gets lost
            try {
              const bedHere = bot.findBlock({ matching: (b) => b && b.name.endsWith("_bed"), maxDistance: 10 });
              if (bedHere) {
                const slept = await ensureBedAndSleep(bot, this.mcData, this.log, this.state).catch(() => ({ ok: false }));
                if (slept.ok) {
                  this.log(`[clear] ${slept.message}`);
                  continue;
                }
              }
            } catch {
              /* fall through to the flee */
            }
            // sprint away FIRST — digging a pocket takes ~10s bare-handed and
            // a mob standing over the respawn kills us mid-dig (spawn-camp loop)
            const pf = bot.entity.position;
            const fleeDirs = [
              [70, 0],
              [-70, 0],
              [0, 70],
              [0, -70],
            ];
            // fleeing onto bare stone is a second death — nothing diggable,
            // nothing to pillar with. Bias the direction toward a remembered
            // log site (dirt ground + wood for pillar blocks) when one is in
            // reach; otherwise keep the dry-window pick
            const siteDir = (this.state?.logSites || [])
              .map((s) => ({ s, d: Math.hypot(s.x - pf.x, s.z - pf.z) }))
              .filter((e) => e.d > 30 && e.d < 300)
              .sort((a, b) => a.d - b.d)[0]?.s;
            let [fdx, fdz] = pickDryDir(bot, fleeDirs);
            if (siteDir) {
              const sx = siteDir.x - pf.x;
              const sz = siteDir.z - pf.z;
              // don't bias INTO the pack: if a hostile sits within ~25° of
              // the site bearing (or right on the site), the site is inside
              // the camp — keep the dry pick instead
              const siteNorm = Math.hypot(sx, sz) || 1;
              const toward = (e) => {
                const ex = e.position.x - pf.x;
                const ez = e.position.z - pf.z;
                const en = Math.hypot(ex, ez) || 1;
                return (ex * sx + ez * sz) / (en * siteNorm) > 0.9 &&
                  e.position.distanceTo(bot.entity.position) < 60;
              };
              const camped = Object.values(bot.entities || {}).some((e) => {
                if (!e?.position || e === bot.entity) return false;
                const n = String(e.name || "").toLowerCase();
                const hostile =
                  e.kind === "Hostile mobs" ||
                  /zombie|skeleton|creeper|spider|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
                return hostile && toward(e);
              });
              if (!camped) {
                const n = Math.max(Math.abs(sx), Math.abs(sz)) || 1;
                fdx = Math.round((sx / n) * 70);
                fdz = Math.round((sz / n) * 70);
                this.log(`[clear] night flee toward logSite ${siteDir.x},${siteDir.z}`);
              } else {
                this.log(`[clear] logSite is inside the camp — dry pick instead`);
              }
            }
            this.log(`[clear] night flee ${fdx},${fdz} after death #${this.deaths}`);
            await fleeUntilClear(fdx, fdz).catch(() => {});
            // the escape gap is ~15s before the horde re-converges — a log
            // punch (~30-60s) or a sheep hunt (~60s) spends it entirely and
            // the burrow never starts. Only prep when genuinely clear.
            const stillClose = Object.values(bot.entities || {}).some((e) => {
              if (!e?.position || e === bot.entity) return false;
              const n = String(e.name || "").toLowerCase();
              const hostile =
                e.kind === "Hostile mobs" ||
                /zombie|skeleton|creeper|spider|husk|drowned|stray|slime|phantom|pillager|vex|enderman|witch/.test(n);
              return hostile && e.position.distanceTo(bot.entity.position) < 40;
            });
            if (!stillClose) {
              try {
                // bare-handed on stone ground the burrow can't dig — punch a
                // few logs first so planks exist for the pillar fallback
                await punchNearbyLogs(bot, this.mcData, 4);
              } catch {
                /* no tree in reach — burrow anyway */
              }
            }
            // bed attempt only when one is already in hand or placed —
            // hunting sheep under an approaching pack is a death loop
            const bedNear =
              bot.inventory.items().some((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name)) ||
              bot.findBlock({ matching: (b) => b && b.name.endsWith("_bed"), maxDistance: 12 });
            try {
              if (bedNear && !stillClose) {
                const slept = await ensureBedAndSleep(bot, this.mcData, this.log, this.state);
                if (slept.ok) {
                  this.log(`[clear] ${slept.message}`);
                } else {
                  this.log(`[clear] no bed: ${slept.message}`);
                  await burrowForNight(bot, this.mcData, this.log, false, 0, this.state);
                }
              } else {
                if (!bedNear && stillClose) this.log(`[clear] pack within 40m — burrow immediately`);
                await burrowForNight(bot, this.mcData, this.log, false, 0, this.state);
              }
            } catch (err) {
              this.log(`[clear] burrow fail: ${err?.message || err}`);
            }
          } else {
            // day respawn: a camper (usually a skeleton in shade/water) can
            // out-range any sprint — flee, then hide in a sealed pocket until
            // it wanders off (the burrow wait is hostile-proximity based)
            const pf = bot.entity.position;
            // hostile already in arrow range at respawn: fleeing draws the
            // kill-window open — burrow on the spot instead of sprinting past.
            // EXCEPTION: a creeper closes and detonates mid-carve (~10s to
            // seal) — against blast-range creepers the sprint IS the burrow
            const dist = (e) => e.position.distanceTo(bot.entity.position);
            const isRanged = (e) => {
              const n = String(e?.name || "");
              return /skeleton|stray|witch|pillager|drowned|phantom|blaze|ghast|shulker/.test(n);
            };
            const respawnHostiles = Object.values(bot.entities || {}).filter((e) => {
              const n = String(e?.name || "");
              const hostile = e.kind === "Hostile mobs" || /zombie|skeleton|creeper|spider|enderman|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
              return hostile && dist(e) < 20;
            });
            // a ranged camper shoots straight through a sprint: a skeleton at
            // 20-34m still kills a fleeing target — burrow and break its line
            // of sight instead of choosing the sprint it can out-range
            const rangedNear = Object.values(bot.entities || {}).some(
              (e) => e?.position && isRanged(e) && dist(e) < 34
            );
            const respawnHostile = respawnHostiles.length > 0 || rangedNear;
            const creepNear = respawnHostiles.some(
              (e) => /creeper/.test(String(e.name || "")) && e.position.distanceTo(bot.entity.position) < 14
            );
            // a melee swarm camps the respawn — you cannot dig/pillar while
            // two+ zombies are already inside reach; only a long sprint opens
            // enough distance to start a build
            const meleeSwarm =
              respawnHostiles.filter(
                (e) =>
                  /zombie|spider|husk|vex|enderman|slime|drowned/.test(String(e.name || "")) &&
                  dist(e) < 10
              ).length >= 2;
            if (!respawnHostile || creepNear || meleeSwarm) {
              const fleeDirs = [
                [70, 0],
                [-70, 0],
                [0, 70],
                [0, -70],
              ];
              // a camper reads the deterministic dry-dir exit — after a couple
              // of spawn-camp deaths, rotate the escape instead of running the
              // same bearing into the same arrow; still prefer the drier of
              // two fresh directions so we don't flee straight into a river
              const [fdx, fdz] =
                this.deaths >= 2
                  ? pickDryDir(bot, [fleeDirs[this.deaths % 4], fleeDirs[(this.deaths + 1) % 4]])
                  : pickDryDir(bot, fleeDirs);
              this.log(`[clear] day flee ${fdx},${fdz} after death #${this.deaths}`);
              await fleeUntilClear(fdx, fdz).catch(() => {});
            } else {
              this.log(`[clear] hostile at spawn — burrowing in place`);
              // a skeleton keeps shooting through the ~30s pocket build —
              // wall its line of sight FIRST (2 adjacent-cell places, ~3s),
              // then burrow behind the cover
              try {
                const ranged = Object.values(bot.entities || {})
                  .filter(
                    (e) =>
                      e?.position &&
                      /skeleton|stray|pillager|witch|drowned/.test(String(e.name || "")) &&
                      e.position.distanceTo(bot.entity.position) < 26
                  )
                  .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
                if (ranged) {
                  const f = bot.entity.position.floored();
                  const vx = ranged.position.x - (f.x + 0.5);
                  const vz = ranged.position.z - (f.z + 0.5);
                  const dirs = Math.abs(vx) > Math.abs(vz) ? [[Math.sign(vx), 0]] : [[0, Math.sign(vz)]];
                  dirs.push([Math.sign(vx), Math.sign(vz)], [0, Math.sign(vz)], [Math.sign(vx), 0]);
                  const solid = () =>
                    bot.inventory.items().find((i) => this.mcData.blocksByName[i.name]?.boundingBox === "block" && !/slab|stairs|fence|torch|sign|carpet|glass|pane/.test(i.name));
                  for (const [wx, wz] of dirs) {
                    if (!wx && !wz) continue;
                    const cellB = bot.blockAt(f.offset(wx, -1, wz));
                    const cell = bot.blockAt(f.offset(wx, 0, wz));
                    if (!cellB || cellB.name === "air" || (cell && cell.name !== "air")) continue;
                    const s = solid();
                    if (!s) break;
                    try {
                      if (bot.heldItem?.name !== s.name) await bot.equip(s, "hand");
                      await bot.lookAt(cellB.position.offset(wx * 0.5, 0.9, wz * 0.5), true);
                      await bot.placeBlock(cellB, new Vec3(0, 1, 0));
                      const cell2 = bot.blockAt(f.offset(wx, 1, wz));
                      if (cell2 && cell2.name === "air") {
                        const s2 = solid();
                        if (s2) {
                          if (bot.heldItem?.name !== s2.name) await bot.equip(s2, "hand");
                          const newBase = bot.blockAt(f.offset(wx, 0, wz));
                          if (newBase && newBase.name !== "air") await bot.placeBlock(newBase, new Vec3(0, 1, 0));
                        }
                      }
                      this.log(`[clear] wall vs ${ranged.name} placed`);
                      break;
                    } catch {
                      /* try next direction */
                    }
                  }
                }
              } catch {
                /* wall is best-effort — burrow anyway */
              }
            }
            try {
              // a melee camper on the respawn kills the build mid-work the
              // same way it does the night burrow — separation burst first
              const melee2 = Object.values(bot.entities || {})
                .filter((e) => {
                  if (!e?.position || e === bot.entity) return false;
                  const n = String(e.name || "").toLowerCase();
                  return /zombie|creeper|spider|husk|vex|enderman|slime|skeleton|stray|pillager/.test(n);
                })
                .sort(
                  (a, b) =>
                    a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
                )[0];
              if (melee2 && melee2.position.distanceTo(bot.entity.position) < 9) {
                const away = bot.entity.position.minus(melee2.position);
                this.log(`[clear] separation sprint away from ${melee2.name}`);
                await sprintBurst(Math.sign(away.x || 1) * 40, Math.sign(away.z || 1) * 40, 1500).catch(() => {});
              }
              // a camper at spawn survives every respawn — a bed activate
              // moves the spawn point permanently, no sleep needed in
              // daylight. Only attempt it when a bed is already held/placed —
              // a sheep hunt under arrows is where the camp deaths happen
              const hasBed2 =
                bot.inventory.items().some((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name)) ||
                bot.findBlock({ matching: (b) => b && b.name.endsWith("_bed"), maxDistance: 12 });
              const slept = hasBed2
                ? await ensureBedAndSleep(bot, this.mcData, this.log, this.state)
                : { ok: false, message: "no bed in hand" };
              if (slept.ok) this.log(`[clear] ${slept.message}`);
              else {
                this.log(`[clear] no bed: ${slept.message}`);
                await burrowForNight(bot, this.mcData, this.log, true, 0, this.state);
              }
            } catch (err) {
              this.log(`[clear] burrow fail: ${err?.message || err}`);
            }
          }
          // respawn wiped the inventory — walk back to the stash chest and
          // take the spare kit before re-entering the grind
          try {
            const rec = await stashRecover(bot, this.mcData, this.log, this.state);
            if (rec?.ok && /recovered/.test(rec.message)) this.log(`[clear] ${rec.message}`);
          } catch {
            /* stash err — continue empty-handed */
          }
          // escape landed — reflexes back on for whatever chased us out here
          } finally {
            bot._burrowActive = false;
          }
          try {
            this.combat?.setMode?.(this.combat?.cfg?.mode || "auto");
          } catch {
            /* ignore */
          }
          continue;
        }
        if (this.combat?.shouldYield?.() && yieldCount < 50) {
          yieldCount += 1;
          await sleep(600);
          continue;
        }
        yieldCount = 0;
        // Food: foodLevel 0 means no sprint and ~0.5hp — starvation is the
        // quiet killer of the marathon. Eat carried food or hunt animals.
        // At food<=4 it's a CRISIS — the bot can't sprint and dies to one
        // hit: phase work pauses until it eats something real.
        // gated on the bail too — an underground starving loop was doing
        // nothing but 45s starve-walk pathfinder timeouts through rock
        if (bot.food != null && bot.food < 14 && (this._starveBail || 0) < 2 && Date.now() - (this._lastFood || 0) > 25000) {
          this._lastFood = Date.now();
          try {
            const fed = await ensureFed(bot, this.mcData, this.log, this.state);
            if (fed?.ate) this.log(`[clear] ate (food=${bot.food})`);
          } catch {
            /* food err — continue */
          }
        }
        if (bot.food != null && bot.food > 8) this._starveBail = 0;
        if (bot.food != null && bot.food <= 4 && (this._starveBail || 0) < 2) {
          this.log(`[clear] starving (food=${bot.food}) — pausing for food`);
          const hungerT0 = Date.now();
          let foundFood = false;
          while (bot.food != null && bot.food <= 8 && Date.now() - hungerT0 < 90000) {
            try {
              const fed2 = await ensureFed(bot, this.mcData, this.log, this.state);
              if (fed2?.ate) {
                this.log(`[clear] ate (food=${bot.food})`);
                foundFood = true;
              }
              if (bot.food > 8) break;
              await sleep(3000);
            } catch {
              break;
            }
          }
          // hunts can fail indefinitely underground — bail and keep grinding
          // at 1hp instead of looping forever; a death resets hunger anyway
          this._starveBail = foundFood || bot.food > 8 ? 0 : (this._starveBail || 0) + 1;
        }
        // Survival for surface phases: burrow at night (mobs will come), and
        // also in daylight when a hostile is camped nearby and the run has
        // died before — creepers/spiders don't burn at dawn.
        const surfacePhase = ["wood", "stone", "iron"].includes(detectPhase(bot));
        const hostileClose = () => Object.values(bot.entities || {}).some((e) => {
          if (!e?.position || e === bot.entity) return false;
          const n = String(e.name || e.displayName || "").toLowerCase();
          const hostile = e.kind === "Hostile mobs" || /zombie|skeleton|creeper|spider|enderman|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
          if (!hostile) return false;
          const d = e.position.distanceTo(bot.entity.position);
          // ranged mobs engage from ~16m — a skeleton just past the melee
          // bound still snipes us mid-work, so it counts as "close" further out
          return /skeleton|stray|witch|pillager|drowned|phantom|blaze|ghast|shulker/.test(n) ? d < 26 : d < 14;
        });
        const hostileNear = hostileClose();
        if (
          surfacePhase &&
          (nightSoon || (hostileNear && this.deaths > 0)) &&
          Date.now() - (this._lastBurrow || 0) > 120000
        ) {
          this._lastBurrow = Date.now();
          this.log(`[clear] burrow: night=${isNight} hostileNear=${hostileNear}`);
          // park the reflex for the whole attempt: a hostile in range makes
          // its engage-goto supersede every burrow hop — the bot cycles in
          // place next to the mob instead of sealing or relocating
          bot._burrowActive = true;
          try {
            // a melee mob already in blast/reach range detonates mid-build —
            // sprint out ~1.4s first for separation (sprint ~5.6 vs mob ~2.3
            // m/s buys ~8m of buffer), then start the shelter work
            const melee = Object.values(bot.entities || {})
              .filter((e) => {
                if (!e?.position || e === bot.entity) return false;
                const n = String(e.name || "").toLowerCase();
                return /zombie|creeper|spider|husk|vex|enderman|slime/.test(n);
              })
              .sort(
                (a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
              )[0];
            // creepers walking in during the ~12s dig are the top killer —
            // an 8m gap closes before the pocket seals; sprint until ~25m
            const meleeDist = melee ? melee.position.distanceTo(bot.entity.position) : 99;
            if (melee && meleeDist < 22) {
              const away = bot.entity.position.minus(melee.position);
              const sdx = Math.sign(away.x || 1) * 40;
              const sdz = Math.sign(away.z || 1) * 40;
              this.log(`[clear] separation sprint away from ${melee.name}@${meleeDist.toFixed(0)}m`);
              await sprintBurst(sdx, sdz, 2400).catch(() => {});
            }
            // bed first on real nights — a slept night is ~30s of exposure
            // vs ~9.5min sealed; burrow remains the fallback. In daylight it
            // still places+activates a bed to claim the spawn point — after
            // one respawn-at-camp the bed is the only permanent fix.
            let burrowed = false;
            // bed attempt only when one is already in hand or placed: hunting
            // sheep is a ~60s loop and under a camp it gets the bot killed
            // long before the bed exists
            const hasBedReady =
              bot.inventory.items().some((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name)) ||
              bot.findBlock({ matching: (b) => b && b.name.endsWith("_bed"), maxDistance: 12 });
            const slept = hasBedReady
              ? await ensureBedAndSleep(bot, this.mcData, this.log, this.state)
              : { ok: false, message: "no bed in hand" };
            if (slept.ok) {
              this.log(`[clear] ${slept.message}`);
              burrowed = true; // night is over — treat as sheltered
            } else {
              this.log(`[clear] no bed: ${slept.message}`);
            }
            // force=true for the daytime variant — a hostile is camped on us
            // and the wait-until-safe logic is exactly what we need anyway
            if (!burrowed) burrowed = await burrowForNight(bot, this.mcData, this.log, !isNight, 0, this.state);
            // day-hide ends at ~90s whether or not the camper left (creepers
            // don't burn) — if it's still camped on us, sprint out of its
            // 14m reach instead of looping straight back into a burrow
            if (burrowed && !isNight && hostileClose()) {
              const pf2 = bot.entity.position;
              const [fdx2, fdz2] = pickDryDir(bot, [[70, 0], [-70, 0], [0, 70], [0, -70]]);
              this.log(`[clear] day-flee ${fdx2},${fdz2} — camper survived the hide`);
              await sprintBurst(fdx2, fdz2).catch(() => {});
              try {
                await executeAction(
                  bot,
                  { type: "goto", x: pf2.x + fdx2, y: pf2.y, z: pf2.z + fdz2, range: 8, timeoutMs: 40000 },
                  this.mcData
                );
              } catch {
                /* superseded */
              }
            }
            // Night burrow gave up entirely (no diggable ground anywhere):
            // surface work in the dark is a death loop — keep looking for
            // shelter instead of falling through to the phase step.
            if (!burrowed && isNight) {
              this.log(`[clear] no shelter — waiting out the night`);
              this._lastBurrow = 0;
              await sleep(15000);
            }
          } catch (err) {
            this.log(`[clear] burrow fail: ${err?.message || err}`);
          } finally {
            bot._burrowActive = false;
          }
          continue;
        }
        // surplus beyond the keep-set goes into the stash chest — a death
        // then costs a walk home, not the whole toolkit
        if (!nightSoon && !hostileNear && Date.now() - (this._lastStash || 0) > 90000) {
          this._lastStash = Date.now();
          try {
            const sd = await stashDeposit(bot, this.mcData, this.log, this.state);
            if (sd?.ok && /stashed/.test(sd.message)) this.log(`[clear] ${sd.message}`);
          } catch {
            /* stash err — continue */
          }
        }
        // opportunistic daytime sheep pickup: a bed crafted+claimed while the
        // sun is up means the dusk hunt never has to fight a monster camp for
        // wool — run only when a sheep (or an unclaimed placed bed) is already
        // in view so the detour is seconds, not a 60s blind hunt
        if (
          surfacePhase &&
          !nightSoon &&
          !hostileNear &&
          Date.now() - (this._lastSheep || 0) > 150000 &&
          !bot.inventory.items().some((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name))
        ) {
          const woolHeld = bot.inventory.items().reduce((n, i) => n + (/(?:^|_)wool$/.test(i.name) ? i.count : 0), 0);
          const sheepNear = Object.values(bot.entities || {}).some(
            (e) => e?.position && e.name === "sheep" && e.position.distanceTo(bot.entity.position) < 48
          );
          const bedNear = bot.findBlock({
            matching: (b) => b && (bot.isABed?.(b) || b.name.endsWith("_bed")),
            maxDistance: 12,
          });
          if (woolHeld < 3 && sheepNear) {
            this._lastSheep = Date.now();
            this._note("Овца! Кровать скоро будет — ночи проживу спокойно.");
            try {
              const res = await ensureBedAndSleep(bot, this.mcData, this.log, this.state);
              if (res?.ok || /bed|spawn/.test(res?.message || "")) this.log(`[clear] sheep run: ${res.message}`);
            } catch {
              /* sheep run failed — phase continues */
            }
          } else if (bedNear) {
            // claiming an already-placed bed is a single activate — free
            this._lastSheep = Date.now();
            await ensureBedAndSleep(bot, this.mcData, this.log, this.state).catch(() => {});
          }
        }
        const phaseBefore = detectPhase(bot);
        const dimBefore = String(bot.game?.dimension || "");
        const deathsBefore = this.deaths;
        let step = { ok: false, phase: phaseBefore, message: "no step" };

        // "dragon" is done only once the credits have rolled — dying or
        // leaving the_end without the exit portal means heading back in.
        const dragonDone =
          !this.objectives.includes("dragon") || state.objectivesDone.includes("dragon");
        const nextObj = this.objectives.find((o) => !state.objectivesDone.includes(o) && o !== "dragon");

        if (dragonDone && nextObj) {
          // Epilogue boss objectives (wither/warden): self-contained prep + fight.
          state.objective = nextObj;
          try {
            step = await bossObjectiveStep(bot, this.mcData, state, nextObj, this.log);
          } catch (err) {
            step = { ok: false, phase: phaseBefore, message: `boss crash: ${err?.message || err}` };
            this.log(`[clear] BOSS_STEP_CRASH ${step.message}`);
          }
          if (step.done) {
            state.objectivesDone.push(nextObj);
            this._note(`Босс повержен: ${nextObj}!`);
          }
          step.phase = `${nextObj}_prep`;
        } else {
          try {
            step = await progressionStep(bot, this.mcData, state, this.log);
          } catch (err) {
            step = { ok: false, phase: phaseBefore, message: `crash: ${err?.message || err}` };
            this.log(`[clear] STEP_CRASH ${step.message}`);
            this.log(`[clear] STEP_CRASH_STACK ${err?.stack || "(no stack)"}`);
          }
        }
        const phaseAfter = detectPhase(bot);
        state.phase = step.phase || phaseAfter;

        if (step.milestone && step.milestone !== lastMilestone) {
          lastMilestone = step.milestone;
          state.milestones.push({ t: Date.now() - state.t0, milestone: step.milestone, phase: phaseAfter });
          this._note(`Этап: ${step.milestone} (фаза ${phaseAfter})`);
        }
        if (phaseAfter === lastPhase) samePhaseSteps += 1;
        else {
          samePhaseSteps = 0;
          lastPhase = phaseAfter;
        }
        this.log(
          `[clear] step=${state.steps} phase=${phaseAfter} ok=${step.ok} msg=${step.message} stuck=${samePhaseSteps} deaths=${this.deaths}`
        );

        const dimNow = String(bot.game?.dimension || "");
        if ((phaseAfter === "clear" || step.milestone === "CLEAR") && !state._clearNoted) {
          state._clearNoted = true;
          this._note("Дракон повержен! Иду к выходному порталу — титры.");
        }
        // Credits = left the_end without dying this step (death also flips
        // the dimension — gated on the deaths counter so a death isn't a win).
        const leftEndAlive =
          /end/i.test(dimBefore) &&
          !/end/i.test(dimNow) &&
          this.deaths === deathsBefore &&
          !!state._clearNoted;
        if (!state.creditsDone && (step.milestone === "CREDITS" || leftEndAlive)) {
          state.creditsDone = true;
          state.milestones.push({ t: Date.now() - state.t0, milestone: "CREDITS", phase: "credits" });
          if (this.objectives.includes("dragon") && !state.objectivesDone.includes("dragon")) {
            state.objectivesDone.push("dragon");
          }
          this._note("ТИТРЫ ДОСМОТРЕНЫ — Майнкрафт пройден полностью!");
          const epilogueLeft = this.objectives.filter((o) => !state.objectivesDone.includes(o));
          if (epilogueLeft.length) {
            this._note(`Эпилог: ${epilogueLeft.join(", ")}`);
          }
        }
        if (this.objectives.every((o) => state.objectivesDone.includes(o))) {
          this._note("ВСЕ ЦЕЛИ ВЫПОЛНЕНЫ — полное прохождение!");
          break;
        }

        const stuckThresh = phaseAfter === "diamond" || phaseAfter === "portal" || phaseAfter === "nether" ? 20 : 12;
        if (samePhaseSteps >= stuckThresh && this.brain) {
          this.log("[clear] STUCK — brain.step()");
          try {
            this.brain.unsuspend();
            this.brain.queueCommand(
              `Застрял в фазе ${phaseAfter} во время прохождения. Выбери действия чтобы продвинуться: копай лестницу вниз/вперёд, поднимись, обойди препятствие.`,
              "clear-mode"
            );
            await this.brain.step();
          } catch (err) {
            this.log(`[clear] brain step fail: ${err?.message || err}`);
          } finally {
            this.brain.suspend();
          }
          samePhaseSteps = 0;
          // hard-trap escalation: the planner had its shots and the phase
          // still can't move (ravine/cave-in — every goto is no-path). The
          // sanctioned unstick is /kill respawn onto spawn ground; the
          // respawn handler above re-gears from the stash chest. Surface
          // phases only — a nether/end kill strands the run.
          state.stuckCycles = (state.stuckCycles || 0) + 1;
          if (
            state.stuckCycles >= 3 &&
            (state.unstickKills || 0) < 2 &&
            ["wood", "stone", "iron"].includes(phaseAfter)
          ) {
            this.log("[clear] hard trap — /kill unstick respawn");
            state.unstickKills += 1;
            bot.chat("/kill");
            await sleep(3000);
          }
          await sleep(1500);
        }

        const pace = phaseAfter === "wood" || phaseAfter === "stone" ? 1200 : 800;
        await sleep(pace);
      }
    } finally {
      this.running = false;
      this.brain?.unsuspend();
      if (this._deathHandler) this.bot.removeListener("death", this._deathHandler);
      if (this._respawnHandler) this.bot.removeListener("respawn", this._respawnHandler);
      this._writeResult();
    }
  }

  _writeResult() {
    const state = this.state;
    if (!state) return;
    const clear =
      this.objectives?.length > 0
        ? this.objectives.every((o) => state.objectivesDone?.includes(o))
        : state.milestones.some((m) => m.milestone === "CLEAR") || state.phase === "clear";
    const md = `# Clear mode result

- **clear**: ${clear}
- **objectives**: ${(this.objectives || ["dragon"]).join(", ")} (done: ${(state.objectivesDone || []).join(", ") || "—"})
- **credits**: ${!!state.creditsDone}
- **elapsed**: ${((Date.now() - state.t0) / 60000).toFixed(1)} min
- **finalPhase**: ${state.phase}
- **deaths**: ${this.deaths}

## Milestones
${state.milestones.map((m) => `- +${(m.t / 60000).toFixed(1)}m **${m.milestone}** (${m.phase})`).join("\n") || "_none_"}

## Inventory snapshot
\`\`\`json
${JSON.stringify(this.bot.entity ? inventorySnapshot(this.bot) : {}, null, 2)}
\`\`\`
`;
    try {
      fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
      fs.writeFileSync(RESULT_PATH, md);
      this.log(`[clear] result written ${RESULT_PATH} clear=${clear}`);
    } catch {
      /* ignore */
    }
  }
}

export { PHASES, detectPhase };
