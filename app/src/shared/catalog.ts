// Static game data used by the editors: foods, blocks, items, bot actions, voices.
import type { ScriptStep, VoiceInfo } from './types'

export const MINECRAFT_VERSION = '1.21.1'

export const FOODS: Record<string, string> = {
  apple: 'Яблоко',
  golden_apple: 'Золотое яблоко',
  enchanted_golden_apple: 'Зачарованное яблоко',
  melon_slice: 'Ломтик арбуза',
  sweet_berries: 'Сладкие ягоды',
  glow_berries: 'Светящиеся ягоды',
  chorus_fruit: 'Плод хоруса',
  carrot: 'Морковь',
  golden_carrot: 'Золотая морковь',
  potato: 'Картофель',
  baked_potato: 'Печёный картофель',
  poisonous_potato: 'Ядовитый картофель',
  beetroot: 'Свёкла',
  dried_kelp: 'Сушёная ламинария',
  beef: 'Сырая говядина',
  cooked_beef: 'Стейк',
  porkchop: 'Сырая свинина',
  cooked_porkchop: 'Жареная свинина',
  mutton: 'Сырая баранина',
  cooked_mutton: 'Жареная баранина',
  chicken: 'Сырая курица',
  cooked_chicken: 'Жареная курица',
  rabbit: 'Сырая крольчатина',
  cooked_rabbit: 'Жареная крольчатина',
  cod: 'Сырая треска',
  cooked_cod: 'Жареная треска',
  salmon: 'Сырой лосось',
  cooked_salmon: 'Жареный лосось',
  tropical_fish: 'Тропическая рыба',
  pufferfish: 'Иглобрюх',
  bread: 'Хлеб',
  cookie: 'Печенье',
  pumpkin_pie: 'Тыквенный пирог',
  mushroom_stew: 'Грибной суп',
  beetroot_soup: 'Борщ',
  rabbit_stew: 'Тушёная крольчатина',
  suspicious_stew: 'Подозрительное рагу',
  honey_bottle: 'Бутылочка мёда',
  rotten_flesh: 'Гнилая плоть',
  spider_eye: 'Паучий глаз'
}

export const BLOCKS: Record<string, string> = {
  oak_log: 'Дубовое бревно',
  birch_log: 'Берёзовое бревно',
  spruce_log: 'Еловое бревно',
  jungle_log: 'Тропическое бревно',
  acacia_log: 'Акациевое бревно',
  dark_oak_log: 'Бревно тёмного дуба',
  cherry_log: 'Вишнёвое бревно',
  stone: 'Камень',
  cobblestone: 'Булыжник',
  dirt: 'Земля',
  grass_block: 'Дёрн',
  sand: 'Песок',
  gravel: 'Гравий',
  clay: 'Глина',
  coal_ore: 'Угольная руда',
  iron_ore: 'Железная руда',
  copper_ore: 'Медная руда',
  gold_ore: 'Золотая руда',
  redstone_ore: 'Редстоуновая руда',
  lapis_ore: 'Лазуритовая руда',
  diamond_ore: 'Алмазная руда',
  deepslate_iron_ore: 'Глубинная железная руда',
  deepslate_diamond_ore: 'Глубинная алмазная руда',
  obsidian: 'Обсидиан',
  wheat: 'Пшеница',
  sugar_cane: 'Сахарный тростник',
  pumpkin: 'Тыква',
  melon: 'Арбуз'
}

export const ITEMS: Record<string, string> = {
  oak_planks: 'Дубовые доски',
  stick: 'Палка',
  crafting_table: 'Верстак',
  furnace: 'Печь',
  chest: 'Сундук',
  torch: 'Факел',
  wooden_pickaxe: 'Деревянная кирка',
  stone_pickaxe: 'Каменная кирка',
  iron_pickaxe: 'Железная кирка',
  diamond_pickaxe: 'Алмазная кирка',
  wooden_sword: 'Деревянный меч',
  stone_sword: 'Каменный меч',
  iron_sword: 'Железный меч',
  stone_axe: 'Каменный топор',
  iron_axe: 'Железный топор',
  shield: 'Щит',
  bucket: 'Ведро',
  bow: 'Лук',
  arrow: 'Стрела',
  iron_ingot: 'Железный слиток',
  gold_ingot: 'Золотой слиток',
  diamond: 'Алмаз',
  coal: 'Уголь',
  raw_iron: 'Сырое железо',
  bread: 'Хлеб',
  white_bed: 'Белая кровать',
  flint_and_steel: 'Огниво',
  ender_eye: 'Око Эндера',
  ...FOODS
}

