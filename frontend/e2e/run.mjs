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

  // Start the preview server (no shell wrapper — direct node process)
  const server = spawn(process.execPath, [resolvePath(__dirname, 'serve.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] })

  // Buffer server stderr and capture early failures
  const stderrChunks = []
  server.stderr.on('data', (chunk) => stderrChunks.push(chunk))

  let serverReady = false
  let serverExited = false

  server.on('exit', (code) => {
    serverExited = true
    if (code !== 0 && code !== null) {
      stderrChunks.forEach((c) => process.stderr.write(c))
    }
  })

  // Wait for server to signal ready — fail if it exits or times out
  const serverTimeoutMs = 10000
  await new Promise((ok, fail) => {
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('ready')) {
        serverReady = true
        ok()
      }
    })
    server.on('exit', (code) => {
      if (!serverReady) fail(new Error(`E2E server exited with code ${code} before ready`))
    })
    setTimeout(() => {
      if (!serverReady) fail(new Error(`E2E server did not become ready within ${serverTimeoutMs}ms`))
    }, serverTimeoutMs)
  })

  // Run Playwright — preserve its actual exit code
  let playwrightCode = 0
  try {
    await exec('pnpm', ['exec', 'playwright', 'test'], { env: { ...process.env, CI: 'true' } })
  } catch (err) {
    playwrightCode = 1
  } finally {
    // Kill the server process tree and wait for port release
    try { process.kill(server.pid, 'SIGTERM') } catch {}
    await new Promise((ok) => {
      if (server.killed) return ok()
      server.on('close', ok)
      setTimeout(() => {
        try { process.kill(server.pid, 'SIGKILL') } catch {}
        ok()
      }, 3000)
    })
    if (playwrightCode !== 0) process.exit(playwrightCode)
  }
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})
