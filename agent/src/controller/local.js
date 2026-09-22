/**
 * Local fallback controller: deterministic heuristics over the same bounded
 * verbs. No network. Used when Jev/Laya is unavailable, times out, or when
 * the user picks controller.type="local". Priorities mirror the combat
 * reflexes: survive -> maintain body -> work the plan.
 */

import { VERB_BY_ID } from "./verbs.js";

export function createLocalController() {
  return {
    type: "local",
    decide(ctx) {
      const legal = new Set((ctx.legal || []).map((v) => v.id));
      const pick = pickVerb(ctx, legal);
      return Promise.resolve({
        choice: pick.id,
        confidence: pick.confidence,
        safe: pick.id !== "flee" ? true : false,
        urgency: pick.urgency,
        source: "local",
      });
    },
  };
}

function pickVerb(ctx, legal) {
  const has = (id) => legal.has(id);
  const me = ctx.world?.me || {};
  const hazards = ctx.world?.hazards || {};

  if (me.sleeping && hazards.hostileMobs?.length) {
    return candidate("wake", legal, 0.95, 3) || fallback();
  }
  if (me.sleeping) return { id: "wait", confidence: 1, urgency: 0 };

  const immediate =
    hazards.lowHealth ||
    hazards.lowOxygen ||
    (hazards.blocks || []).some((b) => b.dist <= 2) ||
    (hazards.hostileMobs || []).some((m) => m.dist <= 3 && Number(me.health) < 10);
  if (immediate && has("flee")) return { id: "flee", confidence: 0.95, urgency: 3 };

  if (has("attack") && (hazards.hostileMobs || []).some((m) => m.dist <= 6)) {
    if (has("equip") && Number(me.health) > 8) return { id: "equip", confidence: 0.7, urgency: 2 };
    return { id: "attack", confidence: 0.85, urgency: 2 };
  }

  if (has("eat") && (Number(me.food) < 15 || Number(me.health) < 16)) {
    return { id: "eat", confidence: 0.9, urgency: 2 };
  }
  if (has("sleep")) return { id: "sleep", confidence: 0.8, urgency: 1 };
  if (has("pickup") && (ctx.world?.droppedItems || []).some((d) => d.dist <= 7)) {
    return { id: "pickup", confidence: 0.75, urgency: 1 };
  }

  // Work the plan: prefer the verb that matches the plan's declared targets.
  const targets = (ctx.targets || []).map((t) => String(t).toLowerCase());
  const inv = ctx.inventory || new Map();
  if (has("container_take")) return { id: "container_take", confidence: 0.8, urgency: 1 };
  if (has("craft") && targets.some((t) => !inv.has(t))) {
    return { id: "craft", confidence: 0.75, urgency: 1 };
  }
  if (has("place") && targets.some((t) => /table|furnace|chest|torch/.test(t))) {
    return { id: "place", confidence: 0.7, urgency: 1 };
  }
  if (has("smelt") && targets.some((t) => /ingot|stone|glass|cooked/.test(t))) {
    return { id: "smelt", confidence: 0.7, urgency: 1 };
  }
  if (has("equip")) return { id: "equip", confidence: 0.6, urgency: 1 };
  if (has("collect") && targets.length) return { id: "collect", confidence: 0.7, urgency: 1 };
  if (has("dig") && targets.length) return { id: "dig", confidence: 0.65, urgency: 1 };
  if (has("goto_target")) return { id: "goto_target", confidence: 0.65, urgency: 1 };
  if (has("goto_waypoint")) return { id: "goto_waypoint", confidence: 0.6, urgency: 1 };
  if (has("collect")) return { id: "collect", confidence: 0.55, urgency: 1 };
  if (has("container_put") && (ctx.world?.blocksNearby || []).some((b) => /chest|barrel/.test(b.name) && b.dist <= 6)) {
    return { id: "container_put", confidence: 0.5, urgency: 0 };
  }

  return fallback();
}

function candidate(id, legal, confidence, urgency) {
  return legal.has(id) ? { id, confidence, urgency } : null;
}

function fallback() {
  return { id: "wait", confidence: 0.5, urgency: 0 };
}
