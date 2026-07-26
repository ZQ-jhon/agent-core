import {
  createContext,
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
import { ComponentRenderBoundary, UnsupportedComponentPlaceholder } from './safe-rendering.tsx'
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

interface RendererContextValue {
  readonly actionsById: ReadonlyMap<StableId, ActionDefinition>
  readonly controller: A2UIFormController
  readonly document: NormalizedA2UIFormDocumentV1
  readonly onRenderDiagnostic?: (diagnostic: SchemaDiagnostic) => void
  readonly remoteOptions: Readonly<Record<string, readonly Option[]>>
  readonly state: A2UIFormState
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
}: A2UIFormRendererProps) {
  const state = useA2UIFormState(controller)
  const actionsById = new Map(document.actions.map((action) => [action.id, action]))

  return (
    <rendererContext.Provider
      value={{ actionsById, controller, document, onRenderDiagnostic, remoteOptions, state }}
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
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLButtonElement
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
      <ConfirmationDialog />
    </form>
  )
}

function FormErrorSummary({ ref }: { readonly ref: React.RefObject<HTMLElement | null> }) {
  const context = useRendererContext()
  const { errors, showErrorSummary, submission } = context.state
  const titleId = makeDomId(context.document.formId, 'error-summary-title')
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
              {controlId === undefined ? error.message : <a href={`#${controlId}`}>{error.message}</a>}
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
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const titleId = makeDomId(context.document.formId, 'confirmation-title')
  const sourceId = context.state.submission.sourceComponentId
  const binding = sourceId === undefined ? undefined : findActionBinding(context.document.root, sourceId)
  const confirmation = binding?.confirm

  useEffect(() => {
    if (context.state.submission.status === 'awaiting_confirmation') {
      confirmButtonRef.current?.focus()
    }
  }, [context.state.submission.status])

  if (context.state.submission.status !== 'awaiting_confirmation' || confirmation === undefined) {
    return null
  }

  return (
    <section
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          context.controller.cancelPendingAction()
        }
      }}
      role="dialog"
    >
      <h2 id={titleId}>{confirmation.title}</h2>
      <p>{confirmation.message}</p>
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
  const [collapsed, setCollapsed] = useState(node.props.collapsible === true && node.props.defaultCollapsed === true)
  const contentId = makeDomId(node.id, 'content')
  const titleId = makeDomId(node.id, 'title')

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

  return (
    <FieldFrame node={node}>
      {(control) => (
        <textarea
          {...control}
          onBlur={() => context.controller.blur(node.dataPath)}
          onChange={(event) => context.controller.setValue(node.dataPath, event.currentTarget.value)}
          placeholder={node.props.placeholder}
          rows={node.props.rows}
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
      context.controller.setValue(node.dataPath, null)
      return
    }
    const parsed = Number(rawValue)
    if (Number.isFinite(parsed)) {
      context.controller.setValue(node.dataPath, parsed)
    }
  }

  function normalizeOnBlur(): void {
    if (draft !== '') {
      const parsed = Number(draft)
      if (Number.isFinite(parsed)) {
        context.controller.setValue(node.dataPath, parsed)
      } else {
        setDraft(toNumberDraft(context.state.fields[node.dataPath]?.value))
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
            onBlur={normalizeOnBlur}
            onChange={(event) => updateDraft(event.currentTarget.value)}
            placeholder={node.props.placeholder}
            step={node.props.step}
            type="number"
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
        return (
          <label htmlFor={optionId} key={`${node.id}:${index}`}>
            <input
              checked={sameOptionValue(value, option.value)}
              disabled={isFieldDisabled(node, context.state)}
              id={optionId}
              name={makeDomId(node.id, 'radio')}
              onBlur={() => context.controller.blur(node.dataPath)}
              onChange={() => context.controller.setValue(node.dataPath, option.value)}
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
        return (
          <label htmlFor={optionId} key={`${node.id}:${index}`}>
            <input
              checked={checked}
              disabled={isFieldDisabled(node, context.state)}
              id={optionId}
              onBlur={() => context.controller.blur(node.dataPath)}
              onChange={() => {
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
  const statusId = makeDomId(node.id, 'upload-status')
  const value = context.state.fields[node.dataPath]?.value
  const attachmentCount = Array.isArray(value) ? value.length : 0
  return (
    <FieldFrame node={node} supplementaryDescriptionIds={[statusId]}>
      {(control) => (
        <>
          <input
            {...control}
            accept={node.props.accept?.join(',')}
            disabled
            multiple={(node.props.maxFiles ?? 1) > 1}
            type="file"
          />
          <p id={statusId} role="status">
            {attachmentCount === 0
              ? 'File upload requires a host-provided upload transport.'
              : `${attachmentCount} uploaded file${attachmentCount === 1 ? '' : 's'} are attached.`}
          </p>
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
  const paragraphs = node.props.content.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '')
  return (
    <section aria-label={node.props.ariaLabel}>
      {paragraphs.map((paragraph, index) => <p key={`${node.id}:${index}`}>{paragraph}</p>)}
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
  return `a2ui-${encodeURIComponent(componentId)}-${suffix}`
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