export function itemLabel(id: string): string {
  return ITEMS[id] ?? BLOCKS[id] ?? id.replace(/_/g, ' ')
}

export type ParamKind = 'text' | 'number' | 'item' | 'block' | 'food' | 'player' | 'bool'

export interface ActionParam {
  key: string
  label: string
  kind: ParamKind
  placeholder?: string
  required?: boolean
}

export interface ActionDef {
  type: string
  label: string
  hint: string
  params: ActionParam[]
}

const XYZ: ActionParam[] = [
  { key: 'x', label: 'X', kind: 'text', placeholder: '{px}', required: true },
  { key: 'y', label: 'Y', kind: 'text', placeholder: '{py}', required: true },
  { key: 'z', label: 'Z', kind: 'text', placeholder: '{pz}', required: true }
]

/** Everything a script step may do. Mirrors agent/src/config.js SCRIPT_STEP_TYPES. */
export const ACTIONS: ActionDef[] = [
  { type: 'chat', label: 'Сказать в чат', hint: 'Сообщение от имени персонажа', params: [{ key: 'text', label: 'Текст', kind: 'text', placeholder: 'Уже иду, {player}!', required: true }] },
  { type: 'come', label: 'Подойти к игроку', hint: 'Дойти до игрока и остановиться', params: [{ key: 'player', label: 'Игрок', kind: 'player', placeholder: '{player}' }] },
  { type: 'follow', label: 'Следовать за игроком', hint: 'Держаться рядом, пока не скажут «стоп»', params: [{ key: 'player', label: 'Игрок', kind: 'player', placeholder: '{player}' }, { key: 'distance', label: 'Дистанция', kind: 'number', placeholder: '3' }] },
  { type: 'goto', label: 'Идти к точке', hint: 'Координаты можно брать у игрока: {px} {py} {pz}', params: [...XYZ, { key: 'range', label: 'Точность', kind: 'number', placeholder: '1' }] },
  { type: 'collect', label: 'Добыть блоки', hint: 'Найти рядом, добыть и подобрать', params: [{ key: 'block', label: 'Блок', kind: 'block', placeholder: 'oak_log', required: true }, { key: 'count', label: 'Сколько', kind: 'text', placeholder: '{args|8}' }] },
  { type: 'dig', label: 'Сломать блок', hint: 'Ближайший блок этого типа', params: [{ key: 'block', label: 'Блок', kind: 'block', placeholder: 'stone', required: true }] },
  { type: 'craft', label: 'Скрафтить', hint: 'Нужны материалы, для сложных вещей — верстак рядом', params: [{ key: 'item', label: 'Предмет', kind: 'item', placeholder: 'crafting_table', required: true }, { key: 'count', label: 'Сколько', kind: 'number', placeholder: '1' }] },
  { type: 'smelt', label: 'Переплавить в печи', hint: 'Нужна печь рядом и топливо', params: [{ key: 'input', label: 'Что', kind: 'item', placeholder: 'raw_iron', required: true }, { key: 'fuel', label: 'Топливо', kind: 'item', placeholder: 'coal' }, { key: 'count', label: 'Сколько', kind: 'number', placeholder: '3' }] },
  { type: 'equip', label: 'Взять в руку', hint: 'Предмет из инвентаря', params: [{ key: 'item', label: 'Предмет', kind: 'item', placeholder: 'iron_sword', required: true }] },
  { type: 'toss', label: 'Выбросить предмет', hint: 'Например, отдать игроку', params: [{ key: 'item', label: 'Предмет', kind: 'item', placeholder: 'bread', required: true }, { key: 'count', label: 'Сколько', kind: 'number', placeholder: '1' }] },
  { type: 'eat', label: 'Поесть', hint: 'Учитывает любимую и нелюбимую еду', params: [] },
  { type: 'attack', label: 'Атаковать', hint: 'Ближайшего моба указанного типа', params: [{ key: 'name', label: 'Кого', kind: 'text', placeholder: 'zombie', required: true }] },
  { type: 'place', label: 'Поставить блок', hint: 'Блок из инвентаря в точку', params: [{ key: 'item', label: 'Блок', kind: 'block', placeholder: 'cobblestone', required: true }, ...XYZ] },
  { type: 'look', label: 'Посмотреть на точку', hint: '', params: XYZ },
  { type: 'sleep', label: 'Лечь спать', hint: 'Нужна кровать рядом и ночь', params: [] },
  { type: 'container_put', label: 'Положить в сундук', hint: 'Ближайший сундук', params: [{ key: 'item', label: 'Предмет', kind: 'item', placeholder: 'cobblestone', required: true }, { key: 'count', label: 'Сколько', kind: 'number', placeholder: '64' }] },
  { type: 'container_take', label: 'Взять из сундука', hint: 'Ближайший сундук', params: [{ key: 'item', label: 'Предмет', kind: 'item', placeholder: 'iron_ingot', required: true }, { key: 'count', label: 'Сколько', kind: 'number', placeholder: '8' }] },
  { type: 'wait', label: 'Подождать', hint: 'Пауза в миллисекундах', params: [{ key: 'ms', label: 'Мс', kind: 'number', placeholder: '1000', required: true }] },
  { type: 'set_goal', label: 'Сменить цель', hint: 'Новая долгосрочная цель персонажа', params: [{ key: 'goal', label: 'Цель', kind: 'text', placeholder: 'построить ферму', required: true }] },
  { type: 'ask_ai', label: 'Передать ИИ', hint: 'Дальше персонаж решает сам', params: [{ key: 'prompt', label: 'Задание', kind: 'text', placeholder: 'Осмотрись и расскажи, что видишь', required: true }] },
  { type: 'stop', label: 'Остановиться', hint: 'Прервать движение', params: [] }
]

