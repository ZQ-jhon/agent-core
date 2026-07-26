import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createA2UIFormController } from './form-state.ts'
import { A2UIFormRenderer } from './form-renderer.tsx'
import { parseA2UIFormDocument } from './parser.ts'
import type { NormalizedA2UIFormDocumentV1 } from './types.ts'

afterEach(cleanup)

function parseDocument(input: unknown): NormalizedA2UIFormDocumentV1 {
  const result = parseA2UIFormDocument(input)
  if (!result.ok) {
    throw new Error(JSON.stringify(result.errors))
  }
  return result.value
}

function documentWith(
  initialValues: Record<string, unknown>,
  children: readonly unknown[],
  actions: readonly unknown[] = [],
  formProps: Record<string, unknown> = {},
  dataSources: readonly unknown[] = [],
): NormalizedA2UIFormDocumentV1 {
  return parseDocument({
    schemaVersion: '1.0.0',
    requestId: 'request-1',
    formId: 'form-1',
    revision: 1,
    root: { id: 'form-root', type: 'Form', props: formProps, children },
    data: { initialValues },
    actions,
    dataSources,
  })
}

describe('A2UI form renderer', () => {
  it('connects labels, help, required errors, disabled state, and hidden state to the Stage 3 controller', () => {
    const document = documentWith(
      { name: '', disabledName: 'Fixed', hiddenName: 'Hidden' },
      [
        {
          id: 'name',
          type: 'TextInput',
          props: { label: 'Name', helpText: 'Use your legal name' },
          children: [],
          dataPath: '/name',
          validation: [{ type: 'required' }],
        },
        {
          id: 'disabled-name',
          type: 'TextInput',
          props: { label: 'Disabled name', disabled: true },
          children: [],
          dataPath: '/disabledName',
        },
        {
          id: 'hidden-name',
          type: 'TextInput',
          props: { label: 'Hidden name', visible: false },
          children: [],
          dataPath: '/hiddenName',
        },
      ],
    )
    const controller = createA2UIFormController(document)

    render(<A2UIFormRenderer controller={controller} document={document} />)

    const name = screen.getByRole('textbox', { name: /Name/ })
    expect(name).toHaveAttribute('aria-required', 'true')
    expect(name).toHaveAttribute('aria-describedby', expect.stringContaining('a2ui-name-help'))
    expect(screen.getByText('Use your legal name')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Disabled name' })).toBeDisabled()
    expect(screen.queryByRole('textbox', { name: 'Hidden name' })).not.toBeInTheDocument()

    fireEvent.change(name, { target: { value: 'Ada Lovelace' } })
    expect(controller.getValue('/name')).toBe('Ada Lovelace')

    fireEvent.change(name, { target: { value: '' } })
    fireEvent.blur(name)
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAttribute('aria-errormessage', 'a2ui-name-error')
    expect(screen.getByRole('alert')).toHaveTextContent('required')
  })

  it('writes native choice controls back through the controller using their schema value types', () => {
    const document = documentWith(
      { plan: null, size: 'small', tags: [], date: null, enabled: false },
      [
        {
          id: 'plan',
          type: 'Select',
          props: {
            label: 'Plan',
            options: [
              { label: 'Free', value: false },
              { label: 'Pro', value: true },
            ],
          },
          children: [],
          dataPath: '/plan',
        },
        {
          id: 'size',
          type: 'RadioGroup',
          props: { label: 'Size', options: [{ label: 'Small', value: 'small' }, { label: 'Large', value: 'large' }] },
          children: [],
          dataPath: '/size',
        },
        {
          id: 'tags',
          type: 'CheckboxGroup',
          props: { label: 'Tags', options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }] },
          children: [],
          dataPath: '/tags',
        },
        {
          id: 'date',
          type: 'DatePicker',
          props: { label: 'Start date' },
          children: [],
          dataPath: '/date',
        },
        {
          id: 'enabled',
          type: 'Switch',
          props: { label: 'Enabled', onLabel: 'Enabled', offLabel: 'Disabled' },
          children: [],
          dataPath: '/enabled',
        },
      ],
    )
    const controller = createA2UIFormController(document)

    render(<A2UIFormRenderer controller={controller} document={document} />)

    fireEvent.change(screen.getByRole('combobox', { name: 'Plan' }), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'One' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Two' }))
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))

    expect(controller.getValue('/plan')).toBe(true)
    expect(controller.getValue('/size')).toBe('large')
    expect(controller.getValue('/tags')).toEqual([1, 2])
    expect(controller.getValue('/date')).toBe('2026-08-01')
    expect(controller.getValue('/enabled')).toBe(true)
  })

  it('renders an explicit, non-silent fallback for a remote option source until a trusted host supplies options', () => {
    const document = documentWith(
      { city: null },
      [{ id: 'city', type: 'Select', props: { label: 'City', dataSourceId: 'cities' }, children: [], dataPath: '/city' }],
      [],
      {},
      [{ id: 'cities', type: 'remoteOptions', endpointKey: 'cities.lookup' }],
    )
    const controller = createA2UIFormController(document)
    const view = render(<A2UIFormRenderer controller={controller} document={document} />)

    expect(screen.getByRole('combobox', { name: 'City' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('host supplies this data source')

    view.rerender(
      <A2UIFormRenderer
        controller={controller}
        document={document}
        remoteOptions={{ cities: [{ label: 'Shanghai', value: 1 }] }}
      />,
    )
    const city = screen.getByRole('combobox', { name: 'City' })
    expect(city).not.toBeDisabled()
    fireEvent.change(city, { target: { value: '0' } })
    expect(controller.getValue('/city')).toBe(1)
  })

  it('focuses a linked error summary on submit validation failure and provides an accessible confirmation dialog', async () => {
    const submit = vi.fn(async () => ({ status: 'success' as const, result: { submissionId: 'submission-1' } }))
    const document = documentWith(
      { name: 'Ada' },
      [
        {
          id: 'name',
          type: 'TextInput',
          props: { label: 'Name' },
          children: [],
          dataPath: '/name',
          validation: [{ type: 'required' }],
        },
        {
          id: 'submit',
          type: 'Button',
          props: { label: 'Submit' },
          children: [],
          action: { actionId: 'submit' },
        },
        {
          id: 'reset',
          type: 'Button',
          props: { label: 'Reset with confirmation' },
          children: [],
          action: {
            actionId: 'reset',
            confirm: { title: 'Reset form?', message: 'Your edits will be removed.' },
          },
        },
      ],
      [{ id: 'submit', type: 'submit', endpointKey: 'forms.submit', method: 'POST' }, { id: 'reset', type: 'reset' }],
      { title: 'Profile', submitOnEnter: true },
    )
    const controller = createA2UIFormController(document, { submit })
    render(<A2UIFormRenderer controller={controller} document={document} />)

    const name = screen.getByRole('textbox', { name: /Name/ })
    fireEvent.change(name, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    const summary = await screen.findByRole('alert', { name: 'Please review the highlighted fields' })
    await waitFor(() => expect(summary).toHaveFocus())
    expect(screen.getByRole('link', { name: /required/i })).toHaveAttribute('href', '#a2ui-name-control')
    expect(submit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Reset with confirmation' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reset form?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(controller.getValue('/name')).toBe('Ada')

    fireEvent.keyDown(screen.getByRole('textbox', { name: /Name/ }), { key: 'Enter' })
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  it('safely renders the remaining registered display, upload, and section components without adding transport behavior', () => {
    const document = documentWith(
      { notes: '', amount: null, files: [] },
      [
        {
          id: 'details',
          type: 'Section',
          props: { title: 'Details', collapsible: true, defaultCollapsed: true },
          children: [
            { id: 'notes', type: 'TextArea', props: { label: 'Notes', rows: 3 }, children: [], dataPath: '/notes' },
            { id: 'amount', type: 'NumberInput', props: { label: 'Amount', unit: 'USD' }, children: [], dataPath: '/amount' },
          ],
        },
        {
          id: 'files',
          type: 'Upload',
          props: { label: 'Files', accept: ['image/*'], maxFiles: 2 },
          children: [],
          dataPath: '/files',
          action: { actionId: 'upload' },
        },
        { id: 'notice', type: 'Alert', props: { title: 'Notice', message: 'Saved safely', variant: 'success', dismissible: true }, children: [] },
        { id: 'instructions', type: 'Markdown', props: { content: '<strong>Plain text only</strong>' }, children: [] },
      ],
      [{ id: 'upload', type: 'upload', endpointKey: 'files.upload', method: 'POST' }],
    )
    const controller = createA2UIFormController(document)
    render(<A2UIFormRenderer controller={controller} document={document} />)

    expect(screen.queryByRole('textbox', { name: 'Notes' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: /Amount/ })).toHaveAttribute('aria-describedby', expect.stringContaining('unit'))
    expect(screen.getByLabelText('Files')).toBeDisabled()
    expect(screen.getAllByRole('status').some((status) => status.textContent?.includes('host-provided upload transport') === true)).toBe(true)
    expect(screen.getByText('<strong>Plain text only</strong>')).toBeInTheDocument()
    expect(screen.queryByText('Plain text only', { selector: 'strong' })).not.toBeInTheDocument()
  })
})
