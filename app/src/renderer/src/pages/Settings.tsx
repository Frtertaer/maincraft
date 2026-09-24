import { useEffect, useRef, useState } from 'react'
import type { AiSettings, BudgetSettings } from '@shared/types'
import { USERNAME_RE } from '@shared/catalog'
import { AiForm } from '../components/AiForm'
import { Button, CopyText, Field, Section, Slider, TextInput, Toggle } from '../components/ui'
import { api, attempt, useApp } from '../lib/store'

export function SettingsPage() {
  const view = useApp((s) => s.view)
  const info = useApp((s) => s.info)
  const updateSettings = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)
  const [ai, setAi] = useState<AiSettings | null>(view?.settings.ai ?? null)
  const [keyDraft, setKeyDraft] = useState('')
  const [nick, setNick] = useState(view?.settings.playerName ?? '')
  const [budget, setBudget] = useState<BudgetSettings | null>(view?.settings.budget ?? null)
  const [volume, setVolume] = useState(Math.round((view?.settings.voice.volume ?? 0.9) * 100))
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const changeVolume = (v: number) => {
    setVolume(v)
    if (volumeTimer.current) clearTimeout(volumeTimer.current)
    volumeTimer.current = setTimeout(() => void updateSettings({ voice: { volume: v / 100 } }), 300)
  }

  useEffect(() => {
    if (!view) return
    setAi(view.settings.ai)
    setBudget(view.settings.budget)
    setNick(view.settings.playerName)
  }, [view])

  if (!view || !ai || !budget) return null
  const s = view.settings
  const aiDirty = JSON.stringify(ai) !== JSON.stringify(s.ai) || keyDraft.trim() !== ''
  const budgetDirty = JSON.stringify(budget) !== JSON.stringify(s.budget)
  const nickOk = USERNAME_RE.test(nick)

  const saveAi = async () => {
    const ok = await attempt(async () => {
      if (keyDraft.trim()) {
        const next = await api.settings.setApiKey(keyDraft.trim())
        useApp.setState({ view: next })
      }
      await updateSettings({ ai })
      return true
    })
    if (ok !== undefined) {
      setKeyDraft('')
      toast('Настройки ИИ сохранены. Персонажи в мире подхватят их при следующем вызове.', 'success')
    }
  }

  return (
    <div className="page page-scroll page-narrow">
      <header className="page-head">
        <div>
          <h1>Настройки</h1>
        </div>
      </header>

      <Section title="Ты в игре" description="Ник, под которым ты заходишь в Minecraft. Персонажи слушаются и узнают тебя по нему.">
        <div className="row">
          <TextInput mono value={nick} maxLength={16} onChange={(e) => setNick(e.target.value.replace(/\s/g, '_'))} />
          <Button variant="primary" disabled={!nickOk || nick === s.playerName} onClick={() => attempt(() => updateSettings({ playerName: nick }), 'Ник сохранён')}>
            Сохранить
          </Button>
        </div>
        {!nickOk && nick && <p className="field-error">Латиница, цифры и «_», от 3 до 16 символов</p>}
      </Section>

      <Section title="Мозг персонажей" description="Какой ИИ думает за персонажей. Один ключ — на всех.">
        <AiForm value={ai} onChange={setAi} keyDraft={keyDraft} onKeyDraft={setKeyDraft} hasKey={view.hasApiKey} />
        {!view.keyEncrypted && view.hasApiKey && (
          <p className="callout callout-warn">В этой системе нет защищённого хранилища, поэтому ключ хранится без шифрования — только в папке данных приложения.</p>
        )}
        <div className="inline-save">
          {view.hasApiKey && (
            <Button variant="ghost" size="sm" onClick={() => attempt(async () => useApp.setState({ view: await api.settings.setApiKey(null) }), 'Ключ удалён')}>
              Удалить ключ
            </Button>
          )}
          <Button variant="primary" icon="check" disabled={!aiDirty} onClick={saveAi}>
            Сохранить
          </Button>
        </div>
      </Section>

      <Section title="Лимиты расхода" description="Защита от неожиданного счёта: персонаж засыпает, когда упирается в лимит. Считается на каждый выход персонажа в мир.">
        <Field label="Запросов к ИИ за сессию">
          <Slider value={budget.maxRequestsPerSession} min={50} max={5000} step={50} onChange={(v) => setBudget({ ...budget, maxRequestsPerSession: v })} format={(v) => String(v)} />
        </Field>
        <Field label="Токенов за сессию" hint="Грубо: 1 запрос ≈ 2–4 тыс. токенов, с картинкой — в несколько раз больше">
          <Slider value={budget.maxTokensPerSession} min={100_000} max={20_000_000} step={100_000} onChange={(v) => setBudget({ ...budget, maxTokensPerSession: v })} format={(v) => `${(v / 1_000_000).toFixed(1)} млн`} />
        </Field>
        <Field label="Запросов в минуту">
          <Slider value={budget.maxRequestsPerMinute} min={2} max={60} onChange={(v) => setBudget({ ...budget, maxRequestsPerMinute: v })} format={(v) => String(v)} />
        </Field>
        {budgetDirty && (
          <div className="inline-save">
            <Button variant="ghost" size="sm" onClick={() => setBudget(s.budget)}>
              Отменить
            </Button>
            <Button variant="primary" size="sm" icon="check" onClick={() => attempt(() => updateSettings({ budget }), 'Лимиты сохранены')}>
              Сохранить
            </Button>
          </div>
        )}
      </Section>

      <Section title="Звук">
        <Toggle checked={s.voice.enabled} onChange={(enabled) => attempt(() => updateSettings({ voice: { enabled } }))} label="Озвучивать персонажей" hint="Голоса синтезируются через сервис Microsoft Edge — нужен интернет" />
        <Field label="Громкость">
          <Slider value={volume} min={0} max={100} onChange={changeVolume} format={(v) => `${v}%`} />
        </Field>
      </Section>

      <Section title="Данные">
        <Field label="Папка приложения" hint="Сервер, миры, персонажи и журналы">
          <div className="row">
            <CopyText text={info?.dataDir ?? ''} />
            <Button icon="folder" onClick={() => api.app.openFolder('data')}>
              Открыть
            </Button>
          </div>
        </Field>
        <p className="muted">
          Maincraft {info?.version} · {info?.platform}
          {info && !info.agentFound && <span className="is-error"> · файлы бота не найдены, переустанови приложение</span>}
        </p>
        <div>
          <Button variant="ghost" size="sm" onClick={() => attempt(() => updateSettings({ onboarded: false }))}>
            Пройти знакомство заново
          </Button>
        </div>
      </Section>
    </div>
  )
}
