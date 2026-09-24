import { useEffect, useMemo, useRef, useState } from 'react'
import type { Character, FeedItem } from '@shared/types'
import { ROLE_INFO } from '@shared/persona'
import { Button, Segmented, StatusDot, XpBar, Empty } from '../components/ui'
import { Icon } from '../components/Icon'
import { Hearts, Hunger, PixelFace, PixelScene, type SceneMood } from '../components/Pixel'
import { api, attempt, BOT_STATE_LABEL, isBotActive, useApp } from '../lib/store'

function timeMood(timeOfDay: number): SceneMood {
  if (timeOfDay >= 12000 && timeOfDay < 13500) return 'dusk'
  if (timeOfDay >= 13500 && timeOfDay < 22500) return 'night-lit'
  if (timeOfDay >= 22500 || timeOfDay < 500) return 'dawn'
  return 'day'
}

function WorldHero() {
  const server = useApp((s) => s.server)
  const runtime = useApp((s) => s.runtime)
  const install = useApp((s) => s.install)
  const bots = useApp((s) => s.bots)
  const view = useApp((s) => s.view)
  const characters = useApp((s) => s.characters)
  const go = useApp((s) => s.go)
  const [busy, setBusy] = useState(false)
  const byUsername = new Map(characters.map((c) => [c.username.toLowerCase(), c]))

  const live = Object.values(bots).find((b) => b.state === 'online' && b.live)?.live
  const state = server?.state ?? 'stopped'
  const mood: SceneMood =
    state === 'running' ? (live ? timeMood(live.timeOfDay) : 'day') : state === 'starting' ? 'dawn' : state === 'stopping' ? 'dusk' : 'night'
  const version = view?.settings.server.version ?? ''
  const port = view?.settings.server.port ?? 25565
  const address = port === 25565 ? '127.0.0.1' : `127.0.0.1:${port}`

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    await attempt(fn)
    setBusy(false)
  }

  const progress = install.paper?.phase === 'download' ? install.paper : install.java?.phase === 'download' ? install.java : null
  let title = 'Мир спит'
  let text = 'Запусти мир — и персонажи смогут войти в игру.'
  let actions = (
    <Button variant="primary" size="lg" icon="play" busy={busy} onClick={() => run(() => api.server.start())}>
      Запустить мир
    </Button>
  )
  if (state === 'not-installed') {
    title = 'Мир ещё не построен'
    text = runtime?.installing
      ? install.paper?.message ?? install.java?.message ?? 'Готовлю файлы…'
      : 'Скачаю Java и сервер Minecraft — это займёт пару минут и около 150 МБ.'
    actions = (
      <Button variant="primary" size="lg" icon="download" busy={busy || runtime?.installing} onClick={() => run(() => api.runtime.install())}>
        Установить
      </Button>
    )
  } else if (state === 'starting') {
    title = 'Мир просыпается'
    text = 'Сервер генерирует окрестности. Обычно это меньше минуты.'
    actions = <></>
  } else if (state === 'running') {
    title = 'Мир живёт'
    text = `Заходи: Minecraft Java ${version} → «Сетевая игра» → «Прямое подключение» → ${address}`
    actions = (
      <>
        <Button variant="secondary" icon="stop" busy={busy} onClick={() => run(() => api.server.stop())}>
          Остановить
        </Button>
        <Button variant="ghost" icon="world" onClick={() => go({ page: 'world' })}>
          Консоль мира
        </Button>
      </>
    )
  } else if (state === 'stopping') {
    title = 'Мир сохраняется'
    text = 'Записываю всё на диск, не закрывай приложение.'
    actions = <></>
  } else if (state === 'crashed') {
    title = 'Мир упал'
    text = server?.message ?? 'Сервер неожиданно остановился.'
    actions = (
      <>
        <Button variant="primary" icon="restart" busy={busy} onClick={() => run(() => api.server.start())}>
          Запустить снова
        </Button>
        <Button variant="ghost" icon="journal" onClick={() => go({ page: 'journal', source: 'server' })}>
          Что случилось?
        </Button>
      </>
    )
  }

  return (
    <section className={`hero mood-${mood}`}>
      <PixelScene mood={mood} width={330} height={66} />
      <div className="hero-shade" />
      <div className="hero-content">
        <span className="eyebrow">Minecraft Java {version}</span>
        <h1>{title}</h1>
        <p>{text}</p>
        {(state === 'starting' || (state === 'not-installed' && runtime?.installing)) && (
          <div className="hero-progress">
            <XpBar value={progress?.received ?? 0} max={progress?.total ?? 0} indeterminate={!progress} />
          </div>
        )}
        <div className="hero-actions">{actions}</div>
      </div>
      {state === 'running' && (
        <div className="hero-players">
          <span className="eyebrow">В игре</span>
          {server!.players.length === 0 ? (
            <span className="muted">пока никого</span>
          ) : (
            <ul>
              {server!.players.map((p) => {
                const c = byUsername.get(p.toLowerCase())
                return (
                  <li key={p}>
                    {c ? <PixelFace appearance={c.appearance} seed={c.id} size={16} /> : <StatusDot tone="on" />}
                    <span>{c ? c.name : p}</span>
                    {c ? <span className="hero-tag">ИИ</span> : <span className="hero-tag hero-tag-human">игрок</span>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function RosterCard({ character }: { character: Character }) {
  const status = useApp((s) => s.bots[character.id])
  const speaking = useApp((s) => s.speaking === character.id)
  const go = useApp((s) => s.go)
  const [busy, setBusy] = useState(false)
  const active = isBotActive(status)
  const live = status?.state === 'online' ? status.live : null
  const tone = status?.state === 'online' ? 'on' : status?.state === 'error' ? 'error' : active ? 'busy' : 'off'

  let line = BOT_STATE_LABEL[status?.state ?? 'offline']
  if (status?.state === 'online' && live) {
    const doing = live.activeCommand?.text ? 'выполняет просьбу' : live.goal
    line = doing ? `В мире · ${doing}` : 'В мире'
  } else if (status?.message) line = status.message

  const toggle = async () => {
    setBusy(true)
    await attempt(() => (active ? api.bots.stop(character.id) : api.bots.start(character.id)))
    setBusy(false)
  }

  return (
    <article className={`rcard ${active ? 'is-active' : ''} ${speaking ? 'is-speaking' : ''}`}>
      <button type="button" className="rcard-face" onClick={() => go({ page: 'characters', id: character.id })} title="Открыть персонажа">
        <PixelFace appearance={character.appearance} seed={character.id} size={56} />
      </button>
      <div className="rcard-main">
        <div className="rcard-title">
          <h4>{character.name}</h4>
          <span className="rcard-role">{ROLE_INFO[character.role].title}</span>
        </div>
        <p className={`rcard-status ${status?.state === 'error' ? 'is-error' : ''}`} title={line}>
          <StatusDot tone={tone} pulse={tone === 'busy'} />
          <span>{line}</span>
        </p>
        {live && (
          <div className="rcard-vitals">
            <Hearts value={live.health} />
            <Hunger value={live.food} />
          </div>
        )}
      </div>
      <Button variant={active ? 'secondary' : 'primary'} size="sm" busy={busy} onClick={toggle}>
        {active ? 'Отпустить' : 'Позвать'}
      </Button>
    </article>
  )
}

function FeedLine({ item, characters }: { item: FeedItem; characters: Map<string, Character> }) {
  const character = item.characterId ? characters.get(item.characterId) : undefined
  const time = new Date(item.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (item.kind === 'say' || item.kind === 'chat') {
    return (
      <div className={`fline fline-${item.kind}`}>
        {character ? (
          <PixelFace appearance={character.appearance} seed={character.id} size={24} />
        ) : (
          <span className="fline-player">
            <Icon name="user" size={10} />
          </span>
        )}
        <div className="fline-body">
          <div className="fline-meta">
            <strong>{item.author}</strong>
            <time>{time}</time>
          </div>
          <p className="selectable">{item.text}</p>
        </div>
      </div>
    )
  }
  if (item.kind === 'think') {
    return (
      <div className="fline fline-think">
        <Icon name="idea" size={10} />
        <div className="fline-body">
          <p className="selectable">
            <strong>{item.author}</strong> думает: {item.text}
          </p>
          {item.detail && <code className={item.ok === false ? 'is-bad' : ''}>{item.detail}</code>}
        </div>
      </div>
    )
  }
  const icon = item.kind === 'death' ? 'sword' : item.kind === 'error' ? 'warning' : item.kind === 'command' ? 'commands' : item.kind === 'join' ? 'plus' : item.kind === 'leave' ? 'close' : 'info'
  return (
    <div className={`fline fline-meta-line fline-${item.kind}`}>
      <Icon name={icon} size={10} />
      <span className="selectable">
        {item.kind === 'command' && <strong>{item.author} </strong>}
        {item.text}
        {item.detail && <span className="muted"> — {item.detail}</span>}
      </span>
      <time>{time}</time>
    </div>
  )
}

function Feed() {
  const feed = useApp((s) => s.feed)
  const characters = useApp((s) => s.characters)
  const bots = useApp((s) => s.bots)
  const [filter, setFilter] = useState<'all' | 'talk'>('all')
  const [target, setTarget] = useState<string | null>(null)
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters])
  const online = characters.filter((c) => bots[c.id]?.state === 'online')
  const selected = online.find((c) => c.id === target) ?? online[0]
  const items = filter === 'talk' ? feed.filter((i) => i.kind === 'say' || i.kind === 'chat') : feed

  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items.length])

  const sendMessage = async () => {
    const body = text.trim()
    if (!body || !selected) return
    setText('')
    await attempt(() => (body.startsWith('!') ? api.bots.command(selected.id, body) : api.bots.say(selected.id, body)))
  }

  return (
    <section className="panel feed">
      <header className="panel-head">
        <h3>Что происходит</h3>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Всё' },
            { value: 'talk', label: 'Разговоры' }
          ]}
        />
      </header>
      <div
        className="feed-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {items.length === 0 ? (
          <div className="feed-empty">
            Здесь появятся разговоры, мысли персонажей и события мира.
          </div>
        ) : (
          items.map((item) => <FeedLine key={item.id} item={item} characters={byId} />)
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void sendMessage()
        }}
      >
        {online.length > 1 && (
          <div className="composer-targets">
            {online.map((c) => (
              <button type="button" key={c.id} className={c.id === selected?.id ? 'is-on' : ''} onClick={() => setTarget(c.id)} title={c.name}>
                <PixelFace appearance={c.appearance} seed={c.id} size={16} />
              </button>
            ))}
          </div>
        )}
        <input
          className="input"
          value={text}
          disabled={!selected}
          onChange={(e) => setText(e.target.value)}
          placeholder={selected ? `Сказать ${selected.name}… (команды через «!»)` : 'Позови персонажа, чтобы поговорить'}
        />
        <Button type="submit" variant="primary" icon="send" disabled={!selected || !text.trim()} aria-label="Отправить" />
      </form>
    </section>
  )
}

export function HomePage() {
  const characters = useApp((s) => s.characters)
  const bots = useApp((s) => s.bots)
  const go = useApp((s) => s.go)
  const onlineCount = characters.filter((c) => isBotActive(bots[c.id])).length

  return (
    <div className="page page-home">
      <WorldHero />
      <div className="home-grid">
        <section className="panel roster">
          <header className="panel-head">
            <h3>
              Персонажи
              {characters.length > 0 && (
                <span className="panel-sub">
                  {onlineCount} из {characters.length} в мире
                </span>
              )}
            </h3>
            <Button variant="ghost" size="sm" icon="plus" onClick={() => go({ page: 'characters' })}>
              Новый
            </Button>
          </header>
          {characters.length === 0 ? (
            <Empty icon="characters" title="Пока никого нет" action={<Button variant="primary" onClick={() => go({ page: 'characters' })}>Создать персонажа</Button>}>
              Создай первого персонажа: дай ему имя, характер и вкусы.
            </Empty>
          ) : (
            <div className="roster-list">
              {characters.map((c) => (
                <RosterCard key={c.id} character={c} />
              ))}
            </div>
          )}
        </section>
        <Feed />
      </div>
    </div>
  )
}
