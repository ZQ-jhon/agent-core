import {
  cloneJsonValue,
  dataPathsOverlap,
  equalJsonValue,
  getDataPathValue,
  removeDataPathValue,
  setDataPathValue,
} from './data-path.ts'
import { isCompatibleBoundValue } from './bound-value.ts'
import { componentRegistry } from './registry.ts'
import type {
  ActionDefinition,
  ComponentNode,
  Condition,
  DataPath,
  JsonValue,
  NormalizedA2UIFormDocumentV1,
  RuleEffect,
  StableId,
  Validator,
} from './types.ts'

export const formRuntimeDiagnosticCodes = [
  'COMPONENT_UNSUPPORTED',
  'DATA_BINDING_INVALID',
  'RULE_INVALID',
  'RULE_PATH_NOT_FOUND',
  'RULE_EXECUTION_LIMIT',
  'FIELD_ERROR_UNMAPPED',
  'ACTION_INVALID',
  'ACTION_FAILED',
] as const

export type FormRuntimeDiagnosticCode = (typeof formRuntimeDiagnosticCodes)[number]

export interface FormRuntimeDiagnostic {
  readonly code: FormRuntimeDiagnosticCode
  readonly message: string
  readonly path?: DataPath
  readonly componentId?: StableId
}

export interface FormFieldError {
  readonly code: string
  readonly message: string
  readonly source: 'client' | 'server'
  readonly componentId?: StableId
}

export interface FormErrorSummaryItem extends FormFieldError {
  readonly path?: DataPath
  readonly retryable?: boolean
  /** Preserves the server code when the path cannot be mapped to a field. */
  readonly originalCode?: string
}

export interface FormComponentState {
  readonly visible: boolean
  readonly disabled: boolean
}

export interface FormFieldState {
  readonly value: JsonValue
  readonly touched: boolean
  readonly dirty: boolean
  readonly visible: boolean
  readonly disabled: boolean
  readonly interactive: boolean
  readonly errors: readonly FormFieldError[]
}

export interface FormErrorsState {
  readonly fieldErrors: Readonly<Record<string, readonly FormFieldError[]>>
  readonly formErrors: readonly FormErrorSummaryItem[]
  readonly summary: readonly FormErrorSummaryItem[]
}

export type FormSubmissionStatus =
  | 'idle'
  | 'awaiting_confirmation'
  | 'submitting'
  | 'success'
  | 'validation_error'
  | 'error'

export interface FormSubmissionResult {
  readonly submissionId: StableId
  readonly message?: string
}

export interface FormSubmissionState {
  readonly status: FormSubmissionStatus
  readonly actionId?: StableId
  readonly sourceComponentId?: StableId
  readonly idempotencyKey?: StableId
  readonly result?: FormSubmissionResult
  readonly retryable?: boolean
}

export interface A2UIFormState {
  readonly values: Readonly<Record<string, JsonValue>>
  readonly fields: Readonly<Record<string, FormFieldState>>
  readonly components: Readonly<Record<string, FormComponentState>>
  readonly errors: FormErrorsState
  readonly diagnostics: readonly FormRuntimeDiagnostic[]
  readonly submission: FormSubmissionState
  readonly showErrorSummary: boolean
  readonly canSubmit: boolean
}

export interface FormSubmitClient {
  readonly locale?: string
  readonly timeZone?: string
}

export interface FormSubmitRequest {
  readonly schemaVersion: string
  readonly requestId: StableId
  readonly idempotencyKey: StableId
  readonly formId: StableId
  readonly revision: number
  readonly action: {
    readonly actionId: StableId
    readonly sourceComponentId: StableId
  }
  readonly data: Readonly<Record<string, JsonValue>>
  readonly client?: FormSubmitClient
}

export interface FormServerError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly componentId?: StableId
}

export interface FormSubmitSuccessResponse {
  readonly status: 'success'
  readonly result: FormSubmissionResult
}

export interface FormSubmitValidationErrorResponse {
  readonly status: 'validation_error'
  readonly fieldErrors: Readonly<Record<string, readonly FormServerError[]>>
  readonly errors?: readonly FormServerError[]
}

export interface FormSubmitErrorResponse {
  readonly status: 'error'
  readonly errors: readonly FormServerError[]
}

export type FormSubmitResponse =
  | FormSubmitSuccessResponse
  | FormSubmitValidationErrorResponse
  | FormSubmitErrorResponse

/** The trusted host owns endpoint resolution and actual transport. */
export type FormSubmitTransport = (request: FormSubmitRequest) => Promise<FormSubmitResponse>

export interface A2UIFormControllerOptions {
  readonly submit?: FormSubmitTransport
  readonly createRequestId?: () => StableId
  readonly createIdempotencyKey?: () => StableId
  readonly client?: FormSubmitClient
}

export type FormActionResult =
  | { readonly status: 'completed'; readonly actionType: 'reset' }
  | { readonly status: 'confirmation_required'; readonly actionId: StableId; readonly sourceComponentId: StableId }
  | { readonly status: 'validation_failed' }
  | { readonly status: 'success'; readonly result: FormSubmissionResult }
  | { readonly status: 'server_validation_error' }
  | { readonly status: 'error'; readonly retryable: boolean }
  | {
      readonly status: 'blocked'
      readonly reason:
        | 'configuration_invalid'
        | 'submitting'
        | 'invalid_action'
        | 'confirmation_pending'
        | 'submit_transport_unavailable'
        | 'no_pending_confirmation'
        | 'retry_unavailable'
    }

