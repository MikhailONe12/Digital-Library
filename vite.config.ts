
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { cpSync } from 'node:fs'

export default defineConfig({
  plugins: [
    react(),
    // The precaching service worker left clients (especially iOS Safari)
    // serving a stale/mixed cache after deploys. selfDestroying emits a
    // service worker that unregisters itself and clears every cache.
    VitePWA({
      selfDestroying: true,
      registerType: 'autoUpdate',
    }),
    {
      // pdf.js v5 decodes scanned-page images (JBIG2 / JPEG2000) with
      // WebAssembly. Ship pdf.js's wasm folder so getDocument({ wasmUrl })
      // can load the decoders — without it scanned pages render blank.
      name: 'copy-pdfjs-wasm',
      closeBundle() {
        cpSync('node_modules/pdfjs-dist/wasm', 'dist/wasm', { recursive: true })
      },
    },
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
