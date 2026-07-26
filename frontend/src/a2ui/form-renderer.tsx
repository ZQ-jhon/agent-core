import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type {
  A2UIFormController,
  A2UIFormState,
  FormComponentState,
} from './form-state.ts'
import type { UploadValue } from './bound-value.ts'
import { ComponentRenderBoundary, UnsupportedComponentPlaceholder } from './safe-rendering.tsx'
import { SafeMarkdown } from './safe-markdown.tsx'
import type { SchemaDiagnostic } from './errors.ts'
import type {
  ActionBinding,
  ActionDefinition,
  AlertNode,
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
  Option,
  RadioGroupNode,
  SectionNode,
  SelectNode,
  StableId,
  SwitchNode,
  TextAreaNode,
  TextInputNode,
  UploadNode,
} from './types.ts'
import { getComponentRegistration } from './registry.ts'
import { useA2UIFormState } from './use-form-state.ts'

type FieldNode =
  | TextInputNode
  | TextAreaNode
  | NumberInputNode
  | SelectNode
  | RadioGroupNode
  | CheckboxGroupNode
  | DatePickerNode
  | SwitchNode
  | UploadNode

type UploadActionDefinition = Extract<ActionDefinition, { readonly type: 'upload' }>

/** A host-owned upload invocation. The renderer never resolves endpoints or calls fetch. */
export interface A2UIUploadRequest {
  readonly action: UploadActionDefinition
  readonly componentId: StableId
  readonly dataPath: DataPath
  readonly file: File
  readonly reportProgress: (percent: number) => void
}

/** The only host result that may be committed to an Upload dataPath after success. */
export interface A2UIUploadResult {
  readonly fileId: string
  readonly name?: string
  readonly size?: number
  readonly mimeType?: string
}

/** Trusted hosts implement endpoint lookup, authentication, and file transfer outside the schema renderer. */
export type A2UIUploadTransport = (request: A2UIUploadRequest) => Promise<A2UIUploadResult>

interface RendererContextValue {
  readonly actionsById: ReadonlyMap<StableId, ActionDefinition>
  readonly controller: A2UIFormController
  readonly document: NormalizedA2UIFormDocumentV1
  readonly expandSection: (sectionId: StableId) => void
  readonly onRenderDiagnostic?: (diagnostic: SchemaDiagnostic) => void
  readonly registerSectionExpander: (sectionId: StableId, expand: () => void) => () => void
  readonly remoteOptions: Readonly<Record<string, readonly Option[]>>
  readonly state: A2UIFormState
  readonly upload?: A2UIUploadTransport
}

interface FieldControlProps {
  readonly 'aria-describedby'?: string
  readonly 'aria-errormessage'?: string
  readonly 'aria-invalid': boolean
  readonly 'aria-required': boolean
  readonly disabled: boolean
  readonly id: string
}

interface SubmitSource {
  readonly actionId: StableId
  readonly componentId: StableId
}

const rendererContext = createContext<RendererContextValue | undefined>(undefined)

/**
 * The schema-driven, non-visual Stage 4 renderer. It consumes the frozen
 * registry data and Stage 3 controller; it never resolves endpoints or runs
 * schema-supplied code.
 */
export function A2UIFormRenderer({
  controller,
  document,
  onRenderDiagnostic,
  remoteOptions = {},
  upload,
}: A2UIFormRendererProps) {
  const state = useA2UIFormState(controller)
  const actionsById = new Map(document.actions.map((action) => [action.id, action]))
  const sectionExpanders = useRef(new Map<StableId, () => void>())
  const expandSection = useCallback((sectionId: StableId): void => {
    sectionExpanders.current.get(sectionId)?.()
  }, [])
  const registerSectionExpander = useCallback((sectionId: StableId, expand: () => void): (() => void) => {
    sectionExpanders.current.set(sectionId, expand)
    return () => {
      if (sectionExpanders.current.get(sectionId) === expand) {
        sectionExpanders.current.delete(sectionId)
      }
    }
  }, [])

  return (
    <rendererContext.Provider
      value={{
        actionsById,
        controller,
        document,
        expandSection,
        onRenderDiagnostic,
        registerSectionExpander,
        remoteOptions,
        state,
        upload,
      }}
    >
      <RenderedNode node={document.root} />
    </rendererContext.Provider>
  )
}

export interface A2UIFormRendererProps {
  readonly controller: A2UIFormController
  readonly document: NormalizedA2UIFormDocumentV1
  /** Trusted host-provided values for declared remote option sources; no HTTP is performed here. */
  readonly remoteOptions?: Readonly<Record<string, readonly Option[]>>
  readonly onRenderDiagnostic?: (diagnostic: SchemaDiagnostic) => void
  /** Trusted host bridge for upload actions; without it Upload renders an explicit unavailable state. */
  readonly upload?: A2UIUploadTransport
}

function RenderedNode({ node }: { readonly node: ComponentNode }) {
  const context = useRendererContext()
  if (getComponentRegistration(node.type) === undefined) {
    return <UnsupportedComponentPlaceholder componentId={node.id} componentType={node.type} />
  }
  if (!isNodeVisible(node, context.state.components[node.id])) {
    return null
  }

  return (
    <ComponentRenderBoundary
      componentId={node.id}
      componentType={node.type}
      onDiagnostic={context.onRenderDiagnostic}
      revision={context.document.revision}
    >
      <NodeContents node={node} />
    </ComponentRenderBoundary>
  )
}

