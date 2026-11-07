import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@crdt-engine': path.resolve(__dirname, '../crdt-engine/src'),
      '@collab-sync': path.resolve(__dirname, '../collab-sync'),
    },
  },
})
