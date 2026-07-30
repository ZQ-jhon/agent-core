import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  A2UIApiError,
  resolveForm,
} from '../a2ui/api-client.ts'
import { parseA2UIFormDocument } from '../a2ui/parser.ts'
import type { NormalizedA2UIFormDocumentV1 } from '../a2ui/types.ts'
import { App } from './App.tsx'

vi.mock('../a2ui/api-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../a2ui/api-client.ts')>()
  return {
    ...actual,
    resolveForm: vi.fn(),
    createSubmitTransport: vi.fn(() => vi.fn()),
  }
})

const mockResolveForm = vi.mocked(resolveForm)

beforeEach(() => {
  mockResolveForm.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('A2UI application API lifecycle', () => {
  it('renders an accessible loading state while resolve is pending', () => {
    mockResolveForm.mockReturnValue(new Promise(() => undefined))

    render(<App />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading form')
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('renders only a server-resolved and schema-validated form', async () => {
    mockResolveForm.mockResolvedValue(formDocument())

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Update phone number' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Mobile number' }),
    ).toHaveValue('13800138000')
    expect(screen.queryByText('Stage 1 engineering shell')).not.toBeInTheDocument()
  })

  it('shows a structured server error and never renders fallback form data', async () => {
    mockResolveForm.mockRejectedValue(
      new A2UIApiError('INTERNAL_ERROR', 'Form resolution failed.', {
        retryable: true,
        statusCode: 500,
      }),
    )

    render(<App />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Unable to load form')
    expect(alert).toHaveTextContent('Form resolution failed.')
    expect(alert).toHaveTextContent('Error code: INTERNAL_ERROR')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('shows a safe error for an unexpected client failure', async () => {
    mockResolveForm.mockRejectedValue(new Error('sensitive raw detail'))

    render(<App />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'The form could not be loaded. Please try again.',
    )
    expect(alert).not.toHaveTextContent('sensitive raw detail')
    expect(alert).toHaveTextContent('Error code: UNEXPECTED_ERROR')
  })

  it('retries the real resolve request from the explicit error state', async () => {
    mockResolveForm
      .mockRejectedValueOnce(
        new A2UIApiError(
          'NETWORK_ERROR',
          'The form service is unavailable.',
          { retryable: true },
        ),
      )
      .mockResolvedValueOnce(formDocument())

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(
      await screen.findByRole('heading', { name: 'Update phone number' }),
    ).toBeInTheDocument()
    expect(mockResolveForm).toHaveBeenCalledTimes(2)
  })

  it('uses the approved form key, a fresh request id, and a cancellation signal', async () => {
    mockResolveForm.mockResolvedValue(formDocument())

    render(<App />)

    await waitFor(() => expect(mockResolveForm).toHaveBeenCalledOnce())
    expect(mockResolveForm).toHaveBeenCalledWith(
      'single-field-update',
      expect.stringMatching(/^resolve-/),
      { signal: expect.any(AbortSignal) },
    )
  })
})

function formDocument(): NormalizedA2UIFormDocumentV1 {
  const parsed = parseA2UIFormDocument({
    schemaVersion: '1.0.0',
    requestId: 'resolve-1',
    formId: 'single-field-update',
    revision: 1,
    root: {
      id: 'form-root',
      type: 'Form',
      props: { title: 'Update phone number' },
      children: [
        {
          id: 'phone-input',
          type: 'TextInput',
          props: { label: 'Mobile number' },
          children: [],
          dataPath: '/profile/phone',
        },
      ],
    },
    data: {
      initialValues: {
        profile: { phone: '13800138000' },
      },
    },
    actions: [],
  })
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.errors))
  }
  return parsed.value
}
