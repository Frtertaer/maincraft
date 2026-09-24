import { parseCommand, HELP_TEXT, normalizeTrigger, matchCustomCommand } from "./commands.js";
import { extractJsonObject, LlmClient } from "./llm.js";
import {
  computeCraftPlan,
  executeAction,
  normalizeActionCount,
  selectNearestCombatTarget,
  pickBestFood,
  setFoodPreferences,
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
let craftedSticks = 0;
const craftBot = {
  inventory: { items: () => (craftedSticks ? [{ name: "stick", count: craftedSticks }] : []) },
  recipesFor(itemId, metadata, minResultCount, table) {
    recipeQuery = { itemId, metadata, minResultCount, table };
    return [recipe];
  },
  async craft(selectedRecipe, repetitions, table) {
    craftCall = { selectedRecipe, repetitions, table };
    craftedSticks += repetitions * selectedRecipe.result.count;
  },
};
const craftResult = await executeAction(
  craftBot,
  { type: "craft", item: "stick", count: 8 },
  { itemsByName: { stick: { id: 280 } }, blocksByName: {} }
);
check(
  "craft action uses output count",
  craftResult.ok && recipeQuery?.minResultCount === 1 && craftCall?.repetitions === 2 && craftedSticks === 8,
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
setFoodPreferences({ favorite: ["bread"], hated: ["cooked_beef"] });
const tasteBot = { food: 14, inventory: { items: () => [{ name: "cooked_beef" }, { name: "bread" }] } };
check("favourite food first", pickBestFood(tasteBot)?.name === "bread");
const hatedOnly = { food: 14, inventory: { items: () => [{ name: "cooked_beef" }] } };
check("hated food refused when not starving", pickBestFood(hatedOnly) === null);
check("hated food eaten when starving", pickBestFood({ ...hatedOnly, food: 4 })?.name === "cooked_beef");
setFoodPreferences({});

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

// ---- desktop-app integration: custom commands, providers ----
check("normalizeTrigger", normalizeTrigger("  !Построй ДОМ, ёлка ") === "построй дом елка");
const customList = [
  { id: "home", name: "Дом", triggers: ["дом", "построй дом"], kind: "ai", prompt: "build", enabled: true },
  { id: "dance", name: "Танец", triggers: ["танцуй"], kind: "script", steps: [{ type: "wait" }], matchPlain: true },
];
const hitLong = matchCustomCommand("построй дом у реки", customList);
check("custom longest trigger + args", hitLong?.command.id === "home" && hitLong.trigger === "построй дом" && hitLong.args === "у реки", JSON.stringify(hitLong));
check("custom trigger needs word boundary", matchCustomCommand("домик", customList) === null);
check("custom plain chat needs matchPlain", matchCustomCommand("дом", customList, { addressed: false }) === null);
check("custom plain chat opt-in", matchCustomCommand("танцуй!", customList, { addressed: false })?.command.id === "dance");
check("parse !custom", parseCommand("!дом", "Opus", customList)?.type === "custom");
check("parse addressed custom", parseCommand("Opus, построй дом", "Opus", customList)?.command?.id === "home");
check("parse plain non-command stays null", parseCommand("привет", "Opus", customList) === null);
check("builtin still works with customs", parseCommand("!status", "Opus", customList)?.type === "status");

const baseCfg = () => {
  const copy = JSON.parse(JSON.stringify({ ...cfgVisionOk, commands: undefined }));
  // drop fields derived by the first validation so each variant is normalized from scratch
  for (const key of ["preflight", "loopback", "keyOptional", "keyFileResolved"]) delete copy.api[key];
  return copy;
};
const withCommands = validateConfig({
  ...baseCfg(),
  commands: {
    custom: [
      { id: "a", name: "A", triggers: ["!Копай"], kind: "script", steps: [{ type: "collect", block: "oak_log", count: 3 }] },
      { id: "b", name: "B", triggers: ["off"], kind: "ai", prompt: "x", enabled: false },
    ],
  },
});
check(
  "config normalizes custom commands",
  withCommands.commands.custom.length === 1 && withCommands.commands.custom[0].triggers[0] === "копай",
  JSON.stringify(withCommands.commands)
);
let badStepRejected = false;
try {
  validateConfig({ ...baseCfg(), commands: { custom: [{ id: "x", triggers: ["x"], kind: "script", steps: [{ type: "rm_rf" }] }] } });
} catch {
  badStepRejected = true;
}
check("config rejects unknown script action", badStepRejected);

const official = validateConfig({
  ...baseCfg(),
  api: { ...baseCfg().api, baseUrl: "https://api.anthropic.com", allowedHosts: ["api.anthropic.com"], model: "claude-sonnet-5" },
});
check("official API uses models preflight", official.api.preflight === "models" && official.api.loopback === false);
const local = validateConfig({
  ...baseCfg(),
  api: { ...baseCfg().api, baseUrl: "http://127.0.0.1:11434", allowedHosts: ["127.0.0.1"], allowCustomHost: true },
});
check("local http provider allowed", local.api.loopback === true && local.api.keyOptional === true && local.api.preflight === "none");
let remoteHttpRejected = false;
try {
  validateConfig({ ...baseCfg(), api: { ...baseCfg().api, baseUrl: "http://evil.example", allowedHosts: ["evil.example"], allowCustomHost: true } });
} catch {
  remoteHttpRejected = true;
}
check("remote plain http rejected", remoteHttpRejected);

const modelsClient = new LlmClient(
  { api: { ...official.api, apiKey: "sk-ant-test-0000000000000000" } },
  {
    fetchImpl: async (url) =>
      new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5" }] }), { status: 200, headers: { "content-type": "application/json" } }),
  }
);
const pre = await modelsClient.preflight("models");
check("preflight models", pre.ok && pre.modelListed === true, JSON.stringify(pre));

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
