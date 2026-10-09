const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SECRET_PATTERN = /sk-[A-Za-z0-9._-]{8,}/gi;

export function sanitizeForLog(value, maxLength = 300) {
  return String(value ?? "")
    .replace(SECRET_PATTERN, "<redacted-api-key>")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
    .slice(0, maxLength);
}

export class LlmError extends Error {
  constructor(message, { code = "llm_error", status = null, retryable = false } = {}) {
    super(sanitizeForLog(message));
    this.name = "LlmError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class ApiBudgetError extends LlmError {
  constructor(message, code = "api_budget_exceeded") {
    super(message, { code, retryable: false });
    this.name = "ApiBudgetError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response, ceilingMs) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, ceilingMs);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(date - Date.now(), 0), ceilingMs);
}

function providerErrorText(text) {
  try {
    const data = JSON.parse(text);
    const raw = data?.error?.message ?? data?.message ?? data?.error?.type ?? data?.error;
    if (typeof raw === "string") return sanitizeForLog(raw, 240);
  } catch {
    // A non-JSON provider error is intentionally not logged verbatim.
  }
  return "provider rejected the request";
}

async function readTextLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // best effort
    }
    throw new LlmError("API response exceeded the configured size limit", {
      code: "response_too_large",
    });
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new LlmError("API response exceeded the configured size limit", {
        code: "response_too_large",
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new LlmError("API response exceeded the configured size limit", {
          code: "response_too_large",
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseJsonObject(text, operation) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlmError(`${operation} returned invalid JSON`, { code: "invalid_api_json" });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LlmError(`${operation} returned an invalid response object`, {
      code: "invalid_api_schema",
    });
  }
  return data;
}

function modelIds(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object") return null;
      return entry.id ?? entry.model ?? entry.name ?? null;
    })
    .filter((entry) => typeof entry === "string");
}

function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const fields = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];
  return fields.reduce((total, field) => {
    const value = Number(usage[field]);
    return total + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

function estimateContentTokens(value) {
  if (typeof value === "string") return Math.ceil(value.length / 4);
  if (Array.isArray(value)) return value.reduce((total, item) => total + estimateContentTokens(item), 0);
  if (!value || typeof value !== "object") return 1;
  if (value.type === "image" && typeof value.source?.data === "string") {
    // Image billing is pixel-based rather than base64-character-based. Without
    // decoding dimensions here, use a conservative byte-size allowance.
    return Math.ceil(value.source.data.length / 256);
  }
  return Object.entries(value).reduce(
    (total, [key, item]) => total + Math.ceil(key.length / 4) + estimateContentTokens(item),
    0
  );
}

function estimateRequestTokens(system, messages, maxTokens) {
  return estimateContentTokens(system) + estimateContentTokens(messages) + maxTokens;
}

/**
 * LLM client with bounded retries and local spending guards.
 * protocol "anthropic": /v1/messages + /v1/whoami (x-api-key).
 * protocol "openai": /chat/completions + GET /models (Bearer) —
 * covers OpenAI, OpenRouter, VseGPT, NanoGPT and other compatible APIs.
 */
export class LlmClient {
  constructor(cfg, { fetchImpl = globalThis.fetch, sleepFn = sleep, randomFn = Math.random } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
    this.baseUrl = cfg.api.baseUrl.replace(/\/$/, "");
    this.protocol = String(cfg.api.protocol || "anthropic").toLowerCase();
    if (!["anthropic", "openai"].includes(this.protocol)) {
      throw new Error(`api.protocol must be anthropic or openai (got ${this.protocol})`);
    }
    Object.defineProperty(this, "apiKey", {
      value: cfg.api.apiKey,
      enumerable: false,
      writable: false,
    });
    this.model = cfg.api.model;
    this.requireExactModel = cfg.api.requireExactModel !== false;
    this.maxTokens = cfg.api.maxTokens ?? 1024;
    this.temperature = cfg.api.temperature ?? 0.4;
    this.whoamiTimeoutMs = cfg.api.whoamiTimeoutMs ?? 10000;
    this.requestTimeoutMs = cfg.api.requestTimeoutMs ?? 90000;
    this.maxRetries = cfg.api.maxRetries ?? 2;
    this.retryBaseMs = cfg.api.retryBaseMs ?? 750;
    this.retryMaxMs = cfg.api.retryMaxMs ?? 10000;
    this.retryMessagesOnNetworkError = cfg.api.retryMessagesOnNetworkError === true;
    this.maxResponseBytes = cfg.api.maxResponseBytes ?? 2 * 1024 * 1024;
    this.budgetConfig = { ...cfg.api.budget };
    this.fetchImpl = fetchImpl;
    this.sleepFn = sleepFn;
    this.randomFn = randomFn;
    this.logicalRequests = 0;
    this.httpAttempts = 0;
    this.tokensUsed = 0;
    this.requestTimes = [];
    this.lastKnownTokensRemaining = null;
  }

  getBudgetState() {
    return {
      requests: this.logicalRequests,
      httpAttempts: this.httpAttempts,
      tokensUsed: this.tokensUsed,
      lastKnownTokensRemaining: this.lastKnownTokensRemaining,
      limits: { ...this.budgetConfig },
    };
  }

  assertWhoami(who) {
    if (!who || typeof who !== "object" || Array.isArray(who)) {
      throw new LlmError("whoami returned an invalid response", { code: "invalid_whoami" });
    }
    if (who.ok !== true) {
      throw new LlmError("whoami did not confirm that the API key is ready", {
        code: "whoami_not_ready",
      });
    }
    const available = modelIds(who.models);
    if (!available.includes(this.model)) {
      throw new LlmError(`Configured model is unavailable: ${this.model}`, {
        code: "model_unavailable",
      });
    }
    const remaining = Number(who.balance?.tokens_remaining);
    if (Number.isFinite(remaining)) {
      this.lastKnownTokensRemaining = remaining;
      if (remaining < this.budgetConfig.minTokensRemaining) {
        throw new ApiBudgetError(
          "API balance is below api.budget.minTokensRemaining",
          "minimum_balance_reached"
        );
      }
    }
    return who;
  }

  async whoami() {
    const data = await this.#requestJson(
      "whoami",
      "/v1/whoami",
      {
        method: "GET",
        headers: this.#headers(),
      },
      { timeoutMs: this.whoamiTimeoutMs, idempotent: true }
    );
    return this.assertWhoami(data);
  }

  /**
   * Startup check. Anthropic → /v1/whoami (strict).
   * OpenAI → GET /models; if the provider lacks the endpoint, skip silently.
   */
  async preflight() {
    if (this.protocol === "anthropic") return this.whoami();
    try {
      const data = await this.#requestJson(
        "models",
        "/models",
        { method: "GET", headers: this.#headers() },
        { timeoutMs: this.whoamiTimeoutMs, idempotent: true }
      );
      const available = modelIds(Array.isArray(data?.data) ? data.data : data?.models);
      if (available.length && !available.includes(this.model)) {
        if (this.requireExactModel) {
          throw new LlmError(`Configured model is unavailable: ${this.model}`, {
            code: "model_unavailable",
          });
        }
        return { ok: true, warning: `model ${this.model} not in /models list` };
      }
      return { ok: true, models: available.length || undefined };
    } catch (err) {
      if (err instanceof LlmError && err.code === "model_unavailable") throw err;
      // Many OpenAI-compatible proxies (VseGPT, NanoGPT) lack /models — don't block on it.
      return { ok: true, warning: `/models preflight skipped: ${err?.message || err}` };
    }
  }

  /**
   * @param {object} opts
   * @param {string} opts.system
   * @param {Array} opts.messages - chat messages (Anthropic/OpenAI share the shape)
   * @param {number} [opts.maxTokens]
   */
  async messages({ system, messages, maxTokens }) {
    if (typeof system !== "string" || !Array.isArray(messages) || messages.length === 0) {
      throw new LlmError("messages requires a system string and a non-empty messages array", {
        code: "invalid_request",
      });
    }
    const outputLimit = maxTokens ?? this.maxTokens;
    if (!Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > 32768) {
      throw new LlmError("maxTokens is outside the allowed range", { code: "invalid_request" });
    }
    const estimate = estimateRequestTokens(system, messages, outputLimit);
    this.#reserveBudget(estimate);

    if (this.protocol === "openai") {
      return this.#openaiMessages({ system, messages, maxTokens: outputLimit, estimate });
    }
    return this.#anthropicMessages({ system, messages, maxTokens: outputLimit, estimate });
  }

  async #anthropicMessages({ system, messages, maxTokens, estimate }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      temperature: this.temperature,
      system,
      messages,
    };

    const data = await this.#requestJson(
      "messages",
      "/v1/messages",
      {
        method: "POST",
        headers: this.#headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      },
      { timeoutMs: this.requestTimeoutMs, idempotent: false }
    );

    const usage = data.usage && typeof data.usage === "object" ? data.usage : {};
    const actualTokens = usageTokens(usage);
    this.tokensUsed += actualTokens > 0 ? actualTokens : estimate;

    if (this.requireExactModel && data.model !== this.model) {
      throw new LlmError(`API response model mismatch; expected ${this.model}`, {
        code: "model_mismatch",
      });
    }
    if (!Array.isArray(data.content)) {
      throw new LlmError("messages response is missing content blocks", {
        code: "invalid_api_schema",
      });
    }
    const outText = data.content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    if (!outText) {
      throw new LlmError("messages response did not contain text", {
        code: "invalid_api_schema",
      });
    }
    return {
      text: outText,
      model: data.model,
      usage,
    };
  }

  async #openaiMessages({ system, messages, maxTokens, estimate }) {
    const wire = [{ role: "system", content: system }, ...messages].map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      temperature: this.temperature,
      messages: wire,
    };
    const data = await this.#requestJson(
      "chat/completions",
      "/chat/completions",
      {
        method: "POST",
        headers: this.#headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      },
      { timeoutMs: this.requestTimeoutMs, idempotent: false }
    );

    const usage = data.usage && typeof data.usage === "object" ? data.usage : {};
    const normalizedUsage = {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0,
    };
    const actualTokens = usageTokens(normalizedUsage);
    this.tokensUsed += actualTokens > 0 ? actualTokens : estimate;

    if (this.requireExactModel && data.model && data.model !== this.model) {
      throw new LlmError(`API response model mismatch; expected ${this.model}`, {
        code: "model_mismatch",
      });
    }
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const outText = String(choice?.message?.content ?? "").trim();
    if (!outText) {
      throw new LlmError("chat/completions response did not contain text", {
        code: "invalid_api_schema",
      });
    }
    return {
      text: outText,
      model: data.model || this.model,
      usage: normalizedUsage,
    };
  }

  /** Multimodal: optional base64 JPEG + text. */
  async messagesWithImage({ system, text, imageBase64, mediaType = "image/jpeg", maxTokens }) {
    if (mediaType !== "image/jpeg") {
      throw new LlmError("Only JPEG vision frames are allowed", { code: "invalid_image" });
    }
    const content = [];
    if (imageBase64) {
      if (typeof imageBase64 !== "string" || imageBase64.length > 28 * 1024 * 1024) {
        throw new LlmError("Vision frame is invalid or too large", { code: "invalid_image" });
      }
      content.push(
        this.protocol === "openai"
          ? {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            }
          : {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: imageBase64,
              },
            }
      );
    }
    content.push({ type: "text", text: String(text ?? "") });
    return this.messages({
      system,
      messages: [{ role: "user", content }],
      maxTokens,
    });
  }

  #headers(extra = {}) {
    if (this.protocol === "openai") {
      return {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        ...extra,
      };
    }
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      accept: "application/json",
      ...extra,
    };
  }

  #reserveBudget(estimatedTokens) {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter((timestamp) => now - timestamp < 60000);
    if (this.logicalRequests >= this.budgetConfig.maxRequestsPerSession) {
      throw new ApiBudgetError("Session API request budget reached", "request_budget_reached");
    }
    if (this.requestTimes.length >= this.budgetConfig.maxRequestsPerMinute) {
      throw new ApiBudgetError("Local API requests-per-minute limit reached", "local_rate_limit");
    }
    if (this.tokensUsed + estimatedTokens > this.budgetConfig.maxTokensPerSession) {
      throw new ApiBudgetError("Session token budget would be exceeded", "token_budget_reached");
    }
    if (
      Number.isFinite(this.lastKnownTokensRemaining) &&
      this.lastKnownTokensRemaining - estimatedTokens < this.budgetConfig.minTokensRemaining
    ) {
      throw new ApiBudgetError("Request would cross the minimum API balance reserve", "minimum_balance_reached");
    }
    this.logicalRequests += 1;
    this.requestTimes.push(now);
  }

  async #requestJson(operation, endpoint, init, { timeoutMs, idempotent }) {
    const url = `${this.baseUrl}${endpoint}`;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      this.httpAttempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        const code = timedOut ? "api_timeout" : "api_network_error";
        const message = timedOut ? `${operation} timed out` : `${operation} network request failed`;
        const canRetry =
          attempt < this.maxRetries && (idempotent || this.retryMessagesOnNetworkError);
        if (canRetry) {
          await this.sleepFn(this.#backoffMs(attempt));
          continue;
        }
        throw new LlmError(message, { code, retryable: canRetry });
      }

      try {
        const text = await readTextLimited(response, this.maxResponseBytes);
        if (response.status >= 300 && response.status < 400) {
          throw new LlmError(`${operation} redirect refused`, {
            code: "api_redirect_refused",
            status: response.status,
          });
        }
        if (!response.ok) {
          const retryable = RETRYABLE_STATUSES.has(response.status);
          if (retryable && attempt < this.maxRetries) {
            const delay = retryAfterMs(response, this.retryMaxMs) ?? this.#backoffMs(attempt);
            await this.sleepFn(delay);
            continue;
          }
          throw new LlmError(`${operation} ${response.status}: ${providerErrorText(text)}`, {
            code: "api_http_error",
            status: response.status,
            retryable,
          });
        }
        return parseJsonObject(text, operation);
      } catch (err) {
        if (err instanceof LlmError) throw err;
        const timedOut = controller.signal.aborted;
        const canRetry =
          attempt < this.maxRetries && (idempotent || this.retryMessagesOnNetworkError);
        if (canRetry) {
          await this.sleepFn(this.#backoffMs(attempt));
          continue;
        }
        throw new LlmError(timedOut ? `${operation} timed out` : `${operation} response failed`, {
          code: timedOut ? "api_timeout" : "api_response_error",
          retryable: canRetry,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new LlmError(`${operation} retry limit reached`, { code: "api_retry_exhausted" });
  }

  #backoffMs(attempt) {
    const base = Math.min(this.retryBaseMs * 2 ** attempt, this.retryMaxMs);
    const jitter = 0.75 + this.randomFn() * 0.5;
    return Math.max(0, Math.round(base * jitter));
  }
}

export function extractJsonObject(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