function NodeContents({ node }: { readonly node: ComponentNode }) {
  switch (node.type) {
    case 'Form':
      return <FormComponent node={node} />
    case 'Section':
      return <SectionComponent node={node} />
    case 'TextInput':
      return <TextInputComponent node={node} />
    case 'TextArea':
      return <TextAreaComponent node={node} />
    case 'NumberInput':
      return <NumberInputComponent node={node} />
    case 'Select':
      return <SelectComponent node={node} />
    case 'RadioGroup':
      return <RadioGroupComponent node={node} />
    case 'CheckboxGroup':
      return <CheckboxGroupComponent node={node} />
    case 'DatePicker':
      return <DatePickerComponent node={node} />
    case 'Switch':
      return <SwitchComponent node={node} />
    case 'Upload':
      return <UploadComponent node={node} />
    case 'Button':
      return <ButtonComponent node={node} />
    case 'Alert':
      return <AlertComponent node={node} />
    case 'Markdown':
      return <MarkdownComponent node={node} />
    default: {
      const malformedNode = node as unknown as { readonly id?: string; readonly type?: string }
      return <UnsupportedComponentPlaceholder componentId={malformedNode.id} componentType={malformedNode.type ?? 'unknown'} />
    }
  }
}

function FormComponent({ node }: { readonly node: FormNode }) {
  const context = useRendererContext()
  const summaryRef = useRef<HTMLElement>(null)
  const summaryWasVisible = useRef(false)
  const submitSources = collectSubmitSources(node, context.actionsById)
  const titleId = makeDomId(node.id, 'title')
  const formName = node.props.title ?? context.document.meta?.title ?? 'Form'
  const shouldFocusSummary = context.state.showErrorSummary && context.state.errors.summary.length > 0

  useEffect(() => {
    if (shouldFocusSummary && !summaryWasVisible.current) {
      summaryRef.current?.focus()
    }
    summaryWasVisible.current = shouldFocusSummary
  }, [shouldFocusSummary])

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (
      event.key !== 'Enter' ||
      event.defaultPrevented ||
      node.props.submitOnEnter !== true ||
      submitSources.length !== 1 ||
      !isEditableSingleLineTextInput(event.target)
    ) {
      return
    }
    event.preventDefault()
    const source = submitSources[0]
    if (source !== undefined) {
      void context.controller.dispatchAction(source.actionId, source.componentId)
    }
  }

  return (
    <>
      <form
        aria-busy={context.state.submission.status === 'submitting'}
        aria-label={node.props.title === undefined ? formName : undefined}
        aria-labelledby={node.props.title === undefined ? undefined : titleId}
        data-a2ui-component-id={node.id}
        onKeyDown={handleKeyDown}
        onSubmit={handleSubmit}
      >
        {node.props.title === undefined ? null : <h1 id={titleId}>{node.props.title}</h1>}
        {node.props.description === undefined ? null : <p>{node.props.description}</p>}
        <FormErrorSummary ref={summaryRef} />
        {node.children.map((child) => <RenderedNode key={child.id} node={child} />)}
      </form>
      <ConfirmationDialog />
    </>
  )
}

function FormErrorSummary({ ref }: { readonly ref: React.RefObject<HTMLElement | null> }) {
  const context = useRendererContext()
  const { errors, showErrorSummary, submission } = context.state
  const titleId = makeDomId(context.document.formId, 'error-summary-title')

  function revealAndFocusControl(dataPath: DataPath, controlId: string): void {
    for (const sectionId of findCollapsibleSectionIdsForPath(context.document.root, dataPath)) {
      context.expandSection(sectionId)
    }
    // Section state is committed after this click handler. Defer focus until the
    // newly-expanded control is available, while retaining the real fragment URL.
    window.setTimeout(() => document.getElementById(controlId)?.focus(), 0)
  }

  if (!showErrorSummary || errors.summary.length === 0) {
    return null
  }

  return (
    <section ref={ref} aria-labelledby={titleId} role="alert" tabIndex={-1}>
      <h2 id={titleId}>Please review the highlighted fields</h2>
      <ul>
        {errors.summary.map((error, index) => {
          const controlId = error.path === undefined ? undefined : findControlIdForPath(context.document.root, error.path)
          return (
            <li key={`${error.code}:${error.path ?? 'form'}:${index}`}>
              {controlId === undefined || error.path === undefined
                ? error.message
                : <a href={`#${controlId}`} onClick={() => revealAndFocusControl(error.path!, controlId)}>{error.message}</a>}
            </li>
          )
        })}
      </ul>
      {submission.status === 'error' && submission.retryable === true ? (
        <button onClick={() => void context.controller.retrySubmission()} type="button">
          Retry submission
        </button>
      ) : null}
    </section>
  )
}

