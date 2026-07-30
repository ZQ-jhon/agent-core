import type {
  FormSubmitResponse,
  FormSubmitTransport,
  FormSubmitValidationErrorResponse,
  FormServerFieldError,
} from './form-state.ts'
import { supportedComponentTypes } from './registry.ts'
import {
  A2UI_FORM_SCHEMA_VERSION,
  type JsonValue,
} from './types.ts'

const RESOLVE_PATH = '/api/a2ui/v1/forms:resolve'
const SUBMISSIONS_PATH = '/api/a2ui/v1/submissions'

export interface A2UIApiError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export type ResolveFormResult =
  | { readonly ok: true; readonly document: unknown }
  | { readonly ok: false; readonly errors: readonly A2UIApiError[] }

export interface PersistedSubmission {
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

export type FetchSubmissionResult =
  | { readonly ok: true; readonly submission: PersistedSubmission }
  | { readonly ok: false; readonly errors: readonly A2UIApiError[] }

/**
 * Resolve one form through the frozen v1 endpoint.
 *
 * The returned document intentionally remains unknown until the existing
 * strict parser validates it at the application boundary.
 */
export async function resolveForm(
  formKey: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<ResolveFormResult> {
  const request = {
    schemaVersion: A2UI_FORM_SCHEMA_VERSION,
    requestId,
    formKey,
    client: {
      supportedSchemaVersions: [A2UI_FORM_SCHEMA_VERSION],
      supportedComponents: [...supportedComponentTypes],
    },
  }

  const response = await requestJson(
    RESOLVE_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    },
  )

  if (!response.ok) {
    return response
  }
  if (!response.response.ok) {
    return {
      ok: false,
      errors: readContractErrors(response.body) ?? [httpError(response.response.status)],
    }
  }
  if (response.body === undefined) {
    return {
      ok: false,
      errors: [invalidResponseError(response.response.status)],
    }
  }
  return { ok: true, document: response.body }
}

/** Create the host-owned submit transport consumed by the form controller. */
export function createSubmitTransport(): FormSubmitTransport {
  return async (request) => {
    const response = await requestJson(
      `/api/a2ui/v1/forms/${encodeURIComponent(request.formId)}/submissions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    )

    if (!response.ok) {
      return submitError(response.errors)
    }

    const contractResponse = readSubmitResponse(response.body)
    if (
      contractResponse !== undefined
      && (
        response.response.ok
        || contractResponse.status === 'validation_error'
        || contractResponse.status === 'error'
      )
    ) {
      return contractResponse
    }

    return submitError([
      response.response.ok
        ? invalidResponseError(response.response.status)
        : httpError(response.response.status),
    ])
  }
}

/** Read an owner-visible persisted submission through the frozen v1 route. */
export async function fetchSubmission(
  submissionId: string,
  signal?: AbortSignal,
): Promise<FetchSubmissionResult> {
  const response = await requestJson(
    `${SUBMISSIONS_PATH}/${encodeURIComponent(submissionId)}`,
    {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    },
  )

  if (!response.ok) {
    return response
  }
  if (!response.response.ok) {
    return {
      ok: false,
      errors: readContractErrors(response.body) ?? [httpError(response.response.status)],
    }
  }
  if (!isPersistedSubmission(response.body)) {
    return {
      ok: false,
      errors: [invalidResponseError(response.response.status)],
    }
  }
  return { ok: true, submission: response.body }
}

type JsonRequestResult =
  | {
      readonly ok: true
      readonly response: Response
      readonly body: unknown
    }
  | {
      readonly ok: false
      readonly errors: readonly A2UIApiError[]
    }

async function requestJson(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<JsonRequestResult> {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: 'NETWORK_ERROR',
          message: 'Unable to reach the server. Check your connection.',
          retryable: true,
        },
      ],
    }
  }

  try {
    return { ok: true, response, body: await response.json() as unknown }
  } catch {
    return { ok: true, response, body: undefined }
  }
}

function readSubmitResponse(value: unknown): FormSubmitResponse | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  if (
    value.status === 'success'
    && isRecord(value.result)
    && typeof value.result.submissionId === 'string'
    && (value.result.message === undefined || typeof value.result.message === 'string')
  ) {
    return {
      status: 'success',
      result: {
        submissionId: value.result.submissionId,
        ...(typeof value.result.message === 'string' ? { message: value.result.message } : {}),
      },
    }
  }

  if (value.status === 'validation_error') {
    const fieldErrors = readFieldErrors(value.fieldErrors)
    const errors = value.errors === undefined ? undefined : readApiErrors(value.errors, true)
    if (fieldErrors === undefined || (value.errors !== undefined && errors === undefined)) {
      return undefined
    }
    return {
      status: 'validation_error',
      fieldErrors,
      ...(errors === undefined ? {} : { errors }),
    }
  }

  if (value.status === 'error') {
    const errors = readApiErrors(value.errors, false)
    if (errors === undefined) {
      return undefined
    }
    return {
      status: 'error',
      errors,
    }
  }

  return undefined
}

function readContractErrors(value: unknown): readonly A2UIApiError[] | undefined {
  if (!isRecord(value) || value.status !== 'error') {
    return undefined
  }
  return readApiErrors(value.errors, false)
}

function readApiErrors(
  value: unknown,
  allowEmpty: boolean,
): readonly A2UIApiError[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return undefined
  }
  const errors = value.filter(isApiError)
  return errors.length === value.length ? errors : undefined
}

function readFieldErrors(
  value: unknown,
): FormSubmitValidationErrorResponse['fieldErrors'] | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return undefined
  }

  const fieldErrors: Record<string, readonly FormServerFieldError[]> = {}
  for (const [path, rawErrors] of Object.entries(value)) {
    if (!path.startsWith('/') || !Array.isArray(rawErrors) || rawErrors.length === 0) {
      return undefined
    }
    const errors: FormServerFieldError[] = []
    for (const rawError of rawErrors) {
      if (
        !isRecord(rawError)
        || typeof rawError.code !== 'string'
        || typeof rawError.message !== 'string'
        || (rawError.componentId !== undefined && typeof rawError.componentId !== 'string')
      ) {
        return undefined
      }
      errors.push({
        code: rawError.code,
        message: rawError.message,
        ...(rawError.componentId === undefined
          ? {}
          : { componentId: rawError.componentId }),
      })
    }
    fieldErrors[path] = errors
  }
  return fieldErrors
}

function isApiError(value: unknown): value is A2UIApiError {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && typeof value.retryable === 'boolean'
}

function isPersistedSubmission(value: unknown): value is PersistedSubmission {
  return isRecord(value)
    && typeof value.submissionId === 'string'
    && typeof value.formId === 'string'
    && typeof value.revision === 'number'
    && Number.isInteger(value.revision)
    && value.revision >= 1
    && isRecord(value.action)
    && typeof value.action.actionId === 'string'
    && typeof value.action.sourceComponentId === 'string'
    && isRecord(value.data)
    && value.status === 'completed'
    && typeof value.auditId === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
}

function submitError(errors: readonly A2UIApiError[]): FormSubmitResponse {
  return { status: 'error', errors }
}

function httpError(status: number): A2UIApiError {
  return {
    code: 'HTTP_ERROR',
    message: `Server returned ${status}.`,
    retryable: status >= 500,
  }
}

function invalidResponseError(status: number): A2UIApiError {
  return {
    code: 'INVALID_RESPONSE',
    message: 'Server returned an invalid A2UI response.',
    retryable: status >= 500,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
