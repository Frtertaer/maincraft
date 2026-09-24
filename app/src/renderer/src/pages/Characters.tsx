import { useEffect, useMemo, useState } from 'react'
import type { Character, Traits } from '@shared/types'
import { CHARACTER_TEMPLATES, characterFromTemplate } from '@shared/defaults'
import { FOODS, USERNAME_RE, VOICES, itemLabel } from '@shared/catalog'
import { composePersona, ROLE_INFO, TRAIT_LABELS } from '@shared/persona'
import { Button, Empty, Field, IconButton, Modal, Section, Segmented, Select, Slider, StatusDot, TagInput, TextArea, TextInput, Toggle, Badge } from '../components/ui'
import { Icon, type IconName } from '../components/Icon'
import { HAIR_STYLE_COUNT, Hearts, Hunger, PixelFace } from '../components/Pixel'
import { api, attempt, BOT_STATE_LABEL, isBotActive, speech, useApp } from '../lib/store'
import { formatTokens } from '../lib/format'

const SKINS = ['#f3d2b3', '#e8b38a', '#d9a47a', '#c68a5e', '#a86b45', '#7a4a2c']
const HAIRS = ['#1c1c1c', '#4a3222', '#8a4b1f', '#c9772f', '#e3c16f', '#d8d8d8', '#a33b2b', '#3b5a8a']
const EYES = ['#3b6fd8', '#2f7d4f', '#5a4632', '#6f4fb0', '#c0392b', '#2aa3a3']
const SHIRTS = ['#2f8f83', '#d9822b', '#3a3f47', '#6b9c3f', '#7a5230', '#b8393b', '#3b5fa8', '#e0c34a']

const DIMENSIONS: Record<string, string> = { overworld: 'Верхний мир', the_nether: 'Незер', the_end: 'Край' }

const ROLE_ICON: Record<Character['role'], IconName> = { companion: 'characters', settler: 'home', speedrun: 'sword' }

