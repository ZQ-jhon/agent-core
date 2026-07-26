import type { ComponentType } from './types.ts'

export interface ComponentRegistration {
  readonly type: ComponentType
  readonly category: 'container' | 'input' | 'action' | 'display'
  readonly acceptsChildren: boolean
  readonly requiresDataPath: boolean
  readonly requiredActionType?: 'submit' | 'reset' | 'upload'
}

/**
 * The complete v1 component allowlist. It is deliberately static: schema data
 * can select only a registration already compiled into this client, never an
 * import path, URL, script, or dynamically registered implementation.
 */
export const componentRegistry: Readonly<Record<ComponentType, ComponentRegistration>> =
  Object.freeze({
    Form: { type: 'Form', category: 'container', acceptsChildren: true, requiresDataPath: false },
    Section: { type: 'Section', category: 'container', acceptsChildren: true, requiresDataPath: false },
    TextInput: { type: 'TextInput', category: 'input', acceptsChildren: false, requiresDataPath: true },
    TextArea: { type: 'TextArea', category: 'input', acceptsChildren: false, requiresDataPath: true },
    NumberInput: { type: 'NumberInput', category: 'input', acceptsChildren: false, requiresDataPath: true },
    Select: { type: 'Select', category: 'input', acceptsChildren: false, requiresDataPath: true },
    RadioGroup: { type: 'RadioGroup', category: 'input', acceptsChildren: false, requiresDataPath: true },
    CheckboxGroup: { type: 'CheckboxGroup', category: 'input', acceptsChildren: false, requiresDataPath: true },
    DatePicker: { type: 'DatePicker', category: 'input', acceptsChildren: false, requiresDataPath: true },
    Switch: { type: 'Switch', category: 'input', acceptsChildren: false, requiresDataPath: true },
    Upload: {
      type: 'Upload',
      category: 'input',
      acceptsChildren: false,
      requiresDataPath: true,
      requiredActionType: 'upload',
    },
    Button: {
      type: 'Button',
      category: 'action',
      acceptsChildren: false,
      requiresDataPath: false,
    },
    Alert: { type: 'Alert', category: 'display', acceptsChildren: false, requiresDataPath: false },
    Markdown: { type: 'Markdown', category: 'display', acceptsChildren: false, requiresDataPath: false },
  })

export const supportedComponentTypes = Object.freeze(
  Object.keys(componentRegistry) as ComponentType[],
)

export function isRegisteredComponentType(value: unknown): value is ComponentType {
  return typeof value === 'string' && Object.hasOwn(componentRegistry, value)
}

export function getComponentRegistration(value: unknown): ComponentRegistration | undefined {
  return isRegisteredComponentType(value) ? componentRegistry[value] : undefined
}
