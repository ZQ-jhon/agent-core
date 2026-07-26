/**
 * E2E test fixture — mounts the A2UI form renderer in a real browser for
 * keyboard regression testing. The `?scenario=` query param selects which
 * test form to render.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { A2UIFormRenderer, type A2UIUploadRequest } from '../../src/a2ui/form-renderer.tsx'
import { createA2UIFormController } from '../../src/a2ui/form-state.ts'
import { parseA2UIFormDocument } from '../../src/a2ui/parser.ts'
import type {
  NormalizedA2UIFormDocumentV1,
} from '../../src/a2ui/types.ts'

declare global {
  interface Window {
    __e2e: {
      controller: ReturnType<typeof createA2UIFormController>
      uploadResolve?: (result: { readonly fileId: string; readonly name?: string; readonly size?: number; readonly mimeType?: string }) => void
      uploadReject?: (error: Error) => void
      uploadProgress?: (percent: number) => void
    }
  }
}

function parseDocument(input: unknown): NormalizedA2UIFormDocumentV1 {
  const result = parseA2UIFormDocument(input)
  if (!result.ok) {
    throw new Error(JSON.stringify(result.errors))
  }
  return result.value
}

function documentWith(
  initialValues: Record<string, unknown>,
  children: readonly unknown[],
  actions: readonly unknown[] = [],
  formProps: Record<string, unknown> = {},
  dataSources: readonly unknown[] = [],
): NormalizedA2UIFormDocumentV1 {
  return parseDocument({
    schemaVersion: '1.0.0',
    requestId: 'request-1',
    formId: 'form-1',
    revision: 1,
    root: { id: 'form-root', type: 'Form', props: formProps, children },
    data: { initialValues },
    actions,
    dataSources,
  })
}

function confirmationDialogForm() {
  const document = documentWith(
    { name: 'Ada' },
    [
      { id: 'name', type: 'TextInput', props: { label: 'Name' }, children: [], dataPath: '/name' },
      {
        id: 'reset',
        type: 'Button',
        props: { label: 'Reset' },
        children: [],
        action: { actionId: 'reset', confirm: { title: 'Discard edits?', message: 'This cannot be undone.' } },
      },
    ],
    [{ id: 'reset', type: 'reset' }],
  )
  const controller = createA2UIFormController(document)
  window.__e2e = { controller }
  return { controller, document }
}

function collapsedSectionForm() {
  const document = documentWith(
    { amount: '' },
    [
      {
        id: 'billing:section',
        type: 'Section',
        props: { title: 'Billing', collapsible: true, defaultCollapsed: true },
        children: [
          {
            id: 'billing:amount',
            type: 'TextInput',
            props: { label: 'Amount' },
            children: [],
            dataPath: '/amount',
            validation: [{ type: 'required' }],
          },
        ],
      },
      { id: 'submit', type: 'Button', props: { label: 'Submit' }, children: [], action: { actionId: 'submit' } },
    ],
    [{ id: 'submit', type: 'submit', endpointKey: 'forms.submit', method: 'POST' }],
  )
  const controller = createA2UIFormController(document, {
    submit: async () => ({ status: 'success', result: { submissionId: 'unused' } }),
  })
  window.__e2e = { controller }
  return { controller, document }
}

function uploadForm() {
  const document = documentWith(
    { files: [] },
    [{ id: 'files', type: 'Upload', props: { label: 'Files', accept: ['image/*'], maxFiles: 2, maxSizeBytes: 1024 * 1024 }, children: [], dataPath: '/files', action: { actionId: 'upload' } }],
    [{ id: 'upload', type: 'upload', endpointKey: 'files.upload', method: 'POST' }],
  )
  const controller = createA2UIFormController(document)

  const uploadBridge = async (request: A2UIUploadRequest) => {
    window.__e2e.uploadProgress = (pct: number) => request.reportProgress(pct)
    return new Promise<{ readonly fileId: string }>((resolve, reject) => {
      window.__e2e.uploadResolve = resolve
      window.__e2e.uploadReject = reject
    })
  }
  window.__e2e = { controller }

  return { controller, document, uploadBridge }
}

function submitOnEnterForm() {
  const submit = async () => ({ status: 'success' as const, result: { submissionId: 'sub' } })
  const document = documentWith(
    { name: '', notes: '', plan: 'free' },
    [
      { id: 'name', type: 'TextInput', props: { label: 'Name' }, children: [], dataPath: '/name' },
      { id: 'notes', type: 'TextArea', props: { label: 'Notes', rows: 2, maxRows: 4 }, children: [], dataPath: '/notes' },
      {
        id: 'plan',
        type: 'Select',
        props: { label: 'Plan', options: [{ label: 'Free', value: 'free' }, { label: 'Pro', value: 'pro' }] },
        children: [],
        dataPath: '/plan',
      },
      { id: 'submit', type: 'Button', props: { label: 'Submit' }, children: [], action: { actionId: 'submit' } },
    ],
    [{ id: 'submit', type: 'submit', endpointKey: 'forms.submit', method: 'POST' }],
    { submitOnEnter: true },
  )
  const controller = createA2UIFormController(document, { submit })
  window.__e2e = { controller }
  return { controller, document }
}

function main() {
  const params = new URLSearchParams(window.location.search)
  const scenario = params.get('scenario') ?? 'confirmation-dialog'

  let result: { controller: ReturnType<typeof createA2UIFormController>; document: NormalizedA2UIFormDocumentV1; uploadBridge?: (request: A2UIUploadRequest) => Promise<{ readonly fileId: string }> }

  switch (scenario) {
    case 'confirmation-dialog':
      result = confirmationDialogForm()
      break
    case 'collapsed-section':
      result = collapsedSectionForm()
      break
    case 'upload':
      result = uploadForm()
      break
    case 'submit-on-enter':
      result = submitOnEnterForm()
      break
    default:
      result = confirmationDialogForm()
  }

  const root = createRoot(document.getElementById('root')!)
  root.render(
    <StrictMode>
      <A2UIFormRenderer
        controller={result.controller}
        document={result.document}
        upload={result.uploadBridge}
      />
    </StrictMode>,
  )
}

main()
