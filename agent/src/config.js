import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const PROJECT = path.resolve(ROOT, "..");

const PINNED_API_HOSTS = Object.freeze(["api.cheat-ai.shop"]);
const KEY_PATTERN = /^sk-[A-Za-z0-9._-]{16,}$/;

function loadJson(filePath) {
  try {
    // Strip UTF-8 BOM (PowerShell Out-File / ConvertTo-Json often writes one)
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`Config file not found: ${filePath}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Config is not valid JSON: ${filePath}`);
    }
    throw err;
  }
}

function objectAt(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringAt(value, label, { min = 1, max = 500 } = {}) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new Error(`${label} must be a string (${min}-${max} chars)`);
  }
  return value.trim();
}

function boolAt(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false`);
  return value;
}

function numberAt(value, fallback, label, { min, max, integer = false } = {}) {
  const next = value == null ? fallback : value;
  if (typeof next !== "number" || !Number.isFinite(next)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (integer && !Number.isInteger(next)) throw new Error(`${label} must be an integer`);
  if (min != null && next < min) throw new Error(`${label} must be >= ${min}`);
  if (max != null && next > max) throw new Error(`${label} must be <= ${max}`);
  return next;
}

function expandPath(input) {
  let value = stringAt(input, "api.keyFile");
  if (value === "~") value = os.homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(os.homedir(), value.slice(2));
  }
  value = value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
  value = value.replace(/\$\{([^}]+)\}/g, (match, name) => process.env[name] ?? match);
  if (/%[^%]+%|\$\{[^}]+\}/.test(value)) {
    throw new Error("api.keyFile contains an unknown environment variable");
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(ROOT, value);
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeApiConfig(cfg) {
  const api = objectAt(cfg.api, "api");
  const baseUrlText = stringAt(api.baseUrl, "api.baseUrl");
  let baseUrl;
  try {
    baseUrl = new URL(baseUrlText);
  } catch {
    throw new Error("api.baseUrl must be a valid URL");
  }
  if (baseUrl.protocol !== "https:") throw new Error("api.baseUrl must use HTTPS");
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("api.baseUrl must not contain credentials, query, or fragment");
  }

  const allowCustomHost = boolAt(api.allowCustomHost, false, "api.allowCustomHost");
  const rawHosts = api.allowedHosts ?? PINNED_API_HOSTS;
  if (!Array.isArray(rawHosts) || rawHosts.length < 1 || rawHosts.length > 16) {
    throw new Error("api.allowedHosts must be a non-empty array");
  }
  const allowedHosts = rawHosts.map((host, i) =>
    stringAt(host, `api.allowedHosts[${i}]`, { max: 253 }).toLowerCase()
  );
  const hostname = baseUrl.hostname.toLowerCase();
  if (!allowedHosts.includes(hostname)) {
    throw new Error(`API host is not allowed: ${hostname}`);
  }
  if (!PINNED_API_HOSTS.includes(hostname) && !allowCustomHost) {
    throw new Error("Custom API hosts require api.allowCustomHost=true");
  }
  if (baseUrl.port && baseUrl.port !== "443" && !allowCustomHost) {
    throw new Error("A non-standard API port requires api.allowCustomHost=true");
  }

  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
  api.baseUrl = baseUrl.toString().replace(/\/$/, "");
  api.allowedHosts = [...new Set(allowedHosts)];
  api.allowCustomHost = allowCustomHost;
  api.model = stringAt(api.model, "api.model", { max: 120 });
  api.requireExactModel = boolAt(api.requireExactModel, true, "api.requireExactModel");
  api.maxTokens = numberAt(api.maxTokens, 1024, "api.maxTokens", {
    min: 16,
    max: 32768,
    integer: true,
  });
  api.temperature = numberAt(api.temperature, 0.4, "api.temperature", { min: 0, max: 1 });
  api.whoamiTimeoutMs = numberAt(api.whoamiTimeoutMs, 10000, "api.whoamiTimeoutMs", {
    min: 1000,
    max: 60000,
    integer: true,
  });
  api.requestTimeoutMs = numberAt(api.requestTimeoutMs, 90000, "api.requestTimeoutMs", {
    min: 5000,
    max: 300000,
    integer: true,
  });
  api.maxRetries = numberAt(api.maxRetries, 2, "api.maxRetries", { min: 0, max: 5, integer: true });
  api.retryBaseMs = numberAt(api.retryBaseMs, 750, "api.retryBaseMs", {
    min: 100,
    max: 10000,
    integer: true,
  });
  api.retryMaxMs = numberAt(api.retryMaxMs, 10000, "api.retryMaxMs", {
    min: api.retryBaseMs,
    max: 60000,
    integer: true,
  });
  api.retryMessagesOnNetworkError = boolAt(
    api.retryMessagesOnNetworkError,
    false,
    "api.retryMessagesOnNetworkError"
  );
  api.maxResponseBytes = numberAt(api.maxResponseBytes, 2 * 1024 * 1024, "api.maxResponseBytes", {
    min: 4096,
    max: 10 * 1024 * 1024,
    integer: true,
  });

  const budget = objectAt(api.budget ?? {}, "api.budget");
  api.maxRequestsPerSession = numberAt(
    api.maxRequestsPerSession ?? budget.maxRequestsPerSession,
    500,
    "api.maxRequestsPerSession",
    { min: 1, max: 100000, integer: true }
  );
  budget.maxRequestsPerMinute = numberAt(
    budget.maxRequestsPerMinute,
    12,
    "api.budget.maxRequestsPerMinute",
    { min: 1, max: 600, integer: true }
  );
  api.maxTotalTokens = numberAt(
    api.maxTotalTokens ?? budget.maxTokensPerSession,
    500000,
    "api.maxTotalTokens",
    { min: api.maxTokens, max: 1000000000, integer: true }
  );
  budget.minTokensRemaining = numberAt(
    budget.minTokensRemaining,
    100000,
    "api.budget.minTokensRemaining",
    { min: 0, max: 1000000000, integer: true }
  );
  budget.maxRequestsPerSession = api.maxRequestsPerSession;
  budget.maxTokensPerSession = api.maxTotalTokens;
  api.budget = budget;

  api.keyEnv = stringAt(api.keyEnv ?? "OPUS_API_KEY", "api.keyEnv", { max: 80 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(api.keyEnv)) {
    throw new Error("api.keyEnv must be an environment variable name");
  }
  api.keyFile = api.keyFile ?? "~/Desktop/opus4.8api.txt";
  api.keyFileResolved = expandPath(api.keyFile);
  if (isPathInside(PROJECT, api.keyFileResolved)) {
    throw new Error("API key file must be outside the project workspace");
  }
}

function normalizeMinecraftConfig(cfg) {
  const minecraft = objectAt(cfg.minecraft, "minecraft");
  minecraft.host = stringAt(minecraft.host, "minecraft.host", { max: 253 });
  minecraft.port = numberAt(minecraft.port, 25565, "minecraft.port", {
    min: 1,
    max: 65535,
    integer: true,
  });
  minecraft.username = stringAt(minecraft.username, "minecraft.username", { max: 16 });
  if (!/^[A-Za-z0-9_]{1,16}$/.test(minecraft.username)) {
    throw new Error("minecraft.username must be a valid Java username");
  }
  minecraft.version = stringAt(minecraft.version ?? "auto", "minecraft.version", { max: 40 });
  minecraft.auth = stringAt(minecraft.auth ?? "offline", "minecraft.auth", { max: 20 }).toLowerCase();
  if (!['offline', 'microsoft'].includes(minecraft.auth)) {
    throw new Error("minecraft.auth must be offline or microsoft");
  }

  const reconnect = objectAt(minecraft.reconnect ?? {}, "minecraft.reconnect");
  reconnect.enabled = boolAt(reconnect.enabled, true, "minecraft.reconnect.enabled");
  reconnect.maxAttempts = numberAt(reconnect.maxAttempts, 10, "minecraft.reconnect.maxAttempts", {
    min: 0,
    max: 1000,
    integer: true,
  });
  reconnect.baseDelayMs = numberAt(reconnect.baseDelayMs, 2000, "minecraft.reconnect.baseDelayMs", {
    min: 250,
    max: 60000,
    integer: true,
  });
  reconnect.maxDelayMs = numberAt(reconnect.maxDelayMs, 30000, "minecraft.reconnect.maxDelayMs", {
    min: reconnect.baseDelayMs,
    max: 300000,
    integer: true,
  });
  minecraft.reconnect = reconnect;
}

function normalizeAgentConfig(cfg) {
  const agent = objectAt(cfg.agent, "agent");
  agent.botName = stringAt(agent.botName ?? "Opus", "agent.botName", { max: 40 });
  agent.mode = stringAt(agent.mode ?? "hybrid", "agent.mode", { max: 20 }).toLowerCase();
  if (!["auto", "hybrid", "listen", "observe"].includes(agent.mode)) {
    throw new Error("agent.mode must be auto, hybrid, listen, or observe");
  }
  agent.tickMs = numberAt(agent.tickMs, 4000, "agent.tickMs", { min: 1000, max: 3600000, integer: true });
  agent.maxHistory = numberAt(agent.maxHistory, 16, "agent.maxHistory", { min: 1, max: 200, integer: true });
  agent.idleWhenNoGoal = boolAt(agent.idleWhenNoGoal, true, "agent.idleWhenNoGoal");
  agent.announceOnSpawn = boolAt(agent.announceOnSpawn, true, "agent.announceOnSpawn");
  agent.allowPlayerCommands = boolAt(agent.allowPlayerCommands, false, "agent.allowPlayerCommands");
  agent.allowPlayerChat = boolAt(agent.allowPlayerChat, false, "agent.allowPlayerChat");
  agent.allowWhispers = boolAt(agent.allowWhispers, false, "agent.allowWhispers");
  agent.companionMode = boolAt(agent.companionMode, false, "agent.companionMode");
  agent.persona = stringAt(
    agent.persona ??
      "Ты живой спутник в Minecraft: дружелюбный, с характером, отвечаешь по-русски в чат, исследуешь мир рядом с игроком.",
    "agent.persona",
    { max: 800 }
  );
  agent.trustOfflineUsernames = boolAt(
    agent.trustOfflineUsernames,
    false,
    "agent.trustOfflineUsernames"
  );
  if (!Array.isArray(agent.controllerUsers) || agent.controllerUsers.length > 32) {
    throw new Error("agent.controllerUsers must be an array with at most 32 entries");
  }
  agent.controllerUsers = agent.controllerUsers.map((name, i) => {
    const normalized = stringAt(name, `agent.controllerUsers[${i}]`, { max: 16 });
    if (!/^[A-Za-z0-9_]{1,16}$/.test(normalized)) {
      throw new Error(`agent.controllerUsers[${i}] is not a valid Java username`);
    }
    return normalized;
  });
  // who may free-chat with the character (not only !commands)
  if (agent.chatUsers == null) agent.chatUsers = [];
  if (!Array.isArray(agent.chatUsers) || agent.chatUsers.length > 32) {
    throw new Error("agent.chatUsers must be an array with at most 32 entries");
  }
  agent.chatUsers = agent.chatUsers.map((name, i) => {
    const normalized = stringAt(name, `agent.chatUsers[${i}]`, { max: 16 });
    if (normalized === "*") return "*";
    if (!/^[A-Za-z0-9_]{1,16}$/.test(normalized)) {
      throw new Error(`agent.chatUsers[${i}] is not a valid Java username (or *)`);
    }
    return normalized;
  });
  if (agent.companionMode) {
    // companion defaults: talk + hybrid survival unless explicitly overridden later
    if (!agent.allowPlayerChat) agent.allowPlayerChat = true;
  }
  if (agent.allowPlayerCommands && agent.controllerUsers.length === 0) {
    throw new Error("Player commands require at least one agent.controllerUsers entry");
  }
  if (agent.allowPlayerChat && agent.chatUsers.length === 0 && agent.controllerUsers.length === 0) {
    throw new Error("Player chat requires agent.chatUsers and/or agent.controllerUsers");
  }
  const needsOfflineTrust = agent.allowPlayerCommands || agent.allowPlayerChat;
  if (needsOfflineTrust && cfg.minecraft.auth === "offline" && !agent.trustOfflineUsernames) {
    throw new Error(
      "Offline player chat/commands require explicit agent.trustOfflineUsernames=true (usernames are spoofable)"
    );
  }

  // Mantella-inspired companion extras (optional section)
  if (cfg.mantella == null) cfg.mantella = {};
  const mantella = objectAt(cfg.mantella, "mantella");
  mantella.enabled = boolAt(mantella.enabled, Boolean(agent.companionMode), "mantella.enabled");
  mantella.worldId = stringAt(mantella.worldId ?? "local", "mantella.worldId", { max: 64 });
  mantella.maxChatLines = numberAt(mantella.maxChatLines, 200, "mantella.maxChatLines", {
    min: 20,
    max: 5000,
    integer: true,
  });
  // tts: none | edge (best RU neural via voice server) | silero | sapi | voice (alias edge)
  mantella.tts = stringAt(mantella.tts ?? "none", "mantella.tts", { max: 20 }).toLowerCase();
  if (!["none", "sapi", "edge", "silero", "voice", "whisper"].includes(mantella.tts)) {
    throw new Error("mantella.tts must be none|edge|silero|sapi|voice");
  }
  if (mantella.tts === "whisper") mantella.tts = "edge"; // common mistake
  mantella.ttsVoice = stringAt(
    mantella.ttsVoice ?? "ru-RU-SvetlanaNeural",
    "mantella.ttsVoice",
    { max: 80 }
  );
  mantella.ttsEngine = stringAt(mantella.ttsEngine ?? mantella.tts, "mantella.ttsEngine", { max: 20 }).toLowerCase();
  mantella.stt = stringAt(mantella.stt ?? "none", "mantella.stt", { max: 20 }).toLowerCase();
  if (!["none", "whisper"].includes(mantella.stt)) {
    throw new Error("mantella.stt must be none or whisper");
  }
  mantella.voiceUrl = stringAt(mantella.voiceUrl ?? "http://127.0.0.1:8765", "mantella.voiceUrl", {
    max: 200,
  });
  mantella.summaryEveryTurns = numberAt(mantella.summaryEveryTurns, 6, "mantella.summaryEveryTurns", {
    min: 0,
    max: 100,
    integer: true,
  });
  mantella.llmSummary = boolAt(mantella.llmSummary, true, "mantella.llmSummary");
  // Mantella default: only generate on player turn (pc_to_npc), not every brain tick
  mantella.turnBased = boolAt(
    mantella.turnBased,
    Boolean(agent.companionMode) || mantella.enabled,
    "mantella.turnBased"
  );
  cfg.mantella = mantella;
}

function normalizeVisionConfig(cfg) {
  const vision = objectAt(cfg.vision, "vision");
  vision.enabled = boolAt(vision.enabled, false, "vision.enabled");
  vision.source = stringAt(vision.source ?? "file", "vision.source", { max: 20 }).toLowerCase();
  if (!["file", "viewer", "none"].includes(vision.source)) {
    throw new Error("vision.source must be file, viewer, or none; desktop screen capture is disabled for safety");
  }
  vision.everyNTicks = numberAt(vision.everyNTicks, 3, "vision.everyNTicks", {
    min: 1,
    max: 1000,
    integer: true,
  });
  vision.maxFileBytes = numberAt(vision.maxFileBytes, 5 * 1024 * 1024, "vision.maxFileBytes", {
    min: 1024,
    max: 20 * 1024 * 1024,
    integer: true,
  });
  vision.maxAgeMs = numberAt(vision.maxAgeMs, 30000, "vision.maxAgeMs", {
    min: 1000,
    max: 3600000,
    integer: true,
  });
  vision.width = numberAt(vision.width, 320, "vision.width", { min: 64, max: 640, integer: true });
  vision.height = numberAt(vision.height, 180, "vision.height", { min: 48, max: 360, integer: true });
  vision.maxDistance = numberAt(vision.maxDistance, 48, "vision.maxDistance", {
    min: 8,
    max: 96,
    integer: true,
  });
  vision.jpegQuality = numberAt(vision.jpegQuality, 0.72, "vision.jpegQuality", {
    min: 0.3,
    max: 0.95,
  });
  vision.fov = numberAt(vision.fov, Math.PI / 2.4, "vision.fov", { min: 0.5, max: 2.2 });
  vision.saveDebugFrame = boolAt(vision.saveDebugFrame, true, "vision.saveDebugFrame");
  vision.captureRoot = path.resolve(PROJECT, "logs");
  vision.capturePath = path.resolve(ROOT, stringAt(vision.capturePath, "vision.capturePath"));
  if (!isPathInside(vision.captureRoot, vision.capturePath)) {
    throw new Error("vision.capturePath must stay inside the project logs directory");
  }
  if (!/\.jpe?g$/i.test(vision.capturePath)) {
    throw new Error("vision.capturePath must point to a JPEG file");
  }
}

function normalizeViewerConfig(cfg) {
  const viewer = objectAt(cfg.viewer ?? {}, "viewer");
  viewer.enabled = boolAt(viewer.enabled, false, "viewer.enabled");
  viewer.host = stringAt(viewer.host ?? "127.0.0.1", "viewer.host", { max: 45 });
  if (!['127.0.0.1', '::1'].includes(viewer.host)) {
    throw new Error("viewer.host must be a loopback address");
  }
  viewer.port = numberAt(viewer.port, 3007, "viewer.port", { min: 1024, max: 65535, integer: true });
  viewer.firstPerson = boolAt(viewer.firstPerson, true, "viewer.firstPerson");
  cfg.viewer = viewer;
}

function normalizeCombatConfig(cfg) {
  const combat = objectAt(cfg.combat ?? {}, "combat");
  combat.enabled = boolAt(combat.enabled, true, "combat.enabled");
  combat.intervalMs = numberAt(combat.intervalMs, 40, "combat.intervalMs", {
    min: 20,
    max: 500,
    integer: true,
  });
  combat.engageDistance = numberAt(combat.engageDistance, 24, "combat.engageDistance", {
    min: 3,
    max: 96,
  });
  combat.meleeDistance = numberAt(combat.meleeDistance, 3.15, "combat.meleeDistance", {
    min: 2,
    max: 5,
  });
  combat.maxDistance = numberAt(combat.maxDistance, 32, "combat.maxDistance", {
    min: 4,
    max: 96,
  });
  combat.cooldownMs = numberAt(combat.cooldownMs, 520, "combat.cooldownMs", {
    min: 200,
    max: 2000,
    integer: true,
  });
  combat.fleeAtHealth = numberAt(combat.fleeAtHealth, 4, "combat.fleeAtHealth", {
    min: 1,
    max: 19,
  });
  combat.eatBelowHealth = numberAt(combat.eatBelowHealth, 14, "combat.eatBelowHealth", {
    min: 1,
    max: 20,
  });
  combat.eatBelowFood = numberAt(combat.eatBelowFood, 16, "combat.eatBelowFood", {
    min: 1,
    max: 20,
  });
  combat.autoEngageHostiles = boolAt(combat.autoEngageHostiles, true, "combat.autoEngageHostiles");
  // attack cows/pigs/villagers/etc. — berserk mode ("everything living")
  combat.attackAllLiving = boolAt(combat.attackAllLiving, false, "combat.attackAllLiving");
  combat.allowPlayers = boolAt(combat.allowPlayers, false, "combat.allowPlayers");
  combat.holdMsAfterHit = numberAt(combat.holdMsAfterHit, 8000, "combat.holdMsAfterHit", {
    min: 500,
    max: 120000,
    integer: true,
  });
  combat.equipEveryMs = numberAt(combat.equipEveryMs, 2500, "combat.equipEveryMs", {
    min: 500,
    max: 60000,
    integer: true,
  });
  combat.kiteCreeperDistance = numberAt(combat.kiteCreeperDistance, 5.5, "combat.kiteCreeperDistance", {
    min: 3,
    max: 12,
  });
  combat.shieldVsProjectile = boolAt(combat.shieldVsProjectile, true, "combat.shieldVsProjectile");
  combat.prioritizeExploders = boolAt(combat.prioritizeExploders, true, "combat.prioritizeExploders");
  combat.strafe = boolAt(combat.strafe, true, "combat.strafe");
  combat.jumpCrit = boolAt(combat.jumpCrit, true, "combat.jumpCrit");
  combat.sprintHit = boolAt(combat.sprintHit, true, "combat.sprintHit");
  combat.mode = stringAt(combat.mode ?? "auto", "combat.mode", { max: 20 }).toLowerCase();
  if (!["auto", "hold", "off"].includes(combat.mode)) {
    throw new Error("combat.mode must be auto, hold, or off");
  }
  cfg.combat = combat;
}

function normalizeControllerConfig(cfg) {
  if (cfg.controller == null) cfg.controller = {};
  const c = objectAt(cfg.controller, "controller");
  c.type = stringAt(c.type ?? "off", "controller.type", { max: 20 }).toLowerCase();
  if (!["off", "jev", "laya", "local"].includes(c.type)) {
    throw new Error("controller.type must be off, jev, laya, or local");
  }
  // ticks between Opus planner calls while the controller drives
  c.plannerEveryTicks = numberAt(c.plannerEveryTicks, 8, "controller.plannerEveryTicks", {
    min: 2,
    max: 200,
    integer: true,
  });
  c.minConfidence = numberAt(c.minConfidence, 0.45, "controller.minConfidence", { min: 0, max: 1 });
  c.fallbackToLocal = boolAt(c.fallbackToLocal, true, "controller.fallbackToLocal");
  c.decisionTimeoutMs = numberAt(c.decisionTimeoutMs, 2500, "controller.decisionTimeoutMs", {
    min: 200,
    max: 30000,
    integer: true,
  });

  const jev = objectAt(c.jev ?? {}, "controller.jev");
  jev.model = stringAt(jev.model ?? "jev-latest", "controller.jev.model", { max: 80 });
  jev.timeoutMs = numberAt(jev.timeoutMs ?? c.decisionTimeoutMs, "controller.jev.timeoutMs", {
    min: 200,
    max: 30000,
    integer: true,
  });
  jev.apiKeyEnv = stringAt(jev.apiKeyEnv ?? "TYPESAFE_API_KEY", "controller.jev.apiKeyEnv", { max: 80 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(jev.apiKeyEnv)) {
    throw new Error("controller.jev.apiKeyEnv must be an environment variable name");
  }
  const jevUrl = stringAt(jev.baseUrl ?? "https://api.typesafe.ai/v1/systemone", "controller.jev.baseUrl", {
    max: 300,
  });
  let parsedJev;
  try {
    parsedJev = new URL(jevUrl);
  } catch {
    throw new Error("controller.jev.baseUrl must be a valid URL");
  }
  if (parsedJev.protocol !== "https:") throw new Error("controller.jev.baseUrl must use HTTPS");
  if (parsedJev.username || parsedJev.password || parsedJev.search || parsedJev.hash) {
    throw new Error("controller.jev.baseUrl must not contain credentials, query, or fragment");
  }
  jev.baseUrl = parsedJev.toString();
  c.jev = jev;

  const laya = objectAt(c.laya ?? {}, "controller.laya");
  const layaUrl = stringAt(laya.url ?? "http://127.0.0.1:8091/decide", "controller.laya.url", { max: 300 });
  let parsedLaya;
  try {
    parsedLaya = new URL(layaUrl);
  } catch {
    throw new Error("controller.laya.url must be a valid URL");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(parsedLaya.hostname)) {
    throw new Error("controller.laya.url must point to a loopback host");
  }
  laya.url = parsedLaya.toString();
  laya.timeoutMs = numberAt(laya.timeoutMs ?? c.decisionTimeoutMs, "controller.laya.timeoutMs", {
    min: 200,
    max: 30000,
    integer: true,
  });
  c.laya = laya;
  cfg.controller = c;
}

export function validateConfig(cfg) {
  objectAt(cfg, "config");
  normalizeApiConfig(cfg);
  normalizeMinecraftConfig(cfg);
  normalizeAgentConfig(cfg);
  normalizeVisionConfig(cfg);
  normalizeViewerConfig(cfg);
  normalizeCombatConfig(cfg);
  normalizeControllerConfig(cfg);
  return cfg;
}

function loadApiKey(api) {
  const envValue = process.env[api.keyEnv]?.trim();
  if (envValue) {
    if (!KEY_PATTERN.test(envValue)) throw new Error(`${api.keyEnv} does not contain a valid API key`);
    return { value: envValue, source: `environment variable ${api.keyEnv}` };
  }

  if (!fs.existsSync(api.keyFileResolved)) {
    throw new Error(`API key unavailable: set ${api.keyEnv} or create the configured key file outside the project`);
  }
  const lines = fs.readFileSync(api.keyFileResolved, "utf8").split(/\r?\n/).map((line) => line.trim());
  const value = lines.find((line) => KEY_PATTERN.test(line));
  if (!value) throw new Error("Configured API key file does not contain a valid key");
  return { value, source: "external key file" };
}

/**
 * Minimal .env reader (KEY=VALUE lines, no interpolation). Values in the
 * real environment always win over the file. File lives at agent/.env,
 * which is already covered by .gitignore.
 */
export function loadDotenv(filePath = path.join(ROOT, ".env")) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function resolveConfigPath(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.MAINCRAFT_CONFIG) return path.resolve(process.env.MAINCRAFT_CONFIG);
  const arg = process.argv.find((value) => value.startsWith("--config="));
  if (arg) return path.resolve(arg.slice("--config=".length));
  const flagIndex = process.argv.indexOf("--config");
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return path.resolve(process.argv[flagIndex + 1]);
  }
  return path.join(ROOT, "config.json");
}

export function loadConfig(configPath = resolveConfigPath()) {
  loadDotenv();
  const cfg = validateConfig(loadJson(configPath));
  cfg._configPath = configPath;
  const key = loadApiKey(cfg.api);
  Object.defineProperty(cfg.api, "apiKey", {
    value: key.value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(cfg.api, "keySource", {
    value: key.source,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return cfg;
}
