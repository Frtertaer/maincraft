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
import { progressionStep, detectPhase, countItem, PHASES, bossObjectiveStep, BOSS_OBJECTIVES, burrowForNight, pickDryDir, punchNearbyLogs, ensureBedAndSleep, ensureFed, stashDeposit, stashRecover, stashLoadFile, logSitesLoadFile, deathZonesLoadFile, deathZonesSaveFile } from "./progression.js";
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
      // kill ring remembered on disk too — an OOM/crash restart must not
      // forget the camp zone and wander back into it
      ...(() => {
        const dz = deathZonesLoadFile(this.bot);
        return {
          _deathPts: dz.pts,
          campZone: dz.camp ? { x: dz.camp.x, z: dz.camp.z } : null,
        };
      })(),
    };
    this._deathHandler = () => {
      this.deaths += 1;
      this.state._diedAt = Date.now();
      const killer = this.combat?.getStats?.().lastTarget || "";
      const p = this.bot.entity?.position;
      const at = p ? ` @${p.x | 0},${p.y | 0},${p.z | 0}` : "";
      // empty lastTarget + no engaged mob means the kill came from the
      // environment (lava into the strip, gravel suffocation, a creeper that
      // reached the fuse before the reflex locked on) — log which so the
      // cause is diagnosable instead of a silent "died underground"
      let cause = "";
      if (!killer && p) {
        try {
          const feet = this.bot.blockAt(p.floored());
          const near = [];
          for (const e of Object.values(this.bot.entities || {})) {
            if (!e || !e.position || !e.name) continue;
            const d = e.position.distanceTo(p);
            if (d < 8 && /zombie|skeleton|creeper|spider|witch|drowned|enderman|pillager|slime|hoglin|blaze/.test(e.name)) near.push(`${e.name}@${d | 0}m`);
          }
          if (feet && /lava|fire/.test(feet.name)) cause = ` env=${feet.name}`;
          else if (near.length) cause = ` mob:${near.join(",")}`;
        } catch {}
      }
      this._note(`Я погиб (смерть #${this.deaths}) — фаза ${this.state?.phase}${killer ? ` [${killer}]` : ""}${cause}${at}`);
      if (p) {
        this.state._diedPos = { x: p.x, z: p.z };
        // a spawn camp is a place, not a moment — two deaths inside ~150m of
        // each other within 10min means re-entering that area is how the
        // loop dies; mark it and every flee/site pick steers away
        const pts = (this.state._deathPts = (this.state._deathPts || []).filter((d) => Date.now() - d.t < 600000));
        pts.push({ x: p.x, z: p.z, t: Date.now() });
        const cluster = pts.filter((d) => Math.hypot(d.x - p.x, d.z - p.z) < 150);
        if (cluster.length >= 2) {
          const cx = Math.round(cluster.reduce((a, d) => a + d.x, 0) / cluster.length);
          const cz = Math.round(cluster.reduce((a, d) => a + d.z, 0) / cluster.length);
          if (!this.state.campZone || Math.hypot(this.state.campZone.x - cx, this.state.campZone.z - cz) > 60) {
            this.state.campZone = { x: cx, z: cz };
            this.log(`[clear] camp zone marked ${cx},${cz} — avoiding`);
          }
        }
        deathZonesSaveFile(this.bot, this.state._deathPts, this.state.campZone);
      }
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
        // the camp is the respawn ANCHOR, not the ring of bodies: fleeing
        // 70m in different directions lands each death somewhere new and no
        // 150m cluster ever forms — the zone every pick must avoid is the
        // point we keep coming back to
        const ptsN = (this.state._deathPts || []).length;
        if (ptsN >= 2 && this.bot.entity?.position) {
          const me0 = this.bot.entity.position;
          const zx = Math.round(me0.x);
          const zz = Math.round(me0.z);
          if (!this.state.campZone || Math.hypot(this.state.campZone.x - zx, this.state.campZone.z - zz) > 60) {
            this.state.campZone = { x: zx, z: zz };
            this.log(`[clear] camp zone anchored on respawn ${zx},${zz}`);
          }
          deathZonesSaveFile(this.bot, this.state._deathPts, this.state.campZone);
        }
        // Spawn-camp escape: next loop iteration moves ~40 blocks away from
        // the respawn kill-zone before resuming progression. Bare-handed
        // reflex fights are suicide — park combat until the escape lands.
        this._needRetreat = true;
        // kick the sprint NOW — waiting for the next loop tick gives a
        // spawn-camping creeper its whole 1.5s fuse. A 1.5s burst is ~8
        // blocks: the camper re-closes during the wake-up gap and that's the
        // spawn-camp chain. ~7s of sprint-jump is ~40m — a melee mob at
        // 2.3m/s cannot re-cover it before the loop's own escape continues.
        try {
          const dp = this.state._diedPos;
          const me = this.bot.entity?.position;
          if (dp && me) {
            const dx = me.x - dp.x;
            const dz = me.z - dp.z;
            const len = Math.hypot(dx, dz) || 1;
            void sprintBurst((dx / len) * 40, (dz / len) * 40, 7000).catch(() => {});
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
      const yaw0 = Math.atan2(-fdx, -fdz);
      let yaw = yaw0;
      bot.setControlState("sprint", true);
      bot.setControlState("forward", true);
      const t0 = Date.now();
      let flip = false;
      // shoreline steer: a sprint leg that wades into a lake trades 5.6m/s
      // for ~2 and lets the drowned pack close the gap (speedrun6 deaths #4-5
      // were exactly this). Probe the cell 3m ahead; wet -> bank toward the
      // drier side instead of diving in.
      const wetAt = (ox, oz) => {
        const f = bot.entity.position.floored();
        const c = bot.blockAt(f.offset(ox, 0, oz)) || bot.blockAt(f.offset(ox, -1, oz));
        return c && /water|kelp|seagrass|bubble/.test(c.name);
      };
      while (Date.now() - t0 < ms) {
        const ax = Math.round(-Math.sin(yaw) * 3);
        const az = Math.round(-Math.cos(yaw) * 3);
        if (wetAt(ax, az)) {
          const lx = Math.round(-Math.sin(yaw - 0.9) * 3);
          const lz = Math.round(-Math.cos(yaw - 0.9) * 3);
          const rx = Math.round(-Math.sin(yaw + 0.9) * 3);
          const rz = Math.round(-Math.cos(yaw + 0.9) * 3);
          const lWet = wetAt(lx, lz);
          const rWet = wetAt(rx, rz);
          if (!lWet && rWet) yaw -= 0.9;
          else if (!rWet && lWet) yaw += 0.9;
          else yaw += flip ? 0.9 : -0.9; // shoreline both ways — zigzag along it
        }
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
          // kill sites are campers' homes: a landing that merely has no live
          // hostile in 52m but sits inside a recorded death ring is exactly
          // where the swarm wanders back to — the "flee 70m, camp again, die"
          // loop. Keep hopping until clear of BOTH live hostiles and every
          // remembered kill site
          const killPts = [
            ...(this.state?._deathPts || []),
            ...((deathZonesLoadFile(bot) || {}).pts || []),
          ].filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.z));
          const insideKillRing = () =>
            killPts.some(
              (c) =>
                Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z) < 80
            );
          for (let h = 0; h < hops; h++) {
            const still = Object.values(bot.entities || {}).some((e) => {
              if (!e?.position || e === bot.entity) return false;
              const n = String(e.name || e.displayName || "").toLowerCase();
              const hostile =
                e.kind === "Hostile mobs" && e.name !== "enderman" ||
                /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
              return hostile && e.position.distanceTo(bot.entity.position) < 52;
            });
            if (!still && !insideKillRing()) return;
            // hop-level water guard: the pick's dry-runway scan reaches ~90m
            // but legs run 140m+, and the ±30° drift can still steer into a
            // lake — a drowned in water ends every flee. If the next ~18m is
            // wet, re-pick THIS hop's heading with the runway scorer
            let hopX = dirX;
            let hopZ = dirZ;
            {
              const f = bot.entity.position.floored();
              const ul = Math.hypot(dirX, dirZ) || 1;
              const ux = dirX / ul;
              const uz = dirZ / ul;
              let wet = false;
              outer: for (const t of [6, 12, 18, 24]) {
                for (let dy = 0; dy >= -18; dy--) {
                  const b = bot.blockAt(f.offset(ux * t, dy, uz * t));
                  if (!b) continue;
                  if (/water|kelp|seagrass|ice|bubble/.test(b.name)) {
                    wet = true;
                    break outer;
                  }
                  if (dy < 0 && b.boundingBox === "block") break;
                }
              }
              if (wet) {
                [hopX, hopZ] = pickDryDir(bot, [
                  [dirX * 24, dirZ * 24],
                  [dirZ * 24, -dirX * 24],
                  [-dirZ * 24, dirX * 24],
                  [-dirX * 24, -dirZ * 24],
                ]);
              }
            }
            await sprintBurst(hopX, hopZ, 3500).catch(() => {});
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
                // a bed inside an active death camp is the kill anchor — every
                // respawn lands back in the witch's/mob's ring (speedrun6: 5
                // straight respawns into the same camping witch). Break it:
                // the next death then respawns at world spawn, far away
                const czBed = this.state?.campZone;
                const recentCampDeaths = (this.state?._deathPts || []).filter(
                  (d) => czBed && Math.hypot(d.x - czBed.x, d.z - czBed.z) < 120 && Date.now() - d.t < 240000
                ).length;
                if (czBed && Math.hypot(bedHere.position.x - czBed.x, bedHere.position.z - czBed.z) < 120 && recentCampDeaths >= 2) {
                  try {
                    await executeAction(bot, { type: "dig", x: bedHere.position.x, y: bedHere.position.y, z: bedHere.position.z, timeoutMs: 6000 }, this.mcData);
                    this.log(`[clear] broke camped bed — next respawn goes to world spawn`);
                  } catch {
                    /* couldn't reach it — flee anyway */
                  }
                }
              }
            } catch {
              /* fall through to the flee */
            }
            // starving respawn can't sprint at all (food<=6 kills the sprint
            // flag) — a 210m flee is a slow walk a spider/jockey outruns
            // instantly. If anything edible is in the bag, eat first — even
            // one meal re-enables the sprint that breaks the camp; only then
            // burrow where we stand
            if (bot.food != null && bot.food <= 4) {
              this.log(`[clear] starving respawn (food=${bot.food | 0}) — eat-or-burrow on the spot`);
              // eat ONLY what's already in the bag — the ensureFed hunt walk
              // under an adjacent spider is just a slower death than the dig
              const edible = bot.inventory
                .items()
                .find((i) => this.mcData.foodsByName?.[i.name] || /apple|bread|pork|beef|mutton|chicken|rabbit|flesh|carrot|potato|stew|soup|cookie|melon|pumpkin_pie|salmon|cod|berries|chorus/.test(i.name));
              if (edible) {
                const tOut = (p, ms) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error("timeout")), ms))]);
                try {
                  await tOut(bot.equip(edible, "hand"), 5000);
                  await tOut(bot.consume(), 6000);
                  this.log(`[clear] starve-ate ${edible.name}`);
                } catch {
                  /* eat refused — burrow anyway */
                }
              }
              if (bot.food != null && bot.food > 6) {
                // got the sprint back — real flee now
              } else {
                try {
                  await burrowForNight(bot, this.mcData, this.log, false, 0, this.state);
                } catch (err) {
                  this.log(`[clear] starve-burrow fail: ${err?.message || err}`);
                }
                continue;
              }
            }
            // sprint away FIRST — digging a pocket takes ~10s bare-handed and
            // a mob standing over the respawn kills us mid-dig (spawn-camp loop)
            const pf = bot.entity.position;
            // ...unless the respawn itself sits inside the anchored camp:
            // then every flee direction crosses another shooter's LOS — two
            // straight skeleton deaths this run came from sprinting through
            // the bowl. Seal the ground where we stand instead; the grave
            // abort check keeps a mob from dropping into the shaft with us.
            // Only when blocks are already in hand — a bare-handed log hunt
            // inside the camp stands still ~20s under pursuit and dies first
            const czIn = this.state?.campZone;
            const hasShelterBlocks = bot.inventory
              .items()
              .some((i) => /_log|_planks|dirt|sand|gravel|_leaves|_block|cobble|stone$|netherrack|andesite|diorite|granite/.test(i.name));
            // "burrow first" is only safe when nothing is already in kill
            // range — the ~20s carve can't outrun a camper that's adjacent.
            // With a shooter/melee on the doorstep the sprint comes first
            // and the burrow happens at the landing, not in the kill window
            const campHostileNear = Object.values(bot.entities || {}).some((e) => {
              if (!e?.position || e === bot.entity) return false;
              const n = String(e.name || "").toLowerCase();
              return (
                (e.kind === "Hostile mobs" && e.name !== "enderman") ||
                /zombie|skeleton|creeper|spider|husk|drowned|stray|slime|phantom|pillager|vex|witch/.test(n)
              ) && e.position.distanceTo(bot.entity.position) < 24;
            });
            if (czIn && Math.hypot(pf.x - czIn.x, pf.z - czIn.z) < 120 && hasShelterBlocks && !campHostileNear) {
              this.log(`[clear] respawn inside camp — burrow first`);
              try {
                const okIn = await burrowForNight(bot, this.mcData, this.log, false, 0, this.state);
                if (okIn) continue;
              } catch (errIn) {
                this.log(`[clear] camp-burrow fail: ${errIn?.message || errIn}`);
              }
            }
            // a 70m hop stays inside the same mob field on a dense spawn —
            // each repeat death widens the ring so the escape leaves it
            const ring = 70 * Math.min(3, Math.max(1, (this.state._deathPts || []).length));
            const fleeDirs = [
              [ring, 0],
              [-ring, 0],
              [0, ring],
              [0, -ring],
            ];
            // fleeing onto bare stone is a second death — nothing diggable,
            // nothing to pillar with. Bias the direction toward a remembered
            // log site (dirt ground + wood for pillar blocks) when one is in
            // reach; otherwise keep the dry-window pick
            // the stash chest outranks a log site when empty-handed — the
            // restart kit inside (food+tools) IS the survival baseline; a
            // fresh respawn has neither. Sites inside the camp still skipped.
            const sitePool = [...(this.state?.logSites || []), this.state?.stash, ...stashLoadFile(bot)].filter(Boolean);
            const siteDir = sitePool
              .map((s) => ({ s, d: Math.hypot(s.x - pf.x, s.z - pf.z) }))
              .filter(
                (e) =>
                  e.d > 30 &&
                  e.d < 300 &&
                  !(this.state?.campZone && Math.hypot(e.s.x - this.state.campZone.x, e.s.z - this.state.campZone.z) < 150)
              )
              .sort((a, b) => a.d - b.d)[0]?.s;
            const awayFromCamp = (pos, dirs) => {
              const cz = this.state?.campZone;
              if (!cz) return dirs;
              const ok = dirs.filter(([dx, dz]) => Math.hypot(pos.x + dx - cz.x, pos.z + dz - cz.z) > 120);
              if (ok.length) return ok;
              // a 70m hop in any direction still lands inside the camp —
              // take the long straight line away instead
              const ax = pos.x - cz.x;
              const az = pos.z - cz.z;
              const n = Math.max(Math.abs(ax), Math.abs(az)) || 1;
              return [[Math.round((ax / n) * 200), Math.round((az / n) * 200)]];
            };
            let [fdx, fdz] = pickDryDir(bot, awayFromCamp(pf, fleeDirs));
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
                  e.kind === "Hostile mobs" && e.name !== "enderman" ||
                  /zombie|skeleton|creeper|spider|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
                return hostile && toward(e);
              });
              if (!camped) {
                const n = Math.max(Math.abs(sx), Math.abs(sz)) || 1;
                // keep the death-scaled ring — capping the site leg at 70m
                // landed the bot back inside the mob field on deep camps
                fdx = Math.round((sx / n) * ring);
                fdz = Math.round((sz / n) * ring);
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
            const packClose = () =>
              Object.values(bot.entities || {}).some((e) => {
                if (!e?.position || e === bot.entity) return false;
                const n = String(e.name || "").toLowerCase();
                const hostile =
                  e.kind === "Hostile mobs" && e.name !== "enderman" ||
                  /zombie|skeleton|creeper|spider|husk|drowned|stray|slime|phantom|pillager|vex|witch/.test(n);
                return hostile && e.position.distanceTo(bot.entity.position) < 40;
              });
            // burrowing while the pack trails inside 40m is how every carve
            // dies mid-seal (~20-30s dig vs ~15s walk). Sprint legs until the
            // gap actually opens — HOLD the bearing: zigzagging ±90° inside a
            // camp ring covers ~0.7× distance and never exits it; a straight
            // 6-leg run is ~350m, out of any pack field. Rotate only when a
            // leg stalls on terrain (<20m gained) — and only a dead sprint
            // meter (food<=6) makes the dig the better bet
            const nearestHostile = () => {
              let d = Infinity;
              for (const e of Object.values(bot.entities || {})) {
                if (!e?.position || e === bot.entity) continue;
                const n = String(e.name || "").toLowerCase();
                const hostile =
                  (e.kind === "Hostile mobs" && e.name !== "enderman") ||
                  /zombie|skeleton|creeper|spider|husk|drowned|stray|slime|phantom|pillager|vex|witch/.test(n);
                if (!hostile) continue;
                const ed = e.position.distanceTo(bot.entity.position);
                if (ed < d) d = ed;
              }
              return d;
            };
            let legs = 0;
            let stillClose = packClose();
            let lastPos = bot.entity.position;
            let legDir = [fdx, fdz];
            let lastGap = nearestHostile();
            let noProgress = 0;
            while (stillClose && legs < 6 && bot.food > 6) {
              this.log(`[clear] pack still <40m — flee leg ${legs + 1}`);
              await fleeUntilClear(legDir[0], legDir[1], 6).catch(() => {});
              legs += 1;
              const moved = bot.entity.position.distanceTo(lastPos);
              // stalled on terrain (<20m) — try perpendicular once, then the other side
              if (moved < 20) legDir = legDir[0] === fdx ? [-fdz, fdx] : [fdz, -fdx];
              else legDir = [fdx, fdz];
              lastPos = bot.entity.position;
              stillClose = packClose();
              // two consecutive legs that don't open the gap — the pack
              // outruns the sprint (spider/baby/water/creeper field) or the
              // loop respawned mid-flee and the mobs closed again. Every
              // further leg burns dig time; seal in.
              const gap = nearestHostile();
              if (gap <= lastGap + 10) noProgress += 1;
              else noProgress = 0;
              lastGap = gap;
              if (noProgress >= 2) break;
            }
            if (stillClose) this.log(`[clear] pack won't shake — burrowing anyway`);
            // only chase shelter material when the ground under our feet is
            // undiggable — a 32m collect-goto at night respawn pathfinds into
            // the mob field and the timeout stall is how the loop dies (the
            // skeleton that was >40m walks back in while it stands still).
            // On diggable ground the pocket IS the shelter — carve now.
            const feetBlk = bot.entity.position.floored();
            const groundB = bot.blockAt(feetBlk.offset(0, -1, 0));
            const diggable = (b) =>
              b &&
              /dirt|grass|sand|gravel|clay|mud|snow|mycelium|podzol|coarse_dirt|rooted_dirt|farmland|moss|soul_sand|soul_soil/.test(
                b.name || ""
              );
            const hasShelterMat = bot.inventory
              .items()
              .some((i) => this.mcData.blocksByName[i.name]?.boundingBox === "block");
            if (!stillClose && (!diggable(groundB) || !hasShelterMat)) {
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
            const woolHere = bot.inventory.items().reduce((n, i) => n + (/(?:^|_)wool$/.test(i.name) ? i.count : 0), 0);
            const bedNear =
              bot.inventory.items().some((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name)) ||
              bot.findBlock({ matching: (b) => b && b.name.endsWith("_bed"), maxDistance: 12 }) ||
              woolHere >= 3;
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
              const hostile = e.kind === "Hostile mobs" && e.name !== "enderman" || /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
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
              // a creeper anywhere inside the respawn-hostile radius is a bomb
              // on a timer — it closes ~3.2m/s and the ~10s carve seals slower
              // than it arrives; 14m was still losing spawn-camp loops
              (e) => /creeper/.test(String(e.name || "")) && e.position.distanceTo(bot.entity.position) < 20
            );
            // a melee swarm camps the respawn — you cannot dig/pillar while
            // two+ zombies are already inside reach; only a long sprint opens
            // enough distance to start a build
            // a bare-handed respawn can't wall or seal — "burrow in place"
            // means ~20-40s of log punching while the hostile closes. With
            // anything hostile inside ~48m, sprinting first is the only
            // survivable answer (pillager respawn-camp deaths #2-4)
            const bareHands = !bot.inventory
              .items()
              .some((i) => /_log|_planks|dirt|sand|gravel|_leaves|_block|cobble|stone$|netherrack|andesite|diorite|granite/.test(i.name));
            const packNear48 = Object.values(bot.entities || {}).some((e) => {
              if (!e?.position || e === bot.entity) return false;
              const n = String(e.name || "").toLowerCase();
              return (
                (e.kind === "Hostile mobs" && e.name !== "enderman" ||
                  /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n)) &&
                e.position.distanceTo(bot.entity.position) < 48
              );
            });
            const meleeSwarm =
              respawnHostiles.filter(
                (e) =>
                  /zombie|spider|husk|vex|slime|drowned/.test(String(e.name || "")) &&
                  dist(e) < 10
              ).length >= 2;
            if (!respawnHostile || creepNear || meleeSwarm || (bareHands && packNear48)) {
              // a bed-side respawn under repeat kills is the bed camping us:
              // every death lands at the same anchor in the same mob pocket.
              // Dig it up — the item can be re-placed on safe ground later,
              // and the next death falls back to world spawn instead of the
              // kill ring (daytime twin of the night-branch camped-bed break)
              try {
                const bedNear2 = bot.findBlock({ matching: (b) => b && b.name.endsWith("_bed"), maxDistance: 45 });
                if (bedNear2) {
                  const nearDeaths = (this.state._deathPts || []).filter(
                    (d) => Math.hypot(d.x - bedNear2.position.x, d.z - bedNear2.position.z) < 60 && Date.now() - d.t < 240000
                  ).length;
                  if (nearDeaths >= 2) {
                    await executeAction(
                      bot,
                      { type: "dig", x: bedNear2.position.x, y: bedNear2.position.y, z: bedNear2.position.z, timeoutMs: 6000 },
                      this.mcData
                    ).catch(() => ({ ok: false }));
                    this.log(`[clear] broke camped bed @${bedNear2.position.x},${bedNear2.position.z} — ${nearDeaths} deaths nearby`);
                  }
                }
              } catch {
                /* bed check is best-effort — flee regardless */
              }
              const ring = 70 * Math.min(3, Math.max(1, (this.state._deathPts || []).length));
              const fleeDirs = [
                [ring, 0],
                [-ring, 0],
                [0, ring],
                [0, -ring],
              ];
              // a camper reads the deterministic dry-dir exit — after a couple
              // of spawn-camp deaths, rotate the escape instead of running the
              // same bearing into the same arrow; still prefer the drier of
              // two fresh directions so we don't flee straight into a river;
              // camp zone drops any bearing that lands back inside the death
              // cluster — day-flee through the camp is how the tally grows
              const czD = this.state?.campZone;
              const campOk = czD
                ? (d) => Math.hypot(pf.x + d[0] - czD.x, pf.z + d[1] - czD.z) > 120
                : () => true;
              // every prior kill site is a lit marker — a flee that lands
              // ~40m from a recorded death re-enters the same mob pocket.
              // Filter landings that touch any remembered death, not just the
              // camp centroid.
              const dzFile = deathZonesLoadFile(bot) || { pts: [], camp: null };
              const killSites = [...(this.state._deathPts || []), ...(dzFile.pts || [])]
                .filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.z));
              const siteDist = (d) =>
                killSites.length
                  ? Math.min(...killSites.map((c) => Math.hypot(pf.x + d[0] - c.x, pf.z + d[1] - c.z)))
                  : Infinity;
              const siteOk = (r) => (d) => siteDist(d) > r;
              const dirsAll = fleeDirs.filter(campOk);
              // strict >60m first; when every bearing lands inside the death
              // cluster (the drowned-pool basin) relax to >30m, and past that
              // rank by the farthest-landing instead of picking blindly back
              // into the kill ring — a compromised landing still beats the
              // nearest kill site
              const strict = dirsAll.filter(siteOk(60));
              const relaxed = strict.length ? strict : dirsAll.filter(siteOk(30));
              const dirsOk = relaxed.length
                ? relaxed
                : [...dirsAll].sort((a, b) => siteDist(b) - siteDist(a)).slice(0, 1);
              // rank by dry runway, not just live mobs: pickDryDir measures
              // how far each leg stays out of water AND caps the runway at
              // the first hostile standing in the corridor — a quadrant
              // mobScore only sees entities within 60m, so a 210m leg into
              // the drowned ring scored 'clean' until the bot was already
              // swimming into tridents (drowned kills #9-12)
              const dryPick =
                dirsOk.length > 0
                  ? pickDryDir(bot, dirsOk)
                  : (() => {
                      const ax = pf.x - czD.x;
                      const az = pf.z - czD.z;
                      const n = Math.max(Math.abs(ax), Math.abs(az)) || 1;
                      return [Math.round((ax / n) * 200), Math.round((az / n) * 200)];
                    })();
              const [fdx, fdz] = dryPick;
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
                  return /zombie|creeper|spider|husk|vex|slime|skeleton|stray|pillager/.test(n);
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
                bot.findBlock({ matching: (b) => b && b.name.endsWith("_bed"), maxDistance: 12 }) ||
                bot.inventory.items().reduce((n, i) => n + (/(?:^|_)wool$/.test(i.name) ? i.count : 0), 0) >= 3;
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
          } catch (err) {
            this.log(`[clear] respawn escape err: ${err?.message || err}`);
          } finally {
            bot._burrowActive = false;
          }
          try {
            this.combat?.setMode?.(this.combat?.cfg?.mode || "auto");
          } catch {
            /* ignore */
          }
          // floor between escape iterations: on a dying socket every call
          // fails instantly and a bare continue hot-spins the event loop
          // until the server kicks for keepalive timeout (seen 11:49:18)
          await sleep(800);
          continue;
        }
        if (this.combat?.shouldYield?.() && yieldCount < 50) {
          yieldCount += 1;
          await sleep(600);
          continue;
        }
        yieldCount = 0;
        // Survival for surface phases: burrow at night (mobs will come), and
        // also in daylight when a hostile is camped nearby and the run has
        // died before — creepers/spiders don't burn at dawn.
        const surfacePhase = ["wood", "stone", "iron"].includes(detectPhase(bot));
        const hostileClose = () => Object.values(bot.entities || {}).some((e) => {
          if (!e?.position || e === bot.entity) return false;
          const n = String(e.name || e.displayName || "").toLowerCase();
          const hostile = e.kind === "Hostile mobs" && e.name !== "enderman" || /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
          if (!hostile) return false;
          const d = e.position.distanceTo(bot.entity.position);
          // ranged mobs engage from ~16m — a skeleton just past the melee
          // bound still snipes us mid-work, so it counts as "close" further out
          return /skeleton|stray|witch|pillager|drowned|phantom|blaze|ghast|shulker/.test(n) ? d < 26 : d < 14;
        });
        // A threat that can actually catch or hit a walking bot: ranged mobs
        // (arrows ignore kiting), creepers near fuse range, phantoms, or an
        // already-surrounding pack. Slow melee (zombies 2.3 m/s, creepers
        // 3.3, spiders neutral by day) only counts at night — by day the bot
        // outwalks them and burrowing just wastes the food window.
        const hardThreat = () => {
          const dayNow = (bot.time?.timeOfDay ?? 0) < 12541;
          let meleePack = 0;
          return Object.values(bot.entities || {}).some((e) => {
            if (!e?.position || e === bot.entity) return false;
            const n = String(e.name || e.displayName || "").toLowerCase();
            const hostile =
              e.kind === "Hostile mobs" && e.name !== "enderman" ||
              /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
            if (!hostile) return false;
            const d = e.position.distanceTo(bot.entity.position);
            if (/skeleton|stray|witch|pillager|blaze|ghast|shulker|evoker|illusioner/.test(n)) return d < 30;
            if (/creeper/.test(n)) return d < (dayNow ? 9 : 12);
            if (/phantom/.test(n)) return d < 24;
            if (/spider|cave_spider/.test(n)) return !dayNow && d < 10;
            if (d < 6) meleePack++;
            return !dayNow && d < 14;
          }) || meleePack >= 3;
        };
        const hostileNear = hostileClose();
        // breadcrumbs: a proven-walkable trail — the underground climb replays
        // the newest sky-lit point instead of re-digging a staircase through
        // the same rock (the pocket↔climb loop ate whole days)
        try {
          const bp = bot.entity.position.floored();
          const tr = (state.trail ||= []);
          const last = tr[tr.length - 1];
          if (!last || Math.hypot(bp.x - last.x, bp.y - last.y, bp.z - last.z) > 7) {
            let sky = false;
            for (let dy = 0; dy < 3 && !sky; dy++) {
              const b = bot.blockAt(bp.offset(0, dy, 0));
              if (b && (b.skyLight ?? 0) > 4) sky = true;
            }
            tr.push({ x: bp.x, y: bp.y, z: bp.z, sky });
            if (tr.length > 140) tr.shift();
          }
        } catch {
          /* trail best-effort */
        }
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
        // skip the 90s food window at night: every ensureFed branch is
        // day/sky-gated, so the loop just burns ~100s per iteration while
        // the shelter gate below is the only move that matters. Carried
        // food still gets eaten by the 25s check above.
        if (bot.food != null && bot.food <= 4 && !nightSoon && (this._starveBail || 0) < 2) {
          this.log(`[clear] starving (food=${bot.food}) — pausing for food`);
          const hungerT0 = Date.now();
          let foundFood = false;
          while (bot.food != null && bot.food <= 8 && Date.now() - hungerT0 < 90000) {
            // a hostile in range turns the hunt into target practice — break
            // to the burrow check below, which seals first and eats after.
            // Exception: a flesh-dropper stalker IS the food — armed and able
            // to take a hit, melee it for rotten_flesh (+4 food → sprint
            // unlocks) instead of sheltering from the very thing we need.
            // Only a threat that can actually CATCH or hit a walking bot
            // cancels the food walk. A walk (4.3m/s) outruns zombies (2.3),
            // creepers (3.3), spiders-by-day (neutral), slimes, drowned —
            // burrowing from them just burns the 90s food window while the
            // basin stays food-less. Ranged mobs (arrows ignore kiting) and
            // night (spawn density) still force shelter.
            const p0 = bot.entity.position;
            if (hardThreat()) {
              const mobsNear = Object.values(bot.entities || {}).filter((e) => {
                if (!e?.position || e === bot.entity) return false;
                const n = String(e.name || e.displayName || "").toLowerCase();
                const hostile =
                  e.kind === "Hostile mobs" && e.name !== "enderman" ||
                  /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
                return hostile && e.position.distanceTo(p0) < 14;
              });
              // a fair fight only: one lone flesh-dropper, armed, enough hp to
              // eat ~4 zombie hits — hunting a pack at 1hp is how the starve
              // chain keeps dying (iron death @181,71,41)
              const fleshStalkers = mobsNear.filter((e) =>
                /^(zombie|husk|drowned)$/.test(String(e.name || e.displayName || "").toLowerCase())
              );
              const armed = bot.inventory.items().some((i) => /_(sword|axe)$/.test(i.name));
              if (fleshStalkers.length === 1 && mobsNear.length === 1 && armed && (bot.health ?? 20) > 12) {
                this.log(`[clear] starving — the stalker IS food (hunting it)`);
              } else {
                // a lone slow melee stalker can't catch a walking bot (zombie
                // 2.3 m/s vs walk 4.3) — kite it with a walk-away leg and keep
                // the food window running. Sheltering sealed→exited→same
                // zombie→sealed forever while food stayed 0 (grave-starve)
                const dayNow2 = (bot.time?.timeOfDay ?? 0) < 12541;
                const slowStalker =
                  dayNow2 &&
                  mobsNear.length === 1 &&
                  /^(zombie|husk|drowned|zombie_villager|slime)$/.test(
                    String(mobsNear[0].name || mobsNear[0].displayName || "").toLowerCase()
                  );
                if (slowStalker) {
                  const away = bot.entity.position.minus(mobsNear[0].position);
                  this.log(`[clear] starving — kiting lone ${mobsNear[0].name}, hunt continues`);
                  await executeAction(
                    bot,
                    {
                      type: "goto",
                      x: p0.x + Math.sign(away.x || 1) * 50,
                      y: p0.y,
                      z: p0.z + Math.sign(away.z || 1) * 50,
                      range: 4,
                      timeoutMs: 12000,
                    },
                    this.mcData
                  ).catch(() => {});
                } else {
                  this.log(`[clear] starving + hostile near — shelter before food`);
                  break;
                }
              }
            }
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
        const hostileNow = hostileNear || hostileClose();
        // In daylight a slow-melee mob can't catch a walking bot — only
        // ranged fire, a creeper near fuse range, or an actual surround
        // warrants stopping work to hide. Night keeps the unconditional
        // seal (spawn density beats walking).
        const daylight = !nightSoon && (bot.time?.timeOfDay ?? 0) < 12541;
        const needsShelter =
          nightSoon || (this.deaths > 0 && (daylight ? hardThreat() : hostileNow));
        if (
          surfacePhase &&
          needsShelter &&
          Date.now() - (this._lastBurrow || 0) > 120000
        ) {
          this.log(`[clear] burrow: night=${isNight} hostileNear=${hostileNow}`);
          // daylight escape beats hiding: a sprint clears the camp in ~4s a
          // leg while a hide costs ~90s and the mob is still there when you
          // leave. Burrow only when the escape genuinely fails (dense pack).
          // Only worth sprinting when there is a camp to escape — at dusk
          // with nothing nearby the flee resolves instantly and the loop
          // re-enters forever; go straight to sealing instead.
          if (!isNight && hostileClose() && bot.food > 6) {
            const pf0 = bot.entity.position;
            // inside a camp zone a 70m hop still lands inside it — widen the
            // ring by repeat deaths like the respawn flee does, so the escape
            // actually leaves the pack field
            const ring0 = 70 * Math.min(3, Math.max(1, (this.state._deathPts || []).length));
            const cz0 = this.state?.campZone;
            let escDirs;
            if (cz0 && Math.hypot(pf0.x - cz0.x, pf0.z - cz0.z) < 160) {
              // inside the pack field any ~70m cardinal still lands inside it
              // (the >120 filter passes a 137m landing) — straight 210m line
              // out of the camp center, guaranteed past the field edge
              const ax0 = pf0.x - cz0.x;
              const az0 = pf0.z - cz0.z;
              const n0 = Math.hypot(ax0, az0) || 1;
              escDirs = [[Math.round((ax0 / n0) * 210), Math.round((az0 / n0) * 210)]];
            } else {
              escDirs = [
                [ring0, 0],
                [-ring0, 0],
                [0, ring0],
                [0, -ring0],
              ];
              if (cz0) {
                const ok = escDirs.filter(([dx, dz]) => Math.hypot(pf0.x + dx - cz0.x, pf0.z + dz - cz0.z) > 150);
                if (ok.length) escDirs = ok;
                else {
                  // every cardinal lands inside the camp — straight line out
                  const ax0 = pf0.x - cz0.x;
                  const az0 = pf0.z - cz0.z;
                  const n0 = Math.max(Math.abs(ax0), Math.abs(az0)) || 1;
                  escDirs = [[Math.round((ax0 / n0) * ring0 * 2), Math.round((az0 / n0) * ring0 * 2)]];
                }
              }
            }
            // escaping toward a known resource site beats a bare heading:
            // nearest logSite/stash that also exits the camp zone
            const sites = [...(this.state?.logSites || []), this.state?.stash, ...stashLoadFile(bot)].filter(Boolean);
            if (sites.length) {
              let best = null;
              for (const s of sites) {
                const dx = s.x - pf0.x;
                const dz = s.z - pf0.z;
                const dist = Math.hypot(dx, dz);
                if (dist < 60) continue;
                if (cz0 && Math.hypot(s.x - cz0.x, s.z - cz0.z) < 150) continue;
                if (!best || dist < best.dist) best = { dist, dx, dz };
              }
              if (best) {
                const n = Math.max(Math.abs(best.dx), Math.abs(best.dz)) || 1;
                escDirs.unshift([Math.round((best.dx / n) * ring0 * 2), Math.round((best.dz / n) * ring0 * 2)]);
              }
            }
            const [ex0, ez0] = pickDryDir(bot, escDirs);
            this.log(`[clear] day escape sprint ${ex0},${ez0}`);
            await fleeUntilClear(ex0, ez0).catch(() => {});
            if (!hostileClose()) continue; // outran it — back to the step
            // one failed leg usually means the heading stalled on terrain or
            // a second pack — a rotated retry (~30s) still beats a ~3min hide
            // that just re-camps the pocket it exits from. Never pick the
            // reverse heading: running back crosses the pack we just left
            const esc2 = escDirs.filter(([dx, dz]) => (Math.abs(dx - ex0) > 1 || Math.abs(dz - ez0) > 1) && dx * ex0 + dz * ez0 >= 0);
            const [ex1, ez1] = pickDryDir(bot, esc2.length ? esc2 : escDirs);
            this.log(`[clear] day escape retry ${ex1},${ez1}`);
            await fleeUntilClear(ex1, ez1).catch(() => {});
            if (!hostileClose()) continue;
            // underground a "day-hide" is just re-camping the same cave: both
            // escape legs ran through tunnels into more of the pack. Climb for
            // daylight where escapes actually work — burrow only if that stalls
            const underground = (() => {
              try {
                return (bot.blockAt(bot.entity.position.floored())?.skyLight ?? 15) < 4;
              } catch {
                return false;
              }
            })();
            if (underground) {
              const p0 = bot.entity.position.floored();
              this.log(`[clear] cave camp — climbing for daylight`);
              await executeAction(
                bot,
                { type: "goto", x: p0.x, y: p0.y + 24, z: p0.z, range: 4, timeoutMs: 30000 },
                this.mcData
              ).catch(() => {});
              if (!hostileClose()) continue;
            }
            this.log(`[clear] escape failed — still camped, burrowing`);
          }
          // _lastBurrow stamps only on a real seal below — an abort mid-prep
          // (creeper closing) must not lock the retry out for 120s: the gate
          // skips, the starving step hot-spins "hunger" ~1/s until STUCK→/kill
          // (death #1 on speedrun6 was that cooldown, not a mob)
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
                return /zombie|creeper|spider|husk|vex|slime/.test(n);
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
            const woolHeld2 = bot.inventory.items().reduce((n, i) => n + (/(?:^|_)wool$/.test(i.name) ? i.count : 0), 0);
            const hasBedReady =
              bot.inventory.items().some((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name)) ||
              bot.findBlock({ matching: (b) => b && b.name.endsWith("_bed"), maxDistance: 12 }) ||
              (woolHeld2 >= 3 && meleeDist > 20);
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
            if (burrowed) this._lastBurrow = Date.now();
            // day-hide ends at ~90s whether or not the camper left (creepers
            // don't burn) — if it's still camped on us, sprint out of its
            // 14m reach instead of looping straight back into a burrow.
            // Same for a release inside a marked camp zone: safe() cleared
            // only means nothing was within 40m at that tick — campers drift
            // back in over the next ~30s while the step works beside the
            // pocket (the "dawn out → gather → dead in 37s" loop), so inside
            // the ring the escape leg runs first, aimed straight out of the
            // camp centroid
            const czDawn = this.state?.campZone;
            const inCampDawn = czDawn &&
              Math.hypot(bot.entity.position.x - czDawn.x, bot.entity.position.z - czDawn.z) < 150;
            // isNight is stale here — it was read before a ~10min burrow.
            // Fresh tod read: after a night burrow releases at dawn inside
            // the camp the day-flee must actually fire
            const todNow = bot.time?.timeOfDay;
            const dayNow = todNow != null && todNow < 12541;
            if (burrowed && dayNow && (hostileClose() || inCampDawn)) {
              let dawnDirs = [[70, 0], [-70, 0], [0, 70], [0, -70]];
              if (inCampDawn) {
                const axD = bot.entity.position.x - czDawn.x;
                const azD = bot.entity.position.z - czDawn.z;
                const nD = Math.hypot(axD, azD) || 1;
                dawnDirs = [[Math.round((axD / nD) * 210), Math.round((azD / nD) * 210)], ...dawnDirs];
              }
              const [fdx2, fdz2] = pickDryDir(bot, dawnDirs);
              this.log(`[clear] day-flee ${fdx2},${fdz2} — ${inCampDawn ? "inside camp zone" : "camper survived the hide"}`);
              // sustained sprint until the camper is beyond ~52m — a burst+goto
              // walks at ~4.3m/s and a tracking creeper stays in fuse range
              await fleeUntilClear(fdx2, fdz2, 10).catch(() => {});
            }
            // Night burrow gave up entirely (no diggable ground anywhere):
            // surface work in the dark is a death loop — keep looking for
            // shelter instead of falling through to the phase step.
            if (!burrowed && isNight) {
              // a melee camper aborts every prep attempt then just re-closes
              // during the sleep — sitting still is a fuse timer. Walking is
              // already faster than a creeper/zombie (~4.3 vs ~2.3 m/s) even
              // at food=0, so out-walk it for real separation before retrying
              const camperNow = Object.values(bot.entities || {})
                .filter((e) => {
                  if (!e?.position || e === bot.entity) return false;
                  const n = String(e.name || "").toLowerCase();
                  return /zombie|creeper|spider|husk|vex|slime/.test(n);
                })
                .sort(
                  (a, b) =>
                    a.position.distanceTo(bot.entity.position) -
                    b.position.distanceTo(bot.entity.position)
                )[0];
              if (camperNow && camperNow.position.distanceTo(bot.entity.position) < 26) {
                const away = bot.entity.position.minus(camperNow.position);
                const sdx = Math.sign(away.x || 1) * 70;
                const sdz = Math.sign(away.z || 1) * 70;
                this.log(`[clear] camper on the fuse — out-walking ${camperNow.name}`);
                await fleeUntilClear(sdx, sdz, 5).catch(() => {});
              } else {
                this.log(`[clear] no shelter — waiting out the night`);
                this._lastBurrow = 0;
                await sleep(15000);
              }
            }
          } catch (err) {
            this.log(`[clear] burrow fail: ${err?.message || err}`);
          } finally {
            bot._burrowActive = false;
          }
          // same hot-spin floor: a failed burrow on a dead socket returns
          // instantly, and a bare continue spins the loop flat-out
          await sleep(800);
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
        // opportunistic daytime spider pickup: 4 string crafts a wool — in a
        // basin with zero sheep, lone spiders are the only wool source. Only
        // take a lone one while armed and healthy enough to eat a pounce
        if (
          surfacePhase &&
          !nightSoon &&
          !hostileNear &&
          Date.now() - (this._lastSpider || 0) > 90000 &&
          !bot.inventory.items().some((i) => /_bed$/.test(i.name) && !/bedrock/.test(i.name))
        ) {
          const woolish =
            bot.inventory.items().reduce((n, i) => n + (/(?:^|_)wool$/.test(i.name) ? i.count : 0), 0) +
            Math.floor(countItem(bot, (i) => i.name === "string") / 4);
          const mobsHere = Object.values(bot.entities || {}).filter((e) => {
            if (!e?.position || e === bot.entity) return false;
            const n = String(e.name || "").toLowerCase();
            return (
              (e.kind === "Hostile mobs" && e.name !== "enderman" ||
                /zombie|skeleton|creeper|spider|husk|drowned|stray|slime|phantom|pillager|vex|witch/.test(n)) &&
              e.position.distanceTo(bot.entity.position) < 25
            );
          });
          const loneSpider =
            mobsHere.length === 1 && /spider/.test(String(mobsHere[0].name || "")) ? mobsHere[0] : null;
          const armed = bot.inventory.items().some((i) => /_(sword|axe)$/.test(i.name));
          if (woolish < 3 && loneSpider && armed && (bot.health ?? 20) > 12) {
            this._lastSpider = Date.now();
            this.log(`[clear] spider hunt — string is wool (${woolish}/3)`);
            await executeAction(
              bot,
              { type: "attack", name: "spider", maxDurationMs: 15000, maxDistance: 30, persistent: true },
              this.mcData
            ).catch(() => ({ ok: false }));
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
          // a bed is worth a walk — the passive 48m check almost never
          // fires mid-route, so hunt down the nearest sheep in sight
          const sheepNear = Object.values(bot.entities || {})
            .filter((e) => e?.position && e.name === "sheep")
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
            .find((e) => e.position.distanceTo(bot.entity.position) < 130);
          // sheep seen through solid rock while mining is unreachable —
          // the goto/pathing can't dig 30m up. Underground → skip the hunt.
          const sky = bot.blockAt(bot.entity.position.offset(0, 1, 0))?.skyLight;
          const underground = sky != null && sky < 14;
          if (woolHeld < 3 && sheepNear && !underground && sheepNear.position.distanceTo(bot.entity.position) > 24) {
            const sx = sheepNear.position.x;
            const sz = sheepNear.position.z;
            await executeAction(
              bot,
              { type: "goto", x: sx, y: sheepNear.position.y, z: sz, range: 8, timeoutMs: 30000 },
              this.mcData
            ).catch(() => {});
          }
          const bedNear = bot.findBlock({
            matching: (b) => b && (bot.isABed?.(b) || b.name.endsWith("_bed")),
            maxDistance: 12,
          });
          if ((woolHeld >= 3 && !underground) || (woolHeld < 3 && sheepNear && !underground)) {
            this._lastSheep = Date.now();
            this._note(woolHeld >= 3 ? "Шерсть есть — крафчу кровать." : "Овца! Кровать скоро будет — ночи проживу спокойно.");
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
        } else if (bot.food != null && bot.food <= 4) {
          // starving: the progression step descends for iron while ensureFed
          // climbs for surface — the gotos supersede each other and the bot
          // stalls at 1hp between them (the y~52 stall). The food run IS the
          // productive step until hunger clears.
          try {
            const fed = await ensureFed(bot, this.mcData, this.log, state);
            step = { ok: fed?.ok !== false, phase: phaseBefore, message: `food: ${fed?.message || "hunger"}` };
          } catch (err) {
            step = { ok: false, phase: phaseBefore, message: `food: ${err?.message || err}` };
          }
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
        if (samePhaseSteps >= stuckThresh) {
          // handing one step to the planner while a hostile is in range is how
          // the last deaths happened — Opus stands the bot still mid-thought
          // and a creeper closes the gap. Under a live threat the unstick is
          // a deterministic sprint burst instead; brain.step only when clear
          if (hardThreat()) {
            const foe = Object.values(bot.entities || {})
              .filter((e) => {
                if (!e?.position || e === bot.entity) return false;
                const n = String(e.name || "").toLowerCase();
                return e.kind === "Hostile mobs" || /zombie|skeleton|creeper|spider|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
              })
              .sort(
                (a, b) =>
                  a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
              )[0];
            if (foe) {
              const away = bot.entity.position.minus(foe.position);
              this.log(`[clear] STUCK + ${foe.name} — sprint unstick, no planner`);
              await sprintBurst(Math.sign(away.x || 1) * 40, Math.sign(away.z || 1) * 40, 2500).catch(() => {});
            } else {
              this.log("[clear] STUCK — threat flagged, no target; burrow next");
            }
          } else if (this.brain) {
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
