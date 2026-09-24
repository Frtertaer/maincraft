import { useEffect } from 'react'
import { Icon, type IconName } from './components/Icon'
import { CopyText, StatusDot } from './components/ui'
import { SERVER_STATE_LABEL, useApp, isBotActive, type Route } from './lib/store'
import { plural } from './lib/format'
import { HomePage } from './pages/Home'
import { CharactersPage } from './pages/Characters'
import { CommandsPage } from './pages/Commands'
import { WorldPage } from './pages/World'
import { JournalPage } from './pages/Journal'
import { SettingsPage } from './pages/Settings'
import { Onboarding } from './pages/Onboarding'

const NAV: Array<{ page: Route['page']; label: string; icon: IconName }> = [
  { page: 'home', label: 'Главная', icon: 'home' },
  { page: 'characters', label: 'Персонажи', icon: 'characters' },
  { page: 'commands', label: 'Команды', icon: 'commands' },
  { page: 'world', label: 'Мир', icon: 'world' },
  { page: 'journal', label: 'Журнал', icon: 'journal' },
  { page: 'settings', label: 'Настройки', icon: 'settings' }
]

function Logo() {
  return (
    <div className="logo">
      <svg className="pixelated" width={20} height={20} viewBox="0 0 10 10" aria-hidden>
        <rect x={0} y={0} width={10} height={10} fill="#f2a53a" />
        <rect x={0} y={0} width={10} height={3} fill="#ffc46e" />
        <rect x={1} y={4} width={3} height={2} fill="#1f1407" />
        <rect x={6} y={4} width={3} height={2} fill="#1f1407" />
        <rect x={2} y={4} width={1} height={1} fill="#fff4dc" />
        <rect x={7} y={4} width={1} height={1} fill="#fff4dc" />
        <rect x={3} y={7} width={4} height={1} fill="#a8641a" />
      </svg>
      <span className="logo-word">Maincraft</span>
    </div>
  )
}

function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismiss)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} onClick={() => dismiss(t.id)}>
          <Icon name={t.tone === 'error' ? 'warning' : t.tone === 'success' ? 'check' : 'info'} size={20} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

function Sidebar() {
  const route = useApp((s) => s.route)
  const go = useApp((s) => s.go)
  const characters = useApp((s) => s.characters)
  const bots = useApp((s) => s.bots)
  const server = useApp((s) => s.server)
  const view = useApp((s) => s.view)
  const online = characters.filter((c) => isBotActive(bots[c.id])).length
  const botNames = new Set(characters.map((c) => c.username.toLowerCase()))
  const humans = server?.players.filter((p) => !botNames.has(p.toLowerCase())).length ?? 0
  const port = view?.settings.server.port ?? 25565
  const tone = server?.state === 'running' ? 'on' : server?.state === 'starting' || server?.state === 'stopping' ? 'busy' : server?.state === 'crashed' ? 'error' : 'off'

  return (
    <aside className="sidebar">
      <nav className="nav">
        {NAV.map((item) => (
          <button
            key={item.page}
            type="button"
            className={`nav-item ${route.page === item.page ? 'is-active' : ''}`}
            onClick={() => go({ page: item.page } as Route)}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
            {item.page === 'characters' && online > 0 && <span className="nav-count">{online}</span>}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button type="button" className="world-chip" onClick={() => go({ page: 'world' })}>
          <StatusDot tone={tone} pulse={tone === 'busy'} />
          <span className="world-chip-text">
            <strong>Мир · {server ? SERVER_STATE_LABEL[server.state] : '…'}</strong>
            <span>
              {server?.state === 'running'
                ? `${humans} ${plural(humans, 'игрок', 'игрока', 'игроков')} · ${online} ${plural(online, 'персонаж', 'персонажа', 'персонажей')}`
                : 'Minecraft Java ' + (view?.settings.server.version ?? '')}
            </span>
          </span>
        </button>
        <div className="connect-card">
          <span className="eyebrow">Адрес для входа</span>
          <CopyText text={port === 25565 ? '127.0.0.1' : `127.0.0.1:${port}`} />
          {view?.settings.playerName && (
            <span className="connect-nick">
              Твой ник: <span className="mono">{view.settings.playerName}</span>
            </span>
          )}
        </div>
      </div>
    </aside>
  )
}

function Page() {
  const route = useApp((s) => s.route)
  switch (route.page) {
    case 'home':
      return <HomePage />
    case 'characters':
      return <CharactersPage selectedId={route.id} />
    case 'commands':
      return <CommandsPage selectedId={route.id} />
    case 'world':
      return <WorldPage />
    case 'journal':
      return <JournalPage source={route.source} />
    case 'settings':
      return <SettingsPage />
  }
}

export function App() {
  const ready = useApp((s) => s.ready)
  const onboarded = useApp((s) => s.view?.settings.onboarded)
  const init = useApp((s) => s.init)
  const route = useApp((s) => s.route)

  useEffect(() => {
    void init()
  }, [init])

  const mac = navigator.userAgent.includes('Mac')
  return (
    <div className={`shell ${mac ? 'is-mac' : ''}`}>
      <header className="titlebar">
        <Logo />
      </header>
      {!ready ? (
        <div className="boot">
          <span className="spinner" />
        </div>
      ) : !onboarded ? (
        <Onboarding />
      ) : (
        <div className="frame">
          <Sidebar />
          <main className="content" key={route.page}>
            <Page />
          </main>
        </div>
      )}
      <Toasts />
    </div>
  )
}
