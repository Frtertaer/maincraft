import { parseCommand, HELP_TEXT } from "./commands.js";
import { extractJsonObject, LlmClient } from "./llm.js";
import { parseDialogueReply, dialogueActionToAction, MantellaConversation } from "./mantella/conversation.js";
import {
  computeCraftPlan,
  executeAction,
  normalizeActionCount,
  selectNearestCombatTarget,
  pickBestFood,
} from "./actions.js";
import { buildWorldState, isHazardBlockName, isHostileMobName, spatialSnapshot } from "./world.js";
import {
  Brain,
  sanitizePlan,
  usageTokenCount,
  normalizeSay,
  isSimilarSay,
  decideSayEmission,
} from "./brain.js";
import { renderBotPov } from "./vision-render.js";
import { createVisionProvider } from "./vision.js";
import { validateConfig } from "./config.js";
import { isBossMobName } from "./boss-combat.js";
import { legalVerbs, resolveVerb, parseInventory } from "./controller/verbs.js";
import { readDecision, gateDecision, compactState, createController } from "./controller/index.js";
import { createLocalController } from "./controller/local.js";
import { Vec3 } from "vec3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    console.log("FAIL", name, detail);
  }
}

const commandCases = [
  ["!help", "help"],
  ["!mode observe", "mode"],
  ["Opus, добудь дерево", "direct"],
  ["!goal построй дом", "goal"],
  ["!vision on", "vision"],
  ["привет", null],
];

for (const [message, expected] of commandCases) {
  const parsed = parseCommand(message, "Opus");
  check(`parse ${message}`, (parsed?.type ?? null) === expected, `got=${parsed?.type} expected=${expected}`);
}

const json = extractJsonObject('here {"action":{"type":"idle"}} end');
check("extract JSON", json?.action?.type === "idle");

const craft = computeCraftPlan({ result: { count: 4 } }, 8);
check("craft repetitions", craft?.repetitions === 2 && craft.expectedOutput === 8, JSON.stringify(craft));
check("craft invalid count", normalizeActionCount(-3, 1, 64) === null);

let recipeQuery = null;
let craftCall = null;
const recipe = { result: { count: 4 } };
const craftInventory = { items: [] };
const craftBot = {
  inventory: {
    items() {
      return craftInventory.items;
    },
  },
  recipesFor(itemId, metadata, minResultCount, table) {
    recipeQuery = { itemId, metadata, minResultCount, table };
    return [recipe];
  },
  async craft(selectedRecipe, repetitions, table) {
    craftCall = { selectedRecipe, repetitions, table };
    const made = (selectedRecipe.result?.count || 1) * repetitions;
    const held = craftInventory.items.find((i) => i.name === "stick");
    if (held) held.count += made;
    else craftInventory.items.push({ name: "stick", count: made });
  },
};
const craftResult = await executeAction(
  craftBot,
  { type: "craft", item: "stick", count: 8 },
  { itemsByName: { stick: { id: 280 } }, blocksByName: {} }
);
check(
  "craft action uses output count",
  craftResult.ok && craftCall?.repetitions === 2 && craftInventory.items[0]?.count === 8,
  JSON.stringify({ craftResult, recipeQuery, craftCall })
);

const origin = { x: 0, y: 64, z: 0 };
const entities = {
  1: { id: 1, type: "player", username: "Alice", position: { x: 1, y: 64, z: 0 } },
  2: { id: 2, type: "mob", name: "zombie", position: { x: 7, y: 64, z: 0 } },
  3: { id: 3, type: "mob", name: "zombie", position: { x: 3, y: 64, z: 0 } },
};
const target = selectNearestCombatTarget(entities, origin, {
  name: "zombie",
  maxDistance: 16,
  selfUsername: "OpusBot",
});
check("nearest safe combat target", target?.id === 3);
check(
  "players rejected by default",
  selectNearestCombatTarget(entities, origin, { name: "Alice", maxDistance: 16 }) === null
);

