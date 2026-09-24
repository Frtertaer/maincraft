import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithRef,
  type InputHTMLAttributes,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  icon,
  size = 'md',
  busy,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: IconName; size?: 'sm' | 'md' | 'lg'; busy?: boolean }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size} ${busy ? 'is-busy' : ''} ${className ?? ''}`}
      disabled={rest.disabled || busy}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden /> : icon ? <Icon name={icon} size={size === 'sm' ? 10 : 20} /> : null}
      {children && <span>{children}</span>}
    </button>
  )
}

export function IconButton({
  icon,
  label,
  variant = 'ghost',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; variant?: Variant }) {
  return (
    <button type="button" className={`icon-btn btn-${variant} ${className ?? ''}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={20} />
    </button>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  inline,
  htmlFor
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  inline?: boolean
  htmlFor?: string
}) {
  return (
    <div className={`field ${inline ? 'field-inline' : ''} ${error ? 'has-error' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field-control">{children}</div>
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  )
}

export function TextInput({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={`input ${mono ? 'mono' : ''} ${className ?? ''}`} spellCheck={false} {...rest} />
}

export function TextArea({ className, ...rest }: ComponentPropsWithRef<'textarea'>) {
  return <textarea className={`input textarea ${className ?? ''}`} {...rest} />
}

export interface Option<T extends string> {
  value: T
  label: string
  hint?: string
  group?: string
}

/** Listbox-style select: native <select> popups look foreign in a custom dark UI. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Выберите…',
  id
}: {
  value: T | null
  options: Option<T>[]
  onChange: (value: T) => void
  placeholder?: string
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.value === value)))
  }, [open, options, value])

  const pick = (o: Option<T>) => {
    onChange(o.value)
    setOpen(false)
  }

  let lastGroup: string | undefined
  return (
    <div className={`select ${open ? 'is-open' : ''}`} ref={ref}>
      <button
        id={id}
        type="button"
        className="input select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (!open) setOpen(true)
            else setActive((a) => Math.min(options.length - 1, a + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(0, a - 1))
          } else if (e.key === 'Enter' && open) {
            e.preventDefault()
            if (options[active]) pick(options[active])
          } else if (e.key === 'Escape') setOpen(false)
        }}
      >
        <span className={current ? '' : 'muted'}>{current?.label ?? placeholder}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {open && (
        <div className="select-menu" role="listbox">
          {options.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? o.group : null
            lastGroup = o.group
            return (
              <div key={o.value}>
                {header && <div className="select-group">{header}</div>}
                <div
                  role="option"
                  aria-selected={o.value === value}
                  className={`select-option ${i === active ? 'is-active' : ''} ${o.value === value ? 'is-selected' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(o)
                  }}
                >
                  <span>{o.label}</span>
                  {o.hint && <span className="select-hint">{o.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md'
}: {
  value: T
  options: Array<{ value: T; label: string; icon?: IconName; title?: string }>
  onChange: (value: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'is-on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={10} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  hint?: ReactNode
  disabled?: boolean
}) {
  const id = useId()
  return (
    <label className={`toggle ${disabled ? 'is-disabled' : ''}`} htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden>
        <span className="toggle-thumb" />
      </span>
      {(label || hint) && (
        <span className="toggle-text">
          {label && <span className="toggle-label">{label}</span>}
          {hint && <span className="toggle-hint">{hint}</span>}
        </span>
      )}
    </label>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  left,
  right,
  format
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  left?: string
  right?: string
  format?: (v: number) => string
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="slider">
      {left && <span className="slider-end">{left}</span>}
      <div className="slider-body">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ '--pct': `${pct}%` } as React.CSSProperties}
        />
        {format && <span className="slider-value">{format(value)}</span>}
      </div>
      {right && <span className="slider-end">{right}</span>}
    </div>
  )
}

export function TagInput({
  value,
  onChange,
  placeholder,
  suggestions,
  labelFor,
  max = 20,
  mono
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  suggestions?: Array<{ value: string; label: string }>
  labelFor?: (v: string) => string
  max?: number
  mono?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [focus, setFocus] = useState(false)
  const add = (raw: string) => {
    const v = raw.trim()
    if (!v || value.includes(v) || value.length >= max) return
    onChange([...value, v])
    setDraft('')
  }
  const filtered = useMemo(() => {
    if (!suggestions) return []
    const q = draft.trim().toLowerCase()
    return suggestions.filter((s) => !value.includes(s.value) && (!q || s.label.toLowerCase().includes(q) || s.value.includes(q))).slice(0, 8)
  }, [draft, suggestions, value])

  return (
    <div className={`tags ${focus ? 'is-focus' : ''}`}>
      {value.map((v) => (
        <span className={`tag ${mono ? 'mono' : ''}`} key={v}>
          {labelFor ? labelFor(v) : v}
          <button type="button" aria-label={`Убрать ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      <input
        className={`tags-input ${mono ? 'mono' : ''}`}
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => {
          setTimeout(() => setFocus(false), 120)
          if (!suggestions) add(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || (e.key === ',' && !suggestions)) {
            e.preventDefault()
            if (suggestions) {
              if (filtered[0]) add(filtered[0].value)
            } else add(draft)
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
        }}
      />
      {focus && filtered.length > 0 && (
        <div className="tags-menu">
          {filtered.map((s) => (
            <button type="button" key={s.value} onMouseDown={(e) => { e.preventDefault(); add(s.value) }}>
              {s.label}
              <span className="mono muted">{s.value}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Badge({ tone = 'neutral', children, dot }: { tone?: 'neutral' | 'torch' | 'emerald' | 'redstone' | 'lapis'; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  )
}

export function StatusDot({ tone, pulse }: { tone: 'off' | 'busy' | 'on' | 'error'; pulse?: boolean }) {
  return <span className={`status-dot status-${tone} ${pulse ? 'is-pulse' : ''}`} aria-hidden />
}

/** Segmented progress bar in the spirit of the experience bar. */
export function XpBar({ value, max, indeterminate }: { value: number; max: number; indeterminate?: boolean }) {
  const segments = 24
  const filled = max > 0 ? Math.round((value / max) * segments) : 0
  return (
    <div className={`xpbar ${indeterminate ? 'is-indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} className={i < filled ? 'on' : ''} />
      ))}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton icon="close" label="Закрыть" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export function Empty({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={40} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Section({ title, description, children, aside }: { title: ReactNode; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {aside}
      </header>
      <div className="section-body">{children}</div>
    </section>
  )
}

export function CopyText({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="copy"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
      title="Скопировать"
    >
      <span className="mono">{label ?? text}</span>
      <Icon name={copied ? 'check' : 'copy'} size={10} />
    </button>
  )
}
