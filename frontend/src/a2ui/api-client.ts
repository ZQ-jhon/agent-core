import type {
  FormServerError,
  FormSubmitRequest,
  FormSubmitResponse,
  FormSubmitTransport,
} from './form-state.ts'
import { parseA2UIJson } from './parser.ts'
import { supportedComponentTypes } from './registry.ts'
import {
  A2UI_FORM_SCHEMA_VERSION,
  type JsonValue,
  type NormalizedA2UIFormDocumentV1,
} from './types.ts'

const FORM_RESOLVE_PATH = '/api/a2ui/v1/forms:resolve'
const FORM_SUBMISSIONS_PATH = '/api/a2ui/v1/forms'
const SUBMISSIONS_PATH = '/api/a2ui/v1/submissions'

export type A2UIFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export interface ResolveFormOptions {
  readonly fetch?: A2UIFetch
  readonly signal?: AbortSignal
  readonly locale?: string
  readonly timeZone?: string
}

export interface SubmitTransportOptions {
  readonly fetch?: A2UIFetch
}

export interface FetchSubmissionOptions {
  readonly fetch?: A2UIFetch
  readonly signal?: AbortSignal
}

export interface SubmissionRecord {
  readonly submissionId: string
  readonly formId: string
  readonly revision: number
  readonly action: {
    readonly actionId: string
    readonly sourceComponentId: string
  }
  readonly data: Readonly<Record<string, JsonValue>>
  readonly status: 'completed'
  readonly auditId: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface A2UIApiErrorOptions {
  readonly statusCode?: number
  readonly retryable?: boolean
  readonly cause?: unknown
}

export class A2UIApiError extends Error {
  readonly code: string
  readonly statusCode?: number
  readonly retryable: boolean

  constructor(
    code: string,
    message: string,
    options: A2UIApiErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'A2UIApiError'
    this.code = code
    this.statusCode = options.statusCode
    this.retryable = options.retryable ?? false
  }
}

/**
 * Resolve a form through the frozen A2UI Form Profile v1 endpoint.
 *
 * The successful response is not trusted until it passes the existing schema
 * parser. Every production URL stays same-origin; callers may inject fetch only
 * for tests or trusted host adapters.
 */
export async function resolveForm(
  formKey: string,
  requestId: string,
  options: ResolveFormOptions = {},
): Promise<NormalizedA2UIFormDocumentV1> {
  const client = {
    supportedSchemaVersions: [A2UI_FORM_SCHEMA_VERSION],
    supportedComponents: supportedComponentTypes,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  }
  const { response, source } = await fetchText(
    resolveFetch(options.fetch),
    FORM_RESOLVE_PATH,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        schemaVersion: A2UI_FORM_SCHEMA_VERSION,
        requestId,
        formKey,
        client,
      }),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: options.signal,
    },
  )

  if (!response.ok) {
    throw httpError(
      source,
      response.status,
      'FORM_RESOLVE_FAILED',
      'Unable to load the requested form',
    )
  }

  const parsed = parseA2UIJson(source)
  if (!parsed.ok) {
    throw new A2UIApiError(
      'SCHEMA_INVALID',
      'The form service returned a document that this client cannot render.',
    )
  }
  if (parsed.value.requestId !== requestId) {
    throw new A2UIApiError(
      'RESPONSE_CORRELATION_INVALID',
      'The form service returned a response with an invalid request correlation.',
    )
  }
  return parsed.value
}

/**
 * Build the trusted transport consumed by the existing form controller.
 *
 * Structured server failures are returned to the controller so it can render
 * field and form errors. Network or malformed responses reject and are mapped
 * by the controller to its explicit retryable error state.
 */
export function createSubmitTransport(
  options: SubmitTransportOptions = {},
): FormSubmitTransport {
  const fetcher = resolveFetch(options.fetch)

  return async (request: FormSubmitRequest): Promise<FormSubmitResponse> => {
    const formId = encodeURIComponent(request.formId)
    const { response, source } = await fetchText(
      fetcher,
      `${FORM_SUBMISSIONS_PATH}/${formId}/submissions`,
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(request),
        cache: 'no-store',
        credentials: 'same-origin',
      },
    )
    const value = parseJson(source)
    const parsed = parseSubmitResponse(value, request.formId)

    if (parsed === undefined) {
      if (!response.ok) {
        throw httpError(
          source,
          response.status,
          'FORM_SUBMIT_FAILED',
          'Unable to submit the form',
        )
      }
      throw new A2UIApiError(
        'RESPONSE_INVALID',
        'The form service returned an invalid submission response.',
      )
    }
    if (!response.ok && parsed.status === 'success') {
      throw new A2UIApiError(
        'RESPONSE_INVALID',
        'The form service returned an inconsistent submission response.',
        { statusCode: response.status },
      )
    }
    return parsed
  }
}

