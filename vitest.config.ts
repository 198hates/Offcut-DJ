import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    // The real better-sqlite3 addon is built for Electron's ABI (see the
    // postinstall electron-builder install-app-deps), so it can't load under the
    // vitest Node runtime. Back it with Node's built-in node:sqlite for tests
    // only — same SQLite engine, no native build, app build untouched.
    alias: {
      'better-sqlite3': fileURLToPath(new URL('./test/shims/better-sqlite3.ts', import.meta.url)),
    },
  },
})
