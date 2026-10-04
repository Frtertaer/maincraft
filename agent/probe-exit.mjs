import mineflayer from "mineflayer";
import pkgPathfinder from "mineflayer-pathfinder";
import pkgCollectBlock from "mineflayer-collectblock";
import { progressionStep, detectPhase } from "./src/progression.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mcDataLoader = require("minecraft-data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bot = mineflayer.createBot({ host: "127.0.0.1", port: 25565, username: "ProbeBot", version: "1.21.1" });
bot.loadPlugin(pkgPathfinder.pathfinder);
bot.loadPlugin(pkgCollectBlock.plugin || pkgCollectBlock.default || pkgCollectBlock);
const log = (...a) => console.log("[probe]", ...a);
const state = { phase: "?", boss: { allowStickTp: false }, steps: 0 };
let mcData = null;

bot.once("spawn", async () => {
  mcData = mcDataLoader(bot.version);
  bot.mcData = mcData;
  const { Movements } = pkgPathfinder;
  const moves = new Movements(bot, mcData);
  bot.pathfinder.setMovements(moves);
  for (let i = 0; i < 90; i++) {
    await sleep(400);
    if (String(bot.game?.dimension || "").endsWith("the_end")) {
      log("in the_end — running clear phase");
      for (let k = 0; k < 90; k++) {
        const dim = String(bot.game?.dimension || "");
        if (!/end/i.test(dim)) {
          log(`SUCCESS — respawned to ${dim} at ${bot.entity.position} — CREDITS WATCHED`);
          process.exit(0);
        }
        const phase = detectPhase(bot);
        const r = await progressionStep(bot, mcData, state, log);
        log(`k=${k} phase=${phase} -> ok=${r.ok} msg=${r.message} pos=${bot.entity.position.floored()}`);
        await sleep(1200);
      }
      log("timeout in the_end");
      process.exit(1);
    }
  }
  log("never got to the_end");
  process.exit(1);
});
bot.on("error", (e) => log("ERR", e.message));
bot.on("end", () => { log("bot ended"); process.exit(2); });
