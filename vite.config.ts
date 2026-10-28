import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'

// Homebase rejects `localhost` as an app's CORS host (it needs a dotted domain),
// so dev runs on dev.vidence.co (127.0.0.1 in /etc/hosts) with Guideflow's certs.
const host = 'dev.vidence.co'
const port = 3444
const sslDir = path.resolve(__dirname, '../../../northlight/guideflow/ssl')

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: {
    host,
    port,
    strictPort: true,
    https:
      command === 'serve'
        ? {
            key: fs.readFileSync(path.join(sslDir, 'dev.vidence.co-key.pem')),
            cert: fs.readFileSync(path.join(sslDir, 'dev.vidence.co.pem')),
          }
        : undefined,
    open: `https://${host}:${port}`,
  },
}))
