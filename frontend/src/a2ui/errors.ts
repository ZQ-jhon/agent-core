export const schemaErrorCodes = [
  'SCHEMA_INVALID',
  'SCHEMA_VERSION_UNSUPPORTED',
  'SCHEMA_SEMANTIC_INVALID',
  'COMPONENT_UNSUPPORTED',
  'DATA_BINDING_INVALID',
  'RULE_INVALID',
  'COMPONENT_RENDER_FAILED',
] as const

export type SchemaErrorCode = (typeof schemaErrorCodes)[number]

/** Stable, consumer-facing diagnostics. Never include raw schema values. */
export interface SchemaDiagnostic {
  readonly code: SchemaErrorCode
  readonly message: string
  readonly path: string
  readonly componentId?: string
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T; readonly errors: readonly [] }
  | { readonly ok: false; readonly errors: readonly SchemaDiagnostic[] }
