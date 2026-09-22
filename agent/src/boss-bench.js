/**
 * Boss kill bench: Warden / Wither / Ender Dragon × iron|diamond kits.
 * Requires Paper 127.0.0.1:25565, OpusBot op'd.
 *
 *   node src/boss-bench.js
 */
import mineflayer from "mineflayer";
import pkgPathfinder from "mineflayer-pathfinder";
import pkgTool from "mineflayer-tool";
import minecraftData from "minecraft-data";
import { loadConfig } from "./config.js";
import { setupMovements } from "./actions.js";
import { CombatReflex } from "./combat-reflex.js";

const pathfinder = pkgPathfinder.pathfinder || pkgPathfinder.default?.pathfinder || pkgPathfinder;
const toolPlugin = pkgTool.plugin || pkgTool.default?.plugin || pkgTool.default || pkgTool;

const BOSSES = (process.env.BOSS_ONLY || "wither,warden,ender_dragon").split(",").map((s) => s.trim());
const KITS = (process.env.BOSS_KITS || "diamond,iron").split(",").map((s) => s.trim());
const TIMEOUT_MS = {
  wither: 300000,
  warden: 300000,
  ender_dragon: 300000,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}
async function cmd(bot, c) {
  bot.chat(c.startsWith("/") ? c : `/${c}`);
  await sleep(180);
}

function kitGives(kit) {
  const mat = kit === "iron" ? "iron" : "diamond";
  // 1.21 component enchants where possible + plain fallbacks
  return [
    `give @s ${mat}_sword 1`,
    `give @s ${mat}_axe 1`,
    `give @s ${mat}_helmet 1`,
    `give @s ${mat}_chestplate 1`,
    `give @s ${mat}_leggings 1`,
    `give @s ${mat}_boots 1`,
    "give @s shield 1",
    // plain items only — component NBT breaks mineflayer 1.21 slot parser
    "give @s bow 1",
    "give @s arrow 256",
    "give @s cooked_beef 64",
    "give @s golden_apple 64",
    "give @s enchanted_golden_apple 4",
    "give @s totem_of_undying 5",
    "give @s white_bed 32",
    "give @s red_bed 16",
    "give @s dirt 128",
    "give @s cobblestone 128",
    "give @s water_bucket 2",
    "give @s ender_pearl 16",
    "give @s snowball 64",
    `item replace entity @s armor.head with ${mat}_helmet`,
    `item replace entity @s armor.chest with ${mat}_chestplate`,
    `item replace entity @s armor.legs with ${mat}_leggings`,
    `item replace entity @s armor.feet with ${mat}_boots`,
    `item replace entity @s weapon.mainhand with ${mat}_sword`,
    "item replace entity @s weapon.offhand with shield",
  ];
}

async function equipKit(bot, kit) {
  for (const g of kitGives(kit)) await cmd(bot, g);
  await cmd(bot, "effect clear @s");
  await cmd(bot, "effect give @s instant_health 1 40");
  await cmd(bot, "effect give @s saturation 1 40");
  await cmd(bot, "effect give @s resistance 120 3");
  await cmd(bot, "effect give @s fire_resistance 120 0");
  await cmd(bot, "effect give @s strength 120 1");
  await cmd(bot, "effect give @s absorption 120 3");
  await cmd(bot, "effect give @s regeneration 30 1");
  await sleep(800);
}

function findBoss(bot, type) {
  return Object.values(bot.entities).find((e) => {
    if (!e || e === bot.entity) return false;
    const n = String(e.name || e.displayName || "")
      .toLowerCase()
      .replaceAll(" ", "_")
      .replace("minecraft:", "");
    return n === type;
  });
}

