/**
 * Runtime types for the frozen A2UI Form Profile v1 contract.
 *
 * These types intentionally describe data only. They contain no executable
 * expressions, URLs, headers, or component import paths.
 */

export const A2UI_FORM_SCHEMA_VERSION = '1.0.0' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue }
export type DataPath = `/${string}`
export type StableId = string

export type ComponentType =
  | 'Form'
  | 'Section'
  | 'TextInput'
  | 'TextArea'
  | 'NumberInput'
  | 'Select'
  | 'RadioGroup'
  | 'CheckboxGroup'
  | 'DatePicker'
  | 'Switch'
  | 'Upload'
  | 'Button'
  | 'Alert'
  | 'Markdown'

export interface CommonInputProps {
  readonly label: string
  readonly helpText?: string
  readonly disabled?: boolean
  readonly visible?: boolean
}

export interface Option {
  readonly label: string
  readonly value: string | number | boolean
  readonly disabled?: boolean
}

export interface FormProps {
  readonly title?: string
  readonly description?: string
  readonly submitOnEnter?: boolean
}

export interface SectionProps {
  readonly title: string
  readonly description?: string
  readonly collapsible?: boolean
  readonly defaultCollapsed?: boolean
  readonly visible?: boolean
}

export interface TextInputProps extends CommonInputProps {
  readonly placeholder?: string
  readonly autoComplete?: string
  readonly inputMode?: 'text' | 'email' | 'tel' | 'url' | 'search'
  readonly readOnly?: boolean
}

export interface TextAreaProps extends CommonInputProps {
  readonly placeholder?: string
  readonly rows?: number
  readonly maxRows?: number
}

export interface NumberInputProps extends CommonInputProps {
  readonly placeholder?: string
  readonly step?: number
  readonly unit?: string
}

export type SelectProps = CommonInputProps & {
  readonly placeholder?: string
  readonly clearable?: boolean
} &
  (
    | { readonly options: readonly Option[]; readonly dataSourceId?: never }
    | { readonly dataSourceId: StableId; readonly options?: never }
  )

export interface ChoiceProps extends CommonInputProps {
  readonly options: readonly Option[]
  readonly orientation?: 'horizontal' | 'vertical'
}

export interface DatePickerProps extends CommonInputProps {
  readonly placeholder?: string
  readonly minDate?: string
  readonly maxDate?: string
}

export interface SwitchProps extends CommonInputProps {
  readonly onLabel?: string
  readonly offLabel?: string
}

export interface UploadProps extends CommonInputProps {
  readonly accept?: readonly string[]
  readonly maxFiles?: number
  readonly maxSizeBytes?: number
  readonly buttonLabel?: string
}

export interface ButtonProps {
  readonly label: string
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'text'
  readonly loadingLabel?: string
  readonly disabled?: boolean
  readonly visible?: boolean
}

export interface AlertProps {
  readonly title?: string
  readonly message: string
  readonly variant?: 'info' | 'success' | 'warning' | 'error'
  readonly dismissible?: boolean
  readonly visible?: boolean
}

export interface MarkdownProps {
  readonly content: string
  readonly ariaLabel?: string
  readonly visible?: boolean
}

export interface ComponentPropsByType {
  readonly Form: FormProps
  readonly Section: SectionProps
  readonly TextInput: TextInputProps
  readonly TextArea: TextAreaProps
  readonly NumberInput: NumberInputProps
  readonly Select: SelectProps
  readonly RadioGroup: ChoiceProps
  readonly CheckboxGroup: ChoiceProps
  readonly DatePicker: DatePickerProps
  readonly Switch: SwitchProps
  readonly Upload: UploadProps
  readonly Button: ButtonProps
  readonly Alert: AlertProps
  readonly Markdown: MarkdownProps
}

export interface ActionBinding {
  readonly actionId: StableId
  readonly confirm?: {
    readonly title: string
    readonly message: string
    readonly confirmLabel?: string
    readonly cancelLabel?: string
  }
}

export type Validator =
  | { readonly type: 'required'; readonly message?: string; readonly code?: string }
  | {
      readonly type: 'minLength' | 'maxLength' | 'minItems' | 'maxItems'
      readonly value: number
      readonly message?: string
      readonly code?: string
    }
  | {
      readonly type: 'minimum' | 'maximum'
      readonly value: number
      readonly message?: string
      readonly code?: string
    }
  | { readonly type: 'pattern'; readonly value: string; readonly message?: string; readonly code?: string }
  | { readonly type: 'integer'; readonly message?: string; readonly code?: string }

