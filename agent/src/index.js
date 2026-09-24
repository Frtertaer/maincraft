import mineflayer from "mineflayer";
import pkgPathfinder from "mineflayer-pathfinder";
import pkgCollect from "mineflayer-collectblock";
import pkgTool from "mineflayer-tool";
import minecraftData from "minecraft-data";
import readline from "readline";
import { loadConfig, normalizeCustomCommands } from "./config.js";
import { LlmClient, sanitizeForLog } from "./llm.js";
import { Brain } from "./brain.js";
import { parseCommand, HELP_TEXT } from "./commands.js";
import { setupMovements, executeAction, setFoodPreferences } from "./actions.js";
import { createVisionProvider } from "./vision.js";
import { startLocalViewer } from "./local-viewer.js";
import { CombatReflex } from "./combat-reflex.js";
import { bridge, botSnapshot } from "./app-bridge.js";

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
  return cfg.agent.controllerUsers.some((name) => name === "*" || name.toLowerCase() === wanted);
}

/** Fill {player} {args} {bot} {px} {py} {pz} placeholders in a user-defined command. */
function fillTemplate(value, vars) {
  if (typeof value !== "string") return value;
  return value.replace(/\{(player|args|bot|px|py|pz)(?:\|([^}]*))?\}/g, (_, key, fallback) => {
    const filled = String(vars[key] ?? "").trim();
    return filled || String(fallback ?? "");
  });
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
  setFoodPreferences(cfg.agent.foodPreferences);

  log(`Config ${cfg._configPath || "config.json"}`);
  log(
    `Vision default source=${cfg.vision.source} enabled=${cfg.vision.enabled} everyNTicks=${cfg.vision.everyNTicks}`
  );
  log(`Checking API host=${new URL(cfg.api.baseUrl).host} model=${cfg.api.model} preflight=${cfg.api.preflight}…`);
  bridge.emit("lifecycle", { state: "api-check" });
  try {
    await llm.preflight(cfg.api.preflight);
    log(
      `API ready | exact_model=${cfg.api.model} | session_requests=${cfg.api.budget.maxRequestsPerSession} | session_tokens=${cfg.api.budget.maxTokensPerSession}`
    );
  } catch (err) {
    const code = err?.code ? ` [${err.code}]` : "";
    bridge.emit("lifecycle", { state: "error", reason: "api", message: sanitizeForLog(err?.message || err) });
    throw new Error(`API preflight failed${code}: ${sanitizeForLog(err?.message || err)}`);
  }
  bridge.emit("lifecycle", { state: "api-ready" });

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
    if (session?.statusTimer) clearInterval(session.statusTimer);
    session?.brain?.stop();
    session?.combat?.stop();
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
      bridge.emit("lifecycle", { state: "error", reason: "reconnect-limit", message: reason });
      finishProcess(2);
      return;
    }
    runtime.reconnectAttempts += 1;
    const delay = reconnectDelay(cfg, runtime.reconnectAttempts);
    bridge.emit("lifecycle", { state: "reconnecting", attempt: runtime.reconnectAttempts, delayMs: delay, message: reason });
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
    let viewerUrl = null;

    if (cfg.viewer.enabled) {
      try {
        if (session.ended || runtime.session !== session) return;
        const viewer = await startLocalViewer(bot, {
          host: cfg.viewer.host,
          port: cfg.viewer.port,
          firstPerson: cfg.viewer.firstPerson,
        });
        viewerUrl = viewer.url;
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
    session.brain.onStep = (info) => bridge.emit("step", info);
    session.brain.start();

    bridge.emit("lifecycle", { state: "spawned", viewerUrl, version: bot.version, username: bot.username });
    if (bridge.enabled) {
      const pushStatus = () => {
        if (runtime.session !== session || session.ended) return;
        const snapshot = botSnapshot(bot, session.brain, session.combat);
        if (snapshot) bridge.emit("status", { status: snapshot, apiBudget: llm.getBudgetState() });
      };
      pushStatus();
      session.statusTimer = setInterval(pushStatus, 1500);
    }

    if (cfg.agent.announceOnSpawn) {
      if (cfg.agent.companionMode) {
        bot.chat(
          `Привет! Я ${cfg.agent.botName || "Opus"} — спутник в мире. Пиши в чат, можно просто болтать. Команды: !help !follow !goal`
        );
      } else {
        bot.chat(
          `Opus 5 online | mode=${session.brain.mode} | combat=${session.combat.mode}@${cfg.combat?.intervalMs || 50}ms | vision=${session.brain.visionEnabled ? "on" : "off"}`
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
    const command = parseCommand(message, cfg.agent.botName, cfg.commands?.custom);

    // user-defined commands carry their own access level
    if (command?.type === "custom") {
      const allowed = command.command.access === "everyone" || isController(cfg, username);
      if (!allowed) {
        log(`[security] ignored custom command "${command.command.name}" from ${username}`);
        return;
      }
      void applyCommand(session, command, username, source).catch((err) => {
        log(`[command] ${sanitizeForLog(err?.message || err)}`);
      });
      return;
    }

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
      // Companion / social: any chat line becomes a player message to the character
      const text = String(message || "").trim().slice(0, 400);
      if (!text) return;
      session.brain.resume();
      try {
        session.brain.mantella?.onPlayerChat(username, text);
      } catch (err) {
        log(`[mantella] ${sanitizeForLog(err?.message || err)}`);
      }
      session.brain.queueCommand(
        `Игрок ${username} сказал в игровом чате: «${text}». ` +
          `Ответь как персонаж в поле say (коротко по-русски). ` +
          `Если просят действие — сделай action; если просто болтают — say + idle/look/come/follow по смыслу. ` +
          `Учти Mantella-context (память и мир) в промпте.`,
        username
      );
      log(`[chat] from ${username}: ${sanitizeForLog(text, 120)}`);
      return;
    }

    if (plainChat) {
      log(`[security] ignored chat from ${username} (not in chatUsers/controllers)`);
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
        if (source !== "console" && source !== "app") {
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
      case "custom":
        await runCustomCommand(session, command, username);
        break;
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

  async function runCustomCommand(session, hit, username) {
    const { bot, brain, mcData } = session;
    const def = hit.command;
    const player = username === "console" || username === "app" ? cfg.agent.controllerUsers.find((n) => n !== "*") || username : username;
    const playerEntity = bot.players?.[player]?.entity;
    const vars = {
      player,
      args: hit.args || "",
      bot: bot.username,
      px: playerEntity ? Math.round(playerEntity.position.x) : "",
      py: playerEntity ? Math.round(playerEntity.position.y) : "",
      pz: playerEntity ? Math.round(playerEntity.position.z) : "",
    };
    log(`[custom] "${def.name}" (${def.kind}) from ${username} args="${sanitizeForLog(vars.args, 80)}"`);
    bridge.emit("command", { id: def.id, name: def.name, from: username, state: "started" });
    brain.resume();
    if (def.reply) {
      bot.__speechNext = true;
      bot.chat(fillTemplate(def.reply, vars).slice(0, 256));
    }

    if (def.kind === "ai") {
      brain.queueCommand(fillTemplate(def.prompt, vars), player);
      bridge.emit("command", { id: def.id, name: def.name, from: username, state: "queued" });
      return;
    }

    // Deterministic script: run steps in order; the LLM loop waits until it finishes.
    brain.externalBusy = true;
    let failed = null;
    try {
      for (const [index, raw] of def.steps.entries()) {
        if (runtime.session !== session || session.ended) return;
        const step = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, fillTemplate(v, vars)]));
        for (const key of ["x", "y", "z", "count", "ms", "distance", "range", "maxDurationMs", "maxDistance"]) {
          if (typeof step[key] === "string" && step[key].trim() !== "" && Number.isFinite(Number(step[key]))) {
            step[key] = Number(step[key]);
          }
        }
        if (step.type === "ask_ai") {
          brain.queueCommand(String(step.prompt || step.text || ""), player);
          continue;
        }
        if (step.type === "set_goal") {
          brain.setGoal(step.goal || step.text || "");
          continue;
        }
        if (step.type === "chat" || step.type === "say") bot.__speechNext = true;
        const result = await executeAction(bot, step, mcData);
        bot.__speechNext = false;
        log(`[custom] step ${index + 1}/${def.steps.length} ${step.type}: ${result.ok ? "ok" : result.message}`);
        if (!result.ok && !step.continueOnError) {
          failed = `шаг ${index + 1} (${step.type}): ${result.message}`;
          break;
        }
      }
    } finally {
      brain.externalBusy = false;
    }
    bridge.emit("command", {
      id: def.id,
      name: def.name,
      from: username,
      state: failed ? "failed" : "done",
      message: failed || null,
    });
    if (failed) bot.chat(`Не вышло: ${failed}`.slice(0, 256));
  }

  /** Message from the desktop app user (typed or spoken) — trusted like the console. */
  function handleAppMessage(text, username) {
    const session = runtime.session;
    if (!session?.brain) return;
    const clean = String(text || "").trim().slice(0, 400);
    if (!clean) return;
    const speaker = /^[A-Za-z0-9_]{1,16}$/.test(String(username || "")) ? username : "app";
    const command = parseCommand(clean, cfg.agent.botName, cfg.commands?.custom);
    if (command && command.type !== "direct") {
      void applyCommand(session, command, speaker, "app").catch((err) => log(`[app] ${sanitizeForLog(err?.message || err)}`));
      return;
    }
    const body = command?.type === "direct" ? command.text : clean;
    session.brain.resume();
    try {
      session.brain.mantella?.onPlayerChat(speaker, body);
    } catch {
      /* memory is best effort */
    }
    session.brain.queueCommand(
      `Игрок ${speaker} сказал тебе: «${body}». Ответь как персонаж в поле say (коротко, по-русски). ` +
        `Если просят действие — сделай action; если просто разговор — say + idle/look/follow по смыслу.`,
      speaker
    );
    log(`[app] from ${speaker}: ${sanitizeForLog(body, 120)}`);
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

    const session = { bot, brain: null, mcData: null, ended: false, statusTimer: null };
    runtime.session = session;
    bridge.emit("lifecycle", { state: "connecting", host: cfg.minecraft.host, port: cfg.minecraft.port });

    // Mirror everything the bot writes to chat into the app feed; brain speech is flagged for TTS.
    // bot.chat only exists once the chat plugin is injected at login.
    bot.once("login", () => {
      if (typeof bot.chat !== "function" || bot.__chatMirrored) return;
      const rawChat = bot.chat.bind(bot);
      bot.__chatMirrored = true;
      bot.chat = (text) => {
        const speech = bot.__speechNext === true;
        bot.__speechNext = false;
        bridge.emit("say", { text: String(text ?? "").slice(0, 256), speech });
        return rawChat(text);
      };
    });

    bot.on("kicked", (reason) => {
      log(`Kicked: ${JSON.stringify(reason).slice(0, 500)}`);
      bridge.emit("lifecycle", { state: "kicked", message: JSON.stringify(reason).slice(0, 300) });
    });
    bot.on("death", () => bridge.emit("event", { kind: "death", text: "погиб" }));
    bot.on("error", (err) => log(`Bot error: ${err?.message || "unknown error"}`));
    bot.on("end", (reason) => {
      if (session.ended) return;
      session.ended = true;
      stopSession(session);
      if (runtime.session === session) runtime.session = null;
      log(`Disconnected: ${reason}`);
      bridge.emit("lifecycle", { state: "disconnected", message: String(reason || "") });
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
      if (username === bot.username) return;
      bridge.emit("chat", { username, message: String(message ?? "").slice(0, 256), source: "player" });
      handleIncoming(session, username, message, "player");
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
    bridge.emit("lifecycle", { state: "exiting" });
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
    const command = parseCommand(text.startsWith("!") ? text : `!${text}`, cfg.agent.botName, cfg.commands?.custom);
    if (!command) return;
    void applyCommand(runtime.session, command, "console", "console").catch((err) => {
      log(`[console] ${sanitizeForLog(err?.message || err)}`);
    });
  });

  /** Live update from the app after the user edits the character or commands. */
  function applyReconfigure(patch) {
    const session = runtime.session;
    const agent = patch.agent && typeof patch.agent === "object" ? patch.agent : {};
    if (typeof agent.persona === "string") cfg.agent.persona = agent.persona.slice(0, 6000);
    if (agent.foodPreferences && typeof agent.foodPreferences === "object") {
      const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && /^[a-z0-9_]{1,64}$/.test(x)).slice(0, 64) : []);
      cfg.agent.foodPreferences = { favorite: ids(agent.foodPreferences.favorite), hated: ids(agent.foodPreferences.hated) };
      setFoodPreferences(cfg.agent.foodPreferences);
    }
    if (Number.isInteger(agent.tickMs) && agent.tickMs >= 1000 && agent.tickMs <= 3600000) cfg.agent.tickMs = agent.tickMs;
    const users = (v) =>
      Array.isArray(v) ? v.filter((n) => n === "*" || /^[A-Za-z0-9_]{1,16}$/.test(String(n))).slice(0, 32) : null;
    const controllers = users(agent.controllerUsers);
    if (controllers?.length) cfg.agent.controllerUsers = controllers;
    const chatters = users(agent.chatUsers);
    if (chatters?.length) cfg.agent.chatUsers = chatters;
    if (patch.commands && Array.isArray(patch.commands.custom)) {
      cfg.commands = { ...(cfg.commands || {}), custom: normalizeCustomCommands(patch.commands.custom) };
    }
    if (session?.brain) {
      if (typeof agent.mode === "string") {
        try {
          session.brain.setMode(agent.mode);
        } catch {
          /* keep current mode */
        }
      }
      if (typeof agent.goal === "string" && agent.goal.trim() && agent.goal !== session.brain.goal) {
        session.brain.setGoal(agent.goal);
      }
    }
    const combatMode = patch.combat?.mode;
    if (typeof combatMode === "string" && session?.combat) {
      try {
        session.combat.setMode(combatMode);
      } catch {
        /* keep current combat mode */
      }
    }
    log(`[app] reconfigured: persona=${cfg.agent.persona.length}ch commands=${cfg.commands?.custom?.length ?? 0} tick=${cfg.agent.tickMs}ms`);
    bridge.emit("reconfigured", { commands: cfg.commands?.custom?.length ?? 0 });
  }

  bridge.onMessage((message) => {
    switch (message.type) {
      case "reconfigure":
        try {
          applyReconfigure(message);
        } catch (err) {
          log(`[app] reconfigure rejected: ${sanitizeForLog(err?.message || err)}`);
        }
        break;
      case "console":
        rl.emit("line", String(message.text || ""));
        break;
      case "player-say":
        handleAppMessage(message.text, message.username);
        break;
      case "shutdown":
        void shutdown(0);
        break;
      default:
        break;
    }
  });
  bridge.onDisconnect(() => void shutdown(0));

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  connectBot();
}

main().catch((err) => {
  console.error(sanitizeForLog(err?.message || err, 1000));
  process.exit(1);
});
