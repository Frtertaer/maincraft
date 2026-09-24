import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { LogLine, ServerSettings, ServerStatus } from '@shared/types'
import type { RuntimeManager } from './runtime'
import type { AppPaths } from '../paths'

const MAX_LOG = 2000

/** Properties the app always controls; everything else in server.properties is left alone. */
function managedProperties(s: ServerSettings, seed: boolean): Record<string, string> {
  const props: Record<string, string> = {
    'server-ip': '127.0.0.1',
    'server-port': String(s.port),
    'online-mode': 'false',
    'enforce-secure-profile': 'false',
    motd: s.motd.replace(/[\r\n]/g, ' ').slice(0, 59),
    difficulty: s.difficulty,
    gamemode: s.gamemode,
    'view-distance': String(s.viewDistance),
    'simulation-distance': String(Math.min(s.viewDistance, 8)),
    pvp: String(s.pvp),
    'max-players': '20',
    // Bots are not operators; spawn protection would stop them from building near spawn.
    'spawn-protection': '0',
    'allow-flight': 'true',
    'enable-rcon': 'false',
    'enable-query': 'false'
  }
  if (seed) props['level-seed'] = s.seed.replace(/[\r\n]/g, '')
  return props
}

export function mergeProperties(existing: string, values: Record<string, string>): string {
  const seen = new Set<string>()
  const lines = existing.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([^#!\s][^=:]*?)\s*[=:]/)
    if (!match) return line
    const key = match[1].trim()
    if (!(key in values)) return line
    seen.add(key)
    return `${key}=${values[key]}`
  })
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) lines.push(`${key}=${value}`)
  return lines.filter((line, i, all) => !(line === '' && i === all.length - 1)).join('\n') + '\n'
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(700, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

// "[12:34:56 INFO]: text" (Paper) — the prefix is stripped before matching events.
const PREFIX = /^\[\d{2}:\d{2}:\d{2} (\w+)\]: (?:\[[^\]]*\] )?/
const DEATH = /^(\w{1,16}) (was |died|drowned|fell|blew up|burned|went up in flames|hit the ground|starved|suffocated|froze|withered|tried to swim in lava|experienced kinetic energy|walked into)/

export interface ServerEvents {
  status: [ServerStatus]
  log: [LogLine]
  ready: []
  join: [string]
  leave: [string]
  chat: [string, string]
  death: [string, string]
}

export class ServerManager extends EventEmitter<ServerEvents> {
  private proc: ChildProcessWithoutNullStreams | null = null
  private statusValue: ServerStatus
  private logs: LogLine[] = []
  private stopRequested = false
  private stopWaiters: Array<() => void> = []

  constructor(
    private readonly paths: AppPaths,
    private readonly runtime: RuntimeManager,
    private readonly settings: () => ServerSettings
  ) {
    super()
    const s = settings()
    this.statusValue = { state: 'stopped', players: [], port: s.port, version: s.version, startedAt: null, message: null }
  }

  status(): ServerStatus {
    return { ...this.statusValue, players: [...this.statusValue.players] }
  }

  recentLogs(): LogLine[] {
    return [...this.logs]
  }

  get running(): boolean {
    return this.statusValue.state === 'running'
  }

  private setStatus(patch: Partial<ServerStatus>): void {
    const s = this.settings()
    this.statusValue = { ...this.statusValue, port: s.port, version: s.version, ...patch }
    this.emit('status', this.status())
  }

