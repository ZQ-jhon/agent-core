import { A2UI_FORM_SCHEMA_VERSION } from './types.ts'
import { isCompatibleBoundValue } from './bound-value.ts'
import { cloneJsonValue, getDataPathValue } from './data-path.ts'
import type { ParseResult, SchemaDiagnostic, SchemaErrorCode } from './errors.ts'
import type {
  A2UIFormDocumentV1,
  ActionBinding,
  ActionDefinition,
  ComponentNode,
  ComponentPropsByType,
  ComponentType,
  Condition,
  DataPath,
  JsonValue,
  LinkRule,
  NormalizedA2UIFormDocumentV1,
  Option,
  RemoteOptionsSource,
  RuleEffect,
  Validator,
} from './types.ts'
import { componentRegistry, isRegisteredComponentType } from './registry.ts'

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const dataPathPattern = /^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/
const endpointKeyPattern = /^[A-Za-z][A-Za-z0-9._-]*$/
const customCodePattern = /^[A-Z][A-Z0-9_]*$/
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const MAX_COMPONENT_DEPTH = 32
const MAX_COMPONENT_NODES = 200
const MAX_CONDITION_DEPTH = 16
const MAX_JSON_VALUE_DEPTH = 64
const MAX_SCHEMA_JSON_CHARACTERS = 1_000_000

type UnknownRecord = Record<string, unknown>

interface ParseContext {
  readonly errors: SchemaDiagnostic[]
  readonly supportedSchemaVersions: ReadonlySet<string>
  readonly nodePaths: Map<string, string>
  readonly nodes: ComponentNode[]
  nodeCount: number
}

export interface ParseOptions {
  /** Explicit protocol versions the host agrees to render. Defaults to v1 only. */
  readonly supportedSchemaVersions?: readonly string[]
}

/**
 * Parse a server-provided value into a normalized, strongly typed A2UI v1
 * document. The parser performs no network calls and evaluates no expressions.
 */
export function parseA2UIFormDocument(
  input: unknown,
  options: ParseOptions = {},
): ParseResult<NormalizedA2UIFormDocumentV1> {
  const context: ParseContext = {
    errors: [],
    supportedSchemaVersions: new Set(options.supportedSchemaVersions ?? [A2UI_FORM_SCHEMA_VERSION]),
    nodePaths: new Map(),
    nodes: [],
    nodeCount: 0,
  }

  if (!isRecord(input)) {
    addError(context, 'SCHEMA_INVALID', 'Schema document must be a JSON object.', '/')
    return failure(context)
  }

  rejectUnknownKeys(
    context,
    input,
    '/',
    [
      'schemaVersion',
      'requestId',
      'formId',
      'revision',
      'generatedAt',
      'expiresAt',
      'root',
      'data',
      'actions',
      'dataSources',
      'rules',
      'meta',
    ],
  )

  const schemaVersion = readString(context, input, 'schemaVersion', '/', { required: true })
  if (schemaVersion !== undefined && !context.supportedSchemaVersions.has(schemaVersion)) {
    addError(
      context,
      'SCHEMA_VERSION_UNSUPPORTED',
      'This schema version is not explicitly supported by this client.',
      '/schemaVersion',
    )
  }
  if (schemaVersion !== undefined && schemaVersion !== A2UI_FORM_SCHEMA_VERSION) {
    addError(
      context,
      'SCHEMA_VERSION_UNSUPPORTED',
      'Only the frozen A2UI Form Profile v1 contract can be parsed by this runtime.',
      '/schemaVersion',
    )
  }

  const requestId = readStableId(context, input, 'requestId', '/')
  const formId = readStableId(context, input, 'formId', '/')
  const revision = readNumber(context, input, 'revision', '/', {
    required: true,
    integer: true,
    min: 1,
  })
  const generatedAt = readDateTime(context, input, 'generatedAt', '/')
  const expiresAt = readDateTime(context, input, 'expiresAt', '/')
  if (generatedAt !== undefined && expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(generatedAt)) {
    addError(context, 'SCHEMA_SEMANTIC_INVALID', 'expiresAt must be later than generatedAt.', '/expiresAt')
  }

  const initialValues = parseInitialValues(input.data, '/data', context)
  const actions = parseActions(input.actions, '/actions', context)
  const dataSources = parseDataSources(input.dataSources, '/dataSources', context)
  const rules = parseRules(input.rules, '/rules', context)
  const meta = parseMeta(input.meta, '/meta', context)
  const root = parseNode(input.root, '/root', context, undefined, 0)

  if (root !== undefined && root.type !== 'Form') {
    addError(context, 'SCHEMA_SEMANTIC_INVALID', 'The document root must be a Form component.', '/root/type', root.id)
  }

  if (root !== undefined && initialValues !== undefined) {
    validateDocumentSemantics(context, root, initialValues, actions, dataSources, rules)
  }

  if (
    context.errors.length > 0 ||
    schemaVersion === undefined ||
    requestId === undefined ||
    formId === undefined ||
    revision === undefined ||
    initialValues === undefined ||
    root === undefined ||
    root.type !== 'Form'
  ) {
    return failure(context)
  }

  const document: NormalizedA2UIFormDocumentV1 = {
    schemaVersion: A2UI_FORM_SCHEMA_VERSION,
    requestId,
    formId,
    revision,
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    root,
    data: { initialValues },
    actions,
    dataSources,
    rules,
    ...(meta === undefined ? {} : { meta }),
  }

  return { ok: true, value: deepFreeze(document), errors: [] }
}

/** Alias used by later stages as the single controlled schema entry point. */
export const parseSchema = parseA2UIFormDocument

/** Parse JSON transport safely before applying the same controlled schema gate. */
export function parseA2UIJson(
  source: string,
  options: ParseOptions = {},
): ParseResult<NormalizedA2UIFormDocumentV1> {
  if (source.length > MAX_SCHEMA_JSON_CHARACTERS) {
    return {
      ok: false,
      errors: [
        {
          code: 'SCHEMA_INVALID',
          message: 'Schema response exceeds the client safety limit.',
          path: '/',
        },
      ],
    }
  }
  try {
    return parseA2UIFormDocument(JSON.parse(source) as unknown, options)
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: 'SCHEMA_INVALID',
          message: 'Schema response is not valid JSON.',
          path: '/',
        },
      ],
    }
  }
}

function failure(context: ParseContext): ParseResult<never> {
  return { ok: false, errors: Object.freeze([...context.errors]) }
}

