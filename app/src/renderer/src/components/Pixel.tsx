// Pixel-art pieces drawn in code: character faces, vitals, and the world horizon.
import { memo, useMemo } from 'react'
import type { Appearance } from '@shared/types'

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amount))
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount))
  const b = Math.max(0, Math.min(255, (n & 255) + amount))
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// 8×8 hair masks. H = hair, S = shirt-coloured hat, - = leave face.
const HAIR_STYLES: string[][] = [
  ['HHHHHHHH', 'HHHHHHHH', 'H------H', '--------', '--------', '--------', '--------', '--------'],
  ['HHHHHHHH', 'HHHHHHHH', 'HHHH---H', 'H-------', '--------', '--------', '--------', '--------'],
  ['HHHHHHHH', 'HH----HH', '--------', '--------', '--------', '--------', '--------', '--------'],
  ['HHHHHHHH', 'HHHHHHHH', 'HH----HH', 'H------H', 'H------H', 'H------H', 'H------H', 'H------H'],
  ['HHHHHHHH', 'H------H', '--------', '--------', '--------', 'H------H', 'HH----HH', 'HHHHHHHH'],
  ['SSSSSSSS', 'SSSSSSSS', 'H------H', '--------', '--------', '--------', '--------', '--------'],
  ['HHHHHHHH', 'HHHHHHHH', 'HH----HH', 'HH----HH', 'H------H', '--------', '--------', '--------'],
  ['---HH---', '--HHHH--', '---HH---', '--------', '--------', '--------', '--------', '--------']
]

export const HAIR_STYLE_COUNT = HAIR_STYLES.length

/** A Minecraft-style 8×8 face built from the character's colours. */
export const PixelFace = memo(function PixelFace({
  appearance,
  size = 48,
  seed = ''
}: {
  appearance: Appearance
  size?: number
  seed?: string
}) {
  const cells = useMemo(() => {
    const { skin, hair, eyes, shirt } = appearance
    const style = HAIR_STYLES[appearance.hairStyle % HAIR_STYLES.length]
    let h = hash(seed + skin + hair)
    const noise = () => {
      h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
      return (h % 100) / 100
    }
    const grid: string[][] = []
    for (let y = 0; y < 8; y++) {
      const row: string[] = []
      for (let x = 0; x < 8; x++) {
        const n = noise()
        let c = n < 0.18 ? shade(skin, -10) : n > 0.9 ? shade(skin, 6) : skin
        if (y === 4 && (x === 1 || x === 6)) c = '#f4f1ea'
        if (y === 4 && (x === 2 || x === 5)) c = eyes
        if (y === 5 && (x === 3 || x === 4)) c = shade(skin, -28)
        if (y === 6 && x >= 2 && x <= 5) c = shade(skin, -46)
        if (y === 7) c = shade(skin, -14)
        const mask = style[y][x]
        if (mask === 'H') c = n < 0.25 ? shade(hair, -18) : n > 0.85 ? shade(hair, 14) : hair
        if (mask === 'S') c = y === 1 ? shade(shirt, -22) : shirt
        row.push(c)
      }
      grid.push(row)
    }
    return grid
  }, [appearance, seed])

  return (
    <svg className="pixel-face pixelated" width={size} height={size} viewBox="0 0 8 8" aria-hidden>
      {cells.flatMap((row, y) => row.map((fill, x) => <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />))}
    </svg>
  )
})

// ---- vitals ------------------------------------------------------------------------------

const HEART = ['.oo...oo.', 'orro.orro', 'orwrorrro', 'orrrrrrro', '.orrrrro.', '..orrro..', '...oro...', '....o....']
const FOOD = ['.....oo..', '....owwo.', '....owo..', '..oobro..', '.obbbbo..', 'obbbbbo..', 'obbbbo...', 'obbbo....', '.ooo.....']

type SpriteState = 'full' | 'half' | 'empty'

function Sprite({ rows, palette, state }: { rows: string[]; palette: Record<string, string>; state: SpriteState }) {
  const width = rows[0].length
  return (
    <svg className="pixelated" width={width * 2} height={rows.length * 2} viewBox={`0 0 ${width} ${rows.length}`} aria-hidden>
      {rows.flatMap((row, y) =>
        [...row].map((ch, x) => {
          if (ch === '.') return null
          let fill = palette[ch]
          const emptyHalf = state === 'empty' || (state === 'half' && x >= Math.ceil(width / 2))
          if (emptyHalf && ch !== 'o') fill = palette.e
          return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />
        })
      )}
    </svg>
  )
}

