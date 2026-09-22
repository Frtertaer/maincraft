/**
 * Measure combat-reflex vs summoned hostiles.
 * Requires Paper online-mode=false on 127.0.0.1 and OpusBot op'd.
 *
 * Usage: node src/combat-bench.js
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

// Retry only previous failures + silverfish + sample of easy to ensure no regression.
const MOBS = process.env.COMBAT_MOBS
  ? process.env.COMBAT_MOBS.split(",").map((s) => s.trim()).filter(Boolean)
  : [
      "zombie",
      "skeleton",
      "spider",
      "creeper",
      "husk",
      "stray",
      "drowned",
      "witch",
      "enderman",
      "cave_spider",
      "pillager",
      "vindicator",
      "blaze",
      "wither_skeleton",
      "ravager",
      "silverfish",
      "endermite",
      "slime",
      "magma_cube",
      "phantom",
      "hoglin",
      "zoglin",
      "piglin_brute",
      "evoker",
    ];

const ROUNDS_PER_MOB = 1;
const FIGHT_TIMEOUT_MS = 120000;
const BETWEEN_MS = 1500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(...a) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...a);
}

async function chatCmd(bot, cmd) {
  bot.chat(cmd.startsWith("/") ? cmd : `/${cmd}`);
  await sleep(200);
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  const cfg = loadConfig();
  cfg.combat = {
    ...cfg.combat,
    enabled: true,
    mode: "auto",
    intervalMs: 40,
    engageDistance: 28,
    maxDistance: 40,
    autoEngageHostiles: true,
    allowPlayers: false,
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

  const results = [];
  let combat = null;

  await new Promise((resolve, reject) => {
    bot.once("spawn", resolve);
    bot.once("error", reject);
    setTimeout(() => reject(new Error("spawn timeout")), 30000);
  });

  const mcData = minecraftData(bot.version);
  setupMovements(bot, mcData);
  log(`Spawned ${bot.entity.position} ver=${bot.version}`);

  // Op + gear + safe arena prep (needs op)
  await chatCmd(bot, "op " + bot.username); // no-op if already; may fail
  await sleep(300);
  await chatCmd(bot, "gamemode survival");
  await chatCmd(bot, "difficulty hard");
  await chatCmd(bot, "gamerule doMobSpawning false");
  await chatCmd(bot, "gamerule keepInventory true");
  await chatCmd(bot, "effect clear @s");
  await chatCmd(bot, "kill @e[type=!player]");
  await sleep(500);

  // Full diamond + shield + food + sword
  // 1.21 item components (Paper)
  const gives = [
    "give @s diamond_sword[enchantments={levels:{sharpness:5,knockback:2,sweeping_edge:3}}] 1",
    "give @s shield 1",
    "give @s diamond_helmet[enchantments={levels:{protection:4}}] 1",
    "give @s diamond_chestplate[enchantments={levels:{protection:4}}] 1",
    "give @s diamond_leggings[enchantments={levels:{protection:4}}] 1",
    "give @s diamond_boots[enchantments={levels:{protection:4,feather_falling:4}}] 1",
    "give @s carved_pumpkin 1",
    "give @s cooked_beef 64",
    "give @s golden_apple 32",
    "give @s totem_of_undying 3",
    "give @s milk_bucket 4",
    "give @s water_bucket 2",
  ];
  for (const g of gives) {
    await chatCmd(bot, g);
  }
  // fallback plain gear if components rejected
  await chatCmd(bot, "give @s diamond_sword 1");
  await chatCmd(bot, "give @s diamond_helmet 1");
  await chatCmd(bot, "give @s diamond_chestplate 1");
  await chatCmd(bot, "give @s diamond_leggings 1");
  await chatCmd(bot, "give @s diamond_boots 1");
  await sleep(800);

  combat = new CombatReflex({ bot, cfg, log });
  combat.setMode("auto");
  combat.start();

  // Equip once
  await sleep(500);

  const startPos = bot.entity.position.clone();

  for (const mob of MOBS) {
    for (let round = 1; round <= ROUNDS_PER_MOB; round++) {
      await chatCmd(bot, "kill @e[type=!player]");
      await chatCmd(bot, "kill @e[type=vex]");
      await chatCmd(bot, "kill @e[type=evoker_fangs]");
      await chatCmd(bot, "effect clear @s");
      await chatCmd(bot, `tp @s ${Math.floor(startPos.x)} ${Math.floor(startPos.y)} ${Math.floor(startPos.z)}`);
      // full reset gear + heal every round (deaths strip armor)
      for (const g of gives) await chatCmd(bot, g);
      await chatCmd(bot, "give @s diamond_sword 1");
      await chatCmd(bot, "give @s shield 1");
      await chatCmd(bot, "item replace entity @s armor.head with diamond_helmet");
      await chatCmd(bot, "item replace entity @s armor.chest with diamond_chestplate");
      await chatCmd(bot, "item replace entity @s armor.legs with diamond_leggings");
      await chatCmd(bot, "item replace entity @s armor.feet with diamond_boots");
      await chatCmd(bot, "item replace entity @s weapon.offhand with shield");
      await chatCmd(bot, "item replace entity @s weapon.mainhand with diamond_sword");
      await chatCmd(bot, "effect give @s instant_health 1 20");
      await chatCmd(bot, "effect give @s saturation 1 20");
      await chatCmd(bot, "effect give @s resistance 30 1");
      await sleep(600);

      const deathsBefore = bot.deaths ?? 0;
      let died = false;
      const onDeath = () => {
        died = true;
      };
      bot.once("death", onDeath);

      const beforeKills = combat.getStats().kills;
      const px = Math.floor(bot.entity.position.x) + 3;
      const py = Math.floor(bot.entity.position.y);
      const pz = Math.floor(bot.entity.position.z);

      log(`SUMMON ${mob} round=${round}`);
      await chatCmd(bot, `summon minecraft:${mob} ${px} ${py} ${pz} {PersistenceRequired:1b,Health:1000f}`);
      // some versions ignore Health NBT — also plain summon
      await sleep(250);
      await chatCmd(bot, `summon minecraft:${mob} ${px} ${py} ${pz}`);
      await sleep(400);

      const mobMatch = (e) => {
        if (!e?.position || e === bot.entity) return false;
        const n = String(e.name || e.displayName || "")
          .toLowerCase()
          .replaceAll(" ", "_")
          .replace("minecraft:", "");
        // slime/magma split into sizes — accept family
        if (mob === "slime") return n === "slime";
        if (mob === "magma_cube") return n === "magma_cube";
        return n === mob;
      };

      // must observe the mob at least once, else summon failed
      let saw = false;
      for (let i = 0; i < 20 && !saw; i++) {
        saw = Object.values(bot.entities).some(mobMatch);
        if (!saw) await sleep(100);
      }
      if (!saw) {
        results.push({
          mob,
          round,
          win: false,
          died: false,
          ms: 0,
          hpEnd: bot.health,
          combatHits: combat.getStats().hits,
          combatKills: combat.getStats().kills,
          summonFailed: true,
        });
        log(`RESULT ${mob}: win=false summonFailed=true`);
        await sleep(BETWEEN_MS);
        continue;
      }

      // lock engage
      combat.engage({ holdMs: FIGHT_TIMEOUT_MS });
      const hitsAtStart = combat.getStats().hits;

      const t0 = Date.now();
      let win = false;
      while (Date.now() - t0 < FIGHT_TIMEOUT_MS) {
        if (died) break;
        const still = Object.values(bot.entities).some(
          (e) => mobMatch(e) && e.position.distanceTo(bot.entity.position) < 64
        );
        const hitDelta = combat.getStats().hits - hitsAtStart;
        // real win: saw mob, it's gone, and we landed at least one hit OR kill counter moved
        if (!still && Date.now() - t0 > 500 && (hitDelta > 0 || combat.getStats().kills > beforeKills)) {
          win = true;
          break;
        }
        await sleep(200);
      }

      bot.removeListener("death", onDeath);
      const ms = Date.now() - t0;
      const hp = bot.health;
      const row = {
        mob,
        round,
        win: win && !died,
        died,
        ms,
        hpEnd: hp,
        combatHits: combat.getStats().hits,
        combatKills: combat.getStats().kills,
        kites: combat.getStats().kites,
        blocks: combat.getStats().blocks,
      };
      results.push(row);
      log(
        `RESULT ${mob}: win=${row.win} died=${row.died} ms=${ms} hp=${hp} hits=${row.combatHits}`
      );

      if (died) {
        await sleep(800);
        // respawn
        bot.chat("/kill @e[type=!player]");
        await waitUntil(() => bot.entity && bot.health > 0, 15000, "respawn").catch(() => {});
        await chatCmd(bot, `tp @s ${startPos.x} ${startPos.y} ${startPos.z}`);
        await chatCmd(bot, "effect give @s instant_health 1 10");
        // re-give gear if lost
        for (const g of gives) await chatCmd(bot, g);
        await sleep(500);
      }
      await sleep(BETWEEN_MS);
    }
  }

  combat.stop();

  const wins = results.filter((r) => r.win).length;
  const losses = results.filter((r) => !r.win).length;
  const summary = {
    total: results.length,
    wins,
    losses,
    winRate: results.length ? Number((wins / results.length).toFixed(3)) : 0,
    byMob: Object.fromEntries(
      MOBS.map((m) => {
        const rows = results.filter((r) => r.mob === m);
        return [
          m,
          {
            wins: rows.filter((r) => r.win).length,
            losses: rows.filter((r) => !r.win).length,
            avgMs: rows.length
              ? Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length)
              : null,
          },
        ];
      })
    ),
    combatStats: combat.getStats(),
    results,
  };

  console.log("=== COMBAT_BENCH_JSON ===");
  console.log(JSON.stringify(summary, null, 2));

  bot.quit("bench done");
  process.exit(losses === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error("BENCH_FAIL", err);
  process.exit(1);
});
