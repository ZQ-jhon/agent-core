import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// E2E-only Vite config — self-contained, never included in production builds.
// Root is the parent (frontend project) dir so imports resolve correctly.
export default defineConfig({
  root: resolve(__dirname, '..'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist-e2e'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        fixture: resolve(__dirname, 'fixtures/fixture.html'),
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
})