const HEART_PALETTE = { o: '#2a0c0c', r: '#e03a31', w: '#ffb3a8', e: '#3a2b2b' }
const FOOD_PALETTE = { o: '#2b1a0c', b: '#b8662b', r: '#8a4418', w: '#efe6d2', e: '#3a3027' }

function row(value: number, max = 20): SpriteState[] {
  const v = Math.max(0, Math.min(max, Math.round(value)))
  return Array.from({ length: max / 2 }, (_, i) => (v >= (i + 1) * 2 ? 'full' : v === i * 2 + 1 ? 'half' : 'empty'))
}

export function Hearts({ value }: { value: number }) {
  return (
    <span className="vitals" title={`Здоровье: ${Math.round(value)} / 20`}>
      {row(value).map((s, i) => (
        <Sprite key={i} rows={HEART} palette={HEART_PALETTE} state={s} />
      ))}
    </span>
  )
}

export function Hunger({ value }: { value: number }) {
  return (
    <span className="vitals" title={`Сытость: ${Math.round(value)} / 20`}>
      {row(value).map((s, i) => (
        <Sprite key={i} rows={FOOD} palette={FOOD_PALETTE} state={s} />
      ))}
    </span>
  )
}

// ---- horizon -----------------------------------------------------------------------------

export type SceneMood = 'night' | 'dawn' | 'day' | 'dusk' | 'night-lit'

const SKIES: Record<SceneMood, { bands: string[]; ground: string; grass: string; dirt: string; tree: string; leaf: string; body: 'moon' | 'sun' | 'none'; stars: boolean; windows: boolean }> = {
  night: { bands: ['#0b0f16', '#0d121b', '#101722', '#131b28'], ground: '#0c0e0f', grass: '#1f3325', dirt: '#1b1512', tree: '#15110d', leaf: '#16281b', body: 'moon', stars: true, windows: false },
  'night-lit': { bands: ['#0b0f16', '#0d121b', '#101722', '#16192a'], ground: '#0c0e0f', grass: '#20382a', dirt: '#1d1714', tree: '#17120e', leaf: '#182c1e', body: 'moon', stars: true, windows: true },
  dawn: { bands: ['#141a26', '#2a2632', '#5a3a36', '#a8603a'], ground: '#121212', grass: '#2d4a2c', dirt: '#2a1f18', tree: '#1f1812', leaf: '#23391f', body: 'sun', stars: false, windows: true },
  day: { bands: ['#3d6a96', '#5582ad', '#7aa2c4', '#a7c3d8'], ground: '#1a1a1a', grass: '#4f8a3b', dirt: '#6b4a2f', tree: '#5a3d22', leaf: '#3e7a34', body: 'sun', stars: false, windows: false },
  dusk: { bands: ['#1c2438', '#3f3346', '#8a4d3c', '#d88a44'], ground: '#141212', grass: '#3a5a2e', dirt: '#3d2a1d', tree: '#2a1d14', leaf: '#2e4a26', body: 'sun', stars: false, windows: true }
}

