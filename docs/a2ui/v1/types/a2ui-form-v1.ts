/** Normative TypeScript types for the project-local A2UI Form Profile v1. */

export const A2UI_FORM_SCHEMA_VERSION = "1.0.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type DataPath = `/${string}`;
export type StableId = string;

export interface A2UIFormDocumentV1 {
  schemaVersion: typeof A2UI_FORM_SCHEMA_VERSION;
  requestId: StableId;
  formId: StableId;
  revision: number;
  generatedAt?: string;
  expiresAt?: string;
  root: FormNode;
  data: { initialValues: Record<string, JsonValue> };
  actions: ActionDefinition[];
  dataSources?: RemoteOptionsSource[];
  rules?: LinkRule[];
  meta?: { locale?: string; traceId?: StableId; title?: string };
}

export interface NodeBase<TType extends string, TProps> {
  id: StableId;
  type: TType;
  props: TProps;
  children: ComponentNode[];
  dataPath?: DataPath;
  action?: ActionBinding;
  validation?: Validator[];
}

export interface CommonInputProps {
  label: string;
  helpText?: string;
  disabled?: boolean;
  visible?: boolean;
}

export interface Option {
  label: string;
  value: string | number | boolean;
  disabled?: boolean;
}

export type FormNode = NodeBase<
  "Form",
  { title?: string; description?: string; submitOnEnter?: boolean }
>;

export type SectionNode = NodeBase<
  "Section",
  {
    title: string;
    description?: string;
    collapsible?: boolean;
    defaultCollapsed?: boolean;
    visible?: boolean;
  }
>;

export type TextInputNode = BoundLeafNode<
  "TextInput",
  CommonInputProps & {
    placeholder?: string;
    autoComplete?: string;
    inputMode?: "text" | "email" | "tel" | "url" | "search";
    readOnly?: boolean;
  }
>;

export type TextAreaNode = BoundLeafNode<
  "TextArea",
  CommonInputProps & { placeholder?: string; rows?: number; maxRows?: number }
>;

export type NumberInputNode = BoundLeafNode<
  "NumberInput",
  CommonInputProps & { placeholder?: string; step?: number; unit?: string }
>;

export type SelectNode = BoundLeafNode<
  "Select",
  CommonInputProps &
    { placeholder?: string; clearable?: boolean } &
    ({ options: Option[]; dataSourceId?: never } | { dataSourceId: StableId; options?: never })
>;

export type RadioGroupNode = BoundLeafNode<
  "RadioGroup",
  CommonInputProps & { options: Option[]; orientation?: "horizontal" | "vertical" }
>;

export type CheckboxGroupNode = BoundLeafNode<
  "CheckboxGroup",
  CommonInputProps & { options: Option[]; orientation?: "horizontal" | "vertical" }
>;

export type DatePickerNode = BoundLeafNode<
  "DatePicker",
  CommonInputProps & { placeholder?: string; minDate?: string; maxDate?: string }
>;

export type SwitchNode = BoundLeafNode<
  "Switch",
  CommonInputProps & { onLabel?: string; offLabel?: string }
>;

export type UploadNode = BoundLeafNode<
  "Upload",
  CommonInputProps & {
    accept?: string[];
    maxFiles?: number;
    maxSizeBytes?: number;
    buttonLabel?: string;
  }
> & { action: ActionBinding };

export type ButtonNode = LeafNode<
  "Button",
  {
    label: string;
    variant?: "primary" | "secondary" | "danger" | "text";
    loadingLabel?: string;
    disabled?: boolean;
    visible?: boolean;
  }
> & { action: ActionBinding };

export type AlertNode = LeafNode<
  "Alert",
  {
    title?: string;
    message: string;
    variant?: "info" | "success" | "warning" | "error";
    dismissible?: boolean;
    visible?: boolean;
  }
>;

export type MarkdownNode = LeafNode<
  "Markdown",
  { content: string; ariaLabel?: string; visible?: boolean }
>;

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
  | MarkdownNode;

export type LeafNode<TType extends string, TProps> = Omit<
  NodeBase<TType, TProps>,
  "children"
> & { children: [] };

export type BoundLeafNode<TType extends string, TProps> = LeafNode<TType, TProps> & {
  dataPath: DataPath;
};

export interface ActionBinding {
  actionId: StableId;
  confirm?: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
  };
}

