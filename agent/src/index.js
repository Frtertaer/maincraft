import mineflayer from "mineflayer";
import pkgPathfinder from "mineflayer-pathfinder";
import pkgCollect from "mineflayer-collectblock";
import pkgTool from "mineflayer-tool";
import minecraftData from "minecraft-data";
import readline from "readline";
import { loadConfig } from "./config.js";
import { LlmClient, sanitizeForLog } from "./llm.js";
import { Brain } from "./brain.js";
import { parseCommand, HELP_TEXT } from "./commands.js";
import { setupMovements, executeAction } from "./actions.js";
import { createVisionProvider } from "./vision.js";
import { startLocalViewer } from "./local-viewer.js";
import { CombatReflex } from "./combat-reflex.js";
import { createController } from "./controller/index.js";
import { ClearRunner } from "./clear.js";

const pathfinder = pkgPathfinder.pathfinder || pkgPathfinder.default?.pathfinder || pkgPathfinder;
const collectPlugin = pkgCollect.plugin || pkgCollect.default?.plugin || pkgCollect.default || pkgCollect;
const toolPlugin = pkgTool.plugin || pkgTool.default?.plugin || pkgTool.default || pkgTool;

function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  const safe = args.map((value) => (typeof value === "string" ? sanitizeForLog(value, 2000) : value));
  console.log(`[${ts}]`, ...safe);
}

function isController(cfg, username) {
  if (!cfg.agent.allowPlayerCommands) return false;
  const wanted = String(username || "").toLowerCase();
  return cfg.agent.controllerUsers.some((name) => name.toLowerCase() === wanted);
}

/** Free-chat companions (neuro-Skyrim style), not only !commands. */
function isChatAllowed(cfg, username) {
  if (!cfg.agent.allowPlayerChat && !cfg.agent.companionMode) return false;
  const wanted = String(username || "").toLowerCase();
  const chats = cfg.agent.chatUsers || [];
  if (chats.some((n) => n === "*" || String(n).toLowerCase() === wanted)) return true;
  // controllers may always free-chat when chat is on
  if (cfg.agent.allowPlayerChat || cfg.agent.companionMode) {
    return (cfg.agent.controllerUsers || []).some((n) => String(n).toLowerCase() === wanted);
  }
  return false;
}

function reconnectDelay(cfg, attempt) {
  const base = Math.min(
    cfg.minecraft.reconnect.baseDelayMs * 2 ** Math.max(attempt - 1, 0),
    cfg.minecraft.reconnect.maxDelayMs
  );
  return Math.max(250, Math.round(base * (0.85 + Math.random() * 0.3)));
}

