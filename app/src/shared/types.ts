// Types shared by the main process, the preload bridge and the UI.

export type ProviderId = 'anthropic' | 'compatible' | 'local'

export interface AiSettings {
  provider: ProviderId
  baseUrl: string
  model: string
}

export interface BudgetSettings {
  /** Max LLM requests one bot may make per session. */
  maxRequestsPerSession: number
  /** Max tokens one bot may spend per session. */
  maxTokensPerSession: number
  maxRequestsPerMinute: number
}

export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'
export type GameMode = 'survival' | 'creative' | 'adventure'

export interface ServerSettings {
  version: string
  port: number
  ramMb: number
  difficulty: Difficulty
  gamemode: GameMode
  seed: string
  motd: string
  viewDistance: number
  pvp: boolean
  eulaAccepted: boolean
}

export interface VoiceSettings {
  /** Speak character lines through the PC speakers. */
  enabled: boolean
  volume: number
}

export interface AppSettings {
  schema: 1
  onboarded: boolean
  /** The human player's Minecraft nickname; bots obey and talk to this player. */
  playerName: string
  ai: AiSettings
  budget: BudgetSettings
  server: ServerSettings
  voice: VoiceSettings
}

export interface SettingsView {
  settings: AppSettings
  hasApiKey: boolean
  /** False when the OS keychain is unavailable and the key is stored obfuscated only. */
  keyEncrypted: boolean
}

export type CharacterRole = 'companion' | 'settler' | 'speedrun'
export type BrainMode = 'auto' | 'hybrid' | 'listen' | 'observe'
export type CombatMode = 'auto' | 'hold' | 'off'

export interface Traits {
  friendliness: number
  humor: number
  courage: number
  talkativeness: number
  curiosity: number
}

export interface Appearance {
  skin: string
  hair: string
  eyes: string
  shirt: string
  hairStyle: number
}

export interface Character {
  id: string
  /** Name used in speech, may be Cyrillic ("Бублик"). */
  name: string
  /** Minecraft nickname of the bot: Latin letters, digits, underscore. */
  username: string
  role: CharacterRole
  appearance: Appearance
  bio: string
  speech: string
  traits: Traits
  likes: string[]
  dislikes: string[]
  favoriteFoods: string[]
  hatedFoods: string[]
  fears: string[]
  /** What the character pursues right after joining. */
  goal: string
  behavior: {
    mode: BrainMode
    combat: CombatMode
    thinkEverySec: number
    obeys: 'me' | 'everyone'
    talksTo: 'me' | 'everyone'
  }
  voice: { enabled: boolean; voice: string; rate: number; pitch: number }
  vision: { enabled: boolean; everyNTicks: number }
  /** 'all' or a list of custom command ids available to this character. */
  commands: 'all' | string[]
  createdAt: number
  updatedAt: number
}

export type StepValue = string | number | boolean
export interface ScriptStep {
  type: string
  [param: string]: StepValue
}

export interface CustomCommand {
  id: string
  name: string
  description: string
  triggers: string[]
  enabled: boolean
  access: 'controllers' | 'everyone'
  /** Also react to the phrase in plain chat, without "!" or the bot's name. */
  matchPlain: boolean
  kind: 'ai' | 'script'
  prompt: string
  steps: ScriptStep[]
  reply: string
  createdAt: number
  updatedAt: number
}

export interface RuntimeState {
  javaReady: boolean
  javaVersion: string | null
  paperReady: boolean
  paperBuild: number | null
  paperVersion: string | null
  worldExists: boolean
  installing: boolean
}

export type InstallStage = 'java' | 'paper'
export interface InstallProgress {
  stage: InstallStage
  phase: 'resolve' | 'download' | 'verify' | 'extract' | 'done' | 'error'
  received: number
  total: number
  message: string
}

export type ServerState = 'not-installed' | 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface ServerStatus {
  state: ServerState
  players: string[]
  port: number
  version: string
  startedAt: number | null
  message: string | null
}

export type BotState =
  | 'offline'
  | 'starting'
  | 'checking-api'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'stopping'
  | 'error'

