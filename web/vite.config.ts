import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The built bundle is served by `toklume web` from web/dist.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // `pnpm --dir web dev` proxies the API to a running `toklume web`.
    proxy: {
      '/api': 'http://127.0.0.1:4477',
    },
  },
})
