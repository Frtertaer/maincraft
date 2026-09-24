import { useEffect, useRef, useState } from 'react'
import type { AiSettings } from '@shared/types'
import { CHARACTER_TEMPLATES, characterFromTemplate } from '@shared/defaults'
import { USERNAME_RE } from '@shared/catalog'
import { ROLE_INFO } from '@shared/persona'
import { AiForm } from '../components/AiForm'
import { Button, CopyText, StatusDot, TextInput, XpBar } from '../components/ui'
import { Icon } from '../components/Icon'
import { PixelFace, PixelScene, type SceneMood } from '../components/Pixel'
import { api, attempt, useApp } from '../lib/store'
import { formatBytes } from '../lib/format'

const STEPS = ['Привет', 'Ник', 'ИИ', 'Мир', 'Персонажи', 'Готово']
const MOODS: SceneMood[] = ['night', 'night', 'dawn', 'dawn', 'day', 'dusk']

export function Onboarding() {
  const view = useApp((s) => s.view)!
  const runtime = useApp((s) => s.runtime)
  const install = useApp((s) => s.install)
  const characters = useApp((s) => s.characters)
  const updateSettings = useApp((s) => s.updateSettings)
  const reloadCharacters = useApp((s) => s.reloadCharacters)
  const [step, setStep] = useState(0)
  const [nick, setNick] = useState(view.settings.playerName)
  const [ai, setAi] = useState<AiSettings>(view.settings.ai)
  const [keyDraft, setKeyDraft] = useState('')
  const [eula, setEula] = useState(view.settings.server.eulaAccepted)
  const [picked, setPicked] = useState<string[]>(() => {
    const existing = CHARACTER_TEMPLATES.filter((t) => characters.some((c) => c.username === t.seed.username)).map((t) => t.key)
    return existing.length ? existing : ['companion']
  })
  const [busy, setBusy] = useState(false)

  const installed = Boolean(runtime?.javaReady && runtime?.paperReady)
  const nickOk = USERNAME_RE.test(nick)

  // Start the download once when the user agrees; retries after a failure are manual.
  const autoInstalled = useRef(false)
  useEffect(() => {
    if (step !== 3 || !eula || installed || runtime?.installing || autoInstalled.current) return
    autoInstalled.current = true
    void attempt(() => api.runtime.install())
  }, [step, eula, installed, runtime?.installing])

  const next = async () => {
    setBusy(true)
    try {
      if (step === 1) await updateSettings({ playerName: nick })
      if (step === 2) {
        if (keyDraft.trim()) useApp.setState({ view: await api.settings.setApiKey(keyDraft.trim()) })
        await updateSettings({ ai })
      }
      if (step === 3) await updateSettings({ server: { eulaAccepted: eula } })
      if (step === 4) {
        for (const key of picked) {
          const template = CHARACTER_TEMPLATES.find((t) => t.key === key)
          if (!template || characters.some((c) => c.username === template.seed.username)) continue
          await api.characters.save(characterFromTemplate(key))
        }
        await reloadCharacters()
      }
      setStep((s) => Math.min(STEPS.length - 1, s + 1))
    } catch (err) {
      useApp.getState().toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const finish = async (launch: boolean) => {
    setBusy(true)
    await attempt(() => updateSettings({ onboarded: true }))
    if (launch) {
      const first = useApp.getState().characters[0]
      void attempt(async () => {
        await api.server.start()
        if (first) await api.bots.start(first.id)
      })
    }
    setBusy(false)
  }

  const canNext =
    (step === 1 && nickOk) ||
    (step === 2 && (ai.provider === 'local' || view.hasApiKey || keyDraft.trim().length > 8)) ||
    (step === 3 && eula && installed) ||
    (step === 4 && picked.length > 0) ||
    step === 0

  const progress = install.paper?.phase === 'download' ? install.paper : install.java
  const hasKey = view.hasApiKey

  return (
    <div className="onboarding">
      <PixelScene mood={MOODS[step]} seed={11} height={150} />
      <div className="onboarding-shade" />
      <div className="onboarding-card">
        <ol className="stepper">
          {STEPS.map((label, i) => (
            <li key={label} className={i === step ? 'is-now' : i < step ? 'is-done' : ''}>
              <span className="stepper-dot">{i < step ? <Icon name="check" size={10} /> : String(i + 1).padStart(2, '0')}</span>
              <span className="stepper-label">{label}</span>
            </li>
          ))}
        </ol>

        <div className="onboarding-body">
          {step === 0 && (
            <>
              <h1 className="onb-title">Твой мир Minecraft, в котором живут ИИ-персонажи</h1>
              <p className="onb-lead">
                Maincraft ставит на этот компьютер сервер Minecraft и поселяет в нём персонажей со своим характером. С ними можно
                разговаривать, давать им поручения — или смотреть, как один из них пытается пройти игру до финальных титров.
              </p>
              <ul className="onb-points">
                <li>
                  <Icon name="world" size={20} />
                  <span>
                    <strong>Сервер ставится сам.</strong> Java и Paper скачаются автоматически, ничего настраивать не нужно.
                  </span>
                </li>
                <li>
                  <Icon name="characters" size={20} />
                  <span>
                    <strong>Персонажи с характером.</strong> Имя, внешность, вкусы, страхи, голос — всё задаётся в редакторе.
                  </span>
                </li>
                <li>
                  <Icon name="commands" size={20} />
                  <span>
                    <strong>Свои команды.</strong> «!дрова», «Бублик, охраняй» — придумывай и собирай из готовых действий.
                  </span>
                </li>
              </ul>
            </>
          )}

          {step === 1 && (
            <>
              <h1 className="onb-title">Как тебя зовут в Minecraft?</h1>
              <p className="onb-lead">По этому нику персонажи тебя узнают и будут слушаться. Используй тот же ник, под которым заходишь в игру.</p>
              <TextInput mono autoFocus className="onb-nick" value={nick} maxLength={16} placeholder="Steve" onChange={(e) => setNick(e.target.value.replace(/\s/g, '_'))} onKeyDown={(e) => e.key === 'Enter' && nickOk && void next()} />
              {nick && !nickOk && <p className="field-error">Латиница, цифры и «_», от 3 до 16 символов</p>}
            </>
          )}

          {step === 2 && (
            <>
              <h1 className="onb-title">Кто будет думать за персонажей?</h1>
              <p className="onb-lead">Персонажам нужен языковой ИИ. Лучше всего — Claude от Anthropic по своему ключу. Проверь связь, прежде чем идти дальше.</p>
              <AiForm value={ai} onChange={setAi} keyDraft={keyDraft} onKeyDraft={setKeyDraft} hasKey={hasKey} />
            </>
          )}

          {step === 3 && (
            <>
              <h1 className="onb-title">Строим мир</h1>
              <p className="onb-lead">Скачаю Java 21 и сервер Paper для Minecraft {view.settings.server.version} — около 100 МБ. Сервер будет доступен только на этом компьютере.</p>
              <label className="eula">
                <input type="checkbox" checked={eula} onChange={(e) => setEula(e.target.checked)} />
                <span>
                  Я принимаю{' '}
                  <a
                    href="https://aka.ms/MinecraftEULA"
                    onClick={(e) => {
                      e.preventDefault()
                      void api.app.openExternal('https://aka.ms/MinecraftEULA')
                    }}
                  >
                    лицензионное соглашение Minecraft (EULA)
                  </a>
                  . Без этого сервер Minecraft запускать нельзя.
                </span>
              </label>
              {eula && (
                <div className="onb-install">
                  {(['java', 'paper'] as const).map((stage) => {
                    const p = install[stage]
                    const ready = stage === 'java' ? runtime?.javaReady : runtime?.paperReady
                    return (
                      <div className="install-row" key={stage}>
                        <StatusDot tone={ready ? 'on' : p?.phase === 'error' ? 'error' : p ? 'busy' : 'off'} pulse={Boolean(p && !ready && p.phase !== 'error')} />
                        <div className="install-text">
                          <strong>{stage === 'java' ? 'Java 21' : 'Сервер Paper'}</strong>
                          <span className={p?.phase === 'error' ? 'is-error' : ''}>
                            {ready ? 'готово' : p?.message ?? 'в очереди'}
                            {p?.phase === 'download' && p.total > 0 && !ready && ` — ${formatBytes(p.received)} из ${formatBytes(p.total)}`}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                  {!installed && <XpBar value={progress?.received ?? 0} max={progress?.total ?? 0} indeterminate={!progress || progress.phase !== 'download'} />}
                  {(install.java?.phase === 'error' || install.paper?.phase === 'error') && !runtime?.installing && (
                    <Button icon="restart" onClick={() => attempt(() => api.runtime.install())}>
                      Попробовать снова
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <h1 className="onb-title">Кто будет жить в мире?</h1>
              <p className="onb-lead">Выбери одного или нескольких. Потом их можно переделать до неузнаваемости — или создать своих.</p>
              <div className="template-grid">
                {CHARACTER_TEMPLATES.map((t) => {
                  const on = picked.includes(t.key)
                  return (
                    <button type="button" key={t.key} className={`template ${on ? 'is-on' : ''}`} onClick={() => setPicked(on ? picked.filter((k) => k !== t.key) : [...picked, t.key])}>
                      {on && (
                        <span className="template-check">
                          <Icon name="check" size={10} />
                        </span>
                      )}
                      <PixelFace appearance={t.seed.appearance} seed={t.key} size={64} />
                      <strong>{t.title}</strong>
                      <span className="template-role">{ROLE_INFO[t.seed.role].title}</span>
                      <span className="template-tag">{t.tagline}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <h1 className="onb-title">Готово. Как зайти в мир</h1>
              <ol className="onb-howto">
                <li>
                  Запусти <strong>Minecraft Java Edition {view.settings.server.version}</strong> под ником <span className="mono">{view.settings.playerName}</span>.
                </li>
                <li>
                  «Сетевая игра» → «Прямое подключение» → адрес <CopyText text={view.settings.server.port === 25565 ? '127.0.0.1' : `127.0.0.1:${view.settings.server.port}`} />
                </li>
                <li>Пиши в чат — персонажи ответят. Команды начинаются с «!», например <span className="mono">!ко мне</span>.</li>
              </ol>
            </>
          )}
        </div>

        <footer className="onboarding-foot">
          {step > 0 && step < 5 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              Назад
            </Button>
          )}
          <span className="grow" />
          {step < 5 ? (
            <Button variant="primary" size="lg" busy={busy} disabled={!canNext} onClick={next}>
              {step === 0 ? 'Начать' : 'Дальше'}
            </Button>
          ) : (
            <>
              <Button variant="ghost" busy={busy} onClick={() => finish(false)}>
                Осмотреться
              </Button>
              <Button variant="primary" size="lg" icon="play" busy={busy} onClick={() => finish(true)}>
                Запустить мир
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
