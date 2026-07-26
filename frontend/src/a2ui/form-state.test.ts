import { describe, expect, it } from 'vitest'
import { createA2UIFormController } from './form-state.ts'
import { parseA2UIFormDocument } from './parser.ts'
import type { NormalizedA2UIFormDocumentV1 } from './types.ts'

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
  options: { readonly rules?: readonly unknown[]; readonly actions?: readonly unknown[] } = {},
): NormalizedA2UIFormDocumentV1 {
  return parseDocument({
    schemaVersion: '1.0.0',
    requestId: 'request-1',
    formId: 'form-1',
    revision: 1,
    root: { id: 'form-root', type: 'Form', props: {}, children },
    data: { initialValues },
    actions: options.actions ?? [],
    rules: options.rules ?? [],
  })
}

function textInput(id: string, dataPath: string, options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'TextInput',
    props: { label: id, ...options },
    children: [],
    dataPath,
  }
}

function numberInput(id: string, dataPath: string, options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'NumberInput',
    props: { label: id, ...options },
    children: [],
    dataPath,
  }
}

function submitButton(actionId = 'submit'): Record<string, unknown> {
  return {
    id: 'submit-button',
    type: 'Button',
    props: { label: 'Submit' },
    children: [],
    action: { actionId },
  }
}

function submitAction(id = 'submit'): Record<string, unknown> {
  return { id, type: 'submit', endpointKey: 'forms.submit', method: 'POST' }
}

