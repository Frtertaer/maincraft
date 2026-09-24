import { useEffect, useRef } from 'react'
import type { LogLine } from '@shared/types'
import { formatClock } from '../lib/format'

function tone(line: LogLine): string {
  if (line.stream === 'app') return 'is-app'
  if (line.stream === 'err' || /\b(ERROR|SEVERE|FATAL|Exception)\b/.test(line.text)) return 'is-err'
  if (/\bWARN\b/.test(line.text)) return 'is-warn'
  if (/joined the game|left the game|Done \(/.test(line.text)) return 'is-good'
  return ''
}

// Paper ("[12:34:56 INFO]: ") and the agent ("[12:34:56] ") stamp lines themselves; we show our own time column.
const OWN_STAMP = /^\[\d{2}:\d{2}:\d{2}(?: (\w+))?\]:? /

function clean(text: string): { text: string; level: string | null } {
  const m = text.match(OWN_STAMP)
  if (!m) return { text, level: null }
  const level = m[1] && m[1] !== 'INFO' ? m[1] : null
  return { text: text.slice(m[0].length), level }
}

export function LogView({ lines, filter = '', empty = 'Пока пусто' }: { lines: LogLine[]; filter?: string; empty?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const q = filter.trim().toLowerCase()
  const shown = (q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines).slice(-1500)

  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [shown.length, lines])

  return (
    <div
      className="logview selectable"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
      }}
    >
      {shown.length === 0 ? (
        <div className="logview-empty">{empty}</div>
      ) : (
        shown.map((line, i) => {
          const c = clean(line.text)
          return (
            <div key={`${line.ts}-${i}`} className={`logline ${tone(line)}`}>
              <time>{formatClock(line.ts)}</time>
              <span>
                {c.level && <b className="loglevel">{c.level}</b>}
                {c.text}
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}
