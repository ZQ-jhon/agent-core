import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { UploadValue } from './bound-value.ts'
import { getComponentRegistration } from './registry.ts'
import { ComponentRenderBoundary, UnsupportedComponentPlaceholder } from './safe-rendering.tsx'
import { useA2UIFormState } from './use-form-state.ts'
import type {
  A2UIFormController,
  A2UIFormState,
  FormActionResult,
  FormComponentState,
  FormFieldError,
  FormFieldState,
} from './form-state.ts'
import type { SchemaDiagnostic } from './errors.ts'
import type {
  ActionDefinition,
  ButtonNode,
  CheckboxGroupNode,
  ComponentNode,
  DataPath,
  DatePickerNode,
  FormNode,
  JsonValue,
  MarkdownNode,
  NormalizedA2UIFormDocumentV1,
  NumberInputNode,
  RadioGroupNode,
  SectionNode,
  SelectNode,
  SwitchNode,
  TextAreaNode,
  TextInputNode,
  UploadNode,
} from './types.ts'

export interface A2UIUploadRequest {
  readonly file: File
  readonly componentId: string
  readonly dataPath: DataPath
  readonly actionId: string
}

/**
 * Hosts own the upload transport. A completed upload returns the only value
 * shape that may be written into an Upload field.
 */
export type A2UIUploadHandler = (request: A2UIUploadRequest) => Promise<UploadValue>

export interface A2UIFormRendererProps {
  readonly document: NormalizedA2UIFormDocumentV1
  readonly controller: A2UIFormController
  readonly onActionResult?: (result: FormActionResult) => void
  readonly onDiagnostic?: (diagnostic: SchemaDiagnostic) => void
  readonly onUpload?: A2UIUploadHandler
}

interface FieldAccessibility {
  readonly controlId: string
  readonly describedBy?: string
  readonly errorMessage?: string
  readonly invalid?: boolean
  readonly required?: boolean
}

interface FieldShellProps {
  readonly componentId: string
  readonly controlId: string
  readonly label: string
  readonly helpText?: string
  readonly required: boolean
  readonly disabled: boolean
  readonly readOnly?: boolean
  readonly errors: readonly FormFieldError[]
  readonly group?: boolean
  readonly extraDescription?: {
    readonly id: string
    readonly content: ReactNode
  }
  readonly children: (accessibility: FieldAccessibility) => ReactNode
}

interface ComponentIndexes {
  readonly componentByDataPath: ReadonlyMap<DataPath, string>
  readonly sectionAncestors: ReadonlyMap<string, readonly string[]>
  readonly focusTriggerByTarget: ReadonlyMap<string, string>
  readonly buttonById: ReadonlyMap<string, ButtonNode>
  readonly submitButtons: readonly ButtonNode[]
  readonly collapsedByDefault: Readonly<Record<string, boolean>>
}

const EMPTY_FIELD_STATE: FormFieldState = {
  value: null,
  touched: false,
  dirty: false,
  visible: false,
  disabled: true,
  interactive: false,
  errors: [],
}

const HIDDEN_COMPONENT_STATE: FormComponentState = {
  visible: false,
  disabled: true,
}

const supportedAutoCompleteTokens = new Set([
  'off',
  'on',
  'name',
  'honorific-prefix',
  'given-name',
  'additional-name',
  'family-name',
  'honorific-suffix',
  'nickname',
  'username',
  'new-password',
  'current-password',
  'one-time-code',
  'organization-title',
  'organization',
  'street-address',
  'address-line1',
  'address-line2',
  'address-line3',
  'address-level1',
  'address-level2',
  'address-level3',
  'address-level4',
  'country',
  'country-name',
  'postal-code',
  'cc-name',
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'transaction-currency',
  'bday',
  'sex',
  'tel',
  'tel-national',
  'tel-country-code',
  'email',
  'impp',
  'url',
  'photo',
  'webauthn',
])

/**
 * Safely renders the compiled v1 component allowlist. Schema data selects
 * component instances only; it never selects imports, callbacks, styles, or
 * executable expressions.
 */
