import mineflayer from "mineflayer";
import pkgPathfinder from "mineflayer-pathfinder";
import pkgCollectBlock from "mineflayer-collectblock";
import { ClearRunner } from "./src/clear.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const mcDataLoader = require("minecraft-data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bot = mineflayer.createBot({ host: "127.0.0.1", port: 25565, username: "ProbeBot", version: "1.21.1" });
bot.loadPlugin(pkgPathfinder.pathfinder);
bot.loadPlugin(pkgCollectBlock.plugin || pkgCollectBlock.default || pkgCollectBlock);
const log = (...a) => console.log("[probe]", ...a);

bot.once("spawn", async () => {
  const mcData = mcDataLoader(bot.version);
  bot.mcData = mcData;
  const moves = new pkgPathfinder.Movements(bot, mcData);
  bot.pathfinder.setMovements(moves);
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    if (String(bot.game?.dimension || "").endsWith("the_end")) {
      log("in the_end — starting ClearRunner");
      const runner = new ClearRunner({
        bot, cfg: { clear: { maxMs: 120000 } }, mcData, log,
        onMilestone: (t) => log(`MILESTONE: ${t}`),
      });
      await runner.start(["dragon"]);
      for (let k = 0; k < 90; k++) {
        await sleep(1500);
        const s = runner.status();
        log(`k=${k} running=${s.running} phase=${s.phase} credits=${s.credits} dim=${bot.game?.dimension} pos=${bot.entity.position.floored()}`);
        if (!runner.running) {
          log(`DONE credits=${s.credits} done=${JSON.stringify(s.objectivesDone)}`);
          process.exit(s.credits ? 0 : 1);
        }
      }
      runner.stop();
      process.exit(1);
    }
  }
  process.exit(1);
});
bot.on("error", (e) => log("ERR", e.message));
bot.on("end", () => process.exit(2));
