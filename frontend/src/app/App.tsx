import './app.css'

const stageOneBoundaries = [
  'React + TypeScript + Vite engineering shell',
  'Independent development, build, typecheck, and test commands',
  'No Schema runtime, business actions, Upload, Markdown, or API requests',
]

export function App() {
  return (
    <main className="app-shell">
      <p className="app-shell__eyebrow">agent-core / A2UI frontend</p>
      <h1>Stage 1 engineering shell</h1>
      <p className="app-shell__summary">
        The frontend workspace is ready. Runtime and business implementation are
        intentionally deferred to later stages.
      </p>

      <section aria-labelledby="scope-title" className="app-shell__scope">
        <h2 id="scope-title">Delivery boundary</h2>
        <ul>
          {stageOneBoundaries.map((boundary) => (
            <li key={boundary}>{boundary}</li>
          ))}
        </ul>
      </section>
    </main>
  )
}
