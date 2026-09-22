/**
 * LLM-based conversation summarization (Mantella summary_client pattern).
 * Uses the same LlmClient / Opus API as the bot.
 */
export async function summarizeConversationWithLlm(llm, { recentChat, prevSummary, playerName, companionName, log }) {
  const lines = (recentChat || [])
    .slice(-30)
    .map((e) => `${e.role}${e.username ? `(${e.username})` : ""}: ${e.text}`)
    .join("\n");
  if (!lines.trim()) {
    return { ok: false, error: "no chat to summarize", summary: prevSummary || "" };
  }

  const system = `Ты — модуль памяти спутника в Minecraft (как Mantella summary).
Сожми диалог в 5–12 коротких фактов на русском:
- что игрок просил / любит / не любит
- договорённости и совместные планы
- важные события мира
- тон отношений
Без воды, без markdown, только связный текст 800–1500 символов. Сохрани важные имена.`;

  const user = [
    `Спутник: ${companionName || "Opus"}. Игрок: ${playerName || "Игрок"}.`,
    prevSummary ? `Старая память:\n${String(prevSummary).slice(0, 1200)}` : "Старой памяти нет.",
    `Новый диалог:\n${lines.slice(0, 4000)}`,
    "Обнови память:",
  ].join("\n\n");

  try {
    const result = await llm.messages({
      system,
      messages: [{ role: "user", content: user }],
      // use slightly lower tokens if API supports via cfg — messages() uses cfg
    });
    const summary = String(result?.text || "")
      .replace(/^```[\s\S]*?```/g, "")
      .trim()
      .slice(0, 2500);
    if (!summary || summary.length < 20) {
      return { ok: false, error: "empty summary", summary: prevSummary || "" };
    }
    return { ok: true, summary, usage: result.usage, model: result.model };
  } catch (err) {
    log?.(`[summarize] ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err), summary: prevSummary || "" };
  }
}