export const ACTION_BY_TYPE: Record<string, ActionDef> = Object.fromEntries(ACTIONS.map((a) => [a.type, a]))

export function describeStep(step: ScriptStep): string {
  const def = ACTION_BY_TYPE[step.type]
  if (!def) return step.type
  const values = def.params
    .map((p) => step[p.key])
    .filter((v) => v !== undefined && v !== '')
    .map((v) => (typeof v === 'string' ? itemLabelIfKnown(v) : String(v)))
  return values.length ? `${def.label}: ${values.join(' · ')}` : def.label
}

function itemLabelIfKnown(v: string): string {
  return ITEMS[v] ?? BLOCKS[v] ?? v
}

export const PLACEHOLDERS: Array<{ token: string; label: string }> = [
  { token: '{player}', label: 'ник того, кто позвал' },
  { token: '{args}', label: 'слова после команды' },
  { token: '{args|8}', label: 'слова после команды или 8' },
  { token: '{bot}', label: 'ник персонажа' },
  { token: '{px} {py} {pz}', label: 'координаты игрока' }
]

export const VOICES: VoiceInfo[] = [
  { id: 'ru-RU-DmitryNeural', label: 'Дмитрий', gender: 'male', native: true },
  { id: 'ru-RU-SvetlanaNeural', label: 'Светлана', gender: 'female', native: true },
  { id: 'en-US-AndrewMultilingualNeural', label: 'Эндрю', gender: 'male', native: false },
  { id: 'en-US-BrianMultilingualNeural', label: 'Брайан', gender: 'male', native: false },
  { id: 'en-AU-WilliamMultilingualNeural', label: 'Уильям', gender: 'male', native: false },
  { id: 'de-DE-FlorianMultilingualNeural', label: 'Флориан', gender: 'male', native: false },
  { id: 'fr-FR-RemyMultilingualNeural', label: 'Реми', gender: 'male', native: false },
  { id: 'it-IT-GiuseppeMultilingualNeural', label: 'Джузеппе', gender: 'male', native: false },
  { id: 'ko-KR-HyunsuMultilingualNeural', label: 'Хёнсу', gender: 'male', native: false },
  { id: 'en-US-AvaMultilingualNeural', label: 'Ава', gender: 'female', native: false },
  { id: 'en-US-EmmaMultilingualNeural', label: 'Эмма', gender: 'female', native: false },
  { id: 'de-DE-SeraphinaMultilingualNeural', label: 'Серафина', gender: 'female', native: false },
  { id: 'fr-FR-VivienneMultilingualNeural', label: 'Вивьен', gender: 'female', native: false },
  { id: 'pt-BR-ThalitaMultilingualNeural', label: 'Талита', gender: 'female', native: false }
]

export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/