function addError(
  context: ParseContext,
  code: SchemaErrorCode,
  message: string,
  path: string,
  componentId?: string,
): void {
  context.errors.push({ code, message, path, ...(componentId === undefined ? {} : { componentId }) })
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (depth > MAX_JSON_VALUE_DEPTH || typeof value !== 'object' || value === null || seen.has(value)) {
    return false
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, seen, depth + 1))
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return false
  }
  return Object.values(value).every((item) => isJsonValue(item, seen, depth + 1))
}

function rejectUnknownKeys(
  context: ParseContext,
  record: UnknownRecord,
  path: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      addError(context, 'SCHEMA_INVALID', 'Unknown fields are not allowed in the v1 schema.', pointer(path, key))
    }
  }
}

interface StringOptions {
  readonly required?: boolean
  readonly min?: number
  readonly max?: number
  readonly pattern?: RegExp
}

function readString(
  context: ParseContext,
  record: UnknownRecord,
  key: string,
  path: string,
  options: StringOptions = {},
): string | undefined {
  const value = record[key]
  const propertyPath = pointer(path, key)
  if (value === undefined) {
    if (options.required === true) {
      addError(context, 'SCHEMA_INVALID', 'Required field is missing.', propertyPath)
    }
    return undefined
  }
  if (typeof value !== 'string') {
    addError(context, 'SCHEMA_INVALID', 'Field must be a string.', propertyPath)
    return undefined
  }
  if (options.min !== undefined && value.length < options.min) {
    addError(context, 'SCHEMA_INVALID', `String must contain at least ${options.min} character(s).`, propertyPath)
  }
  if (options.max !== undefined && value.length > options.max) {
    addError(context, 'SCHEMA_INVALID', `String must contain at most ${options.max} character(s).`, propertyPath)
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    addError(context, 'SCHEMA_INVALID', 'Field has an invalid format.', propertyPath)
  }
  return value
}

interface NumberOptions {
  readonly required?: boolean
  readonly integer?: boolean
  readonly min?: number
  readonly exclusiveMin?: number
  readonly max?: number
}

function readNumber(
  context: ParseContext,
  record: UnknownRecord,
  key: string,
  path: string,
  options: NumberOptions = {},
): number | undefined {
  const value = record[key]
  const propertyPath = pointer(path, key)
  if (value === undefined) {
    if (options.required === true) {
      addError(context, 'SCHEMA_INVALID', 'Required field is missing.', propertyPath)
    }
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addError(context, 'SCHEMA_INVALID', 'Field must be a finite number.', propertyPath)
    return undefined
  }
  if (options.integer === true && !Number.isInteger(value)) {
    addError(context, 'SCHEMA_INVALID', 'Field must be an integer.', propertyPath)
  }
  if (options.min !== undefined && value < options.min) {
    addError(context, 'SCHEMA_INVALID', `Number must be at least ${options.min}.`, propertyPath)
  }
  if (options.exclusiveMin !== undefined && value <= options.exclusiveMin) {
    addError(context, 'SCHEMA_INVALID', `Number must be greater than ${options.exclusiveMin}.`, propertyPath)
  }
  if (options.max !== undefined && value > options.max) {
    addError(context, 'SCHEMA_INVALID', `Number must be at most ${options.max}.`, propertyPath)
  }
  return value
}

function readBoolean(context: ParseContext, record: UnknownRecord, key: string, path: string): boolean | undefined {
  const value = record[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    addError(context, 'SCHEMA_INVALID', 'Field must be a boolean.', pointer(path, key))
    return undefined
  }
  return value
}

function readStableId(context: ParseContext, record: UnknownRecord, key: string, path: string): string | undefined {
  return readString(context, record, key, path, { required: true, min: 1, max: 128, pattern: stableIdPattern })
}

function readDataPath(context: ParseContext, record: UnknownRecord, key: string, path: string): DataPath | undefined {
  const value = readString(context, record, key, path, { required: true, min: 1, max: 512, pattern: dataPathPattern })
  return value === undefined ? undefined : (value as DataPath)
}

function readDateTime(context: ParseContext, record: UnknownRecord, key: string, path: string): string | undefined {
  const value = record[key]
  if (value === undefined) {
    return undefined
  }
  const parsed = readString(context, record, key, path, { pattern: rfc3339Pattern })
  if (parsed !== undefined && !Number.isFinite(Date.parse(parsed))) {
    addError(context, 'SCHEMA_INVALID', 'Field must be a valid RFC 3339 date-time.', pointer(path, key))
  }
  return parsed
}

function parseInitialValues(value: unknown, path: string, context: ParseContext): Readonly<Record<string, JsonValue>> | undefined {
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'data must be an object.', path)
    return undefined
  }
  rejectUnknownKeys(context, value, path, ['initialValues'])
  const initialValues = value.initialValues
  if (!isRecord(initialValues) || !isJsonValue(initialValues)) {
    addError(context, 'SCHEMA_INVALID', 'data.initialValues must be a JSON object.', pointer(path, 'initialValues'))
    return undefined
  }
  return cloneJsonValue(initialValues) as Readonly<Record<string, JsonValue>>
}

function parseActions(value: unknown, path: string, context: ParseContext): readonly ActionDefinition[] {
  if (!Array.isArray(value)) {
    addError(context, 'SCHEMA_INVALID', 'actions must be an array.', path)
    return []
  }
  const ids = new Set<string>()
  const result: ActionDefinition[] = []
  value.forEach((item, index) => {
    const action = parseAction(item, `${path}/${index}`, context)
    if (action === undefined) {
      return
    }
    if (ids.has(action.id)) {
      addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Action ids must be unique.', `${path}/${index}/id`)
    }
    ids.add(action.id)
    result.push(action)
  })
  return result
}

function parseAction(value: unknown, path: string, context: ParseContext): ActionDefinition | undefined {
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'Action definition must be an object.', path)
    return undefined
  }
  const type = readString(context, value, 'type', path, { required: true })
  const id = readStableId(context, value, 'id', path)
  if (type === 'reset') {
    rejectUnknownKeys(context, value, path, ['id', 'type'])
    return id === undefined ? undefined : { id, type: 'reset' }
  }
  if (type !== 'submit' && type !== 'upload') {
    addError(context, 'SCHEMA_INVALID', 'Action type must be submit, reset, or upload.', pointer(path, 'type'))
    return undefined
  }
  rejectUnknownKeys(context, value, path, ['id', 'type', 'endpointKey', 'method', 'fieldName', 'timeoutMs'])
  const endpointKey = readString(context, value, 'endpointKey', path, {
    required: true,
    min: 1,
    max: 128,
    pattern: endpointKeyPattern,
  })
  const method = readString(context, value, 'method', path, { required: true })
  if (method !== undefined && method !== 'POST') {
    addError(context, 'SCHEMA_INVALID', 'Only POST actions are permitted by v1.', pointer(path, 'method'))
  }
  const timeoutMs = readNumber(context, value, 'timeoutMs', path, {
    integer: true,
    min: 1000,
    max: type === 'submit' ? 60000 : 120000,
  })
  if (type === 'submit') {
    if (value.fieldName !== undefined) {
      addError(context, 'SCHEMA_INVALID', 'fieldName is only valid for upload actions.', pointer(path, 'fieldName'))
    }
    if (id === undefined || endpointKey === undefined || method !== 'POST') {
      return undefined
    }
    return { id, type, endpointKey, method, timeoutMs: timeoutMs ?? 15000 }
  }
  const fieldName = readString(context, value, 'fieldName', path, { min: 1, max: 80 })
  if (id === undefined || endpointKey === undefined || method !== 'POST') {
    return undefined
  }
  return { id, type, endpointKey, method, fieldName: fieldName ?? 'file', timeoutMs: timeoutMs ?? 30000 }
}

