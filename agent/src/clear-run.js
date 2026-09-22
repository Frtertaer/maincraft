/**
 * Fair survival clear attempt: spawn → ender dragon without /give boss kits.
 * Hybrid: deterministic progression + combat-reflex + Opus fallback when stuck.
 *
 *   npm run clear-run
 *   CLEAR_MAX_MS=7200000 npm run clear-run   # 2h default
 */
import fs from "fs";
import path from "path";
import mineflayer from "mineflayer";
import pkgPathfinder from "mineflayer-pathfinder";
import pkgCollect from "mineflayer-collectblock";
import pkgTool from "mineflayer-tool";
import minecraftData from "minecraft-data";
import { fileURLToPath } from "url";
import { loadConfig } from "./config.js";
import { setupMovements } from "./actions.js";
import { CombatReflex } from "./combat-reflex.js";
import { LlmClient } from "./llm.js";
import { Brain } from "./brain.js";
import { progressionStep, detectPhase, countItem, PHASES } from "./progression.js";

const pathfinder = pkgPathfinder.pathfinder || pkgPathfinder.default?.pathfinder || pkgPathfinder;
const collectPlugin = pkgCollect.plugin || pkgCollect.default?.plugin || pkgCollect.default || pkgCollect;
const toolPlugin = pkgTool.plugin || pkgTool.default?.plugin || pkgTool.default || pkgTool;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.resolve(__dirname, "../../logs/clear-run.log");
const RESULT_PATH = path.resolve(__dirname, "../../logs/CLEAR_RUN_RESULT.md");
const MAX_MS = Number(process.env.CLEAR_MAX_MS || 120 * 60 * 1000); // 120 min default

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* ignore */
  }
}

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
  // tools
  out.bestPick = bot.inventory.items().find((i) => i.name.includes("pickaxe"))?.name || null;
  out.bestSword = bot.inventory.items().find((i) => i.name.includes("sword"))?.name || null;
  out.dim = bot.game?.dimension || "?";
  out.hp = bot.health;
  out.food = bot.food;
  out.pos = bot.entity
    ? `${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)}`
    : null;
  return out;
}

