import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import yauzl from 'yauzl'
import * as tar from 'tar'
import type { AppPaths } from '../paths'
import type { InstallProgress, InstallStage, RuntimeState } from '@shared/types'
import { downloadFile, fetchJson, USER_AGENT } from './net'

const execFileAsync = promisify(execFile)

interface AdoptiumAsset {
  release_name: string
  version: { semver: string; openjdk_version: string }
  binary: { package: { link: string; checksum: string; size: number; name: string } }
}

interface PaperBuild {
  id: number
  channel: string
  downloads: Record<string, { name: string; url: string; size: number; checksums: { sha256: string } }>
}

interface JavaMarker {
  javaPath: string
  release: string
}

interface PaperMarker {
  version: string
  build: number
  sha256: string
}

function osName(): string {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function archName(): string {
  return process.arch === 'arm64' ? 'aarch64' : 'x64'
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Zip extraction that refuses absolute paths, "..", and symlinks (unlike extract-zip). */
function extractZip(zipFile: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('zip open failed'))
      zip.on('error', reject)
      zip.on('end', () => resolve())
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/')
        const dest = normalize(join(target, name))
        if (isAbsolute(name) || !isInside(target, dest)) return reject(new Error(`unsafe path in archive: ${name}`))
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if (mode === 0o120000) return reject(new Error(`symlink in archive refused: ${name}`))
        if (name.endsWith('/')) {
          mkdirSync(dest, { recursive: true })
          zip.readEntry()
          return
        }
        mkdirSync(dirname(dest), { recursive: true })
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('zip read failed'))
          pipeline(stream, createWriteStream(dest))
            .then(() => zip.readEntry())
            .catch(reject)
        })
      })
      zip.readEntry()
    })
  })
}

function findJavaBinary(dir: string): string | null {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java'
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()!
    for (const candidate of [join(current, 'bin', exe), join(current, 'Contents', 'Home', 'bin', exe)]) {
      if (existsSync(candidate)) return candidate
    }
    if (relative(dir, current).split(sep).length > 3) continue
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(current, entry.name))
    }
  }
  return null
}

export class RuntimeManager extends EventEmitter {
  private installing = false

  constructor(
    private readonly paths: AppPaths,
    private readonly minecraftVersion: () => string
  ) {
    super()
  }

  get javaMarker(): string {
    return join(this.paths.java, 'current.json')
  }

  get paperMarker(): string {
    return join(this.paths.server, 'paper-build.json')
  }

  get paperJar(): string {
    return join(this.paths.server, 'paper.jar')
  }

  javaPath(): string | null {
    try {
      const marker = JSON.parse(readFileSync(this.javaMarker, 'utf8')) as JavaMarker
      return existsSync(marker.javaPath) ? marker.javaPath : null
    } catch {
      return null
    }
  }

  private readPaper(): PaperMarker | null {
    try {
      const marker = JSON.parse(readFileSync(this.paperMarker, 'utf8')) as PaperMarker
      return existsSync(this.paperJar) ? marker : null
    } catch {
      return null
    }
  }

  async state(): Promise<RuntimeState> {
    let javaVersion: string | null = null
    try {
      javaVersion = (JSON.parse(readFileSync(this.javaMarker, 'utf8')) as JavaMarker).release
    } catch {
      /* not installed */
    }
    const paper = this.readPaper()
    const wanted = this.minecraftVersion()
    return {
      javaReady: Boolean(this.javaPath()),
      javaVersion,
      paperReady: Boolean(paper && paper.version === wanted),
      paperBuild: paper?.build ?? null,
      paperVersion: paper?.version ?? null,
      worldExists: existsSync(join(this.paths.server, 'world', 'level.dat')),
      installing: this.installing
    }
  }

  private progress(stage: InstallStage, phase: InstallProgress['phase'], message: string, received = 0, total = 0): void {
    const payload: InstallProgress = { stage, phase, message, received, total }
    this.emit('progress', payload)
  }