export interface A2UIFormController {
  getSnapshot(): A2UIFormState
  subscribe(listener: () => void): () => void
  getValue(dataPath: DataPath): JsonValue | undefined
  getSubmissionData(): Readonly<Record<string, JsonValue>>
  setValue(dataPath: DataPath, value: JsonValue): boolean
  blur(dataPath: DataPath): readonly FormFieldError[]
  validateField(dataPath: DataPath): readonly FormFieldError[]
  validateForm(): boolean
  dispatchAction(actionId: StableId, sourceComponentId: StableId): Promise<FormActionResult>
  confirmPendingAction(): Promise<FormActionResult>
  cancelPendingAction(): void
  retrySubmission(): Promise<FormActionResult>
  reset(): void
}

interface IndexedNode {
  readonly node: ComponentNode
  readonly parentId?: StableId
  readonly order: number
}

interface ComponentSettings {
  visible: boolean
  disabled: boolean
}

interface PendingAction {
  readonly action: ActionDefinition
  readonly sourceComponentId: StableId
}

interface RetryableSubmission {
  readonly request: Omit<FormSubmitRequest, 'requestId'>
}

interface MutableSubmission {
  status: FormSubmissionStatus
  actionId?: StableId
  sourceComponentId?: StableId
  idempotencyKey?: StableId
  result?: FormSubmissionResult
  retryable?: boolean
}

const MAX_RULE_BATCHES = 20

/**
 * Creates the non-visual runtime for an already parsed Schema v1 document.
 * The controller never resolves endpoints, imports components, or executes
 * schema-supplied code.
 */
