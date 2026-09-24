import type { MaincraftApi } from '../shared/types'

declare global {
  interface Window {
    maincraft: MaincraftApi
  }
}

export {}
