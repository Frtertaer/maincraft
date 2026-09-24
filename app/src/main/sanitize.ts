// Defensive normalisation of objects coming from the UI before they are persisted.
import { characterFromTemplate, commandFromTemplate, defaultSettings } from '@shared/defaults'
import { ACTION_BY_TYPE, USERNAME_RE } from '@shared/catalog'
import type { AppSettings, Character, CustomCommand, ScriptStep, SettingsPatch } from '@shared/types'

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const str = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' ? v.slice(0, max) : fallback)
const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems) : []
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)
const color = (v: unknown, fallback: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback)

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue
    const current = out[key]
    out[key] =
      current && typeof current === 'object' && !Array.isArray(current) ? deepMerge(current, value) : value ?? current
  }
  return out as T
}

export function normalizeSettings(raw: unknown, totalMemMb: number): AppSettings {
  const d = defaultSettings(totalMemMb)
  const s = deepMerge(d, raw)
  return {
    schema: 1,
    onboarded: Boolean(s.onboarded),
    playerName: USERNAME_RE.test(str(s.playerName, 16)) ? str(s.playerName, 16) : '',
    ai: {
      provider: oneOf(s.ai.provider, ['anthropic', 'compatible', 'local'] as const, d.ai.provider),
      baseUrl: str(s.ai.baseUrl, 300, d.ai.baseUrl).trim() || d.ai.baseUrl,
      model: str(s.ai.model, 120, d.ai.model).trim() || d.ai.model
    },
    budget: {
      maxRequestsPerSession: Math.round(clamp(s.budget.maxRequestsPerSession, 10, 100000, d.budget.maxRequestsPerSession)),
      maxTokensPerSession: Math.round(clamp(s.budget.maxTokensPerSession, 10000, 1_000_000_000, d.budget.maxTokensPerSession)),
      maxRequestsPerMinute: Math.round(clamp(s.budget.maxRequestsPerMinute, 1, 600, d.budget.maxRequestsPerMinute))
    },
    server: {
      version: /^\d+\.\d+(\.\d+)?$/.test(str(s.server.version, 12)) ? s.server.version : d.server.version,
      port: Math.round(clamp(s.server.port, 1024, 65535, d.server.port)),
      ramMb: Math.round(clamp(s.server.ramMb, 1024, 32768, d.server.ramMb)),
      difficulty: oneOf(s.server.difficulty, ['peaceful', 'easy', 'normal', 'hard'] as const, d.server.difficulty),
      gamemode: oneOf(s.server.gamemode, ['survival', 'creative', 'adventure'] as const, d.server.gamemode),
      seed: str(s.server.seed, 64),
      motd: str(s.server.motd, 59, d.server.motd),
      viewDistance: Math.round(clamp(s.server.viewDistance, 3, 16, d.server.viewDistance)),
      pvp: Boolean(s.server.pvp),
      eulaAccepted: Boolean(s.server.eulaAccepted)
    },
    voice: {
      enabled: Boolean(s.voice.enabled),
      volume: clamp(s.voice.volume, 0, 1, d.voice.volume)
    }
  }
}

export function applySettingsPatch(current: AppSettings, patch: SettingsPatch, totalMemMb: number): AppSettings {
  return normalizeSettings(deepMerge(current, patch), totalMemMb)
}