function parseDataSources(value: unknown, path: string, context: ParseContext): readonly RemoteOptionsSource[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    addError(context, 'SCHEMA_INVALID', 'dataSources must be an array.', path)
    return []
  }
  const ids = new Set<string>()
  const result: RemoteOptionsSource[] = []
  value.forEach((item, index) => {
    const itemPath = `${path}/${index}`
    if (!isRecord(item)) {
      addError(context, 'SCHEMA_INVALID', 'Data source definition must be an object.', itemPath)
      return
    }
    rejectUnknownKeys(context, item, itemPath, ['id', 'type', 'endpointKey'])
    const id = readStableId(context, item, 'id', itemPath)
    const type = readString(context, item, 'type', itemPath, { required: true })
    const endpointKey = readString(context, item, 'endpointKey', itemPath, {
      required: true,
      min: 1,
      max: 128,
      pattern: endpointKeyPattern,
    })
    if (type !== undefined && type !== 'remoteOptions') {
      addError(context, 'SCHEMA_INVALID', 'Only remoteOptions data sources are allowed.', `${itemPath}/type`)
    }
    if (id === undefined || endpointKey === undefined || type !== 'remoteOptions') {
      return
    }
    if (ids.has(id)) {
      addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Data source ids must be unique.', `${itemPath}/id`)
    }
    ids.add(id)
    result.push({ id, type: 'remoteOptions', endpointKey })
  })
  return result
}

function parseMeta(value: unknown, path: string, context: ParseContext): A2UIFormDocumentV1['meta'] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'meta must be an object.', path)
    return undefined
  }
  rejectUnknownKeys(context, value, path, ['locale', 'traceId', 'title'])
  const locale = readString(context, value, 'locale', path, { min: 2, max: 35 })
  const traceId = value.traceId === undefined ? undefined : readStableId(context, value, 'traceId', path)
  const title = readString(context, value, 'title', path, { max: 200 })
  return {
    ...(locale === undefined ? {} : { locale }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(title === undefined ? {} : { title }),
  }
}

function parseNode(
  value: unknown,
  path: string,
  context: ParseContext,
  parentType: ComponentType | undefined,
  depth: number,
): ComponentNode | undefined {
  if (depth > MAX_COMPONENT_DEPTH) {
    addError(context, 'SCHEMA_INVALID', 'Component tree exceeds the client safety depth limit.', path)
    return undefined
  }
  context.nodeCount += 1
  if (context.nodeCount > MAX_COMPONENT_NODES) {
    addError(context, 'SCHEMA_INVALID', 'Component tree exceeds the client safety node limit.', path)
    return undefined
  }
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'Component node must be an object.', path)
    return undefined
  }
  rejectUnknownKeys(context, value, path, ['id', 'type', 'props', 'children', 'dataPath', 'action', 'validation'])
  const id = readStableId(context, value, 'id', path)
  const rawType = readString(context, value, 'type', path, { required: true })
  if (!isRegisteredComponentType(rawType)) {
    addError(context, 'COMPONENT_UNSUPPORTED', 'Component type is not in the client allowlist.', `${path}/type`, id)
    return undefined
  }
  if (id !== undefined) {
    const firstPath = context.nodePaths.get(id)
    if (firstPath !== undefined) {
      addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Component ids must be globally unique.', `${path}/id`, id)
    } else {
      context.nodePaths.set(id, path)
    }
  }
  if (rawType === 'Form' && parentType !== undefined) {
    addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Form can only appear at the document root.', `${path}/type`, id)
  }

  const props = parseProps(rawType, value.props, `${path}/props`, context)
  const registration = componentRegistry[rawType]
  const children = parseChildren(value.children, `${path}/children`, context, rawType, depth)
  if (!registration.acceptsChildren && children.length > 0) {
    addError(context, 'SCHEMA_INVALID', 'This component must not contain children.', `${path}/children`, id)
  }
  if (rawType === 'Form' && children.length === 0) {
    addError(context, 'SCHEMA_INVALID', 'Form must contain at least one child component.', `${path}/children`, id)
  }

  const dataPath = value.dataPath === undefined ? undefined : readDataPath(context, value, 'dataPath', path)
  if (registration.requiresDataPath && dataPath === undefined) {
    addError(context, 'DATA_BINDING_INVALID', 'This input component requires a dataPath.', `${path}/dataPath`, id)
  }
  if (!registration.requiresDataPath && value.dataPath !== undefined) {
    addError(context, 'SCHEMA_INVALID', 'This component must not define a dataPath.', `${path}/dataPath`, id)
  }

  const action = value.action === undefined ? undefined : parseActionBinding(value.action, `${path}/action`, context)
  const actionIsAllowed = rawType === 'Button' || rawType === 'Upload'
  if (!actionIsAllowed && value.action !== undefined) {
    addError(context, 'SCHEMA_INVALID', 'This component must not define an action.', `${path}/action`, id)
  }
  if ((rawType === 'Button' || rawType === 'Upload') && action === undefined) {
    addError(context, 'SCHEMA_INVALID', 'This component requires an action binding.', `${path}/action`, id)
  }

  const validation = value.validation === undefined ? undefined : parseValidators(value.validation, `${path}/validation`, context)
  if (!registration.requiresDataPath && value.validation !== undefined) {
    addError(context, 'SCHEMA_INVALID', 'Only input components may declare validation.', `${path}/validation`, id)
  }

  if (id === undefined) {
    return undefined
  }
  const node = {
    id,
    type: rawType,
    props,
    children,
    ...(dataPath === undefined ? {} : { dataPath }),
    ...(action === undefined ? {} : { action }),
    ...(validation === undefined ? {} : { validation }),
  } as unknown as ComponentNode
  context.nodes.push(node)
  return node
}

