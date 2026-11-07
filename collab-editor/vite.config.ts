import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000
  },
  resolve: {
    alias: [
      { find: /^collab-sync$/, replacement: path.resolve(__dirname, "../collab-sync/src/client/ClientSync.ts") },
      { find: /^collab-sync\/(.*)/, replacement: path.resolve(__dirname, "../collab-sync/$1") },
      { find: /^crdt-engine$/, replacement: path.resolve(__dirname, "../crdt-engine/index.ts") },
      { find: /^crdt-engine\/(.*)/, replacement: path.resolve(__dirname, "../crdt-engine/$1") }
    ]
  }
})
