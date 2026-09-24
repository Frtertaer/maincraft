import { useEffect, useState } from 'react'
import type { LogLine } from '@shared/types'
import { Button } from '../components/ui'
import { LogView } from '../components/LogView'
import { PixelFace } from '../components/Pixel'
import { Icon } from '../components/Icon'
import { api, useApp } from '../lib/store'

function useLogs(source: string): LogLine[] {
  const [lines, setLines] = useState<LogLine[]>([])
  useEffect(() => {
    let alive = true
    setLines([])
    if (source === 'server') {
      void api.server.logs().then((l) => alive && setLines(l))
      const off = api.on('server-log', (line) => setLines((prev) => [...prev.slice(-1999), line]))
      return () => {
        alive = false
        off()
      }
    }
    void api.bots.logs(source).then((l) => alive && setLines(l))
    const off = api.on('bot-log', ({ characterId, line }) => {
      if (characterId === source) setLines((prev) => [...prev.slice(-1999), line])
    })
    return () => {
      alive = false
      off()
    }
  }, [source])
  return lines
}

export function JournalPage({ source = 'server' }: { source?: string }) {
  const characters = useApp((s) => s.characters)
  const go = useApp((s) => s.go)
  const [filter, setFilter] = useState('')
  const lines = useLogs(source)
  const current = characters.find((c) => c.id === source)

  return (
    <div className="page page-journal">
      <header className="page-head">
        <div>
          <h1>Журнал</h1>
          <p className="page-lead">Технические записи сервера и персонажей — пригодятся, если что-то пошло не так.</p>
        </div>
        <div className="page-actions">
          <Button icon="folder" onClick={() => api.app.openFolder(source === 'server' ? 'server' : 'logs')}>
            Открыть папку
          </Button>
        </div>
      </header>
      <div className="tabs">
        <button type="button" className={source === 'server' ? 'is-on' : ''} onClick={() => go({ page: 'journal', source: 'server' })}>
          <Icon name="world" size={10} /> Сервер
        </button>
        {characters.map((c) => (
          <button type="button" key={c.id} className={source === c.id ? 'is-on' : ''} onClick={() => go({ page: 'journal', source: c.id })}>
            <PixelFace appearance={c.appearance} seed={c.id} size={16} /> {c.name}
          </button>
        ))}
        <input className="input input-sm tabs-filter" placeholder="Фильтр…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="panel journal-body">
        <LogView lines={lines} filter={filter} empty={current ? `${current.name} ещё не выходил в мир в этот запуск приложения.` : 'Сервер ещё не запускался.'} />
      </div>
    </div>
  )
}
