// Cooperative cancellation for hung progression steps. The step watchdog
// used to only race the step against a timer: the "hung" step kept running in
// the background, and the next step then fought it for the same body
// (concurrent digs abort each other — "Digging aborted", competing gotos —
// "pathfinder timeout", duplicated eat loops). Each step now runs inside an
// AsyncLocalStorage context tagged with a generation; when the watchdog
// fires the generation is bumped and every bot action issued from the stale
// context throws, so the orphan unwinds at its next action.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

export function stepStale(bot) {
  const s = als.getStore();
  return !!s && s.bot === bot && s.gen !== bot._stepGen;
}

export function runStep(bot, fn) {
  bot._stepGen = bot._stepGen || 0;
  return als.run({ bot, gen: bot._stepGen }, fn);
}

export function cancelSteps(bot) {
  bot._stepGen = (bot._stepGen || 0) + 1;
  try {
    bot.pathfinder?.setGoal(null);
  } catch {
    /* ignore */
  }
  try {
    bot.stopDigging?.();
  } catch {
    /* ignore */
  }
  try {
    bot.clearControlStates?.();
  } catch {
    /* ignore */
  }
}

const ASYNC = ["dig", "placeBlock", "equip", "consume", "activateBlock", "openContainer", "openBlock", "craft", "lookAt", "look", "toss", "tossStack", "sleep"];
const SYNC = ["attack", "setControlState", "activateItem", "useOn"];

export function installStepGuards(bot) {
  if (!bot || bot._stepGuards) return;
  bot._stepGuards = true;
  const cancelled = () => new Error("step cancelled (watchdog)");
  for (const k of ASYNC) {
    const orig = bot[k];
    if (typeof orig !== "function") continue;
    bot[k] = function (...a) {
      if (stepStale(bot)) return Promise.reject(cancelled());
      return orig.apply(this, a);
    };
  }
  for (const k of SYNC) {
    const orig = bot[k];
    if (typeof orig !== "function") continue;
    bot[k] = function (...a) {
      if (stepStale(bot)) throw cancelled();
      return orig.apply(this, a);
    };
  }
  const pf = bot.pathfinder;
  if (pf) {
    for (const k of ["goto", "setGoal"]) {
      const orig = pf[k];
      if (typeof orig !== "function") continue;
      pf[k] = function (...a) {
        // setGoal(null) is a stop — always allowed
        if (stepStale(bot) && !(k === "setGoal" && a[0] == null)) {
          if (k === "goto") return Promise.reject(cancelled());
          throw cancelled();
        }
        return orig.apply(this, a);
      };
    }
  }
}
