import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { characterFromTemplate, commandFromTemplate, COMMAND_TEMPLATES } from '@shared/defaults'
import { VOICES } from '@shared/catalog'
import type { AppSettings, Character, CustomCommand, MaincraftEvents, SettingsView } from '@shared/types'
import { agentDir, appPaths } from './paths'
import { JsonStore } from './services/jsonStore'
import { SecretStore } from './services/secrets'
import { RuntimeManager } from './services/runtime'
import { ServerManager } from './services/server'
import { BotManager } from './services/bots'
import { FeedService } from './services/feed'
import { TtsService } from './services/tts'
import { testAi } from './services/aiTest'
import { applySettingsPatch, normalizeCharacter, normalizeCommand, normalizeSettings } from './sanitize'

const TOTAL_MEM_MB = Math.round(totalmem() / 1024 / 1024)

// Honour a proxy from the environment in Chromium's network stack as well.
const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
if (envProxy) app.commandLine.appendSwitch('proxy-server', envProxy)

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null
let quitting = false

function send<E extends keyof MaincraftEvents>(event: E, payload: MaincraftEvents[E]): void {
  if (win && !win.isDestroyed()) win.webContents.send('mc:event', event, payload)
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'Maincraft',
    backgroundColor: '#101112',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarOverlay: { color: '#101112', symbolColor: '#9d978d', height: 40 } }),
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const current = win?.webContents.getURL()
    if (current && new URL(url).origin !== new URL(current).origin) event.preventDefault()
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => {
    win = null
  })
}

