/**
 * Controller layer factory + shared helpers.
 * The fast controller (Jev/Laya/local) turns each tick's world snapshot
 * into ONE bounded verb; brain.js executes it. The Opus planner keeps
 * running asynchronously at a much lower cadence.
 */

import { legalVerbs, resolveVerb, parseInventory } from "./verbs.js";
import { createJevController } from "./jev.js";
import { createLayaController } from "./laya.js";
import { createLocalController } from "./local.js";

export function createController({ cfg, log }) {
  const c = cfg?.controller;
  if (!c || c.type === "off") return null;
  if (c.type === "local") return createLocalController();
  if (c.type === "laya") {
    return createLayaController({ url: c.laya.url, timeoutMs: c.laya.timeoutMs });
  }
  if (c.type === "jev") {
    const apiKey = process.env[c.jev.apiKeyEnv] || "";
    if (!apiKey) {
      log?.warn?.(`controller=jev requested but ${c.jev.apiKeyEnv} is not set; falling back to local`);
      return createLocalController();
    }
    return createJevController({
      apiKey,
      model: c.jev.model,
      baseUrl: c.jev.baseUrl,
      timeoutMs: c.jev.timeoutMs,
    });
  }
  log?.warn?.(`unknown controller type "${c.type}"; disabled`);
  return null;
}

/** Snapshot actually sent to the decision model — small and stable. */
export function compactState(ctx) {
  const w = ctx.world || {};
  const me = w.me || {};
  const trim = (list, n, fields) =>
    (list || []).slice(0, n).map((e) => {
      const out = {};
      for (const f of fields) if (e[f] !== undefined) out[f] = e[f];
      return out;
    });
  return {
    goal: ctx.goal || w.agent?.goal || null,
    plan: (ctx.plan || w.agent?.plan || []).slice(0, 6),
    targets: (ctx.targets || []).slice(0, 12),
    waypoint: ctx.waypoint || null,
    me: {
      health: me.health,
      food: me.food,
      oxygen: me.oxygen,
      sleeping: me.sleeping,
      dimension: me.dimension,
      inWater: me.inWater,
      held: me.held?.name ?? me.held,
    },
    environment: w.environment
      ? { isDay: w.environment.isDay, timeOfDay: w.environment.timeOfDay, raining: w.environment.raining }
      : null,
    inventory: (w.inventory || []).slice(0, 40),
    hazards: {
      lowHealth: w.hazards?.lowHealth || false,
      lowOxygen: w.hazards?.lowOxygen || false,
      hostileMobs: trim(w.hazards?.hostileMobs, 4, ["name", "dist"]),
      blocks: trim(w.hazards?.blocks, 4, ["name", "dist"]),
    },
    mobs: trim(w.mobs, 6, ["name", "hostile", "dist", "visible"]),
    players: trim(w.players, 4, ["name", "dist"]),
    droppedItems: trim(w.droppedItems, 6, ["name", "count", "dist"]),
    blocksNearby: trim(w.blocksNearby, 10, ["name", "dist"]),
    container: ctx.container?.block ? { block: ctx.container.block, items: [...containerItems(ctx).entries()].slice(0, 30) } : null,
    lastError: w.agent?.lastError || null,
    lastAction: w.agent?.lastAction || null,
  };
}

function containerItems(ctx) {
  return ctx.container?.items instanceof Map ? ctx.container.items : new Map();
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/**
 * Normalize Jev/Laya `answers` into {choice,confidence,safe,urgency,source,raw}.
 * - `choice`/`probabilities` may be {id:desc} keyed or an array of ids.
 * - `safe` may be boolean or {noul:0..1} (true when noul>=0.5).
 * - `urgency` is 0..3 integer-ish.
 */
export function readDecision(answers, legal, source) {
  const legalIds = new Set((legal || []).map((v) => v.id));
  const a = answers?.action || answers?.decision || answers || {};
  let choice = a.choice ?? a.id ?? a.answer;
  let confidence = a.confidence;
  const probs = a.probabilities;
  if (choice == null && probs && typeof probs === "object") {
    const entries = Array.isArray(probs)
      ? probs.map((v, i) => [typeof v === "object" ? v.id ?? i : v, typeof v === "object" ? v.p ?? v.probability ?? 1 : 1])
      : Object.entries(probs);
    entries.sort((x, y) => Number(y[1]) - Number(x[1]));
    if (entries.length) choice = entries[0][0];
  }
  if (typeof probs === "object" && probs !== null && !Array.isArray(probs) && choice != null) {
    const p = Number(probs[choice]);
    if (Number.isFinite(p)) confidence = confidence ?? p;
  }
  if (Array.isArray(probs) && choice != null) {
    const hit = probs.find((p) => typeof p === "object" && p && (p.id === choice || p.choice === choice));
    if (hit) confidence = confidence ?? Number(hit.probability ?? hit.p);
  }
  choice = String(choice ?? "");
  if (!legalIds.size || !legalIds.has(choice)) {
    return {
      choice: legalIds.size ? [...legalIds][0] : "wait",
      confidence: 0,
      safe: false,
      urgency: 0,
      source: `${source}:invalid-choice`,
      raw: answers,
    };
  }
  const safeRaw = answers?.safe;
  const noul = typeof safeRaw === "object" && safeRaw !== null ? Number(safeRaw.noul ?? safeRaw.score) : Number(safeRaw);
  const safe = Number.isFinite(noul) ? noul >= 0.5 : safeRaw !== false;
  const urg = answers?.urgency;
  const urgency = clamp01(typeof urg === "object" && urg !== null ? Number(urg.score) / 3 : Number(urg) / 3) * 3;
  // Decision confidence = the chosen verb's share of probability mass over
  // the offered legal options. Jev/Laya return a `confidence` field too, but
  // it is calibrated differently per model; the probability share is
  // comparable across models, so it wins when present.
  let probOfChoice;
  if (probs && typeof probs === "object" && !Array.isArray(probs)) {
    const p = Number(probs[choice]);
    if (Number.isFinite(p)) probOfChoice = p;
  } else if (Array.isArray(probs)) {
    const hit = probs.find((p) => typeof p === "object" && p && (p.id === choice || p.choice === choice));
    if (hit) {
      const p = Number(hit.probability ?? hit.p);
      if (Number.isFinite(p)) probOfChoice = p;
    }
  }
  return {
    choice,
    confidence: clamp01(probOfChoice ?? confidence ?? 0.5),
    safe,
    urgency: Math.round(Math.min(3, Math.max(0, urgency))),
    source,
    raw: answers,
    usage: answers?.usage || undefined,
  };
}

/** Decide whether the model's pick is allowed to act this tick. */
export function gateDecision(decision, c) {
  if (!decision) return { ok: false, reason: "no-decision" };
  if (decision.choice === "wait") return { ok: true };
  if (!decision.safe) return { ok: false, reason: "unsafe", override: "flee" };
  if (decision.confidence < (c?.minConfidence ?? 0.45)) {
    return { ok: false, reason: `low-confidence ${decision.confidence.toFixed(2)}` };
  }
  return { ok: true };
}

export { legalVerbs, resolveVerb, parseInventory };
