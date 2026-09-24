import { safeStorage } from 'electron'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

/**
 * The AI key is encrypted with the OS keychain (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Where no keychain exists the key is stored base64-encoded in a
 * user-only file and the UI tells the user so.
 */
export class SecretStore {
  constructor(private readonly file: string) {}

  get encrypted(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  has(): boolean {
    return existsSync(this.file)
  }

  get(): string | null {
    if (!existsSync(this.file)) return null
    try {
      const raw = readFileSync(this.file)
      if (raw.subarray(0, 4).toString() === 'PLN:') return Buffer.from(raw.subarray(4).toString(), 'base64').toString('utf8')
      return safeStorage.decryptString(raw)
    } catch {
      return null
    }
  }

  set(value: string | null): void {
    if (!value) {
      rmSync(this.file, { force: true })
      return
    }
    const data = this.encrypted
      ? safeStorage.encryptString(value)
      : Buffer.from(`PLN:${Buffer.from(value, 'utf8').toString('base64')}`)
    writeFileSync(this.file, data)
    try {
      chmodSync(this.file, 0o600)
    } catch {
      /* not supported on every filesystem */
    }
  }
}
