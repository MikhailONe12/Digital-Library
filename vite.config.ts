
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /\/api\/state$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'api-state',
              expiration: { maxAgeSeconds: 60 * 60 },
            },
          },
          {
            urlPattern: /\/content\/.*\.(jpg|jpeg|png|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'covers',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      manifest: {
        name: 'OptionsData Digital Library',
        short_name: 'Library',
        description: 'Digital library of OptionsData',
        theme_color: '#dc2626',
        background_color: '#f8fafc',
        display: 'standalone',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon.svg',     sizes: 'any',     type: 'image/svg+xml' },
        ],
      },
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
