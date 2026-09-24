// Renders the pixel-art app icon to PNG without any image library.
// node scripts/make-icon.mjs  ->  build/icon.png (512) and resources/icon.png (256)
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const PALETTE = {
  '.': null,
  O: [31, 20, 7],
  T: [255, 196, 110],
  A: [242, 165, 58],
  D: [168, 100, 26],
  E: [31, 20, 7],
  W: [255, 244, 220],
  M: [140, 78, 18]
}

const GRID = [
  '................',
  '.OOOOOOOOOOOOOO.',
  '.OTTTTTTTTTTTTO.',
  '.OTTTTTTTTTTTTO.',
  '.OAAAAAAAAAAAAO.',
  '.OAAAAAAAAAAAAO.',
  '.OAEWEAAAAEWEAO.',
  '.OAEEEAAAAEEEAO.',
  '.OAAAAAAAAAAAAO.',
  '.OAAAAAAAAAAAAO.',
  '.OAAAAMMMMAAAAO.',
  '.OAAAAAAAAAAAAO.',
  '.ODDDDDDDDDDDDO.',
  '.ODDDDDDDDDDDDO.',
  '.OOOOOOOOOOOOOO.',
  '................'
]

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function render(size) {
  const scale = size / GRID.length
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const color = PALETTE[GRID[Math.floor(y / scale)][Math.floor(x / scale)]]
      const i = y * (size * 4 + 1) + 1 + x * 4
      if (color) {
        raw[i] = color[0]
        raw[i + 1] = color[1]
        raw[i + 2] = color[2]
        raw[i + 3] = 255
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

for (const [file, size] of [
  ['build/icon.png', 512],
  ['resources/icon.png', 256]
]) {
  const target = join(root, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, render(size))
  console.log('wrote', file)
}
