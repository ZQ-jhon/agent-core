import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

const resolvePath = resolve
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const base = resolvePath(__dirname, 'dist-e2e')
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' }

createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const file = resolvePath(base, `.${url}`)
  if (!file.startsWith(base) || !existsSync(file)) { res.writeHead(404); res.end(); return }
  try {
    const content = readFileSync(file)
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' })
    res.end(content)
  } catch { res.writeHead(500); res.end() }
}).listen(4173, () => {
  console.log('E2E server ready on http://localhost:4173')
})
