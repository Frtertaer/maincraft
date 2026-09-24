import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs'

/**
 * Tiny JSON persistence with atomic writes. A corrupted file is kept aside as *.broken
 * so a bad write never silently wipes the user's characters.
 */
export class JsonStore<T> {
  private value: T

  constructor(
    private readonly file: string,
    private readonly fallback: () => T,
    private readonly migrate: (raw: unknown) => T = (raw) => raw as T
  ) {
    this.value = this.load()
  }

  private load(): T {
    if (!existsSync(this.file)) return this.fallback()
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^﻿/, ''))
      return this.migrate(raw)
    } catch {
      try {
        copyFileSync(this.file, `${this.file}.broken`)
      } catch {
        /* best effort */
      }
      return this.fallback()
    }
  }

  get(): T {
    return this.value
  }

  set(next: T): T {
    this.value = next
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, this.file)
    return next
  }

  update(fn: (current: T) => T): T {
    return this.set(fn(this.value))
  }
}