export function createA2UIFormController(
  document: NormalizedA2UIFormDocumentV1,
  options: A2UIFormControllerOptions = {},
): A2UIFormController {
  const indexedNodes = indexNodes(document.root)
  const nodesById = new Map(indexedNodes.map((item) => [item.node.id, item]))
  const fieldComponentIds = new Map<DataPath, StableId[]>()
  const componentSettings = new Map<StableId, ComponentSettings>()
  const invalidComponents = new Set<StableId>()
  const diagnostics: FormRuntimeDiagnostic[] = []
  const actionsById = new Map(document.actions.map((action) => [action.id, action]))
  const initialValues = cloneJsonValue(document.data.initialValues) as Readonly<Record<string, JsonValue>>

  let values = cloneJsonValue(initialValues) as Record<string, JsonValue>
  let clientErrors = new Map<DataPath, FormFieldError>()
  let serverErrors = new Map<DataPath, readonly FormFieldError[]>()
  let formErrors: FormErrorSummaryItem[] = []
  let touchedPaths = new Set<DataPath>()
  let blockingConfiguration = false
  let showErrorSummary = false
  let pendingAction: PendingAction | undefined
  let retryableSubmission: RetryableSubmission | undefined
  let submission: MutableSubmission = { status: 'idle' }
  const listeners = new Set<() => void>()
  let snapshot: A2UIFormState

  for (const { node } of indexedNodes) {
    const registration = componentRegistry[node.type]
    componentSettings.set(node.id, {
      visible: initialVisible(node),
      disabled: initialDisabled(node),
    })
    if (registration === undefined) {
      invalidComponents.add(node.id)
      reportConfigurationProblem(
        'COMPONENT_UNSUPPORTED',
        'The normalized document contains an unsupported component type.',
        undefined,
        node.id,
      )
      continue
    }
    if (registration.requiresDataPath) {
      if (node.dataPath === undefined) {
        invalidComponents.add(node.id)
        reportConfigurationProblem(
          'DATA_BINDING_INVALID',
          'A field is missing its required dataPath.',
          undefined,
          node.id,
        )
        continue
      }
      const ids = fieldComponentIds.get(node.dataPath) ?? []
      ids.push(node.id)
      fieldComponentIds.set(node.dataPath, ids)
      const initialValue = getDataPathValue(values, node.dataPath)
      if (!initialValue.found) {
        invalidComponents.add(node.id)
        reportConfigurationProblem(
          'DATA_BINDING_INVALID',
          'A field dataPath does not resolve to an initial value.',
          node.dataPath,
          node.id,
        )
      } else if (!isCompatibleBoundValue(node, initialValue.value)) {
        invalidComponents.add(node.id)
        reportConfigurationProblem(
          'DATA_BINDING_INVALID',
          'A field initial value is incompatible with its component type.',
          node.dataPath,
          node.id,
        )
      }
    }
  }

  validateRuntimeRuleReferences()
  if (!blockingConfiguration) {
    executeRuleBatches(undefined)
  }
  refreshSnapshot()

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getValue(dataPath: DataPath): JsonValue | undefined {
      const value = getDataPathValue(values, dataPath)
      return value.found ? cloneJsonValue(value.value) : undefined
    },
    getSubmissionData() {
      return freezeSnapshot(projectSubmissionData())
    },
    setValue(dataPath: DataPath, value: JsonValue): boolean {
      if (submission.status === 'submitting') {
        return false
      }
      const componentStates = getEffectiveComponentStates()
      const isInteractive = (fieldComponentIds.get(dataPath) ?? []).some((componentId) => {
        const state = componentStates.get(componentId)
        return state?.visible === true && state.disabled === false
      })
      if (!isInteractive) {
        return false
      }
      const current = getDataPathValue(values, dataPath)
      const updated = setDataPathValue(values, dataPath, value)
      if (!updated.ok) {
        reportRuntimeDiagnostic(
          'DATA_BINDING_INVALID',
          'A value write targeted an unavailable dataPath and was ignored.',
          dataPath,
        )
        refreshSnapshot()
        notify()
        return false
      }
      const incompatibleComponentId = findIncompatibleBoundComponent(dataPath, updated.value)
      if (incompatibleComponentId !== undefined) {
        reportRuntimeDiagnostic(
          'DATA_BINDING_INVALID',
          'A value write is incompatible with the bound component type and was ignored.',
          dataPath,
          incompatibleComponentId,
        )
        refreshSnapshot()
        notify()
        return false
      }
      if (current.found && equalJsonValue(current.value, value)) {
        return true
      }

      values = updated.value as Record<string, JsonValue>
      serverErrors.delete(dataPath)
      invalidateTerminalSubmission()
      if (!blockingConfiguration) {
        executeRuleBatches([dataPath])
      }
      refreshSnapshot()
      notify()
      return true
    },
    blur(dataPath: DataPath): readonly FormFieldError[] {
      touchedPaths.add(dataPath)
      const errors = validateOneField(dataPath)
      refreshSnapshot()
      notify()
      return errors
    },
    validateField(dataPath: DataPath): readonly FormFieldError[] {
      const errors = validateOneField(dataPath)
      refreshSnapshot()
      notify()
      return errors
    },
    validateForm(): boolean {
      const valid = validateAllFields()
      refreshSnapshot()
      notify()
      return valid
    },
    async dispatchAction(actionId: StableId, sourceComponentId: StableId): Promise<FormActionResult> {
      if (submission.status === 'submitting') {
        return { status: 'blocked', reason: 'submitting' }
      }
      if (pendingAction !== undefined) {
        return { status: 'blocked', reason: 'confirmation_pending' }
      }
      if (blockingConfiguration) {
        return { status: 'blocked', reason: 'configuration_invalid' }
      }
      const action = actionsById.get(actionId)
      const source = nodesById.get(sourceComponentId)
      const sourceState = getEffectiveComponentStates().get(sourceComponentId)
      if (
        action === undefined ||
        source?.node.action?.actionId !== actionId ||
        sourceState?.visible !== true ||
        sourceState.disabled === true
      ) {
        reportRuntimeDiagnostic('ACTION_INVALID', 'The requested action is not bound to its source component.', undefined, sourceComponentId)
        refreshSnapshot()
        notify()
        return { status: 'blocked', reason: 'invalid_action' }
      }
      if (source.node.action.confirm !== undefined) {
        pendingAction = { action, sourceComponentId }
        submission = { status: 'awaiting_confirmation', actionId, sourceComponentId }
        refreshSnapshot()
        notify()
        return { status: 'confirmation_required', actionId, sourceComponentId }
      }
      return performAction(action, sourceComponentId)
    },
    async confirmPendingAction(): Promise<FormActionResult> {
      if (pendingAction === undefined) {
        return { status: 'blocked', reason: 'no_pending_confirmation' }
      }
      const current = pendingAction
      pendingAction = undefined
      return performAction(current.action, current.sourceComponentId)
    },
    cancelPendingAction(): void {
      if (pendingAction === undefined) {
        return
      }
      pendingAction = undefined
      submission = { status: 'idle' }
      refreshSnapshot()
      notify()
    },
    async retrySubmission(): Promise<FormActionResult> {
      if (submission.status === 'submitting') {
        return { status: 'blocked', reason: 'submitting' }
      }
      if (blockingConfiguration) {
        return { status: 'blocked', reason: 'configuration_invalid' }
      }
      if (retryableSubmission === undefined || options.submit === undefined) {
        return { status: 'blocked', reason: 'retry_unavailable' }
      }
      const request: FormSubmitRequest = {
        ...retryableSubmission.request,
        requestId: createRequestId(),
        data: cloneJsonValue(retryableSubmission.request.data) as Readonly<Record<string, JsonValue>>,
      }
      return sendSubmission(request)
    },
    reset(): void {
      if (submission.status === 'submitting') {
        return
      }
      values = cloneJsonValue(initialValues) as Record<string, JsonValue>
      clientErrors = new Map()
      serverErrors = new Map()
      formErrors = []
      touchedPaths = new Set()
      showErrorSummary = false
      pendingAction = undefined
      retryableSubmission = undefined
      submission = { status: 'idle' }
      for (const { node } of indexedNodes) {
        componentSettings.set(node.id, {
          visible: initialVisible(node),
          disabled: initialDisabled(node),
        })
      }
      if (!blockingConfiguration) {
        executeRuleBatches(undefined)
      }
      refreshSnapshot()
      notify()
    },
  })

  function createRequestId(): StableId {
    return options.createRequestId?.() ?? createRuntimeId('request')
  }

  function createIdempotencyKey(): StableId {
    return options.createIdempotencyKey?.() ?? createRuntimeId('idem')
  }

  async function performAction(action: ActionDefinition, sourceComponentId: StableId): Promise<FormActionResult> {
    if (action.type === 'reset') {
      resetThroughAction()
      return { status: 'completed', actionType: 'reset' }
    }
    if (action.type !== 'submit') {
      reportRuntimeDiagnostic('ACTION_INVALID', 'Only submit and reset actions are available to the form state controller.', undefined, sourceComponentId)
      refreshSnapshot()
      notify()
      return { status: 'blocked', reason: 'invalid_action' }
    }
    if (!validateAllFields()) {
      showErrorSummary = true
      submission = { status: 'idle', actionId: action.id, sourceComponentId }
      refreshSnapshot()
      notify()
      return { status: 'validation_failed' }
    }
    if (options.submit === undefined) {
      reportRuntimeDiagnostic('ACTION_FAILED', 'No trusted submit transport is registered for this form.', undefined, sourceComponentId)
      formErrors = [toSummaryError('ACTION_FAILED', 'The form cannot be submitted right now.', false)]
      submission = { status: 'error', actionId: action.id, sourceComponentId, retryable: false }
      showErrorSummary = true
      refreshSnapshot()
      notify()
      return { status: 'blocked', reason: 'submit_transport_unavailable' }
    }

    const request: FormSubmitRequest = {
      schemaVersion: document.schemaVersion,
      requestId: createRequestId(),
      idempotencyKey: createIdempotencyKey(),
      formId: document.formId,
      revision: document.revision,
      action: { actionId: action.id, sourceComponentId },
      data: projectSubmissionData(),
      ...(options.client === undefined ? {} : { client: { ...options.client } }),
    }
    return sendSubmission(request)
  }

  async function sendSubmission(request: FormSubmitRequest): Promise<FormActionResult> {
    const retryRequest = withoutRequestId(request)
    submission = {
      status: 'submitting',
      actionId: request.action.actionId,
      sourceComponentId: request.action.sourceComponentId,
      idempotencyKey: request.idempotencyKey,
    }
    refreshSnapshot()
    notify()

    try {
      const response = await options.submit!(request)
      return mapSubmissionResponse(response, request, retryRequest)
    } catch {
      reportRuntimeDiagnostic('ACTION_FAILED', 'The submit transport failed without a response.', undefined, request.action.sourceComponentId)
      formErrors = [toSummaryError('ACTION_FAILED', 'Unable to submit the form. Please try again.', true)]
      retryableSubmission = { request: retryRequest }
      submission = {
        status: 'error',
        actionId: request.action.actionId,
        sourceComponentId: request.action.sourceComponentId,
        idempotencyKey: request.idempotencyKey,
        retryable: true,
      }
      showErrorSummary = true
      refreshSnapshot()
      notify()
      return { status: 'error', retryable: true }
    }
  }

  function mapSubmissionResponse(
    response: FormSubmitResponse,
    request: FormSubmitRequest,
    retryRequest: Omit<FormSubmitRequest, 'requestId'>,
  ): FormActionResult {
    if (response.status === 'success') {
      clientErrors = new Map()
      serverErrors = new Map()
      formErrors = []
      retryableSubmission = undefined
      submission = {
        status: 'success',
        actionId: request.action.actionId,
        sourceComponentId: request.action.sourceComponentId,
        idempotencyKey: request.idempotencyKey,
        result: { ...response.result },
      }
      showErrorSummary = false
      refreshSnapshot()
      notify()
      return { status: 'success', result: response.result }
    }

    if (response.status === 'validation_error') {
      formErrors = (response.errors ?? []).map((error) => toSummaryError(error.code, error.message, error.retryable, error.componentId))
      const nextServerErrors = new Map<DataPath, readonly FormFieldError[]>()
      for (const [rawPath, errors] of Object.entries(response.fieldErrors)) {
        const dataPath = rawPath as DataPath
        if (!fieldComponentIds.has(dataPath)) {
          for (const error of errors) {
            formErrors.push({
              ...toSummaryError('FIELD_ERROR_UNMAPPED', error.message, error.retryable, error.componentId),
              path: dataPath,
              originalCode: error.code,
            })
          }
          reportRuntimeDiagnostic('FIELD_ERROR_UNMAPPED', 'A server field error did not match a rendered dataPath.', dataPath)
          continue
        }
        nextServerErrors.set(
          dataPath,
          errors.map((error) => ({
            code: error.code,
            message: error.message,
            source: 'server' as const,
            ...(error.componentId === undefined ? {} : { componentId: error.componentId }),
          })),
        )
      }
      serverErrors = nextServerErrors
      retryableSubmission = undefined
      submission = {
        status: 'validation_error',
        actionId: request.action.actionId,
        sourceComponentId: request.action.sourceComponentId,
        idempotencyKey: request.idempotencyKey,
        retryable: false,
      }
      showErrorSummary = true
      refreshSnapshot()
      notify()
      return { status: 'server_validation_error' }
    }

    const hasRevisionConflict = response.errors.some((error) => error.code === 'FORM_REVISION_CONFLICT')
    serverErrors = new Map()
    formErrors = response.errors.map((error) => toSummaryError(error.code, error.message, hasRevisionConflict ? false : error.retryable, error.componentId))
    const retryable = !hasRevisionConflict && response.errors.some((error) => error.retryable)
    retryableSubmission = retryable ? { request: retryRequest } : undefined
    submission = {
      status: 'error',
      actionId: request.action.actionId,
      sourceComponentId: request.action.sourceComponentId,
      idempotencyKey: request.idempotencyKey,
      retryable,
    }
    showErrorSummary = true
    refreshSnapshot()
    notify()
    return { status: 'error', retryable }
  }

  function resetThroughAction(): void {
    values = cloneJsonValue(initialValues) as Record<string, JsonValue>
    clientErrors = new Map()
    serverErrors = new Map()
    formErrors = []
    touchedPaths = new Set()
    showErrorSummary = false
    pendingAction = undefined
    retryableSubmission = undefined
    submission = { status: 'idle' }
    for (const { node } of indexedNodes) {
      componentSettings.set(node.id, {
        visible: initialVisible(node),
        disabled: initialDisabled(node),
      })
    }
    if (!blockingConfiguration) {
      executeRuleBatches(undefined)
    }
    refreshSnapshot()
    notify()
  }

  function invalidateTerminalSubmission(): void {
    if (submission.status !== 'submitting') {
      submission = { status: 'idle' }
      retryableSubmission = undefined
      pendingAction = undefined
    }
  }

  function validateAllFields(): boolean {
    let valid = !blockingConfiguration
    for (const dataPath of fieldComponentIds.keys()) {
      const componentState = getEffectiveComponentStates()
      const interactive = (fieldComponentIds.get(dataPath) ?? []).some((id) => {
        const state = componentState.get(id)
        return state?.visible === true && state.disabled === false
      })
      if (!interactive) {
        clientErrors.delete(dataPath)
        continue
      }
      touchedPaths.add(dataPath)
      if (validateOneField(dataPath).length > 0) {
        valid = false
      }
    }
    return valid
  }

  function validateOneField(dataPath: DataPath): readonly FormFieldError[] {
    const componentIds = fieldComponentIds.get(dataPath)
    if (componentIds === undefined) {
      return []
    }
    const componentStates = getEffectiveComponentStates()
    const boundNodes = componentIds
      .map((id) => nodesById.get(id))
      .filter((item): item is IndexedNode => item !== undefined)
      .filter((item) => {
        const state = componentStates.get(item.node.id)
        return state?.visible === true && state.disabled === false
      })
      .sort((left, right) => left.order - right.order)

    if (boundNodes.length === 0) {
      clientErrors.delete(dataPath)
      return []
    }
    const value = getDataPathValue(values, dataPath)
    if (!value.found) {
      clientErrors.set(dataPath, makeClientError('DATA_BINDING_INVALID', 'The field value is unavailable.'))
      return [clientErrors.get(dataPath)!]
    }

    for (const { node } of boundNodes) {
      for (const validator of node.validation ?? []) {
        const error = validateValidator(validator, value.value, node.type === 'Upload')
        if (error !== undefined) {
          clientErrors.set(dataPath, error)
          return [error]
        }
      }
    }
    clientErrors.delete(dataPath)
    return []
  }

  function executeRuleBatches(changedPaths: readonly DataPath[] | undefined): void {
    let pendingPaths = changedPaths === undefined ? undefined : new Set(changedPaths)
    const executedRuleIds = new Set<StableId>()
    for (let batch = 0; batch < MAX_RULE_BATCHES; batch += 1) {
      const rules = (pendingPaths === undefined
        ? document.rules
        : document.rules.filter((rule) => pendingPaths!.has(rule.sourceDataPath)))
        .filter((rule) => !executedRuleIds.has(rule.id))
      if (rules.length === 0) {
        return
      }
      const batchValues = values
      const scheduledEffects: RuleEffect[] = []
      for (const rule of rules) {
        executedRuleIds.add(rule.id)
        const effects = selectRuleEffects(rule, batchValues)
        if (effects !== undefined) {
          scheduledEffects.push(...effects)
        }
      }
      const nextPaths = new Set<DataPath>()
      for (const effect of scheduledEffects) {
        if (effect.type === 'setVisible') {
          const settings = componentSettings.get(effect.targetComponentId)
          if (settings !== undefined) {
            settings.visible = effect.value
          }
          continue
        }
        if (effect.type === 'setDisabled') {
          const settings = componentSettings.get(effect.targetComponentId)
          if (settings !== undefined) {
            settings.disabled = effect.value
          }
          continue
        }
        if (effect.type === 'setValue') {
          const before = getDataPathValue(values, effect.targetDataPath)
          const updated = setDataPathValue(values, effect.targetDataPath, effect.value)
          if (!updated.ok) {
            reportConfigurationProblem('RULE_INVALID', 'A rule setValue target is unavailable at runtime.', effect.targetDataPath)
            break
          }
          const incompatibleComponentId = findIncompatibleBoundComponent(effect.targetDataPath, updated.value)
          if (incompatibleComponentId !== undefined) {
            reportConfigurationProblem(
              'DATA_BINDING_INVALID',
              'A rule setValue value is incompatible with the bound component type.',
              effect.targetDataPath,
              incompatibleComponentId,
            )
            break
          }
          if (before.found && !equalJsonValue(before.value, effect.value)) {
            values = updated.value as Record<string, JsonValue>
            serverErrors.delete(effect.targetDataPath)
            nextPaths.add(effect.targetDataPath)
          }
        }
      }
      if (nextPaths.size === 0) {
        return
      }
      pendingPaths = nextPaths
    }
    reportConfigurationProblem('RULE_EXECUTION_LIMIT', 'Rule execution exceeded the v1 limit of 20 batches and was stopped.')
  }

  function selectRuleEffects(
    rule: NormalizedA2UIFormDocumentV1['rules'][number],
    batchValues: Readonly<Record<string, JsonValue>>,
  ): readonly RuleEffect[] | undefined {
    const condition = evaluateCondition(rule.when, batchValues)
    for (const path of condition.missingPaths) {
      reportRuntimeDiagnostic('RULE_PATH_NOT_FOUND', 'A rule condition referenced a path that is unavailable at runtime.', path)
    }
    const effects = condition.value ? rule.then : (rule.else ?? [])
    for (const effect of effects) {
      if (effect.type === 'setValue') {
        const updated = setDataPathValue(batchValues, effect.targetDataPath, effect.value)
        if (!updated.ok) {
          reportConfigurationProblem('RULE_INVALID', 'A rule target dataPath is unavailable.', effect.targetDataPath)
          return undefined
        }
        const incompatibleComponentId = findIncompatibleBoundComponent(effect.targetDataPath, updated.value)
        if (incompatibleComponentId !== undefined) {
          reportConfigurationProblem(
            'DATA_BINDING_INVALID',
            'A rule setValue value is incompatible with the bound component type.',
            effect.targetDataPath,
            incompatibleComponentId,
          )
          return undefined
        }
      } else if (!nodesById.has(effect.targetComponentId)) {
        reportConfigurationProblem('RULE_INVALID', 'A rule target component is unavailable.', undefined, effect.targetComponentId)
        return undefined
      }
    }
    return effects
  }

  function evaluateCondition(
    condition: Condition,
    stateValues: Readonly<Record<string, JsonValue>>,
  ): { readonly value: boolean; readonly missingPaths: readonly DataPath[] } {
    if ('path' in condition) {
      const current = getDataPathValue(stateValues, condition.path)
      if (!current.found) {
        return { value: false, missingPaths: [condition.path] }
      }
      if (condition.op === 'exists') {
        return { value: true, missingPaths: [] }
      }
      if (condition.op === 'isEmpty') {
        return { value: isEmptyValue(current.value, isUploadDataPath(condition.path)), missingPaths: [] }
      }
      switch (condition.op) {
        case 'equals':
          return { value: equalJsonValue(current.value, condition.value), missingPaths: [] }
        case 'notEquals':
          return { value: !equalJsonValue(current.value, condition.value), missingPaths: [] }
        case 'in':
        case 'notIn': {
          if (!Array.isArray(condition.value)) {
            return { value: false, missingPaths: [] }
          }
          const includes = condition.value.some((item) => equalJsonValue(current.value, item))
          return { value: condition.op === 'in' ? includes : !includes, missingPaths: [] }
        }
        case 'greaterThan':
        case 'greaterThanOrEqual':
        case 'lessThan':
        case 'lessThanOrEqual': {
          const comparison = compareRuleValues(current.value, condition.value)
          if (comparison === undefined) {
            return { value: false, missingPaths: [] }
          }
          switch (condition.op) {
            case 'greaterThan':
              return { value: comparison > 0, missingPaths: [] }
            case 'greaterThanOrEqual':
              return { value: comparison >= 0, missingPaths: [] }
            case 'lessThan':
              return { value: comparison < 0, missingPaths: [] }
            default:
              return { value: comparison <= 0, missingPaths: [] }
          }
        }
      }
    }
    if (condition.op === 'and') {
      const missingPaths: DataPath[] = []
      for (const child of condition.args) {
        const result = evaluateCondition(child, stateValues)
        missingPaths.push(...result.missingPaths)
        if (!result.value) {
          return { value: false, missingPaths }
        }
      }
      return { value: true, missingPaths }
    }
    if (condition.op === 'or') {
      const missingPaths: DataPath[] = []
      for (const child of condition.args) {
        const result = evaluateCondition(child, stateValues)
        missingPaths.push(...result.missingPaths)
        if (result.value) {
          return { value: true, missingPaths }
        }
      }
      return { value: false, missingPaths }
    }
    if (condition.op === 'not') {
      const result = evaluateCondition(condition.arg, stateValues)
      return { value: !result.value, missingPaths: result.missingPaths }
    }
    return { value: false, missingPaths: [] }
  }

  function isUploadDataPath(dataPath: DataPath): boolean {
    return (fieldComponentIds.get(dataPath) ?? []).some((componentId) => nodesById.get(componentId)?.node.type === 'Upload')
  }

  function validateRuntimeRuleReferences(): void {
    const graph = new Map<DataPath, Set<DataPath>>()
    for (const rule of document.rules) {
      if (!getDataPathValue(values, rule.sourceDataPath).found) {
        reportConfigurationProblem('RULE_INVALID', 'A rule source dataPath is unavailable.', rule.sourceDataPath)
      }
      for (const path of conditionPaths(rule.when)) {
        if (!getDataPathValue(values, path).found) {
          reportConfigurationProblem('RULE_INVALID', 'A rule condition dataPath is unavailable.', path)
        }
      }
      for (const effect of [...rule.then, ...(rule.else ?? [])]) {
        if (effect.type === 'setValue') {
          const updated = setDataPathValue(values, effect.targetDataPath, effect.value)
          if (!updated.ok) {
            reportConfigurationProblem('RULE_INVALID', 'A rule target dataPath is unavailable.', effect.targetDataPath)
          } else {
            const incompatibleComponentId = findIncompatibleBoundComponent(effect.targetDataPath, updated.value)
            if (incompatibleComponentId !== undefined) {
              reportConfigurationProblem(
                'DATA_BINDING_INVALID',
                'A rule setValue value is incompatible with the bound component type.',
                effect.targetDataPath,
                incompatibleComponentId,
              )
            }
          }
          const edges = graph.get(rule.sourceDataPath) ?? new Set<DataPath>()
          edges.add(effect.targetDataPath)
          graph.set(rule.sourceDataPath, edges)
        } else if (!nodesById.has(effect.targetComponentId)) {
          reportConfigurationProblem('RULE_INVALID', 'A rule target component is unavailable.', undefined, effect.targetComponentId)
        }
      }
    }
    if (hasCycle(graph)) {
      reportConfigurationProblem('RULE_INVALID', 'setValue rules create a cyclic data dependency.')
    }
  }

  function findIncompatibleBoundComponent(
    targetDataPath: DataPath,
    candidateValues: Readonly<Record<string, JsonValue>>,
  ): StableId | undefined {
    for (const [boundDataPath, componentIds] of fieldComponentIds) {
      if (!dataPathsOverlap(boundDataPath, targetDataPath)) {
        continue
      }
      const candidateValue = getDataPathValue(candidateValues, boundDataPath)
      for (const componentId of componentIds) {
        const node = nodesById.get(componentId)?.node
        if (node !== undefined && (!candidateValue.found || !isCompatibleBoundValue(node, candidateValue.value))) {
          return componentId
        }
      }
    }
    return undefined
  }

  function projectSubmissionData(): Readonly<Record<string, JsonValue>> {
    let projected = cloneJsonValue(values) as Record<string, JsonValue>
    const states = getEffectiveComponentStates()
    const hiddenPaths = [...fieldComponentIds.entries()]
      .filter(([, componentIds]) => componentIds.every((id) => states.get(id)?.visible !== true))
      .map(([path]) => path)
      .sort(compareDataPathsForRemoval)

    for (const dataPath of hiddenPaths) {
      const withoutPath = removeDataPathValue(projected, dataPath)
      if (withoutPath.ok) {
        projected = withoutPath.value as Record<string, JsonValue>
      }
    }
    return freezeSnapshot(projected)
  }

  function getEffectiveComponentStates(): Map<StableId, FormComponentState> {
    const states = new Map<StableId, FormComponentState>()
    for (const { node, parentId } of indexedNodes) {
      const settings = componentSettings.get(node.id) ?? { visible: false, disabled: true }
      const parent = parentId === undefined ? undefined : states.get(parentId)
      states.set(node.id, {
        visible: settings.visible && (parent?.visible ?? true),
        disabled: settings.disabled || (parent?.disabled ?? false) || invalidComponents.has(node.id),
      })
    }
    return states
  }

  function refreshSnapshot(): void {
    const componentStates = getEffectiveComponentStates()
    reconcileInactiveClientErrors(componentStates)
    const fields: Record<string, FormFieldState> = {}
    const fieldErrors: Record<string, readonly FormFieldError[]> = {}
    const fieldSummary: FormErrorSummaryItem[] = []
    for (const [dataPath, componentIds] of fieldComponentIds) {
      const value = getDataPathValue(values, dataPath)
      if (!value.found) {
        continue
      }
      const visible = componentIds.some((id) => componentStates.get(id)?.visible === true)
      const interactive = componentIds.some((id) => {
        const state = componentStates.get(id)
        return state?.visible === true && state.disabled === false
      })
      const fieldError = clientErrors.get(dataPath)
      const errors = [...(serverErrors.get(dataPath) ?? []), ...(fieldError === undefined ? [] : [fieldError])]
      if (errors.length > 0) {
        fieldErrors[dataPath] = errors
        if (showErrorSummary && visible) {
          fieldSummary.push({ ...errors[0]!, path: dataPath })
        }
      }
      const initial = getDataPathValue(initialValues, dataPath)
      fields[dataPath] = {
        value: cloneJsonValue(value.value),
        touched: touchedPaths.has(dataPath),
        dirty: !initial.found || !equalJsonValue(initial.value, value.value),
        visible,
        disabled: !interactive,
        interactive,
        errors,
      }
    }
    const components = Object.fromEntries(componentStates.entries()) as Record<string, FormComponentState>
    const summary = showErrorSummary ? [...fieldSummary, ...formErrors] : [...formErrors]
    snapshot = freezeSnapshot({
      values: cloneJsonValue(values) as Readonly<Record<string, JsonValue>>,
      fields,
      components,
      errors: { fieldErrors, formErrors: [...formErrors], summary },
      diagnostics: [...diagnostics],
      submission: { ...submission, ...(submission.result === undefined ? {} : { result: { ...submission.result } }) },
      showErrorSummary,
      canSubmit: !blockingConfiguration && submission.status !== 'submitting',
    })
  }

  function notify(): void {
    for (const listener of listeners) {
      listener()
    }
  }

  function reconcileInactiveClientErrors(componentStates: ReadonlyMap<StableId, FormComponentState>): void {
    for (const dataPath of clientErrors.keys()) {
      const interactive = (fieldComponentIds.get(dataPath) ?? []).some((componentId) => {
        const state = componentStates.get(componentId)
        return state?.visible === true && state.disabled === false
      })
      if (!interactive) {
        clientErrors.delete(dataPath)
      }
    }
  }

  function reportConfigurationProblem(
    code: Extract<FormRuntimeDiagnosticCode, 'COMPONENT_UNSUPPORTED' | 'DATA_BINDING_INVALID' | 'RULE_INVALID' | 'RULE_EXECUTION_LIMIT'>,
    message: string,
    path?: DataPath,
    componentId?: StableId,
  ): void {
    blockingConfiguration = true
    reportRuntimeDiagnostic(code, message, path, componentId)
  }

  function reportRuntimeDiagnostic(
    code: FormRuntimeDiagnosticCode,
    message: string,
    path?: DataPath,
    componentId?: StableId,
  ): void {
    if (diagnostics.some((item) => item.code === code && item.message === message && item.path === path && item.componentId === componentId)) {
      return
    }
    diagnostics.push({
      code,
      message,
      ...(path === undefined ? {} : { path }),
      ...(componentId === undefined ? {} : { componentId }),
    })
  }
}

