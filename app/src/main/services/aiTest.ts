import { net } from 'electron'
import type { AiSettings, AiTestResult } from '@shared/types'

function explain(status: number, body: string): string {
  let detail = ''
  try {
    const data = JSON.parse(body)
    detail = String(data?.error?.message ?? data?.message ?? '')
  } catch {
    /* not JSON */
  }
  if (status === 401 || status === 403) return 'Ключ не подошёл — проверьте, что скопировали его целиком.'
  if (status === 404) return `Модель или адрес не найдены. ${detail}`.trim()
  if (status === 429) return 'Сервис ограничил частоту запросов или закончился баланс.'
  if (status === 400 && /credit|balance/i.test(detail)) return 'На счёте сервиса недостаточно средств.'
  return `Сервис ответил ошибкой ${status}. ${detail}`.trim().slice(0, 300)
}

/** One tiny real request, so the user knows the brain works before starting a world. */
export async function testAi(ai: AiSettings, key: string | null): Promise<AiTestResult> {
  let url: URL
  try {
    url = new URL(ai.baseUrl.replace(/\/+$/, '') + '/v1/messages')
  } catch {
    return { ok: false, message: 'Адрес сервиса выглядит неправильно.' }
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !local) return { ok: false, message: 'Адрес должен начинаться с https://' }
  if (!key && !local) return { ok: false, message: 'Вставьте ключ.' }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), local ? 120000 : 30000)
  try {
    const res = await net.fetch(url.toString(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key ?? 'local'
      },
      body: JSON.stringify({
        model: ai.model,
        max_tokens: 40,
        messages: [{ role: 'user', content: 'Ты персонаж Minecraft. Поздоровайся одной короткой фразой.' }]
      })
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, message: explain(res.status, text) }
    const data = JSON.parse(text)
    const sample = Array.isArray(data?.content)
      ? data.content.filter((b: { type?: string }) => b?.type === 'text').map((b: { text: string }) => b.text).join(' ').trim()
      : ''
    return {
      ok: true,
      message: 'Связь есть, ИИ отвечает.',
      model: typeof data?.model === 'string' ? data.model : ai.model,
      latencyMs: Date.now() - started,
      sample: sample.slice(0, 160)
    }
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, message: 'Сервис не ответил вовремя.' }
    const msg = err instanceof Error ? err.message : String(err)
    if (local && /ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(msg)) {
      return { ok: false, message: 'Локальная модель не отвечает. Запустите Ollama или LM Studio.' }
    }
    return { ok: false, message: `Нет связи с сервисом: ${msg}`.slice(0, 240) }
  } finally {
    clearTimeout(timer)
  }
}
