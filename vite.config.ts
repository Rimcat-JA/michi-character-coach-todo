import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), VitePWA({ registerType: 'autoUpdate', manifest: { name: 'michi — キャラクターコーチToDo', short_name: 'michi', description: '端末内で正式保存するToDo', theme_color: '#7662df', background_color: '#f7f7fb', display: 'standalone', start_url: '/', icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }, workbox: { globPatterns: ['**/*.{js,css,html,svg,png}'] } })],
})