function indexNodes(root: ComponentNode): readonly IndexedNode[] {
  const nodes: IndexedNode[] = []
  const visit = (node: ComponentNode, parentId: StableId | undefined): void => {
    nodes.push({ node, ...(parentId === undefined ? {} : { parentId }), order: nodes.length })
    for (const child of node.children) {
      visit(child, node.id)
    }
  }
  visit(root, undefined)
  return nodes
}

function initialVisible(node: ComponentNode): boolean {
  return !('visible' in node.props) || node.props.visible !== false
}

function initialDisabled(node: ComponentNode): boolean {
  return 'disabled' in node.props && node.props.disabled === true
}

function validateValidator(validator: Validator, value: JsonValue, isUpload: boolean): FormFieldError | undefined {
  switch (validator.type) {
    case 'required':
      return isEmptyValue(value, isUpload) ? makeClientError(validator.code ?? 'FIELD_REQUIRED', validator.message ?? 'This field is required.') : undefined
    case 'minLength':
      return typeof value === 'string' && value.length < validator.value
        ? makeClientError(validator.code ?? 'STRING_TOO_SHORT', validator.message ?? `Enter at least ${validator.value} characters.`)
        : undefined
    case 'maxLength':
      return typeof value === 'string' && value.length > validator.value
        ? makeClientError(validator.code ?? 'STRING_TOO_LONG', validator.message ?? `Enter no more than ${validator.value} characters.`)
        : undefined
    case 'minItems':
      return Array.isArray(value) && value.length < validator.value
        ? makeClientError(validator.code ?? 'ARRAY_TOO_SHORT', validator.message ?? `Select at least ${validator.value} item(s).`)
        : undefined
    case 'maxItems':
      return Array.isArray(value) && value.length > validator.value
        ? makeClientError(validator.code ?? 'ARRAY_TOO_LONG', validator.message ?? `Select no more than ${validator.value} item(s).`)
        : undefined
    case 'minimum':
      return typeof value === 'number' && value < validator.value
        ? makeClientError(validator.code ?? 'NUMBER_TOO_SMALL', validator.message ?? `Enter a value of at least ${validator.value}.`)
        : undefined
    case 'maximum':
      return typeof value === 'number' && value > validator.value
        ? makeClientError(validator.code ?? 'NUMBER_TOO_LARGE', validator.message ?? `Enter a value no greater than ${validator.value}.`)
        : undefined
    case 'integer':
      return typeof value === 'number' && !Number.isInteger(value)
        ? makeClientError(validator.code ?? 'INTEGER_REQUIRED', validator.message ?? 'Enter a whole number.')
        : undefined
    case 'pattern':
      if (typeof value !== 'string') {
        return undefined
      }
      try {
        return new RegExp(validator.value, 'u').test(value)
          ? undefined
          : makeClientError(validator.code ?? 'PATTERN_MISMATCH', validator.message ?? 'Enter a value in the expected format.')
      } catch {
        return makeClientError(validator.code ?? 'PATTERN_MISMATCH', validator.message ?? 'Enter a value in the expected format.')
      }
  }
}

