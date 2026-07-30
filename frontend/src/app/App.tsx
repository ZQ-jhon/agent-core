import { useEffect, useMemo, useState } from 'react'
import {
  A2UIApiError,
  createSubmitTransport,
  isAbortError,
  resolveForm,
} from '../a2ui/api-client.ts'
import { A2UIFormRenderer } from '../a2ui/form-renderer.tsx'
import { createA2UIFormController } from '../a2ui/form-state.ts'
import type { NormalizedA2UIFormDocumentV1 } from '../a2ui/types.ts'
import './app.css'

const DEFAULT_FORM_KEY = 'single-field-update'

type FormLoadState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready'
      readonly document: NormalizedA2UIFormDocumentV1
    }
  | {
      readonly status: 'error'
      readonly code: string
      readonly message: string
    }

export function App() {
  const [attempt, setAttempt] = useState(0)
  const [loadState, setLoadState] = useState<FormLoadState>({
    status: 'loading',
  })

  useEffect(() => {
    const abortController = new AbortController()
    setLoadState({ status: 'loading' })

    void resolveForm(DEFAULT_FORM_KEY, createRequestId(), {
      signal: abortController.signal,
    })
      .then((document) => {
        if (!abortController.signal.aborted) {
          setLoadState({ status: 'ready', document })
        }
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted || isAbortError(error)) {
          return
        }
        if (error instanceof A2UIApiError) {
          setLoadState({
            status: 'error',
            code: error.code,
            message: error.message,
          })
          return
        }
        setLoadState({
          status: 'error',
          code: 'UNEXPECTED_ERROR',
          message: 'The form could not be loaded. Please try again.',
        })
      })

    return () => {
      abortController.abort()
    }
  }, [attempt])

  return (
    <main className="app-shell">
      <p className="app-shell__eyebrow">agent-core / A2UI frontend</p>
      {loadState.status === 'loading' ? <LoadingState /> : null}
      {loadState.status === 'error' ? (
        <ErrorState
          code={loadState.code}
          message={loadState.message}
          onRetry={() => setAttempt((current) => current + 1)}
        />
      ) : null}
      {loadState.status === 'ready' ? (
        <ResolvedForm document={loadState.document} />
      ) : null}
    </main>
  )
}

function LoadingState() {
  return (
    <section
      aria-labelledby="form-loading-title"
      aria-live="polite"
      className="app-shell__state"
      role="status"
    >
      <h1 id="form-loading-title">Loading form</h1>
      <p className="app-shell__summary">
        Connecting to the A2UI form service…
      </p>
    </section>
  )
}

interface ErrorStateProps {
  readonly code: string
  readonly message: string
  readonly onRetry: () => void
}

function ErrorState({ code, message, onRetry }: ErrorStateProps) {
  return (
    <section
      aria-labelledby="form-error-title"
      className="app-shell__state app-shell__state--error"
      role="alert"
    >
      <h1 id="form-error-title">Unable to load form</h1>
      <p className="app-shell__summary">{message}</p>
      <p className="app-shell__error-code">Error code: {code}</p>
      <button className="app-shell__retry" onClick={onRetry} type="button">
        Try again
      </button>
    </section>
  )
}

function ResolvedForm({
  document,
}: {
  readonly document: NormalizedA2UIFormDocumentV1
}) {
  const controller = useMemo(
    () =>
      createA2UIFormController(document, {
        submit: createSubmitTransport(),
      }),
    [document],
  )

  return (
    <section aria-label="Resolved A2UI form" className="app-shell__form">
      <A2UIFormRenderer controller={controller} document={document} />
    </section>
  )
}

let fallbackRequestId = 0

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `resolve-${globalThis.crypto.randomUUID()}`
  }
  fallbackRequestId += 1
  return `resolve-${Date.now().toString(36)}-${fallbackRequestId.toString(36)}`
}