function parseChildren(
  value: unknown,
  path: string,
  context: ParseContext,
  parentType: ComponentType,
  depth: number,
): readonly ComponentNode[] {
  if (!Array.isArray(value)) {
    addError(context, 'SCHEMA_INVALID', 'children must be an array.', path)
    return []
  }
  if (value.length > MAX_COMPONENT_NODES) {
    addError(context, 'SCHEMA_INVALID', 'children exceeds the client safety node limit.', path)
  }
  const children: ComponentNode[] = []
  value.slice(0, MAX_COMPONENT_NODES).forEach((child, index) => {
    const node = parseNode(child, `${path}/${index}`, context, parentType, depth + 1)
    if (node !== undefined) {
      children.push(node)
    }
  })
  return children
}

function parseProps(
  type: ComponentType,
  value: unknown,
  path: string,
  context: ParseContext,
): ComponentPropsByType[ComponentType] {
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'props must be an object.', path)
    return {} as ComponentPropsByType[ComponentType]
  }
  switch (type) {
    case 'Form':
      rejectUnknownKeys(context, value, path, ['title', 'description', 'submitOnEnter'])
      return {
        ...(withString(readString(context, value, 'title', path, { max: 200 }), 'title')),
        ...(withString(readString(context, value, 'description', path, { max: 1000 }), 'description')),
        submitOnEnter: readBoolean(context, value, 'submitOnEnter', path) ?? false,
      }
    case 'Section':
      rejectUnknownKeys(context, value, path, ['title', 'description', 'collapsible', 'defaultCollapsed', 'visible'])
      return {
        title: readString(context, value, 'title', path, { required: true, min: 1, max: 200 }) ?? '',
        ...(withString(readString(context, value, 'description', path, { max: 1000 }), 'description')),
        collapsible: readBoolean(context, value, 'collapsible', path) ?? false,
        defaultCollapsed: readBoolean(context, value, 'defaultCollapsed', path) ?? false,
        visible: readBoolean(context, value, 'visible', path) ?? true,
      }
    case 'TextInput':
      rejectUnknownKeys(context, value, path, [
        'label',
        'helpText',
        'disabled',
        'visible',
        'placeholder',
        'autoComplete',
        'inputMode',
        'readOnly',
      ])
      return {
        ...parseCommonInputProps(value, path, context),
        ...(withString(readString(context, value, 'placeholder', path, { max: 200 }), 'placeholder')),
        ...(withString(readString(context, value, 'autoComplete', path, { max: 80 }), 'autoComplete')),
        ...(withEnum(readEnum(context, value, 'inputMode', path, ['text', 'email', 'tel', 'url', 'search'] as const))),
        readOnly: readBoolean(context, value, 'readOnly', path) ?? false,
      }
    case 'TextArea': {
      rejectUnknownKeys(context, value, path, ['label', 'helpText', 'disabled', 'visible', 'placeholder', 'rows', 'maxRows'])
      const rows = readNumber(context, value, 'rows', path, { integer: true, min: 2, max: 20 }) ?? 4
      const maxRows = readNumber(context, value, 'maxRows', path, { integer: true, min: 2, max: 40 })
      if (maxRows !== undefined && maxRows < rows) {
        addError(context, 'SCHEMA_SEMANTIC_INVALID', 'maxRows must be greater than or equal to rows.', `${path}/maxRows`)
      }
      return {
        ...parseCommonInputProps(value, path, context),
        ...(withString(readString(context, value, 'placeholder', path, { max: 200 }), 'placeholder')),
        rows,
        ...(withNumber(maxRows, 'maxRows')),
      }
    }
    case 'NumberInput':
      rejectUnknownKeys(context, value, path, ['label', 'helpText', 'disabled', 'visible', 'placeholder', 'step', 'unit'])
      return {
        ...parseCommonInputProps(value, path, context),
        ...(withString(readString(context, value, 'placeholder', path, { max: 200 }), 'placeholder')),
        step: readNumber(context, value, 'step', path, { exclusiveMin: 0 }) ?? 1,
        ...(withString(readString(context, value, 'unit', path, { max: 30 }), 'unit')),
      }
    case 'Select':
      rejectUnknownKeys(context, value, path, ['label', 'helpText', 'disabled', 'visible', 'placeholder', 'clearable', 'options', 'dataSourceId'])
      return parseSelectProps(value, path, context)
    case 'RadioGroup':
    case 'CheckboxGroup':
      rejectUnknownKeys(context, value, path, ['label', 'helpText', 'disabled', 'visible', 'options', 'orientation'])
      return {
        ...parseCommonInputProps(value, path, context),
        options: parseOptions(value.options, `${path}/options`, context),
        orientation: readEnum(context, value, 'orientation', path, ['horizontal', 'vertical'] as const) ?? 'vertical',
      }
    case 'DatePicker': {
      rejectUnknownKeys(context, value, path, ['label', 'helpText', 'disabled', 'visible', 'placeholder', 'minDate', 'maxDate'])
      const minDate = readDate(context, value, 'minDate', path)
      const maxDate = readDate(context, value, 'maxDate', path)
      if (minDate !== undefined && maxDate !== undefined && minDate > maxDate) {
        addError(context, 'SCHEMA_SEMANTIC_INVALID', 'maxDate must not be earlier than minDate.', `${path}/maxDate`)
      }
      return {
        ...parseCommonInputProps(value, path, context),
        ...(withString(readString(context, value, 'placeholder', path, { max: 200 }), 'placeholder')),
        ...(withString(minDate, 'minDate')),
        ...(withString(maxDate, 'maxDate')),
      }
    }
    case 'Switch':
      rejectUnknownKeys(context, value, path, ['label', 'helpText', 'disabled', 'visible', 'onLabel', 'offLabel'])
      return {
        ...parseCommonInputProps(value, path, context),
        ...(withString(readString(context, value, 'onLabel', path, { max: 40 }), 'onLabel')),
        ...(withString(readString(context, value, 'offLabel', path, { max: 40 }), 'offLabel')),
      }
    case 'Upload':
      rejectUnknownKeys(context, value, path, ['label', 'helpText', 'disabled', 'visible', 'accept', 'maxFiles', 'maxSizeBytes', 'buttonLabel'])
      return {
        ...parseCommonInputProps(value, path, context),
        ...(withStringArray(parseStringArray(value.accept, `${path}/accept`, context, { min: 1, max: 100 }), 'accept')),
        maxFiles: readNumber(context, value, 'maxFiles', path, { integer: true, min: 1, max: 20 }) ?? 1,
        ...(withNumber(readNumber(context, value, 'maxSizeBytes', path, { integer: true, min: 1 }), 'maxSizeBytes')),
        ...(withString(readString(context, value, 'buttonLabel', path, { max: 80 }), 'buttonLabel')),
      }
    case 'Button':
      rejectUnknownKeys(context, value, path, ['label', 'variant', 'loadingLabel', 'disabled', 'visible'])
      return {
        label: readString(context, value, 'label', path, { required: true, min: 1, max: 80 }) ?? '',
        variant: readEnum(context, value, 'variant', path, ['primary', 'secondary', 'danger', 'text'] as const) ?? 'secondary',
        ...(withString(readString(context, value, 'loadingLabel', path, { max: 80 }), 'loadingLabel')),
        disabled: readBoolean(context, value, 'disabled', path) ?? false,
        visible: readBoolean(context, value, 'visible', path) ?? true,
      }
    case 'Alert':
      rejectUnknownKeys(context, value, path, ['title', 'message', 'variant', 'dismissible', 'visible'])
      return {
        ...(withString(readString(context, value, 'title', path, { max: 120 }), 'title')),
        message: readString(context, value, 'message', path, { required: true, min: 1, max: 2000 }) ?? '',
        variant: readEnum(context, value, 'variant', path, ['info', 'success', 'warning', 'error'] as const) ?? 'info',
        dismissible: readBoolean(context, value, 'dismissible', path) ?? false,
        visible: readBoolean(context, value, 'visible', path) ?? true,
      }
    case 'Markdown':
      rejectUnknownKeys(context, value, path, ['content', 'ariaLabel', 'visible'])
      return {
        content: readString(context, value, 'content', path, { required: true, max: 20000 }) ?? '',
        ...(withString(readString(context, value, 'ariaLabel', path, { max: 200 }), 'ariaLabel')),
        visible: readBoolean(context, value, 'visible', path) ?? true,
      }
  }
}