function makeClientError(code: string, message: string): FormFieldError {
  return { code, message, source: 'client' }
}

function toSummaryError(code: string, message: string, retryable: boolean, componentId?: StableId): FormErrorSummaryItem {
  return {
    code,
    message,
    source: 'server',
    ...(componentId === undefined ? {} : { componentId }),
    retryable,
  }
}

function isEmptyValue(value: JsonValue, isUpload: boolean): boolean {
  if (value === null) {
    return true
  }
  if (typeof value === 'string') {
    return value.trim().length === 0
  }
  if (Array.isArray(value)) {
    if (!isUpload) {
      return value.length === 0
    }
    return !value.some((item) => isRecord(item) && item.status === 'uploaded')
  }
  return false
}

function compareRuleValues(left: JsonValue, right: JsonValue): number | undefined {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left > right ? 1 : -1
  }
  if (typeof left === 'string' && typeof right === 'string' && isIsoDate(left) && isIsoDate(right)) {
    return left === right ? 0 : left > right ? 1 : -1
  }
  return undefined
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const [year, month, day] = value.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) {
    return false
  }
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function conditionPaths(condition: Condition): readonly DataPath[] {
  if ('path' in condition) {
    return [condition.path]
  }
  if ('args' in condition) {
    return condition.args.flatMap(conditionPaths)
  }
  return conditionPaths(condition.arg)
}

