// Prepares the Minecraft agent for packaging: a clean production install in
// app/.agent-bundle with game data trimmed to the Minecraft versions the app runs.
//
//   node scripts/bundle-agent.mjs            (keeps 1.21.1)
//   KEEP_MC_VERSIONS=1.21.1,1.21.4 node scripts/bundle-agent.mjs
import { execSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(app, '..', 'agent')
const target = join(app, '.agent-bundle')
const keep = (process.env.KEEP_MC_VERSIONS || '1.21.1').split(',').map((v) => v.trim()).filter(Boolean)

function size(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    total += entry.isDirectory() ? size(p) : statSync(p).size
  }
  return total
}

rmSync(target, { recursive: true, force: true })
for (const item of ['package.json', 'package-lock.json', 'src']) {
  cpSync(join(source, item), join(target, item), { recursive: true })
}
for (const devOnly of ['selftest.js', 'combat-bench.js', 'boss-bench.js', 'vision-smoke.js']) {
  rmSync(join(target, 'src', devOnly), { force: true })
}

console.log('installing agent dependencies (production)…')
execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: target, stdio: 'inherit' })

const modules = join(target, 'node_modules')

// minecraft-data: every version is a lazy getter, so unused versions can go.
const mcData = join(modules, 'minecraft-data', 'minecraft-data', 'data')
const dataPaths = JSON.parse(readFileSync(join(mcData, 'dataPaths.json'), 'utf8'))
const needed = new Set(['pc/common'])
for (const version of keep) {
  const entry = dataPaths.pc[version]
  if (!entry) throw new Error(`minecraft-data has no pc/${version}`)
  for (const dir of Object.values(entry)) needed.add(dir)
}
// index.js eagerly requires {pc,bedrock}/common/*, so "common" stays for both editions.
for (const dir of readdirSync(join(mcData, 'bedrock'))) {
  if (dir !== 'common') rmSync(join(mcData, 'bedrock', dir), { recursive: true, force: true })
}
for (const dir of readdirSync(join(mcData, 'pc'))) {
  if (!needed.has(`pc/${dir}`)) rmSync(join(mcData, 'pc', dir), { recursive: true, force: true })
}

// prismarine-viewer ships textures and block states for every version it supports.
const viewerRequire = join(modules, 'prismarine-viewer', 'viewer', 'lib', 'version.js')
const { getVersion } = await import(pathToFileURL(viewerRequire).href).then((m) => m.default ?? m)
const viewerKeep = new Set(keep.map((v) => getVersion(v)).filter(Boolean))
for (const folder of ['textures', 'blocksStates']) {
  const dir = join(modules, 'prismarine-viewer', 'public', folder)
  if (!existsSync(dir)) continue
  for (const entry of readdirSync(dir)) {
    const version = entry.replace(/\.(png|json)$/, '')
    if (!viewerKeep.has(version)) rmSync(join(dir, entry), { recursive: true, force: true })
  }
}

// Smoke test: the trimmed bundle must still load the agent and the game data it needs.
const smoke = `
  const mcData = (await import('minecraft-data')).default
  for (const v of ${JSON.stringify(keep)}) {
    const d = mcData(v)
    if (!d?.blocksByName?.oak_log || !d.itemsByName?.bread || !d.recipes) throw new Error('minecraft-data broken for ' + v)
  }
  await import('mineflayer')
  for (const m of ['config', 'actions', 'brain', 'world', 'commands', 'local-viewer', 'app-bridge', 'vision-render']) await import('./src/' + m + '.js')
  console.log('bundle smoke test passed')
`
const smokeFile = join(target, 'bundle-smoke.mjs')
writeFileSync(smokeFile, smoke)
try {
  execSync('node bundle-smoke.mjs', { cwd: target, stdio: 'inherit' })
} finally {
  rmSync(smokeFile, { force: true })
}

console.log(`agent bundle ready: ${(size(target) / 1024 / 1024).toFixed(0)} MB (Minecraft ${keep.join(', ')}; viewer ${[...viewerKeep].join(', ')})`)