export type Condition =
  | {
      readonly op:
        | 'equals'
        | 'notEquals'
        | 'greaterThan'
        | 'greaterThanOrEqual'
        | 'lessThan'
        | 'lessThanOrEqual'
        | 'in'
        | 'notIn'
      readonly path: DataPath
      readonly value: JsonValue
    }
  | { readonly op: 'exists' | 'isEmpty'; readonly path: DataPath }
  | { readonly op: 'and' | 'or'; readonly args: readonly Condition[] }
  | { readonly op: 'not'; readonly arg: Condition }

export type RuleEffect =
  | {
      readonly type: 'setVisible' | 'setDisabled'
      readonly targetComponentId: StableId
      readonly value: boolean
    }
  | { readonly type: 'setValue'; readonly targetDataPath: DataPath; readonly value: JsonValue }

export interface LinkRule {
  readonly id: StableId
  readonly event: 'change'
  readonly sourceDataPath: DataPath
  readonly when: Condition
  readonly then: readonly RuleEffect[]
  readonly else?: readonly RuleEffect[]
}

export type ActionDefinition =
  | {
      readonly id: StableId
      readonly type: 'submit'
      readonly endpointKey: string
      readonly method: 'POST'
      readonly timeoutMs?: number
    }
  | { readonly id: StableId; readonly type: 'reset' }
  | {
      readonly id: StableId
      readonly type: 'upload'
      readonly endpointKey: string
      readonly method: 'POST'
      readonly fieldName?: string
      readonly timeoutMs?: number
    }

export interface RemoteOptionsSource {
  readonly id: StableId
  readonly type: 'remoteOptions'
  readonly endpointKey: string
}

export interface NodeBase<TType extends ComponentType> {
  readonly id: StableId
  readonly type: TType
  readonly props: ComponentPropsByType[TType]
  readonly children: readonly ComponentNode[]
  readonly dataPath?: DataPath
  readonly action?: ActionBinding
  readonly validation?: readonly Validator[]
}

export type FormNode = NodeBase<'Form'>
export type SectionNode = NodeBase<'Section'>
export type TextInputNode = NodeBase<'TextInput'> & { readonly dataPath: DataPath }
export type TextAreaNode = NodeBase<'TextArea'> & { readonly dataPath: DataPath }
export type NumberInputNode = NodeBase<'NumberInput'> & { readonly dataPath: DataPath }
export type SelectNode = NodeBase<'Select'> & { readonly dataPath: DataPath }
export type RadioGroupNode = NodeBase<'RadioGroup'> & { readonly dataPath: DataPath }
export type CheckboxGroupNode = NodeBase<'CheckboxGroup'> & { readonly dataPath: DataPath }
export type DatePickerNode = NodeBase<'DatePicker'> & { readonly dataPath: DataPath }
export type SwitchNode = NodeBase<'Switch'> & { readonly dataPath: DataPath }
export type UploadNode = NodeBase<'Upload'> & {
  readonly dataPath: DataPath
  readonly action: ActionBinding
}
export type ButtonNode = NodeBase<'Button'> & { readonly action: ActionBinding }
export type AlertNode = NodeBase<'Alert'>
export type MarkdownNode = NodeBase<'Markdown'>

export type ComponentNode =
  | FormNode
  | SectionNode
  | TextInputNode
  | TextAreaNode
  | NumberInputNode
  | SelectNode
  | RadioGroupNode
  | CheckboxGroupNode
  | DatePickerNode
  | SwitchNode
  | UploadNode
  | ButtonNode
  | AlertNode
  | MarkdownNode

export interface A2UIFormDocumentV1 {
  readonly schemaVersion: typeof A2UI_FORM_SCHEMA_VERSION
  readonly requestId: StableId
  readonly formId: StableId
  readonly revision: number
  readonly generatedAt?: string
  readonly expiresAt?: string
  readonly root: FormNode
  readonly data: { readonly initialValues: Readonly<Record<string, JsonValue>> }
  readonly actions: readonly ActionDefinition[]
  readonly dataSources?: readonly RemoteOptionsSource[]
  readonly rules?: readonly LinkRule[]
  readonly meta?: { readonly locale?: string; readonly traceId?: StableId; readonly title?: string }
}

/** A parser result with all v1 defaults materialized for downstream stages. */
export interface NormalizedA2UIFormDocumentV1 extends A2UIFormDocumentV1 {
  readonly dataSources: readonly RemoteOptionsSource[]
  readonly rules: readonly LinkRule[]
}