function compareDataPathsForRemoval(left: DataPath, right: DataPath): number {
  const leftParent = left.slice(0, left.lastIndexOf('/'))
  const rightParent = right.slice(0, right.lastIndexOf('/'))
  if (leftParent === rightParent) {
    const leftSegment = left.slice(left.lastIndexOf('/') + 1)
    const rightSegment = right.slice(right.lastIndexOf('/') + 1)
    if (/^(0|[1-9]\d*)$/.test(leftSegment) && /^(0|[1-9]\d*)$/.test(rightSegment)) {
      return Number(rightSegment) - Number(leftSegment)
    }
  }
  return right.split('/').length - left.split('/').length
}

function hasCycle(graph: ReadonlyMap<DataPath, ReadonlySet<DataPath>>): boolean {
  const visiting = new Set<DataPath>()
  const visited = new Set<DataPath>()
  const visit = (dataPath: DataPath): boolean => {
    if (visiting.has(dataPath)) {
      return true
    }
    if (visited.has(dataPath)) {
      return false
    }
    visiting.add(dataPath)
    for (const target of graph.get(dataPath) ?? []) {
      if (visit(target)) {
        return true
      }
    }
    visiting.delete(dataPath)
    visited.add(dataPath)
    return false
  }
  return [...graph.keys()].some(visit)
}

function withoutRequestId(request: FormSubmitRequest): Omit<FormSubmitRequest, 'requestId'> {
  const { requestId: _requestId, ...retryRequest } = request
  return {
    ...retryRequest,
    data: cloneJsonValue(request.data) as Readonly<Record<string, JsonValue>>,
  }
}

let fallbackId = 0

function createRuntimeId(prefix: string): StableId {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  fallbackId += 1
  return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`
}

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function freezeSnapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value)) {
    freezeSnapshot(child)
  }
  return Object.freeze(value)
}
