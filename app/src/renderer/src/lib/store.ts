import { create } from 'zustand'
import type {
  AppInfo,
  BotStatus,
  Character,
  CustomCommand,
  FeedItem,
  InstallProgress,
  RuntimeState,
  ServerStatus,
  SettingsPatch,
  SettingsView
} from '@shared/types'

export const api = window.maincraft

export type Route =
  | { page: 'home' }
  | { page: 'characters'; id?: string }
  | { page: 'commands'; id?: string }
  | { page: 'world' }
  | { page: 'journal'; source?: string }
  | { page: 'settings' }

export interface Toast {
  id: number
  tone: 'info' | 'success' | 'error'
  text: string
}

interface AppState {
  ready: boolean
  info: AppInfo | null
  view: SettingsView | null
  characters: Character[]
  commands: CustomCommand[]
  server: ServerStatus | null
  runtime: RuntimeState | null
  install: Partial<Record<'java' | 'paper', InstallProgress>>
  bots: Record<string, BotStatus>
  feed: FeedItem[]
  route: Route
  toasts: Toast[]
  speaking: string | null

  init(): Promise<void>
  go(route: Route): void
  toast(text: string, tone?: Toast['tone']): void
  dismiss(id: number): void
  updateSettings(patch: SettingsPatch): Promise<void>
  reloadCharacters(): Promise<void>
  reloadCommands(): Promise<void>
}

let toastSeq = 0
let started = false

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  info: null,
  view: null,
  characters: [],
  commands: [],
  server: null,
  runtime: null,
  install: {},
  bots: {},
  feed: [],
  route: { page: 'home' },
  toasts: [],
  speaking: null,

  async init() {
    if (started) return
    started = true
    api.on('server-status', (server) => set({ server }))
    api.on('runtime-state', (runtime) => set({ runtime }))
    api.on('install-progress', (p) => set((s) => ({ install: { ...s.install, [p.stage]: p } })))
    api.on('bot-status', (b) => set((s) => ({ bots: { ...s.bots, [b.characterId]: b } })))
    api.on('feed', (item) => set((s) => ({ feed: [...s.feed.slice(-499), item] })))
    api.on('speech', (e) => speech.enqueue(e.characterId, e.audio, e.mime))

    const [info, view, characters, commands, server, runtime, feed] = await Promise.all([
      api.app.info(),
      api.settings.get(),
      api.characters.list(),
      api.commands.list(),
      api.server.status(),
      api.runtime.state(),
      api.feed.recent()
    ])
    const statuses = await api.bots.statuses()
    speech.volume = view.settings.voice.volume
    set({
      ready: true,
      info,
      view,
      characters,
      commands,
      server,
      runtime,
      feed,
      bots: Object.fromEntries(statuses.map((b) => [b.characterId, b]))
    })
  },

  go(route) {
    set({ route })
  },

  toast(text, tone = 'info') {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }))
    setTimeout(() => get().dismiss(id), tone === 'error' ? 7000 : 3800)
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  async updateSettings(patch) {
    const view = await api.settings.update(patch)
    speech.volume = view.settings.voice.volume
    set({ view })
  },

  async reloadCharacters() {
    const [characters, statuses] = await Promise.all([api.characters.list(), api.bots.statuses()])
    set({ characters, bots: Object.fromEntries(statuses.map((b) => [b.characterId, b])) })
  },

  async reloadCommands() {
    set({ commands: await api.commands.list() })
  }
}))

/** Wraps an async action with an error toast so no failure is silent. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const value = await fn()
    if (success) useApp.getState().toast(success, 'success')
    return value
  } catch (err) {
    useApp.getState().toast(err instanceof Error ? err.message : String(err), 'error')
    return undefined
  }
}

/** Plays character speech one line at a time. */
class SpeechQueue {
  volume = 0.9
  private queue: Array<{ id: string; url: string }> = []
  private playing = false

  enqueue(characterId: string, audio: Uint8Array, mime: string): void {
    const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: mime }))
    this.queue.push({ id: characterId, url })
    if (this.queue.length > 6) {
      const dropped = this.queue.shift()
      if (dropped) URL.revokeObjectURL(dropped.url)
    }
    if (!this.playing) void this.next()
  }

  private async next(): Promise<void> {
    const item = this.queue.shift()
    if (!item) {
      this.playing = false
      useApp.setState({ speaking: null })
      return
    }
    this.playing = true
    useApp.setState({ speaking: item.id || null })
    const audio = new Audio(item.url)
    audio.volume = this.volume
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve()
      audio.onerror = () => resolve()
      audio.play().catch(() => resolve())
    })
    URL.revokeObjectURL(item.url)
    void this.next()
  }
}

export const speech = new SpeechQueue()

export function isBotActive(status: BotStatus | undefined): boolean {
  return Boolean(status && !['offline', 'error'].includes(status.state))
}

export const BOT_STATE_LABEL: Record<BotStatus['state'], string> = {
  offline: 'Не в мире',
  starting: 'Просыпается',
  'checking-api': 'Проверяет связь с ИИ',
  connecting: 'Входит в мир',
  online: 'В мире',
  reconnecting: 'Переподключается',
  stopping: 'Уходит',
  error: 'Ошибка'
}

export const SERVER_STATE_LABEL: Record<ServerStatus['state'], string> = {
  'not-installed': 'Не установлен',
  stopped: 'Спит',
  starting: 'Загружается',
  running: 'Онлайн',
  stopping: 'Сохраняется',
  crashed: 'Упал'
}
