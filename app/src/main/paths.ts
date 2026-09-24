import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface AppPaths {
  root: string
  settings: string
  characters: string
  commands: string
  secret: string
  runtime: string
  java: string
  downloads: string
  server: string
  bots: string
  logs: string
  backups: string
}

let cached: AppPaths | null = null

/** Everything the app writes lives under one folder (userData, or MAINCRAFT_HOME for tests). */
export function appPaths(): AppPaths {
  if (cached) return cached
  const root = process.env.MAINCRAFT_HOME ? resolve(process.env.MAINCRAFT_HOME) : app.getPath('userData')
  const runtime = join(root, 'runtime')
  cached = {
    root,
    settings: join(root, 'settings.json'),
    characters: join(root, 'characters.json'),
    commands: join(root, 'commands.json'),
    secret: join(root, 'ai-key.bin'),
    runtime,
    java: join(runtime, 'java'),
    downloads: join(runtime, 'downloads'),
    server: join(root, 'server'),
    bots: join(root, 'bots'),
    logs: join(root, 'logs'),
    backups: join(root, 'backups')
  }
  for (const dir of [root, runtime, cached.java, cached.downloads, cached.server, cached.bots, cached.logs, cached.backups]) {
    mkdirSync(dir, { recursive: true })
  }
  return cached
}

/** The Node agent ships as an extra resource; in development it is the sibling ../agent folder. */
export function agentDir(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'agent')]
    : [resolve(app.getAppPath(), '../agent'), resolve(app.getAppPath(), '../../agent')]
  return candidates.find((dir) => existsSync(join(dir, 'src', 'index.js'))) ?? candidates[0]
}