function parseCommonInputProps(value: UnknownRecord, path: string, context: ParseContext) {
  return {
    label: readString(context, value, 'label', path, { required: true, min: 1, max: 200 }) ?? '',
    ...(withString(readString(context, value, 'helpText', path, { max: 500 }), 'helpText')),
    disabled: readBoolean(context, value, 'disabled', path) ?? false,
    visible: readBoolean(context, value, 'visible', path) ?? true,
  }
}

function parseSelectProps(value: UnknownRecord, path: string, context: ParseContext): ComponentPropsByType['Select'] {
  const common = parseCommonInputProps(value, path, context)
  const options = value.options === undefined ? undefined : parseOptions(value.options, `${path}/options`, context)
  const dataSourceId = value.dataSourceId === undefined ? undefined : readStableId(context, value, 'dataSourceId', path)
  if ((options === undefined && dataSourceId === undefined) || (options !== undefined && dataSourceId !== undefined)) {
    addError(context, 'SCHEMA_INVALID', 'Select must define exactly one of options or dataSourceId.', path)
  }
  const shared = {
    ...common,
    ...(withString(readString(context, value, 'placeholder', path, { max: 200 }), 'placeholder')),
    clearable: readBoolean(context, value, 'clearable', path) ?? true,
  }
  if (dataSourceId !== undefined) {
    return { ...shared, dataSourceId }
  }
  return { ...shared, options: options ?? [] }
}

function parseOptions(value: unknown, path: string, context: ParseContext): readonly Option[] {
  if (!Array.isArray(value) || value.length === 0) {
    addError(context, 'SCHEMA_INVALID', 'options must be a non-empty array.', path)
    return []
  }
  const options: Option[] = []
  const identities = new Set<string>()
  let valueType: 'string' | 'number' | 'boolean' | undefined
  value.forEach((item, index) => {
    const itemPath = `${path}/${index}`
    if (!isRecord(item)) {
      addError(context, 'SCHEMA_INVALID', 'Option must be an object.', itemPath)
      return
    }
    rejectUnknownKeys(context, item, itemPath, ['label', 'value', 'disabled'])
    const label = readString(context, item, 'label', itemPath, { required: true, min: 1, max: 200 })
    const optionValue = item.value
    if (typeof optionValue !== 'string' && typeof optionValue !== 'number' && typeof optionValue !== 'boolean') {
      addError(context, 'SCHEMA_INVALID', 'Option value must be a string, number, or boolean.', `${itemPath}/value`)
      return
    }
    if (typeof optionValue === 'number' && !Number.isFinite(optionValue)) {
      addError(context, 'SCHEMA_INVALID', 'Option number value must be finite.', `${itemPath}/value`)
      return
    }
    const optionValueType = typeof optionValue as 'string' | 'number' | 'boolean'
    if (valueType !== undefined && valueType !== optionValueType) {
      addError(context, 'SCHEMA_SEMANTIC_INVALID', 'All option values must use the same primitive type.', `${itemPath}/value`)
    }
    valueType ??= optionValueType
    const identity = `${optionValueType}:${String(optionValue)}`
    if (identities.has(identity)) {
      addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Option values must be unique.', `${itemPath}/value`)
    }
    identities.add(identity)
    if (label !== undefined) {
      options.push({ label, value: optionValue, disabled: readBoolean(context, item, 'disabled', itemPath) ?? false })
    }
  })
  return options
}

function parseActionBinding(value: unknown, path: string, context: ParseContext): ActionBinding | undefined {
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'action must be an object.', path)
    return undefined
  }
  rejectUnknownKeys(context, value, path, ['actionId', 'confirm'])
  const actionId = readStableId(context, value, 'actionId', path)
  const confirm = parseConfirm(value.confirm, `${path}/confirm`, context)
  return actionId === undefined ? undefined : { actionId, ...(confirm === undefined ? {} : { confirm }) }
}

function parseConfirm(value: unknown, path: string, context: ParseContext): ActionBinding['confirm'] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'confirm must be an object.', path)
    return undefined
  }
  rejectUnknownKeys(context, value, path, ['title', 'message', 'confirmLabel', 'cancelLabel'])
  const title = readString(context, value, 'title', path, { required: true, min: 1, max: 120 })
  const message = readString(context, value, 'message', path, { required: true, min: 1, max: 500 })
  if (title === undefined || message === undefined) {
    return undefined
  }
  return {
    title,
    message,
    ...(withString(readString(context, value, 'confirmLabel', path, { min: 1, max: 40 }), 'confirmLabel')),
    ...(withString(readString(context, value, 'cancelLabel', path, { min: 1, max: 40 }), 'cancelLabel')),
  }
}

