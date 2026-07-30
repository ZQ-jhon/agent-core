import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'

const validDocument = {
  schemaVersion: '1.0.0',
  requestId: 'resolve-001',
  formId: 'single-field-update',
  revision: 1,
  root: {
    id: 'profile-form',
    type: 'Form',
    props: { title: 'Update profile' },
    children: [
      {
        id: 'phone',
        type: 'TextInput',
        props: { label: 'Phone' },
        children: [],
        dataPath: '/profile/phone',
      },
      {
        id: 'submit',
        type: 'Button',
        props: { label: 'Save' },
        children: [],
        action: { actionId: 'submit-profile' },
      },
    ],
  },
  data: {
    initialValues: {
      profile: {
        phone: '13800138000',
      },
    },
  },
  actions: [
    {
      id: 'submit-profile',
      type: 'submit',
      endpointKey: 'forms.submit',
      method: 'POST',
    },
  ],
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('A2UI application API lifecycle', () => {
  it('renders a loading state while the real resolve request is pending', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<App />)

    expect(
      screen.getByRole('heading', { name: 'Loading form…' }),
    ).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/a2ui/v1/forms:resolve',
      expect.objectContaining({ method: 'POST' }),
    )
    view.unmount()
  })

  it('parses and renders a form returned by the backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(validDocument))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(await screen.findByRole('textbox', { name: 'Phone' })).toHaveValue('13800138000')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('shows the backend contract error without rendering a fallback form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      schemaVersion: '1.0.0',
      requestId: 'resolve-404',
      formKey: 'single-field-update',
      status: 'error',
      errors: [
        {
          code: 'FORM_NOT_FOUND',
          message: 'The requested form was not found.',
          retryable: false,
        },
      ],
    }, 404)))

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Unable to load the form' })).toBeInTheDocument()
    expect(screen.getByText('The requested form was not found.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('shows an explicit retryable state when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Unable to load the form' })).toBeInTheDocument()
    expect(screen.getByText('Unable to reach the server. Check your connection.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('rejects a successful response that violates the frozen schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...validDocument,
      schemaVersion: '1.1.0',
    })))

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Form definition error' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('retries the real API request without falling back to local data', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: 'error',
        errors: [
          {
            code: 'INTERNAL_ERROR',
            message: 'The service is temporarily unavailable.',
            retryable: true,
          },
        ],
      }, 503))
      .mockResolvedValueOnce(jsonResponse(validDocument))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('textbox', { name: 'Phone' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}
