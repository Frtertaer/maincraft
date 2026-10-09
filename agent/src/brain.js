import { extractJsonObject } from "./llm.js";
import { buildWorldState, stateToText } from "./world.js";
import { executeAction } from "./actions.js";
import { MantellaConversation } from "./mantella/conversation.js";
import { legalVerbs, resolveVerb, parseInventory, gateDecision } from "./controller/index.js";
import { createLocalController } from "./controller/local.js";

const SYSTEM_RU = `Ты — Opus, автономный персонаж в Minecraft Java.
Ты управляешь ботом через JSON-действие (одно за шаг).
Отвечай ТОЛЬКО валидным JSON-объектом без markdown-обёртки (или с \`\`\`json).

Формат:
{
  "think": "кратко что видишь и план",
  "say": "что сказать в чат игрокам (или null)",
  "goal": "текущая цель одной фразой (или оставь прежнюю)",
  "plan": ["2-8 коротких проверяемых подцелей; сохраняй и обновляй по мере выполнения"],
  "command_done": false,
  "action": { "type": "...", ... }
}

Доступные action.type:
- chat: { "type":"chat", "text":"..." }
- wait: { "type":"wait", "ms":1000 }
- stop: { "type":"stop" }
- idle / none: ничего не делать
- goto: { "type":"goto", "x":0, "y":64, "z":0, "range":1 }
- follow: { "type":"follow", "player":"Nick", "distance":3 }  // без player — ближайший
- come: { "type":"come", "player":"Nick" }
- dig: { "type":"dig", "block":"oak_log" } или coords x,y,z
- collect: { "type":"collect", "block":"oak_log", "count":8 }
- craft: { "type":"craft", "item":"crafting_table", "count":1 }
- equip: { "type":"equip", "item":"wooden_pickaxe", "destination":"hand" }
- toss: { "type":"toss", "item":"cobblestone", "count":16 }
- eat: { "type":"eat" }
- attack: LLM-запрос на бой (рефлексы уже бьют хостов каждые ~50ms без API); { "type":"attack", "name":"zombie", "maxDurationMs":12000, "maxDistance":16 }. Для PvP/угроз не жди LLM — combat-reflex уже ведёт melee.
- smelt: { "type":"smelt", "input":"raw_iron", "output":"iron_ingot", "fuel":"coal", "count":3 }
- use_item: активировать предмет в руке { "type":"use_item", "item":"ender_eye", "x":..,"y":..,"z":..,"durationMs":120 }
- use_block: активировать УЖЕ существующий блок рукой/предметом { "type":"use_block", "block":"obsidian", "item":"flint_and_steel", "x":..,"y":..,"z":..,"face":"top" }; это НЕ ставит item как новый блок
- sleep / wake: { "type":"sleep" }
- container_list: { "type":"container_list", "block":"chest" }
- container_take: { "type":"container_take", "block":"chest", "item":"iron_ingot", "count":3 }
- container_put: { "type":"container_put", "block":"chest", "item":"cobblestone", "count":16 }
- place: { "type":"place", "item":"cobblestone", "x":..,"y":..,"z":.. }
- look: { "type":"look", "x":..,"y":..,"z":.. }

Правила:
1. Если есть приказ игрока (pending_command) — выполни его в приоритете.
2. Режим observe: почти не действуй, только say/опиши, idle.
3. Режим listen: действуй только по команде, иначе idle.
4. Режим hybrid/auto: развивайся (дерево→верстак→инструменты→убежище), но слушай приказы.
5. Не выдумывай блоки/предметы которых нет рядом или в инвентаре.
6. Имена блоков/предметов — minecraft id на английском (oak_log, cobblestone...).
7. say — коротко по-русски ИЛИ null. По умолчанию null. Не болтай каждый тик.
8. Если HP низкое или ночь и нет укрытия — приоритет безопасность.
9. Одно действие за шаг. Не пиши код. Используй точные pos/delta из world, не угадывай координаты.
10. Если есть pending_command, держи command_done=false, пока выполнена не одна операция, а весь приказ. При полном выполнении поставь true.
11. Сначала container_list, если содержимое контейнера неизвестно. Проверяй result прошлого действия и меняй план после ошибки.
12. Успешный use_block подтверждает только активацию, а не размещение или изменение мира. Для установки блока используй place и проверяй его result.
13. Не ставь command_done=true, пока результат действия и world/inventory наблюдаемо не подтверждают весь приказ.
14. Не заявляй, что Minecraft пройден, без наблюдаемого подтверждения победы; доступные primitives ещё не гарантируют убийство дракона.
15. Если приложен JPEG first-person POV (vision_attached=true): опиши в think что реально видно на кадре; кадр — синтетический raycast (цвета приблизительные, без текстур/мобов). Координаты и имена блоков всё равно бери из world/JSON, а не «с пальца» по картинке.
16. Vision не заменяет world state: картинка помогает ориентироваться (стена, проём, дерево, лава, небо), а goto/dig/place — только с числами из world.
17. Бой: локальный combat-reflex (не ты) уже атакует враждебных мобов ~50ms. Ты — стратег: еда, броня, бегство, цели. Не трать каждый шаг на attack, если world.combat_reflex уже engaged.`;