function ConfirmationDialog() {
  const context = useRendererContext()
  const dialogRef = useRef<HTMLElement>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const restoreFocusPendingRef = useRef(false)
  const wasOpenRef = useRef(false)
  const titleId = makeDomId(context.document.formId, 'confirmation-title')
  const descriptionId = makeDomId(context.document.formId, 'confirmation-description')
  const sourceId = context.state.submission.sourceComponentId
  const binding = sourceId === undefined ? undefined : findActionBinding(context.document.root, sourceId)
  const confirmation = binding?.confirm
  const isOpen = context.state.submission.status === 'awaiting_confirmation' && confirmation !== undefined

  // Apply inert to the form when dialog is open. The dialog is a sibling of the
  // form, so inert on the form only blocks background interaction.
  useEffect(() => {
    if (!isOpen) {
      return undefined
    }
    const form = document.querySelector<HTMLFormElement>('form[data-a2ui-component-id]')
    if (form !== null) {
      form.setAttribute('inert', '')
      return () => {
        form.removeAttribute('inert')
      }
    }
  }, [isOpen])

  // Global Escape listener — cancels dialog regardless of where focus has drifted.
  useEffect(() => {
    if (!isOpen) {
      return undefined
    }
    function handleGlobalKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        context.controller.cancelPendingAction()
      }
    }
    document.addEventListener('keydown', handleGlobalKeyDown)
    return () => document.removeEventListener('keydown', handleGlobalKeyDown)
  }, [context.controller, isOpen])

  // Pull focus back into the dialog if it escapes (mouse click on inert background, script focus).
  useEffect(() => {
    if (!isOpen) {
      return undefined
    }
    function handleFocusIn(event: FocusEvent): void {
      if (dialogRef.current === null || dialogRef.current.contains(event.target as Node)) {
        return
      }
      // Focus drifted outside — pull it back to the first focusable element.
      const focusable = getFocusableElements(dialogRef.current)
      focusable[0]?.focus()
    }
    document.addEventListener('focusin', handleFocusIn)
    return () => document.removeEventListener('focusin', handleFocusIn)
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      const activeElement = document.activeElement
      previouslyFocusedRef.current = (sourceId === undefined ? undefined : findActionSourceElement(sourceId))
        ?? (activeElement instanceof HTMLElement ? activeElement : null)
      wasOpenRef.current = true
      confirmButtonRef.current?.focus()
      return
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false
      restoreFocusPendingRef.current = true
    }
    const previousFocus = previouslyFocusedRef.current
    if (!isOpen && restoreFocusPendingRef.current && previousFocus !== null && !previousFocus.matches(':disabled')) {
      previousFocus.focus()
      restoreFocusPendingRef.current = false
      previouslyFocusedRef.current = null
    }
  }, [context.state.submission.status, isOpen])

  if (!isOpen || confirmation === undefined) {
    return null
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      context.controller.cancelPendingAction()
      return
    }
    if (event.key !== 'Tab') {
      return
    }
    const focusable = getFocusableElements(dialogRef.current)
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const activeElement = document.activeElement
    const activeIndex = focusable.indexOf(activeElement as HTMLElement)
    const nextIndex = event.shiftKey
      ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
      : activeIndex === -1 || activeIndex >= focusable.length - 1 ? 0 : activeIndex + 1
    event.preventDefault()
    focusable[nextIndex]!.focus()
  }

  return (
    <section
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={handleKeyDown}
      ref={dialogRef}
      role="dialog"
    >
      <h2 id={titleId}>{confirmation.title}</h2>
      <p id={descriptionId}>{confirmation.message}</p>
      <button onClick={() => void context.controller.confirmPendingAction()} ref={confirmButtonRef} type="button">
        {confirmation.confirmLabel ?? 'Confirm'}
      </button>
      <button onClick={() => context.controller.cancelPendingAction()} type="button">
        {confirmation.cancelLabel ?? 'Cancel'}
      </button>
    </section>
  )
}

function SectionComponent({ node }: { readonly node: SectionNode }) {
  const context = useRendererContext()
  const [collapsed, setCollapsed] = useState(node.props.collapsible === true && node.props.defaultCollapsed === true)
  const contentId = makeDomId(node.id, 'content')
  const titleId = makeDomId(node.id, 'title')
  const expand = useCallback(() => setCollapsed(false), [])

  useEffect(() => {
    if (node.props.collapsible !== true) {
      return undefined
    }
    return context.registerSectionExpander(node.id, expand)
  }, [context.registerSectionExpander, expand, node.id, node.props.collapsible])

  return (
    <section aria-labelledby={titleId} data-a2ui-component-id={node.id}>
      {node.props.collapsible === true ? (
        <h2>
          <button
            aria-controls={contentId}
            aria-expanded={!collapsed}
            id={titleId}
            onClick={() => setCollapsed((current) => !current)}
            type="button"
          >
            {node.props.title}
          </button>
        </h2>
      ) : <h2 id={titleId}>{node.props.title}</h2>}
      {node.props.description === undefined ? null : <p>{node.props.description}</p>}
      <div hidden={collapsed} id={contentId}>
        {node.children.map((child) => <RenderedNode key={child.id} node={child} />)}
      </div>
    </section>
  )
}

function TextInputComponent({ node }: { readonly node: TextInputNode }) {
  const context = useRendererContext()
  const value = toTextValue(context.state.fields[node.dataPath]?.value)

  return (
    <FieldFrame node={node}>
      {(control) => (
        <input
          {...control}
          autoComplete={node.props.autoComplete}
          inputMode={node.props.inputMode}
          onBlur={() => context.controller.blur(node.dataPath)}
          onChange={(event) => context.controller.setValue(node.dataPath, event.currentTarget.value)}
          placeholder={node.props.placeholder}
          readOnly={node.props.readOnly}
          type="text"
          value={value}
        />
      )}
    </FieldFrame>
  )
}

