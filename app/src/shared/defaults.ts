// Defaults, starter characters and starter commands.
import { MINECRAFT_VERSION } from './catalog'
import type { AppSettings, Character, CustomCommand, ProviderId } from './types'

export const PROVIDERS: Record<ProviderId, { title: string; baseUrl: string; model: string; hint: string }> = {
  anthropic: {
    title: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-5',
    hint: 'Официальный API Claude. Ключ начинается с sk-ant-'
  },
  compatible: {
    title: 'Совместимый сервис',
    baseUrl: 'https://api.cheat-ai.shop',
    model: 'claude-opus-5',
    hint: 'Любой сервис с Anthropic-совместимым API: свой адрес и ключ'
  },
  local: {
    title: 'Локальная модель',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    hint: 'Ollama или LM Studio на этом ПК — бесплатно, но слабее'
  }
}

export const MODEL_SUGGESTIONS: Record<ProviderId, string[]> = {
  anthropic: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5'],
  compatible: ['claude-opus-5', 'claude-sonnet-5'],
  local: ['qwen3:8b', 'llama3.1:8b', 'gpt-oss:20b']
}

export function defaultSettings(totalMemMb = 8192): AppSettings {
  // A quarter of RAM, between 2 and 6 GB, is plenty for a small local world.
  const ramMb = Math.max(2048, Math.min(6144, Math.round(totalMemMb / 4 / 512) * 512))
  return {
    schema: 1,
    onboarded: false,
    playerName: '',
    ai: {
      provider: 'anthropic',
      baseUrl: PROVIDERS.anthropic.baseUrl,
      model: PROVIDERS.anthropic.model
    },
    budget: {
      maxRequestsPerSession: 600,
      maxTokensPerSession: 1_500_000,
      maxRequestsPerMinute: 15
    },
    server: {
      version: MINECRAFT_VERSION,
      port: 25565,
      ramMb,
      difficulty: 'normal',
      gamemode: 'survival',
      seed: '',
      motd: 'Maincraft — мир с ИИ-персонажами',
      viewDistance: 8,
      pvp: true,
      eulaAccepted: false
    },
    voice: { enabled: true, volume: 0.9 }
  }
}

export function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) ?? Math.random().toString(36).slice(2, 12)
  return `${prefix}_${random}`
}

type CharacterSeed = Omit<Character, 'id' | 'createdAt' | 'updatedAt'>

const base: CharacterSeed = {
  name: 'Новый персонаж',
  username: 'Newbie',
  role: 'companion',
  appearance: { skin: '#e0ac7e', hair: '#4a3222', eyes: '#3b6fd8', shirt: '#2f8f83', hairStyle: 0 },
  bio: '',
  speech: '',
  traits: { friendliness: 60, humor: 50, courage: 50, talkativeness: 40, curiosity: 50 },
  likes: [],
  dislikes: [],
  favoriteFoods: [],
  hatedFoods: [],
  fears: [],
  goal: '',
  behavior: { mode: 'hybrid', combat: 'auto', thinkEverySec: 4, obeys: 'me', talksTo: 'everyone' },
  voice: { enabled: true, voice: 'ru-RU-DmitryNeural', rate: 1, pitch: 0 },
  vision: { enabled: false, everyNTicks: 3 },
  commands: 'all'
}

export interface CharacterTemplate {
  key: string
  title: string
  tagline: string
  seed: CharacterSeed
}