/** Read an owner-visible persisted submission through the frozen v1 route. */
export async function fetchSubmission(
  submissionId: string,
  options: FetchSubmissionOptions = {},
): Promise<SubmissionRecord> {
  const { response, source } = await fetchText(
    resolveFetch(options.fetch),
    `${SUBMISSIONS_PATH}/${encodeURIComponent(submissionId)}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      signal: options.signal,
    },
  )

  if (!response.ok) {
    throw httpError(
      source,
      response.status,
      'SUBMISSION_READ_FAILED',
      'Unable to load the submission',
    )
  }

  const record = parseSubmissionRecord(parseJson(source))
  if (record === undefined) {
    throw new A2UIApiError(
      'RESPONSE_INVALID',
      'The form service returned an invalid submission record.',
    )
  }
  return record
}

export function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'AbortError'
  )
}

function jsonHeaders(): Readonly<Record<string, string>> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

function resolveFetch(fetcher: A2UIFetch | undefined): A2UIFetch {
  if (fetcher !== undefined) {
    return fetcher
  }
  if (typeof globalThis.fetch !== 'function') {
    throw new A2UIApiError(
      'NETWORK_UNAVAILABLE',
      'This browser cannot connect to the form service.',
      { retryable: true },
    )
  }
  return globalThis.fetch.bind(globalThis)
}

async function fetchText(
  fetcher: A2UIFetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<{ readonly response: Response; readonly source: string }> {
  try {
    const response = await fetcher(input, init)
    return { response, source: await response.text() }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new A2UIApiError(
      'NETWORK_ERROR',
      'The form service is unavailable. Check your connection and try again.',
      { retryable: true, cause: error },
    )
  }
}

function httpError(
  source: string,
  statusCode: number,
  fallbackCode: string,
  fallbackMessage: string,
): A2UIApiError {
  const value = parseJson(source)
  if (isRecord(value) && value.status === 'error') {
    const errors = parseGeneralErrors(value.errors)
    const first = errors?.[0]
    if (first !== undefined) {
      return new A2UIApiError(first.code, first.message, {
        statusCode,
        retryable: first.retryable,
      })
    }
  }
  return new A2UIApiError(
    fallbackCode,
    `${fallbackMessage} (HTTP ${statusCode}).`,
    {
      statusCode,
      retryable: statusCode === 408 || statusCode === 429 || statusCode >= 500,
    },
  )
}

function parseSubmitResponse(
  value: unknown,
  expectedFormId: string,
): FormSubmitResponse | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== A2UI_FORM_SCHEMA_VERSION ||
    typeof value.requestId !== 'string' ||
    value.formId !== expectedFormId
  ) {
    return undefined
  }

  if (value.status === 'success') {
    if (!isRecord(value.result) || typeof value.result.submissionId !== 'string') {
      return undefined
    }
    if (
      value.result.message !== undefined &&
      typeof value.result.message !== 'string'
    ) {
      return undefined
    }
    return {
      status: 'success',
      result: {
        submissionId: value.result.submissionId,
        ...(value.result.message === undefined
          ? {}
          : { message: value.result.message }),
      },
    }
  }

  if (value.status === 'validation_error') {
    const fieldErrors = parseFieldErrors(value.fieldErrors)
    if (fieldErrors === undefined) {
      return undefined
    }
    const errors =
      value.errors === undefined || value.errors === null
        ? undefined
        : parseGeneralErrors(value.errors, true)
    if (
      value.errors !== undefined &&
      value.errors !== null &&
      errors === undefined
    ) {
      return undefined
    }
    return {
      status: 'validation_error',
      fieldErrors,
      ...(errors === undefined ? {} : { errors }),
    }
  }

  if (value.status === 'error') {
    const errors = parseGeneralErrors(value.errors)
    return errors === undefined ? undefined : { status: 'error', errors }
  }

  return undefined
}

function parseGeneralErrors(
  value: unknown,
  allowEmpty = false,
): readonly FormServerError[] | undefined {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0)
  ) {
    return undefined
  }
  const errors: FormServerError[] = []
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.code !== 'string' ||
      typeof item.message !== 'string' ||
      typeof item.retryable !== 'boolean'
    ) {
      return undefined
    }
    if (
      item.componentId !== undefined &&
      typeof item.componentId !== 'string'
    ) {
      return undefined
    }
    errors.push({
      code: item.code,
      message: item.message,
      retryable: item.retryable,
      ...(item.componentId === undefined
        ? {}
        : { componentId: item.componentId }),
    })
  }
  return errors
}

function parseFieldErrors(
  value: unknown,
): Readonly<Record<string, readonly FormServerError[]>> | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return undefined
  }
  const fieldErrors: Record<string, readonly FormServerError[]> = {}
  for (const [path, items] of Object.entries(value)) {
    if (!path.startsWith('/') || !Array.isArray(items) || items.length === 0) {
      return undefined
    }
    const errors: FormServerError[] = []
    for (const item of items) {
      if (
        !isRecord(item) ||
        typeof item.code !== 'string' ||
        typeof item.message !== 'string'
      ) {
        return undefined
      }
      if (
        item.componentId !== undefined &&
        typeof item.componentId !== 'string'
      ) {
        return undefined
      }
      errors.push({
        code: item.code,
        message: item.message,
        retryable: false,
        ...(item.componentId === undefined
          ? {}
          : { componentId: item.componentId }),
      })
    }
    fieldErrors[path] = errors
  }
  return fieldErrors
}

function parseSubmissionRecord(value: unknown): SubmissionRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value.submissionId !== 'string' ||
    typeof value.formId !== 'string' ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !isRecord(value.action) ||
    typeof value.action.actionId !== 'string' ||
    typeof value.action.sourceComponentId !== 'string' ||
    !isRecord(value.data) ||
    !isJsonValue(value.data) ||
    value.status !== 'completed' ||
    typeof value.auditId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return undefined
  }
  return {
    submissionId: value.submissionId,
    formId: value.formId,
    revision: value.revision as number,
    action: {
      actionId: value.action.actionId,
      sourceComponentId: value.action.sourceComponentId,
    },
    data: value.data,
    status: 'completed',
    auditId: value.auditId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function parseJson(source: string): unknown {
  if (source.length === 0) {
    return undefined
  }
  try {
    return JSON.parse(source) as unknown
  } catch {
    return undefined
  }
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (depth >= 100) {
    return false
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1))
  }
  if (!isRecord(value)) {
    return false
  }
  return Object.values(value).every((item) => isJsonValue(item, depth + 1))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