function TextAreaComponent({ node }: { readonly node: TextAreaNode }) {
  const context = useRendererContext()
  const value = toTextValue(context.state.fields[node.dataPath]?.value)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const rows = node.props.rows ?? 4
  const maxRows = node.props.maxRows

  useEffect(() => {
    if (maxRows !== undefined) {
      resizeTextArea(textareaRef.current, rows, maxRows)
    }
  }, [maxRows, rows, value])

  return (
    <FieldFrame node={node}>
      {(control) => (
        <textarea
          {...control}
          data-a2ui-max-rows={maxRows}
          onBlur={() => context.controller.blur(node.dataPath)}
          onChange={(event) => {
            context.controller.setValue(node.dataPath, event.currentTarget.value)
            if (maxRows !== undefined) {
              resizeTextArea(event.currentTarget, rows, maxRows)
            }
          }}
          placeholder={node.props.placeholder}
          ref={textareaRef}
          rows={rows}
          value={value}
        />
      )}
    </FieldFrame>
  )
}

function NumberInputComponent({ node }: { readonly node: NumberInputNode }) {
  const context = useRendererContext()
  const value = context.state.fields[node.dataPath]?.value
  const [draft, setDraft] = useState(toNumberDraft(value))
  const unitId = makeDomId(node.id, 'unit')

  useEffect(() => {
    setDraft(toNumberDraft(value))
  }, [value])

  function updateDraft(rawValue: string): void {
    setDraft(rawValue)
    if (rawValue === '') {
      context.controller.setTransientError(node.dataPath)
      context.controller.setValue(node.dataPath, null)
      return
    }
    const parsed = parseCompleteNumberDraft(rawValue)
    if (parsed !== undefined) {
      context.controller.setTransientError(node.dataPath)
      context.controller.setValue(node.dataPath, parsed)
    }
  }

  function normalizeAndValidate(): void {
    if (draft === '') {
      context.controller.setTransientError(node.dataPath)
      context.controller.setValue(node.dataPath, null)
    } else {
      const parsed = parseNumberOnBlur(draft)
      if (parsed !== undefined) {
        context.controller.setTransientError(node.dataPath)
        context.controller.setValue(node.dataPath, parsed)
        setDraft(String(parsed))
      } else {
        context.controller.setTransientError(node.dataPath, {
          code: 'NUMBER_INVALID',
          message: 'Enter a valid number.',
        })
      }
    }
    context.controller.blur(node.dataPath)
  }

  return (
    <FieldFrame node={node} supplementaryDescriptionIds={node.props.unit === undefined ? [] : [unitId]}>
      {(control) => (
        <>
          <input
            {...control}
            data-a2ui-step={node.props.step}
            inputMode="decimal"
            onBlur={normalizeAndValidate}
            onChange={(event) => updateDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                normalizeAndValidate()
              }
            }}
            placeholder={node.props.placeholder}
            type="text"
            value={draft}
          />
          {node.props.unit === undefined ? null : <span id={unitId}>{node.props.unit}</span>}
        </>
      )}
    </FieldFrame>
  )
}

function SelectComponent({ node }: { readonly node: SelectNode }) {
  const context = useRendererContext()
  const sourceId = 'dataSourceId' in node.props ? node.props.dataSourceId : undefined
  const staticOptions = 'options' in node.props ? node.props.options : undefined
  const options = staticOptions ?? (sourceId === undefined ? undefined : context.remoteOptions[sourceId]) ?? []
  const remoteUnavailable = sourceId !== undefined && context.remoteOptions[sourceId] === undefined
  const statusId = makeDomId(node.id, 'option-status')
  const selectedIndex = findOptionIndex(context.state.fields[node.dataPath]?.value, options)
  const currentValue = selectedIndex === undefined ? '' : String(selectedIndex)
  const clearable = node.props.clearable !== false

  return (
    <FieldFrame node={node} supplementaryDescriptionIds={remoteUnavailable ? [statusId] : []}>
      {(control) => (
        <>
          <select
            {...control}
            disabled={control.disabled || remoteUnavailable}
            onBlur={() => context.controller.blur(node.dataPath)}
            onChange={(event) => {
              if (event.currentTarget.value === '') {
                if (clearable) {
                  context.controller.setValue(node.dataPath, null)
                }
                return
              }
              const option = options[Number(event.currentTarget.value)]
              if (option !== undefined) {
                context.controller.setValue(node.dataPath, option.value)
              }
            }}
            value={currentValue}
          >
            <option disabled={!clearable} value="">{node.props.placeholder ?? 'Select an option'}</option>
            {options.map((option, index) => (
              <option disabled={option.disabled} key={`${node.id}:${index}`} value={String(index)}>
                {option.label}
              </option>
            ))}
          </select>
          {remoteUnavailable ? <p id={statusId} role="status">Options are unavailable until the host supplies this data source.</p> : null}
        </>
      )}
    </FieldFrame>
  )
}