export const CHARACTER_TEMPLATES: CharacterTemplate[] = [
  {
    key: 'companion',
    title: 'Бублик',
    tagline: 'Весёлый спутник, который всегда рядом',
    seed: {
      ...base,
      name: 'Бублик',
      username: 'Bublik',
      role: 'companion',
      appearance: { skin: '#e8b38a', hair: '#8a4b1f', eyes: '#2f7d4f', shirt: '#d9822b', hairStyle: 1 },
      bio: 'Бывший пекарь из деревни у реки. Ушёл в приключения, потому что в деревне стало скучно.',
      speech: 'Простая разговорная речь, добродушные подколы, иногда вспоминает выпечку.',
      traits: { friendliness: 90, humor: 80, courage: 45, talkativeness: 65, curiosity: 70 },
      likes: ['закаты', 'алмазы', 'уютные дома', 'котики'],
      dislikes: ['дождь', 'грязь в сундуках'],
      favoriteFoods: ['bread', 'cookie', 'pumpkin_pie'],
      hatedFoods: ['rotten_flesh', 'spider_eye'],
      fears: ['криперы', 'тёмные пещеры'],
      goal: 'держаться рядом с игроком и помогать',
      voice: { enabled: true, voice: 'ru-RU-DmitryNeural', rate: 1.05, pitch: 8 }
    }
  },
  {
    key: 'speedrun',
    title: 'Вектор',
    tagline: 'Хладнокровно идёт к Эндер-дракону',
    seed: {
      ...base,
      name: 'Вектор',
      username: 'Vektor',
      role: 'speedrun',
      appearance: { skin: '#c68a5e', hair: '#1c1c1c', eyes: '#c0392b', shirt: '#3a3f47', hairStyle: 2 },
      bio: 'Странник, который однажды увидел финальные титры во сне и с тех пор идёт к ним.',
      speech: 'Коротко, по делу, иногда сухая ирония. Отчитывается о прогрессе.',
      traits: { friendliness: 40, humor: 25, courage: 85, talkativeness: 20, curiosity: 55 },
      likes: ['чёткий план', 'железо', 'огненные стержни'],
      dislikes: ['пустая болтовня', 'потерянное время'],
      favoriteFoods: ['cooked_beef', 'golden_carrot'],
      hatedFoods: ['rotten_flesh'],
      fears: [],
      goal: 'пройти игру: победить Эндер-дракона и увидеть титры',
      behavior: { mode: 'auto', combat: 'auto', thinkEverySec: 3, obeys: 'me', talksTo: 'everyone' },
      voice: { enabled: true, voice: 'ru-RU-DmitryNeural', rate: 0.95, pitch: -10 }
    }
  },
  {
    key: 'settler',
    title: 'Ива',
    tagline: 'Обустраивает дом, ферму и огород',
    seed: {
      ...base,
      name: 'Ива',
      username: 'Iva_Green',
      role: 'settler',
      appearance: { skin: '#f0c7a0', hair: '#c9772f', eyes: '#3d8f5a', shirt: '#6b9c3f', hairStyle: 3 },
      bio: 'Садовница. Верит, что любой мир можно сделать уютным, если посадить в нём хоть что-нибудь.',
      speech: 'Мягкая, заботливая, говорит о растениях как о живых существах.',
      traits: { friendliness: 85, humor: 45, courage: 30, talkativeness: 55, curiosity: 60 },
      likes: ['цветы', 'пшеница', 'пчёлы', 'аккуратные грядки'],
      dislikes: ['вытоптанные посевы', 'огонь в лесу'],
      favoriteFoods: ['baked_potato', 'sweet_berries', 'honey_bottle'],
      hatedFoods: ['rotten_flesh', 'pufferfish'],
      fears: ['зомби', 'пожары'],
      goal: 'построить уютный дом и огород неподалёку',
      behavior: { mode: 'hybrid', combat: 'auto', thinkEverySec: 6, obeys: 'me', talksTo: 'everyone' },
      voice: { enabled: true, voice: 'ru-RU-SvetlanaNeural', rate: 1, pitch: 4 }
    }
  },
  {
    key: 'miner',
    title: 'Дед Кирка',
    tagline: 'Ворчливый шахтёр с золотыми руками',
    seed: {
      ...base,
      name: 'Дед Кирка',
      username: 'Ded_Kirka',
      role: 'companion',
      appearance: { skin: '#d9a47a', hair: '#d8d8d8', eyes: '#5a4632', shirt: '#7a5230', hairStyle: 4 },
      bio: 'Полвека в шахтах. Знает, где искать алмазы, и не устаёт об этом напоминать.',
      speech: 'Ворчит, называет всех «салагами», любит байки про старые шахты.',
      traits: { friendliness: 35, humor: 60, courage: 70, talkativeness: 70, curiosity: 40 },
      likes: ['алмазы', 'крепкие кирки', 'тишина подземелий'],
      dislikes: ['спешка', 'когда трогают его инструменты'],
      favoriteFoods: ['cooked_porkchop', 'beetroot_soup'],
      hatedFoods: ['sweet_berries', 'cookie'],
      fears: ['лава'],
      goal: 'добыть железо и найти алмазы',
      voice: { enabled: true, voice: 'ru-RU-DmitryNeural', rate: 0.88, pitch: -14 }
    }
  }
]

