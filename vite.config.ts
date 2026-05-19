
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    // The precaching service worker left clients (especially iOS Safari)
    // serving a stale/mixed cache after deploys — a cached index.html pointing
    // at JS chunks that no longer exist, which blanks the whole app.
    // selfDestroying emits a service worker that unregisters itself and clears
    // every cache, removing the PWA from all clients that already installed it.
    VitePWA({
      selfDestroying: true,
      registerType: 'autoUpdate',
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  optimizeDeps: {
    include: ['epubjs'],
  },
})
