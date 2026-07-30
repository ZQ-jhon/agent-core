import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormSubmitRequest } from './form-state.ts'
import {
  createSubmitTransport,
  fetchSubmission,
  resolveForm,
} from './api-client.ts'
import { supportedComponentTypes } from './registry.ts'

const resolvedDocument = {
  schemaVersion: '1.0.0',
  requestId: 'resolve-001',
  formId: 'single-field-update',
  revision: 1,
}

const submitRequest: FormSubmitRequest = {
  schemaVersion: '1.0.0',
  requestId: 'submit-001',
  idempotencyKey: 'idem-001',
  formId: 'single-field:update',
  revision: 1,
  action: {
    actionId: 'submit-single-field',
    sourceComponentId: 'single-field-submit',
  },
  data: {
    profile: {
      phone: '13800138000',
    },
  },
}

const persistedSubmission = {
  submissionId: 'submission-001',
  formId: 'single-field-update',
  revision: 1,
  action: {
    actionId: 'submit-single-field',
    sourceComponentId: 'single-field-submit',
  },
  data: {
    profile: {
      phone: '13800138000',
    },
  },
  status: 'completed',
  auditId: 'audit-001',
  createdAt: '2026-07-31T00:00:00Z',
  updatedAt: '2026-07-31T00:00:00Z',
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveForm', () => {
  it('posts the complete frozen v1 resolve envelope to the relative endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(resolvedDocument))

    const result = await resolveForm('single-field-update', 'resolve-001')

    expect(result).toEqual({ ok: true, document: resolvedDocument })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/a2ui/v1/forms:resolve')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: '1.0.0',
      requestId: 'resolve-001',
      formKey: 'single-field-update',
      client: {
        supportedSchemaVersions: ['1.0.0'],
        supportedComponents: [...supportedComponentTypes],
      },
    })
  })

  it('preserves a contract error envelope from the backend', async () => {
    const errors = [
      {
        code: 'FORM_NOT_FOUND',
        message: 'The requested form was not found.',
        retryable: false,
      },
    ]
    fetchMock.mockResolvedValue(jsonResponse({ status: 'error', errors }, 404))

    await expect(resolveForm('missing-form', 'resolve-404')).resolves.toEqual({
      ok: false,
      errors,
    })
  })

  it('uses a stable HTTP error when a failed response is not a contract envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'upstream unavailable' }, 503))

    await expect(resolveForm('single-field-update', 'resolve-503')).resolves.toEqual({
      ok: false,
      errors: [
        {
          code: 'HTTP_ERROR',
          message: 'Server returned 503.',
          retryable: true,
        },
      ],
    })
  })

  it('turns a network rejection into a visible retryable error', async () => {
    fetchMock.mockRejectedValue(new TypeError('network unavailable'))

    await expect(resolveForm('single-field-update', 'resolve-network')).resolves.toEqual({
      ok: false,
      errors: [
        {
          code: 'NETWORK_ERROR',
          message: 'Unable to reach the server. Check your connection.',
          retryable: true,
        },
      ],
    })
  })

  it('does not accept invalid JSON from a successful response', async () => {
    fetchMock.mockResolvedValue(invalidJsonResponse(200))

    await expect(resolveForm('single-field-update', 'resolve-invalid-json')).resolves.toEqual({
      ok: false,
      errors: [
        {
          code: 'INVALID_RESPONSE',
          message: 'Server returned an invalid A2UI response.',
          retryable: false,
        },
      ],
    })
  })
})

describe('createSubmitTransport', () => {
  it('posts the controller request to the encoded form submission path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      schemaVersion: '1.0.0',
      requestId: 'submit-001',
      formId: 'single-field:update',
      status: 'success',
      result: { submissionId: 'submission-001' },
    }))

    const result = await createSubmitTransport()(submitRequest)

    expect(result).toEqual({
      status: 'success',
      result: { submissionId: 'submission-001' },
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/a2ui/v1/forms/single-field%3Aupdate/submissions')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitRequest),
    })
  })

  it('returns server field validation without the HTTP envelope fields', async () => {
    const fieldErrors = {
      '/profile/phone': [
        {
          code: 'PATTERN_MISMATCH',
          message: 'Enter a valid phone number.',
        },
      ],
    }
    fetchMock.mockResolvedValue(jsonResponse({
      schemaVersion: '1.0.0',
      requestId: 'submit-invalid',
      formId: 'single-field:update',
      status: 'validation_error',
      fieldErrors,
      errors: [],
    }, 422))

    await expect(createSubmitTransport()(submitRequest)).resolves.toEqual({
      status: 'validation_error',
      fieldErrors,
      errors: [],
    })
  })

  it('preserves a general submit error from a non-2xx response', async () => {
    const errors = [
      {
        code: 'FORM_REVISION_CONFLICT',
        message: 'The form revision is stale.',
        retryable: false,
      },
    ]
    fetchMock.mockResolvedValue(jsonResponse({
      schemaVersion: '1.0.0',
      requestId: 'submit-001',
      formId: 'single-field:update',
      status: 'error',
      errors,
    }, 409))

    await expect(createSubmitTransport()(submitRequest)).resolves.toEqual({
      status: 'error',
      errors,
    })
  })

  it('uses a stable HTTP error for a non-contract failed response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'not found' }, 404))

    await expect(createSubmitTransport()(submitRequest)).resolves.toEqual({
      status: 'error',
      errors: [
        {
          code: 'HTTP_ERROR',
          message: 'Server returned 404.',
          retryable: false,
        },
      ],
    })
  })

  it('returns a retryable error when the backend is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))

    await expect(createSubmitTransport()(submitRequest)).resolves.toEqual({
      status: 'error',
      errors: [
        {
          code: 'NETWORK_ERROR',
          message: 'Unable to reach the server. Check your connection.',
          retryable: true,
        },
      ],
    })
  })

  it('does not pass malformed successful JSON to the form controller', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'success' }))

    await expect(createSubmitTransport()(submitRequest)).resolves.toEqual({
      status: 'error',
      errors: [
        {
          code: 'INVALID_RESPONSE',
          message: 'Server returned an invalid A2UI response.',
          retryable: false,
        },
      ],
    })
  })
})

describe('fetchSubmission', () => {
  it('reads a persisted submission from the relative owner-visible endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse(persistedSubmission))

    const result = await fetchSubmission('submission:001')

    expect(result).toEqual({ ok: true, submission: persistedSubmission })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/a2ui/v1/submissions/submission%3A001',
      { method: 'GET' },
    )
  })

  it('preserves a submission read error envelope', async () => {
    const errors = [
      {
        code: 'SUBMISSION_NOT_FOUND',
        message: 'The submission was not found.',
        retryable: false,
      },
    ]
    fetchMock.mockResolvedValue(jsonResponse({ status: 'error', errors }, 404))

    await expect(fetchSubmission('missing-submission')).resolves.toEqual({
      ok: false,
      errors,
    })
  })

  it('rejects a malformed successful submission response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      submissionId: 'submission-001',
      status: 'completed',
    }))

    await expect(fetchSubmission('submission-001')).resolves.toEqual({
      ok: false,
      errors: [
        {
          code: 'INVALID_RESPONSE',
          message: 'Server returned an invalid A2UI response.',
          retryable: false,
        },
      ],
    })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}

function invalidJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockRejectedValue(new SyntaxError('invalid JSON')),
  } as unknown as Response
}