function parseValidators(value: unknown, path: string, context: ParseContext): readonly Validator[] {
  if (!Array.isArray(value)) {
    addError(context, 'SCHEMA_INVALID', 'validation must be an array.', path)
    return []
  }
  const validators: Validator[] = []
  value.forEach((item, index) => {
    const validator = parseValidator(item, `${path}/${index}`, context)
    if (validator !== undefined) {
      validators.push(validator)
    }
  })
  validateValidatorBounds(validators, path, context)
  return validators
}

function parseValidator(value: unknown, path: string, context: ParseContext): Validator | undefined {
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'Validator must be an object.', path)
    return undefined
  }
  const type = readString(context, value, 'type', path, { required: true })
  const message = readString(context, value, 'message', path, { min: 1, max: 300 })
  const code = readString(context, value, 'code', path, { pattern: customCodePattern })
  if (type === 'required' || type === 'integer') {
    rejectUnknownKeys(context, value, path, ['type', 'message', 'code'])
    return type === 'required'
      ? { type, ...(withString(message, 'message')), ...(withString(code, 'code')) }
      : { type, ...(withString(message, 'message')), ...(withString(code, 'code')) }
  }
  if (type === 'pattern') {
    rejectUnknownKeys(context, value, path, ['type', 'value', 'message', 'code'])
    const pattern = readString(context, value, 'value', path, { required: true, min: 1, max: 256 })
    if (pattern !== undefined && !isSafePattern(pattern)) {
      addError(context, 'SCHEMA_INVALID', 'Pattern validator uses unsupported or unsafe regular expression syntax.', `${path}/value`)
    } else if (pattern !== undefined) {
      try {
        new RegExp(pattern)
      } catch {
        addError(context, 'SCHEMA_INVALID', 'Pattern validator must contain a valid regular expression.', `${path}/value`)
      }
    }
    return pattern === undefined ? undefined : { type, value: pattern, ...(withString(message, 'message')), ...(withString(code, 'code')) }
  }
  if (
    type === 'minLength' ||
    type === 'maxLength' ||
    type === 'minItems' ||
    type === 'maxItems' ||
    type === 'minimum' ||
    type === 'maximum'
  ) {
    rejectUnknownKeys(context, value, path, ['type', 'value', 'message', 'code'])
    const numericValue = readNumber(context, value, 'value', path, {
      required: true,
      ...(type === 'minLength' || type === 'maxLength' || type === 'minItems' || type === 'maxItems'
        ? { integer: true, min: 0 }
        : {}),
    })
    return numericValue === undefined
      ? undefined
      : { type, value: numericValue, ...(withString(message, 'message')), ...(withString(code, 'code')) }
  }
  rejectUnknownKeys(context, value, path, ['type', 'value', 'message', 'code'])
  addError(context, 'SCHEMA_INVALID', 'Unknown validator type.', `${path}/type`)
  return undefined
}

function validateValidatorBounds(validators: readonly Validator[], path: string, context: ParseContext): void {
  const values = new Map<string, number>()
  for (const validator of validators) {
    if ('value' in validator && typeof validator.value === 'number') {
      values.set(validator.type, validator.value)
    }
  }
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
    ['minimum', 'maximum'],
  ]
  for (const [minimum, maximum] of pairs) {
    const min = values.get(minimum)
    const max = values.get(maximum)
    if (min !== undefined && max !== undefined && min > max) {
      addError(context, 'SCHEMA_SEMANTIC_INVALID', `${minimum} must not exceed ${maximum}.`, path)
    }
  }
}

function parseRules(value: unknown, path: string, context: ParseContext): readonly LinkRule[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    addError(context, 'SCHEMA_INVALID', 'rules must be an array.', path)
    return []
  }
  const ids = new Set<string>()
  const rules: LinkRule[] = []
  value.forEach((item, index) => {
    const rule = parseRule(item, `${path}/${index}`, context)
    if (rule === undefined) {
      return
    }
    if (ids.has(rule.id)) {
      addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Rule ids must be unique.', `${path}/${index}/id`)
    }
    ids.add(rule.id)
    rules.push(rule)
  })
  return rules
}

function parseRule(value: unknown, path: string, context: ParseContext): LinkRule | undefined {
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'Rule must be an object.', path)
    return undefined
  }
  rejectUnknownKeys(context, value, path, ['id', 'event', 'sourceDataPath', 'when', 'then', 'else'])
  const id = readStableId(context, value, 'id', path)
  const event = readString(context, value, 'event', path, { required: true })
  if (event !== undefined && event !== 'change') {
    addError(context, 'SCHEMA_INVALID', 'Only change rules are supported.', `${path}/event`)
  }
  const sourceDataPath = readDataPath(context, value, 'sourceDataPath', path)
  const when = parseCondition(value.when, `${path}/when`, context)
  const then = parseEffects(value.then, `${path}/then`, context, true)
  const otherwise = value.else === undefined ? undefined : parseEffects(value.else, `${path}/else`, context, false)
  if (id === undefined || event !== 'change' || sourceDataPath === undefined || when === undefined) {
    return undefined
  }
  return { id, event: 'change', sourceDataPath, when, then, ...(otherwise === undefined ? {} : { else: otherwise }) }
}

function parseCondition(value: unknown, path: string, context: ParseContext, depth = 0): Condition | undefined {
  if (depth > MAX_CONDITION_DEPTH) {
    addError(context, 'SCHEMA_INVALID', 'Condition exceeds the client safety depth limit.', path)
    return undefined
  }
  if (!isRecord(value)) {
    addError(context, 'SCHEMA_INVALID', 'Condition must be an object.', path)
    return undefined
  }
  const op = readString(context, value, 'op', path, { required: true })
  const comparisonOps = [
    'equals',
    'notEquals',
    'greaterThan',
    'greaterThanOrEqual',
    'lessThan',
    'lessThanOrEqual',
    'in',
    'notIn',
  ] as const
  if (comparisonOps.includes(op as (typeof comparisonOps)[number])) {
    rejectUnknownKeys(context, value, path, ['op', 'path', 'value'])
    const dataPath = readDataPath(context, value, 'path', path)
    if (!isJsonValue(value.value)) {
      addError(context, 'SCHEMA_INVALID', 'Condition value must be JSON data.', `${path}/value`)
    }
    return dataPath === undefined || !isJsonValue(value.value)
      ? undefined
      : { op: op as (typeof comparisonOps)[number], path: dataPath, value: cloneJsonValue(value.value) }
  }
  if (op === 'exists' || op === 'isEmpty') {
    rejectUnknownKeys(context, value, path, ['op', 'path'])
    const dataPath = readDataPath(context, value, 'path', path)
    return dataPath === undefined ? undefined : { op, path: dataPath }
  }
  if (op === 'and' || op === 'or') {
    rejectUnknownKeys(context, value, path, ['op', 'args'])
    if (!Array.isArray(value.args) || value.args.length === 0 || value.args.length > 20) {
      addError(context, 'SCHEMA_INVALID', 'Logical condition args must contain between 1 and 20 conditions.', `${path}/args`)
      return undefined
    }
    const args = value.args
      .map((item, index) => parseCondition(item, `${path}/args/${index}`, context, depth + 1))
      .filter((item): item is Condition => item !== undefined)
    return args.length === value.args.length ? { op, args } : undefined
  }
  if (op === 'not') {
    rejectUnknownKeys(context, value, path, ['op', 'arg'])
    const arg = parseCondition(value.arg, `${path}/arg`, context, depth + 1)
    return arg === undefined ? undefined : { op, arg }
  }
  rejectUnknownKeys(context, value, path, ['op', 'path', 'value', 'args', 'arg'])
  addError(context, 'SCHEMA_INVALID', 'Unknown condition operator.', `${path}/op`)
  return undefined
}