  private pushLog(stream: LogLine['stream'], text: string): void {
    const line: LogLine = { ts: Date.now(), stream, text }
    this.logs.push(line)
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG)
    this.emit('log', line)
  }

  async refreshInstalled(): Promise<void> {
    if (this.proc) return
    const state = await this.runtime.state()
    const installed = state.javaReady && state.paperReady
    if (!installed && this.statusValue.state !== 'not-installed') this.setStatus({ state: 'not-installed' })
    if (installed && this.statusValue.state === 'not-installed') this.setStatus({ state: 'stopped' })
  }

  private writeConfig(s: ServerSettings): void {
    writeFileSync(join(this.paths.server, 'eula.txt'), `# Accepted in Maincraft: https://aka.ms/MinecraftEULA\neula=${s.eulaAccepted}\n`)
    const file = join(this.paths.server, 'server.properties')
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '#Minecraft server properties\n'
    const worldExists = existsSync(join(this.paths.server, 'world', 'level.dat'))
    writeFileSync(file, mergeProperties(existing, managedProperties(s, !worldExists)))
  }

  async start(): Promise<ServerStatus> {
    if (this.proc) return this.status()
    const s = this.settings()
    const java = this.runtime.javaPath()
    const state = await this.runtime.state()
    if (!java || !state.paperReady) {
      this.setStatus({ state: 'not-installed', message: 'Сначала нужно установить Java и сервер' })
      throw new Error('Сервер ещё не установлен')
    }
    if (!s.eulaAccepted) throw new Error('Нужно принять лицензию Minecraft (EULA)')
    if (await portInUse(s.port)) {
      this.setStatus({ state: 'crashed', message: `Порт ${s.port} уже занят — возможно, другой сервер Minecraft уже запущен` })
      throw new Error(`Порт ${s.port} уже занят`)
    }

    this.writeConfig(s)
    this.stopRequested = false
    this.setStatus({ state: 'starting', players: [], startedAt: Date.now(), message: 'Мир загружается…' })
    this.pushLog('app', `Запуск Paper ${state.paperVersion} #${state.paperBuild} · ${s.ramMb} МБ ОЗУ`)

    const ram = Math.max(1024, s.ramMb)
    const args = [
      `-Xms${Math.min(1024, ram)}M`,
      `-Xmx${ram}M`,
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      // Console output in UTF-8, otherwise Cyrillic chat turns into "???" (Windows consoles default to cp866/cp1251).
      '-Dfile.encoding=UTF-8',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      '-Dsun.stdout.encoding=UTF-8',
      '-Dsun.stderr.encoding=UTF-8',
      '-jar',
      'paper.jar',
      '--nogui'
    ]
    const proc = spawn(java, args, {
      cwd: this.paths.server,
      windowsHide: true
    })
    this.proc = proc

    const onData = (stream: 'out' | 'err') => {
      let buffer = ''
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const text = raw.replace(/\u001b\[[0-9;]*m/g, '')
          if (!text.trim()) continue
          this.pushLog(stream, text)
          this.parseLine(text)
        }
      }
    }
    proc.stdout.on('data', onData('out'))
    proc.stderr.on('data', onData('err'))
    proc.on('error', (err) => {
      this.pushLog('app', `Не удалось запустить Java: ${err.message}`)
      this.setStatus({ state: 'crashed', message: `Не удалось запустить Java: ${err.message}` })
    })
    proc.on('exit', (code) => {
      this.proc = null
      const clean = this.stopRequested
      this.pushLog('app', clean ? 'Сервер остановлен' : `Сервер завершился (код ${code})`)
      this.setStatus({
        state: clean ? 'stopped' : 'crashed',
        players: [],
        startedAt: null,
        message: clean ? null : this.statusValue.message ?? `Сервер неожиданно завершился (код ${code}). Подробности — в журнале.`
      })
      for (const waiter of this.stopWaiters.splice(0)) waiter()
    })
    return this.status()
  }

  private parseLine(line: string): void {
    const match = line.match(PREFIX)
    const body = match ? line.slice(match[0].length) : line
    if (/^Done \([\d.,]+s\)!/.test(body)) {
      this.setStatus({ state: 'running', message: null })
      this.emit('ready')
      return
    }
    if (/FAILED TO BIND TO PORT/i.test(body)) {
      this.setStatus({ message: `Порт ${this.settings().port} занят другой программой` })
      return
    }
    if (/You need to agree to the EULA/i.test(body)) {
      this.setStatus({ message: 'Нужно принять лицензию Minecraft (EULA)' })
      return
    }
    let m = body.match(/^(\w{1,16}) joined the game$/)
    if (m) {
      const players = [...new Set([...this.statusValue.players, m[1]])]
      this.setStatus({ players })
      this.emit('join', m[1])
      return
    }
    m = body.match(/^(\w{1,16}) left the game$/)
    if (m) {
      this.setStatus({ players: this.statusValue.players.filter((p) => p !== m![1]) })
      this.emit('leave', m[1])
      return
    }
    m = body.match(/^<(\w{1,16})> (.*)$/)
    if (m) {
      this.emit('chat', m[1], m[2])
      return
    }
    m = body.match(DEATH)
    if (m && this.statusValue.players.includes(m[1])) this.emit('death', m[1], body)
  }

  async send(command: string): Promise<void> {
    const clean = command.replace(/[\r\n]+/g, ' ').trim().replace(/^\//, '')
    if (!clean) return
    if (!this.proc) throw new Error('Сервер не запущен')
    this.pushLog('app', `> ${clean}`)
    this.proc.stdin.write(`${clean}\n`)
  }

  async stop(timeoutMs = 45000): Promise<ServerStatus> {
    const proc = this.proc
    if (!proc) return this.status()
    this.stopRequested = true
    this.setStatus({ state: 'stopping', message: 'Сохраняю мир…' })
    const exited = new Promise<void>((resolve) => this.stopWaiters.push(resolve))
    try {
      proc.stdin.write('stop\n')
    } catch {
      /* stdin already closed */
    }
    const timer = setTimeout(() => {
      this.pushLog('app', 'Сервер не остановился вовремя — завершаю принудительно')
      proc.kill('SIGKILL')
    }, timeoutMs)
    await exited
    clearTimeout(timer)
    return this.status()
  }

  async backupWorld(): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const target = join(this.paths.backups, `world-${stamp}`)
    if (this.proc) {
      await this.send('save-all flush')
      await new Promise((r) => setTimeout(r, 1500))
    }
    for (const dim of ['world', 'world_nether', 'world_the_end']) {
      const src = join(this.paths.server, dim)
      if (existsSync(src)) cpSync(src, join(target, dim), { recursive: true, filter: (p) => !p.endsWith('session.lock') })
    }
    return target
  }

  async resetWorld(): Promise<void> {
    if (this.proc) throw new Error('Сначала остановите сервер')
    await this.backupWorld()
    for (const dim of ['world', 'world_nether', 'world_the_end']) {
      rmSync(join(this.paths.server, dim), { recursive: true, force: true })
    }
  }
}
