import type { ComponentNode, JsonValue, Option } from './types.ts'

/**
 * The completed file reference that is allowed to enter an Upload field.
 * Local File objects, temporary URLs, and failed upload records never belong
 * in form data.
 */
export type UploadValue = Readonly<Record<string, JsonValue>> & {
  readonly fileId: string
  readonly name: string
  readonly size: number
  readonly mimeType: string
  readonly status: 'uploaded'
}

/**
 * Checks the frozen Schema v1 value contract for a value bound to a component.
 * Parser and runtime both use this guard so a forged normalized document cannot
 * bypass the schema boundary.
 */
export function isCompatibleBoundValue(node: ComponentNode, value: JsonValue): boolean {
  switch (node.type) {
    case 'TextInput':
    case 'TextArea':
      return value === null || typeof value === 'string'
    case 'NumberInput':
      return value === null || (typeof value === 'number' && Number.isFinite(value))
    case 'Select':
    case 'RadioGroup':
      if (value === null) {
        return true
      }
      if (!isOptionValue(value)) {
        return false
      }
      const options = node.props.options
      return options === undefined || options.some((option) => Object.is(option.value, value))
    case 'CheckboxGroup':
      if (!Array.isArray(value) || !value.every(isOptionValue)) {
        return false
      }
      return new Set(value.map((item) => `${typeof item}:${String(item)}`)).size === value.length
        && value.every((item) => node.props.options.some((option) => Object.is(option.value, item)))
    case 'DatePicker':
      return value === null || (typeof value === 'string' && isValidCalendarDate(value))
    case 'Switch':
      return typeof value === 'boolean'
    case 'Upload':
      return Array.isArray(value) && value.every(isUploadValue)
    default:
      return true
  }
}

function isOptionValue(value: JsonValue): value is Option['value'] {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

function isUploadValue(value: JsonValue): value is UploadValue {
  if (!isRecord(value)) {
    return false
  }
  const keys = Object.keys(value)
  if (keys.length !== 5 || !['fileId', 'name', 'size', 'mimeType', 'status'].every((key) => keys.includes(key))) {
    return false
  }
  return typeof value.fileId === 'string'
    && typeof value.name === 'string'
    && typeof value.size === 'number'
    && Number.isFinite(value.size)
    && typeof value.mimeType === 'string'
    && value.status === 'uploaded'
}

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidCalendarDate(value: string): boolean {
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