function parseEffects(value: unknown, path: string, context: ParseContext, required: boolean): readonly RuleEffect[] {
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > 20) {
    addError(context, 'SCHEMA_INVALID', 'Rule effects must contain between 1 and 20 entries.', path)
    return []
  }
  const effects: RuleEffect[] = []
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      addError(context, 'SCHEMA_INVALID', 'Rule effect must be an object.', `${path}/${index}`)
      return
    }
    const effectPath = `${path}/${index}`
    const type = readString(context, item, 'type', effectPath, { required: true })
    if (type === 'setVisible' || type === 'setDisabled') {
      rejectUnknownKeys(context, item, effectPath, ['type', 'targetComponentId', 'value'])
      const targetComponentId = readStableId(context, item, 'targetComponentId', effectPath)
      const effectValue = readBoolean(context, item, 'value', effectPath)
      if (targetComponentId !== undefined && effectValue !== undefined) {
        effects.push({ type, targetComponentId, value: effectValue })
      }
      return
    }
    if (type === 'setValue') {
      rejectUnknownKeys(context, item, effectPath, ['type', 'targetDataPath', 'value'])
      const targetDataPath = readDataPath(context, item, 'targetDataPath', effectPath)
      if (!isJsonValue(item.value)) {
        addError(context, 'SCHEMA_INVALID', 'setValue value must be JSON data.', `${effectPath}/value`)
      }
      if (targetDataPath !== undefined && isJsonValue(item.value)) {
        effects.push({ type, targetDataPath, value: cloneJsonValue(item.value) })
      }
      return
    }
    rejectUnknownKeys(context, item, effectPath, ['type', 'targetComponentId', 'targetDataPath', 'value'])
    addError(context, 'SCHEMA_INVALID', 'Unknown rule effect type.', `${effectPath}/type`)
  })
  return effects
}

function validateDocumentSemantics(
  context: ParseContext,
  root: ComponentNode,
  initialValues: Readonly<Record<string, JsonValue>>,
  actions: readonly ActionDefinition[],
  dataSources: readonly RemoteOptionsSource[],
  rules: readonly LinkRule[],
): void {
  const actionById = new Map(actions.map((action) => [action.id, action]))
  const dataSourceIds = new Set(dataSources.map((source) => source.id))
  const nodeIds = new Set(context.nodes.map((node) => node.id))
  const boundNodesByDataPath = new Map<DataPath, ComponentNode[]>()
  for (const node of context.nodes) {
    if (node.dataPath !== undefined) {
      const boundNodes = boundNodesByDataPath.get(node.dataPath) ?? []
      boundNodes.push(node)
      boundNodesByDataPath.set(node.dataPath, boundNodes)
      const dataValue = getDataPathValue(initialValues, node.dataPath)
      if (!dataValue.found) {
        addError(
          context,
          'DATA_BINDING_INVALID',
          'dataPath must resolve to an existing initialValues location.',
          `${context.nodePaths.get(node.id) ?? '/root'}/dataPath`,
          node.id,
        )
      } else if (!isCompatibleBoundValue(node, dataValue.value)) {
        addError(
          context,
          'DATA_BINDING_INVALID',
          'The initial value is incompatible with this component type.',
          `${context.nodePaths.get(node.id) ?? '/root'}/dataPath`,
          node.id,
        )
      }
    }
    if (node.type === 'Select' && 'dataSourceId' in node.props && node.props.dataSourceId !== undefined && !dataSourceIds.has(node.props.dataSourceId)) {
      addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Select dataSourceId must reference a declared data source.', `${context.nodePaths.get(node.id) ?? '/root'}/props/dataSourceId`, node.id)
    }
    if (node.action !== undefined) {
      const action = actionById.get(node.action.actionId)
      const actionPath = `${context.nodePaths.get(node.id) ?? '/root'}/action/actionId`
      if (action === undefined) {
        addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Action binding must reference a declared action.', actionPath, node.id)
      } else if (node.type === 'Upload' && action.type !== 'upload') {
        addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Upload components may only reference upload actions.', actionPath, node.id)
      } else if (node.type === 'Button' && action.type !== 'submit' && action.type !== 'reset') {
        addError(context, 'SCHEMA_SEMANTIC_INVALID', 'Button components may only reference submit or reset actions.', actionPath, node.id)
      }
    }
  }
  if (root.type !== 'Form') {
    return
  }
  for (const rule of rules) {
    const rulePath = `/rules/${rule.id}`
    assertExistingDataPath(context, initialValues, rule.sourceDataPath, `${rulePath}/sourceDataPath`)
    validateConditionPaths(context, initialValues, rule.when, `${rulePath}/when`)
    for (const branch of [
      { name: 'then', effects: rule.then },
      { name: 'else', effects: rule.else ?? [] },
    ] as const) {
      for (const [effectIndex, effect] of branch.effects.entries()) {
        const effectPath = `${rulePath}/${branch.name}/${effectIndex}`
        if ('targetComponentId' in effect && !nodeIds.has(effect.targetComponentId)) {
          addError(context, 'RULE_INVALID', 'Rule target component must exist.', `${effectPath}/targetComponentId`)
        }
        if ('targetDataPath' in effect) {
          assertExistingDataPath(context, initialValues, effect.targetDataPath, `${effectPath}/targetDataPath`)
          for (const node of boundNodesByDataPath.get(effect.targetDataPath) ?? []) {
            if (!isCompatibleBoundValue(node, effect.value)) {
              addError(
                context,
                'DATA_BINDING_INVALID',
                'A rule setValue value is incompatible with the bound component type.',
                `${effectPath}/value`,
                node.id,
              )
            }
          }
        }
      }
    }
  }
  validateRuleValueCycles(context, rules)
}