export function normalizeCharacter(raw: Partial<Character>): Character {
  const d = characterFromTemplate(null)
  const c = deepMerge(d, raw)
  const username = str(c.username, 16).trim()
  if (!USERNAME_RE.test(username)) throw new Error('Ник в игре: только латиница, цифры и «_», от 3 до 16 символов')
  const name = str(c.name, 40).trim()
  if (!name) throw new Error('У персонажа должно быть имя')
  return {
    id: /^[\w-]{3,64}$/.test(str(raw.id, 64)) ? (raw.id as string) : d.id,
    name,
    username,
    role: oneOf(c.role, ['companion', 'settler', 'speedrun'] as const, 'companion'),
    appearance: {
      skin: color(c.appearance.skin, d.appearance.skin),
      hair: color(c.appearance.hair, d.appearance.hair),
      eyes: color(c.appearance.eyes, d.appearance.eyes),
      shirt: color(c.appearance.shirt, d.appearance.shirt),
      hairStyle: Math.round(clamp(c.appearance.hairStyle, 0, 7, 0))
    },
    bio: str(c.bio, 1200),
    speech: str(c.speech, 600),
    traits: {
      friendliness: clamp(c.traits.friendliness, 0, 100, 50),
      humor: clamp(c.traits.humor, 0, 100, 50),
      courage: clamp(c.traits.courage, 0, 100, 50),
      talkativeness: clamp(c.traits.talkativeness, 0, 100, 50),
      curiosity: clamp(c.traits.curiosity, 0, 100, 50)
    },
    likes: strList(c.likes, 20, 60),
    dislikes: strList(c.dislikes, 20, 60),
    favoriteFoods: strList(c.favoriteFoods, 12, 40).filter((f) => /^[a-z0-9_]+$/.test(f)),
    hatedFoods: strList(c.hatedFoods, 12, 40).filter((f) => /^[a-z0-9_]+$/.test(f)),
    fears: strList(c.fears, 12, 60),
    goal: str(c.goal, 300),
    behavior: {
      mode: oneOf(c.behavior.mode, ['auto', 'hybrid', 'listen', 'observe'] as const, 'hybrid'),
      combat: oneOf(c.behavior.combat, ['auto', 'hold', 'off'] as const, 'auto'),
      thinkEverySec: clamp(c.behavior.thinkEverySec, 1, 120, 4),
      obeys: oneOf(c.behavior.obeys, ['me', 'everyone'] as const, 'me'),
      talksTo: oneOf(c.behavior.talksTo, ['me', 'everyone'] as const, 'everyone')
    },
    voice: {
      enabled: Boolean(c.voice.enabled),
      voice: str(c.voice.voice, 80, d.voice.voice) || d.voice.voice,
      rate: clamp(c.voice.rate, 0.5, 2, 1),
      pitch: clamp(c.voice.pitch, -50, 50, 0)
    },
    vision: { enabled: Boolean(c.vision.enabled), everyNTicks: Math.round(clamp(c.vision.everyNTicks, 1, 20, 3)) },
    commands: c.commands === 'all' ? 'all' : strList(c.commands, 200, 64),
    createdAt: clamp(c.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    updatedAt: Date.now()
  }
}

function normalizeStep(raw: unknown): ScriptStep | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const type = str(src.type, 40)
  if (!ACTION_BY_TYPE[type]) return null
  const step: ScriptStep = { type }
  for (const [key, value] of Object.entries(src)) {
    if (key === 'type' || !/^[A-Za-z_]\w{0,39}$/.test(key)) continue
    if (typeof value === 'string' && value.trim() !== '') step[key] = value.slice(0, 500)
    else if (typeof value === 'number' && Number.isFinite(value)) step[key] = value
    else if (typeof value === 'boolean') step[key] = value
  }
  return step
}

export function normalizeCommand(raw: Partial<CustomCommand>): CustomCommand {
  const d = commandFromTemplate(null)
  const c = deepMerge(d, raw)
  const name = str(c.name, 80).trim()
  if (!name) throw new Error('Назовите команду')
  const triggers = [...new Set(strList(raw.triggers, 12, 60).map((t) => t.replace(/^[!/]+/, '').trim().toLowerCase()).filter(Boolean))]
  if (!triggers.length) throw new Error('Добавьте хотя бы одну фразу для вызова')
  const kind = oneOf(c.kind, ['ai', 'script'] as const, 'ai')
  const steps = kind === 'script' ? (Array.isArray(raw.steps) ? raw.steps : []).map(normalizeStep).filter((s): s is ScriptStep => Boolean(s)).slice(0, 50) : []
  if (kind === 'script' && !steps.length) throw new Error('Добавьте в сценарий хотя бы один шаг')
  const prompt = str(c.prompt, 2000).trim()
  if (kind === 'ai' && !prompt) throw new Error('Опишите задание для ИИ')
  return {
    id: /^[\w-]{3,64}$/.test(str(raw.id, 64)) ? (raw.id as string) : d.id,
    name,
    description: str(c.description, 300),
    triggers,
    enabled: Boolean(c.enabled),
    access: oneOf(c.access, ['controllers', 'everyone'] as const, 'controllers'),
    matchPlain: Boolean(c.matchPlain),
    kind,
    prompt: kind === 'ai' ? prompt : '',
    steps,
    reply: str(c.reply, 256),
    createdAt: clamp(c.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    updatedAt: Date.now()
  }
}
