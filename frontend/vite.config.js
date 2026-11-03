import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Set here, not on the command line: Windows PowerShell drops the `--` in
    // `npm run dev -- --host ...`, and Vite then takes the host as the folder to serve (404s).
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Forward API calls to the FastAPI backend during development.
    // 127.0.0.1 (not localhost): the backend binds to 127.0.0.1 and only accepts the
    // development identity from loopback, which proxied requests are.
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