function assertExistingDataPath(
  context: ParseContext,
  initialValues: Readonly<Record<string, JsonValue>>,
  dataPath: DataPath,
  path: string,
): void {
  if (!hasDataPath(initialValues, dataPath)) {
    addError(context, 'RULE_INVALID', 'Rule data path must resolve to an existing initialValues location.', path)
  }
}

function validateConditionPaths(
  context: ParseContext,
  initialValues: Readonly<Record<string, JsonValue>>,
  condition: Condition,
  path: string,
): void {
  if ('path' in condition) {
    assertExistingDataPath(context, initialValues, condition.path, `${path}/path`)
  }
  if ('args' in condition) {
    condition.args.forEach((item, index) => validateConditionPaths(context, initialValues, item, `${path}/args/${index}`))
  }
  if ('arg' in condition) {
    validateConditionPaths(context, initialValues, condition.arg, `${path}/arg`)
  }
}

function validateRuleValueCycles(context: ParseContext, rules: readonly LinkRule[]): void {
  const graph = new Map<DataPath, Set<DataPath>>()
  for (const rule of rules) {
    for (const effect of [...rule.then, ...(rule.else ?? [])]) {
      if ('targetDataPath' in effect) {
        const edges = graph.get(rule.sourceDataPath) ?? new Set<DataPath>()
        edges.add(effect.targetDataPath)
        graph.set(rule.sourceDataPath, edges)
      }
    }
  }
  const visiting = new Set<DataPath>()
  const visited = new Set<DataPath>()
  const visit = (path: DataPath): boolean => {
    if (visiting.has(path)) {
      return true
    }
    if (visited.has(path)) {
      return false
    }
    visiting.add(path)
    for (const target of graph.get(path) ?? []) {
      if (visit(target)) {
        return true
      }
    }
    visiting.delete(path)
    visited.add(path)
    return false
  }
  for (const sourcePath of graph.keys()) {
    if (visit(sourcePath)) {
      addError(context, 'RULE_INVALID', 'setValue rules must not create a cyclic data dependency.', '/rules')
      return
    }
  }
}

function hasDataPath(initialValues: Readonly<Record<string, JsonValue>>, dataPath: DataPath): boolean {
  return getDataPathValue(initialValues, dataPath).found
}

function readEnum<T extends string>(
  context: ParseContext,
  record: UnknownRecord,
  key: string,
  path: string,
  allowed: readonly T[],
): T | undefined {
  const value = readString(context, record, key, path)
  if (value === undefined) {
    return undefined
  }
  if (!(allowed as readonly string[]).includes(value)) {
    addError(context, 'SCHEMA_INVALID', `Field must be one of: ${allowed.join(', ')}.`, pointer(path, key))
    return undefined
  }
  return value as T
}

function readDate(context: ParseContext, record: UnknownRecord, key: string, path: string): string | undefined {
  const date = readString(context, record, key, path, { pattern: datePattern })
  if (date !== undefined && !isValidCalendarDate(date)) {
    addError(context, 'SCHEMA_INVALID', 'Field must be a valid calendar date.', pointer(path, key))
  }
  return date
}

function isValidCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * V1 patterns use a deliberately small, linear-time subset of ECMAScript
 * regular expressions: concatenated literals, escapes, character classes,
 * anchors, and a single quantifier per atom. Groups, alternation, references,
 * and nested quantifiers are rejected before a browser RegExp is constructed.
 */
function isSafePattern(pattern: string): boolean {
  let index = 0
  let canQuantify = false
  while (index < pattern.length) {
    const character = pattern[index]
    if (character === undefined) {
      return false
    }
    if (character === '(' || character === ')' || character === '|') {
      return false
    }
    if (character === '^' || character === '$') {
      canQuantify = false
      index += 1
      continue
    }
    if (character === '\\') {
      const escaped = pattern[index + 1]
      if (escaped === undefined || /[1-9]/.test(escaped)) {
        return false
      }
      canQuantify = true
      index += 2
      continue
    }
    if (character === '[') {
      let classIndex = index + 1
      let escaped = false
      let closed = false
      while (classIndex < pattern.length) {
        const classCharacter = pattern[classIndex]
        if (classCharacter === undefined) {
          return false
        }
        if (!escaped && classCharacter === ']') {
          closed = true
          break
        }
        escaped = !escaped && classCharacter === '\\'
        if (classCharacter !== '\\') {
          escaped = false
        }
        classIndex += 1
      }
      if (!closed) {
        return false
      }
      canQuantify = true
      index = classIndex + 1
      continue
    }
    if (character === '*' || character === '+' || character === '?') {
      if (!canQuantify) {
        return false
      }
      canQuantify = false
      index += 1
      continue
    }
    if (character === '{') {
      if (!canQuantify) {
        return false
      }
      const quantifier = /^\{(\d+)(?:,(\d+))?\}/.exec(pattern.slice(index))
      if (quantifier === null) {
        return false
      }
      const minimum = Number(quantifier[1])
      const maximum = quantifier[2] === undefined ? minimum : Number(quantifier[2])
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum || maximum > 10000) {
        return false
      }
      canQuantify = false
      index += quantifier[0].length
      continue
    }
    if (character === ']' || character === '}') {
      return false
    }
    canQuantify = true
    index += 1
  }
  return true
}

function parseStringArray(
  value: unknown,
  path: string,
  context: ParseContext,
  limits: { readonly min: number; readonly max: number },
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    addError(context, 'SCHEMA_INVALID', 'Field must be an array of strings.', path)
    return undefined
  }
  const strings: string[] = []
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length < limits.min || item.length > limits.max) {
      addError(context, 'SCHEMA_INVALID', 'Array entries must be strings within the allowed length.', `${path}/${index}`)
      return
    }
    strings.push(item)
  })
  return strings
}

function pointer(path: string, key: string): string {
  const encoded = key.replaceAll('~', '~0').replaceAll('/', '~1')
  return path === '/' ? `/${encoded}` : `${path}/${encoded}`
}

function withString<T extends string>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : { [key]: value }
}

function withNumber(value: number | undefined, key: string): Record<string, number> {
  return value === undefined ? {} : { [key]: value }
}

function withStringArray(value: readonly string[] | undefined, key: string): Record<string, readonly string[]> {
  return value === undefined ? {} : { [key]: value }
}

function withEnum<T extends string>(value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { inputMode: value }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}
