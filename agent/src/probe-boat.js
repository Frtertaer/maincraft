// Probe: which call actually spawns a boat entity on Paper 1.21.1.
"use strict";
const mineflayer = require("mineflayer");
const Vec3 = require("vec3").Vec3;

const bot = mineflayer.createBot({
  host: "127.0.0.1",
  port: 25565,
  username: "BoatProbe",
  version: "1.21.1",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boats = () =>
  Object.values(bot.entities).filter(
    (e) => e.name === "boat" || e.name === "chest_boat"
  ).length;

bot.once("spawn", async () => {
  await sleep(1500);
  const give = (c) => bot.chat(c);
  give("give @s oak_boat 4");
  await sleep(800);
  const boat = bot.inventory.items().find((i) => /boat/.test(i.name));
  console.log("boat item:", boat?.name);
  const p = bot.entity.position.floored();
  // stand flat, aim at ground 2m ahead
  const target = new Vec3(p.x + 2.5, p.y, p.z + 0.5);
  await bot.equip(boat, "hand");
  await bot.lookAt(target, true);
  await sleep(300);
  console.log("before activateItem boats=", boats());
  bot.activateItem();
  await sleep(700);
  console.log("after activateItem boats=", boats());
  // try activateBlock on the block under the target
  const ground = bot.blockAt(new Vec3(p.x + 2, p.y - 1, p.z));
  console.log("ground:", ground?.name, ground?.position);
  await bot.lookAt(target, true);
  await sleep(200);
  try {
    await bot.activateBlock(ground);
  } catch (e) {
    console.log("activateBlock err:", e.message);
  }
  await sleep(700);
  console.log("after activateBlock boats=", boats());
  // try useOn on top face
  try {
    await bot.useOn(ground);
  } catch (e) {
    console.log("useOn err:", e.message);
  }
  await sleep(700);
  console.log("after useOn boats=", boats());
  bot.quit();
  process.exit(0);
});
bot.on("error", (e) => console.log("bot error:", e.message));
setTimeout(() => process.exit(2), 40000);
