import { net } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, renameSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'

export const USER_AGENT = 'Maincraft-Desktop/0.1 (+https://github.com/frtertaer/maincraft)'

/** net.fetch goes through Chromium's network stack, so system proxies and certificates just work. */
export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await net.fetch(url, {
      ...init,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(init.headers ?? {}) },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`${new URL(url).host} ответил ${res.status}`)
    return (await res.json()) as T
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`${new URL(url).host} не ответил вовремя`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export interface DownloadOptions {
  sha256?: string
  size?: number
  onProgress?: (received: number, total: number) => void
}

/** Streams a file to disk, verifying size and SHA-256 before it is moved into place. */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const part = `${dest}.part`
  rmSync(part, { force: true })
  const res = await net.fetch(url, { headers: { 'user-agent': USER_AGENT } })
  if (!res.ok || !res.body) throw new Error(`Не удалось скачать ${new URL(url).pathname.split('/').pop()}: ${res.status}`)
  const total = Number(res.headers.get('content-length')) || opts.size || 0
  const hash = createHash('sha256')
  const out = createWriteStream(part)
  let received = 0
  let lastReport = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      received += value.byteLength
      if (!out.write(value)) await once(out, 'drain')
      const now = Date.now()
      if (now - lastReport > 120) {
        lastReport = now
        opts.onProgress?.(received, total)
      }
    }
    out.end()
    await once(out, 'finish')
  } catch (err) {
    out.destroy()
    rmSync(part, { force: true })
    throw err
  }
  opts.onProgress?.(received, total)
  if (opts.size && statSync(part).size !== opts.size) {
    rmSync(part, { force: true })
    throw new Error('Файл скачался не полностью. Проверьте интернет и попробуйте ещё раз.')
  }
  const digest = hash.digest('hex')
  if (opts.sha256 && digest !== opts.sha256.toLowerCase()) {
    rmSync(part, { force: true })
    throw new Error('Контрольная сумма файла не совпала — загрузка отменена ради безопасности.')
  }
  rmSync(dest, { force: true })
  renameSync(part, dest)
}