function RadioGroupComponent({ node }: { readonly node: RadioGroupNode }) {
  const context = useRendererContext()
  const value = context.state.fields[node.dataPath]?.value
  return (
    <ChoiceGroupFrame node={node}>
      {node.props.options.map((option, index) => {
        const optionId = makeDomId(node.id, `option-${index}`)
        const disabled = isFieldDisabled(node, context.state) || option.disabled === true
        return (
          <label htmlFor={optionId} key={`${node.id}:${index}`}>
            <input
              checked={sameOptionValue(value, option.value)}
              disabled={disabled}
              id={optionId}
              name={makeDomId(node.id, 'radio')}
              onBlur={() => context.controller.blur(node.dataPath)}
              onChange={() => {
                if (!disabled) {
                  context.controller.setValue(node.dataPath, option.value)
                }
              }}
              type="radio"
              value={String(index)}
            />
            {option.label}
          </label>
        )
      })}
    </ChoiceGroupFrame>
  )
}

function CheckboxGroupComponent({ node }: { readonly node: CheckboxGroupNode }) {
  const context = useRendererContext()
  const rawValue = context.state.fields[node.dataPath]?.value
  const selectedValues = Array.isArray(rawValue) ? rawValue : []
  return (
    <ChoiceGroupFrame node={node}>
      {node.props.options.map((option, index) => {
        const optionId = makeDomId(node.id, `option-${index}`)
        const checked = selectedValues.some((value) => sameOptionValue(value, option.value))
        const disabled = isFieldDisabled(node, context.state) || option.disabled === true
        return (
          <label htmlFor={optionId} key={`${node.id}:${index}`}>
            <input
              checked={checked}
              disabled={disabled}
              id={optionId}
              onBlur={() => context.controller.blur(node.dataPath)}
              onChange={() => {
                if (disabled) {
                  return
                }
                const nextValues = checked
                  ? selectedValues.filter((value) => !sameOptionValue(value, option.value))
                  : [...selectedValues, option.value]
                context.controller.setValue(node.dataPath, nextValues)
              }}
              type="checkbox"
            />
            {option.label}
          </label>
        )
      })}
    </ChoiceGroupFrame>
  )
}

function DatePickerComponent({ node }: { readonly node: DatePickerNode }) {
  const context = useRendererContext()
  const value = toTextValue(context.state.fields[node.dataPath]?.value)
  return (
    <FieldFrame node={node}>
      {(control) => (
        <input
          {...control}
          max={node.props.maxDate}
          min={node.props.minDate}
          onBlur={() => context.controller.blur(node.dataPath)}
          onChange={(event) => context.controller.setValue(node.dataPath, event.currentTarget.value || null)}
          type="date"
          value={value}
        />
      )}
    </FieldFrame>
  )
}

function SwitchComponent({ node }: { readonly node: SwitchNode }) {
  const context = useRendererContext()
  const value = context.state.fields[node.dataPath]?.value === true
  return (
    <FieldFrame node={node}>
      {(control) => (
        <>
          <input
            {...control}
            aria-checked={value}
            checked={value}
            onBlur={() => context.controller.blur(node.dataPath)}
            onChange={(event) => context.controller.setValue(node.dataPath, event.currentTarget.checked)}
            role="switch"
            type="checkbox"
          />
          {node.props.onLabel === undefined && node.props.offLabel === undefined ? null : (
            <span>{value ? node.props.onLabel ?? 'On' : node.props.offLabel ?? 'Off'}</span>
          )}
        </>
      )}
    </FieldFrame>
  )
}