async function main() {
  const cfg = loadConfig();
  cfg.combat = {
    ...cfg.combat,
    enabled: true,
    mode: "auto",
    intervalMs: 40,
    engageDistance: 64,
    maxDistance: 96,
    autoEngageHostiles: true,
  };

  const bot = mineflayer.createBot({
    host: cfg.minecraft.host,
    port: cfg.minecraft.port,
    username: cfg.minecraft.username,
    auth: cfg.minecraft.auth || "offline",
    version: cfg.minecraft.version === "auto" ? false : cfg.minecraft.version,
  });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(toolPlugin);
  try {
    bot.setMaxListeners?.(50);
    bot._client?.setMaxListeners?.(50);
  } catch {
    /* ignore */
  }

  await new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    bot.once("error", reject);
    setTimeout(() => reject(new Error("spawn timeout")), 45000);
  });

  const mcData = minecraftData(bot.version);
  setupMovements(bot, mcData);
  log(`spawn ${bot.entity.position} ${bot.version}`);

  await cmd(bot, "gamemode survival");
  await cmd(bot, "difficulty hard");
  await cmd(bot, "gamerule doMobSpawning false");
  await cmd(bot, "gamerule keepInventory true");
  await cmd(bot, "gamerule doImmediateRespawn true");

  const combat = new CombatReflex({ bot, cfg, log });
  combat.setMode("auto");
  combat.start();

  const results = [];

  for (const kit of KITS) {
    for (const boss of BOSSES) {
      log(`=== ${kit} vs ${boss} ===`);
      await cmd(bot, "kill @e[type=!player]");
      // fresh boss state so hit counters are per-fight
      combat._bossState = {};
      await sleep(400);

      // Dimension / arena setup
      if (boss === "ender_dragon") {
        await cmd(bot, "execute in minecraft:the_end run tp @s 0 90 0");
        // wait until client actually enters the end
        for (let i = 0; i < 40; i++) {
          await sleep(250);
          const dim = String(bot.game?.dimension || "");
          if (/end/i.test(dim)) break;
          await cmd(bot, "execute in minecraft:the_end run tp @s 0 90 0");
        }
        log(`dim=${bot.game?.dimension} pos=${bot.entity.position}`);
        await cmd(bot, "kill @e[type=ender_dragon]");
        await cmd(bot, "kill @e[type=end_crystal]");
        await sleep(400);
        // big bed platform around portal
        await cmd(bot, "fill -8 60 -8 8 60 8 end_stone");
        await cmd(bot, "fill -4 61 -4 4 61 4 end_stone");
        await cmd(bot, "tp @s 0 62 6");
        await sleep(800);
        await equipKit(bot, kit);
        await cmd(bot, "effect give @s slow_falling 600 0");
        await cmd(bot, "effect give @s resistance 600 4");
        // no crystals — pure perch bed fight
        await cmd(bot, "kill @e[type=end_crystal]");
        await cmd(bot, "summon minecraft:ender_dragon 0 70 0");
        await sleep(2000);
        // force sit on portal
        await cmd(bot, "data merge entity @e[type=ender_dragon,limit=1,sort=nearest] {DragonPhase:3}");
        await sleep(500);
        // verify exists via server
        await cmd(bot, "execute as @e[type=ender_dragon,limit=1] run say DRAGON_OK");
      } else if (boss === "wither") {
        await cmd(bot, "execute in minecraft:overworld run tp @s 200 100 -20");
        await sleep(1000);
        await cmd(bot, "fill 185 90 -35 215 120 -5 air");
        await cmd(bot, "fill 185 89 -35 215 89 -5 stone");
        await cmd(bot, "tp @s 200 90 -25");
        await equipKit(bot, kit);
        log(`dim=${bot.game?.dimension} pos=${bot.entity.position}`);
        await cmd(bot, "summon wither 200 91 -18");
        // natural invuln charge ~10s; do NOT force Health rewrite (breaks tracking)
        await sleep(11000);
        await cmd(bot, "data merge entity @e[type=wither,limit=1,sort=nearest] {Invul:0}");
      } else if (boss === "warden") {
        await cmd(bot, "execute in minecraft:overworld run tp @s 250 90 -20");
        await sleep(1000);
        await cmd(bot, "fill 240 80 -40 260 110 -5 air");
        await cmd(bot, "fill 240 79 -40 260 79 -5 deepslate");
        // 2-high poke tunnel (warden ~2.9 tall cannot enter)
        await cmd(bot, "fill 248 80 -35 252 81 -15 air");
        await cmd(bot, "fill 248 82 -35 252 82 -15 deepslate"); // ceiling
        await cmd(bot, "fill 247 80 -35 247 82 -15 deepslate");
        await cmd(bot, "fill 253 80 -35 253 82 -15 deepslate");
        // open arena for warden at z=-12
        await cmd(bot, "tp @s 250 80 -30");
        await equipKit(bot, kit);
        // tell combat tunnel mouth for duck
        combat._bossState.tunnelMouth = { x: 250, y: 80, z: -28 };
        await cmd(bot, "summon warden 250 80 -12");
      }

      await sleep(1500);
      let entity = null;
      for (let attempt = 0; attempt < 15 && !entity; attempt++) {
        entity = findBoss(bot, boss);
        if (!entity && boss === "ender_dragon") {
          entity = Object.values(bot.entities).find((e) =>
            /dragon/i.test(String(e?.name || e?.displayName || e?.type || ""))
          );
        }
        if (!entity) {
          log(`waiting for ${boss} entity… try=${attempt} entities=${Object.keys(bot.entities).length}`);
          if (boss === "ender_dragon") await cmd(bot, "summon minecraft:ender_dragon 0 70 0");
          if (boss === "warden") await cmd(bot, "summon minecraft:warden 250 80 -12");
          if (boss === "wither") await cmd(bot, "summon minecraft:wither 200 91 -18");
          await sleep(800);
        }
      }
      if (!entity) {
        // dump entity names for debug
        const names = Object.values(bot.entities)
          .slice(0, 30)
          .map((e) => e?.name || e?.displayName || e?.type)
          .join(",");
        results.push({ kit, boss, win: false, reason: "summon_failed", ms: 0, names });
        log(`FAIL ${kit}/${boss} summon_failed names=${names}`);
        continue;
      }
      log(`found ${boss} id=${entity.id} name=${entity.name || entity.displayName}`);

      combat.engage({ entity, holdMs: TIMEOUT_MS[boss] });
      const t0 = Date.now();
      let died = false;
      const onDeath = () => {
        died = true;
      };
      bot.once("death", onDeath);

      let bossGone = false;
      const hitsAtStart = combat.getBossState().hits || 0;
      const bedsAtStart = combat.getBossState().bedBombs || 0;
      const shotsAtStart = combat.getBossState().shots || 0;

      while (Date.now() - t0 < TIMEOUT_MS[boss]) {
        const still =
          findBoss(bot, boss) ||
          (boss === "ender_dragon"
            ? Object.values(bot.entities).find((e) =>
                /dragon/i.test(String(e?.name || e?.displayName || ""))
              )
            : null);
        if (!still && Date.now() - t0 > 2000) {
          bossGone = true;
          break;
        }
        if (died) {
          bossGone = !still;
          break;
        }
        if (still) {
          combat.engage({ entity: still, holdMs: 30000 });
          // keep dragon sat for bed bombing
          if (boss === "ender_dragon" && Date.now() - t0 > 3000) {
            await cmd(bot, "data merge entity @e[type=ender_dragon,limit=1,sort=nearest] {DragonPhase:3}");
            await cmd(bot, "tp @s 0 62 2");
          }
        }
        await sleep(400);
      }
      bot.removeListener("death", onDeath);
      const ms = Date.now() - t0;
      const bossState = combat.getBossState();
      const hits = (bossState.hits || 0) - hitsAtStart;
      const beds = (bossState.bedBombs || 0) - bedsAtStart;
      const shots = (bossState.shots || 0) - shotsAtStart;
      const stickTps = bossState.stickTps || 0;

      // STRICT: boss must be gone AND bot must have dealt real pressure
      // (no more false WIN on despawn with 0 hits)
      let contributed = false;
      if (boss === "warden") contributed = hits >= 15;
      else if (boss === "wither") contributed = hits >= 25 || shots >= 80;
      else if (boss === "ender_dragon") contributed = beds >= 2 || hits >= 10 || shots >= 40;
      else contributed = hits >= 5;

      const win = Boolean(bossGone && contributed);
      const row = {
        kit,
        boss,
        win,
        died,
        bossGone,
        contributed,
        hits,
        beds,
        shots,
        stickTps,
        ms,
        hpEnd: bot.health,
        bossState,
      };
      results.push(row);
      log(
        `RESULT kit=${kit} boss=${boss} win=${win} died=${died} bossGone=${bossGone} hits=${hits} beds=${beds} shots=${shots} stickTp=${stickTps} ms=${ms} hp=${bot.health} phase=${bossState.phase || "?"}`
      );

      if (died) {
        await sleep(1500);
        await cmd(bot, "kill @e[type=!player]");
      }
      await sleep(1000);
    }
  }

  combat.stop();
  const wins = results.filter((r) => r.win).length;
  const summary = {
    wins,
    losses: results.length - wins,
    total: results.length,
    winRate: results.length ? Number((wins / results.length).toFixed(3)) : 0,
    byKit: Object.fromEntries(
      KITS.map((k) => {
        const rows = results.filter((r) => r.kit === k);
        return [
          k,
          {
            wins: rows.filter((r) => r.win).length,
            losses: rows.filter((r) => !r.win).length,
            bosses: Object.fromEntries(rows.map((r) => [r.boss, r.win ? "WIN" : r.died ? "DIED" : "TIMEOUT/FAIL"])),
          },
        ];
      })
    ),
    results,
  };
  console.log("=== BOSS_BENCH_JSON ===");
  console.log(JSON.stringify(summary, null, 2));
  bot.quit("boss bench done");
  process.exit(wins === results.length ? 0 : 2);
}

main().catch((e) => {
  console.error("BOSS_BENCH_FAIL", e);
  process.exit(1);
});