async function main() {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, "");
  } catch {
    /* ignore */
  }

  const cfg = loadConfig();
  cfg.agent.mode = "auto";
  cfg.agent.tickMs = Math.max(cfg.agent.tickMs || 3000, 5000); // slower Opus — skills do heavy work
  cfg.combat = {
    ...cfg.combat,
    enabled: true,
    mode: "auto",
    autoEngageHostiles: true,
    allowPlayers: false,
    engageDistance: 20,
    maxDistance: 48,
  };

  log(`CLEAR_RUN start maxMs=${MAX_MS}`);
  const bot = mineflayer.createBot({
    host: cfg.minecraft.host,
    port: cfg.minecraft.port,
    username: cfg.minecraft.username || "OpusBot",
    auth: cfg.minecraft.auth || "offline",
    version: cfg.minecraft.version === "auto" ? false : cfg.minecraft.version,
  });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectPlugin);
  bot.loadPlugin(toolPlugin);

  await new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    bot.once("error", reject);
    setTimeout(() => reject(new Error("spawn timeout")), 60000);
  });

  const mcData = minecraftData(bot.version);
  setupMovements(bot, mcData);
  log(`spawn ${bot.entity.position} ver=${bot.version} dim=${bot.game?.dimension}`);

  const combat = new CombatReflex({ bot, cfg, log });
  combat.setMode("auto");
  combat.start();

  // Opus as advisor / unstucker — optional if API works
  let brain = null;
  let llmOk = false;
  try {
    const llm = new LlmClient(cfg);
    await llm.whoami();
    llmOk = true;
    brain = new Brain({ bot, llm, cfg, mcData, log });
    brain.setMode("auto");
    brain.setGoal(
      "Пройди Minecraft: железо, портал, ад, крепость, стержни, жемчуг, глаза, крепость, Энд, убей дракона. Выживай."
    );
    brain.combat = combat;
    // Don't start brain auto-loop full speed — we call step when stuck
    log("API ready — Opus assist on stuck");
  } catch (err) {
    log(`API unavailable, pure progression skills: ${err?.message || err}`);
  }

  const state = { phase: "wood", milestones: [], boss: { allowStickTp: false }, combat };
  const t0 = Date.now();
  let lastMilestone = null;
  let stuck = 0;
  let lastPhase = null;
  let samePhaseSteps = 0;
  let deaths = 0;

  bot.on("death", () => {
    deaths += 1;
    log(`DEATH #${deaths} phase=${state.phase}`);
  });

  bot.on("respawn", () => {
    log(`RESPAWN phase=${detectPhase(bot)}`);
  });

  while (Date.now() - t0 < MAX_MS) {
    if (!bot.entity) {
      await sleep(1000);
      continue;
    }

    // fair: no stick tp
    state.boss = state.boss || {};
    state.boss.allowStickTp = false;

    const phaseBefore = detectPhase(bot);
    let step = { ok: false, phase: phaseBefore, message: "no step" };
    try {
      step = await progressionStep(bot, mcData, state, log);
    } catch (err) {
      step = { ok: false, phase: phaseBefore, message: `crash: ${err?.message || err}` };
      log(`STEP_CRASH ${step.message}`);
    }
    const phaseAfter = detectPhase(bot);

    if (step.milestone && step.milestone !== lastMilestone) {
      lastMilestone = step.milestone;
      state.milestones.push({ t: Date.now() - t0, milestone: step.milestone, phase: phaseAfter });
      log(`MILESTONE ${step.milestone} phase=${phaseAfter} inv=${JSON.stringify(inventorySnapshot(bot))}`);
    }

    if (phaseAfter === lastPhase) samePhaseSteps += 1;
    else {
      samePhaseSteps = 0;
      lastPhase = phaseAfter;
    }

    log(
      `step=${state.steps} phase=${phaseAfter} ok=${step.ok} msg=${step.message} stuck=${samePhaseSteps} deaths=${deaths}`
    );

    if (phaseAfter === "clear" || step.milestone === "CLEAR") {
      log("CLEAR ACHIEVED");
      break;
    }

    // dragon dead check
    const dim = String(bot.game?.dimension || "");
    if (/end/i.test(dim)) {
      const dragon = Object.values(bot.entities).find((e) => /dragon/i.test(String(e?.name || "")));
      if (!dragon && (state.boss?.hits || 0) > 5) {
        log("CLEAR — dragon entity gone after hits");
        state.milestones.push({ t: Date.now() - t0, milestone: "CLEAR", phase: "clear" });
        break;
      }
    }

    // stuck → Opus one step (rate-limit; diamond strip can legitimately take many steps)
    const stuckThresh = phaseAfter === "diamond" || phaseAfter === "portal" || phaseAfter === "nether" ? 20 : 12;
    if (samePhaseSteps >= stuckThresh && brain && llmOk) {
      log("STUCK — Opus brain.step()");
      try {
        brain.resume();
        await brain.step();
      } catch (err) {
        log(`Opus step fail: ${err?.message || err}`);
      }
      samePhaseSteps = 0;
      await sleep(1500);
    }

    // pace: give GC / pathfinder breathing room (was OOM ~4GB on thrash)
    const pace = phaseAfter === "wood" || phaseAfter === "stone" ? 1200 : 800;
    await sleep(pace);
  }

  combat.stop();
  const elapsed = Date.now() - t0;
  const finalPhase = bot.entity ? detectPhase(bot) : "dead";
  const inv = bot.entity ? inventorySnapshot(bot) : {};
  const clear = state.milestones.some((m) => m.milestone === "CLEAR") || finalPhase === "clear";

  const summary = {
    clear,
    elapsedMs: elapsed,
    elapsedMin: Number((elapsed / 60000).toFixed(1)),
    finalPhase,
    deaths,
    milestones: state.milestones,
    inventory: inv,
    combat: combat.getStats(),
    boss: state.boss,
    llmOk,
    phaseOrder: PHASES,
  };

  const md = `# Clear run result

- **clear**: ${clear}
- **elapsed**: ${summary.elapsedMin} min
- **finalPhase**: ${finalPhase}
- **deaths**: ${deaths}
- **llmOk**: ${llmOk}

## Milestones
${state.milestones.map((m) => `- +${(m.t / 60000).toFixed(1)}m **${m.milestone}** (${m.phase})`).join("\n") || "_none_"}

## Inventory snapshot
\`\`\`json
${JSON.stringify(inv, null, 2)}
\`\`\`

## Note
Fair run: no /give gear, no stickTp. Hybrid progression skills + combat + optional Opus unstuck.
`;

  fs.writeFileSync(RESULT_PATH, md);
  console.log("=== CLEAR_RUN_JSON ===");
  console.log(JSON.stringify(summary, null, 2));
  log(`written ${RESULT_PATH} clear=${clear}`);

  try {
    bot.quit("clear-run end");
  } catch {
    /* ignore */
  }
  process.exit(clear ? 0 : 2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("CLEAR_RUN_FAIL", e);
  process.exit(1);
});
