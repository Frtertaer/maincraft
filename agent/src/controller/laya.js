/**
 * Laya — local decision-model sidecar (convaiinnovations/laya).
 * Same decide() shape as Jev, but the model runs next to the agent
 * via agent/tools/laya_server.py (POST /decide, {state, questions}).
 */

import { readDecision, compactState } from "./index.js";

export function createLayaController({ url = "http://127.0.0.1:8091/decide", timeoutMs = 3000, fetchImpl = fetch } = {}) {
  return {
    type: "laya",
    async decide(ctx) {
      const legal = ctx.legal;
      if (!legal?.length) {
        return { choice: "wait", confidence: 1, safe: true, urgency: 0, source: "empty" };
      }
      if (legal.length === 1) {
        return { choice: legal[0].id, confidence: 1, safe: true, urgency: 1, source: "single" };
      }
      const body = {
        state: compactState(ctx),
        questions: {
          action: {
            type: "choice",
            instructions:
              "Which single bounded action should the Minecraft player take this tick? " +
              "Pick the option that best advances `plan.goal` and `targets` without ignoring `hazards`.",
            criteria: Object.fromEntries(legal.map((v) => [v.id, v.description])),
          },
          safe: {
            type: "noul",
            instructions:
              "Is the action you would pick safe right now given hazards, body health, lava, drowning and nearby hostiles?",
          },
          urgency: {
            type: "score",
            instructions: "How urgently must the player act this tick?",
            criteria: [
              "Can wait. Standing still loses nothing.",
              "Should act. Progress or a mild threat.",
              "Must act now. Hazard, combat, or a closing window.",
            ],
          },
        },
      };
      const answers = await postJson(fetchImpl, url, body, timeoutMs);
      return readDecision(answers, legal, "laya");
    },
  };
}

async function postJson(fetchImpl, url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Laya HTTP ${res.status} ${text.slice(0, 160)}`);
    }
    const json = await res.json();
    return json.answers || json;
  } finally {
    clearTimeout(timer);
  }
}
