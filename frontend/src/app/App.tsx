import { useEffect, useState } from 'react'
import {
  A2UIFormRenderer,
  createA2UIFormController,
  createSubmitTransport,
  parseA2UIFormDocument,
  resolveForm,
  type A2UIFormController,
  type NormalizedA2UIFormDocumentV1,
} from '../a2ui/index.ts'
import './app.css'

const DEFAULT_FORM_KEY = 'single-field-update'

type LoadState =
  | { readonly stage: 'loading' }
  | {
      readonly stage: 'error'
      readonly message: string
      readonly retryable: boolean
    }
  | {
      readonly stage: 'schema_error'
      readonly message: string
    }
  | {
      readonly stage: 'ready'
      readonly controller: A2UIFormController
      readonly document: NormalizedA2UIFormDocumentV1
    }

export function App() {
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<LoadState>({ stage: 'loading' })

  useEffect(() => {
    let active = true
    const abortController = new AbortController()

    async function loadForm(): Promise<void> {
      setStatus({ stage: 'loading' })
      const result = await resolveForm(
        DEFAULT_FORM_KEY,
        `resolve-${Date.now()}`,
        abortController.signal,
      )
      if (!active) {
        return
      }

      if (!result.ok) {
        setStatus({
          stage: 'error',
          message: result.errors.map((error) => error.message).join(' ')
            || 'Failed to load the form.',
          retryable: result.errors.some((error) => error.retryable),
        })
        return
      }

      const parsed = parseA2UIFormDocument(result.document)
      if (!parsed.ok) {
        setStatus({
          stage: 'schema_error',
          message: parsed.errors.map((error) => error.message).join(' ')
            || 'The form definition is invalid.',
        })
        return
      }

      setStatus({
        stage: 'ready',
        controller: createA2UIFormController(parsed.value, {
          submit: createSubmitTransport(),
        }),
        document: parsed.value,
      })
    }

    void loadForm()
    return () => {
      active = false
      abortController.abort()
    }
  }, [attempt])

  return (
    <main className="app-shell">
      <p className="app-shell__eyebrow">agent-core / A2UI frontend</p>
      <LoadContent
        onRetry={() => setAttempt((current) => current + 1)}
        status={status}
      />
    </main>
  )
}

function LoadContent({
  onRetry,
  status,
}: {
  readonly onRetry: () => void
  readonly status: LoadState
}) {
  switch (status.stage) {
    case 'loading':
      return (
        <section
          aria-busy="true"
          aria-label="Loading form"
          className="app-shell__status"
          role="status"
        >
          <h1>Loading form…</h1>
          <p>The form is being fetched from the server. Please wait.</p>
        </section>
      )
    case 'error':
      return (
        <section className="app-shell__status app-shell__status--error" role="alert">
          <h1>Unable to load the form</h1>
          <p>{status.message}</p>
          {status.retryable ? (
            <button onClick={onRetry} type="button">Retry</button>
          ) : null}
        </section>
      )
    case 'schema_error':
      return (
        <section className="app-shell__status app-shell__status--error" role="alert">
          <h1>Form definition error</h1>
          <p>{status.message}</p>
        </section>
      )
    case 'ready':
      return (
        <A2UIFormRenderer
          controller={status.controller}
          document={status.document}
          onRenderDiagnostic={(diagnostic) => {
            console.error('A2UI render diagnostic:', diagnostic)
          }}
        />
      )
  }
}
