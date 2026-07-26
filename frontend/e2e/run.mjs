import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

function exec(cmd, args, opts) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts })
    child.on('close', (code) => {
      if (code === 0) ok()
      else fail(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}

async function main() {
  // Build the e2e fixture
  await exec('pnpm', ['exec', 'vite', 'build', '--config', 'e2e/vite.config.e2e.ts'])

  // Start the preview server
  const server = spawn('node', [resolvePath(__dirname, 'serve.mjs')], { stdio: 'pipe', shell: true })
  server.stderr.pipe(process.stderr)

  // Wait for server to be ready
  await new Promise((ok) => {
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('ready')) ok()
    })
    setTimeout(ok, 5000)
  })

  // Run Playwright
  try {
    await exec('pnpm', ['exec', 'playwright', 'test'], { env: { ...process.env, CI: 'true' } })
  } finally {
    server.kill()
    process.exit(0)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
