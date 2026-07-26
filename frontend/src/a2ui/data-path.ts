import type { DataPath, JsonValue } from './types.ts'

const arrayIndexPattern = /^(0|[1-9]\d*)$/

export type DataPathReadResult =
  | { readonly found: true; readonly value: JsonValue }
  | { readonly found: false }

export type DataPathWriteResult<T extends JsonValue> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false }

/**
 * Decode the limited RFC 6901 pointer subset accepted by the v1 parser.
 * Invalid runtime input is reported as `undefined` rather than throwing.
 */
export function decodeDataPath(dataPath: DataPath): readonly string[] | undefined {
  if (typeof dataPath !== 'string' || !dataPath.startsWith('/') || dataPath.length < 2) {
    return undefined
  }

  const segments: string[] = []
  for (const rawSegment of dataPath.slice(1).split('/')) {
    if (rawSegment.length === 0) {
      return undefined
    }

    let decoded = ''
    for (let index = 0; index < rawSegment.length; index += 1) {
      const character = rawSegment[index]
      if (character !== '~') {
        decoded += character
        continue
      }

      const escape = rawSegment[index + 1]
      if (escape === '0') {
        decoded += '~'
      } else if (escape === '1') {
        decoded += '/'
      } else {
        return undefined
      }
      index += 1
    }
    segments.push(decoded)
  }

  return segments
}

/**
 * Returns whether two accepted RFC 6901 pointers address the same value or
 * overlapping ancestor/descendant values. Segments are compared after decoding
 * so escaped slashes and tildes cannot change the pointer hierarchy.
 */
export function dataPathsOverlap(left: DataPath, right: DataPath): boolean {
  const leftSegments = decodeDataPath(left)
  const rightSegments = decodeDataPath(right)
  if (leftSegments === undefined || rightSegments === undefined) {
    return false
  }

  const sharedLength = Math.min(leftSegments.length, rightSegments.length)
  return leftSegments.slice(0, sharedLength).every((segment, index) => segment === rightSegments[index])
}

export function getDataPathValue(root: JsonValue, dataPath: DataPath): DataPathReadResult {
  const segments = decodeDataPath(dataPath)
  if (segments === undefined) {
    return { found: false }
  }

  let current: JsonValue = root
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!arrayIndexPattern.test(segment)) {
        return { found: false }
      }
      const index = Number(segment)
      if (index >= current.length) {
        return { found: false }
      }
      current = current[index]!
      continue
    }

    if (!isJsonRecord(current) || !Object.hasOwn(current, segment)) {
      return { found: false }
    }
    current = current[segment]!
  }

  return { found: true, value: current }
}

/**
 * Return a cloned JSON tree with one existing pointer value replaced. Paths
 * never create new objects or array slots, which keeps runtime writes inside
 * the Schema v1 binding whitelist.
 */
export function setDataPathValue<T extends JsonValue>(
  root: T,
  dataPath: DataPath,
  nextValue: JsonValue,
): DataPathWriteResult<T> {
  const segments = decodeDataPath(dataPath)
  if (segments === undefined) {
    return { ok: false }
  }

  const updated = setAt(root, segments, 0, nextValue)
  return updated.ok ? { ok: true, value: updated.value as T } : updated
}

/**
 * Build a submission projection without a bound path. It is intentionally
 * non-mutating so hiding a field never changes the user's in-memory value.
 */
export function removeDataPathValue<T extends JsonValue>(root: T, dataPath: DataPath): DataPathWriteResult<T> {
  const segments = decodeDataPath(dataPath)
  if (segments === undefined) {
    return { ok: false }
  }

  const updated = removeAt(root, segments, 0)
  return updated.ok ? { ok: true, value: updated.value as T } : updated
}

export function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue)
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]))
}

export function equalJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equalJsonValue(item, right[index]!))
  }
  if (isJsonRecord(left) || isJsonRecord(right)) {
    if (!isJsonRecord(left) || !isJsonRecord(right)) {
      return false
    }
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && equalJsonValue(left[key]!, right[key]!))
  }
  return false
}

function setAt(
  current: JsonValue,
  segments: readonly string[],
  index: number,
  nextValue: JsonValue,
): DataPathWriteResult<JsonValue> {
  if (index === segments.length) {
    return { ok: true, value: cloneJsonValue(nextValue) }
  }

  const segment = segments[index]!
  if (Array.isArray(current)) {
    if (!arrayIndexPattern.test(segment)) {
      return { ok: false }
    }
    const childIndex = Number(segment)
    if (childIndex >= current.length) {
      return { ok: false }
    }
    const child = setAt(current[childIndex]!, segments, index + 1, nextValue)
    if (!child.ok) {
      return child
    }
    const copy = [...current]
    copy[childIndex] = child.value
    return { ok: true, value: copy }
  }

  if (!isJsonRecord(current) || !Object.hasOwn(current, segment)) {
    return { ok: false }
  }
  const child = setAt(current[segment]!, segments, index + 1, nextValue)
  if (!child.ok) {
    return child
  }
  return { ok: true, value: { ...current, [segment]: child.value } }
}

function removeAt(current: JsonValue, segments: readonly string[], index: number): DataPathWriteResult<JsonValue> {
  const segment = segments[index]
  if (segment === undefined) {
    return { ok: false }
  }

  const isLeaf = index === segments.length - 1
  if (Array.isArray(current)) {
    if (!arrayIndexPattern.test(segment)) {
      return { ok: false }
    }
    const childIndex = Number(segment)
    if (childIndex >= current.length) {
      return { ok: false }
    }
    const copy = [...current]
    if (isLeaf) {
      copy.splice(childIndex, 1)
      return { ok: true, value: copy }
    }
    const child = removeAt(current[childIndex]!, segments, index + 1)
    if (!child.ok) {
      return child
    }
    copy[childIndex] = child.value
    return { ok: true, value: copy }
  }

  if (!isJsonRecord(current) || !Object.hasOwn(current, segment)) {
    return { ok: false }
  }
  if (isLeaf) {
    const copy = { ...current }
    delete copy[segment]
    return { ok: true, value: copy }
  }
  const child = removeAt(current[segment]!, segments, index + 1)
  if (!child.ok) {
    return child
  }
  return { ok: true, value: { ...current, [segment]: child.value } }
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
