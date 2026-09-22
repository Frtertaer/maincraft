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
import { progressionStep, detectPhase, countItem, PHASES, bossObjectiveStep, BOSS_OBJECTIVES } from "./progression.js";

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
      this._note(`Я погиб (смерть #${this.deaths}) — фаза ${this.state?.phase}`);
    };
    this._respawnHandler = () => {
      try {
        this._note(`Возродился. Фаза: ${detectPhase(this.bot)}`);
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

    try {
      while (this.running && bot.entity && Date.now() - state.t0 < this.maxMs) {
        state.boss.allowStickTp = false;
        const phaseBefore = detectPhase(bot);
        let step = { ok: false, phase: phaseBefore, message: "no step" };

        const dragonDone =
          state.objectivesDone.includes("dragon") ||
          state.milestones.some((m) => m.milestone === "CLEAR") ||
          state.phase === "clear";
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

        if (phaseAfter === "clear" || step.milestone === "CLEAR") {
          if (!state.objectivesDone.includes("dragon")) state.objectivesDone.push("dragon");
          if (!this.objectives.some((o) => o !== "dragon" && !state.objectivesDone.includes(o))) {
            this._note("ДРАКОН ПОВЕРЖЕН — игра пройдена!");
            break;
          }
          this._note(`Дракон повержен! Эпилог: ${this.objectives.filter((o) => o !== "dragon").join(", ")}`);
        }
        if (this.objectives.every((o) => state.objectivesDone.includes(o))) {
          this._note("ВСЕ ЦЕЛИ ВЫПОЛНЕНЫ — полное прохождение!");
          break;
        }
        const dim = String(bot.game?.dimension || "");
        if (/end/i.test(dim)) {
          const dragon = Object.values(bot.entities).find((e) => /dragon/i.test(String(e?.name || "")));
          if (!dragon && (state.boss?.hits || 0) > 5) {
            this._note("ДРАКОН ПОВЕРЖЕН — игра пройдена!");
            state.milestones.push({ t: Date.now() - state.t0, milestone: "CLEAR", phase: "clear" });
            break;
          }
        }

        const stuckThresh = phaseAfter === "diamond" || phaseAfter === "portal" || phaseAfter === "nether" ? 20 : 12;
        if (samePhaseSteps >= stuckThresh && this.brain) {
          this.log("[clear] STUCK — brain.step()");
          try {
            this.brain.resume();
            await this.brain.step();
          } catch (err) {
            this.log(`[clear] brain step fail: ${err?.message || err}`);
          }
          samePhaseSteps = 0;
          await sleep(1500);
        }

        const pace = phaseAfter === "wood" || phaseAfter === "stone" ? 1200 : 800;
        await sleep(pace);
      }
    } finally {
      this.running = false;
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
