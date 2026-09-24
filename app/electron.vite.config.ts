import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// The dev server injects an inline React Refresh preamble that a strict CSP would block.
const relaxCspInDev: Plugin = {
  name: 'maincraft-relax-csp-in-dev',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
}

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        ...shared,
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react(), relaxCspInDev],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
})
