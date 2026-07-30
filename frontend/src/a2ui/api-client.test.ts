import { describe, expect, it, vi } from 'vitest'
import {
  A2UIApiError,
  createSubmitTransport,
  fetchSubmission,
  isAbortError,
  resolveForm,
  type A2UIFetch,
} from './api-client.ts'
import type { FormSubmitRequest } from './form-state.ts'

const resolvedDocument = {
  schemaVersion: '1.0.0',
  requestId: 'resolve-1',
  formId: 'single-field-update',
  revision: 1,
  root: {
    id: 'form-root',
    type: 'Form',
    props: { title: 'Update profile' },
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
  data: { initialValues: { profile: { phone: '13800138000' } } },
  actions: [],
}

const submitRequest: FormSubmitRequest = {
  schemaVersion: '1.0.0',
  requestId: 'submit-1',
  idempotencyKey: 'idem-1',
  formId: 'single-field-update',
  revision: 1,
  action: {
    actionId: 'submit-single-field',
    sourceComponentId: 'single-field-submit',
  },
  data: { profile: { phone: '13800138000' } },
}

describe('A2UI API client', () => {
  it('resolves a form through the exact relative v1 route and capability envelope', async () => {
    const fetcher = mockFetch(resolvedDocument)

    const document = await resolveForm('single-field-update', 'resolve-1', {
      fetch: fetcher,
    })

    expect(document.formId).toBe('single-field-update')
    expect(document.dataSources).toEqual([])
    expect(document.rules).toEqual([])
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/a2ui/v1/forms:resolve')

    const init = fetcher.mock.calls[0]?.[1]
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
    })
    const body = JSON.parse(String(init?.body)) as {
      readonly schemaVersion: string
      readonly requestId: string
      readonly formKey: string
      readonly client: {
        readonly supportedSchemaVersions: readonly string[]
        readonly supportedComponents: readonly string[]
      }
    }
    expect(body).toMatchObject({
      schemaVersion: '1.0.0',
      requestId: 'resolve-1',
      formKey: 'single-field-update',
      client: { supportedSchemaVersions: ['1.0.0'] },
    })
    expect(body.client.supportedComponents).toEqual(
      expect.arrayContaining(['Form', 'Section', 'TextInput', 'Button']),
    )
  })

  it('forwards trusted locale, time zone, and cancellation context', async () => {
    const fetcher = mockFetch(resolvedDocument)
    const abortController = new AbortController()

    await resolveForm('single-field-update', 'resolve-1', {
      fetch: fetcher,
      signal: abortController.signal,
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
    })

    const init = fetcher.mock.calls[0]?.[1]
    const body = JSON.parse(String(init?.body)) as {
      readonly client: Record<string, unknown>
    }
    expect(init?.signal).toBe(abortController.signal)
    expect(body.client).toMatchObject({
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
    })
  })

  it('surfaces a structured resolve error without substituting a document', async () => {
    const fetcher = mockFetch(
      {
        schemaVersion: '1.0.0',
        requestId: 'resolve-1',
        formKey: 'single-field-update',
        status: 'error',
        errors: [
          {
            code: 'INTERNAL_ERROR',
            message: 'Form resolution failed.',
            retryable: true,
          },
        ],
      },
      500,
    )

    await expect(
      resolveForm('single-field-update', 'resolve-1', { fetch: fetcher }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Form resolution failed.',
      retryable: true,
      statusCode: 500,
    })
  })

  it('turns a network failure into a retryable explicit error', async () => {
    const fetcher = vi
      .fn<A2UIFetch>()
      .mockRejectedValue(new TypeError('socket closed'))

    await expect(
      resolveForm('single-field-update', 'resolve-1', { fetch: fetcher }),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
    })
  })

  it('rejects malformed JSON from a successful resolve response', async () => {
    const fetcher = mockFetch('{not-json', 200, true)

    await expect(
      resolveForm('single-field-update', 'resolve-1', { fetch: fetcher }),
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('rejects a resolve response with the wrong correlation id', async () => {
    const fetcher = mockFetch({
      ...resolvedDocument,
      requestId: 'different-request',
    })

    await expect(
      resolveForm('single-field-update', 'resolve-1', { fetch: fetcher }),
    ).rejects.toMatchObject({ code: 'RESPONSE_CORRELATION_INVALID' })
  })

  it('submits through the form-scoped relative route and maps success', async () => {
    const fetcher = mockFetch({
      schemaVersion: '1.0.0',
      requestId: 'submit-1',
      formId: 'single-field-update',
      status: 'success',
      result: { submissionId: 'submission-1', message: 'Saved' },
    })

    const response = await createSubmitTransport({ fetch: fetcher })(
      submitRequest,
    )

    expect(response).toEqual({
      status: 'success',
      result: { submissionId: 'submission-1', message: 'Saved' },
    })
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      '/api/a2ui/v1/forms/single-field-update/submissions',
    )
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(
      submitRequest,
    )
  })

  it('maps server field errors into the controller response shape', async () => {
    const fetcher = mockFetch(
      {
        schemaVersion: '1.0.0',
        requestId: 'submit-1',
        formId: 'single-field-update',
        status: 'validation_error',
        fieldErrors: {
          '/profile/phone': [
            {
              code: 'PATTERN_MISMATCH',
              message: 'Invalid phone number.',
              componentId: 'phone-input',
            },
          ],
        },
        errors: [],
      },
      422,
    )

    await expect(
      createSubmitTransport({ fetch: fetcher })(submitRequest),
    ).resolves.toEqual({
      status: 'validation_error',
      fieldErrors: {
        '/profile/phone': [
          {
            code: 'PATTERN_MISMATCH',
            message: 'Invalid phone number.',
            componentId: 'phone-input',
            retryable: false,
          },
        ],
      },
      errors: [],
    })
  })

  it('returns structured general submission errors to the controller', async () => {
    const fetcher = mockFetch(
      {
        schemaVersion: '1.0.0',
        requestId: 'submit-1',
        formId: 'single-field-update',
        status: 'error',
        errors: [
          {
            code: 'FORM_REVISION_CONFLICT',
            message: 'The form revision changed.',
            retryable: false,
          },
        ],
      },
      409,
    )

    await expect(
      createSubmitTransport({ fetch: fetcher })(submitRequest),
    ).resolves.toEqual({
      status: 'error',
      errors: [
        {
          code: 'FORM_REVISION_CONFLICT',
          message: 'The form revision changed.',
          retryable: false,
        },
      ],
    })
  })

  it('rejects a malformed successful submission envelope', async () => {
    const fetcher = mockFetch({ status: 'success', result: {} })

    await expect(
      createSubmitTransport({ fetch: fetcher })(submitRequest),
    ).rejects.toMatchObject({ code: 'RESPONSE_INVALID' })
  })

  it('does not hide a submission network failure', async () => {
    const fetcher = vi
      .fn<A2UIFetch>()
      .mockRejectedValue(new TypeError('offline'))

    await expect(
      createSubmitTransport({ fetch: fetcher })(submitRequest),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true })
  })

  it('reads and validates an owner-visible persisted submission', async () => {
    const fetcher = mockFetch({
      submissionId: 'submission/id',
      formId: 'single-field-update',
      revision: 1,
      action: {
        actionId: 'submit-single-field',
        sourceComponentId: 'single-field-submit',
      },
      data: { profile: { phone: '13800138000' } },
      status: 'completed',
      auditId: 'audit-1',
      createdAt: '2026-07-31T00:00:00Z',
      updatedAt: '2026-07-31T00:00:00Z',
    })

    const record = await fetchSubmission('submission/id', { fetch: fetcher })

    expect(record.status).toBe('completed')
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      '/api/a2ui/v1/submissions/submission%2Fid',
    )
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    })
  })

  it('surfaces a structured submission-read failure', async () => {
    const fetcher = mockFetch(
      {
        schemaVersion: '1.0.0',
        requestId: 'unknown',
        formId: 'unknown',
        status: 'error',
        errors: [
          {
            code: 'SUBMISSION_NOT_FOUND',
            message: 'The submission was not found.',
            retryable: false,
          },
        ],
      },
      404,
    )

    await expect(
      fetchSubmission('missing', { fetch: fetcher }),
    ).rejects.toMatchObject({
      code: 'SUBMISSION_NOT_FOUND',
      statusCode: 404,
    })
  })

  it('rejects an invalid successful submission record', async () => {
    const fetcher = mockFetch({
      submissionId: 'submission-1',
      status: 'completed',
    })

    await expect(
      fetchSubmission('submission-1', { fetch: fetcher }),
    ).rejects.toMatchObject({ code: 'RESPONSE_INVALID' })
  })

  it('preserves abort errors so callers can ignore cancelled work', async () => {
    const abortError = new DOMException('cancelled', 'AbortError')
    const fetcher = vi.fn<A2UIFetch>().mockRejectedValue(abortError)

    await expect(
      resolveForm('single-field-update', 'resolve-1', { fetch: fetcher }),
    ).rejects.toBe(abortError)
    expect(isAbortError(abortError)).toBe(true)
    expect(isAbortError(new A2UIApiError('OTHER', 'Other error'))).toBe(false)
  })
})

function mockFetch(
  body: unknown,
  status = 200,
  bodyIsSource = false,
) {
  const source = bodyIsSource ? String(body) : JSON.stringify(body)
  return vi.fn<A2UIFetch>().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(source),
  } as unknown as Response)
}
