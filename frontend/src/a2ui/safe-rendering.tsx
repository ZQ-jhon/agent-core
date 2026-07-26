import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { SchemaDiagnostic } from './errors.ts'

export interface SchemaErrorPanelProps {
  readonly errors: readonly SchemaDiagnostic[]
  readonly title?: string
}

/** Fatal protocol fallback. It deliberately exposes codes and paths, never raw schema or stack details. */
export function SchemaErrorPanel({ errors, title = 'This form configuration cannot be displayed.' }: SchemaErrorPanelProps) {
  return (
    <section aria-live="assertive" aria-labelledby="a2ui-schema-error-title" role="alert">
      <h2 id="a2ui-schema-error-title">{title}</h2>
      <ul>
        {errors.map((error, index) => (
          <li key={`${error.code}:${error.path}:${index}`}>
            <code>{error.code}</code> at <code>{error.path}</code>
            {error.componentId === undefined ? null : <> (component: {error.componentId})</>}
            <span> — {error.message}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export interface UnsupportedComponentPlaceholderProps {
  readonly componentId?: string
  readonly componentType: string
}

/** Defense-in-depth fallback for a malformed node that reaches a renderer after parsing. */
export function UnsupportedComponentPlaceholder({
  componentId,
  componentType,
}: UnsupportedComponentPlaceholderProps) {
  return (
    <div aria-live="polite" data-a2ui-component-id={componentId} role="status">
      <strong>Unsupported form component</strong>
      <span> ({componentType})</span>
      {componentId === undefined ? null : <span> — {componentId}</span>}
    </div>
  )
}

export interface ComponentRenderBoundaryProps {
  readonly children: ReactNode
  readonly componentId: string
  readonly componentType: string
  readonly revision: number
  readonly onDiagnostic?: (diagnostic: SchemaDiagnostic) => void
}

interface ComponentRenderBoundaryState {
  readonly failed: boolean
}

/** Isolates a known component failure so sibling form content remains available. */
export class ComponentRenderBoundary extends Component<
  ComponentRenderBoundaryProps,
  ComponentRenderBoundaryState
> {
  public state: ComponentRenderBoundaryState = { failed: false }

  public static getDerivedStateFromError(): ComponentRenderBoundaryState {
    return { failed: true }
  }

  public componentDidCatch(_error: Error, _errorInfo: ErrorInfo): void {
    this.props.onDiagnostic?.({
      code: 'COMPONENT_RENDER_FAILED',
      message: 'A form component could not be rendered.',
      path: `/components/${this.props.componentId}`,
      componentId: this.props.componentId,
    })
  }

  public componentDidUpdate(previousProps: ComponentRenderBoundaryProps): void {
    if (this.state.failed && previousProps.revision !== this.props.revision) {
      this.setState({ failed: false })
    }
  }

  public render(): ReactNode {
    if (this.state.failed) {
      return (
        <div aria-live="polite" data-a2ui-component-id={this.props.componentId} role="status">
          This form element is temporarily unavailable. ({this.props.componentId})
        </div>
      )
    }
    return this.props.children
  }
}
