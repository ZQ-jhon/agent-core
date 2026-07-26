import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComponentRenderBoundary, SchemaErrorPanel, UnsupportedComponentPlaceholder } from './safe-rendering.tsx'

function ThrowingComponent(): never {
  throw new Error('internal implementation detail must not be shown')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('A2UI safe rendering fallbacks', () => {
  it('contains a component render failure and preserves sibling content', () => {
    const onDiagnostic = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(
      <>
        <ComponentRenderBoundary
          componentId="failing-component"
          componentType="TextInput"
          onDiagnostic={onDiagnostic}
          revision={1}
        >
          <ThrowingComponent />
        </ComponentRenderBoundary>
        <p>Other form content remains available</p>
      </>,
    )

    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument()
    expect(screen.getByText('Other form content remains available')).toBeInTheDocument()
    expect(screen.queryByText(/internal implementation detail/)).not.toBeInTheDocument()
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'COMPONENT_RENDER_FAILED', componentId: 'failing-component' }),
    )
  })

  it('shows a local unknown-component placeholder without rendering descendants', () => {
    render(<UnsupportedComponentPlaceholder componentId="unknown-node" componentType="UnknownWidget" />)

    expect(screen.getByRole('status')).toHaveTextContent('Unsupported form component (UnknownWidget) — unknown-node')
  })

  it('renders fatal protocol errors with stable codes and locatable paths', () => {
    render(
      <SchemaErrorPanel
        errors={[
          {
            code: 'SCHEMA_VERSION_UNSUPPORTED',
            message: 'Do not render.',
            path: '/schemaVersion',
          },
        ]}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('SCHEMA_VERSION_UNSUPPORTED')
    expect(screen.getByRole('alert')).toHaveTextContent('/schemaVersion')
  })
})
