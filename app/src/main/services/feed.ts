import { EventEmitter } from 'node:events'
import type { FeedItem } from '@shared/types'

const MAX_ITEMS = 600

/** Live timeline of the world: chat, character speech, thoughts, joins and deaths. */
export class FeedService extends EventEmitter<{ item: [FeedItem] }> {
  private items: FeedItem[] = []
  private seq = 0

  push(item: Omit<FeedItem, 'id' | 'ts'> & { ts?: number }): FeedItem {
    const full: FeedItem = { ts: Date.now(), ...item, id: `f${Date.now().toString(36)}${(this.seq++).toString(36)}` }
    this.items.push(full)
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS)
    this.emit('item', full)
    return full
  }

  recent(): FeedItem[] {
    return [...this.items]
  }
}
