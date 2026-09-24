import { useEffect, useState } from 'react'
import type { LogLine, ServerSettings } from '@shared/types'
import { Badge, Button, Field, Modal, Section, Segmented, Slider, StatusDot, TextInput, Toggle, XpBar } from '../components/ui'
import { LogView } from '../components/LogView'
import { api, attempt, SERVER_STATE_LABEL, useApp } from '../lib/store'
import { formatBytes } from '../lib/format'

function useServerLogs(): LogLine[] {
  const [lines, setLines] = useState<LogLine[]>([])
  useEffect(() => {
    let alive = true
    void api.server.logs().then((l) => alive && setLines(l))
    const off = api.on('server-log', (line) => setLines((prev) => [...prev.slice(-1999), line]))
    return () => {
      alive = false
      off()
    }
  }, [])
  return lines
}

const QUICK: Array<{ label: string; command: string }> = [
  { label: 'Сделать день', command: 'time set day' },
  { label: 'Ясная погода', command: 'weather clear' },
  { label: 'Сохранить мир', command: 'save-all' },
  { label: 'Кто в игре', command: 'list' }
]

function InstallPanel() {
  const runtime = useApp((s) => s.runtime)
  const install = useApp((s) => s.install)
  const [busy, setBusy] = useState(false)
  const stages: Array<{ key: 'java' | 'paper'; title: string; ready: boolean; detail: string | null }> = [
    { key: 'java', title: 'Java 21', ready: Boolean(runtime?.javaReady), detail: runtime?.javaVersion ?? null },
    { key: 'paper', title: 'Сервер Paper', ready: Boolean(runtime?.paperReady), detail: runtime?.paperBuild ? `${runtime.paperVersion} · сборка ${runtime.paperBuild}` : null }
  ]
  return (
    <div className="install">
      {stages.map((st) => {
        const p = install[st.key]
        const active = runtime?.installing && p && p.phase !== 'done' && p.phase !== 'error'
        return (
          <div key={st.key} className="install-row">
            <StatusDot tone={st.ready ? 'on' : p?.phase === 'error' ? 'error' : active ? 'busy' : 'off'} pulse={Boolean(active)} />
            <div className="install-text">
              <strong>{st.title}</strong>
              <span className={p?.phase === 'error' ? 'is-error' : ''}>
                {active || p?.phase === 'error' ? p?.message : st.ready ? st.detail : 'не установлено'}
                {active && p?.phase === 'download' && p.total > 0 && ` — ${formatBytes(p.received)} из ${formatBytes(p.total)}`}
              </span>
              {active && <XpBar value={p?.received ?? 0} max={p?.total ?? 0} indeterminate={p?.phase !== 'download'} />}
            </div>
          </div>
        )
      })}
      {!(runtime?.javaReady && runtime?.paperReady) && (
        <Button
          variant="primary"
          icon="download"
          busy={busy || runtime?.installing}
          onClick={async () => {
            setBusy(true)
            await attempt(() => api.runtime.install(), 'Всё установлено')
            setBusy(false)
          }}
        >
          Установить
        </Button>
      )}
    </div>
  )
}