  async install(): Promise<RuntimeState> {
    if (this.installing) return this.state()
    this.installing = true
    this.emit('state', await this.state())
    let stage: InstallStage = 'java'
    try {
      if (!this.javaPath()) await this.installJava()
      else this.progress('java', 'done', 'Java уже установлена')
      stage = 'paper'
      const current = this.readPaper()
      if (!current || current.version !== this.minecraftVersion()) await this.installPaper()
      else this.progress('paper', 'done', `Сервер Paper ${current.version} уже на месте`)
    } catch (err) {
      this.progress(stage, 'error', err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      this.installing = false
      this.emit('state', await this.state())
    }
    return this.state()
  }

  private async installJava(): Promise<void> {
    this.progress('java', 'resolve', 'Ищу подходящую Java 21…')
    const url =
      `https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=${archName()}` +
      `&image_type=jre&os=${osName()}&vendor=eclipse`
    const assets = await fetchJson<AdoptiumAsset[]>(url)
    const asset = assets.find((a) => a.binary?.package?.link)
    if (!asset) throw new Error('Не нашлось сборки Java для этой системы')
    const pkg = asset.binary.package
    if (!/^https:\/\//.test(pkg.link) || !/^[a-f0-9]{64}$/i.test(pkg.checksum)) throw new Error('Некорректный ответ Adoptium')

    const archive = join(this.paths.downloads, pkg.name)
    await downloadFile(pkg.link, archive, {
      sha256: pkg.checksum,
      size: pkg.size,
      onProgress: (r, t) => this.progress('java', 'download', 'Скачиваю Java 21', r, t)
    })

    this.progress('java', 'extract', 'Распаковываю Java…')
    const target = join(this.paths.java, asset.release_name.replace(/[^\w.+-]/g, '_'))
    const staging = `${target}.staging`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    if (pkg.name.endsWith('.zip')) await extractZip(archive, staging)
    else await tar.x({ file: archive, cwd: staging, strict: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    rmSync(archive, { force: true })

    const javaPath = findJavaBinary(target)
    if (!javaPath) throw new Error('В архиве Java не нашлось исполняемого файла')
    const { stderr } = await execFileAsync(javaPath, ['-version'], { timeout: 20000, windowsHide: true })
    if (!/version "21/.test(stderr)) throw new Error('Установленная Java не запускается')

    const marker: JavaMarker = { javaPath, release: asset.version.openjdk_version || asset.release_name }
    writeFileSync(this.javaMarker, JSON.stringify(marker, null, 2))
    this.progress('java', 'done', `Java ${marker.release} готова`)
  }

  private async installPaper(): Promise<void> {
    const version = this.minecraftVersion()
    this.progress('paper', 'resolve', `Ищу сервер Paper для Minecraft ${version}…`)
    const builds = await fetchJson<PaperBuild[]>(
      `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`,
      { headers: { 'user-agent': USER_AGENT } }
    )
    const build = builds
      .filter((b) => b.channel === 'STABLE' && b.downloads?.['server:default'])
      .sort((a, b) => b.id - a.id)[0]
    if (!build) throw new Error(`Для Minecraft ${version} нет стабильной сборки Paper`)
    const file = build.downloads['server:default']
    if (!/^https:\/\//.test(file.url) || !/^[a-f0-9]{64}$/i.test(file.checksums.sha256)) {
      throw new Error('Некорректный ответ PaperMC')
    }
    await downloadFile(file.url, this.paperJar, {
      sha256: file.checksums.sha256,
      size: file.size,
      onProgress: (r, t) => this.progress('paper', 'download', `Скачиваю сервер Paper ${version} (сборка ${build.id})`, r, t)
    })
    const marker: PaperMarker = { version, build: build.id, sha256: file.checksums.sha256 }
    writeFileSync(this.paperMarker, JSON.stringify(marker, null, 2))
    this.progress('paper', 'done', `Paper ${version} #${build.id} готов`)
  }
}