function UploadComponent({ node }: { readonly node: UploadNode }) {
  const context = useRendererContext()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pendingUploads, setPendingUploads] = useState<readonly PendingUpload[]>([])
  const statusId = makeDomId(node.id, 'upload-status')
  const value = context.state.fields[node.dataPath]?.value
  const attachments = getUploadedAttachments(value)
  const maxFiles = node.props.maxFiles ?? 1
  const action = context.actionsById.get(node.action.actionId)
  const uploadAction = action?.type === 'upload' ? action : undefined
  const bridgeAvailable = context.upload !== undefined && uploadAction !== undefined
  const activeUploadCount = pendingUploads.filter((upload) => upload.status === 'uploading').length
  const limitReached = attachments.length + activeUploadCount >= maxFiles

  function addFailure(file: File, message: string, retryable: boolean): void {
    setPendingUploads((current) => [
      ...current,
      { id: createUploadTaskId(), file, message, progress: 0, retryable, status: 'failed' },
    ])
  }

  function startUpload(file: File, retryId?: string): void {
    if (context.upload === undefined || uploadAction === undefined) {
      addFailure(file, 'File upload is unavailable until the host provides an upload transport.', false)
      return
    }
    const taskId = retryId ?? createUploadTaskId()
    setPendingUploads((current) => {
      const next = { id: taskId, file, message: undefined, progress: 0, retryable: false, status: 'uploading' as const }
      return retryId === undefined ? [...current, next] : current.map((upload) => upload.id === taskId ? next : upload)
    })

    void context.upload({
      action: uploadAction,
      componentId: node.id,
      dataPath: node.dataPath,
      file,
      reportProgress: (percent) => {
        const progress = clampUploadProgress(percent)
        setPendingUploads((current) => current.map((upload) => upload.id === taskId
          ? { ...upload, progress }
          : upload))
      },
    }).then((result) => {
      const uploaded = toUploadValue(result, file)
      if (uploaded === undefined) {
        throw new Error('invalid_upload_reference')
      }
      const current = getUploadedAttachments(context.controller.getValue(node.dataPath))
      if (current.length >= maxFiles || !context.controller.setValue(node.dataPath, [...current, uploaded])) {
        throw new Error('upload_result_rejected')
      }
      setPendingUploads((currentPending) => currentPending.filter((upload) => upload.id !== taskId))
    }).catch(() => {
      setPendingUploads((current) => current.map((upload) => upload.id === taskId
        ? { ...upload, message: 'Upload failed. Retry the file.', retryable: true, status: 'failed' as const }
        : upload))
    })
  }

  function handleFileSelection(files: FileList | null): void {
    if (files === null || !bridgeAvailable || limitReached) {
      return
    }
    let remainingSlots = maxFiles - attachments.length - activeUploadCount
    for (const file of Array.from(files)) {
      if (remainingSlots <= 0) {
        addFailure(file, `A maximum of ${maxFiles} file${maxFiles === 1 ? '' : 's'} can be attached.`, false)
        continue
      }
      if (!isAcceptedUploadFile(file, node.props.accept)) {
        addFailure(file, 'This file type is not accepted.', false)
        continue
      }
      if (node.props.maxSizeBytes !== undefined && file.size > node.props.maxSizeBytes) {
        addFailure(file, 'This file exceeds the maximum allowed size.', false)
        continue
      }
      remainingSlots -= 1
      startUpload(file)
    }
  }

  function removeAttachment(index: number): void {
    const next = attachments.filter((_, attachmentIndex) => attachmentIndex !== index)
    context.controller.setValue(node.dataPath, next)
  }

  return (
    <FieldFrame node={node} supplementaryDescriptionIds={[statusId]}>
      {(control) => (
        <>
          <input
            {...control}
            accept={node.props.accept?.join(',')}
            disabled={control.disabled || !bridgeAvailable || limitReached}
            multiple={maxFiles > 1}
            onBlur={() => context.controller.blur(node.dataPath)}
            onChange={(event) => {
              handleFileSelection(event.currentTarget.files)
              event.currentTarget.value = ''
            }}
            ref={inputRef}
            type="file"
          />
          <button
            aria-describedby={statusId}
            disabled={control.disabled || !bridgeAvailable || limitReached}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                inputRef.current?.click()
              }
            }}
            type="button"
          >
            {node.props.buttonLabel ?? 'Choose file'}
          </button>
          <p id={statusId} role="status">
            {!bridgeAvailable
              ? 'File upload is unavailable until the host provides an upload transport.'
              : limitReached
                ? `The maximum of ${maxFiles} file${maxFiles === 1 ? '' : 's'} has been reached.`
                : `${attachments.length} uploaded file${attachments.length === 1 ? '' : 's'} attached.`}
          </p>
          <div aria-label={`${node.props.label} upload progress`} aria-live="polite" role="status">
            {pendingUploads
              .filter((upload) => upload.status === 'uploading')
              .map((upload) => (
                <span key={upload.id}>{upload.file.name}: {upload.progress}% uploaded.</span>
              ))}
          </div>
          {attachments.length === 0 && pendingUploads.length === 0 ? null : (
            <ul aria-label={`${node.props.label} uploads`}>
              {attachments.map((attachment, index) => (
                <li key={`${attachment.fileId}:${index}`}>
                  {attachment.name}
                  <button disabled={control.disabled} onClick={() => removeAttachment(index)} type="button">Remove {attachment.name}</button>
                </li>
              ))}
              {pendingUploads.map((upload) => (
                <li key={upload.id}>
                  {upload.file.name} — {upload.status === 'uploading' ? `${upload.progress}% uploaded` : upload.message}
                  {upload.status === 'failed' && upload.retryable ? (
                    <button onClick={() => startUpload(upload.file, upload.id)} type="button">Retry {upload.file.name}</button>
                  ) : null}
                  {upload.status === 'failed' ? (
                    <button onClick={() => {
                      setPendingUploads((current) => current.filter((pending) => pending.id !== upload.id))
                    }} type="button">Remove {upload.file.name}</button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </FieldFrame>
  )
}

function ButtonComponent({ node }: { readonly node: ButtonNode }) {
  const context = useRendererContext()
  const componentState = context.state.components[node.id]
  const action = context.actionsById.get(node.action.actionId)
  const submitting = context.state.submission.status === 'submitting' && context.state.submission.sourceComponentId === node.id
  const disabled = componentState?.disabled === true || submitting || action === undefined
  const label = submitting ? node.props.loadingLabel ?? node.props.label : node.props.label

  return (
    <button
      aria-busy={submitting}
      data-a2ui-action-source={node.id}
      data-a2ui-component-id={node.id}
      data-a2ui-variant={node.props.variant ?? 'secondary'}
      disabled={disabled}
      onClick={() => void context.controller.dispatchAction(node.action.actionId, node.id)}
      type="button"
    >
      {label}
    </button>
  )
}

function AlertComponent({ node }: { readonly node: AlertNode }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) {
    return null
  }
  const variant = node.props.variant ?? 'info'
  const role = variant === 'error' || variant === 'warning' ? 'alert' : 'status'
  return (
    <section data-a2ui-variant={variant} role={role}>
      {node.props.title === undefined ? null : <h2>{node.props.title}</h2>}
      <p>{node.props.message}</p>
      {node.props.dismissible === true ? (
        <button aria-label="Dismiss alert" onClick={() => setDismissed(true)} type="button">Dismiss</button>
      ) : null}
    </section>
  )
}

function MarkdownComponent({ node }: { readonly node: MarkdownNode }) {
  return (
    <section aria-label={node.props.ariaLabel}>
      <SafeMarkdown content={node.props.content} />
    </section>
  )
}

function FieldFrame({
  children,
  node,
  supplementaryDescriptionIds = [],
}: {
  readonly children: (control: FieldControlProps) => ReactNode
  readonly node: FieldNode
  readonly supplementaryDescriptionIds?: readonly string[]
}) {
  const context = useRendererContext()
  const ids = fieldDomIds(node.id)
  const field = context.state.fields[node.dataPath]
  const error = field?.errors[0]
  const required = node.validation?.some((validator) => validator.type === 'required') === true
  const describedBy = [
    node.props.helpText === undefined ? undefined : ids.help,
    ...supplementaryDescriptionIds,
    error === undefined ? undefined : ids.error,
  ].filter((id): id is string => id !== undefined).join(' ') || undefined
  const disabled = isFieldDisabled(node, context.state)

  return (
    <div data-a2ui-component-id={node.id}>
      <label htmlFor={ids.control}>
        {node.props.label}
        {required ? ' (required)' : null}
      </label>
      {node.props.helpText === undefined ? null : <p id={ids.help}>{node.props.helpText}</p>}
      {children({
        'aria-describedby': describedBy,
        'aria-errormessage': error === undefined ? undefined : ids.error,
        'aria-invalid': error !== undefined,
        'aria-required': required,
        disabled,
        id: ids.control,
      })}
      {error === undefined ? null : <p id={ids.error} role="alert">{error.message}</p>}
    </div>
  )
}

function ChoiceGroupFrame({
  children,
  node,
}: {
  readonly children: ReactNode
  readonly node: RadioGroupNode | CheckboxGroupNode
}) {
  const context = useRendererContext()
  const ids = fieldDomIds(node.id)
  const error = context.state.fields[node.dataPath]?.errors[0]
  const required = node.validation?.some((validator) => validator.type === 'required') === true
  const describedBy = [
    node.props.helpText === undefined ? undefined : ids.help,
    error === undefined ? undefined : ids.error,
  ].filter((id): id is string => id !== undefined).join(' ') || undefined

  return (
    <fieldset
      aria-describedby={describedBy}
      aria-errormessage={error === undefined ? undefined : ids.error}
      aria-invalid={error !== undefined}
      aria-required={required}
      data-a2ui-component-id={node.id}
    >
      <legend>{node.props.label}{required ? ' (required)' : null}</legend>
      {node.props.helpText === undefined ? null : <p id={ids.help}>{node.props.helpText}</p>}
      <div data-a2ui-orientation={node.props.orientation ?? 'vertical'}>{children}</div>
      {error === undefined ? null : <p id={ids.error} role="alert">{error.message}</p>}
    </fieldset>
  )
}

function useRendererContext(): RendererContextValue {
  const context = useContext(rendererContext)
  if (context === undefined) {
    throw new Error('A2UI renderer components must be used within A2UIFormRenderer.')
  }
  return context
}

function isNodeVisible(node: ComponentNode, state: FormComponentState | undefined): boolean {
  if (state !== undefined) {
    return state.visible
  }
  return (node.props as { readonly visible?: boolean }).visible !== false
}

function isFieldDisabled(node: FieldNode, state: A2UIFormState): boolean {
  const component = state.components[node.id]
  return component?.disabled ?? node.props.disabled === true
}

function toTextValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function toNumberDraft(value: JsonValue | undefined): string {
  return typeof value === 'number' ? String(value) : ''
}

function parseCompleteNumberDraft(value: string): number | undefined {
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseNumberOnBlur(value: string): number | undefined {
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isEditableSingleLineTextInput(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLInputElement) || target.disabled || target.readOnly) {
    return false
  }
  return ['text', 'email', 'password', 'search', 'tel', 'url'].includes(target.type)
}

function resizeTextArea(textarea: HTMLTextAreaElement | null, rows: number, maxRows: number): void {
  if (textarea === null) {
    return
  }
  const computedLineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight)
  const lineHeight = Number.isFinite(computedLineHeight) && computedLineHeight > 0 ? computedLineHeight : 20
  const minHeight = lineHeight * rows
  const maxHeight = lineHeight * maxRows

  textarea.style.height = 'auto'
  textarea.style.minHeight = `${minHeight}px`
  textarea.style.maxHeight = `${maxHeight}px`
  const contentHeight = Math.max(textarea.scrollHeight, minHeight)
  textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`
  textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
}

function getFocusableElements(container: HTMLElement | null): readonly HTMLElement[] {
  if (container === null) {
    return []
  }
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.getAttribute('aria-hidden') !== 'true')
}

function findActionSourceElement(componentId: StableId): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-a2ui-action-source]'))
    .find((element) => element.getAttribute('data-a2ui-action-source') === componentId)
}

function findCollapsibleSectionIdsForPath(root: ComponentNode, dataPath: DataPath): readonly StableId[] {
  return findCollapsibleSectionIds(root, dataPath, []) ?? []
}

function findCollapsibleSectionIds(
  node: ComponentNode,
  dataPath: DataPath,
  ancestorSections: readonly StableId[],
): readonly StableId[] | undefined {
  const nextAncestors = node.type === 'Section' && node.props.collapsible === true
    ? [...ancestorSections, node.id]
    : ancestorSections
  if (node.dataPath === dataPath) {
    return nextAncestors
  }
  for (const child of node.children) {
    const result = findCollapsibleSectionIds(child, dataPath, nextAncestors)
    if (result !== undefined) {
      return result
    }
  }
  return undefined
}

interface PendingUpload {
  readonly id: string
  readonly file: File
  readonly message?: string
  readonly progress: number
  readonly retryable: boolean
  readonly status: 'uploading' | 'failed'
}

let uploadTaskSequence = 0

function createUploadTaskId(): string {
  uploadTaskSequence += 1
  return `upload-${uploadTaskSequence}`
}

function clampUploadProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0
}

function getUploadedAttachments(value: JsonValue | undefined): readonly UploadValue[] {
  return Array.isArray(value) ? value.filter(isUploadValue) : []
}

function isUploadValue(value: JsonValue): value is UploadValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Readonly<Record<string, JsonValue>>
  return typeof record.fileId === 'string'
    && typeof record.name === 'string'
    && typeof record.size === 'number'
    && Number.isFinite(record.size)
    && typeof record.mimeType === 'string'
    && record.status === 'uploaded'
}

function toUploadValue(result: A2UIUploadResult, file: File): UploadValue | undefined {
  if (
    typeof result.fileId !== 'string'
    || (result.name !== undefined && typeof result.name !== 'string')
    || (result.size !== undefined && (typeof result.size !== 'number' || !Number.isFinite(result.size)))
    || (result.mimeType !== undefined && typeof result.mimeType !== 'string')
  ) {
    return undefined
  }
  const fileId = result.fileId.trim()
  const name = result.name ?? file.name
  const size = result.size ?? file.size
  const mimeType = result.mimeType ?? file.type
  if (fileId === '' || fileId.length > 512 || name.length > 1024 || !Number.isFinite(size) || size < 0 || mimeType.length > 255) {
    return undefined
  }
  return { fileId, name, size, mimeType, status: 'uploaded' }
}

function isAcceptedUploadFile(file: File, accept: readonly string[] | undefined): boolean {
  if (accept === undefined || accept.length === 0) {
    return true
  }
  const fileName = file.name.toLowerCase()
  const mimeType = file.type.toLowerCase()
  return accept.some((rawAccept) => {
    const accepted = rawAccept.trim().toLowerCase()
    if (accepted.startsWith('.')) {
      return fileName.endsWith(accepted)
    }
    if (accepted.endsWith('/*')) {
      return mimeType.startsWith(accepted.slice(0, -1))
    }
    return mimeType === accepted
  })
}

function findOptionIndex(value: JsonValue | undefined, options: readonly Option[]): number | undefined {
  const index = options.findIndex((option) => sameOptionValue(value, option.value))
  return index === -1 ? undefined : index
}

function sameOptionValue(value: JsonValue | undefined, optionValue: Option['value']): boolean {
  return typeof value === typeof optionValue && value === optionValue
}

function fieldDomIds(componentId: StableId): { readonly control: string; readonly error: string; readonly help: string } {
  return {
    control: makeDomId(componentId, 'control'),
    error: makeDomId(componentId, 'error'),
    help: makeDomId(componentId, 'help'),
  }
}

function makeDomId(componentId: StableId, suffix: string): string {
  // Fragment identifiers percent-decode before lookup; percent escapes inside
  // an element id therefore break legal StableIds such as `billing:amount`.
  const encodedId = Array.from(componentId, (character) => character.charCodeAt(0).toString(36)).join('-')
  return `a2ui-${encodedId}-${suffix}`
}

function findControlIdForPath(node: ComponentNode, dataPath: DataPath): string | undefined {
  if (node.dataPath === dataPath) {
    return fieldDomIds(node.id).control
  }
  for (const child of node.children) {
    const result = findControlIdForPath(child, dataPath)
    if (result !== undefined) {
      return result
    }
  }
  return undefined
}

function findActionBinding(node: ComponentNode, componentId: StableId): ActionBinding | undefined {
  if (node.id === componentId) {
    return node.action
  }
  for (const child of node.children) {
    const result = findActionBinding(child, componentId)
    if (result !== undefined) {
      return result
    }
  }
  return undefined
}

function collectSubmitSources(node: ComponentNode, actionsById: ReadonlyMap<StableId, ActionDefinition>): readonly SubmitSource[] {
  const sources: SubmitSource[] = []
  const nodes = [node]
  while (nodes.length > 0) {
    const current = nodes.pop()
    if (current === undefined) {
      continue
    }
    if (current.type === 'Button' && current.action !== undefined && actionsById.get(current.action.actionId)?.type === 'submit') {
      sources.push({ actionId: current.action.actionId, componentId: current.id })
    }
    nodes.push(...current.children)
  }
  return sources
}
