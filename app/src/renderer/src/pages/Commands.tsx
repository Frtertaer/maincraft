import { useEffect, useRef, useState } from 'react'
import type { CustomCommand, ScriptStep } from '@shared/types'
import { ACTIONS, ACTION_BY_TYPE, BLOCKS, FOODS, ITEMS, PLACEHOLDERS } from '@shared/catalog'
import { COMMAND_TEMPLATES, commandFromTemplate } from '@shared/defaults'
import { Badge, Button, Empty, Field, IconButton, Modal, Section, Segmented, Select, TagInput, TextArea, TextInput, Toggle } from '../components/ui'
import { Icon } from '../components/Icon'
import { api, attempt, useApp } from '../lib/store'

const ACTION_OPTIONS = ACTIONS.map((a) => ({ value: a.type, label: a.label }))

function datalistFor(kind: string): string | undefined {
  if (kind === 'block') return 'dl-blocks'
  if (kind === 'item') return 'dl-items'
  if (kind === 'food') return 'dl-foods'
  return undefined
}

function Datalists() {
  return (
    <>
      <datalist id="dl-blocks">
        {Object.entries(BLOCKS).map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </datalist>
      <datalist id="dl-items">
        {Object.entries(ITEMS).map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </datalist>
      <datalist id="dl-foods">
        {Object.entries(FOODS).map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </datalist>
    </>
  )
}

function StepEditor({
  step,
  index,
  total,
  onChange,
  onMove,
  onRemove
}: {
  step: ScriptStep
  index: number
  total: number
  onChange: (s: ScriptStep) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const def = ACTION_BY_TYPE[step.type]
  return (
    <li className="step">
      <span className="step-num">{index + 1}</span>
      <div className="step-main">
        <div className="step-row">
          <div className="step-param step-type">
            <span>Действие</span>
            <Select value={step.type} options={ACTION_OPTIONS} onChange={(type) => onChange({ type })} />
          </div>
          {def?.params.map((p) => (
            <label key={p.key} className={`step-param step-param-${p.kind}`}>
              <span>{p.label}</span>
              <input
                className="input mono"
                list={datalistFor(p.kind)}
                value={step[p.key] === undefined ? '' : String(step[p.key])}
                placeholder={p.placeholder}
                onChange={(e) => {
                  const next = { ...step }
                  const raw = e.target.value
                  if (raw === '') delete next[p.key]
                  else next[p.key] = p.kind === 'number' && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
                  onChange(next)
                }}
              />
            </label>
          ))}
        </div>
        <div className="step-foot">
          {def?.hint && <span className="muted">{def.hint}</span>}
          <label className="step-check">
            <input type="checkbox" checked={step.continueOnError === true} onChange={(e) => onChange({ ...step, continueOnError: e.target.checked })} />
            продолжить, если не вышло
          </label>
        </div>
      </div>
      <div className="step-tools">
        <IconButton icon="arrowUp" label="Выше" disabled={index === 0} onClick={() => onMove(-1)} />
        <IconButton icon="arrowDown" label="Ниже" disabled={index === total - 1} onClick={() => onMove(1)} />
        <IconButton icon="trash" label="Удалить шаг" onClick={onRemove} />
      </div>
    </li>
  )
}

function CommandEditor({ command }: { command: CustomCommand }) {
  const characters = useApp((s) => s.characters)
  const bots = useApp((s) => s.bots)
  const reload = useApp((s) => s.reloadCommands)
  const go = useApp((s) => s.go)
  const toast = useApp((s) => s.toast)
  const [draft, setDraft] = useState(command)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [tester, setTester] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => setDraft(command), [command])
  const dirty = JSON.stringify({ ...draft, updatedAt: 0 }) !== JSON.stringify({ ...command, updatedAt: 0 })
  const set = <K extends keyof CustomCommand>(key: K, value: CustomCommand[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const online = characters.filter((c) => bots[c.id]?.state === 'online')
  const testTarget = online.find((c) => c.id === tester) ?? online[0]
  const example = characters[0]?.name ?? 'Бублик'
  const trigger = draft.triggers[0] ?? 'команда'

  const insert = (token: string) => {
    const el = promptRef.current
    if (!el) return set('prompt', draft.prompt + token)
    const start = el.selectionStart ?? draft.prompt.length
    const end = el.selectionEnd ?? start
    set('prompt', draft.prompt.slice(0, start) + token + draft.prompt.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const updateStep = (i: number, s: ScriptStep) => set('steps', draft.steps.map((x, j) => (j === i ? s : x)))
  const moveStep = (i: number, dir: -1 | 1) => {
    const next = [...draft.steps]
    const [item] = next.splice(i, 1)
    next.splice(i + dir, 0, item)
    set('steps', next)
  }

  const save = async () => {
    setSaving(true)
    const saved = await attempt(() => api.commands.save(draft))
    setSaving(false)
    if (!saved) return
    await reload()
    toast(online.length ? 'Сохранено — персонажи в мире уже знают новую версию' : 'Команда сохранена', 'success')
  }

  const remove = async () => {
    setConfirm(false)
    await attempt(() => api.commands.remove(command.id), 'Команда удалена')
    await reload()
    go({ page: 'commands' })
  }

  const test = async () => {
    if (!testTarget) return
    await attempt(() => api.bots.command(testTarget.id, `!${trigger}`), `Отправил «!${trigger}» персонажу ${testTarget.name}`)
  }

  return (
    <div className="editor">
      <div className="cmd-title">
        <input className="title-input" value={draft.name} maxLength={80} onChange={(e) => set('name', e.target.value)} aria-label="Название команды" />
        <Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label={draft.enabled ? 'Включена' : 'Выключена'} />
      </div>
      <TextInput className="subtitle-input" value={draft.description} maxLength={300} placeholder="Короткое описание — для себя" onChange={(e) => set('description', e.target.value)} />

      <Section title="Как вызвать" description="Фразы, на которые персонаж откликается. Всё, что сказано после фразы, попадёт в {args}.">
        <TagInput mono value={draft.triggers} onChange={(v) => set('triggers', v.map((t) => t.replace(/^!+/, '').toLowerCase()))} placeholder="дрова, наруби дерева (Enter)" max={12} />
        <div className="examples">
          <span className="eyebrow">В чате Minecraft</span>
          <code>!{trigger} 16</code>
          <code>
            {example}, {trigger}
          </code>
          {draft.matchPlain && <code>{trigger}</code>}
        </div>
        <Toggle checked={draft.matchPlain} onChange={(v) => set('matchPlain', v)} label="Срабатывать без обращения" hint="Персонаж отреагирует, даже если фразу просто написали в общий чат" />
        <Field label="Кто может вызвать">
          <Segmented
            value={draft.access}
            onChange={(access) => set('access', access)}
            options={[
              { value: 'controllers', label: 'Те, кого персонаж слушается' },
              { value: 'everyone', label: 'Любой игрок' }
            ]}
          />
        </Field>
      </Section>

      <Section title="Что сделать">
        <div className="role-cards role-cards-2">
          <button type="button" className={`role-card ${draft.kind === 'ai' ? 'is-on' : ''}`} onClick={() => set('kind', 'ai')}>
            <Icon name="idea" size={20} />
            <strong>Задание для ИИ</strong>
            <span>Опиши словами, что нужно, — персонаж сам решит, как это сделать</span>
          </button>
          <button
            type="button"
            className={`role-card ${draft.kind === 'script' ? 'is-on' : ''}`}
            onClick={() => setDraft((d) => ({ ...d, kind: 'script', steps: d.steps.length ? d.steps : [{ type: 'come', player: '{player}' }] }))}
          >
            <Icon name="script" size={20} />
            <strong>Сценарий</strong>
            <span>Точная последовательность действий — без ИИ, мгновенно и бесплатно</span>
          </button>
        </div>

        {draft.kind === 'ai' ? (
          <Field label="Задание" hint="Подстановки заменятся на реальные значения в момент вызова">
            <TextArea ref={promptRef} rows={4} value={draft.prompt} maxLength={2000} placeholder="Построй рядом со мной небольшой дом из досок…" onChange={(e) => set('prompt', e.target.value)} />
          </Field>
        ) : (
          <>
            <ol className="steps">
              {draft.steps.map((s, i) => (
                <StepEditor
                  key={i}
                  step={s}
                  index={i}
                  total={draft.steps.length}
                  onChange={(next) => updateStep(i, next)}
                  onMove={(dir) => moveStep(i, dir)}
                  onRemove={() => set('steps', draft.steps.filter((_, j) => j !== i))}
                />
              ))}
            </ol>
            <div>
              <Button icon="plus" size="sm" disabled={draft.steps.length >= 50} onClick={() => set('steps', [...draft.steps, { type: 'chat', text: '' }])}>
                Добавить шаг
              </Button>
            </div>
          </>
        )}
        <div className="placeholders">
          {PLACEHOLDERS.map((p) => (
            <button type="button" key={p.token} className="placeholder" onClick={() => (draft.kind === 'ai' ? insert(p.token) : void navigator.clipboard.writeText(p.token))} title={draft.kind === 'ai' ? 'Вставить' : 'Скопировать'}>
              <code>{p.token}</code>
              <span>{p.label}</span>
            </button>
          ))}
        </div>
        <Field label="Сразу ответить в чат" hint="Необязательно. Например: «Бегу, {player}!»">
          <TextInput value={draft.reply} maxLength={256} onChange={(e) => set('reply', e.target.value)} placeholder="Сейчас сделаю" />
        </Field>
      </Section>

      <Section title="Проверить" description={online.length ? 'Отправит команду выбранному персонажу, как будто ты написал её в чат' : 'Позови персонажа в мир, чтобы проверить команду'}>
        <div className="test-row">
          {online.length > 1 && (
            <div className="test-target">
              <Select value={testTarget?.id ?? null} options={online.map((c) => ({ value: c.id, label: c.name }))} onChange={setTester} />
            </div>
          )}
          <Button icon="play" disabled={!testTarget || dirty || !draft.triggers.length} onClick={test}>
            {testTarget ? `Отправить «!${trigger}» — ${testTarget.name}` : 'Никого нет в мире'}
          </Button>
          {dirty && <span className="muted">сначала сохрани</span>}
        </div>
      </Section>

      <div className="danger-zone">
        <Button variant="danger" icon="trash" onClick={() => setConfirm(true)}>
          Удалить команду
        </Button>
      </div>

      <div className={`savebar ${dirty ? 'is-visible' : ''}`}>
        <span>Есть несохранённые изменения</span>
        <Button variant="ghost" onClick={() => setDraft(command)}>
          Отменить
        </Button>
        <Button variant="primary" icon="check" busy={saving} onClick={save}>
          Сохранить
        </Button>
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Удалить «${command.name}»?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Оставить
            </Button>
            <Button variant="danger" onClick={remove}>
              Удалить
            </Button>
          </>
        }
      >
        <p>Персонажи перестанут понимать эту команду.</p>
      </Modal>
    </div>
  )
}

function NewCommand({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reload = useApp((s) => s.reloadCommands)
  const go = useApp((s) => s.go)
  const create = async (index: number | null) => {
    const draft = commandFromTemplate(index)
    if (index === null) {
      draft.triggers = ['новая']
      draft.prompt = 'Опиши здесь, что должен сделать персонаж.'
    }
    const saved = await attempt(() => api.commands.save(draft))
    if (saved) {
      await reload()
      go({ page: 'commands', id: saved.id })
      onClose()
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Новая команда" wide>
      <div className="cmd-templates">
        <button type="button" className="cmd-template" onClick={() => create(null)}>
          <Icon name="plus" size={20} />
          <strong>Пустая команда</strong>
          <span>Придумай с нуля</span>
        </button>
        {COMMAND_TEMPLATES.map((t, i) => (
          <button type="button" key={t.name} className="cmd-template" onClick={() => create(i)}>
            <Icon name={t.kind === 'ai' ? 'idea' : 'script'} size={20} />
            <strong>{t.name}</strong>
            <span>{t.description}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

export function CommandsPage({ selectedId }: { selectedId?: string }) {
  const commands = useApp((s) => s.commands)
  const go = useApp((s) => s.go)
  const [creating, setCreating] = useState(false)
  const selected = commands.find((c) => c.id === selectedId) ?? commands[0]

  return (
    <div className="page page-split">
      <Datalists />
      <aside className="list-pane">
        <header className="list-head">
          <h2>Команды</h2>
          <IconButton icon="plus" label="Новая команда" variant="secondary" onClick={() => setCreating(true)} />
        </header>
        <div className="list">
          {commands.map((c) => (
            <button type="button" key={c.id} className={`list-item list-item-cmd ${c.id === selected?.id ? 'is-active' : ''} ${c.enabled ? '' : 'is-off'}`} onClick={() => go({ page: 'commands', id: c.id })}>
              <span className="cmd-kind">
                <Icon name={c.kind === 'ai' ? 'idea' : 'script'} size={20} />
              </span>
              <span className="list-item-text">
                <strong>{c.name}</strong>
                <span className="mono">{c.triggers.map((t) => `!${t}`).join('  ')}</span>
              </span>
              {!c.enabled && <Badge>выкл</Badge>}
            </button>
          ))}
        </div>
      </aside>
      <div className="detail-pane">
        {selected ? (
          <CommandEditor key={selected.id} command={selected} />
        ) : (
          <Empty icon="commands" title="Команд пока нет" action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Создать команду</Button>}>
            Команда — это фраза в чате, на которую персонаж откликается действием: «!дрова», «Бублик, охраняй».
          </Empty>
        )}
      </div>
      <NewCommand open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}