const spatial = spatialSnapshot(origin, { x: 3.04, y: 65, z: 4.02 });
check("spatial coordinates", spatial.pos.x === 3 && spatial.delta.y === 1 && spatial.dist === 5.1, JSON.stringify(spatial));
check("hazard classification", isHazardBlockName("lava") && isHazardBlockName("magma_block"));
check("hostile classification", isHostileMobName("blaze") && isHostileMobName("ender_dragon"));

const combatCmd = parseCommand("!combat hold", "Opus");
check("parse combat hold", combatCmd?.type === "combat" && combatCmd.mode === "hold");
const combatOff = parseCommand("!combat off", "Opus");
check("parse combat off", combatOff?.type === "combat" && combatOff.mode === "off");

const foodBot = {
  inventory: {
    items: () => [{ name: "cooked_beef" }, { name: "dirt" }],
  },
};
check("pickBestFood prefers cooked_beef", pickBestFood(foodBot)?.name === "cooked_beef");

check("boss names", isBossMobName("warden") && isBossMobName("wither") && isBossMobName("ender_dragon"));

const worldBot = {
  username: "OpusBot",
  entity: {
    position: new Vec3(0, 64, 0),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: true,
    isInWater: false,
  },
  entities: {},
  inventory: { items: () => [] },
  findBlocks: () => [],
  blockAt: (position) => ({ name: position.y < 64 ? "stone" : "air", position, biome: 1 }),
  time: { timeOfDay: 1000, isDay: true },
  isRaining: false,
  health: 20,
  food: 20,
  oxygenLevel: 20,
  heldItem: null,
  isSleeping: false,
  game: { gameMode: "survival", dimension: "overworld" },
  pathfinder: { setGoal() {} },
  clearControlStates() {},
  chat() {},
};
const worldState = buildWorldState(worldBot, {
  mode: "auto",
  goal: "test",
  plan: [],
  visionEnabled: false,
  paused: false,
});
check(
  "world state spatial schema",
  worldState.me.pos.y === 64 && worldState.me.bodyBlocks.below.name === "stone" && Array.isArray(worldState.droppedItems)
);

const plan = sanitizePlan([" wood ", "", "stone", null]);
check("plan sanitization", JSON.stringify(plan) === JSON.stringify(["wood", "stone"]), JSON.stringify(plan));
check(
  "usage accounting",
  usageTokenCount({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 }) === 18
);

// Anti-spam say gate (companion monologue fix)
check("normalizeSay strips punct", normalizeSay("Привет, Steve!!!") === "привет steve");
check(
  "similar monologue detected",
  isSimilarSay(
    "Я рядом, Steve. Думаю, дерево важнее.",
    "Я рядом, Steve. Думаю, дерево добыть раньше укрытия."
  ) === true
);
check("different topics not similar", isSimilarSay("Бегу за тобой", "В шахте нашёл уголь") === false);
const dup = decideSayEmission({
  text: "Я рядом, Steve",
  recentSays: [normalizeSay("Я рядом, Steve. Дерево и укрытие.")],
  lastSayTick: 1,
  tick: 10,
  playerTriggered: false,
  minGapTicks: 6,
});
check("duplicate say blocked", dup.ok === false && dup.reason === "duplicate", dup.reason);
const rate = decideSayEmission({
  text: "Совсем другая новость про зомби",
  recentSays: [normalizeSay("Я рядом, Steve")],
  lastSayTick: 9,
  tick: 10,
  playerTriggered: false,
  minGapTicks: 6,
});
check("rate limit blocks unsolicited", rate.ok === false && rate.reason === "rate_limit", rate.reason);
const reply = decideSayEmission({
  text: "Ок, иду",
  recentSays: [normalizeSay("Я рядом, Steve")],
  lastSayTick: 9,
  tick: 10,
  playerTriggered: true,
  minGapTicks: 6,
});
check("player reply bypasses rate limit", reply.ok === true, reply.reason);
const silence = decideSayEmission({ text: "null", recentSays: [], tick: 1, playerTriggered: true });
check("null say is silence", silence.ok === false);