export function WorldPage() {
  const server = useApp((s) => s.server)
  const view = useApp((s) => s.view)
  const runtime = useApp((s) => s.runtime)
  const info = useApp((s) => s.info)
  const updateSettings = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)
  const lines = useServerLogs()
  const [command, setCommand] = useState('')
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState<ServerSettings | null>(view?.settings.server ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => setDraft(view?.settings.server ?? null), [view])
  if (!server || !draft || !view) return null

  const state = server.state
  const running = state === 'running'
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.settings.server)
  const maxRam = Math.max(2048, Math.min(16384, Math.floor(((info?.totalMemMb ?? 8192) * 0.6) / 512) * 512))
  const set = <K extends keyof ServerSettings>(key: K, value: ServerSettings[K]) => setDraft({ ...draft, [key]: value })

  const act = async (name: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(name)
    await attempt(fn, done)
    setBusy(null)
  }

  const send = async (text: string) => {
    const clean = text.trim()
    if (!clean) return
    setCommand('')
    await attempt(() => api.server.send(clean))
  }

  return (
    <div className="page page-scroll">
      <header className="page-head">
        <div>
          <h1>Мир</h1>
          <p className="page-lead">
            <Badge tone={running ? 'emerald' : state === 'crashed' ? 'redstone' : state === 'starting' || state === 'stopping' ? 'torch' : 'neutral'} dot>
              {SERVER_STATE_LABEL[state]}
            </Badge>
            <span>Paper {runtime?.paperVersion ?? view.settings.server.version} · порт {server.port}</span>
            {server.message && <span className="is-error">{server.message}</span>}
          </p>
        </div>
        <div className="page-actions">
          {running || state === 'starting' || state === 'stopping' ? (
            <>
              <Button icon="restart" busy={busy === 'restart'} disabled={state !== 'running'} onClick={() => act('restart', () => api.server.restart())}>
                Перезапустить
              </Button>
              <Button icon="stop" busy={busy === 'stop' || state === 'stopping'} onClick={() => act('stop', () => api.server.stop())}>
                Остановить
              </Button>
            </>
          ) : (
            <Button variant="primary" icon="play" busy={busy === 'start'} disabled={state === 'not-installed'} onClick={() => act('start', () => api.server.start())}>
              Запустить мир
            </Button>
          )}
        </div>
      </header>

      <div className="world-grid">
        <section className="panel console">
          <header className="panel-head">
            <h3>Консоль сервера</h3>
            <input className="input input-sm" placeholder="Фильтр…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </header>
          <LogView lines={lines} filter={filter} empty="Здесь будет журнал сервера. Запусти мир." />
          <div className="quick">
            {QUICK.map((q) => (
              <button type="button" key={q.command} disabled={!running} onClick={() => send(q.command)}>
                {q.label}
              </button>
            ))}
            {view.settings.playerName && (
              <button type="button" disabled={!running} onClick={() => send(`op ${view.settings.playerName}`)} title="Даёт права администратора: креатив, /tp, /give">
                Права админа для {view.settings.playerName}
              </button>
            )}
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault()
              void send(command)
            }}
          >
            <span className="composer-prompt mono">/</span>
            <input className="input mono" value={command} disabled={!running} onChange={(e) => setCommand(e.target.value)} placeholder={running ? 'команда серверу, например: time set night' : 'мир не запущен'} />
            <Button type="submit" icon="send" disabled={!running || !command.trim()} aria-label="Отправить" />
          </form>
        </section>

        <div className="world-side">
          <Section title="Установка">
            <InstallPanel />
          </Section>

          <Section title="Правила мира" description={running ? 'Применятся при следующем запуске' : undefined}>
            <Field label="Сложность">
              <Segmented
                size="sm"
                value={draft.difficulty}
                onChange={(v) => set('difficulty', v)}
                options={[
                  { value: 'peaceful', label: 'Мирная' },
                  { value: 'easy', label: 'Лёгкая' },
                  { value: 'normal', label: 'Обычная' },
                  { value: 'hard', label: 'Сложная' }
                ]}
              />
            </Field>
            <Field label="Режим игры">
              <Segmented
                size="sm"
                value={draft.gamemode}
                onChange={(v) => set('gamemode', v)}
                options={[
                  { value: 'survival', label: 'Выживание' },
                  { value: 'creative', label: 'Творческий' },
                  { value: 'adventure', label: 'Приключение' }
                ]}
              />
            </Field>
            <Field label="Память для сервера" hint={`Всего в компьютере ${Math.round((info?.totalMemMb ?? 0) / 1024)} ГБ`}>
              <Slider value={draft.ramMb} min={1024} max={maxRam} step={512} onChange={(v) => set('ramMb', v)} format={(v) => `${(v / 1024).toFixed(1)} ГБ`} />
            </Field>
            <Field label="Дальность прорисовки">
              <Slider value={draft.viewDistance} min={4} max={16} onChange={(v) => set('viewDistance', v)} format={(v) => `${v} чанков`} />
            </Field>
            <Toggle checked={draft.pvp} onChange={(v) => set('pvp', v)} label="Игроки могут драться друг с другом" />
            <div className="grid-2">
              <Field label="Сид мира" hint={runtime?.worldExists ? 'Мир уже создан — сид сработает для нового мира' : 'Пусто — случайный мир'}>
                <TextInput mono value={draft.seed} maxLength={64} onChange={(e) => set('seed', e.target.value)} />
              </Field>
              <Field label="Порт">
                <TextInput mono inputMode="numeric" value={String(draft.port)} onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '')) || 0)} />
              </Field>
            </div>
            <Field label="Описание в списке серверов">
              <TextInput value={draft.motd} maxLength={59} onChange={(e) => set('motd', e.target.value)} />
            </Field>
            {dirty && (
              <div className="inline-save">
                <Button variant="ghost" size="sm" onClick={() => setDraft(view.settings.server)}>
                  Отменить
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon="check"
                  onClick={async () => {
                    await attempt(() => updateSettings({ server: draft }))
                    toast(running ? 'Сохранено. Перезапусти мир, чтобы применить.' : 'Сохранено', 'success')
                  }}
                >
                  Сохранить
                </Button>
              </div>
            )}
          </Section>

          <Section title="Файлы мира">
            <div className="button-stack">
              <Button icon="folder" onClick={() => api.app.openFolder('server')}>
                Открыть папку сервера
              </Button>
              <Button icon="archive" busy={busy === 'backup'} disabled={!runtime?.worldExists} onClick={() => act('backup', () => api.server.backup(), 'Резервная копия готова')}>
                Сделать резервную копию
              </Button>
              <Button icon="folder" variant="ghost" onClick={() => api.app.openFolder('backups')}>
                Папка с копиями
              </Button>
              <Button variant="danger" icon="restart" disabled={state !== 'stopped' || !runtime?.worldExists} onClick={() => setConfirmReset(true)}>
                Начать новый мир
              </Button>
            </div>
          </Section>
        </div>
      </div>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Начать новый мир?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Отмена
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setConfirmReset(false)
                await attempt(() => api.server.resetWorld(), 'Старый мир сохранён в копиях. При запуске создастся новый.')
                useApp.setState({ runtime: await api.runtime.state() })
              }}
            >
              Сохранить копию и начать заново
            </Button>
          </>
        }
      >
        <p>Текущий мир сначала будет скопирован в «Папку с копиями», потом удалён. При следующем запуске сервер создаст новый.</p>
      </Modal>
    </div>
  )
}
