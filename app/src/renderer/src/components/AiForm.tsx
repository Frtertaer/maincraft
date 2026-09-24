import { useState } from 'react'
import type { AiSettings, AiTestResult, ProviderId } from '@shared/types'
import { MODEL_SUGGESTIONS, PROVIDERS } from '@shared/defaults'
import { Button, Field, TextInput } from './ui'
import { Icon } from './Icon'
import { api } from '../lib/store'

const KEY_LINKS: Partial<Record<ProviderId, { url: string; label: string }>> = {
  anthropic: { url: 'https://console.anthropic.com/settings/keys', label: 'Где взять ключ Anthropic' },
  local: { url: 'https://ollama.com/download', label: 'Скачать Ollama' }
}

export function AiForm({
  value,
  onChange,
  keyDraft,
  onKeyDraft,
  hasKey
}: {
  value: AiSettings
  onChange: (v: AiSettings) => void
  keyDraft: string
  onKeyDraft: (v: string) => void
  hasKey: boolean
}) {
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AiTestResult | null>(null)
  const link = KEY_LINKS[value.provider]

  const pick = (provider: ProviderId) => {
    setResult(null)
    onChange({ provider, baseUrl: PROVIDERS[provider].baseUrl, model: PROVIDERS[provider].model })
  }

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await api.settings.testAi({ ai: value, key: keyDraft.trim() || undefined }))
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="aiform">
      <div className="role-cards">
        {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => (
          <button type="button" key={id} className={`role-card ${value.provider === id ? 'is-on' : ''}`} onClick={() => pick(id)}>
            <Icon name={id === 'local' ? 'home' : id === 'anthropic' ? 'idea' : 'bolt'} size={20} />
            <strong>{PROVIDERS[id].title}</strong>
            <span>{PROVIDERS[id].hint}</span>
          </button>
        ))}
      </div>

      {value.provider !== 'anthropic' && (
        <Field label="Адрес сервиса" hint={value.provider === 'local' ? 'Ollama: http://127.0.0.1:11434 · LM Studio: http://127.0.0.1:1234' : 'Anthropic-совместимый API, адрес без /v1'}>
          <TextInput mono value={value.baseUrl} onChange={(e) => onChange({ ...value, baseUrl: e.target.value.trim() })} />
        </Field>
      )}

      <Field label="Модель">
        <TextInput mono value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value.trim() })} />
        <div className="suggest">
          {MODEL_SUGGESTIONS[value.provider].map((m) => (
            <button type="button" key={m} className={m === value.model ? 'is-on' : ''} onClick={() => onChange({ ...value, model: m })}>
              {m}
            </button>
          ))}
        </div>
      </Field>

      {value.provider !== 'local' && (
        <Field
          label="Ключ"
          hint={
            hasKey && !keyDraft
              ? 'Ключ сохранён и зашифрован. Вставь новый, чтобы заменить.'
              : 'Хранится только на этом компьютере, в зашифрованном виде.'
          }
        >
          <div className="key-row">
            <TextInput
              mono
              type={showKey ? 'text' : 'password'}
              value={keyDraft}
              placeholder={hasKey ? '••••••••••••••••  сохранён' : 'sk-…'}
              onChange={(e) => onKeyDraft(e.target.value)}
              autoComplete="off"
            />
            <Button variant="ghost" icon="eye" aria-label={showKey ? 'Скрыть ключ' : 'Показать ключ'} onClick={() => setShowKey((s) => !s)} />
          </div>
        </Field>
      )}

      <div className="aitest">
        <Button icon="bolt" busy={testing} onClick={test} disabled={value.provider !== 'local' && !hasKey && !keyDraft.trim()}>
          Проверить связь
        </Button>
        {link && (
          <a href={link.url} onClick={(e) => { e.preventDefault(); void api.app.openExternal(link.url) }}>
            {link.label} <Icon name="external" size={10} />
          </a>
        )}
      </div>
      {result && (
        <div className={`callout ${result.ok ? 'callout-good' : 'callout-bad'}`}>
          <Icon name={result.ok ? 'check' : 'warning'} size={20} />
          <div>
            <strong>{result.message}</strong>
            {result.ok && (
              <p>
                {result.sample && <>«{result.sample}» · </>}
                <span className="mono">{result.model}</span> · {result.latencyMs} мс
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