// Mantella turn-based: companion without pending command must not call LLM
{
  let llmCalls = 0;
  const turnBrain = new Brain({
    bot: worldBot,
    llm: {
      async messages() {
        llmCalls += 1;
        return {
          text: '{"think":"hi","say":"привет","command_done":true,"action":{"type":"idle"}}',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
    cfg: {
      agent: { mode: "hybrid", companionMode: true, idleWhenNoGoal: true, maxHistory: 4 },
      mantella: { enabled: true, turnBased: true },
      vision: { enabled: false },
      api: {},
    },
    mcData: {},
    log() {},
  });
  await turnBrain.step();
  check("mantella idle skips LLM", llmCalls === 0, `calls=${llmCalls}`);
  turnBrain.queueCommand("Игрок Steve сказал в игровом чате: «привет».", "Steve");
  await turnBrain.step();
  check("mantella player turn calls LLM", llmCalls === 1, `calls=${llmCalls}`);
  await turnBrain.step();
  check("mantella after reply idle again", llmCalls === 1, `calls=${llmCalls}`);
}

const fakeBot = {
  pathfinder: { setGoal() {} },
  clearControlStates() {},
  chat() {},
};
const brain = new Brain({
  bot: fakeBot,
  llm: {},
  cfg: { agent: { mode: "listen" }, vision: { enabled: false }, api: {} },
  mcData: {},
  log() {},
});
brain.queueCommand("first", "A");
brain.queueCommand("second", "B");
check("active command preserved", brain.pendingCommand === "first" && brain.commandQueue.length === 1);
brain.completeActiveCommand();
check("queued command promoted", brain.pendingCommand === "second" && brain.pendingFrom === "B");

const budgetBrain = new Brain({
  bot: fakeBot,
  llm: {},
  cfg: {
    agent: { mode: "auto" },
    vision: { enabled: false },
    api: { maxRequestsPerSession: 2, maxTotalTokens: 100 },
  },
  mcData: {},
  log() {},
});
budgetBrain.requestCount = 2;
check("request budget guard", budgetBrain._budgetError()?.includes("request limit") === true);

const responses = [
  { text: '{"think":"step 1","plan":["finish order"],"command_done":false,"action":{"type":"chat","text":"working"}}', usage: { input_tokens: 2, output_tokens: 3 } },
  { text: '{"think":"done","plan":[],"command_done":true,"action":{"type":"chat","text":"done"}}', usage: { input_tokens: 2, output_tokens: 3 } },
];
const stepBrain = new Brain({
  bot: worldBot,
  llm: { async messages() { return responses.shift(); } },
  cfg: { agent: { mode: "listen", idleWhenNoGoal: true, maxHistory: 4 }, vision: { enabled: false }, api: {} },
  mcData: {},
  log() {},
});
stepBrain.queueCommand("do two steps", "tester");
await stepBrain.step();
check("multi-step command retained", stepBrain.pendingCommand === "do two steps" && stepBrain.commandTurns === 1);
await stepBrain.step();
check("explicit command completion", stepBrain.pendingCommand === null && stepBrain.totalTokens === 10);

// --- Opus 5 vision POV renderer ---
const __selfDir = path.dirname(fileURLToPath(import.meta.url));
const visionLogsDir = path.resolve(__selfDir, "..", "..", "logs");
const visionFramePath = path.join(visionLogsDir, "vision_selftest.jpg");
fs.mkdirSync(visionLogsDir, { recursive: true });

const povBot = {
  entity: {
    position: new Vec3(0.5, 64, 0.5),
    yaw: 0,
    pitch: 0,
    eyeHeight: 1.62,
    height: 1.8,
  },
  world: {
    raycast(origin, direction, maxDistance) {
      // Flat stone wall ahead at z=4; dirt floor under feet.
      if (direction.y < -0.35) {
        return { name: "dirt", position: new Vec3(0, 63, 0), face: 1 };
      }
      if (direction.z < -0.2) {
        return { name: "stone", position: new Vec3(0, 64, -4), face: 3 };
      }
      return null;
    },
  },
};

const rendered = renderBotPov(povBot, { width: 160, height: 90, maxDistance: 32, jpegQuality: 0.7 });
check("pov jpeg magic", rendered.buffer[0] === 0xff && rendered.buffer[1] === 0xd8, `len=${rendered.buffer.length}`);
check("pov size bounds", rendered.buffer.length > 400 && rendered.buffer.length < 200_000, String(rendered.buffer.length));
check("pov dimensions", rendered.width === 160 && rendered.height === 90 && rendered.rays === 160 * 90);
check("pov render budget", rendered.ms < 5000, `${rendered.ms}ms`);
fs.writeFileSync(visionFramePath, rendered.buffer);
check("pov debug file written", fs.existsSync(visionFramePath) && fs.statSync(visionFramePath).size === rendered.buffer.length);

const visionCfg = {
  vision: {
    enabled: true,
    source: "viewer",
    everyNTicks: 1,
    maxFileBytes: 5 * 1024 * 1024,
    maxAgeMs: 30000,
    width: 160,
    height: 90,
    maxDistance: 32,
    jpegQuality: 0.7,
    saveDebugFrame: true,
    captureRoot: visionLogsDir,
    capturePath: path.join(visionLogsDir, "vision_provider_selftest.jpg"),
  },
};
const provider = createVisionProvider(visionCfg, () => {});
provider.setBot(povBot);
const frameB64 = await provider.getFrame();
check("viewer provider base64", typeof frameB64 === "string" && frameB64.length > 100, String(frameB64?.length));
check(
  "viewer provider debug frame",
  fs.existsSync(visionCfg.vision.capturePath) && fs.statSync(visionCfg.vision.capturePath).size > 100
);

const cfgVisionOk = validateConfig({
  api: {
    baseUrl: "https://api.cheat-ai.shop",
    allowedHosts: ["api.cheat-ai.shop"],
    allowCustomHost: false,
    keyEnv: "OPUS_API_KEY",
    keyFile: path.join(process.env.USERPROFILE || process.env.HOME || ".", "Desktop", "opus4.8api.txt"),
    model: "claude-opus-5",
    requireExactModel: true,
    maxTokens: 1024,
    temperature: 0.4,
    whoamiTimeoutMs: 10000,
    requestTimeoutMs: 90000,
    maxRetries: 2,
    retryBaseMs: 750,
    retryMaxMs: 10000,
    retryMessagesOnNetworkError: false,
    maxResponseBytes: 2097152,
    maxRequestsPerSession: 500,
    maxTotalTokens: 500000,
    budget: { maxRequestsPerMinute: 12, minTokensRemaining: 100000 },
  },
  minecraft: {
    host: "127.0.0.1",
    port: 25565,
    username: "OpusBot",
    version: "1.21.1",
    auth: "offline",
    reconnect: { enabled: true, maxAttempts: 10, baseDelayMs: 2000, maxDelayMs: 30000 },
  },
  agent: {
    botName: "Opus",
    mode: "hybrid",
    language: "ru",
    tickMs: 5000,
    idleWhenNoGoal: true,
    maxHistory: 16,
    announceOnSpawn: true,
    allowPlayerCommands: false,
    allowWhispers: false,
    controllerUsers: [],
    trustOfflineUsernames: false,
  },
  vision: {
    enabled: true,
    source: "viewer",
    everyNTicks: 2,
    maxFileBytes: 5242880,
    maxAgeMs: 30000,
    width: 320,
    height: 180,
    capturePath: "../logs/vision_frame.jpg",
  },
  viewer: { enabled: true, host: "127.0.0.1", port: 3007, firstPerson: true },
});
check("vision config source=viewer", cfgVisionOk.vision.source === "viewer" && cfgVisionOk.vision.enabled === true);

let visionScreenRejected = false;
try {
  validateConfig({
    ...cfgVisionOk,
    vision: { ...cfgVisionOk.vision, source: "screen" },
  });
} catch {
  visionScreenRejected = true;
}
check("desktop screen capture rejected", visionScreenRejected);

// --- Controller layer: bounded verbs, decision normalize, gate, routing ---
const mkWorld = (over = {}) => ({
  me: {
    pos: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    oxygen: 20,
    sleeping: false,
    dimension: "overworld",
    inWater: false,
    held: null,
    ...over.me,
  },
  environment: { isDay: true, timeOfDay: 1000, raining: false, ...over.environment },
  inventory: over.inventory || [],
  players: over.players || [],
  mobs: over.mobs || [],
  droppedItems: over.droppedItems || [],
  blocksNearby: over.blocksNearby || [],
  hazards: { blocks: [], hostileMobs: [], lowOxygen: false, lowHealth: false, ...over.hazards },
  agent: { mode: "auto", goal: "g", plan: ["p"], lastError: null },
});
const mkCtx = (world, over = {}) => ({
  world,
  goal: "g",
  plan: ["p"],
  targets: [],
  waypoint: null,
  inventory: parseInventory(world),
  container: null,
  passive: false,
  mcData: { itemsByName: {}, blocksByName: {} },
  ...over,
});

{
  const ids = legalVerbs(mkCtx(mkWorld())).map((v) => v.id);
  check("wait always legal", ids.includes("wait"));
  check("calm world: no flee/attack/eat", !ids.includes("flee") && !ids.includes("attack") && !ids.includes("eat"));

  const danger = mkWorld({
    me: { health: 6 },
    mobs: [{ name: "zombie", hostile: true, dist: 3, pos: { x: 3, y: 64, z: 0 }, visible: true }],
    hazards: { hostileMobs: [{ name: "zombie", dist: 3, pos: { x: 3, y: 64, z: 0 } }], lowHealth: true },
  });
  const dIds = legalVerbs(mkCtx(danger)).map((v) => v.id);
  check("danger: flee+attack legal", dIds.includes("flee") && dIds.includes("attack"));
  const atk = resolveVerb("attack", mkCtx(danger));
  check("attack resolves to nearest hostile", atk.type === "attack" && atk.name === "zombie" && atk.maxDistance === 16);
  const flee = resolveVerb("flee", mkCtx(danger));
  check("flee resolves to goto away", flee.type === "goto" && flee.x < 0, JSON.stringify(flee));

  const hungry = mkWorld({ me: { food: 12 }, inventory: ["cooked_beef x3"] });
  const hCtx = mkCtx(hungry);
  check("eat legal when hungry with food", legalVerbs(hCtx).some((v) => v.id === "eat"));
  check("eat resolves", resolveVerb("eat", hCtx).type === "eat");

  const res = mkWorld({
    blocksNearby: [{ name: "oak_log", dist: 5, pos: { x: 5, y: 64, z: 0 } }],
  });
  const rCtx = mkCtx(res, { targets: ["oak_log"] });
  check("collect legal on target block", legalVerbs(rCtx).some((v) => v.id === "collect"));
  check("collect resolves target", resolveVerb("collect", rCtx).block === "oak_log");
  check("goto_target resolves pos", resolveVerb("goto_target", rCtx).x === 5);

  const wpCtx = mkCtx(mkWorld(), { waypoint: { x: 10, y: 64, z: -5 } });
  const wp = resolveVerb("goto_waypoint", wpCtx);
  check("waypoint resolves", wp.type === "goto" && wp.z === -5 && wp.range === 2);

  const passiveCtx = mkCtx(danger, { passive: true });
  const pIds = legalVerbs(passiveCtx).map((v) => v.id);
  check("passive mode only wait", pIds.length === 1 && pIds[0] === "wait");

  check("illegal verb resolves wait", resolveVerb("teleport", mkCtx(mkWorld())).type === "wait");
  check("non-legal verb resolves wait", resolveVerb("attack", mkCtx(mkWorld())).type === "wait");
}

{
  const legal = [{ id: "collect" }, { id: "wait" }];
  const jevAnswer = {
    action: { choice: "collect", confidence: 0.8, probabilities: { collect: 0.8, wait: 0.2 } },
    safe: { noul: 0.9 },
    urgency: { score: 2 },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const d = readDecision(jevAnswer, legal, "jev");
  check("readDecision normalize", d.choice === "collect" && d.confidence === 0.8 && d.safe === true && d.urgency === 2);

  const bad = readDecision({ action: { choice: "explode" }, safe: { noul: 0.9 } }, legal, "jev");
  check("readDecision unknown choice falls back", bad.choice === "collect" && bad.confidence === 0 && bad.safe === false);

  const unsafe = readDecision({ action: { choice: "collect", confidence: 0.9 }, safe: { noul: 0.2 } }, legal, "jev");
  check("noul<0.5 unsafe", unsafe.safe === false);

  const g1 = gateDecision(d, { minConfidence: 0.45 });
  check("gate ok", g1.ok === true);
  const g2 = gateDecision(unsafe, { minConfidence: 0.45 });
  check("gate unsafe -> flee", g2.ok === false && g2.override === "flee");
  const g3 = gateDecision({ ...d, confidence: 0.2 }, { minConfidence: 0.45 });
  check("gate low conf -> wait", g3.ok === false && /low-confidence/.test(g3.reason));

  const cs = compactState(mkCtx(mkWorld(), { targets: ["oak_log"], waypoint: { x: 1, y: 2, z: 3 } }));
  check(
    "compactState serializable",
    cs.targets[0] === "oak_log" && cs.me.health === 20 && JSON.parse(JSON.stringify(cs)).targets.length === 1
  );
}

{
  const local = createLocalController();
  const danger = mkWorld({
    me: { health: 6 },
    mobs: [{ name: "zombie", hostile: true, dist: 3, pos: { x: 3, y: 64, z: 0 } }],
    hazards: { hostileMobs: [{ name: "zombie", dist: 3, pos: { x: 3, y: 64, z: 0 } }], lowHealth: true },
  });
  const ctx = mkCtx(danger);
  ctx.legal = legalVerbs(ctx);
  const d1 = await local.decide(ctx);
  check("local: danger -> flee", d1.choice === "flee" && d1.urgency >= 2);

  const gatherCtx = mkCtx(
    mkWorld({ blocksNearby: [{ name: "oak_log", dist: 5, pos: { x: 5, y: 64, z: 0 } }] }),
    { targets: ["oak_log"] }
  );
  gatherCtx.legal = legalVerbs(gatherCtx);
  const d2 = await local.decide(gatherCtx);
  check("local: target -> collect", d2.choice === "collect");

  const idleCtx = mkCtx(mkWorld());
  idleCtx.legal = legalVerbs(idleCtx);
  const d3 = await local.decide(idleCtx);
  check("local: empty world -> wait", d3.choice === "wait");
}

{
  // Brain routing: controller set -> per-tick decide without LLM;
  // pending command -> full planner power (llm.messages called).
  let llmCalls = 0;
  const ctrlBrain = new Brain({
    bot: worldBot,
    llm: {
      async messages() {
        llmCalls += 1;
        return {
          text: '{"think":"p","targets":["oak_log"],"command_done":true,"action":{"type":"idle"}}',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
    cfg: {
      agent: { mode: "auto", maxHistory: 8 },
      controller: { type: "local", plannerEveryTicks: 8, minConfidence: 0.45, fallbackToLocal: true },
      vision: { enabled: false },
      api: {},
    },
    mcData: {},
    log() {},
  });
  ctrlBrain.tick = 5;
  ctrlBrain.lastPlannerTick = 4; // planner not due
  ctrlBrain._plannerBusy = true; // suppress background planner for determinism
  let decided = null;
  ctrlBrain.setController({
    type: "fake",
    async decide(ctx) {
      decided = ctx;
      return { choice: "wait", confidence: 1, safe: true, urgency: 0, source: "fake" };
    },
  });
  await ctrlBrain.step();
  check(
    "controller tick: no LLM call, decide ran",
    llmCalls === 0 && decided !== null && decided.legal.some((v) => v.id === "wait"),
    `llmCalls=${llmCalls}`
  );
  check(
    "controller tick history marked src",
    ctrlBrain.history.at(-1)?.src === "fake" && ctrlBrain.lastAction?.result?.ok === true
  );
  ctrlBrain.queueCommand("сделай палку", "tester");
  ctrlBrain._plannerBusy = false;
  await ctrlBrain.step();
  check("command tick routes to planner", llmCalls === 1 && ctrlBrain.controllerTargets[0] === "oak_log");
}

{
  const off = createController({ cfg: { controller: { type: "off" } }, log() {} });
  check("factory off -> null", off === null);
  const loc = createController({ cfg: { controller: { type: "local" } }, log() {} });
  check("factory local", loc?.type === "local");
  const missingKey = createController({ cfg: { controller: { type: "jev", jev: { apiKeyEnv: "NO_SUCH_ENV_X" } } }, log() {} });
  check("factory jev w/o key -> local fallback", missingKey?.type === "local");

  const badCfg = { ...cfgVisionOk, controller: { type: "mindflayer" } };
  let rejected = false;
  try {
    validateConfig(badCfg);
  } catch {
    rejected = true;
  }
  check("unknown controller type rejected", rejected);

  const cfgCtrl = validateConfig({
    ...cfgVisionOk,
    controller: { type: "laya", plannerEveryTicks: 6 },
  });
  check(
    "controller config normalized",
    cfgCtrl.controller.type === "laya" &&
      cfgCtrl.controller.plannerEveryTicks === 6 &&
      cfgCtrl.controller.minConfidence === 0.45 &&
      cfgCtrl.controller.laya.url === "http://127.0.0.1:8091/decide"
  );
  let remoteRejected = false;
  try {
    validateConfig({
      ...cfgVisionOk,
      controller: { type: "laya", laya: { url: "http://evil.example.com/decide" } },
    });
  } catch {
    remoteRejected = true;
  }
  check("remote laya url rejected", remoteRejected);
}

{
  // NeuroSkyrim dialogue: parseCommand !clear, dialogue reply parse, action mapping
  check("parse !clear", parseCommand("!clear", "Opus")?.type === "clear" && parseCommand("!clear", "Opus").op === "start");
  check("parse !clear stop", parseCommand("!clear stop", "Opus")?.op === "stop");
  check("parse !проход", parseCommand("!проходи игру", "Opus")?.type === "clear");

  const dr = parseDialogueReply('{"say":"привет, Стив","action":"wave","task":null,"mood":"happy"}');
  check("dialogue reply json", dr.say === "привет, Стив" && dr.action === "wave" && dr.mood === "happy" && dr.task === null);
  const drTask = parseDialogueReply('{"say":"понял","task":"добудь дубовое бревно","action":"none"}');
  check("dialogue task parse", drTask.task === "добудь дубовое бревно" && drTask.action === null);
  const drRaw = parseDialogueReply("просто текст без json");
  check("dialogue raw fallback", drRaw.say === "просто текст без json" && drRaw.action === null);
  const drNulls = parseDialogueReply('{"say":null,"action":"null","task":null,"mood":null}');
  check("dialogue nulls", drNulls.say === null && drNulls.action === null && drNulls.task === null);

  check("give→toss", dialogueActionToAction("give:bread", { playerName: "Steve" })?.type === "toss" && dialogueActionToAction("give:bread", { playerName: "Steve" }).item === "bread");
  check("wave→emote", dialogueActionToAction("wave", { playerName: "Steve" })?.type === "emote");
  check("follow→follow", dialogueActionToAction("follow", { playerName: "Steve" })?.type === "follow" && dialogueActionToAction("follow", { playerName: "Steve" }).player === "Steve");
  check("look→look_at_player", dialogueActionToAction("look", { playerName: "Steve" })?.type === "look_at_player");
  check("none→null", dialogueActionToAction("none") === null && dialogueActionToAction(null) === null);
  check("attack→attack", dialogueActionToAction("attack")?.type === "attack");

  // OpenAI-compatible protocol (OpenRouter/VseGPT/etc): request shape + response mapping
  let captured = null;
  const openaiLlm = new LlmClient(
    {
      api: {
        baseUrl: "https://openrouter.ai/api/v1",
        protocol: "openai",
        apiKey: "TESTKEY123",
        model: "some-model/x",
        requireExactModel: true,
        maxTokens: 64,
        temperature: 0.4,
        whoamiTimeoutMs: 5000,
        requestTimeoutMs: 5000,
        maxRetries: 0,
        retryBaseMs: 10,
        retryMaxMs: 50,
        retryMessagesOnNetworkError: false,
        maxResponseBytes: 65536,
        budget: { maxRequestsPerSession: 10, maxRequestsPerMinute: 10, maxTokensPerSession: 100000, minTokensRemaining: 0 },
      },
    },
    {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"say":"привет"}' } }],
            model: "some-model/x",
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    }
  );
  const openaiRes = await openaiLlm.messages({ system: "sys", messages: [{ role: "user", content: "hi" }] });
  const capturedBody = JSON.parse(captured.init.body);
  check(
    "openai request shape",
    captured.url === "https://openrouter.ai/api/v1/chat/completions" &&
      captured.init.headers.authorization === "Bearer TESTKEY123" &&
      capturedBody.messages[0].role === "system" &&
      capturedBody.messages[0].content === "sys" &&
      capturedBody.messages[1].role === "user"
  );
  check("openai response mapped", openaiRes.text === '{"say":"привет"}' && openaiRes.usage.input_tokens === 10 && openaiLlm.tokensUsed === 15);

  const prefl = await new LlmClient(
    {
      api: {
        baseUrl: "https://x.example/v1",
        protocol: "openai",
        apiKey: "K",
        model: "m",
        requireExactModel: true,
        whoamiTimeoutMs: 5000,
        requestTimeoutMs: 5000,
        maxRetries: 0,
        maxResponseBytes: 65536,
        budget: { maxRequestsPerSession: 10, maxRequestsPerMinute: 10, maxTokensPerSession: 100000, minTokensRemaining: 0 },
      },
    },
    {
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: "m" }, { id: "other" }] }), { status: 200 }),
    }
  ).preflight();
  check("openai preflight /models ok", prefl.ok === true && prefl.models === 2);

  let preflightRejected = false;
  try {
    await new LlmClient(
      {
        api: {
          baseUrl: "https://x.example/v1",
          protocol: "openai",
          apiKey: "K",
          model: "missing",
          requireExactModel: true,
          whoamiTimeoutMs: 5000,
          requestTimeoutMs: 5000,
          maxRetries: 0,
          maxResponseBytes: 65536,
          budget: { maxRequestsPerSession: 10, maxRequestsPerMinute: 10, maxTokensPerSession: 100000, minTokensRemaining: 0 },
        },
      },
      {
        fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }),
      }
    ).preflight();
  } catch (err) {
    preflightRejected = err.code === "model_unavailable";
  }
  check("openai preflight missing model rejected", preflightRejected);

  const cfgOpenai = validateConfig({
    ...cfgVisionOk,
    api: { ...cfgVisionOk.api, protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", allowedHosts: ["openrouter.ai"], allowCustomHost: true, model: "qwen/x" },
  });
  check("openai protocol config accepted", cfgOpenai.api.protocol === "openai");
  let badProto = false;
  try {
    validateConfig({ ...cfgVisionOk, api: { ...cfgVisionOk.api, protocol: "grpc" } });
  } catch {
    badProto = true;
  }
  check("bad protocol rejected", badProto);

  // Dialogue end-to-end on a mocked LLM: reply + mood + memory wiring
  const convo = new MantellaConversation({
    bot: worldBot,
    cfg: { agent: { botName: "Opus", persona: "тестовый персонаж" }, mantella: { worldId: "selftest", maxChatLines: 50 } },
    log() {},
    llm: {
      async messages() {
        return { text: '{"say":"здорово","action":"wave","task":null,"mood":"happy"}', usage: {} };
      },
    },
  });
  convo.onPlayerChat("Steve", "привет");
  const convoReply = await convo.respond("Steve", "привет", {});
  check("respond returns reply", convoReply.say === "здорово" && convoReply.action === "wave" && convo.mood === "happy");
  const mapped = dialogueActionToAction(convoReply.action, { playerName: "Steve" });
  check("respond action maps", mapped?.type === "emote");
}

console.log(
  JSON.stringify({
    pass,
    fail,
    help_len: HELP_TEXT.length,
    pov_ms: rendered.ms,
    pov_bytes: rendered.buffer.length,
    pov_frame: visionFramePath,
  })
);
process.exit(fail ? 1 : 0);
