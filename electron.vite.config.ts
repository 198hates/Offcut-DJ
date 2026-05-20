import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Compile the beat-analysis worker as a separate CJS bundle alongside the main bundle.
function beatWorkerPlugin(): Plugin {
  return {
    name: 'beat-analysis-worker',
    async closeBundle() {
      const { build } = await import('esbuild')
      await build({
        entryPoints: ['src/main/workers/beat-analysis-worker.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: 'out/main/beat-analysis-worker.js',
        external: [
          'onnxruntime-node',
          'ffmpeg-static',
          'electron',
          'better-sqlite3',
          'better-sqlite3-multiple-ciphers',
        ],
        // Mirror tsconfig.node paths
        tsconfig: resolve('tsconfig.node.json'),
      })
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), beatWorkerPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
