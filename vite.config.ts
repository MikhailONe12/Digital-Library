
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
    rollupOptions: {
      output: {
        // Emit .mjs assets (the pdf.js worker) as .js. Browsers reject a .mjs
        // module unless the server sends a JS MIME type, and renaming also
        // produces a fresh URL that bypasses any stale cached copy.
        assetFileNames: (assetInfo) => {
          const name = assetInfo.names?.[0] ?? assetInfo.name ?? ''
          return name.endsWith('.mjs')
            ? 'assets/[name]-[hash].js'
            : 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
  optimizeDeps: {
    include: ['epubjs'],
  },
})
