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
import { progressionStep, detectPhase, countItem, PHASES, bossObjectiveStep, BOSS_OBJECTIVES, burrowForNight, pickDryDir, punchNearbyLogs, ensureBedAndSleep, ensureFed, stashDeposit, stashRecover } from "./progression.js";
import { executeAction } from "./actions.js";

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
    };
    this._deathHandler = () => {
      this.deaths += 1;
      this.state._diedAt = Date.now();
      const killer = this.combat?.getStats?.().lastTarget || "";
      const p = this.bot.entity?.position;
      const at = p ? ` @${p.x | 0},${p.y | 0},${p.z | 0}` : "";
      this._note(`Я погиб (смерть #${this.deaths}) — фаза ${this.state?.phase}${killer ? ` [${killer}]` : ""}${at}`);
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
        // sprintBurst: control-state movement starts in <100ms — pathfinder
        // goto needs ~1s to spin up, and skeletons lead shots on standing
        // targets. 1.5s of sprint+zigzag buys distance before planning.
        const sprintBurst = async (fdx, fdz, ms = 1500) => {
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
            bot.setControlState("jump", false);
            bot.setControlState("forward", false);
            bot.setControlState("sprint", false);
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
          if (isNight) {
            this.log(`[clear] night respawn — flee then burrow`);
            // sprint away FIRST — digging a pocket takes ~10s bare-handed and
            // a mob standing over the respawn kills us mid-dig (spawn-camp loop)
            const pf = bot.entity.position;
            const fleeDirs = [
              [70, 0],
              [-70, 0],
              [0, 70],
              [0, -70],
            ];
            const [fdx, fdz] = pickDryDir(bot, fleeDirs);
            this.log(`[clear] night flee ${fdx},${fdz} after death #${this.deaths}`);
            await sprintBurst(fdx, fdz).catch(() => {});
            try {
              await executeAction(
                bot,
                { type: "goto", x: pf.x + fdx, y: pf.y, z: pf.z + fdz, range: 8, timeoutMs: 40000 },
                this.mcData
              );
            } catch {
              /* superseded — burrow anyway */
            }
            try {
              // bare-handed on stone ground the burrow can't dig — punch a
              // few logs first so planks exist for the pillar fallback
              await punchNearbyLogs(bot, this.mcData, 4);
            } catch {
              /* no tree in reach — burrow anyway */
            }
            try {
              // bed beats burrow: sheep are everywhere near spawn and a
              // slept night skips the whole exposure window
              const slept = await ensureBedAndSleep(bot, this.mcData, this.log, this.state);
              if (slept.ok) this.log(`[clear] ${slept.message}`);
              else await burrowForNight(bot, this.mcData, this.log);
            } catch (err) {
              this.log(`[clear] burrow fail: ${err?.message || err}`);
            }
          } else {
            // day respawn: a camper (usually a skeleton in shade/water) can
            // out-range any sprint — flee, then hide in a sealed pocket until
            // it wanders off (the burrow wait is hostile-proximity based)
            const pf = bot.entity.position;
            const fleeDirs = [
              [70, 0],
              [-70, 0],
              [0, 70],
              [0, -70],
            ];
            const [fdx, fdz] = pickDryDir(bot, fleeDirs);
            this.log(`[clear] day flee ${fdx},${fdz} after death #${this.deaths}`);
            await sprintBurst(fdx, fdz).catch(() => {});
            try {
              await executeAction(
                bot,
                { type: "goto", x: pf.x + fdx, y: pf.y, z: pf.z + fdz, range: 8, timeoutMs: 40000 },
                this.mcData
              );
            } catch {
              /* superseded — burrow anyway */
            }
            try {
              await burrowForNight(bot, this.mcData, this.log, true);
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
        if (bot.food != null && bot.food < 14 && Date.now() - (this._lastFood || 0) > 25000) {
          this._lastFood = Date.now();
          try {
            const fed = await ensureFed(bot, this.mcData, this.log, this.state);
            if (fed?.ate) this.log(`[clear] ate (food=${bot.food})`);
          } catch {
            /* food err — continue */
          }
        }
        // Survival for surface phases: burrow at night (mobs will come), and
        // also in daylight when a hostile is camped nearby and the run has
        // died before — creepers/spiders don't burn at dawn.
        const surfacePhase = ["wood", "stone", "iron"].includes(detectPhase(bot));
        const hostileNear = Object.values(bot.entities || {}).some((e) => {
          if (!e?.position || e === bot.entity) return false;
          const n = String(e.name || e.displayName || "").toLowerCase();
          const hostile = e.kind === "Hostile mobs" || /zombie|skeleton|creeper|spider|enderman|witch|husk|drowned|stray|slime|phantom|pillager|vex/.test(n);
          return hostile && e.position.distanceTo(bot.entity.position) < 14;
        });
        if (
          surfacePhase &&
          (nightSoon || (hostileNear && this.deaths > 0)) &&
          Date.now() - (this._lastBurrow || 0) > 120000
        ) {
          this._lastBurrow = Date.now();
          this.log(`[clear] burrow: night=${isNight} hostileNear=${hostileNear}`);
          try {
            // bed first on real nights — a slept night is ~30s of exposure
            // vs ~9.5min sealed; burrow remains the fallback. In daylight it
            // still places+activates a bed to claim the spawn point — after
            // one respawn-at-camp the bed is the only permanent fix.
            let burrowed = false;
            const slept = await ensureBedAndSleep(bot, this.mcData, this.log, this.state);
            if (slept.ok) {
              this.log(`[clear] ${slept.message}`);
              burrowed = true; // night is over — treat as sheltered
            }
            // force=true for the daytime variant — a hostile is camped on us
            // and the wait-until-safe logic is exactly what we need anyway
            if (!burrowed) burrowed = await burrowForNight(bot, this.mcData, this.log, !isNight);
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
