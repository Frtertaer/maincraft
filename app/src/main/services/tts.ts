import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { VOICES } from '@shared/catalog'

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]!)
}

/** Cleans chat text for speech: no markdown, emoji, or links read out loud. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`~#>|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

/**
 * Neural speech through the Microsoft Edge "Read aloud" service: natural Russian voices,
 * no Python and no GPU on the user's machine. Needs an internet connection.
 */
export class TtsService {
  private readonly agent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined
  private queue: Promise<unknown> = Promise.resolve()

  synth(text: string, voice: string, rate = 1, pitch = 0): Promise<Buffer> {
    // One synthesis at a time keeps the service happy and the speech in order.
    const job = this.queue.then(() => this.run(text, voice, rate, pitch))
    this.queue = job.catch(() => undefined)
    return job
  }

  private async run(text: string, voice: string, rate: number, pitch: number): Promise<Buffer> {
    const clean = speakable(text)
    if (!clean) throw new Error('Пустая фраза')
    const known = VOICES.some((v) => v.id === voice)
    const tts = new MsEdgeTTS({ agent: this.agent })
    try {
      await tts.setMetadata(known ? voice : 'ru-RU-DmitryNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
        voiceLocale: 'ru-RU'
      })
      const { audioStream } = tts.toStream(escapeXml(clean), {
        rate: Math.max(0.5, Math.min(2, rate)),
        pitch: `${pitch >= 0 ? '+' : ''}${Math.round(Math.max(-50, Math.min(50, pitch)))}%`
      })
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const timer = setTimeout(() => reject(new Error('Сервис озвучки не ответил')), 20000)
        audioStream.on('data', (chunk: Buffer) => chunks.push(chunk))
        audioStream.on('error', (err: Error) => {
          clearTimeout(timer)
          reject(err)
        })
        audioStream.on('close', () => {
          clearTimeout(timer)
          const audio = Buffer.concat(chunks)
          if (audio.length < 100) reject(new Error('Сервис озвучки вернул пустой звук'))
          else resolve(audio)
        })
      })
    } finally {
      try {
        tts.close()
      } catch {
        /* already closed */
      }
    }
  }
}