function Swatches({ value, colors, onChange, label }: { value: string; colors: string[]; onChange: (c: string) => void; label: string }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      <span className="swatches-label">{label}</span>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          className={`swatch ${c === value ? 'is-on' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
          title={c}
        />
      ))}
      <label className="swatch swatch-custom" title="Свой цвет">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <Icon name="plus" size={10} />
      </label>
    </div>
  )
}

function uniqueUsername(base: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()))
  if (!lower.has(base.toLowerCase())) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, 14)}${i}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
  return `${base.slice(0, 10)}${Date.now() % 100000}`
}

function TemplatePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const characters = useApp((s) => s.characters)
  const reload = useApp((s) => s.reloadCharacters)
  const go = useApp((s) => s.go)
  const create = async (key: string | null) => {
    const c = characterFromTemplate(key)
    c.username = uniqueUsername(c.username, characters.map((x) => x.username))
    if (!key) {
      c.name = 'Безымянный'
      c.username = uniqueUsername('Stranger', characters.map((x) => x.username))
    }
    const saved = await attempt(() => api.characters.save(c))
    if (saved) {
      await reload()
      go({ page: 'characters', id: saved.id })
      onClose()
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Новый персонаж" wide>
      <p className="muted modal-lead">Возьми готовый характер и поменяй под себя — или начни с чистого листа.</p>
      <div className="template-grid">
        {CHARACTER_TEMPLATES.map((t) => (
          <button type="button" key={t.key} className="template" onClick={() => create(t.key)}>
            <PixelFace appearance={t.seed.appearance} seed={t.key} size={64} />
            <strong>{t.title}</strong>
            <span className="template-role">{ROLE_INFO[t.seed.role].title}</span>
            <span className="template-tag">{t.tagline}</span>
          </button>
        ))}
        <button type="button" className="template template-blank" onClick={() => create(null)}>
          <span className="template-blank-icon">
            <Icon name="plus" size={30} />
          </span>
          <strong>С чистого листа</strong>
          <span className="template-tag">Пустой персонаж — всё настроишь сам</span>
        </button>
      </div>
    </Modal>
  )
}

function LiveStrip({ character }: { character: Character }) {
  const status = useApp((s) => s.bots[character.id])
  const [viewer, setViewer] = useState(false)
  const [busy, setBusy] = useState(false)
  const active = isBotActive(status)
  const live = status?.state === 'online' ? status.live : null

  const toggle = async () => {
    setBusy(true)
    await attempt(() => (active ? api.bots.stop(character.id) : api.bots.start(character.id)))
    setBusy(false)
  }

  return (
    <div className={`live-strip ${active ? 'is-active' : ''}`}>
      <div className="live-top">
        <div className="live-state">
          <StatusDot tone={status?.state === 'online' ? 'on' : status?.state === 'error' ? 'error' : active ? 'busy' : 'off'} pulse={active && status?.state !== 'online'} />
          <div>
            <strong>{BOT_STATE_LABEL[status?.state ?? 'offline']}</strong>
            <span className={status?.state === 'error' ? 'is-error' : ''}>
              {status?.message ?? (live ? `${DIMENSIONS[live.dimension] ?? live.dimension} · ${live.position.x} ${live.position.y} ${live.position.z}` : 'Позови, чтобы персонаж вошёл в мир')}
            </span>
          </div>
        </div>
        <div className="live-actions">
          {status?.viewerUrl && status.state === 'online' && (
            <Button variant="ghost" icon="eye" onClick={() => setViewer(true)}>
              Глазами персонажа
            </Button>
          )}
          <Button variant={active ? 'secondary' : 'primary'} busy={busy} onClick={toggle}>
            {active ? 'Отпустить' : 'Позвать в мир'}
          </Button>
        </div>
      </div>
      {live && (
        <div className="live-stats">
          <div className="live-vitals">
            <Hearts value={live.health} />
            <Hunger value={live.food} />
          </div>
          {live.budget && (
            <div className="live-stat" title="Сколько ИИ потратил за этот выход в мир">
              <span className="eyebrow">Расход ИИ</span>
              <span className="mono">
                {live.budget.requestsUsed} запр. · {formatTokens(live.budget.tokensUsed)} ток.
              </span>
            </div>
          )}
          {live.inventory.length > 0 && (
            <div className="live-stat live-inv" title={live.inventory.map((i) => `${itemLabel(i.name)} × ${i.count}`).join('\n')}>
              <span className="eyebrow">В карманах</span>
              <span>
                {live.inventory
                  .slice(0, 4)
                  .map((i) => `${itemLabel(i.name)} ×${i.count}`)
                  .join(', ')}
                {live.inventory.length > 4 && ` и ещё ${live.inventory.length - 4}`}
              </span>
            </div>
          )}
        </div>
      )}
      {live && (live.goal || live.plan.length > 0) && (
        <div className="live-mind">
          {live.goal && (
            <p>
              <span className="eyebrow">Цель</span> {live.goal}
            </p>
          )}
          {live.plan.length > 0 && (
            <ol>
              {live.plan.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          )}
          {live.lastThink && <p className="live-think">«{live.lastThink}»</p>}
        </div>
      )}
      <Modal open={viewer} onClose={() => setViewer(false)} title={`Глазами: ${character.name}`} wide>
        {status?.viewerUrl ? (
          <iframe className="pov" src={status.viewerUrl} title="Вид от первого лица" />
        ) : (
          <p className="muted">Просмотр появится, когда персонаж войдёт в мир.</p>
        )}
      </Modal>
    </div>
  )
}

function CharacterEditor({ character }: { character: Character }) {
  const characters = useApp((s) => s.characters)
  const commands = useApp((s) => s.commands)
  const playerName = useApp((s) => s.view?.settings.playerName ?? '')
  const status = useApp((s) => s.bots[character.id])
  const reload = useApp((s) => s.reloadCharacters)
  const go = useApp((s) => s.go)
  const toast = useApp((s) => s.toast)
  const [draft, setDraft] = useState<Character>(character)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sample, setSample] = useState('Привет! Пойдём копать алмазы?')
  const [previewing, setPreviewing] = useState(false)

  useEffect(() => setDraft(character), [character])

  const dirty = useMemo(() => JSON.stringify({ ...draft, updatedAt: 0 }) !== JSON.stringify({ ...character, updatedAt: 0 }), [draft, character])
  const set = <K extends keyof Character>(key: K, value: Character[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const setTrait = (key: keyof Traits, value: number) => setDraft((d) => ({ ...d, traits: { ...d.traits, [key]: value } }))
  const usernameError = !USERNAME_RE.test(draft.username)
    ? 'Латиница, цифры и «_», от 3 до 16 символов'
    : characters.some((c) => c.id !== draft.id && c.username.toLowerCase() === draft.username.toLowerCase())
      ? 'Такой ник уже у другого персонажа'
      : null
  const foodOptions = useMemo(() => Object.entries(FOODS).map(([value, label]) => ({ value, label })), [])
  const active = isBotActive(status)

  const save = async () => {
    setSaving(true)
    const saved = await attempt(() => api.characters.save(draft))
    setSaving(false)
    if (!saved) return
    await reload()
    const renamed = saved.username !== character.username || saved.name !== character.name
    toast(
      active
        ? renamed
          ? 'Сохранено. Новое имя и ник появятся, когда персонаж снова войдёт в мир.'
          : 'Сохранено — персонаж уже живёт по-новому'
        : 'Персонаж сохранён',
      'success'
    )
  }

  const preview = async () => {
    setPreviewing(true)
    const res = await attempt(() => api.voice.preview(draft.voice.voice, draft.voice.rate, draft.voice.pitch, sample))
    setPreviewing(false)
    if (res) speech.enqueue(draft.id, res.audio, res.mime)
  }

  const remove = async () => {
    setConfirmDelete(false)
    await attempt(() => api.characters.remove(character.id), `«${character.name}» удалён`)
    await reload()
    go({ page: 'characters' })
  }

  const randomLook = () => {
    const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]
    set('appearance', { skin: pick(SKINS), hair: pick(HAIRS), eyes: pick(EYES), shirt: pick(SHIRTS), hairStyle: Math.floor(Math.random() * HAIR_STYLE_COUNT) })
  }

  const voiceOptions = VOICES.map((v) => ({
    value: v.id,
    label: `${v.label}${v.gender === 'female' ? ' · жен.' : ' · муж.'}`,
    group: v.native ? 'Русские голоса' : 'Мультиязычные — с лёгким акцентом'
  }))

  return (
    <div className="editor">
      <LiveStrip character={character} />

      <div className="identity">
        <div className="identity-face">
          <PixelFace appearance={draft.appearance} seed={draft.id} size={128} />
          <div className="identity-face-actions">
            <IconButton icon="chevronRight" label="Другая причёска" className="flip" onClick={() => set('appearance', { ...draft.appearance, hairStyle: (draft.appearance.hairStyle + HAIR_STYLE_COUNT - 1) % HAIR_STYLE_COUNT })} />
            <span className="muted">причёска</span>
            <IconButton icon="chevronRight" label="Следующая причёска" onClick={() => set('appearance', { ...draft.appearance, hairStyle: (draft.appearance.hairStyle + 1) % HAIR_STYLE_COUNT })} />
          </div>
        </div>
        <div className="identity-fields">
          <div className="grid-2">
            <Field label="Имя" hint="Так персонаж представляется и откликается в чате">
              <TextInput value={draft.name} maxLength={40} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Ник в игре" error={usernameError} hint="Видно над головой в Minecraft">
              <TextInput mono value={draft.username} maxLength={16} onChange={(e) => set('username', e.target.value.replace(/\s/g, '_'))} />
            </Field>
          </div>
          <Swatches label="Кожа" value={draft.appearance.skin} colors={SKINS} onChange={(c) => set('appearance', { ...draft.appearance, skin: c })} />
          <Swatches label="Волосы" value={draft.appearance.hair} colors={HAIRS} onChange={(c) => set('appearance', { ...draft.appearance, hair: c })} />
          <Swatches label="Глаза" value={draft.appearance.eyes} colors={EYES} onChange={(c) => set('appearance', { ...draft.appearance, eyes: c })} />
          <Swatches label="Одежда" value={draft.appearance.shirt} colors={SHIRTS} onChange={(c) => set('appearance', { ...draft.appearance, shirt: c })} />
          <div>
            <Button variant="ghost" size="sm" icon="dice" onClick={randomLook}>
              Случайный облик
            </Button>
          </div>
        </div>
      </div>

      <Section title="Роль" description="Главное, чем персонаж занят в мире">
        <div className="role-cards">
          {(Object.keys(ROLE_INFO) as Character['role'][]).map((role) => (
            <button
              type="button"
              key={role}
              className={`role-card ${draft.role === role ? 'is-on' : ''}`}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  role,
                  behavior: { ...d.behavior, mode: role === 'speedrun' ? 'auto' : d.behavior.mode === 'auto' && role === 'companion' ? 'hybrid' : d.behavior.mode }
                }))
              }
            >
              <Icon name={ROLE_ICON[role]} size={20} />
              <strong>{ROLE_INFO[role].title}</strong>
              <span>{ROLE_INFO[role].short}</span>
            </button>
          ))}
        </div>
        <Field label="Цель" hint={draft.role === 'speedrun' ? 'С этой целью персонаж входит в мир и идёт к титрам' : 'Чем персонаж займётся, если ему ничего не поручили'}>
          <TextInput value={draft.goal} maxLength={300} placeholder="например, построить дом у реки" onChange={(e) => set('goal', e.target.value)} />
        </Field>
      </Section>

      <Section title="Характер" description="Из этого складывается то, как персонаж думает и разговаривает">
        <Field label="Кто он такой" hint="Пара предложений о прошлом и о том, чем живёт">
          <TextArea rows={3} value={draft.bio} maxLength={1200} placeholder="Бывший пекарь из деревни у реки…" onChange={(e) => set('bio', e.target.value)} />
        </Field>
        <Field label="Манера речи" hint="Словечки, темп, обращение к игроку">
          <TextArea rows={2} value={draft.speech} maxLength={600} placeholder="Говорит просто, любит подшутить…" onChange={(e) => set('speech', e.target.value)} />
        </Field>
        <div className="traits">
          {(Object.keys(TRAIT_LABELS) as Array<keyof Traits>).map((key) => (
            <Slider key={key} value={draft.traits[key]} min={0} max={100} left={TRAIT_LABELS[key][0]} right={TRAIT_LABELS[key][1]} onChange={(v) => setTrait(key, v)} />
          ))}
        </div>
      </Section>

      <Section title="Вкусы" description="Любимая и нелюбимая еда влияет не только на разговоры: персонаж правда ест любимое первым и отказывается от ненавистного, пока не проголодается всерьёз">
        <div className="grid-2">
          <Field label="Любит">
            <TagInput value={draft.likes} onChange={(v) => set('likes', v)} placeholder="закаты, алмазы… (Enter)" />
          </Field>
          <Field label="Терпеть не может">
            <TagInput value={draft.dislikes} onChange={(v) => set('dislikes', v)} placeholder="дождь, криперы… (Enter)" />
          </Field>
          <Field label="Любимая еда">
            <TagInput value={draft.favoriteFoods} onChange={(v) => set('favoriteFoods', v)} suggestions={foodOptions} labelFor={(v) => FOODS[v] ?? v} placeholder="начни печатать: хлеб" />
          </Field>
          <Field label="Не выносит">
            <TagInput value={draft.hatedFoods} onChange={(v) => set('hatedFoods', v)} suggestions={foodOptions} labelFor={(v) => FOODS[v] ?? v} placeholder="гнилая плоть…" />
          </Field>
        </div>
        <Field label="Боится">
          <TagInput value={draft.fears} onChange={(v) => set('fears', v)} placeholder="темнота, лава… (Enter)" />
        </Field>
      </Section>

      <Section title="Поведение">
        <Field label="Самостоятельность">
          <Segmented
            value={draft.behavior.mode}
            onChange={(mode) => set('behavior', { ...draft.behavior, mode })}
            options={[
              { value: 'hybrid', label: 'Сам и по просьбе' },
              { value: 'auto', label: 'Полностью сам' },
              { value: 'listen', label: 'Только по команде' },
              { value: 'observe', label: 'Наблюдает' }
            ]}
          />
        </Field>
        <div className="grid-2">
          <Field label="В бою">
            <Segmented
              value={draft.behavior.combat}
              onChange={(combat) => set('behavior', { ...draft.behavior, combat })}
              options={[
                { value: 'auto', label: 'Отбивается' },
                { value: 'hold', label: 'Наготове' },
                { value: 'off', label: 'Не дерётся' }
              ]}
            />
          </Field>
          <Field label="Думает раз в" hint="Чаще — живее, но дороже по токенам">
            <Slider value={draft.behavior.thinkEverySec} min={2} max={30} onChange={(v) => set('behavior', { ...draft.behavior, thinkEverySec: v })} format={(v) => `${v} с`} />
          </Field>
          <Field label="Слушается">
            <Segmented
              value={draft.behavior.obeys}
              onChange={(obeys) => set('behavior', { ...draft.behavior, obeys })}
              options={[
                { value: 'me', label: playerName ? `Только ${playerName}` : 'Только меня' },
                { value: 'everyone', label: 'Всех игроков' }
              ]}
            />
          </Field>
          <Field label="Разговаривает">
            <Segmented
              value={draft.behavior.talksTo}
              onChange={(talksTo) => set('behavior', { ...draft.behavior, talksTo })}
              options={[
                { value: 'everyone', label: 'Со всеми' },
                { value: 'me', label: 'Только со мной' }
              ]}
            />
          </Field>
        </div>
        <Toggle
          checked={draft.vision.enabled}
          onChange={(enabled) => set('vision', { ...draft.vision, enabled })}
          label="Видит мир картинкой"
          hint="ИИ получает кадр от первого лица и лучше ориентируется. Расход токенов вырастет в несколько раз."
        />
        {draft.vision.enabled && (
          <Field label="Кадр каждые" inline>
            <Slider value={draft.vision.everyNTicks} min={1} max={10} onChange={(v) => set('vision', { ...draft.vision, everyNTicks: v })} format={(v) => `${v} шаг.`} />
          </Field>
        )}
      </Section>

      <Section title="Голос" description="Реплики персонажа звучат из колонок компьютера — удобно, когда играешь в полноэкранном режиме">
        <Toggle checked={draft.voice.enabled} onChange={(enabled) => set('voice', { ...draft.voice, enabled })} label="Говорить вслух" />
        <div className={`voice-grid ${draft.voice.enabled ? '' : 'is-dim'}`}>
          <Field label="Голос">
            <Select value={draft.voice.voice} options={voiceOptions} onChange={(voice) => set('voice', { ...draft.voice, voice })} />
          </Field>
          <Field label="Темп">
            <Slider value={draft.voice.rate} min={0.7} max={1.4} step={0.05} onChange={(rate) => set('voice', { ...draft.voice, rate })} format={(v) => `×${v.toFixed(2)}`} />
          </Field>
          <Field label="Высота">
            <Slider value={draft.voice.pitch} min={-30} max={30} onChange={(pitch) => set('voice', { ...draft.voice, pitch })} format={(v) => `${v > 0 ? '+' : ''}${v}%`} />
          </Field>
        </div>
        <div className="voice-try">
          <TextInput value={sample} onChange={(e) => setSample(e.target.value)} maxLength={200} />
          <Button icon="speaker" busy={previewing} onClick={preview}>
            Прослушать
          </Button>
        </div>
      </Section>

      <Section title="Команды" description="Какие из твоих команд персонаж понимает">
        <Toggle checked={draft.commands === 'all'} onChange={(all) => set('commands', all ? 'all' : commands.map((c) => c.id))} label="Все команды" hint="Новые команды будут доступны автоматически" />
        {draft.commands !== 'all' && (
          <div className="command-checks">
            {commands.map((cmd) => {
              const list = draft.commands === 'all' ? [] : draft.commands
              const on = list.includes(cmd.id)
              return (
                <Toggle key={cmd.id} checked={on} onChange={(v) => set('commands', v ? [...list, cmd.id] : list.filter((x) => x !== cmd.id))} label={cmd.name} hint={cmd.triggers.map((t) => `!${t}`).join('  ')} />
              )
            })}
          </div>
        )}
      </Section>

      <details className="prompt-preview">
        <summary>
          <Icon name="idea" size={10} /> Как это видит ИИ
        </summary>
        <pre className="selectable">{composePersona(draft, playerName)}</pre>
      </details>

      <div className="danger-zone">
        <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>
          Удалить персонажа
        </Button>
      </div>

      <div className={`savebar ${dirty ? 'is-visible' : ''}`}>
        <span>Есть несохранённые изменения</span>
        <Button variant="ghost" onClick={() => setDraft(character)}>
          Отменить
        </Button>
        <Button variant="primary" icon="check" busy={saving} disabled={Boolean(usernameError) || !draft.name.trim()} onClick={save}>
          Сохранить
        </Button>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Удалить «${character.name}»?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Оставить
            </Button>
            <Button variant="danger" onClick={remove}>
              Удалить
            </Button>
          </>
        }
      >
        <p>Персонаж исчезнет из списка. Мир и постройки останутся на месте.</p>
      </Modal>
    </div>
  )
}

export function CharactersPage({ selectedId }: { selectedId?: string }) {
  const characters = useApp((s) => s.characters)
  const bots = useApp((s) => s.bots)
  const go = useApp((s) => s.go)
  const [picker, setPicker] = useState(false)
  const selected = characters.find((c) => c.id === selectedId) ?? characters[0]

  return (
    <div className="page page-split">
      <aside className="list-pane">
        <header className="list-head">
          <h2>Персонажи</h2>
          <IconButton icon="plus" label="Новый персонаж" variant="secondary" onClick={() => setPicker(true)} />
        </header>
        <div className="list">
          {characters.map((c) => {
            const st = bots[c.id]
            return (
              <button type="button" key={c.id} className={`list-item ${c.id === selected?.id ? 'is-active' : ''}`} onClick={() => go({ page: 'characters', id: c.id })}>
                <PixelFace appearance={c.appearance} seed={c.id} size={40} />
                <span className="list-item-text">
                  <strong>{c.name}</strong>
                  <span>
                    <StatusDot tone={st?.state === 'online' ? 'on' : st?.state === 'error' ? 'error' : isBotActive(st) ? 'busy' : 'off'} /> {ROLE_INFO[c.role].title}
                  </span>
                </span>
                {st?.state === 'online' && <Badge tone="emerald">в мире</Badge>}
              </button>
            )
          })}
        </div>
      </aside>
      <div className="detail-pane">
        {selected ? (
          <CharacterEditor key={selected.id} character={selected} />
        ) : (
          <Empty icon="characters" title="Персонажей пока нет" action={<Button variant="primary" icon="plus" onClick={() => setPicker(true)}>Создать персонажа</Button>}>
            Персонаж — это ИИ со своим именем, характером и вкусами, который живёт в твоём мире.
          </Empty>
        )}
      </div>
      <TemplatePicker open={picker} onClose={() => setPicker(false)} />
    </div>
  )
}