function bootstrap(): void {
  const paths = appPaths()
  const settingsStore = new JsonStore<AppSettings>(paths.settings, () => normalizeSettings({}, TOTAL_MEM_MB), (raw) =>
    normalizeSettings(raw, TOTAL_MEM_MB)
  )
  const characterStore = new JsonStore<Character[]>(paths.characters, () => [], (raw) =>
    Array.isArray(raw) ? raw.flatMap((c) => { try { return [normalizeCharacter(c)] } catch { return [] } }) : []
  )
  const commandStore = new JsonStore<CustomCommand[]>(
    paths.commands,
    () => COMMAND_TEMPLATES.map((_, i) => commandFromTemplate(i)),
    (raw) => (Array.isArray(raw) ? raw.flatMap((c) => { try { return [normalizeCommand(c)] } catch { return [] } }) : [])
  )
  if (!existsSync(paths.commands)) commandStore.set(commandStore.get())
  const secrets = new SecretStore(paths.secret)
  const settings = () => settingsStore.get()

  const feed = new FeedService()
  const runtime = new RuntimeManager(paths, () => settings().server.version)
  const server = new ServerManager(paths, runtime, () => settings().server)
  const bots = new BotManager(
    paths,
    {
      settings,
      character: (id) => characterStore.get().find((c) => c.id === id),
      commands: () => commandStore.get(),
      apiKey: () => secrets.get()
    },
    feed
  )
  const tts = new TtsService()

  const settingsView = (): SettingsView => ({
    settings: settings(),
    hasApiKey: secrets.has(),
    keyEncrypted: secrets.encrypted
  })

  // ---- events → UI ----
  feed.on('item', (item) => send('feed', item))
  runtime.on('progress', (p) => send('install-progress', p))
  runtime.on('state', (s) => send('runtime-state', s))
  server.on('status', (s) => send('server-status', s))
  server.on('log', (line) => send('server-log', line))
  server.on('ready', () => feed.push({ kind: 'system', text: 'Мир готов — можно заходить' }))
  server.on('join', (name) => {
    if (!bots.isBotUsername(name)) feed.push({ kind: 'join', author: name, text: `${name} зашёл в мир` })
  })
  server.on('leave', (name) => {
    const c = bots.characterByUsername(name)
    feed.push({ kind: 'leave', author: c?.name ?? name, characterId: c?.id, text: `${c?.name ?? name} вышел из мира` })
  })
  server.on('chat', (name, message) => {
    if (!bots.isBotUsername(name)) feed.push({ kind: 'chat', author: name, text: message })
  })
  server.on('death', (name, text) => {
    if (!bots.isBotUsername(name)) feed.push({ kind: 'death', author: name, text })
  })
  server.on('status', (s) => {
    // Without a world the bots cannot live: take them offline when the server stops.
    if (s.state === 'stopped' || s.state === 'crashed') void bots.stopAll()
  })
  bots.on('status', (s) => send('bot-status', s))
  bots.on('log', (characterId, line) => send('bot-log', { characterId, line }))
  bots.on('speech', (characterId, text) => {
    const c = characterStore.get().find((x) => x.id === characterId)
    if (!c || !c.voice.enabled || !settings().voice.enabled) return
    tts
      .synth(text, c.voice.voice, c.voice.rate, c.voice.pitch)
      .then((audio) => send('speech', { characterId, text, audio: new Uint8Array(audio), mime: 'audio/mpeg' }))
      .catch((err) => feed.push({ kind: 'error', characterId, author: c.name, text: `Озвучка не удалась: ${err.message}` }))
  })

  async function ensureServerRunning(): Promise<void> {
    if (server.running) return
    if (server.status().state !== 'starting') await server.start()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Мир слишком долго загружается'))
      }, 240000)
      const onStatus = (s: { state: string; message: string | null }) => {
        if (s.state === 'running') {
          cleanup()
          resolve()
        } else if (s.state === 'crashed' || s.state === 'stopped') {
          cleanup()
          reject(new Error(s.message ?? 'Сервер не запустился'))
        }
      }
      const cleanup = () => {
        clearTimeout(timer)
        server.off('status', onStatus)
      }
      server.on('status', onStatus)
      onStatus(server.status())
    })
  }

  // ---- IPC ----
  const handlers: Record<string, (...args: never[]) => unknown> = {
    'app.info': () => ({
      version: app.getVersion(),
      platform: process.platform,
      dataDir: paths.root,
      totalMemMb: TOTAL_MEM_MB,
      agentFound: existsSync(join(agentDir(), 'src', 'index.js'))
    }),
    'app.openFolder': (which: 'data' | 'server' | 'logs' | 'backups') => {
      const target = { data: paths.root, server: paths.server, logs: paths.bots, backups: paths.backups }[which]
      if (target) return shell.openPath(target)
      return undefined
    },
    'app.openExternal': (url: string) => {
      if (typeof url === 'string' && /^https:\/\//.test(url)) return shell.openExternal(url)
      return undefined
    },

    'settings.get': () => settingsView(),
    'settings.update': (patch: object) => {
      settingsStore.set(applySettingsPatch(settings(), patch, TOTAL_MEM_MB))
      void server.refreshInstalled()
      return settingsView()
    },
    'settings.setApiKey': (key: string | null) => {
      const clean = typeof key === 'string' ? key.trim() : ''
      if (clean && !/^[\x21-\x7e]{8,512}$/.test(clean)) throw new Error('Ключ содержит недопустимые символы')
      secrets.set(clean || null)
      return settingsView()
    },
    'settings.testAi': (draft?: { ai: AppSettings['ai']; key?: string }) =>
      testAi(draft?.ai ?? settings().ai, draft?.key?.trim() || secrets.get()),

    'characters.list': () => characterStore.get(),
    'characters.save': (raw: Character) => {
      const c = normalizeCharacter(raw)
      const clash = characterStore.get().find((x) => x.id !== c.id && x.username.toLowerCase() === c.username.toLowerCase())
      if (clash) throw new Error(`Ник ${c.username} уже у персонажа «${clash.name}»`)
      characterStore.update((list) => {
        const i = list.findIndex((x) => x.id === c.id)
        return i >= 0 ? list.map((x) => (x.id === c.id ? { ...c, createdAt: x.createdAt } : x)) : [...list, c]
      })
      bots.reconfigure(c.id)
      return c
    },
    'characters.remove': async (id: string) => {
      await bots.stop(id)
      characterStore.update((list) => list.filter((x) => x.id !== id))
    },

    'commands.list': () => commandStore.get(),
    'commands.save': (raw: CustomCommand) => {
      const c = normalizeCommand(raw)
      commandStore.update((list) => {
        const i = list.findIndex((x) => x.id === c.id)
        return i >= 0 ? list.map((x) => (x.id === c.id ? { ...c, createdAt: x.createdAt } : x)) : [...list, c]
      })
      bots.reconfigureAll()
      return c
    },
    'commands.remove': (id: string) => {
      commandStore.update((list) => list.filter((x) => x.id !== id))
      bots.reconfigureAll()
    },

    'runtime.state': () => runtime.state(),
    'runtime.install': async () => {
      const state = await runtime.install()
      await server.refreshInstalled()
      return state
    },

    'server.status': async () => {
      await server.refreshInstalled()
      return server.status()
    },
    'server.start': () => server.start(),
    'server.stop': async () => {
      await bots.stopAll()
      return server.stop()
    },
    'server.restart': async () => {
      await bots.stopAll()
      await server.stop()
      return server.start()
    },
    'server.send': (command: string) => server.send(String(command ?? '')),
    'server.logs': () => server.recentLogs(),
    'server.backup': () => server.backupWorld(),
    'server.resetWorld': () => server.resetWorld(),

    'bots.statuses': () => bots.statuses(characterStore.get().map((c) => c.id)),
    'bots.start': async (id: string) => {
      if (!characterStore.get().some((c) => c.id === id)) throw new Error('Персонаж не найден')
      await ensureServerRunning()
      return bots.start(id)
    },
    'bots.stop': (id: string) => bots.stop(id),
    'bots.say': (id: string, text: string) => bots.say(id, String(text ?? ''), settings().playerName || 'app'),
    'bots.command': (id: string, text: string) => bots.command(id, String(text ?? '')),
    'bots.logs': (id: string) => bots.logs(id),

    'feed.recent': () => feed.recent(),

    'voice.list': () => VOICES,
    'voice.preview': async (voice: string, rate: number, pitch: number, text: string) => {
      const audio = await tts.synth(String(text || 'Привет! Так звучит мой голос.'), voice, Number(rate) || 1, Number(pitch) || 0)
      return { characterId: '', text, audio: new Uint8Array(audio), mime: 'audio/mpeg' }
    }
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(`mc:${channel}`, async (_event, ...args) => {
      try {
        return { ok: true, value: await (handler as (...a: unknown[]) => unknown)(...args) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  void server.refreshInstalled()

  app.on('before-quit', (event) => {
    if (quitting) return
    const busy = bots.runningIds().length > 0 || server.status().state !== 'stopped'
    if (!busy || server.status().state === 'not-installed') return
    event.preventDefault()
    quitting = true
    void (async () => {
      try {
        await bots.stopAll()
        await server.stop()
      } finally {
        app.quit()
      }
    })()
  })

  // Seed a first character for brand-new installs so the roster is never empty.
  if (!existsSync(paths.characters)) characterStore.set([characterFromTemplate('companion')])
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.maincraft.app')
  bootstrap()
  createWindow()
  if (app.isPackaged) {
    import('electron-updater')
      .then(({ autoUpdater }) => autoUpdater.checkForUpdatesAndNotify())
      .catch(() => undefined)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
