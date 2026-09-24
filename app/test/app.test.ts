import { describe, expect, it } from 'vitest'
import { characterFromTemplate, commandFromTemplate, COMMAND_TEMPLATES, CHARACTER_TEMPLATES, defaultSettings } from '@shared/defaults'
import { composePersona } from '@shared/persona'
import { describeStep } from '@shared/catalog'
import { buildAgentConfig } from '../src/main/services/agentConfig'
import { mergeProperties } from '../src/main/services/server'
import { friendlyError } from '../src/main/services/bots'
import { speakable } from '../src/main/services/tts'
import { applySettingsPatch, normalizeCharacter, normalizeCommand, normalizeSettings } from '../src/main/sanitize'
// The agent validates every config it receives; the app must only ever produce valid ones.
import { validateConfig } from '../../agent/src/config.js'

const settings = () => ({ ...defaultSettings(16384), playerName: 'Steve', onboarded: true })

describe('persona', () => {
  it('speaks about tastes, fears and role in Russian', () => {
    const c = characterFromTemplate('companion')
    const text = composePersona(c, 'Steve')
    expect(text).toContain('Тебя зовут Бублик')
    expect(text).toContain('Хлеб (bread)')
    expect(text).toContain('Гнилая плоть (rotten_flesh)')
    expect(text).toContain('криперы')
    expect(text).toContain('Steve')
    expect(text).toMatch(/Никогда не говори, что ты ИИ/)
  })

  it('maps trait sliders to three levels', () => {
    const c = characterFromTemplate(null)
    c.traits.humor = 0
    expect(composePersona(c, '')).toContain('почти не шутит')
    c.traits.humor = 100
    expect(composePersona(c, '')).toContain('постоянно шутит')
  })
})