export function characterFromTemplate(key: string | null): Character {
  const template = CHARACTER_TEMPLATES.find((t) => t.key === key)
  const seed: CharacterSeed = template ? structuredClone(template.seed) : structuredClone(base)
  const now = Date.now()
  return { ...seed, id: newId('chr'), createdAt: now, updatedAt: now }
}

type CommandSeed = Omit<CustomCommand, 'id' | 'createdAt' | 'updatedAt'>

export const COMMAND_TEMPLATES: CommandSeed[] = [
  {
    name: 'Ко мне',
    description: 'Персонаж бежит к позвавшему игроку',
    triggers: ['ко мне', 'сюда'],
    enabled: true,
    access: 'controllers',
    matchPlain: false,
    kind: 'script',
    prompt: '',
    steps: [{ type: 'come', player: '{player}' }],
    reply: 'Бегу, {player}!'
  },
  {
    name: 'Нарубить дерева',
    description: 'Добывает брёвна. Число можно сказать после команды: «!дрова 16»',
    triggers: ['дрова', 'наруби дерева'],
    enabled: true,
    access: 'controllers',
    matchPlain: false,
    kind: 'script',
    prompt: '',
    steps: [
      { type: 'collect', block: 'log', count: '{args|8}' },
      { type: 'chat', text: 'Готово, дрова есть.' }
    ],
    reply: ''
  },
  {
    name: 'Построй убежище',
    description: 'ИИ сам решает, как и из чего построить укрытие рядом с игроком',
    triggers: ['убежище', 'построй убежище'],
    enabled: true,
    access: 'controllers',
    matchPlain: false,
    kind: 'ai',
    prompt:
      'Построй рядом с игроком {player} (около {px} {py} {pz}) небольшое укрытие на ночь из того, что есть в инвентаре или рядом. {args}',
    steps: [],
    reply: 'Сейчас что-нибудь соорудим.'
  },
  {
    name: 'Охрана',
    description: 'Держится рядом и защищает от мобов',
    triggers: ['охраняй', 'защищай меня'],
    enabled: true,
    access: 'controllers',
    matchPlain: false,
    kind: 'ai',
    prompt: 'Охраняй игрока {player}: держись в 2–3 блоках и атакуй враждебных мобов, которые подходят близко.',
    steps: [],
    reply: 'Прикрою.'
  },
  {
    name: 'Что в карманах?',
    description: 'Рассказывает, что лежит в инвентаре',
    triggers: ['инвентарь', 'что у тебя есть'],
    enabled: true,
    access: 'everyone',
    matchPlain: false,
    kind: 'ai',
    prompt: 'Посмотри свой инвентарь и коротко, в своём стиле, скажи игроку {player}, что у тебя есть.',
    steps: [],
    reply: ''
  }
]

export function commandFromTemplate(index: number | null): CustomCommand {
  const now = Date.now()
  const seed: CommandSeed =
    index != null && COMMAND_TEMPLATES[index]
      ? structuredClone(COMMAND_TEMPLATES[index])
      : {
          name: 'Новая команда',
          description: '',
          triggers: [],
          enabled: true,
          access: 'controllers',
          matchPlain: false,
          kind: 'ai',
          prompt: '',
          steps: [],
          reply: ''
        }
  return { ...seed, id: newId('cmd'), createdAt: now, updatedAt: now }
}
