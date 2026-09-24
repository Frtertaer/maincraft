// Micro-probe 2: jump + placeBlock tower mechanics in isolation.
import mineflayer from "mineflayer";
import pkgPathfinder from "mineflayer-pathfinder";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { setupMovements } from "./actions.js";
import { loadConfig } from "./config.js";

const pathfinder = pkgPathfinder.pathfinder || pkgPathfinder.default || pkgPathfinder;
const cfg = loadConfig();
const bot = mineflayer.createBot({
  host: cfg.minecraft.host,
  port: cfg.minecraft.port,
  username: "OpusBot",
  auth: cfg.minecraft.auth || "offline",
  version: cfg.minecraft.version === "auto" ? false : cfg.minecraft.version,
});
bot.loadPlugin(pathfinder);
await new Promise((res, rej) => {
  bot.once("spawn", res);
  bot.once("error", rej);
  setTimeout(() => rej(new Error("spawn timeout")), 30000);
});
const mcData = minecraftData(bot.version);
setupMovements(bot, mcData);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chat = (c) => new Promise((r) => { bot.chat(c); setTimeout(r, 250); });
await chat("/gamemode survival @s");
// clear old towers from previous bench runs first
await chat("/fill 255 80 -65 265 110 -55 air");
await chat("/tp @s 260 80 -60");
await chat("/give @s dirt 64");
await sleep(800);
const p = bot.entity.position;
console.log("pos:", p.x.toFixed(2), p.y.toFixed(4), p.z.toFixed(2));
const fb = bot.blockAt(p);
const ab = bot.blockAt(p.offset(0, 0.35, 0));
const un = bot.blockAt(p.offset(0, -0.7, 0));
console.log("feetBlock:", fb?.name, fb?.position);
console.log("aboveFeet:", ab?.name, ab?.position);
console.log("under(-0.7):", un?.name, un?.position);
console.log("dirt:", bot.inventory.items().filter((i) => i.name === "dirt").map((i) => i.count));

// 1) does jump rise?
const y0 = bot.entity.position.y;
bot.setControlState("jump", true);
for (let i = 0; i < 14; i++) {
  await sleep(55);
  if (bot.entity.position.y - y0 >= 0.95) break;
}
console.log("jump rise:", (bot.entity.position.y - y0).toFixed(2));
bot.setControlState("jump", false);
await sleep(800);

// 2) does placeBlock under feet work?
const dirt = bot.inventory.items().find((i) => i.name === "dirt");
await bot.equip(dirt, "hand");
const under = bot.blockAt(bot.entity.position.offset(0, -0.7, 0));
console.log("under:", under?.name, under?.position);
try {
  await bot.lookAt(under.position.offset(0.5, 1, 0.5), true);
  bot.setControlState("jump", true);
  const y1 = bot.entity.position.y;
  for (let i = 0; i < 14; i++) {
    await sleep(55);
    if (bot.entity.position.y - y1 >= 0.95) break;
  }
  console.log("pre-place rise:", (bot.entity.position.y - y1).toFixed(2));
  await bot.placeBlock(under, new Vec3(0, 1, 0));
  console.log("PLACE OK — new y:", bot.entity.position.y.toFixed(2));
} catch (err) {
  console.log("PLACE FAIL:", err?.message || err);
}
bot.setControlState("jump", false);
process.exit(0);
