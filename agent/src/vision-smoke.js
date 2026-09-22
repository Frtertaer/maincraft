/**
 * Live vision smoke: join Paper, render POV JPEG, write metrics, quit.
 *   node src/vision-smoke.js
 *   MAINCRAFT_CONFIG=config.companion.json node src/vision-smoke.js
 */
import fs from "fs";
import path from "path";
import mineflayer from "mineflayer";
import pkgPathfinder from "mineflayer-pathfinder";
import { fileURLToPath } from "url";
import { loadConfig } from "./config.js";
import { createVisionProvider } from "./vision.js";
import { setupMovements } from "./actions.js";
import minecraftData from "minecraft-data";

const pathfinder = pkgPathfinder.pathfinder || pkgPathfinder.default?.pathfinder || pkgPathfinder;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULT = path.resolve(__dirname, "../../logs/VISION_SMOKE_RESULT.md");

function log(...a) {
  console.log(`[vision-smoke]`, ...a);
}

async function main() {
  const cfg = loadConfig();
  // force vision on for this smoke regardless of config drift
  cfg.vision.enabled = true;
  cfg.vision.source = "viewer";
  cfg.vision.saveDebugFrame = true;

  const bot = mineflayer.createBot({
    host: cfg.minecraft.host,
    port: cfg.minecraft.port,
    username: cfg.minecraft.username || "VisionSmoke",
    auth: cfg.minecraft.auth || "offline",
    version: cfg.minecraft.version === "auto" ? false : cfg.minecraft.version,
  });
  bot.loadPlugin(pathfinder);

  const lines = [];
  const push = (s) => {
    lines.push(s);
    log(s);
  };

  await new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    bot.once("error", reject);
    setTimeout(() => reject(new Error("spawn timeout 60s")), 60000);
  });

  const mcData = minecraftData(bot.version);
  setupMovements(bot, mcData);
  push(`spawn ok ver=${bot.version} pos=${bot.entity.position} dim=${bot.game?.dimension}`);

  // let chunks load
  await sleep(2500);

  const vision = createVisionProvider(cfg, log);
  vision.setBot(bot);

  const t0 = Date.now();
  let b64 = null;
  let err = null;
  try {
    b64 = await vision.getFrame();
  } catch (e) {
    err = e?.message || String(e);
  }
  const ms = Date.now() - t0;

  const framePath = cfg.vision.capturePath;
  const exists = fs.existsSync(framePath);
  const size = exists ? fs.statSync(framePath).size : 0;
  const isJpeg =
    exists &&
    (() => {
      const buf = fs.readFileSync(framePath);
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    })();

  push(`getFrame ms=${ms} b64_len=${b64 ? b64.length : 0} err=${err || "null"}`);
  push(`debug_file=${framePath} exists=${exists} size=${size} jpeg=${isJpeg}`);

  // second frame (stability)
  await sleep(500);
  const t1 = Date.now();
  let b64b = null;
  try {
    b64b = await vision.getFrame();
  } catch (e) {
    push(`second frame fail: ${e?.message || e}`);
  }
  push(`second_frame ms=${Date.now() - t1} b64_len=${b64b ? b64b.length : 0}`);

  const ok = Boolean(b64 && b64.length > 500 && isJpeg && size > 500);
  const md = `# Vision smoke result

- **ok**: ${ok}
- **ms**: ${ms}
- **b64_len**: ${b64 ? b64.length : 0}
- **file**: \`${framePath}\`
- **file_size**: ${size}
- **jpeg_magic**: ${isJpeg}
- **error**: ${err || "_none_"}
- **version**: ${bot.version}
- **pos**: ${bot.entity?.position}

## Log
${lines.map((l) => `- ${l}`).join("\n")}

## Note
source=viewer (in-process raycast POV). Not desktop capture.
`;
  fs.mkdirSync(path.dirname(RESULT), { recursive: true });
  fs.writeFileSync(RESULT, md);
  push(`written ${RESULT} ok=${ok}`);

  try {
    bot.quit("vision-smoke end");
  } catch {
    /* ignore */
  }
  process.exit(ok ? 0 : 2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("VISION_SMOKE_FAIL", e);
  process.exit(1);
});