const COMPANION_EXTRA = `
Режим COMPANION (отдельный персонаж в мире, как «живой спутник»):
- Ты не «скрипт прохождения». Ты персонаж рядом с игроком.
- МОЛЧАНИЕ ПО УМОЛЧАНИЮ: в большинстве тиков "say": null. Действуй action без болтовни.
- Говори ТОЛЬКО если: (а) игрок только что написал (pending_command), (б) опасность/смерть/низкое HP, (в) закончил задачу и есть новая новость. 1 короткая фраза.
- ЗАПРЕЩЕНО: повторять смысл прошлых реплик (recent_says / history). Не «я рядом / дерево / укрытие / привет» по кругу.
- Если нечего нового сказать — "say": null и action idle/follow/goto/dig. Тишина нормальна.
- Когда игрок пишет — ответь один раз в say (1 предложение), не продолжай монолог следующие тики.
- Просьбы «иди / за мной / добудь» — action, say максимум одно «ок» или null.
- Не притворяйся, что видишь то, чего нет в world/vision.
- Имена: обращайся к игроку по username из pending_from, если есть.
`;

export function sanitizePlan(value, maxItems = 8) {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => String(item || "").trim().slice(0, 180))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function usageTokenCount(usage) {
  const fields = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  return fields.reduce((sum, field) => {
    const value = Number(usage?.[field]);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

/** Normalize chat line for anti-repeat (lowercase, strip punct). */
export function normalizeSay(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if two say-lines are effectively the same monologue. */
export function isSimilarSay(a, b) {
  const na = normalizeSay(a);
  const nb = normalizeSay(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 12 && longer.includes(shorter)) return true;
  // shared prefix (common spam: "я рядом, steve. …")
  const prefixLen = Math.min(28, shorter.length, longer.length);
  if (prefixLen >= 16 && shorter.slice(0, prefixLen) === longer.slice(0, prefixLen)) return true;
  const ta = new Set(na.split(" ").filter((w) => w.length > 2));
  const tb = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  // Coverage of the shorter phrase: catches "я рядом…дерево" variants
  const coverage = inter / Math.min(ta.size, tb.size);
  return jaccard >= 0.5 || (inter >= 3 && coverage >= 0.7);
}

/**
 * Gate chat spam. playerTriggered = reply to player command/chat.
 * minGapTicks = min ticks between unsolicited lines (default 6).
 */
export function decideSayEmission({ text, recentSays = [], lastSayTick = -999, tick = 0, playerTriggered = false, minGapTicks = 6 }) {
  const spoken = String(text || "").trim().slice(0, 256);
  if (!spoken || spoken.toLowerCase() === "null") {
    return { ok: false, reason: "empty", text: null };
  }
  if (recentSays.some((prev) => isSimilarSay(spoken, prev))) {
    return { ok: false, reason: "duplicate", text: spoken };
  }
  if (!playerTriggered && tick - lastSayTick < minGapTicks) {
    return { ok: false, reason: "rate_limit", text: spoken };
  }
  return { ok: true, reason: "emit", text: spoken };
}

export class Brain {
  constructor({ bot, llm, cfg, mcData, log }) {
    this.bot = bot;
    this.llm = llm;
    this.cfg = cfg;
    this.mcData = mcData;
    this.log = log || console.log;
    this.mode = cfg.agent.mode || "hybrid";
    this.goal = "осмотреться и начать выживание";
    this.plan = ["оценить безопасность и ресурсы", "добыть дерево", "сделать базовые инструменты"];
    this.lastThink = null;
    this.visionEnabled = Boolean(cfg.vision?.enabled);
    this.paused = false;
    this.suspended = false;
    this.pendingCommand = null;
    this.pendingFrom = null;
    this.commandTurns = 0;
    this.commandQueue = [];
    this.lastAction = null;
    this.lastError = null;
    this.history = [];
    /** Recent spoken lines (normalized) for anti-spam. */
    this.recentSays = [];
    this.lastSayTick = -999;
    this.tick = 0;
    this.requestCount = 0;
    this.totalTokens = 0;
    this.requestLimit = configuredLimit(cfg.api?.maxRequestsPerSession);
    this.tokenLimit = configuredLimit(cfg.api?.maxTotalTokens);
    this._budgetNotified = false;
    this.running = false;
    this._timer = null;
    this.combat = null;
    this.mantella = null;
    // Fast per-tick controller (Jev/Laya/local). When set, Opus becomes an
    // async planner and the controller fills the ticks between calls.
    this.controller = null;
    this._localController = null;
    this.controllerTargets = [];
    this.controllerConsecutiveFails = 0;
    this.plannerConsecutiveFails = 0;
    this._verbCooldowns = new Map();
    this.waypoint = null;
    this.container = null;
    this.lastPlannerTick = -999;
    this._plannerBusy = false;
    if (cfg.mantella?.enabled || cfg.agent?.companionMode) {
      this.mantella = new MantellaConversation({ bot, cfg, log: this.log, llm: this.llm, mcData: this.mcData });
      this.log(
        `[mantella] memory world=${cfg.mantella?.worldId || "local"} char=${cfg.agent?.botName || "Opus"} tts=${cfg.mantella?.tts || "none"}`
      );
    }
  }

  getState() {
    return {
      mode: this.mode,
      goal: this.goal,
      plan: this.plan,
      lastThink: this.lastThink,
      activeCommand: this.pendingCommand
        ? { text: this.pendingCommand, from: this.pendingFrom, turns: this.commandTurns }
        : null,
      commandQueueLength: this.commandQueue.length,
      visionEnabled: this.visionEnabled,
      lastAction: this.lastAction,
      lastError: this.lastError,
      paused: this.paused,
      controller: this.controller
        ? {
            type: this.controller.type,
            targets: this.controllerTargets,
            waypoint: this.waypoint,
            lastPlannerTick: this.lastPlannerTick,
            fails: this.controllerConsecutiveFails,
          }
        : null,
      budget: {
        requestsUsed: this.requestCount,
        requestLimit: Number.isFinite(this.requestLimit) ? this.requestLimit : null,
        tokensUsed: this.totalTokens,
        tokenLimit: Number.isFinite(this.tokenLimit) ? this.tokenLimit : null,
      },
    };
  }

  setMode(mode) {
    const allowed = ["auto", "hybrid", "listen", "observe"];
    if (!allowed.includes(mode)) throw new Error(`mode must be ${allowed.join("|")}`);
    this.mode = mode;
  }

  setGoal(goal) {
    this.goal = String(goal || "").slice(0, 300);
  }

  queueCommand(text, from = "player") {
    const command = String(text || "").trim().slice(0, 500);
    if (!command) return false;
    // index.js already stops movement synchronously; do not leave a stale stop order for resume.
    if (this.paused && /^stop all actions now$/i.test(command)) return false;
    const queued = { text: command, from: String(from || "player"), queuedAtTick: this.tick };
    if (!this.pendingCommand) {
      this._activateCommand(queued);
    } else {
      this.commandQueue.push(queued);
      if (this.commandQueue.length > 8) this.commandQueue.shift();
    }
    return true;
  }

  _activateCommand(command) {
    this.pendingCommand = command?.text || null;
    this.pendingFrom = command?.from || null;
    this.commandTurns = 0;
  }

  completeActiveCommand() {
    const completed = this.pendingCommand;
    const next = this.commandQueue.shift() || null;
    this._activateCommand(next);
    return completed;
  }

  _recordSay(text) {
    const norm = normalizeSay(text);
    if (!norm) return;
    this.recentSays.push(norm);
    if (this.recentSays.length > 10) this.recentSays.shift();
    this.lastSayTick = this.tick;
  }

  /** Speak once, record for anti-spam. Returns true if sent. */
  _emitSay(text) {
    const spoken = String(text || "").trim().slice(0, 256);
    if (!spoken) return false;
    try {
      this.bot.chat(spoken);
    } catch {
      return false;
    }
    this._recordSay(spoken);
    try {
      this.mantella?.onCompanionSay(spoken);
    } catch {
      /* ignore */
    }
    return true;
  }

  setController(controller) {
    this.controller = controller;
    if (controller) this.log(`[controller] enabled type=${controller.type}`);
  }

  pause() {
    this.paused = true;
    try {
      this.bot.pathfinder?.setGoal(null);
      this.bot.clearControlStates();
    } catch {
      /* ignore */
    }
  }

  resume() {
    this.paused = false;
  }

  suspend() {
    this.suspended = true;
    try {
      this.bot.pathfinder?.setGoal(null);
      this.bot.clearControlStates();
    } catch {
      /* ignore */
    }
  }

  unsuspend() {
    this.suspended = false;
  }

  _budgetError() {
    if (this.requestCount >= this.requestLimit) {
      return `LLM request limit reached (${this.requestCount}/${this.requestLimit})`;
    }
    if (this.totalTokens >= this.tokenLimit) {
      return `LLM token limit reached (${this.totalTokens}/${this.tokenLimit})`;
    }
    return null;
  }

  _pauseForBudget(reason) {
    this.lastError = reason;
    this.pause();
    this.log(`[brain] ${reason}; agent paused`);
    if (!this._budgetNotified) {
      this._budgetNotified = true;
      try {
        this.bot.chat(`Opus paused: ${reason}`.slice(0, 256));
      } catch {
        /* ignore */
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.step();
      } catch (err) {
        this.lastError = err.message || String(err);
        this.log(`[brain] step error: ${this.lastError}`);
      }
      this._timer = setTimeout(loop, this.cfg.agent.tickMs || 4000);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
  }

  async step() {
    this.tick += 1;
    if (this.paused || this.suspended) return;
    if (!this.bot.entity) return;
    const budgetError = this._budgetError();
    if (budgetError) {
      this._pauseForBudget(budgetError);
      return;
    }

    const hasCommand = Boolean(this.pendingCommand);
    const activeCommandText = this.pendingCommand;
    // Mantella pc_to_npc: NPC talks only on a player turn — never monologue every tick.
    // See vendor/Mantella conversation_continue_type PLAYER_TALK / NPC_TALK.
    const mantellaTurnBased =
      Boolean(this.cfg.agent?.companionMode || this.cfg.mantella?.enabled) &&
      this.cfg.mantella?.turnBased !== false;
    if (mantellaTurnBased && !hasCommand) {
      return;
    }
    if (this.mode === "listen" && !hasCommand && this.cfg.agent.idleWhenNoGoal) {
      return;
    }
    if (this.mode === "observe" && !hasCommand) {
      // rare status only every ~8 ticks
      if (this.tick % 8 !== 0) return;
    }

    const world = buildWorldState(this.bot, this.getState());
    if (this.combat?.getStats) {
      world.combat_reflex = this.combat.getStats();
    }
    // When under fire or engaged, tell reflex to hold focus; brain still plans resources.
    if (this.combat && Number(this.bot.health) < 14) {
      try {
        this.combat.engage({ holdMs: 6000 });
      } catch {
        /* ignore */
      }
    }

    if (this.controller) {
      const every = this.cfg.controller?.plannerEveryTicks || 8;
      const plannerDue = this.tick === 1 || this.tick - this.lastPlannerTick >= every;
      if (hasCommand && !this._plannerBusy && this.plannerConsecutiveFails < 3) {
        // Player commands need the full planner (free-form action space).
        // After 3 straight planner failures let the controller keep driving
        // instead of stalling on a dead API; a later background run resets it.
        this.lastPlannerTick = this.tick;
        return this._plannerStep(world);
      }
      if (plannerDue && !this._plannerBusy) {
        this.lastPlannerTick = this.tick;
        this._plannerBusy = true;
        this._plannerStep(world)
          .catch((err) => {
            this.lastError = `planner error: ${err?.message || err}`;
            this.log(`[brain] ${this.lastError}`);
          })
          .finally(() => {
            this._plannerBusy = false;
          });
      }
      return this._controllerStep(world);
    }

    return this._plannerStep(world);
  }

  /**
   * The slow mind: one Opus call producing say/goal/plan/targets/waypoint
   * plus a full-power action. Runs on command ticks and every Nth tick
   * when a controller is enabled (then it may also run in the background).
   */
  async _plannerStep(world) {
    const hasCommand = Boolean(this.pendingCommand);
    const activeCommandText = this.pendingCommand;
    const useVision =
      this.visionEnabled &&
      this.cfg.vision?.enabled !== false &&
      this.tick % (this.cfg.vision.everyNTicks || 3) === 0;

    let imageBase64 = null;
    if (useVision && this.getVisionFrame) {
      try {
        imageBase64 = await this.getVisionFrame();
      } catch (err) {
        this.log(`[vision] capture failed: ${err.message}`);
      }
    }

    const userPayload = {
      tick: this.tick,
      mode: this.mode,
      goal: this.goal,
      plan: this.plan,
      last_think: this.lastThink,
      pending_command: this.pendingCommand,
      pending_from: this.pendingFrom,
      pending_command_turns: this.commandTurns,
      queued_commands: this.commandQueue.length,
      recent: this.history.slice(-6),
      // What we already said — do NOT rephrase these
      recent_says: this.recentSays.slice(-6),
      speak_policy:
        "say=null by default. Speak only for new player message, danger, or real news. Never repeat recent_says.",
      world,
      vision_attached: Boolean(imageBase64),
    };

    const visionNote = imageBase64
      ? "К сообщению приложен JPEG first-person POV бота (синтетический raycast). Используй кадр вместе с world state.\n\n"
      : "";
    const promptText =
      visionNote +
      "Состояние Minecraft-бота и приказы. Верни JSON с action.\n\n" +
      stateToText(userPayload);

    this.log(`[brain] tick=${this.tick} mode=${this.mode} vision=${Boolean(imageBase64)} goal="${this.goal}"`);

    const persona = String(this.cfg.agent?.persona || "").trim();
    const companion = Boolean(this.cfg.agent?.companionMode);
    let system = SYSTEM_RU;
    if (companion) system = SYSTEM_RU + "\n" + COMPANION_EXTRA;
    if (persona) system += `\n\nPersona / характер:\n${persona.slice(0, 800)}`;
    if (this.controller) {
      system +=
        "\n\nКонтроллер: между твоими вызовами быстрый локальный контроллер исполняет " +
        "ограниченный набор действий (collect/dig/craft/place/goto/flee/eat/attack/...). " +
        'Дополнительно верни "targets": [minecraft id предметов/блоков, над которыми работать ' +
        'ближайшие ~30 сек] и "waypoint": {x,y,z} или null.';
    }

    // Mantella-style long-term memory + world context block
    let mantellaBlock = "";
    if (this.mantella) {
      try {
        const extras = this.mantella.buildPromptExtras(this.bot, {
          botName: this.cfg.agent?.botName,
          persona,
          lastPlayerName: this.pendingFrom,
        });
        mantellaBlock = "\n\n--- Mantella-context (память и мир) ---\n" + extras.text;
      } catch (err) {
        this.log(`[mantella] context failed: ${err?.message || err}`);
      }
    }

    const fullUserText = promptText + mantellaBlock;

    this.requestCount += 1;
    let result;
    try {
      result = imageBase64
        ? await this.llm.messagesWithImage({
            system,
            text: fullUserText,
            imageBase64,
            mediaType: "image/jpeg",
          })
        : await this.llm.messages({
            system,
            messages: [{ role: "user", content: fullUserText }],
          });
    } catch (err) {
      this.plannerConsecutiveFails += 1;
      this.lastError = `planner llm failed: ${err?.message || err}`;
      this.log(`[brain] ${this.lastError} (streak=${this.plannerConsecutiveFails})`);
      return;
    }
    this.totalTokens += usageTokenCount(result.usage);

    const parsed = extractJsonObject(result.text);
    if (!parsed) {
      this.plannerConsecutiveFails += 1;
      this.lastError = "LLM returned non-JSON";
      this.log(`[brain] bad JSON (streak=${this.plannerConsecutiveFails}): ${result.text.slice(0, 200)}`);
      return;
    }
    this.plannerConsecutiveFails = 0;

    if (parsed.goal) this.goal = String(parsed.goal).slice(0, 300);
    const nextPlan = sanitizePlan(parsed.plan);
    if (nextPlan) this.plan = nextPlan;
    if (parsed.think) this.lastThink = String(parsed.think).slice(0, 500);
    if (this.controller && Array.isArray(parsed.targets)) {
      this.controllerTargets = parsed.targets
        .map((t) => String(t || "").toLowerCase().trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 12);
    }
    if (this.controller && parsed.waypoint !== undefined) {
      const w = parsed.waypoint;
      this.waypoint =
        w && typeof w === "object" && [w.x, w.y, w.z].every((v) => Number.isFinite(Number(v)))
          ? { x: Number(w.x), y: Number(w.y), z: Number(w.z) }
          : null;
    }

    // Only the first tick of a new command/chat may speak freely.
    // Later ticks (follow loop, multi-step) go through rate-limit + dedup.
    const playerTriggered = Boolean(hasCommand) && this.commandTurns === 0;
    const minGapTicks = Number(this.cfg.agent?.minSayGapTicks ?? (this.cfg.agent?.companionMode ? 8 : 4));
    let didSpeak = false;
    if (parsed.say != null && String(parsed.say).trim() && String(parsed.say).trim().toLowerCase() !== "null") {
      const decision = decideSayEmission({
        text: parsed.say,
        recentSays: this.recentSays,
        lastSayTick: this.lastSayTick,
        tick: this.tick,
        playerTriggered,
        minGapTicks,
      });
      if (decision.ok) {
        didSpeak = this._emitSay(decision.text);
      } else {
        this.log(`[brain] suppressed say (${decision.reason}): ${String(decision.text || "").slice(0, 80)}`);
      }
    }

    const action = parsed.action || { type: "idle" };
    if (action.type === "set_goal" && (action.goal || action.text)) {
      this.goal = String(action.goal || action.text);
    }

    // observe: only allow chat/idle/wait unless explicit command
    if (this.mode === "observe" && !hasCommand) {
      const t = String(action.type || "").toLowerCase();
      if (!["chat", "say", "idle", "none", "wait", "look"].includes(t)) {
        action.type = "idle";
      }
    }

    // If action is chat/say — same gate; emit once via _emitSay, never double-post
    const actionType = String(action.type || "").toLowerCase();
    if (actionType === "chat" || actionType === "say") {
      const chatText = action.text || action.message || action.say;
      if (!didSpeak) {
        const decision = decideSayEmission({
          text: chatText,
          recentSays: this.recentSays,
          lastSayTick: this.lastSayTick,
          tick: this.tick,
          playerTriggered,
          minGapTicks,
        });
        if (decision.ok) {
          didSpeak = this._emitSay(decision.text);
        } else {
          this.log(`[brain] suppressed action.chat (${decision.reason})`);
        }
      }
      action.type = "idle";
      delete action.text;
    }

    this.log(`[brain] think=${(parsed.think || "").slice(0, 120)} action=${JSON.stringify(action)}`);
    const exec = await executeAction(this.bot, action, this.mcData);
    this.lastAction = { action, result: exec, usage: result.usage, model: result.model };
    this.lastError = exec.ok ? null : exec.message;

    this.history.push({
      t: this.tick,
      cmd: activeCommandText,
      think: this.lastThink,
      action,
      result: exec.message,
      ok: exec.ok,
      commandDone: parsed.command_done === true,
    });
    if (this.history.length > (this.cfg.agent.maxHistory || 16)) {
      this.history.shift();
    }

    // Keep a multi-step command active until the model explicitly confirms the
    // whole order is complete (or reaches an idle completion / safety bound).
    if (hasCommand) {
      this.commandTurns += 1;
      const actionDoneType = String(action.type || "").toLowerCase();
      const isSocialChat = /сказал в игровом чате/i.test(String(activeCommandText || ""));
      const socialChitChatDone =
        isSocialChat &&
        didSpeak &&
        this.commandTurns === 1 &&
        ["idle", "none", "wait", "look"].includes(actionDoneType);
      if (exec.ok && (parsed.command_done === true || socialChitChatDone)) {
        this.completeActiveCommand();
      } else if (this.commandTurns >= 64) {
        this.lastError = `command safety limit reached: ${activeCommandText}`;
        this.completeActiveCommand();
      }
    }
  }

  /**
   * The fast mind: ask the controller for ONE bounded verb, gate it
   * (safe + confidence), resolve it to a concrete executeAction action
   * from world state only, run it. Never lets the model emit coordinates
   * or free-form commands.
   */
  async _controllerStep(world) {
    const c = this.cfg.controller || {};
    const ctx = {
      world,
      goal: this.goal,
      plan: this.plan,
      targets: this.controllerTargets,
      waypoint: this.waypoint,
      inventory: parseInventory(world),
      container: this.container,
      passive: this.mode === "observe",
      mcData: this.mcData,
    };
    ctx.legal = legalVerbs(ctx);
    // Verbs that just failed cool down briefly so the controller does not
    // re-issue the same failing action every tick (observed: failing craft
    // retried ~15 ticks straight). wait/flee never cool down (safety).
    const decideCtx = {
      ...ctx,
      legal: ctx.legal.filter((v) => {
        if (v.id === "wait" || v.id === "flee") return true;
        const until = this._verbCooldowns.get(v.id);
        return !(Number.isFinite(until) && until > this.tick);
      }),
    };

    let decision;
    try {
      decision = await this.controller.decide(decideCtx);
      this.controllerConsecutiveFails = 0;
    } catch (err) {
      this.controllerConsecutiveFails += 1;
      this.log(
        `[controller] ${this.controller.type} failed (${this.controllerConsecutiveFails}): ` +
          String(err?.message || err).slice(0, 120)
      );
      if (c.fallbackToLocal !== false) {
        if (!this._localController) this._localController = createLocalController();
        try {
          decision = await this._localController.decide(decideCtx);
        } catch {
          decision = { choice: "wait", confidence: 1, safe: true, urgency: 0, source: "fallback-error" };
        }
      } else {
        decision = { choice: "wait", confidence: 1, safe: true, urgency: 0, source: "controller-error" };
      }
    }

    const gate = gateDecision(decision, c);
    const verbId = gate.ok
      ? decision.choice
      : gate.override === "flee" && ctx.legal.some((v) => v.id === "flee")
        ? "flee"
        : "wait";
    const action = resolveVerb(verbId, ctx);
    this.log(
      `[controller] t=${this.tick} verb=${verbId} conf=${Number(decision.confidence || 0).toFixed(2)} ` +
        `urg=${decision.urgency} src=${decision.source}${gate.ok ? "" : ` gate=${gate.reason}`} ` +
        `-> ${JSON.stringify(action).slice(0, 120)}`
    );

    const exec = await executeAction(this.bot, action, this.mcData);
    this.lastAction = { action, result: exec, controller: decision.source };
    this.lastError = exec.ok ? null : exec.message;
    if (!exec?.ok && verbId !== "wait" && verbId !== "flee") {
      this._verbCooldowns.set(verbId, this.tick + 10);
    } else if (exec?.ok) {
      this._verbCooldowns.delete(verbId);
    }

    if (exec?.ok && action.type === "container_list" && Array.isArray(exec.meta?.contents)) {
      this.container = {
        block: action.block || "container",
        items: parseInventory({ inventory: exec.meta.contents }),
      };
    }

    this.history.push({
      t: this.tick,
      src: decision.source,
      action,
      result: exec.message,
      ok: exec.ok,
    });
    if (this.history.length > (this.cfg.agent.maxHistory || 16)) {
      this.history.shift();
    }
  }
}

function configuredLimit(value) {
  if (value == null || value === "") return Infinity;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : Infinity;
}
