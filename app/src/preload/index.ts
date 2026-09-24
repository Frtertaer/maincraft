import { contextBridge, ipcRenderer } from 'electron'
import type { MaincraftApi, MaincraftEvents } from '../shared/types'

type Envelope = { ok: true; value: unknown } | { ok: false; error: string }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(`mc:${channel}`, ...args)) as Envelope
  if (!res.ok) throw new Error(res.error)
  return res.value as T
}

const api: MaincraftApi = {
  app: {
    info: () => call('app.info'),
    openFolder: (which) => call('app.openFolder', which),
    openExternal: (url) => call('app.openExternal', url)
  },
  settings: {
    get: () => call('settings.get'),
    update: (patch) => call('settings.update', patch),
    setApiKey: (key) => call('settings.setApiKey', key),
    testAi: (draft) => call('settings.testAi', draft)
  },
  characters: {
    list: () => call('characters.list'),
    save: (c) => call('characters.save', c),
    remove: (id) => call('characters.remove', id)
  },
  commands: {
    list: () => call('commands.list'),
    save: (c) => call('commands.save', c),
    remove: (id) => call('commands.remove', id)
  },
  runtime: {
    state: () => call('runtime.state'),
    install: () => call('runtime.install')
  },
  server: {
    status: () => call('server.status'),
    start: () => call('server.start'),
    stop: () => call('server.stop'),
    restart: () => call('server.restart'),
    send: (command) => call('server.send', command),
    logs: () => call('server.logs'),
    backup: () => call('server.backup'),
    resetWorld: () => call('server.resetWorld')
  },
  bots: {
    statuses: () => call('bots.statuses'),
    start: (id) => call('bots.start', id),
    stop: (id) => call('bots.stop', id),
    say: (id, text) => call('bots.say', id, text),
    command: (id, text) => call('bots.command', id, text),
    logs: (id) => call('bots.logs', id)
  },
  feed: {
    recent: () => call('feed.recent')
  },
  voice: {
    list: () => call('voice.list'),
    preview: (voice, rate, pitch, text) => call('voice.preview', voice, rate, pitch, text)
  },
  on(event, listener) {
    const handler = (_: unknown, name: keyof MaincraftEvents, payload: unknown) => {
      if (name === event) listener(payload as never)
    }
    ipcRenderer.on('mc:event', handler)
    return () => ipcRenderer.off('mc:event', handler)
  }
}

contextBridge.exposeInMainWorld('maincraft', api)
