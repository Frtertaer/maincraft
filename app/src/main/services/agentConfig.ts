import { composePersona } from '@shared/persona'
import type { AppSettings, Character, CustomCommand } from '@shared/types'

const PINNED_HOSTS = ['api.cheat-ai.shop', 'api.anthropic.com']
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']

export interface AgentConfigOptions {
  settings: AppSettings
  character: Character
  commands: CustomCommand[]
  viewerPort: number
}

/** Translates the app's character sheet into agent/config.json (validated again by the agent). */
export function buildAgentConfig({ settings, character: c, commands, viewerPort }: AgentConfigOptions): Record<string, unknown> {
  const url = new URL(settings.ai.baseUrl)
  const host = url.hostname.toLowerCase()
  const legacyProxy = host === 'api.cheat-ai.shop'
  const loopback = LOOPBACK.includes(host)
  const player = settings.playerName.trim()
  const me = player ? [player] : ['*']
  const courage = c.traits.courage
  const available = commands.filter((cmd) => cmd.enabled && (c.commands === 'all' || c.commands.includes(cmd.id)))

  return {
    api: {
      baseUrl: settings.ai.baseUrl,
      allowedHosts: [host],
      allowCustomHost: !PINNED_HOSTS.includes(host),
      keyEnv: 'OPUS_API_KEY',
      keyOptional: loopback,
      model: settings.ai.model,
      // The original proxy promises an exact model id; the official API may answer with a dated id.
      requireExactModel: legacyProxy,
      preflight: legacyProxy ? 'whoami' : host === 'api.anthropic.com' ? 'models' : 'none',
      maxTokens: 1024,
      temperature: Math.min(1, 0.45 + c.traits.humor / 250),
      requestTimeoutMs: loopback ? 240000 : 90000,
      maxRetries: 2,
      maxRequestsPerSession: settings.budget.maxRequestsPerSession,
      maxTotalTokens: settings.budget.maxTokensPerSession,
      budget: { maxRequestsPerMinute: settings.budget.maxRequestsPerMinute, minTokensRemaining: 0 }
    },
    minecraft: {
      host: '127.0.0.1',
      port: settings.server.port,
      username: c.username,
      version: settings.server.version,
      auth: 'offline',
      reconnect: { enabled: true, maxAttempts: 20, baseDelayMs: 2000, maxDelayMs: 30000 }
    },
    agent: {
      botName: c.name,
      mode: c.behavior.mode,
      language: 'ru',
      tickMs: Math.round(Math.max(1, c.behavior.thinkEverySec) * 1000),
      idleWhenNoGoal: true,
      maxHistory: 20,
      announceOnSpawn: false,
      companionMode: c.role === 'companion',
      persona: composePersona(c, player),
      goal: c.goal.trim() ? c.goal.trim().slice(0, 300) : null,
      allowPlayerCommands: true,
      allowPlayerChat: true,
      allowWhispers: true,
      trustOfflineUsernames: true,
      controllerUsers: c.behavior.obeys === 'everyone' ? ['*'] : me,
      chatUsers: c.behavior.talksTo === 'everyone' ? ['*'] : me,
      foodPreferences: { favorite: c.favoriteFoods, hated: c.hatedFoods }
    },
    combat: {
      enabled: c.behavior.combat !== 'off',
      mode: c.behavior.combat,
      // Courage decides when the character runs away and how far it looks for fights.
      fleeAtHealth: courage < 34 ? 10 : courage < 67 ? 6 : 3,
      engageDistance: courage < 34 ? 8 : courage < 67 ? 14 : 20,
      autoEngageHostiles: courage >= 34,
      allowPlayers: false
    },
    vision: {
      enabled: c.vision.enabled,
      source: 'viewer',
      everyNTicks: c.vision.everyNTicks,
      width: 320,
      height: 180,
      capturePath: 'vision_frame.jpg'
    },
    viewer: { enabled: true, host: '127.0.0.1', port: viewerPort, firstPerson: true },
    mantella: {
      enabled: true,
      worldId: 'world',
      tts: 'none',
      stt: 'none',
      summaryEveryTurns: 6,
      llmSummary: true,
      // Companions answer when spoken to; settlers and speedrunners think on every tick.
      turnBased: c.role === 'companion'
    },
    commands: {
      custom: available.map((cmd) => ({
        id: cmd.id,
        name: cmd.name,
        triggers: cmd.triggers,
        kind: cmd.kind,
        access: cmd.access,
        matchPlain: cmd.matchPlain,
        reply: cmd.reply,
        prompt: cmd.kind === 'ai' ? cmd.prompt : undefined,
        steps: cmd.kind === 'script' ? cmd.steps : undefined
      }))
    }
  }
}