export type ActionDefinition =
  | {
      id: StableId;
      type: "submit";
      endpointKey: string;
      method: "POST";
      timeoutMs?: number;
    }
  | { id: StableId; type: "reset" }
  | {
      id: StableId;
      type: "upload";
      endpointKey: string;
      method: "POST";
      fieldName?: string;
      timeoutMs?: number;
    };

export type Validator =
  | { type: "required"; message?: string; code?: string }
  | {
      type: "minLength" | "maxLength" | "minItems" | "maxItems";
      value: number;
      message?: string;
      code?: string;
    }
  | {
      type: "minimum" | "maximum";
      value: number;
      message?: string;
      code?: string;
    }
  | { type: "pattern"; value: string; message?: string; code?: string }
  | { type: "integer"; message?: string; code?: string };

export type Condition =
  | {
      op:
        | "equals"
        | "notEquals"
        | "greaterThan"
        | "greaterThanOrEqual"
        | "lessThan"
        | "lessThanOrEqual"
        | "in"
        | "notIn";
      path: DataPath;
      value: JsonValue;
    }
  | { op: "exists" | "isEmpty"; path: DataPath }
  | { op: "and" | "or"; args: Condition[] }
  | { op: "not"; arg: Condition };

export type RuleEffect =
  | {
      type: "setVisible" | "setDisabled";
      targetComponentId: StableId;
      value: boolean;
    }
  | { type: "setValue"; targetDataPath: DataPath; value: JsonValue };

export interface LinkRule {
  id: StableId;
  event: "change";
  sourceDataPath: DataPath;
  when: Condition;
  then: RuleEffect[];
  else?: RuleEffect[];
}

export type QuerySource =
  | { kind: "data"; path: DataPath }
  | { kind: "searchText" }
  | { kind: "literal"; value: string | number | boolean };

export interface RemoteOptionsSource {
  id: StableId;
  type: "remoteOptions";
  endpointKey: string;
  method: "GET";
  query: Array<{ name: string; source: QuerySource }>;
  response: {
    itemsPath: DataPath;
    labelPath: DataPath;
    valuePath: DataPath;
    disabledPath?: DataPath;
  };
  dependsOn?: DataPath[];
  debounceMs?: number;
  minQueryLength?: number;
  cacheTtlSeconds?: number;
}

export interface FormResolveRequestV1 {
  schemaVersion: typeof A2UI_FORM_SCHEMA_VERSION;
  requestId: StableId;
  formKey: StableId;
  context?: Record<string, JsonValue>;
  client: {
    supportedSchemaVersions: string[];
    supportedComponents: ComponentNode["type"][];
    locale?: string;
    timeZone?: string;
  };
}

export interface GeneralErrorV1 {
  code: string;
  message: string;
  retryable: boolean;
}

export interface FormResolveErrorV1 {
  schemaVersion: typeof A2UI_FORM_SCHEMA_VERSION;
  requestId: StableId;
  formKey: StableId;
  status: "error";
  errors: GeneralErrorV1[];
}

export type FormResolveResponseV1 = A2UIFormDocumentV1 | FormResolveErrorV1;

export interface FormSubmitRequestV1 {
  schemaVersion: typeof A2UI_FORM_SCHEMA_VERSION;
  requestId: StableId;
  idempotencyKey: StableId;
  formId: StableId;
  revision: number;
  action: { actionId: StableId; sourceComponentId: StableId };
  data: Record<string, JsonValue>;
  client?: { locale?: string; timeZone?: string };
}

export interface FieldErrorV1 {
  code: string;
  message: string;
  componentId?: StableId;
}

export type FormSubmitResponseV1 =
  | {
      schemaVersion: typeof A2UI_FORM_SCHEMA_VERSION;
      requestId: StableId;
      formId: StableId;
      status: "success";
      result: { submissionId: StableId; message?: string };
    }
  | {
      schemaVersion: typeof A2UI_FORM_SCHEMA_VERSION;
      requestId: StableId;
      formId: StableId;
      status: "validation_error";
      fieldErrors: Record<DataPath, FieldErrorV1[]>;
      errors?: GeneralErrorV1[];
    }
  | {
      schemaVersion: typeof A2UI_FORM_SCHEMA_VERSION;
      requestId: StableId;
      formId: StableId;
      status: "error";
      errors: GeneralErrorV1[];
    };