async function main() {
  const cfg = loadConfig();
  const llm = new LlmClient(cfg);

  log(`Config ${cfg._configPath || "config.json"}`);
  log(
    `Vision default source=${cfg.vision.source} enabled=${cfg.vision.enabled} everyNTicks=${cfg.vision.everyNTicks}`
  );
  log(`Checking API host=${new URL(cfg.api.baseUrl).host} model=${cfg.api.model} protocol=${cfg.api.protocol || "anthropic"}…`);
  try {
    const pre = await llm.preflight();
    log(
      `API ready | exact_model=${cfg.api.model} | session_requests=${cfg.api.budget.maxRequestsPerSession} | session_tokens=${cfg.api.budget.maxTokensPerSession}` +
        (pre?.warning ? ` | note=${pre.warning}` : "")
    );
  } catch (err) {
    const code = err?.code ? ` [${err.code}]` : "";
    throw new Error(`API preflight failed${code}: ${sanitizeForLog(err?.message || err)}`);
  }

  const runtime = {
    session: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    stopping: false,
    exitTimer: null,
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  function closeViewer(bot) {
    try {
      bot?.viewer?.close?.();
    } catch (err) {
      log(`Viewer close failed: ${err?.message || "unknown error"}`);
    }
  }

  function stopSession(session) {
    session?.brain?.stop();
    session?.combat?.stop();
    session?.clear?.stop();
    if (session?.ambientTimer) clearInterval(session.ambientTimer);
    if (session?.pruneTimer) clearInterval(session.pruneTimer);
    closeViewer(session?.bot);
  }

  function finishProcess(code) {
    if (runtime.exitTimer) return;
    runtime.exitTimer = setTimeout(() => process.exit(code), 300);
  }

  function scheduleReconnect(reason) {
    if (runtime.stopping || runtime.reconnectTimer) return;
    const reconnect = cfg.minecraft.reconnect;
    if (!reconnect.enabled) {
      log(`Disconnected (${reason}); reconnect is disabled.`);
      finishProcess(2);
      return;
    }
    if (reconnect.maxAttempts > 0 && runtime.reconnectAttempts >= reconnect.maxAttempts) {
      log(`Reconnect limit reached (${reconnect.maxAttempts}). Exiting.`);
      finishProcess(2);
      return;
    }
    runtime.reconnectAttempts += 1;
    const delay = reconnectDelay(cfg, runtime.reconnectAttempts);
    log(`Reconnect ${runtime.reconnectAttempts} in ${delay}ms (${reason}).`);
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = null;
      connectBot();
    }, delay);
  }

  function disconnectBot(bot, reason = "bye") {
    try {
      bot.quit(reason);
    } catch {
      try {
        bot.end(reason);
      } catch {
        // The connection may already be closed.
      }
    }
  }

  async function initializeSpawn(session) {
    const { bot } = session;
    if (session.ended || runtime.session !== session) return;
    session.mcData = minecraftData(bot.version);
    setupMovements(bot, session.mcData);
    runtime.reconnectAttempts = 0;
    log(`Spawned at ${bot.entity.position} | version=${bot.version}`);

    if (cfg.viewer.enabled) {
      try {
        if (session.ended || runtime.session !== session) return;
        const viewer = await startLocalViewer(bot, {
          host: cfg.viewer.host,
          port: cfg.viewer.port,
          firstPerson: cfg.viewer.firstPerson,
        });
        log(`Viewer: ${viewer.url} (loopback only)`);
      } catch (err) {
        log(`Viewer failed (optional): ${err?.message || "unknown error"}`);
      }
    }

    if (session.ended || runtime.session !== session) {
      closeViewer(bot);
      return;
    }

    session.brain = new Brain({ bot, llm, cfg, mcData: session.mcData, log });
    const vision = createVisionProvider(cfg, log);
    vision.setBot(bot);
    session.vision = vision;
    session.brain.getVisionFrame = () => vision.getFrame();
    session.brain.visionEnabled = Boolean(cfg.vision.enabled);

    session.combat = new CombatReflex({ bot, cfg, log });
    try {
      session.combat.setMode(cfg.combat?.mode || "auto");
    } catch {
      /* keep default */
    }
    session.combat.start();
    session.brain.combat = session.combat;

    session.controller = createController({ cfg, log });
    if (session.controller) session.brain.setController(session.controller);
    session.brain.start();

    // NeuroSkyrim-style ambient NPC: world events feed memory; when chat is
    // quiet the companion may comment on its own (mantella.ambientEveryMs).
    if (session.brain.mantella) {
      const note = (text) => {
        try {
          session.brain.mantella.noteWorldEvent(text);
        } catch {
          /* ignore */
        }
      };
      bot.on("death", () => note("Я погиб и возродился — надо вернуться за вещами"));
      bot.on("playerJoined", (player) => {
        if (player?.username && player.username !== bot.username) note(`${player.username} зашёл в мир`);
      });
      bot.on("playerLeft", (player) => {
        if (player?.username && player.username !== bot.username) note(`${player.username} вышел из мира`);
      });
      bot.on("rain", () => note("Пошёл дождь"));
      const ambientMs = Math.max(20000, Number(cfg.mantella?.ambientEveryMs) || 0);
      if (ambientMs > 0) {
        session.ambientTimer = setInterval(() => {
          void (async () => {
            try {
              const reply = await session.brain.mantella.maybeAmbient({
                agentState: { mode: session.brain.mode, goal: session.brain.goal },
                minGapMs: ambientMs,
              });
              if (reply?.say) session.brain._emitSay(reply.say);
              if (reply?.action) {
                await session.brain.mantella.runDialogueAction(reply.action, {
                  playerName: session.brain.mantella.lastPlayerName,
                });
              }
            } catch (err) {
              log(`[ambient] ${sanitizeForLog(err?.message || err, 160)}`);
            }
          })();
        }, ambientMs);
        session.ambientTimer.unref?.();
      }
    }

    if (cfg.agent.announceOnSpawn) {
      if (cfg.agent.companionMode) {
        bot.chat(
          `Привет! Я ${cfg.agent.botName || "Opus"} — спутник в мире. Пиши в чат, можно просто болтать. Команды: !help !follow !goal`
        );
      } else {
        bot.chat(
          `Opus 5 online | mode=${session.brain.mode} | combat=${session.combat.mode}@${cfg.combat?.intervalMs || 50}ms | vision=${session.brain.visionEnabled ? "on" : "off"}` +
            (session.controller ? ` | controller=${session.controller.type}` : "")
        );
      }
    }
    log(HELP_TEXT);
    log("Console commands are trusted. Player commands are restricted by agent.controllerUsers.");
    if (cfg.agent.allowPlayerChat || cfg.agent.companionMode) {
      log(
        `Player chat enabled for: ${(cfg.agent.chatUsers || []).join(", ") || "(controllers only)"} | companion=${cfg.agent.companionMode}`
      );
    }
  }

  function handleIncoming(session, username, message, source) {
    if (runtime.session !== session || !session.brain) return;
    if (source === "whisper" && !cfg.agent.allowWhispers) {
      log(`[security] ignored whisper from ${username}`);
      return;
    }
    const command = parseCommand(message, cfg.agent.botName);

    // !commands / Opus, … — only controllers
    if (command && command.type !== "direct") {
      if (!isController(cfg, username)) {
        log(`[security] ignored player command from ${username}`);
        return;
      }
      void applyCommand(session, command, username, source).catch((err) => {
        log(`[command] ${sanitizeForLog(err?.message || err)}`);
      });
      return;
    }

    // free-form: either addressed "Opus, …" (direct) or plain chat in companion mode
    const addressedDirect = Boolean(command && command.type === "direct");
    const plainChat = !command && (source === "player" || source === "whisper");

    if (addressedDirect) {
      if (!isController(cfg, username) && !isChatAllowed(cfg, username)) {
        log(`[security] ignored addressed message from ${username}`);
        return;
      }
      void applyCommand(session, command, username, source).catch((err) => {
        log(`[command] ${sanitizeForLog(err?.message || err)}`);
      });
      return;
    }

    if (plainChat && isChatAllowed(cfg, username)) {
      // Companion / social: a chat line goes through the fast dialogue
      // pipeline (SkyrimNet-style), not the heavy planner command path.
      const text = String(message || "").trim().slice(0, 400);
      if (!text) return;
      session.brain.resume();
      try {
        session.brain.mantella?.onPlayerChat(username, text);
      } catch (err) {
        log(`[mantella] ${sanitizeForLog(err?.message || err)}`);
      }
      log(`[chat] from ${username}: ${sanitizeForLog(text, 120)}`);
      void handleDialogue(session, username, text).catch((err) => {
        log(`[dialogue] ${sanitizeForLog(err?.message || err)}`);
      });
      return;
    }

    if (plainChat) {
      log(`[security] ignored chat from ${username} (not in chatUsers/controllers)`);
    }
  }

  /**
   * NeuroSkyrim dialogue turn: memory → one LLM reply → say + optional body
   * action + optional task routed to the planner (or the clear runner).
   */
  async function handleDialogue(session, username, text) {
    const brain = session.brain;
    if (!brain) return;
    if (!brain.mantella) {
      brain.queueCommand(
        `Игрок ${username} сказал в игровом чате: «${text}». Ответь в say по-русски и действуй если просят.`,
        username
      );
      return;
    }
    let reply;
    try {
      reply = await brain.mantella.respond(username, text, {
        agentState: { mode: brain.mode, goal: brain.goal },
      });
    } catch (err) {
      // API hiccup → degrade to the planner path so the player is not ignored.
      log(`[dialogue] llm fail, queueing: ${sanitizeForLog(err?.message || err, 160)}`);
      brain.queueCommand(
        `Игрок ${username} сказал в игровом чате: «${text}». Ответь в say по-русски и действуй если просят.`,
        username
      );
      return;
    }
    if (!reply) return;
    if (reply.say) brain._emitSay(reply.say);
    if (reply.action) {
      const r = await brain.mantella.runDialogueAction(reply.action, { playerName: username });
      if (r && !r.ok) log(`[dialogue] action ${reply.action} fail: ${r.message}`);
    }
    if (reply.task) {
      log(`[dialogue] task from ${username}: ${sanitizeForLog(reply.task, 120)}`);
      if (/пройд|дракон|эндер|визер|варден|wither|warden|clear|beat the game|босс/i.test(reply.task)) {
        const objectives = [];
        if (/визер|wither/i.test(reply.task)) objectives.push("wither");
        if (/варден|warden/i.test(reply.task)) objectives.push("warden");
        if (!objectives.length || /пройд|дракон|эндер|clear|beat/i.test(reply.task)) objectives.unshift("dragon");
        await applyCommand(session, { type: "clear", op: "start", objectives }, username, "chat");
      } else {
        brain.queueCommand(`Игрок ${username} просит: ${reply.task}. Выполни.`, username);
      }
    }
  }

  async function applyCommand(session, command, username = "console", source = "console") {
    if (runtime.session !== session || !session?.brain) {
      log("Brain not ready");
      return;
    }
    const { bot, brain, mcData } = session;
    switch (command.type) {
      case "help":
        if (source === "console") log(HELP_TEXT);
        else bot.chat(HELP_TEXT.slice(0, 256));
        break;
      case "stop":
        brain.pause();
        brain.queueCommand("stop all actions now", username);
        await executeAction(bot, { type: "stop" }, mcData);
        if (source !== "console") bot.chat("Стою.");
        log("stopped");
        break;
      case "pause":
        brain.pause();
        if (source !== "console") bot.chat("Пауза.");
        log("paused");
        break;
      case "resume":
        brain.resume();
        if (source !== "console") bot.chat("Продолжаю.");
        log("resumed");
        break;
      case "status": {
        const state = {
          brain: brain.getState(),
          combat: session.combat?.getStats?.() || null,
          apiBudget: llm.getBudgetState(),
          health: bot.health,
          food: bot.food,
        };
        if (source !== "console") {
          bot.chat(
            `mode=${brain.mode} goal=${brain.goal} vision=${brain.visionEnabled} pause=${brain.paused} hp=${bot.health} food=${bot.food}`.slice(
              0,
              256
            )
          );
        }
        log(JSON.stringify(state, null, 2));
        break;
      }
      case "mode":
        try {
          brain.setMode(command.mode);
          if (source !== "console") bot.chat(`Режим: ${command.mode}`);
          log(`mode=${command.mode}`);
        } catch (err) {
          if (source !== "console") bot.chat(String(err?.message || "invalid mode").slice(0, 256));
          log(err?.message || "invalid mode");
        }
        break;
      case "combat":
        try {
          if (!session.combat) throw new Error("combat layer not ready");
          session.combat.setMode(command.mode);
          if (source !== "console") bot.chat(`Combat: ${command.mode}`);
          log(`combat.mode=${command.mode} stats=${JSON.stringify(session.combat.getStats())}`);
        } catch (err) {
          if (source !== "console") bot.chat(String(err?.message || "invalid combat").slice(0, 256));
          log(err?.message || "invalid combat");
        }
        break;
      case "goal":
        brain.setGoal(command.goal);
        brain.resume();
        if (source !== "console") bot.chat(`Цель: ${command.goal}`.slice(0, 256));
        brain.queueCommand(`Твоя новая цель: ${command.goal}. Начни выполнять.`, username);
        break;
      case "vision":
        if (source !== "console") {
          log(`[security] denied vision toggle from ${username}; use the local console`);
          return;
        }
        if (command.enabled && !["file", "viewer"].includes(cfg.vision.source)) {
          log("Vision cannot be enabled: vision.source must be file or viewer");
          return;
        }
        brain.visionEnabled = command.enabled;
        cfg.vision.enabled = command.enabled;
        log(`vision=${command.enabled ? "on" : "off"} (source=${cfg.vision.source})`);
        break;
      case "follow": {
        // Direct pathfinder (Mantella-style action), no LLM monologue loop
        brain.resume();
        const player = command.player || username;
        brain.setGoal(`следовать за ${player}`);
        const r = await executeAction(bot, { type: "follow", player, distance: 3 }, mcData);
        if (source !== "console") bot.chat(r.ok ? `Иду за ${player}` : String(r.message || "не вижу").slice(0, 100));
        log(`[follow] ${r.ok ? "ok" : r.message} -> ${player}`);
        break;
      }
      case "come": {
        brain.resume();
        const player = command.player || username;
        const r = await executeAction(bot, { type: "come", player }, mcData);
        if (source !== "console") bot.chat(r.ok ? "Иду!" : String(r.message || "не вижу").slice(0, 100));
        log(`[come] ${r.ok ? "ok" : r.message}`);
        break;
      }
      case "direct":
        brain.resume();
        brain.queueCommand(command.text, username);
        log(`[cmd] queued from ${username}`);
        break;
      case "clear": {
        if (!session.clear) {
          session.clear = new ClearRunner({
            bot,
            cfg,
            mcData: session.mcData,
            brain,
            combat: session.combat,
            log,
            onMilestone: (text) => {
              try {
                bot.chat(String(text).slice(0, 200));
              } catch {
                /* ignore */
              }
              brain.mantella?.noteWorldEvent(text);
            },
          });
        }
        if (command.op === "stop") {
          const r = session.clear.stop();
          if (source !== "console") bot.chat(r.ok ? "Останавливаю прохождение." : r.message);
          log(`[clear] stop ${r.message}`);
        } else if (command.op === "status") {
          const s = session.clear.status();
          log(`[clear] ${JSON.stringify(s)}`);
          if (source !== "console") {
            bot.chat(
              `Прохождение: фаза ${s.phase}, цель ${s.objective}, шаг ${s.steps}, смертей ${s.deaths}${s.credits ? ", титры ✓" : ""}`.slice(0, 256)
            );
          }
        } else {
          const objectives = command.objectives?.length ? command.objectives : ["dragon"];
          const r = await session.clear.start(objectives);
          if (source !== "console") {
            const names = { dragon: "дракон", wither: "визер", warden: "варден" };
            bot.chat(
              r.ok
                ? `Погнали — цели: ${objectives.map((o) => names[o] || o).join(" → ")}!`
                : String(r.message).slice(0, 100)
            );
          }
          log(`[clear] start ${r.message} objectives=${objectives.join(",")}`);
        }
        break;
      }
      case "listen": {
        // Whisper STT via voice sidecar
        brain.resume();
        const sec = Math.min(20, Math.max(2, Number(command.seconds) || 5));
        if (source !== "console") bot.chat(`Слушаю ${sec}с…`);
        log(`[listen] ${sec}s from ${username}`);
        void (async () => {
          try {
            if (!brain.mantella) {
              bot.chat("Mantella/voice не включён");
              return;
            }
            const r = await brain.mantella.listenMic(sec);
            if (!r?.ok || !r.text) {
              bot.chat(`Не расслышал: ${r?.error || "пусто"}`.slice(0, 256));
              return;
            }
            log(`[stt] ${sanitizeForLog(r.text, 200)} engine=${r.engine || "?"}`);
            brain.mantella.onPlayerChat(username, r.text);
            brain.queueCommand(
              `Игрок ${username} СКАЗАЛ ГОЛОСОМ (Whisper STT): «${r.text}». ` +
                `Ответь в say по-русски и действуй если просят.`,
              username
            );
          } catch (err) {
            log(`[listen] ${sanitizeForLog(err?.message || err)}`);
            if (source !== "console") bot.chat("STT ошибка — voice server?");
          }
        })();
        break;
      }
      case "summary": {
        void (async () => {
          try {
            if (!brain.mantella) {
              bot.chat("Нет mantella memory");
              return;
            }
            await brain.mantella.maybeSummarize(username);
            const s = brain.mantella.memory.loadSummary().slice(0, 200);
            bot.chat(s ? `Память: ${s}` : "Память пуста");
            log(`[summary] ${s.slice(0, 300)}`);
          } catch (err) {
            log(`[summary] ${sanitizeForLog(err?.message || err)}`);
          }
        })();
        break;
      }
      default:
        log(`unknown command type: ${command.type}`);
    }
  }

  function connectBot() {
    if (runtime.stopping || runtime.session) return;
    log(
      `Connecting to ${cfg.minecraft.host}:${cfg.minecraft.port} as ${cfg.minecraft.username} (auth=${cfg.minecraft.auth}, ver=${cfg.minecraft.version})…`
    );

    let bot;
    try {
      bot = mineflayer.createBot({
        host: cfg.minecraft.host,
        port: cfg.minecraft.port,
        username: cfg.minecraft.username,
        version: cfg.minecraft.version === "auto" ? false : cfg.minecraft.version,
        auth: cfg.minecraft.auth,
        hideErrors: false,
      });
    } catch (err) {
      log(`Bot creation failed: ${err?.message || "unknown error"}`);
      scheduleReconnect("create failed");
      return;
    }

    const session = { bot, brain: null, mcData: null, ended: false };
    runtime.session = session;

    // Chunk columns accumulate forever — unload ones far from the bot so
    // exploring/mining does not grow the heap until OOM.
    session.pruneTimer = setInterval(() => {
      try {
        const p = bot.entity?.position;
        if (!p || !bot.world?.async?.columns) return;
        const cx = Math.floor(p.x / 16);
        const cz = Math.floor(p.z / 16);
        let pruned = 0;
        for (const key of Object.keys(bot.world.async.columns)) {
          const [x, z] = key.split(",").map(Number);
          if (Math.abs(x - cx) + Math.abs(z - cz) > 24) {
            bot.world.unloadColumn(x, z);
            pruned += 1;
          }
        }
        const heap = Math.round(process.memoryUsage().heapUsed / 1048576);
        let blockUpdates = 0;
        let totalListeners = 0;
        for (const ev of bot.eventNames()) {
          const n = bot.listenerCount(ev);
          totalListeners += n;
          if (String(ev).startsWith("blockUpdate")) blockUpdates += n;
        }
        log(`[mem] heap=${heap}MB cols=${Object.keys(bot.world.async.columns).length} listeners=${totalListeners} blockUpdate=${blockUpdates} handles=${process._getActiveHandles().length}`);
        if (typeof global.gc === "function") global.gc();
      } catch (err) {
        log(`[mem] prune fail: ${err?.message || err}`);
      }
    }, 15000);

    bot._client?.on?.("error", (e) => {
      if (/PartialRead|Parse error/i.test(String(e?.message || ""))) {
        log(`[pkt] ${e?.field || "?"}: ${String(e?.message || "").slice(0, 140)}`);
      }
    });
    bot.on("kicked", (reason) => log(`Kicked: ${JSON.stringify(reason).slice(0, 500)}`));
    bot.on("error", (err) => log(`Bot error: ${err?.message || "unknown error"}`));
    bot.on("end", (reason) => {
      if (session.ended) return;
      session.ended = true;
      stopSession(session);
      if (runtime.session === session) runtime.session = null;
      log(`Disconnected: ${reason}`);
      scheduleReconnect(String(reason || "connection ended"));
    });

    try {
      bot.loadPlugin(pathfinder);
      bot.loadPlugin(collectPlugin);
      bot.loadPlugin(toolPlugin);
    } catch (err) {
      log(`Plugin setup failed: ${err?.message || "unknown error"}`);
      session.ended = true;
      if (runtime.session === session) runtime.session = null;
      disconnectBot(bot, "plugin setup failed");
      scheduleReconnect("plugin setup failed");
      return;
    }

    bot.once("spawn", () => {
      void initializeSpawn(session).catch((err) => {
        log(`Spawn initialization failed: ${err?.message || "unknown error"}`);
        disconnectBot(bot, "spawn initialization failed");
      });
    });
    bot.on("chat", (username, message) => {
      if (username !== bot.username) handleIncoming(session, username, message, "player");
    });
    bot.on("whisper", (username, message) => {
      handleIncoming(session, username, message, "whisper");
    });
  }

  async function shutdown(code = 0) {
    if (runtime.stopping) return;
    runtime.stopping = true;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
    const session = runtime.session;
    runtime.session = null;
    stopSession(session);
    rl.close();
    if (session?.bot) disconnectBot(session.bot, "local shutdown");
    finishProcess(code);
  }

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === "exit" || text === "quit") {
      void shutdown(0);
      return;
    }
    if (text === "reconnect") {
      if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
      if (runtime.session?.bot) disconnectBot(runtime.session.bot, "manual reconnect");
      else connectBot();
      return;
    }
    const command = parseCommand(text.startsWith("!") ? text : `!${text}`, cfg.agent.botName);
    if (!command) return;
    void applyCommand(runtime.session, command, "console", "console").catch((err) => {
      log(`[console] ${sanitizeForLog(err?.message || err)}`);
    });
  });

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  connectBot();
}

main().catch((err) => {
  console.error(sanitizeForLog(err?.message || err, 1000));
  process.exit(1);
});