/** Blocky horizon for the home hero; mood follows the real in-game time. */
export const PixelScene = memo(function PixelScene({ mood, seed = 7, height = 64, width = 240 }: { mood: SceneMood; seed?: number; height?: number; width?: number }) {
  const W = width
  const H = Math.max(64, height)
  const base = H - 20 // average ground level
  const sky = SKIES[mood]
  const terrain = useMemo(() => {
    let h = seed * 9301 + 49297
    const rnd = () => {
      h = (h * 9301 + 49297) % 233280
      return h / 233280
    }
    const cols: number[] = []
    let y = base
    for (let x = 0; x < W; x += 4) {
      y += Math.round((rnd() - 0.5) * 3) * 2
      y = Math.max(base - 8, Math.min(base + 8, y))
      cols.push(y)
    }
    const trees: Array<{ x: number; y: number; h: number }> = []
    const house = Math.round(cols.length * 0.64)
    for (let i = 3; i < cols.length - 3; i += 5 + Math.floor(rnd() * 5)) {
      if (i > house - 4 && i < house + 6) continue
      trees.push({ x: i * 4, y: cols[i], h: 8 + Math.floor(rnd() * 3) * 2 })
    }
    const stars = Array.from({ length: Math.round(34 * (H / 64)) }, () => ({ x: Math.floor(rnd() * W), y: Math.floor(rnd() * (base - 16)), big: rnd() > 0.88 }))
    return { cols, trees, stars, house }
  }, [seed, base, H, W])

  const bandH = (base - 4) / sky.bands.length
  const skyTop = base - 4 - bandH * sky.bands.length
  const houseCol = terrain.house
  const houseY = terrain.cols[houseCol]
  const sunX = Math.round(W * (mood === 'day' ? 0.75 : 0.62))
  const sunY = mood === 'day' ? Math.round(base * 0.2) : Math.round(base * 0.55)
  return (
    <svg className="pixel-scene pixelated" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" aria-hidden>
      <rect x={0} y={0} width={W} height={H} fill={sky.bands[0]} />
      {sky.bands.map((c, i) => (
        <rect key={c + i} x={0} y={Math.round(skyTop + i * bandH)} width={W} height={H} fill={c} />
      ))}
      {/* dithered seams between sky bands */}
      {sky.bands.slice(1).map((c, i) => {
        const y = Math.round(skyTop + (i + 1) * bandH)
        return Array.from({ length: W / 2 }, (_, k) => <rect key={`d${i}-${k}`} x={k * 2 + (i % 2)} y={y - 1} width={1} height={1} fill={c} />)
      })}
      {sky.stars && terrain.stars.map((s, i) => <rect key={`s${i}`} x={s.x} y={s.y} width={s.big ? 2 : 1} height={s.big ? 2 : 1} fill="#e8e3d6" opacity={s.big ? 0.8 : 0.45} />)}
      {sky.body === 'moon' && (
        <g>
          <rect x={Math.round(W * 0.78)} y={Math.round(base * 0.18)} width={10} height={10} fill="#e9e4d3" />
          <rect x={Math.round(W * 0.78) + 2} y={Math.round(base * 0.18) + 2} width={2} height={2} fill="#c9c3b1" />
          <rect x={Math.round(W * 0.78) + 6} y={Math.round(base * 0.18) + 6} width={2} height={2} fill="#c9c3b1" />
        </g>
      )}
      {sky.body === 'sun' && (
        <g>
          <rect x={sunX} y={sunY} width={12} height={12} fill="#ffd27a" />
          <rect x={sunX + 2} y={sunY + 2} width={8} height={8} fill="#fff0c2" />
        </g>
      )}
      {terrain.cols.map((y, i) => (
        <g key={`c${i}`}>
          <rect x={i * 4} y={y} width={4} height={H - y} fill={sky.dirt} />
          <rect x={i * 4} y={y} width={4} height={2} fill={sky.grass} />
          <rect x={i * 4} y={Math.max(y + 10, H - 4)} width={4} height={H} fill={sky.ground} />
        </g>
      ))}
      {terrain.trees.map((t, i) => (
        <g key={`t${i}`}>
          <rect x={t.x + 1} y={t.y - t.h + 4} width={2} height={t.h - 4} fill={sky.tree} />
          <rect x={t.x - 3} y={t.y - t.h - 2} width={10} height={6} fill={sky.leaf} />
          <rect x={t.x - 1} y={t.y - t.h - 5} width={6} height={3} fill={sky.leaf} />
        </g>
      ))}
      <g>
        <rect x={houseCol * 4 - 2} y={houseY - 10} width={16} height={10} fill={sky.tree} />
        <rect x={houseCol * 4 - 4} y={houseY - 13} width={20} height={3} fill={sky.dirt} />
        <rect x={houseCol * 4 + 1} y={houseY - 8} width={3} height={3} fill={sky.windows ? '#ffc46e' : '#0e0f10'} />
        <rect x={houseCol * 4 + 8} y={houseY - 6} width={3} height={6} fill="#0e0f10" />
        {sky.windows && <rect x={houseCol * 4} y={houseY - 9} width={5} height={5} fill="#ffc46e" opacity={0.18} />}
      </g>
    </svg>
  )
})