export function A2UIFormRenderer({
  document,
  controller,
  onActionResult,
  onDiagnostic,
  onUpload,
}: A2UIFormRendererProps) {
  const snapshot = useA2UIFormState(controller)
  const indexes = useMemo(
    () => buildComponentIndexes(document.root, document.actions, document.rules),
    [document],
  )
  const [collapsedSections, setCollapsedSections] = useState<Readonly<Record<string, boolean>>>(
    indexes.collapsedByDefault,
  )
  const controls = useRef(new Map<string, HTMLElement>())
  const errorSummary = useRef<HTMLElement | null>(null)
  const hadErrorSummary = useRef(false)
  const actionTrigger = useRef<HTMLElement | null>(null)
  const lastFocusedComponent = useRef<string | undefined>(undefined)
  const restoringFocus = useRef(false)
  const pendingFocusTimer = useRef<number | undefined>(undefined)
  const [focusAnnouncement, setFocusAnnouncement] = useState<string | undefined>()

  useEffect(() => () => {
    if (pendingFocusTimer.current !== undefined) {
      window.clearTimeout(pendingFocusTimer.current)
    }
  }, [])

  useEffect(() => {
    setCollapsedSections(indexes.collapsedByDefault)
  }, [document.formId, document.revision, indexes.collapsedByDefault])

  useEffect(() => {
    const shouldFocus = snapshot.showErrorSummary && snapshot.errors.summary.length > 0
    if (shouldFocus && !hadErrorSummary.current) {
      errorSummary.current?.focus()
    }
    hadErrorSummary.current = shouldFocus
  }, [snapshot.errors.summary.length, snapshot.showErrorSummary])

  useEffect(() => {
    const hiddenComponentId = lastFocusedComponent.current
    if (hiddenComponentId === undefined || componentState(hiddenComponentId).visible) {
      return
    }
    lastFocusedComponent.current = undefined
    const triggerComponentId = indexes.focusTriggerByTarget.get(hiddenComponentId)
    if (triggerComponentId === undefined) {
      setFocusAnnouncement('A field was hidden.')
      return
    }
    setFocusAnnouncement('A field was hidden. Focus returned to the control that changed it.')
    focusComponent(triggerComponentId, true)
  }, [indexes.focusTriggerByTarget, snapshot.components])

  function componentState(componentId: string): FormComponentState {
    return snapshot.components[componentId] ?? HIDDEN_COMPONENT_STATE
  }

  function fieldState(dataPath: DataPath): FormFieldState {
    return snapshot.fields[dataPath] ?? EMPTY_FIELD_STATE
  }

  function registerControl(componentId: string, element: HTMLElement | null): void {
    if (element === null) {
      controls.current.delete(componentId)
      return
    }
    controls.current.set(componentId, element)
  }

  function focusComponent(componentId: string, preserveAnnouncement = false): void {
    const sections = indexes.sectionAncestors.get(componentId) ?? []
    if (sections.length > 0) {
      setCollapsedSections((previous) => {
        const next = { ...previous }
        for (const sectionId of sections) {
          next[sectionId] = false
        }
        return next
      })
    }
    if (pendingFocusTimer.current !== undefined) {
      window.clearTimeout(pendingFocusTimer.current)
    }
    pendingFocusTimer.current = window.setTimeout(() => {
      pendingFocusTimer.current = undefined
      const control = controls.current.get(componentId)
      if (control === undefined) {
        return
      }
      restoringFocus.current = preserveAnnouncement
      control.focus()
    }, 0)
  }

  function reportActionResult(result: FormActionResult): void {
    onActionResult?.(result)
  }

  function dispatchAction(actionId: string, sourceComponentId: string): void {
    void controller.dispatchAction(actionId, sourceComponentId).then(reportActionResult)
  }

  function dispatchConfirmation(): void {
    void controller.confirmPendingAction().then(reportActionResult)
  }

  function renderNode(node: ComponentNode): ReactNode {
    const registration = getComponentRegistration(node.type)
    if (registration === undefined) {
      return (
        <UnsupportedComponentPlaceholder
          componentId={node.id}
          componentType={String(node.type)}
          key={node.id}
        />
      )
    }

    const state = componentState(node.id)
    if (!state.visible) {
      return null
    }

    return (
      <ComponentRenderBoundary
        componentId={node.id}
        componentType={node.type}
        key={node.id}
        onDiagnostic={onDiagnostic}
        revision={document.revision}
      >
        {renderRegisteredNode(node, state)}
      </ComponentRenderBoundary>
    )
  }

  function renderRegisteredNode(node: ComponentNode, state: FormComponentState): ReactNode {
    switch (node.type) {
      case 'Form':
        return renderForm(node, state)
      case 'Section':
        return renderSection(node, state)
      case 'TextInput':
        return renderTextInput(node, state)
      case 'TextArea':
        return renderTextArea(node, state)
      case 'NumberInput':
        return renderNumberInput(node, state)
      case 'Select':
        return renderSelect(node, state)
      case 'RadioGroup':
        return renderRadioGroup(node, state)
      case 'CheckboxGroup':
        return renderCheckboxGroup(node, state)
      case 'DatePicker':
        return renderDatePicker(node, state)
      case 'Switch':
        return renderSwitch(node, state)
      case 'Upload':
        return renderUpload(node, state)
      case 'Button':
        return renderButton(node, state)
      case 'Alert':
        return <AlertComponent key={node.id + '-' + String(document.revision)} node={node} />
      case 'Markdown':
        return <MarkdownComponent node={node} />
    }
  }

  function renderForm(node: FormNode, state: FormComponentState): ReactNode {
    const titleId = domId(node.id, 'title')
    const descriptionId = domId(node.id, 'description')
    const displayChildren = node.children.filter((child) => child.type === 'Alert' || child.type === 'Markdown')
    const flowChildren = node.children.filter((child) => child.type !== 'Alert' && child.type !== 'Markdown')
    const formDisabled = state.disabled

    function submit(event: FormEvent<HTMLFormElement>): void {
      event.preventDefault()
      if (snapshot.submission.status === 'submitting' || formDisabled) {
        return
      }

      const submitter = (event.nativeEvent as SubmitEvent).submitter
      const sourceComponentId = submitter instanceof HTMLElement
        ? submitter.dataset.a2uiComponentId
        : undefined
      const source = sourceComponentId === undefined
        ? undefined
        : indexes.buttonById.get(sourceComponentId)

      if (source !== undefined) {
        const actionId = source.action?.actionId
        const action = actionId === undefined ? undefined : actionById(document.actions, actionId)
        if (action?.type === 'submit') {
          dispatchAction(action.id, source.id)
        }
        return
      }

      if (node.props.submitOnEnter === true && indexes.submitButtons.length === 1) {
        const onlyButton = indexes.submitButtons[0]!
        const actionId = onlyButton.action?.actionId
        if (actionId !== undefined) {
          dispatchAction(actionId, onlyButton.id)
        }
      }
    }

    function keyDown(event: KeyboardEvent<HTMLFormElement>): void {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLTextAreaElement
        || target instanceof HTMLButtonElement
        || target instanceof HTMLAnchorElement
      ) {
        return
      }
      if (node.props.submitOnEnter !== true || indexes.submitButtons.length !== 1) {
        event.preventDefault()
      }
    }

    return (
      <form
        aria-busy={snapshot.submission.status === 'submitting' || undefined}
        aria-describedby={node.props.description === undefined ? undefined : descriptionId}
        aria-label={node.props.title === undefined ? 'A2UI form' : undefined}
        aria-labelledby={node.props.title === undefined ? undefined : titleId}
        data-a2ui-component-id={node.id}
        noValidate
        onFocusCapture={(event) => {
          const target = event.target
          if (!(target instanceof HTMLElement)) {
            return
          }
          const componentId = target.dataset.a2uiComponentId
          if (componentId !== undefined) {
            lastFocusedComponent.current = componentId
            if (restoringFocus.current) {
              restoringFocus.current = false
            } else {
              setFocusAnnouncement(undefined)
            }
          }
        }}
        onKeyDown={keyDown}
        onSubmit={submit}
      >
        {node.props.title === undefined ? null : <h1 id={titleId}>{node.props.title}</h1>}
        {node.props.description === undefined ? null : <p id={descriptionId}>{node.props.description}</p>}
        {displayChildren.map(renderNode)}
        <ErrorSummary
          componentByDataPath={indexes.componentByDataPath}
          focusComponent={focusComponent}
          summaryRef={errorSummary}
          summary={snapshot.errors.summary}
          titleId={domId(node.id, 'error-summary-title')}
          visible={snapshot.showErrorSummary}
        />
        {focusAnnouncement === undefined ? null : <p aria-live="polite" role="status">{focusAnnouncement}</p>}
        {flowChildren.map(renderNode)}
        <SubmissionFeedback snapshot={snapshot} />
        <ConfirmationDialog
          actionId={snapshot.submission.actionId}
          confirmation={
            snapshot.submission.sourceComponentId === undefined
              ? undefined
              : indexes.buttonById.get(snapshot.submission.sourceComponentId)?.action?.confirm
          }
          onConfirm={dispatchConfirmation}
          onDismiss={() => {
            controller.cancelPendingAction()
            actionTrigger.current?.focus()
          }}
          snapshot={snapshot}
        />
      </form>
    )
  }

  function renderSection(node: SectionNode, state: FormComponentState): ReactNode {
    const contentId = domId(node.id, 'content')
    const descriptionId = domId(node.id, 'description')
    const collapsible = node.props.collapsible === true
    const collapsed = collapsible && collapsedSections[node.id] === true
    const disabled = state.disabled || snapshot.submission.status === 'submitting'

    return (
      <fieldset data-a2ui-component-id={node.id} disabled={disabled}>
        <legend>
          {collapsible ? (
            <button
              aria-controls={contentId}
              aria-expanded={!collapsed}
              onClick={() => {
                setCollapsedSections((previous) => ({
                  ...previous,
                  [node.id]: !collapsed,
                }))
              }}
              type="button"
            >
              {node.props.title}
            </button>
          ) : (
            node.props.title
          )}
        </legend>
        {node.props.description === undefined ? null : <p id={descriptionId}>{node.props.description}</p>}
        <div
          aria-describedby={node.props.description === undefined ? undefined : descriptionId}
          hidden={collapsed}
          id={contentId}
        >
          {node.children.map(renderNode)}
        </div>
      </fieldset>
    )
  }

  function renderTextInput(node: TextInputNode, state: FormComponentState): ReactNode {
    const field = fieldState(node.dataPath)
    const disabled = state.disabled || snapshot.submission.status === 'submitting'
    const autoComplete = supportedAutoComplete(node.props.autoComplete)
      ? node.props.autoComplete
      : undefined
    const ignoredAutoComplete = node.props.autoComplete !== undefined && autoComplete === undefined

    return (
      <FieldShell
        componentId={node.id}
        controlId={domId(node.id, 'control')}
        disabled={disabled}
        errors={field.errors}
        helpText={node.props.helpText}
        label={node.props.label}
        readOnly={node.props.readOnly}
        required={isRequired(node)}
      >
        {(accessibility) => (
          <>
            <input
              aria-describedby={accessibility.describedBy}
              aria-errormessage={accessibility.errorMessage}
              aria-invalid={accessibility.invalid}
              aria-readonly={node.props.readOnly || undefined}
              aria-required={accessibility.required}
              autoComplete={autoComplete}
              data-a2ui-component-id={node.id}
              disabled={disabled}
              id={accessibility.controlId}
              inputMode={node.props.inputMode}
              onBlur={() => {
                controller.blur(node.dataPath)
              }}
              onChange={(event) => {
                controller.setValue(node.dataPath, event.target.value)
              }}
              placeholder={node.props.placeholder}
              readOnly={node.props.readOnly}
              ref={(element) => {
                registerControl(node.id, element)
              }}
              type={inputTypeFor(node.props.inputMode)}
              value={asString(field.value)}
            />
            {ignoredAutoComplete ? (
              <p role="status">This autocomplete hint is not supported by the renderer.</p>
            ) : null}
          </>
        )}
      </FieldShell>
    )
  }

  function renderTextArea(node: TextAreaNode, state: FormComponentState): ReactNode {
    const field = fieldState(node.dataPath)
    const disabled = state.disabled || snapshot.submission.status === 'submitting'
    const rows = node.props.rows ?? 4

    return (
      <FieldShell
        componentId={node.id}
        controlId={domId(node.id, 'control')}
        disabled={disabled}
        errors={field.errors}
        helpText={node.props.helpText}
        label={node.props.label}
        required={isRequired(node)}
      >
        {(accessibility) => (
          <textarea
            aria-describedby={accessibility.describedBy}
            aria-errormessage={accessibility.errorMessage}
            aria-invalid={accessibility.invalid}
            aria-required={accessibility.required}
            data-a2ui-component-id={node.id}
            data-max-rows={node.props.maxRows}
            disabled={disabled}
            id={accessibility.controlId}
            onBlur={() => {
              controller.blur(node.dataPath)
            }}
            onChange={(event) => {
              controller.setValue(node.dataPath, event.target.value)
              resizeTextArea(event.currentTarget, node.props.maxRows)
            }}
            placeholder={node.props.placeholder}
            ref={(element) => {
              registerControl(node.id, element)
            }}
            rows={rows}
            value={asString(field.value)}
          />
        )}
      </FieldShell>
    )
  }

  function renderNumberInput(node: NumberInputNode, state: FormComponentState): ReactNode {
    const field = fieldState(node.dataPath)
    const disabled = state.disabled || snapshot.submission.status === 'submitting'
    const unitId = domId(node.id, 'unit')

    return (
      <FieldShell
        componentId={node.id}
        controlId={domId(node.id, 'control')}
        disabled={disabled}
        errors={field.errors}
        extraDescription={node.props.unit === undefined ? undefined : { id: unitId, content: node.props.unit }}
        helpText={node.props.helpText}
        label={node.props.label}
        required={isRequired(node)}
      >
        {(accessibility) => (
          <NumberInputControl
            accessibility={accessibility}
            disabled={disabled}
            field={field}
            node={node}
            onBlur={() => {
              controller.blur(node.dataPath)
            }}
            onValueChange={(value) => {
              controller.setValue(node.dataPath, value)
            }}
            registerControl={registerControl}
          />
        )}
      </FieldShell>
    )
  }

  function renderSelect(node: SelectNode, state: FormComponentState): ReactNode {
    const field = fieldState(node.dataPath)
    const disabled = state.disabled || snapshot.submission.status === 'submitting'
    const options = 'options' in node.props ? node.props.options : undefined
    const remoteDataSourceId = 'dataSourceId' in node.props ? node.props.dataSourceId : undefined
    const clearable = node.props.clearable !== false
    const selectedValue = field.value
    const selectedToken = isOptionValue(selectedValue) ? optionToken(selectedValue) : ''

    return (
      <FieldShell
        componentId={node.id}
        controlId={domId(node.id, 'control')}
        disabled={disabled}
        errors={field.errors}
        helpText={node.props.helpText}
        label={node.props.label}
        required={isRequired(node)}
      >
        {(accessibility) => (
          <>
            <select
              aria-busy={remoteDataSourceId === undefined ? undefined : true}
              aria-describedby={accessibility.describedBy}
              aria-errormessage={accessibility.errorMessage}
              aria-invalid={accessibility.invalid}
              aria-required={accessibility.required}
              data-a2ui-component-id={node.id}
              disabled={disabled || remoteDataSourceId !== undefined}
              id={accessibility.controlId}
              onBlur={() => {
                controller.blur(node.dataPath)
              }}
              onChange={(event) => {
                const selected = options?.find((option) => optionToken(option.value) === event.target.value)
                controller.setValue(node.dataPath, selected === undefined ? null : selected.value)
              }}
              ref={(element) => {
                registerControl(node.id, element)
              }}
              value={selectedToken}
            >
              <option disabled={!clearable} value="">
                {node.props.placeholder ?? 'Select an option'}
              </option>
              {options?.map((option) => (
                <option disabled={option.disabled} key={optionToken(option.value)} value={optionToken(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
            {remoteDataSourceId === undefined ? null : (
              <p role="status">
                Options from {remoteDataSourceId} require a host data-source adapter and are unavailable in this renderer.
              </p>
            )}
          </>
        )}
      </FieldShell>
    )
  }

  function renderRadioGroup(node: RadioGroupNode, state: FormComponentState): ReactNode {
    const field = fieldState(node.dataPath)
    const disabled = state.disabled || snapshot.submission.status === 'submitting'
    const controlId = domId(node.id, 'control')

    return (
      <FieldShell
        componentId={node.id}
        controlId={controlId}
        disabled={disabled}
        errors={field.errors}
        group
        helpText={node.props.helpText}
        label={node.props.label}
        required={isRequired(node)}
      >
        {() => (
          <div data-orientation={node.props.orientation ?? 'vertical'}>
            {node.props.options.map((option, index) => {
              const optionId = domId(node.id, 'option-' + String(index))
              return (
                <div key={optionToken(option.value)}>
                  <input
                    checked={Object.is(field.value, option.value)}
                    data-a2ui-component-id={node.id}
                    disabled={disabled || option.disabled}
                    id={optionId}
                    name={controlId}
                    onBlur={() => {
                      controller.blur(node.dataPath)
                    }}
                    onChange={() => {
                      controller.setValue(node.dataPath, option.value)
                    }}
                    ref={index === 0 ? (element) => registerControl(node.id, element) : undefined}
                    type="radio"
                  />
                  <label htmlFor={optionId}>{option.label}</label>
                </div>
              )
            })}
          </div>
        )}
      </FieldShell>
    )
  }

  function renderCheckboxGroup(node: CheckboxGroupNode, state: FormComponentState): ReactNode {
    const field = fieldState(node.dataPath)
    const disabled = state.disabled || snapshot.submission.status === 'submitting'
    const selectedValues = Array.isArray(field.value) ? field.value.filter(isOptionValue) : []

    return (
      <FieldShell
        componentId={node.id}
        controlId={domId(node.id, 'control')}
        disabled={disabled}
        errors={field.errors}
        group
        helpText={node.props.helpText}
        label={node.props.label}
        required={isRequired(node)}
      >
        {() => (
          <div data-orientation={node.props.orientation ?? 'vertical'}>
            {node.props.options.map((option, index) => {
              const optionId = domId(node.id, 'option-' + String(index))
              const checked = selectedValues.some((value) => Object.is(value, option.value))
              return (
                <div key={optionToken(option.value)}>
                  <input
                    checked={checked}
                    data-a2ui-component-id={node.id}
                    disabled={disabled || option.disabled}
                    id={optionId}
                    onBlur={() => {
                      controller.blur(node.dataPath)
                    }}
                    onChange={() => {
                      const next = checked
                        ? selectedValues.filter((value) => !Object.is(value, option.value))
                        : [...selectedValues, option.value]
                      controller.setValue(node.dataPath, next)
                    }}
                    ref={index === 0 ? (element) => registerControl(node.id, element) : undefined}
                    type="checkbox"
                  />
                  <label htmlFor={optionId}>{option.label}</label>
                </div>
              )
            })}
          </div>
        )}
      </FieldShell>
    )
  }

  function renderDatePicker(node: DatePickerNode, state: FormComponentState): ReactNode {
    const field = fieldState(node.dataPath)
    const disabled = state.disabled || snapshot.submission.status === 'submitting'

    return (
      <FieldShell
        componentId={node.id}
        controlId={domId(node.id, 'control')}
        disabled={disabled}
        errors={field.errors}
        helpText={node.props.helpText}
        label={node.props.label}
        required={isRequired(node)}
      >
        {(accessibility) => (
          <input
            aria-describedby={accessibility.describedBy}
            aria-errormessage={accessibility.errorMessage}
            aria-invalid={accessibility.invalid}
            aria-required={accessibility.required}
            data-a2ui-component-id={node.id}
            disabled={disabled}
            id={accessibility.controlId}
            max={node.props.maxDate}
            min={node.props.minDate}
            onBlur={() => {
              controller.blur(node.dataPath)
            }}
            onChange={(event) => {
              controller.setValue(node.dataPath, event.target.value === '' ? null : event.target.value)
            }}
            placeholder={node.props.placeholder}
            ref={(element) => {
              registerControl(node.id, element)
            }}
            type="date"
            value={asString(field.value)}
          />
        )}
      </FieldShell>
    )
  }

  function renderSwitch(node: SwitchNode, state: FormComponentState): ReactNode {
    const field = fieldState(node.dataPath)
    const disabled = state.disabled || snapshot.submission.status === 'submitting'
    const checked = field.value === true
    const stateLabel = checked ? node.props.onLabel : node.props.offLabel

    return (
      <FieldShell
        componentId={node.id}
        controlId={domId(node.id, 'control')}
        disabled={disabled}
        errors={field.errors}
        helpText={node.props.helpText}
        label={node.props.label}
        required={isRequired(node)}
      >
        {(accessibility) => (
          <>
            <input
              aria-checked={checked}
              aria-describedby={accessibility.describedBy}
              aria-errormessage={accessibility.errorMessage}
              aria-invalid={accessibility.invalid}
              aria-required={accessibility.required}
              checked={checked}
              data-a2ui-component-id={node.id}
              disabled={disabled}
              id={accessibility.controlId}
              onBlur={() => {
                controller.blur(node.dataPath)
              }}
              onChange={(event) => {
                controller.setValue(node.dataPath, event.target.checked)
              }}
              ref={(element) => {
                registerControl(node.id, element)
              }}
              role="switch"
              type="checkbox"
            />
            {stateLabel === undefined ? null : <span>{stateLabel}</span>}
          </>
        )}
      </FieldShell>
    )
  }

  function renderUpload(node: UploadNode, state: FormComponentState): ReactNode {
    const field = fieldState(node.dataPath)
    const disabled = state.disabled || snapshot.submission.status === 'submitting'

    return (
      <FieldShell
        componentId={node.id}
        controlId={domId(node.id, 'control')}
        disabled={disabled}
        errors={field.errors}
        helpText={node.props.helpText}
        label={node.props.label}
        required={isRequired(node)}
      >
        {(accessibility) => (
          <UploadControl
            accessibility={accessibility}
            controller={controller}
            disabled={disabled}
            field={field}
            node={node}
            onUpload={onUpload}
            registerControl={registerControl}
          />
        )}
      </FieldShell>
    )
  }

  function renderButton(node: ButtonNode, state: FormComponentState): ReactNode {
    const action = actionById(document.actions, node.action.actionId)
    const busy = snapshot.submission.status === 'submitting'
      && snapshot.submission.sourceComponentId === node.id
    const actionIsSupported = action?.type === 'submit' || action?.type === 'reset'
    const disabled = state.disabled || snapshot.submission.status === 'submitting' || !actionIsSupported
    const label = busy ? node.props.loadingLabel ?? node.props.label : node.props.label

    return (
      <div data-a2ui-component-id={node.id} data-variant={node.props.variant ?? 'secondary'}>
        <button
          aria-busy={busy || undefined}
          data-a2ui-action-id={node.action.actionId}
          data-a2ui-component-id={node.id}
          disabled={disabled}
          onClick={(event) => {
            actionTrigger.current = event.currentTarget
            if (action?.type !== 'submit') {
              event.preventDefault()
              if (action?.type === 'reset') {
                dispatchAction(action.id, node.id)
              }
            }
          }}
          type={action?.type === 'submit' ? 'submit' : 'button'}
        >
          {label}
        </button>
        {actionIsSupported ? null : (
          <p role="status">This action is not available in the current renderer.</p>
        )}
      </div>
    )
  }

  return <>{renderNode(document.root)}</>
}

function FieldShell({
  componentId,
  controlId,
  label,
  helpText,
  required,
  disabled,
  readOnly,
  errors,
  group = false,
  extraDescription,
  children,
}: FieldShellProps) {
  const helpId = domId(componentId, 'help')
  const errorId = domId(componentId, 'error')
  const firstError = errors[0]
  const describedBy = [
    helpText === undefined ? undefined : helpId,
    extraDescription?.id,
    firstError === undefined ? undefined : errorId,
  ].filter((value): value is string => value !== undefined).join(' ') || undefined
  const accessibility: FieldAccessibility = {
    controlId,
    ...(describedBy === undefined ? {} : { describedBy }),
    ...(firstError === undefined ? {} : { errorMessage: errorId, invalid: true }),
    ...(required ? { required: true } : {}),
  }

  const labelContent = (
    <>
      {label}
      {required ? <span> (required)</span> : null}
      {readOnly ? <span> (read only)</span> : null}
    </>
  )
  const messages = (
    <>
      {extraDescription === undefined ? null : <span id={extraDescription.id}>{extraDescription.content}</span>}
      {firstError === undefined ? null : <p id={errorId} role="alert">{firstError.message}</p>}
      {helpText === undefined ? null : <p id={helpId}>{helpText}</p>}
    </>
  )

  if (group) {
    return (
      <fieldset
        aria-describedby={accessibility.describedBy}
        aria-errormessage={accessibility.errorMessage}
        aria-invalid={accessibility.invalid}
        aria-required={accessibility.required}
        data-a2ui-component-id={componentId}
        disabled={disabled}
        id={controlId}
      >
        <legend>{labelContent}</legend>
        {children(accessibility)}
        {messages}
      </fieldset>
    )
  }

  return (
    <div data-a2ui-component-id={componentId}>
      <label htmlFor={controlId}>{labelContent}</label>
      {children(accessibility)}
      {messages}
    </div>
  )
}

interface NumberInputControlProps {
  readonly accessibility: FieldAccessibility
  readonly disabled: boolean
  readonly field: FormFieldState
  readonly node: NumberInputNode
  readonly onBlur: () => void
  readonly onValueChange: (value: number | null) => void
  readonly registerControl: (componentId: string, element: HTMLElement | null) => void
}

function NumberInputControl({
  accessibility,
  disabled,
  field,
  node,
  onBlur,
  onValueChange,
  registerControl,
}: NumberInputControlProps) {
  const initialDraft = numericDraft(field.value)
  const [draft, setDraft] = useState(initialDraft)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) {
      setDraft(numericDraft(field.value))
    }
  }, [field.value])

  function change(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.target.value
    setDraft(next)
    onValueChange(normalizeNumberDraft(next))
  }

  return (
    <input
      aria-describedby={accessibility.describedBy}
      aria-errormessage={accessibility.errorMessage}
      aria-invalid={accessibility.invalid}
      aria-required={accessibility.required}
      data-a2ui-component-id={node.id}
      data-step={node.props.step ?? 1}
      disabled={disabled}
      id={accessibility.controlId}
      inputMode="decimal"
      onBlur={() => {
        focused.current = false
        onValueChange(normalizeNumberDraft(draft))
        onBlur()
      }}
      onChange={change}
      onFocus={() => {
        focused.current = true
      }}
      placeholder={node.props.placeholder}
      ref={(element) => {
        registerControl(node.id, element)
      }}
      type="text"
      value={draft}
    />
  )
}

interface UploadControlProps {
  readonly accessibility: FieldAccessibility
  readonly controller: A2UIFormController
  readonly disabled: boolean
  readonly field: FormFieldState
  readonly node: UploadNode
  readonly onUpload?: A2UIUploadHandler
  readonly registerControl: (componentId: string, element: HTMLElement | null) => void
}

function UploadControl({
  accessibility,
  controller,
  disabled,
  field,
  node,
  onUpload,
  registerControl,
}: UploadControlProps) {
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const uploaded = uploadedValues(field.value)
  const maxFiles = node.props.maxFiles ?? 1
  const buttonLabel = node.props.buttonLabel ?? 'Choose file'

  async function selectFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) {
      return
    }
    if (uploaded.length >= maxFiles) {
      setMessage('The maximum number of files has already been selected.')
      return
    }
    if (node.props.maxSizeBytes !== undefined && file.size > node.props.maxSizeBytes) {
      setMessage('This file exceeds the allowed size.')
      return
    }
    if (onUpload === undefined) {
      setMessage('File uploads are not configured for this renderer.')
      return
    }

    setBusy(true)
    setMessage(undefined)
    try {
      const completed = await onUpload({
        file,
        componentId: node.id,
        dataPath: node.dataPath,
        actionId: node.action.actionId,
      })
      controller.setValue(node.dataPath, [...uploaded, completed])
    } catch {
      setMessage('The file could not be uploaded. Try again or remove it.')
    } finally {
      setBusy(false)
    }
  }

  function removeFile(index: number): void {
    controller.setValue(node.dataPath, uploaded.filter((_, currentIndex) => currentIndex !== index))
  }

  return (
    <>
      <input
        accept={node.props.accept?.join(',')}
        aria-hidden="true"
        disabled={disabled || busy}
        onChange={(event) => {
          void selectFile(event)
        }}
        ref={fileInput}
        style={{ display: 'none' }}
        tabIndex={-1}
        type="file"
      />
      <button
        aria-busy={busy || undefined}
        aria-describedby={accessibility.describedBy}
        aria-errormessage={accessibility.errorMessage}
        aria-invalid={accessibility.invalid}
        aria-label={node.props.label + ': ' + buttonLabel}
        aria-required={accessibility.required}
        data-a2ui-component-id={node.id}
        disabled={disabled || busy}
        id={accessibility.controlId}
        onClick={() => {
          fileInput.current?.click()
        }}
        ref={(element) => {
          registerControl(node.id, element)
        }}
        type="button"
      >
        {busy ? 'Uploading…' : buttonLabel}
      </button>
      {uploaded.length === 0 ? null : (
        <ul aria-label="Uploaded files">
          {uploaded.map((file, index) => (
            <li key={file.fileId}>
              <span>{file.name}</span>
              <span> ({formatFileSize(file.size)})</span>
              <button
                aria-label={'Remove ' + file.name}
                disabled={disabled || busy}
                onClick={() => {
                  removeFile(index)
                }}
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {message === undefined ? null : <p role="status">{message}</p>}
    </>
  )
}

function AlertComponent({ node }: { readonly node: Extract<ComponentNode, { readonly type: 'Alert' }> }) {
  const [dismissed, setDismissed] = useState(false)
  const variant = node.props.variant ?? 'info'
  const dynamicRole = variant === 'error' ? 'alert' : variant === 'success' ? 'status' : undefined

  if (dismissed) {
    return null
  }

  return (
    <section data-a2ui-component-id={node.id} data-variant={variant} role={dynamicRole}>
      {node.props.title === undefined ? null : <h2>{node.props.title}</h2>}
      <p>{node.props.message}</p>
      {node.props.dismissible === true ? (
        <button
          aria-label={'Dismiss ' + (node.props.title ?? node.props.message)}
          onClick={() => {
            setDismissed(true)
          }}
          type="button"
        >
          Dismiss
        </button>
      ) : null}
    </section>
  )
}

function MarkdownComponent({ node }: { readonly node: MarkdownNode }) {
  return (
    <section aria-label={node.props.ariaLabel} data-a2ui-component-id={node.id}>
      {renderMarkdownBlocks(node.props.content)}
    </section>
  )
}

interface ErrorSummaryProps {
  readonly componentByDataPath: ReadonlyMap<DataPath, string>
  readonly focusComponent: (componentId: string) => void
  readonly summaryRef: { readonly current: HTMLElement | null }
  readonly summary: A2UIFormState['errors']['summary']
  readonly titleId: string
  readonly visible: boolean
}

function ErrorSummary({
  componentByDataPath,
  focusComponent,
  summaryRef,
  summary,
  titleId,
  visible,
}: ErrorSummaryProps) {
  if (!visible || summary.length === 0) {
    return null
  }

  return (
    <section aria-labelledby={titleId} ref={summaryRef} role="alert" tabIndex={-1}>
      <h2 id={titleId}>
        Please check the following items ({summary.length})
      </h2>
      <ul>
        {summary.map((error, index) => {
          const componentId = error.path === undefined ? undefined : componentByDataPath.get(error.path)
          return (
            <li key={error.path === undefined ? error.code + String(index) : error.path + String(index)}>
              {componentId === undefined ? (
                error.message
              ) : (
                <a
                  href={'#' + domId(componentId, 'control')}
                  onClick={(event) => {
                    event.preventDefault()
                    focusComponent(componentId)
                  }}
                >
                  {error.message}
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

interface SubmissionFeedbackProps {
  readonly snapshot: A2UIFormState
}

function SubmissionFeedback({ snapshot }: SubmissionFeedbackProps) {
  if (snapshot.submission.status === 'success') {
    return (
      <section aria-live="polite" role="status">
        <h2>Action completed</h2>
        <p>{snapshot.submission.result?.message ?? 'Your changes were saved.'}</p>
      </section>
    )
  }

  if (snapshot.submission.status === 'error' && snapshot.errors.formErrors.length > 0) {
    return (
      <section role="alert">
        <h2>Unable to complete the action</h2>
        <p>{snapshot.errors.formErrors[0]?.message}</p>
      </section>
    )
  }

  return null
}

interface ConfirmationDialogProps {
  readonly actionId?: string
  readonly confirmation?: {
    readonly title: string
    readonly message: string
    readonly confirmLabel?: string
    readonly cancelLabel?: string
  }
  readonly onConfirm: () => void
  readonly onDismiss: () => void
  readonly snapshot: A2UIFormState
}

function ConfirmationDialog({
  actionId,
  confirmation,
  onConfirm,
  onDismiss,
  snapshot,
}: ConfirmationDialogProps) {
  const dialog = useRef<HTMLElement | null>(null)
  const cancelButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (snapshot.submission.status === 'awaiting_confirmation') {
      cancelButton.current?.focus()
    }
  }, [snapshot.submission.status])

  if (snapshot.submission.status !== 'awaiting_confirmation' || actionId === undefined || confirmation === undefined) {
    return null
  }

  function keyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onDismiss()
      return
    }
    if (event.key !== 'Tab') {
      return
    }
    const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled])')
    if (focusable === undefined || focusable.length === 0) {
      return
    }
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div>
      <section
        aria-describedby={domId(actionId, 'confirm-description')}
        aria-labelledby={domId(actionId, 'confirm-title')}
        aria-modal="true"
        onKeyDown={keyDown}
        ref={dialog}
        role="dialog"
      >
        <h2 id={domId(actionId, 'confirm-title')}>{confirmation.title}</h2>
        <p id={domId(actionId, 'confirm-description')}>{confirmation.message}</p>
        <button onClick={onDismiss} ref={cancelButton} type="button">
          {confirmation.cancelLabel ?? 'Cancel'}
        </button>
        <button onClick={onConfirm} type="button">
          {confirmation.confirmLabel ?? 'Confirm'}
        </button>
      </section>
    </div>
  )
}

function buildComponentIndexes(
  root: FormNode,
  actions: readonly ActionDefinition[],
  rules: NormalizedA2UIFormDocumentV1['rules'],
): ComponentIndexes {
  const componentByDataPath = new Map<DataPath, string>()
  const sectionAncestors = new Map<string, readonly string[]>()
  const focusTriggerByTarget = new Map<string, string>()
  const focusTriggerPathByTarget = new Map<string, DataPath>()
  const buttonById = new Map<string, ButtonNode>()
  const submitButtons: ButtonNode[] = []
  const collapsedByDefault: Record<string, boolean> = {}

  function visit(node: ComponentNode, sections: readonly string[]): void {
    sectionAncestors.set(node.id, sections)
    if ('dataPath' in node && node.dataPath !== undefined && !componentByDataPath.has(node.dataPath)) {
      componentByDataPath.set(node.dataPath, node.id)
    }
    if (node.type === 'Button') {
      buttonById.set(node.id, node)
      const action = actionById(actions, node.action.actionId)
      if (action?.type === 'submit') {
        submitButtons.push(node)
      }
    }
    const childSections = node.type === 'Section' ? [...sections, node.id] : sections
    if (node.type === 'Section' && node.props.collapsible === true && node.props.defaultCollapsed === true) {
      collapsedByDefault[node.id] = true
    }
    for (const child of node.children) {
      visit(child, childSections)
    }
  }

  visit(root, [])
  for (const rule of rules) {
    for (const effect of [...rule.then, ...(rule.else ?? [])]) {
      if (effect.type === 'setVisible') {
        focusTriggerPathByTarget.set(effect.targetComponentId, rule.sourceDataPath)
      }
    }
  }
  for (const [targetComponentId, sourceDataPath] of focusTriggerPathByTarget) {
    const sourceComponentId = componentByDataPath.get(sourceDataPath)
    if (sourceComponentId !== undefined) {
      focusTriggerByTarget.set(targetComponentId, sourceComponentId)
    }
  }
  return {
    componentByDataPath,
    sectionAncestors,
    focusTriggerByTarget,
    buttonById,
    submitButtons,
    collapsedByDefault,
  }
}

function actionById(actions: readonly ActionDefinition[], actionId: string): ActionDefinition | undefined {
  return actions.find((action) => action.id === actionId)
}

function domId(componentId: string, suffix: string): string {
  return 'a2ui-' + encodeURIComponent(componentId) + '-' + suffix
}

function isRequired(node: ComponentNode): boolean {
  return node.validation?.some((validator) => validator.type === 'required') === true
}

function asString(value: JsonValue): string {
  return typeof value === 'string' ? value : ''
}

function inputTypeFor(inputMode: TextInputNode['props']['inputMode']): 'text' | 'email' | 'tel' | 'url' | 'search' {
  return inputMode ?? 'text'
}

function supportedAutoComplete(value: string | undefined): value is string {
  return value !== undefined && supportedAutoCompleteTokens.has(value)
}

function isOptionValue(value: JsonValue): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function optionToken(value: string | number | boolean): string {
  return typeof value + ':' + String(value)
}

function numericDraft(value: JsonValue): string {
  return typeof value === 'number' ? String(value) : ''
}

function normalizeNumberDraft(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '-' || trimmed === '+' || trimmed === '.' || trimmed === '-.' || trimmed === '+.') {
    return null
  }
  const numberValue = Number(trimmed)
  return Number.isFinite(numberValue) ? numberValue : null
}

function resizeTextArea(element: HTMLTextAreaElement, maxRows: number | undefined): void {
  if (maxRows === undefined || typeof window === 'undefined') {
    return
  }
  const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight)
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return
  }
  element.style.height = 'auto'
  const maxHeight = lineHeight * maxRows
  const targetHeight = Math.min(element.scrollHeight, maxHeight)
  element.style.height = String(targetHeight) + 'px'
  element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden'
}

function uploadedValues(value: JsonValue): readonly UploadValue[] {
  return Array.isArray(value) ? value.filter(isUploadValue) : []
}

function isUploadValue(value: JsonValue): value is UploadValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Readonly<Record<string, unknown>>
  return typeof candidate.fileId === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.size === 'number'
    && typeof candidate.mimeType === 'string'
    && candidate.status === 'uploaded'
}

function formatFileSize(value: number): string {
  if (value < 1024) {
    return String(value) + ' B'
  }
  if (value < 1024 * 1024) {
    return String(Math.round(value / 102.4) / 10) + ' KB'
  }
  return String(Math.round(value / (1024 * 102.4)) / 10) + ' MB'
}

function renderMarkdownBlocks(content: string): readonly ReactNode[] {
  const blocks: ReactNode[] = []
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let index = 0

  function flushParagraph(): void {
    if (paragraph.length === 0) {
      return
    }
    const value = paragraph.join(' ')
    blocks.push(<p key={'paragraph-' + String(blocks.length)}>{renderInlineMarkdown(value)}</p>)
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === '') {
      flushParagraph()
      index += 1
      continue
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      const level = heading[1]!.length
      const value = heading[2]!
      const key = 'heading-' + String(blocks.length)
      if (level === 1) {
        blocks.push(<h2 key={key}>{renderInlineMarkdown(value)}</h2>)
      } else if (level === 2) {
        blocks.push(<h3 key={key}>{renderInlineMarkdown(value)}</h3>)
      } else {
        blocks.push(<h4 key={key}>{renderInlineMarkdown(value)}</h4>)
      }
      index += 1
      continue
    }

    const unordered = /^[-*]\s+(.+)$/.exec(line)
    const ordered = /^\d+\.\s+(.+)$/.exec(line)
    if (unordered !== null || ordered !== null) {
      flushParagraph()
      const orderedList = ordered !== null
      const items: string[] = []
      while (index < lines.length) {
        const candidate = lines[index]!
        const match = orderedList ? /^\d+\.\s+(.+)$/.exec(candidate) : /^[-*]\s+(.+)$/.exec(candidate)
        if (match === null) {
          break
        }
        items.push(match[1]!)
        index += 1
      }
      const key = 'list-' + String(blocks.length)
      const renderedItems = items.map((item, itemIndex) => (
        <li key={'item-' + String(itemIndex)}>{renderInlineMarkdown(item)}</li>
      ))
      blocks.push(orderedList ? <ol key={key}>{renderedItems}</ol> : <ul key={key}>{renderedItems}</ul>)
      continue
    }

    paragraph.push(line.trim())
    index += 1
  }

  flushParagraph()
  return blocks
}

function renderInlineMarkdown(value: string): readonly ReactNode[] {
  const parts = value.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]*`)/g)
  return parts.filter((part) => part.length > 0).map((part, index) => {
    const key = 'inline-' + String(index)
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={key}>{part.slice(1, -1)}</em>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key}>{part.slice(1, -1)}</code>
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link !== null) {
      const href = safeMarkdownHref(link[2]!)
      return href === undefined ? (
        <span key={key}>{link[1]}</span>
      ) : (
        <a href={href} key={key} rel="noreferrer noopener" target="_blank">
          {link[1]}
        </a>
      )
    }
    return <span key={key}>{part}</span>
  })
}

function safeMarkdownHref(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? value : undefined
  } catch {
    return undefined
  }
}