export interface BotLive {
  username: string
  health: number
  food: number
  xpLevel: number
  position: { x: number; y: number; z: number }
  dimension: string
  timeOfDay: number
  isDay: boolean
  gameMode: string | null
  mode: string | null
  goal: string | null
  plan: string[]
  paused: boolean
  lastThink: string | null
  lastAction: { type: string | null; ok: boolean; message: string } | null
  lastError: string | null
  activeCommand: { text: string; from: string; turns: number } | null
  budget: { requestsUsed: number; requestLimit: number | null; tokensUsed: number; tokenLimit: number | null } | null
  combat: { mode: string | null } | null
  inventory: Array<{ name: string; count: number }>
  players: Array<{ name: string; distance: number | null }>
}

export interface BotStatus {
  characterId: string
  state: BotState
  message: string | null
  viewerUrl: string | null
  startedAt: number | null
  live: BotLive | null
}

export type FeedKind =
  | 'chat'
  | 'say'
  | 'think'
  | 'join'
  | 'leave'
  | 'death'
  | 'command'
  | 'system'
  | 'error'

export interface FeedItem {
  id: string
  ts: number
  kind: FeedKind
  characterId?: string
  author?: string
  text: string
  detail?: string
  ok?: boolean
}

export interface LogLine {
  ts: number
  stream: 'out' | 'err' | 'app'
  text: string
}

export interface AiTestResult {
  ok: boolean
  message: string
  model?: string
  latencyMs?: number
  sample?: string
}

export interface VoiceInfo {
  id: string
  label: string
  gender: 'male' | 'female'
  native: boolean
}

export interface SpeechEvent {
  characterId: string
  text: string
  audio: Uint8Array
  mime: string
}

export interface AppInfo {
  version: string
  platform: NodeJS.Platform | string
  dataDir: string
  totalMemMb: number
  agentFound: boolean
}

export type Unsubscribe = () => void

export interface MaincraftEvents {
  'server-status': ServerStatus
  'server-log': LogLine
  'bot-status': BotStatus
  'bot-log': { characterId: string; line: LogLine }
  feed: FeedItem
  'install-progress': InstallProgress
  'runtime-state': RuntimeState
  speech: SpeechEvent
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
export type SettingsPatch = DeepPartial<AppSettings>

/** The API exposed to the UI as window.maincraft. */
export interface MaincraftApi {
  app: {
    info(): Promise<AppInfo>
    openFolder(which: 'data' | 'server' | 'logs' | 'backups'): Promise<void>
    openExternal(url: string): Promise<void>
  }
  settings: {
    get(): Promise<SettingsView>
    update(patch: SettingsPatch): Promise<SettingsView>
    setApiKey(key: string | null): Promise<SettingsView>
    testAi(draft?: { ai: AiSettings; key?: string }): Promise<AiTestResult>
  }
  characters: {
    list(): Promise<Character[]>
    save(character: Character): Promise<Character>
    remove(id: string): Promise<void>
  }
  commands: {
    list(): Promise<CustomCommand[]>
    save(command: CustomCommand): Promise<CustomCommand>
    remove(id: string): Promise<void>
  }
  runtime: {
    state(): Promise<RuntimeState>
    install(): Promise<RuntimeState>
  }
  server: {
    status(): Promise<ServerStatus>
    start(): Promise<ServerStatus>
    stop(): Promise<ServerStatus>
    restart(): Promise<ServerStatus>
    send(command: string): Promise<void>
    logs(): Promise<LogLine[]>
    backup(): Promise<string>
    resetWorld(): Promise<void>
  }
  bots: {
    statuses(): Promise<BotStatus[]>
    start(characterId: string): Promise<BotStatus>
    stop(characterId: string): Promise<BotStatus>
    say(characterId: string, text: string): Promise<void>
    command(characterId: string, text: string): Promise<void>
    logs(characterId: string): Promise<LogLine[]>
  }
  feed: {
    recent(): Promise<FeedItem[]>
  }
  voice: {
    list(): Promise<VoiceInfo[]>
    preview(voice: string, rate: number, pitch: number, text: string): Promise<SpeechEvent>
  }
  on<E extends keyof MaincraftEvents>(event: E, listener: (payload: MaincraftEvents[E]) => void): Unsubscribe
}