describe('A2UI form state controller', () => {
  it('reads and writes nested RFC 6901 data paths without overwriting defaults until reset', () => {
    const document = documentWith(
      { profile: { name: 'Ada', 'address/home': { city: 'Shanghai' } } },
      [textInput('name', '/profile/name'), textInput('city', '/profile/address~1home/city')],
    )
    const controller = createA2UIFormController(document)

    expect(controller.getValue('/profile/address~1home/city')).toBe('Shanghai')
    expect(controller.setValue('/profile/name', 'Grace')).toBe(true)
    expect(controller.getSnapshot().values).toMatchObject({ profile: { name: 'Grace' } })
    expect(document.data.initialValues).toMatchObject({ profile: { name: 'Ada' } })
    expect(controller.getSnapshot().fields['/profile/name']?.dirty).toBe(true)

    controller.reset()

    expect(controller.getSnapshot().values).toMatchObject({ profile: { name: 'Ada' } })
    expect(controller.getSnapshot().fields['/profile/name']?.dirty).toBe(false)
  })

  it('uses change, blur, and submit validation timing while skipping hidden and disabled fields', async () => {
    const document = documentWith(
      { email: '', disabledValue: '', hiddenValue: '', hostOnly: 'unchanged' },
      [
        {
          ...textInput('email', '/email'),
          validation: [
            { type: 'required' },
            { type: 'minLength', value: 3 },
          ],
        },
        {
          ...textInput('disabled', '/disabledValue', { disabled: true }),
          validation: [{ type: 'required' }],
        },
        {
          ...textInput('hidden', '/hiddenValue', { visible: false }),
          validation: [{ type: 'required' }],
        },
        submitButton(),
      ],
      { actions: [submitAction()] },
    )
    let transports = 0
    const controller = createA2UIFormController(document, {
      submit: async () => {
        transports += 1
        return { status: 'success', result: { submissionId: 'submission-1' } }
      },
    })

    expect(controller.getSubmissionData()).toEqual({ email: '', disabledValue: '', hostOnly: 'unchanged' })
    expect(controller.setValue('/disabledValue', 'not-allowed')).toBe(false)
    expect(controller.setValue('/hiddenValue', 'not-allowed')).toBe(false)
    expect(controller.setValue('/hostOnly', 'not-allowed')).toBe(false)
    expect(controller.getValue('/disabledValue')).toBe('')
    expect(controller.getValue('/hiddenValue')).toBe('')
    expect(controller.getValue('/hostOnly')).toBe('unchanged')
    controller.setValue('/email', '')
    expect(controller.getSnapshot().errors.fieldErrors['/email']).toBeUndefined()
    expect(controller.blur('/email')).toEqual([
      expect.objectContaining({ code: 'FIELD_REQUIRED', source: 'client' }),
    ])

    expect(await controller.dispatchAction('submit', 'submit-button')).toEqual({ status: 'validation_failed' })
    expect(transports).toBe(0)

    controller.setValue('/email', 'valid@example.com')
    expect(await controller.dispatchAction('submit', 'submit-button')).toEqual({
      status: 'success',
      result: { submissionId: 'submission-1' },
    })
    expect(transports).toBe(1)
  })

  it('evaluates the allowed rules in batches and removes hidden values from the submission projection', () => {
    const document = documentWith(
      { kind: 'company', company: 'Acme', first: 1, second: 0, final: '' },
      [
        textInput('kind', '/kind'),
        {
          ...textInput('company', '/company'),
          validation: [{ type: 'required' }],
        },
        numberInput('first', '/first'),
        numberInput('second', '/second'),
        textInput('final', '/final'),
      ],
      {
        rules: [
          {
            id: 'company-visibility',
            event: 'change',
            sourceDataPath: '/kind',
            when: { op: 'equals', path: '/kind', value: 'company' },
            then: [{ type: 'setVisible', targetComponentId: 'company', value: true }],
            else: [{ type: 'setVisible', targetComponentId: 'company', value: false }],
          },
          {
            id: 'first-to-second',
            event: 'change',
            sourceDataPath: '/first',
            when: { op: 'equals', path: '/first', value: 1 },
            then: [{ type: 'setValue', targetDataPath: '/second', value: 2 }],
          },
          {
            id: 'second-to-final',
            event: 'change',
            sourceDataPath: '/second',
            when: { op: 'equals', path: '/second', value: 2 },
            then: [{ type: 'setValue', targetDataPath: '/final', value: 'complete' }],
          },
        ],
      },
    )
    const controller = createA2UIFormController(document)

    expect(controller.getSnapshot().components.company).toEqual({ visible: true, disabled: false })
    expect(controller.getValue('/final')).toBe('complete')

    controller.setValue('/company', '')
    expect(controller.blur('/company')).toEqual([
      expect.objectContaining({ code: 'FIELD_REQUIRED' }),
    ])
    controller.setValue('/kind', 'person')

    expect(controller.getSnapshot().components.company).toEqual({ visible: false, disabled: false })
    expect(controller.getSnapshot().values).toMatchObject({ company: '' })
    expect(controller.getSnapshot().errors.fieldErrors['/company']).toBeUndefined()
    expect(controller.getSubmissionData()).toEqual({ kind: 'person', first: 1, second: 2, final: 'complete' })

    controller.reset()
    expect(controller.getSnapshot().components.company).toEqual({ visible: true, disabled: false })
    expect(controller.getValue('/final')).toBe('complete')
  })

  it('stops a valid but overlong rule chain at the v1 20-batch safety limit', () => {
    const initialValues = Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`step${index}`, 0]))
    const rules = Array.from({ length: 21 }, (_, index) => ({
      id: `step-${index}`,
      event: 'change',
      sourceDataPath: `/step${index}`,
      when: { op: 'equals', path: `/step${index}`, value: 1 },
      then: [{ type: 'setValue', targetDataPath: `/step${index + 1}`, value: 1 }],
    }))
    const document = documentWith(initialValues, [numberInput('step0', '/step0')], { rules })
    const controller = createA2UIFormController(document)

    controller.setValue('/step0', 1)

    expect(controller.getValue('/step20')).toBe(1)
    expect(controller.getValue('/step21')).toBe(0)
    expect(controller.getSnapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RULE_EXECUTION_LIMIT' }),
    ]))
    expect(controller.getSnapshot().canSubmit).toBe(false)
  })

  it('treats a runtime-missing condition path as false, records a warning, and safely runs the else branch', () => {
    const document = documentWith(
      { trigger: '', settings: { nested: 'present' }, outcome: '' },
      [textInput('trigger', '/trigger'), textInput('outcome', '/outcome')],
      {
        rules: [
          {
            id: 'replace-settings',
            event: 'change',
            sourceDataPath: '/trigger',
            when: { op: 'equals', path: '/trigger', value: 'replace' },
            then: [{ type: 'setValue', targetDataPath: '/settings', value: 'not-an-object' }],
          },
          {
            id: 'missing-path-fallback',
            event: 'change',
            sourceDataPath: '/settings',
            when: { op: 'equals', path: '/settings/nested', value: 'present' },
            then: [{ type: 'setValue', targetDataPath: '/outcome', value: 'then' }],
            else: [{ type: 'setValue', targetDataPath: '/outcome', value: 'else' }],
          },
        ],
      },
    )
    const controller = createA2UIFormController(document)

    controller.setValue('/trigger', 'replace')

    expect(controller.getValue('/outcome')).toBe('else')
    expect(controller.getSnapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RULE_PATH_NOT_FOUND', path: '/settings/nested' }),
    ]))
    expect(controller.getSnapshot().canSubmit).toBe(true)
  })

  it('retains an idempotency key across a safe retry and blocks duplicate in-flight submits', async () => {
    const document = documentWith(
      { name: 'Ada' },
      [textInput('name', '/name'), submitButton()],
      { actions: [submitAction()] },
    )
    let requestNumber = 0
    let idempotencyNumber = 0
    let completeFirst: ((response: { status: 'error'; errors: readonly [{ code: string; message: string; retryable: true }] }) => void) | undefined
    let completeSecond: ((response: { status: 'success'; result: { submissionId: string } }) => void) | undefined
    const requests: Array<{ readonly requestId: string; readonly idempotencyKey: string }> = []
    const controller = createA2UIFormController(document, {
      createRequestId: () => `request-${++requestNumber}`,
      createIdempotencyKey: () => `idem-${++idempotencyNumber}`,
      submit: async (request) => {
        requests.push({ requestId: request.requestId, idempotencyKey: request.idempotencyKey })
        if (requests.length === 1) {
          return new Promise((resolve) => { completeFirst = resolve })
        }
        return new Promise((resolve) => { completeSecond = resolve })
      },
    })

    const first = controller.dispatchAction('submit', 'submit-button')
    expect(controller.getSnapshot().submission.status).toBe('submitting')
    expect(await controller.dispatchAction('submit', 'submit-button')).toEqual({ status: 'blocked', reason: 'submitting' })

    completeFirst?.({ status: 'error', errors: [{ code: 'NETWORK_TIMEOUT', message: 'Retry', retryable: true }] })
    expect(await first).toEqual({ status: 'error', retryable: true })
    expect(controller.getSnapshot().submission).toMatchObject({ status: 'error', retryable: true, idempotencyKey: 'idem-1' })

    const retry = controller.retrySubmission()
    expect(controller.getSnapshot().submission.status).toBe('submitting')
    completeSecond?.({ status: 'success', result: { submissionId: 'submission-2' } })
    expect(await retry).toEqual({ status: 'success', result: { submissionId: 'submission-2' } })
    expect(requests).toEqual([
      { requestId: 'request-1', idempotencyKey: 'idem-1' },
      { requestId: 'request-2', idempotencyKey: 'idem-1' },
    ])
  })

  it('maps field and form errors without dropping unmapped server paths, then clears only the changed field error', async () => {
    const document = documentWith(
      { name: '', hidden: 'keep' },
      [textInput('name', '/name'), textInput('hidden', '/hidden', { visible: false }), submitButton()],
      { actions: [submitAction()] },
    )
    const controller = createA2UIFormController(document, {
      submit: async () => ({
        status: 'validation_error',
        fieldErrors: {
          '/name': [{ code: 'NAME_INVALID', message: 'Name needs review', retryable: false }],
          '/missing': [{ code: 'MISSING_INVALID', message: 'Missing field', retryable: false }],
        },
        errors: [{ code: 'FORM_INVALID', message: 'Review the form', retryable: false }],
      }),
    })

    expect(await controller.dispatchAction('submit', 'submit-button')).toEqual({ status: 'server_validation_error' })
    expect(controller.getSnapshot().errors.fieldErrors['/name']).toEqual([
      expect.objectContaining({ code: 'NAME_INVALID', source: 'server' }),
    ])
    expect(controller.getSnapshot().errors.summary).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FORM_INVALID' }),
      expect.objectContaining({ code: 'FIELD_ERROR_UNMAPPED', path: '/missing', originalCode: 'MISSING_INVALID' }),
    ]))

    controller.setValue('/name', 'Ada')

    expect(controller.getSnapshot().errors.fieldErrors['/name']).toBeUndefined()
    expect(controller.getSnapshot().errors.summary).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FIELD_ERROR_UNMAPPED', path: '/missing' }),
    ]))
  })

  it('rejects disabled action sources and does not retry a revision conflict', async () => {
    const disabledDocument = documentWith(
      { name: 'Ada' },
      [
        textInput('name', '/name'),
        {
          id: 'disabled-submit',
          type: 'Button',
          props: { label: 'Submit', disabled: true },
          children: [],
          action: { actionId: 'submit' },
        },
      ],
      { actions: [submitAction()] },
    )
    let calls = 0
    const disabledController = createA2UIFormController(disabledDocument, {
      submit: async () => {
        calls += 1
        return { status: 'success', result: { submissionId: 'unexpected' } }
      },
    })

    expect(await disabledController.dispatchAction('submit', 'disabled-submit')).toEqual({
      status: 'blocked',
      reason: 'invalid_action',
    })
    expect(calls).toBe(0)

    const conflictDocument = documentWith(
      { name: 'Ada' },
      [textInput('name', '/name'), submitButton()],
      { actions: [submitAction()] },
    )
    const conflictController = createA2UIFormController(conflictDocument, {
      submit: async () => ({
        status: 'error',
        errors: [{ code: 'FORM_REVISION_CONFLICT', message: 'Reload required', retryable: true }],
      }),
    })

    expect(await conflictController.dispatchAction('submit', 'submit-button')).toEqual({ status: 'error', retryable: false })
    expect(conflictController.getSnapshot().errors.formErrors).toEqual([
      expect.objectContaining({ code: 'FORM_REVISION_CONFLICT', retryable: false }),
    ])
    expect(await conflictController.retrySubmission()).toEqual({ status: 'blocked', reason: 'retry_unavailable' })
  })

  it('blocks actions safely when a forged normalized document contains a rule cycle', async () => {
    const document = documentWith(
      { first: '', second: '' },
      [textInput('first', '/first'), textInput('second', '/second'), submitButton()],
      { actions: [submitAction()] },
    )
    const forged = structuredClone(document)
    Object.defineProperty(forged, 'rules', {
      value: [
        {
          id: 'first-to-second',
          event: 'change',
          sourceDataPath: '/first',
          when: { op: 'exists', path: '/first' },
          then: [{ type: 'setValue', targetDataPath: '/second', value: 'x' }],
        },
        {
          id: 'second-to-first',
          event: 'change',
          sourceDataPath: '/second',
          when: { op: 'exists', path: '/second' },
          then: [{ type: 'setValue', targetDataPath: '/first', value: 'x' }],
        },
      ],
    })
    const controller = createA2UIFormController(forged)

    expect(controller.getSnapshot().canSubmit).toBe(false)
    expect(controller.getSnapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RULE_INVALID' }),
    ]))
    expect(await controller.dispatchAction('submit', 'submit-button')).toEqual({
      status: 'blocked',
      reason: 'configuration_invalid',
    })
  })

  it('safely blocks a forged normalized document with an unsupported component', () => {
    const document = documentWith(
      { name: 'Ada' },
      [textInput('name', '/name')],
    )
    const forged = structuredClone(document)
    Object.defineProperty(forged.root, 'children', {
      value: [
        ...forged.root.children,
        { id: 'unknown-component', type: 'UnknownWidget', props: {}, children: [] },
      ],
    })

    const controller = createA2UIFormController(forged)

    expect(controller.getSnapshot().canSubmit).toBe(false)
    expect(controller.getSnapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COMPONENT_UNSUPPORTED', componentId: 'unknown-component' }),
    ]))
  })
})
