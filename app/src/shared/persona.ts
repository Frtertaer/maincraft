// Turns the character sheet from the editor into the prompt the model receives.
import { FOODS } from './catalog'
import type { Character, CharacterRole, Traits } from './types'

type Scale = [string, string, string]

const TRAIT_WORDS: Record<keyof Traits, Scale> = {
  friendliness: [
    'держится холодно и не спешит доверять',
    'вежлив, но держит дистанцию',
    'тёплый и открытый, искренне рад компании'
  ],
  humor: [
    'серьёзен и почти не шутит',
    'иногда шутит к месту',
    'постоянно шутит и подкалывает собеседника'
  ],
  courage: [
    'осторожен, избегает драк и лишнего риска',
    'рискует, только когда уверен в себе',
    'смел и первым бросается в бой'
  ],
  talkativeness: [
    'немногословен, отвечает одной короткой фразой',
    'говорит по делу, без лишних слов',
    'болтлив, любит рассказывать истории'
  ],
  curiosity: [
    'домосед, не любит уходить далеко от дома',
    'исследует мир, когда есть повод',
    'неутомимый исследователь, тянется ко всему новому'
  ]
}

export const TRAIT_LABELS: Record<keyof Traits, [string, string]> = {
  friendliness: ['Холодный', 'Дружелюбный'],
  humor: ['Серьёзный', 'Шутник'],
  courage: ['Осторожный', 'Смелый'],
  talkativeness: ['Молчун', 'Болтун'],
  curiosity: ['Домосед', 'Исследователь']
}

export const ROLE_INFO: Record<CharacterRole, { title: string; short: string; prompt: string }> = {
  companion: {
    title: 'Спутник',
    short: 'Ходит рядом, болтает, помогает по просьбе',
    prompt:
      'Ты спутник игрока: держишься рядом, разговариваешь и помогаешь, когда просят. Сам ничего большого не затеваешь без просьбы.'
  },
  settler: {
    title: 'Житель',
    short: 'Живёт своей жизнью: строит, добывает, обустраивается',
    prompt:
      'Ты самостоятельный житель этого мира: у тебя свои дела — добывать, строить, обустраивать жильё. Игрока встречаешь как соседа и охотно общаешься.'
  },
  speedrun: {
    title: 'Прохождение',
    short: 'С нуля идёт к Эндер-дракону и финальным титрам',
    prompt:
      'Твоя главная задача — пройти Minecraft с нуля до финальных титров: ресурсы, инструменты, броня, Незер, огненные стержни, жемчуг Эндера, крепость, портал в Край и победа над Эндер-драконом. Действуй последовательно и не отвлекайся надолго.'
  }
}

function level(value: number): 0 | 1 | 2 {
  if (value < 34) return 0
  if (value < 67) return 1
  return 2
}

function list(values: string[]): string {
  return values.map((v) => v.trim()).filter(Boolean).join(', ')
}

function foods(ids: string[]): string {
  return ids.map((id) => `${FOODS[id] ?? id} (${id})`).join(', ')
}

export function composePersona(c: Character, playerName: string): string {
  const lines: string[] = []
  lines.push(`Тебя зовут ${c.name}. Твой ник в игре — ${c.username}.`)
  if (c.bio.trim()) lines.push(c.bio.trim())
  const traits = (Object.keys(TRAIT_WORDS) as Array<keyof Traits>).map(
    (key) => TRAIT_WORDS[key][level(c.traits[key])]
  )
  lines.push(`Характер: ${traits.join('; ')}.`)
  if (c.speech.trim()) lines.push(`Манера речи: ${c.speech.trim()}`)
  if (list(c.likes)) lines.push(`Ты любишь: ${list(c.likes)}.`)
  if (list(c.dislikes)) lines.push(`Ты терпеть не можешь: ${list(c.dislikes)}.`)
  if (c.favoriteFoods.length) lines.push(`Любимая еда: ${foods(c.favoriteFoods)} — радуешься, когда удаётся её поесть.`)
  if (c.hatedFoods.length)
    lines.push(
      `Еда, которую ты не выносишь: ${foods(c.hatedFoods)}. Отказываешься её есть, пока не начнёшь по-настоящему голодать, и ворчишь, если предлагают.`
    )
  if (list(c.fears)) lines.push(`Ты боишься: ${list(c.fears)}.`)
  lines.push(ROLE_INFO[c.role].prompt)
  if (c.goal.trim()) lines.push(`Твоя цель сейчас: ${c.goal.trim()}.`)
  if (playerName) lines.push(`Игрок, с которым ты играешь, — ${playerName}.`)
  lines.push(
    'Всегда оставайся в образе. Никогда не говори, что ты ИИ, модель или программа. Говори по-русски, как живой персонаж.'
  )
  return lines.join('\n')
}