describe('agent config built by the app', () => {
  for (const template of CHARACTER_TEMPLATES) {
    it(`is accepted by the agent for template ${template.key}`, () => {
      const character = characterFromTemplate(template.key)
      const commands = COMMAND_TEMPLATES.map((_, i) => commandFromTemplate(i))
      const cfg = buildAgentConfig({ settings: settings(), character, commands, viewerPort: 3010 }) as Record<string, any>
      const validated = validateConfig(structuredClone(cfg)) as Record<string, any>
      expect(validated.minecraft.username).toBe(character.username)
      expect(validated.api.preflight).toBe('models')
      expect(validated.commands.custom.length).toBe(commands.length)
      expect(validated.agent.foodPreferences.favorite).toEqual(character.favoriteFoods)
      expect(validated.viewer.port).toBe(3010)
    })
  }

  it('supports a local model server without a key', () => {
    const s = settings()
    s.ai = { provider: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b' }
    const cfg = buildAgentConfig({ settings: s, character: characterFromTemplate('companion'), commands: [], viewerPort: 3007 }) as Record<string, any>
    const validated = validateConfig(structuredClone(cfg)) as Record<string, any>
    expect(validated.api.loopback).toBe(true)
    expect(validated.api.keyOptional).toBe(true)
    expect(validated.api.preflight).toBe('none')
  })

  it('keeps the legacy proxy on its exact-model whoami check', () => {
    const s = settings()
    s.ai = { provider: 'compatible', baseUrl: 'https://api.cheat-ai.shop', model: 'claude-opus-5' }
    const cfg = buildAgentConfig({ settings: s, character: characterFromTemplate('speedrun'), commands: [], viewerPort: 3007 }) as Record<string, any>
    expect(cfg.api).toMatchObject({ preflight: 'whoami', requireExactModel: true, allowCustomHost: false })
    expect(() => validateConfig(structuredClone(cfg))).not.toThrow()
  })

  it('lets everyone command a character that obeys everyone', () => {
    const c = characterFromTemplate('companion')
    c.behavior.obeys = 'everyone'
    const cfg = buildAgentConfig({ settings: settings(), character: c, commands: [], viewerPort: 3007 }) as Record<string, any>
    expect(cfg.agent.controllerUsers).toEqual(['*'])
    expect(() => validateConfig(structuredClone(cfg))).not.toThrow()
  })

  it('only passes commands the character knows', () => {
    const commands = COMMAND_TEMPLATES.map((_, i) => commandFromTemplate(i))
    const c = characterFromTemplate('companion')
    c.commands = [commands[0].id]
    const cfg = buildAgentConfig({ settings: settings(), character: c, commands, viewerPort: 3007 }) as Record<string, any>
    expect(cfg.commands.custom).toHaveLength(1)
  })
})

describe('sanitize', () => {
  it('rejects bad Minecraft nicknames', () => {
    const c = characterFromTemplate('companion')
    expect(() => normalizeCharacter({ ...c, username: 'Бублик' })).toThrow(/латиница/i)
    expect(() => normalizeCharacter({ ...c, username: 'ab' })).toThrow()
    expect(normalizeCharacter({ ...c, username: 'Bublik_2' }).username).toBe('Bublik_2')
  })

  it('clamps numbers and filters food ids', () => {
    const c = characterFromTemplate('companion')
    const out = normalizeCharacter({ ...c, traits: { ...c.traits, humor: 999 }, favoriteFoods: ['bread', 'DROP TABLE'] })
    expect(out.traits.humor).toBe(100)
    expect(out.favoriteFoods).toEqual(['bread'])
  })

  it('normalises triggers and drops unknown script actions', () => {
    const cmd = commandFromTemplate(1)
    const out = normalizeCommand({ ...cmd, triggers: ['!Дрова', 'дрова', ' '], steps: [...cmd.steps, { type: 'format_disk' }] })
    expect(out.triggers).toEqual(['дрова'])
    expect(out.steps.every((s) => s.type !== 'format_disk')).toBe(true)
  })

  it('requires a prompt for AI commands', () => {
    const cmd = commandFromTemplate(2)
    expect(() => normalizeCommand({ ...cmd, prompt: '  ' })).toThrow(/задание/i)
  })

  it('merges settings patches and keeps them valid', () => {
    const base = normalizeSettings({}, 16384)
    const next = applySettingsPatch(base, { server: { ramMb: 999999, difficulty: 'hard' }, playerName: 'Not Valid!' }, 16384)
    expect(next.server.ramMb).toBe(32768)
    expect(next.server.difficulty).toBe('hard')
    expect(next.playerName).toBe('')
  })
})

describe('server.properties', () => {
  it('overrides managed keys and keeps the rest', () => {
    const merged = mergeProperties('#comment\nmotd=old\nlevel-type=minecraft\\:normal\nserver-ip=0.0.0.0\n', {
      motd: 'new',
      'server-ip': '127.0.0.1',
      'spawn-protection': '0'
    })
    expect(merged).toContain('motd=new')
    expect(merged).toContain('server-ip=127.0.0.1')
    expect(merged).toContain('level-type=minecraft\\:normal')
    expect(merged).toContain('spawn-protection=0')
    expect(merged.match(/server-ip=/g)).toHaveLength(1)
  })
})

describe('messages for people', () => {
  it('turns agent errors into advice', () => {
    expect(friendlyError('API preflight failed [api_http_error]: models 401: invalid x-api-key')).toMatch(/ключ/i)
    expect(friendlyError('API key unavailable: set OPUS_API_KEY')).toMatch(/ключ/i)
    expect(friendlyError('connect ECONNREFUSED 127.0.0.1:25565')).toMatch(/мир/i)
  })

  it('cleans speech text', () => {
    expect(speakable('**Привет** 😀 https://example.com')).toBe('Привет')
  })

  it('describes script steps', () => {
    expect(describeStep({ type: 'collect', block: 'oak_log', count: 8 })).toBe('Добыть блоки: Дубовое бревно · 8')
  })
})
