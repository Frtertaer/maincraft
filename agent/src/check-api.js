import { loadConfig } from "./config.js";
import { LlmClient } from "./llm.js";

const cfg = loadConfig();
const llm = new LlmClient(cfg);

const who = await llm.whoami();
const bal = who.balance || {};
console.log(
  JSON.stringify(
    {
      ok: who.ok,
      model_config: cfg.api.model,
      models_on_key: who.models?.slice?.(0, 8) || who.models,
      tokens_remaining: bal.tokens_remaining,
      token_limit: bal.token_limit,
    },
    null,
    2
  )
);

const r = await llm.messages({
  system: "Reply very briefly.",
  messages: [{ role: "user", content: "Скажи одним словом: готов" }],
  maxTokens: 32,
});
console.log("ping_model:", r.model);
console.log("ping_text:", r.text);
console.log("ping_usage:", r.usage);
