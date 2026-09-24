import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { AppSettings, BotLive, BotStatus, Character, CustomCommand, LogLine } from '@shared/types'
import { agentDir, type AppPaths } from '../paths'
import { buildAgentConfig } from './agentConfig'
import type { FeedService } from './feed'

const MAX_LOG = 1500
// Stack frames, Node's version footer and deprecation chatter are never the reason a bot stopped.
const NOISE = /^(Node\.js v\d|\s+at |\s*\^+\s*$|\(Use `node|\(node:\d+\) |\s*(code|errno|syscall|address|port|requireStack):|\s*[\]}']|\s*const |\s*throw )/
const IMPORTANT = /(Error|failed|Cannot|refused|invalid|denied|ECONN|ENOTFOUND|EACCES)/i
const VIEWER_BASE_PORT = 3007

interface BotProcess {
  proc: ChildProcess
  status: BotStatus
  logs: LogLine[]
  stopping: boolean
  lastProblem: string | null
  viewerPort: number
}

export interface BotDeps {
  settings(): AppSettings
  character(id: string): Character | undefined
  commands(): CustomCommand[]
  apiKey(): string | null
}

/** Maps raw agent errors to something a non-technical player can act on. */
export function friendlyError(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (/API key unavailable|does not contain a valid API key/i.test(text)) return 'Не задан ключ ИИ — добавьте его в «Настройках».'
  if (/(401|403|invalid.*key|authentication|permission)/i.test(text) && /preflight|messages|models|whoami/i.test(text))
    return 'Сервис ИИ не принял ключ. Проверьте ключ и адрес в «Настройках».'
  if (/model_unavailable|model.*not.*found|404/i.test(text) && /preflight|model/i.test(text))
    return 'Сервис ИИ не знает такую модель. Выберите другую модель в «Настройках».'
  if (/timed out|network request failed|ENOTFOUND|ECONNREFUSED.*(443|11434|1234)/i.test(text))
    return 'Не удалось связаться с сервисом ИИ. Проверьте интернет или адрес сервиса.'
  if (/balance|minimum_balance|budget/i.test(text)) return 'Закончился лимит запросов или баланс у сервиса ИИ.'
  if (/must be a valid Java username/i.test(text)) return 'Ник персонажа должен быть латиницей, 3–16 символов.'
  if (/ECONNREFUSED/i.test(text)) return 'Не удалось подключиться к миру — сервер запущен?'
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(text)) return 'Файлы бота повреждены. Переустановите приложение.'
  return text.slice(0, 240)
}

function freePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

export interface BotEvents {
  status: [BotStatus]
  log: [string, LogLine]
  speech: [string, string]
}

export class BotManager extends EventEmitter<BotEvents> {
  private bots = new Map<string, BotProcess>()

  constructor(
    private readonly paths: AppPaths,
    private readonly deps: BotDeps,
    private readonly feed: FeedService
  ) {
    super()
  }

  private offline(characterId: string, message: string | null = null): BotStatus {
    return { characterId, state: message ? 'error' : 'offline', message, viewerUrl: null, startedAt: null, live: null }
  }

  status(characterId: string): BotStatus {
    return this.bots.get(characterId)?.status ?? this.lastExit.get(characterId) ?? this.offline(characterId)
  }

  statuses(ids: string[]): BotStatus[] {
    return ids.map((id) => this.status(id))
  }

  runningIds(): string[] {
    return [...this.bots.keys()]
  }

  isBotUsername(name: string): boolean {
    return [...this.bots.values()].some((b) => b.status.live?.username === name) ||
      [...this.bots.keys()].some((id) => this.deps.character(id)?.username === name)
  }

  characterByUsername(name: string): Character | undefined {
    for (const id of this.bots.keys()) {
      const c = this.deps.character(id)
      if (c?.username.toLowerCase() === name.toLowerCase()) return c
    }
    return undefined
  }

  logs(characterId: string): LogLine[] {
    return [...(this.bots.get(characterId)?.logs ?? this.exitLogs.get(characterId) ?? [])]
  }

  private lastExit = new Map<string, BotStatus>()
  private exitLogs = new Map<string, LogLine[]>()

  private update(bot: BotProcess, patch: Partial<BotStatus>): void {
    bot.status = { ...bot.status, ...patch }
    this.emit('status', bot.status)
  }

  private log(characterId: string, bot: BotProcess, stream: LogLine['stream'], text: string): void {
    const line: LogLine = { ts: Date.now(), stream, text }
    bot.logs.push(line)
    if (bot.logs.length > MAX_LOG) bot.logs.splice(0, bot.logs.length - MAX_LOG)
    this.emit('log', characterId, line)
  }

  private async allocateViewerPort(): Promise<number> {
    const used = new Set([...this.bots.values()].map((b) => b.viewerPort))
    for (let port = VIEWER_BASE_PORT; port < VIEWER_BASE_PORT + 200; port++) {
      if (!used.has(port) && (await freePort(port))) return port
    }
    throw new Error('Нет свободного порта для просмотра глазами бота')
  }

  async start(characterId: string): Promise<BotStatus> {
    const existing = this.bots.get(characterId)
    if (existing) return existing.status
    const character = this.deps.character(characterId)
    if (!character) throw new Error('Персонаж не найден')
    const clash = [...this.bots.keys()].map((id) => this.deps.character(id)).find((c) => c?.username.toLowerCase() === character.username.toLowerCase())
    if (clash) throw new Error(`Ник ${character.username} уже занят персонажем «${clash.name}»`)
    const settings = this.deps.settings()
    const key = this.deps.apiKey()
    if (!key && settings.ai.provider !== 'local') throw new Error('Не задан ключ ИИ — добавьте его в «Настройках»')

    const dir = agentDir()
    if (!existsSync(join(dir, 'src', 'index.js'))) throw new Error('Не найдены файлы бота. Переустановите приложение.')

    const viewerPort = await this.allocateViewerPort()
    const botDir = join(this.paths.bots, characterId)
    mkdirSync(join(botDir, 'data'), { recursive: true })
    const configPath = join(botDir, 'config.json')
    const config = buildAgentConfig({ settings, character, commands: this.deps.commands(), viewerPort })
    writeFileSync(configPath, JSON.stringify(config, null, 2))

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MAINCRAFT_LOGS_DIR: join(botDir, 'data'),
      OPUS_API_KEY: key ?? ''
    }
    if (!key) delete env.OPUS_API_KEY
    // Node's fetch ignores proxy variables unless asked; honour them for users behind a proxy.
    if (env.HTTPS_PROXY || env.https_proxy) env.NODE_USE_ENV_PROXY = '1'

    const proc = spawn(process.execPath, [join(dir, 'src', 'index.js'), `--config=${configPath}`], {
      cwd: dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    })
    const bot: BotProcess = {
      proc,
      status: { characterId, state: 'starting', message: 'Персонаж просыпается…', viewerUrl: null, startedAt: Date.now(), live: null },
      logs: [],
      stopping: false,
      lastProblem: null,
      viewerPort
    }
    this.bots.set(characterId, bot)
    this.lastExit.delete(characterId)
    this.emit('status', bot.status)
    this.log(characterId, bot, 'app', `Запуск ${character.name} (${character.username}), просмотр на порту ${viewerPort}`)

    const lines = (stream: 'out' | 'err') => {
      let buffer = ''
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const parts = buffer.split(/\r?\n/)
        buffer = parts.pop() ?? ''
        for (const text of parts) {
          if (!text.trim()) continue
          this.log(characterId, bot, stream, text)
          if (NOISE.test(text)) continue
          const important = IMPORTANT.test(text)
          if (important || (stream === 'err' && !bot.lastProblem)) bot.lastProblem = text
        }
      }
    }
    proc.stdout?.on('data', lines('out'))
    proc.stderr?.on('data', lines('err'))
    proc.on('message', (msg) => this.onMessage(character, bot, msg as Record<string, unknown>))
    proc.on('error', (err) => {
      bot.lastProblem = err.message
      this.log(characterId, bot, 'app', `Процесс не запустился: ${err.message}`)
    })
    proc.on('exit', (code) => {
      this.bots.delete(characterId)
      const final: BotStatus = bot.stopping || code === 0
        ? this.offline(characterId)
        : this.offline(characterId, friendlyError(bot.lastProblem ?? `Бот завершился с кодом ${code}`))
      this.lastExit.set(characterId, final)
      this.exitLogs.set(characterId, bot.logs)
      this.log(characterId, bot, 'app', bot.stopping ? 'Персонаж ушёл из мира' : `Процесс завершился (код ${code})`)
      if (final.state === 'error') this.feed.push({ kind: 'error', characterId, author: character.name, text: final.message ?? 'Ошибка' })
      this.emit('status', final)
    })
    return bot.status
  }

  private onMessage(character: Character, bot: BotProcess, msg: Record<string, unknown>): void {
    const id = character.id
    switch (msg.type) {
      case 'lifecycle': {
        const state = String(msg.state)
        const message = typeof msg.message === 'string' ? msg.message : null
        if (state === 'api-check') this.update(bot, { state: 'checking-api', message: 'Проверяю связь с ИИ…' })
        else if (state === 'api-ready' || state === 'connecting') this.update(bot, { state: 'connecting', message: 'Вхожу в мир…' })
        else if (state === 'spawned') {
          this.update(bot, { state: 'online', message: null, viewerUrl: typeof msg.viewerUrl === 'string' ? msg.viewerUrl : null })
          this.feed.push({ kind: 'join', characterId: id, author: character.name, text: `${character.name} появился в мире` })
        } else if (state === 'reconnecting' && !bot.stopping) this.update(bot, { state: 'reconnecting', message: 'Потерял связь с миром, переподключаюсь…' })
        else if (state === 'kicked' && message) bot.lastProblem = `Kicked: ${message}`
        else if (state === 'error' && message) {
          bot.lastProblem = message
          this.update(bot, { message: friendlyError(message) })
        } else if (state === 'exiting') this.update(bot, { state: 'stopping', message: null })
        break
      }
      case 'status':
        this.update(bot, { live: msg.status as BotLive })
        break
      case 'say': {
        const text = String(msg.text ?? '')
        if (!text) break
        const speech = msg.speech === true
        this.feed.push({ kind: speech ? 'say' : 'system', characterId: id, author: character.name, text })
        if (speech) this.emit('speech', id, text)
        break
      }
      case 'step': {
        const action = (msg.action ?? {}) as { type?: string }
        const think = typeof msg.think === 'string' ? msg.think : ''
        if (!think && (!action.type || action.type === 'idle')) break
        this.feed.push({
          kind: 'think',
          characterId: id,
          author: character.name,
          text: think || `Действие: ${action.type}`,
          detail: action.type && action.type !== 'idle' ? `${action.type} → ${String(msg.result ?? '')}`.slice(0, 200) : undefined,
          ok: msg.ok === true
        })
        break
      }
      case 'command': {
        const state = String(msg.state)
        const label = state === 'started' ? 'выполняет' : state === 'queued' ? 'обдумывает' : state === 'done' ? 'выполнил' : 'не смог выполнить'
        this.feed.push({
          kind: 'command',
          characterId: id,
          author: character.name,
          text: `${label} «${String(msg.name ?? '')}»`,
          detail: typeof msg.message === 'string' ? msg.message : undefined,
          ok: state !== 'failed'
        })
        break
      }
      case 'event':
        if (msg.kind === 'death') this.feed.push({ kind: 'death', characterId: id, author: character.name, text: `${character.name} погиб` })
        break
      default:
        break
    }
  }

  async stop(characterId: string, timeoutMs = 6000): Promise<BotStatus> {
    const bot = this.bots.get(characterId)
    if (!bot) return this.status(characterId)
    bot.stopping = true
    this.update(bot, { state: 'stopping', message: 'Прощается…' })
    const exited = new Promise<void>((resolve) => bot.proc.once('exit', () => resolve()))
    try {
      if (bot.proc.connected) bot.proc.send({ type: 'shutdown' })
      else bot.proc.kill()
    } catch {
      bot.proc.kill()
    }
    const timer = setTimeout(() => bot.proc.kill('SIGKILL'), timeoutMs)
    await exited
    clearTimeout(timer)
    return this.status(characterId)
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.runningIds().map((id) => this.stop(id)))
  }

  private send(characterId: string, message: Record<string, unknown>): void {
    const bot = this.bots.get(characterId)
    if (!bot || !bot.proc.connected) throw new Error('Персонаж сейчас не в мире')
    bot.proc.send(message)
  }

  /** Pushes edited persona, taste, behaviour and commands into a character that is already in the world. */
  reconfigure(characterId: string): boolean {
    const bot = this.bots.get(characterId)
    const character = this.deps.character(characterId)
    if (!bot || !character || !bot.proc.connected) return false
    const config = buildAgentConfig({
      settings: this.deps.settings(),
      character,
      commands: this.deps.commands(),
      viewerPort: bot.viewerPort
    }) as { agent: Record<string, unknown>; combat: Record<string, unknown>; commands: Record<string, unknown> }
    const { persona, goal, foodPreferences, tickMs, mode, controllerUsers, chatUsers } = config.agent
    bot.proc.send({
      type: 'reconfigure',
      agent: { persona, goal: goal ?? '', foodPreferences, tickMs, mode, controllerUsers, chatUsers },
      combat: { mode: config.combat.mode },
      commands: config.commands
    })
    return true
  }

  reconfigureAll(): void {
    for (const id of this.runningIds()) this.reconfigure(id)
  }

  say(characterId: string, text: string, username: string): void {
    this.send(characterId, { type: 'player-say', text: text.slice(0, 400), username })
  }

  command(characterId: string, text: string): void {
    this.send(characterId, { type: 'console', text: text.slice(0, 400) })
  }
}
