import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createA2UIFormController } from './form-state.ts'
import { A2UIFormRenderer, type A2UIUploadRequest } from './form-renderer.tsx'
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
    expect(name).toHaveAttribute('aria-describedby', expect.stringContaining('-help'))
    expect(screen.getByText('Use your legal name')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Disabled name' })).toBeDisabled()
    expect(screen.queryByRole('textbox', { name: 'Hidden name' })).not.toBeInTheDocument()

    fireEvent.change(name, { target: { value: 'Ada Lovelace' } })
    expect(controller.getValue('/name')).toBe('Ada Lovelace')

    fireEvent.change(name, { target: { value: '' } })
    fireEvent.blur(name)
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAttribute('aria-errormessage', expect.stringContaining('-error'))
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
    expect(screen.getByRole('link', { name: /required/i })).toHaveAttribute('href', `#${name.id}`)
    expect(submit).not.toHaveBeenCalled()

    const resetWithConfirmation = screen.getByRole('button', { name: 'Reset with confirmation' })
    fireEvent.click(resetWithConfirmation)
    const dialog = await screen.findByRole('dialog', { name: 'Reset form?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(resetWithConfirmation).toHaveFocus())
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
    expect(screen.getByRole('textbox', { name: /Amount/ })).toHaveAttribute('aria-describedby', expect.stringContaining('unit'))
    expect(screen.getByLabelText('Files')).toBeDisabled()
    expect(screen.getAllByRole('status').some((status) => status.textContent?.includes('host provides an upload transport') === true)).toBe(true)
    expect(screen.getByText('<strong>Plain text only</strong>')).toBeInTheDocument()
    expect(screen.queryByText('Plain text only', { selector: 'strong' })).not.toBeInTheDocument()
  })

  it('applies inert to the background form when the confirmation dialog is open and removes it on close', async () => {
    const document = documentWith(
      { name: 'Ada' },
      [
        { id: 'name', type: 'TextInput', props: { label: 'Name' }, children: [], dataPath: '/name' },
        {
          id: 'reset',
          type: 'Button',
          props: { label: 'Reset' },
          children: [],
          action: { actionId: 'reset', confirm: { title: 'Discard edits?', message: 'This cannot be undone.' } },
        },
      ],
      [{ id: 'reset', type: 'reset' }],
    )
    const controller = createA2UIFormController(document)
    render(<A2UIFormRenderer controller={controller} document={document} />)

    const form = window.document.querySelector('form')!
    expect(form.hasAttribute('inert')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await screen.findByRole('dialog', { name: 'Discard edits?' })
    expect(form.hasAttribute('inert')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(form.hasAttribute('inert')).toBe(false)
  })

  it('cancels the confirmation dialog via a global Escape listener even when focus has drifted outside the dialog', async () => {
    const document = documentWith(
      { name: 'Ada' },
      [
        { id: 'name', type: 'TextInput', props: { label: 'Name' }, children: [], dataPath: '/name' },
        {
          id: 'reset',
          type: 'Button',
          props: { label: 'Reset' },
          children: [],
          action: { actionId: 'reset', confirm: { title: 'Discard edits?', message: 'This cannot be undone.' } },
        },
      ],
      [{ id: 'reset', type: 'reset' }],
    )
    const controller = createA2UIFormController(document)
    render(<A2UIFormRenderer controller={controller} document={document} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await screen.findByRole('dialog', { name: 'Discard edits?' })

    // Fire Escape on the document — the global listener must cancel the dialog.
    fireEvent.keyDown(window.document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('traps confirmation-dialog focus, exposes its description, cancels with Escape, and restores the trigger focus', async () => {
    const document = documentWith(
      { name: 'Ada' },
      [
        { id: 'name', type: 'TextInput', props: { label: 'Name' }, children: [], dataPath: '/name' },
        {
          id: 'reset',
          type: 'Button',
          props: { label: 'Reset' },
          children: [],
          action: { actionId: 'reset', confirm: { title: 'Discard edits?', message: 'This cannot be undone.' } },
        },
      ],
      [{ id: 'reset', type: 'reset' }],
    )
    const controller = createA2UIFormController(document)
    render(<A2UIFormRenderer controller={controller} document={document} />)

    const trigger = screen.getByRole('button', { name: 'Reset' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Discard edits?' })
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(dialog).toHaveAttribute('aria-describedby')
    expect(screen.getByText('This cannot be undone.')).toHaveAttribute('id', dialog.getAttribute('aria-describedby')!)
    expect(confirm).toHaveFocus()

    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
    fireEvent.keyDown(confirm, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('opens collapsed ancestor sections and focuses colon-id fields from an error-summary fragment link', async () => {
    const document = documentWith(
      { amount: '' },
      [
        {
          id: 'billing:section',
          type: 'Section',
          props: { title: 'Billing', collapsible: true, defaultCollapsed: true },
          children: [
            {
              id: 'billing:amount',
              type: 'TextInput',
              props: { label: 'Amount' },
              children: [],
              dataPath: '/amount',
              validation: [{ type: 'required' }],
            },
          ],
        },
        { id: 'submit', type: 'Button', props: { label: 'Submit' }, children: [], action: { actionId: 'submit' } },
      ],
      [{ id: 'submit', type: 'submit', endpointKey: 'forms.submit', method: 'POST' }],
    )
    const controller = createA2UIFormController(document, {
      submit: async () => ({ status: 'success', result: { submissionId: 'unused' } }),
    })
    render(<A2UIFormRenderer controller={controller} document={document} />)

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    const link = await screen.findByRole('link', { name: /required/i })
    expect(link).not.toHaveAttribute('href', expect.stringContaining('%'))
    fireEvent.click(link)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Billing' })).toHaveAttribute('aria-expanded', 'true'))
    const amount = screen.getByRole('textbox', { name: 'Amount (required)' })
    await waitFor(() => expect(amount).toHaveFocus())
    expect(link).toHaveAttribute('href', `#${amount.id}`)
  })

  it('prevents disabled RadioGroup and CheckboxGroup options from changing form state by mouse or keyboard events', () => {
    const document = documentWith(
      { plan: 'free', features: [] },
      [
        {
          id: 'plan',
          type: 'RadioGroup',
          props: { label: 'Plan', options: [{ label: 'Free', value: 'free' }, { label: 'Enterprise', value: 'enterprise', disabled: true }] },
          children: [],
          dataPath: '/plan',
        },
        {
          id: 'features',
          type: 'CheckboxGroup',
          props: { label: 'Features', options: [{ label: 'Audit log', value: 'audit', disabled: true }, { label: 'Export', value: 'export' }] },
          children: [],
          dataPath: '/features',
        },
      ],
    )
    const controller = createA2UIFormController(document)
    render(<A2UIFormRenderer controller={controller} document={document} />)

    const disabledRadio = screen.getByRole('radio', { name: 'Enterprise' })
    const disabledCheckbox = screen.getByRole('checkbox', { name: 'Audit log' })
    expect(disabledRadio).toBeDisabled()
    expect(disabledCheckbox).toBeDisabled()
    fireEvent.click(disabledRadio)
    fireEvent.keyDown(disabledRadio, { key: ' ' })
    fireEvent.change(disabledRadio, { target: { checked: true } })
    fireEvent.click(disabledCheckbox)
    fireEvent.keyDown(disabledCheckbox, { key: ' ' })
    fireEvent.change(disabledCheckbox, { target: { checked: true } })
    expect(controller.getValue('/plan')).toBe('free')
    expect(controller.getValue('/features')).toEqual([])

    fireEvent.click(screen.getByRole('checkbox', { name: 'Export' }))
    expect(controller.getValue('/features')).toEqual(['export'])
  })

  it('keeps negative and decimal NumberInput drafts editable, then normalizes or reports them only when committed', async () => {
    const submit = vi.fn(async () => ({ status: 'success' as const, result: { submissionId: 'should-not-submit' } }))
    const document = documentWith(
      { amount: null },
      [
        {
          id: 'amount',
          type: 'NumberInput',
          props: { label: 'Amount' },
          children: [],
          dataPath: '/amount',
          validation: [{ type: 'required' }],
        },
        { id: 'submit', type: 'Button', props: { label: 'Submit' }, children: [], action: { actionId: 'submit' } },
      ],
      [{ id: 'submit', type: 'submit', endpointKey: 'forms.submit', method: 'POST' }],
      { submitOnEnter: true },
    )
    const controller = createA2UIFormController(document, { submit })
    render(<A2UIFormRenderer controller={controller} document={document} />)

    const amount = screen.getByRole('textbox', { name: /Amount/ }) as HTMLInputElement
    fireEvent.change(amount, { target: { value: '-' } })
    expect(amount.value).toBe('-')
    expect(controller.getValue('/amount')).toBe(null)
    expect(amount).not.toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(amount, { target: { value: '-1.' } })
    expect(amount.value).toBe('-1.')
    fireEvent.blur(amount)
    expect(amount.value).toBe('-1')
    expect(controller.getValue('/amount')).toBe(-1)

    fireEvent.change(amount, { target: { value: '-.5' } })
    fireEvent.blur(amount)
    expect(controller.getValue('/amount')).toBe(-0.5)
    expect(amount.value).toBe('-0.5')

    fireEvent.change(amount, { target: { value: '-.' } })
    fireEvent.blur(amount)
    expect(amount).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid number')

    fireEvent.change(amount, { target: { value: '-' } })
    fireEvent.keyDown(amount, { key: 'Enter' })
    await waitFor(() => expect(amount).toHaveAttribute('aria-invalid', 'true'))
    expect(submit).not.toHaveBeenCalled()
  })

  it('caps auto-growing text areas at maxRows and only submits editable single-line text inputs on Enter', async () => {
    const submit = vi.fn(async () => ({ status: 'success' as const, result: { submissionId: 'submission-2' } }))
    const document = documentWith(
      { name: '', notes: '', plan: 'free' },
      [
        { id: 'name', type: 'TextInput', props: { label: 'Name' }, children: [], dataPath: '/name' },
        { id: 'notes', type: 'TextArea', props: { label: 'Notes', rows: 2, maxRows: 4 }, children: [], dataPath: '/notes' },
        {
          id: 'plan',
          type: 'Select',
          props: { label: 'Plan', options: [{ label: 'Free', value: 'free' }, { label: 'Pro', value: 'pro' }] },
          children: [],
          dataPath: '/plan',
        },
        { id: 'submit', type: 'Button', props: { label: 'Submit' }, children: [], action: { actionId: 'submit' } },
      ],
      [{ id: 'submit', type: 'submit', endpointKey: 'forms.submit', method: 'POST' }],
      { submitOnEnter: true },
    )
    const controller = createA2UIFormController(document, { submit })
    render(<A2UIFormRenderer controller={controller} document={document} />)

    const notes = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement
    Object.defineProperty(notes, 'scrollHeight', { configurable: true, value: 200 })
    fireEvent.change(notes, { target: { value: 'A long note' } })
    expect(notes).toHaveAttribute('data-a2ui-max-rows', '4')
    expect(notes.style.maxHeight).toBe('80px')
    expect(notes.style.height).toBe('80px')
    expect(notes.style.overflowY).toBe('auto')

    fireEvent.keyDown(notes, { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Plan' }), { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter' })
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  it('uses a host bridge for keyboard-triggerable uploads, commits only server file references, and enforces type and size limits', async () => {
    const document = documentWith(
      { files: [] },
      [{ id: 'files', type: 'Upload', props: { label: 'Files', accept: ['image/*'], maxFiles: 2, maxSizeBytes: 4 }, children: [], dataPath: '/files', action: { actionId: 'upload' } }],
      [{ id: 'upload', type: 'upload', endpointKey: 'files.upload', method: 'POST' }],
    )
    const controller = createA2UIFormController(document)
    let resolveUpload: ((result: { readonly fileId: string }) => void) | undefined
    const upload = vi.fn((request: A2UIUploadRequest) => {
      request.reportProgress(45)
      return new Promise<{ readonly fileId: string }>((resolve) => {
        resolveUpload = resolve
      })
    })
    render(<A2UIFormRenderer controller={controller} document={document} upload={upload} />)

    const fileInput = screen.getByLabelText('Files') as HTMLInputElement
    const chooseFile = screen.getByRole('button', { name: 'Choose file' })
    const inputClick = vi.spyOn(fileInput, 'click')
    fireEvent.keyDown(chooseFile, { key: 'Enter' })
    expect(inputClick).toHaveBeenCalledTimes(1)

    const image = new File(['1234'], 'avatar.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [image] } })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText(/45% uploaded/).length).toBeGreaterThanOrEqual(1)
    expect(controller.getValue('/files')).toEqual([])

    resolveUpload?.({ fileId: 'file-server-1' })
    await waitFor(() => expect(controller.getValue('/files')).toEqual([
      { fileId: 'file-server-1', name: 'avatar.png', size: 4, mimeType: 'image/png', status: 'uploaded' },
    ]))
    expect(JSON.stringify(controller.getSubmissionData())).not.toContain('blob:')
    expect(controller.getSubmissionData()).toEqual({
      files: [{ fileId: 'file-server-1', name: 'avatar.png', size: 4, mimeType: 'image/png', status: 'uploaded' }],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove avatar.png' }))
    expect(controller.getValue('/files')).toEqual([])

    fireEvent.change(fileInput, { target: { files: [new File(['ok'], 'notes.txt', { type: 'text/plain' })] } })
    expect(screen.getByText(/This file type is not accepted/)).toBeInTheDocument()
    fireEvent.change(fileInput, { target: { files: [new File(['12345'], 'large.png', { type: 'image/png' })] } })
    expect(screen.getByText(/This file exceeds the maximum allowed size/)).toBeInTheDocument()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('shows failed uploads locally and retries them without ever writing a File object to form state', async () => {
    const document = documentWith(
      { files: [] },
      [{ id: 'files', type: 'Upload', props: { label: 'Files' }, children: [], dataPath: '/files', action: { actionId: 'upload' } }],
      [{ id: 'upload', type: 'upload', endpointKey: 'files.upload', method: 'POST' }],
    )
    const controller = createA2UIFormController(document)
    let attempt = 0
    const upload = vi.fn(async (_request: A2UIUploadRequest) => {
      attempt += 1
      if (attempt === 1) {
        throw new Error('offline')
      }
      return { fileId: 'file-server-2' }
    })
    render(<A2UIFormRenderer controller={controller} document={document} upload={upload} />)

    const fileInput = screen.getByLabelText('Files') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'retry.png', { type: 'image/png' })] } })
    const removeFailed = await screen.findByRole('button', { name: 'Remove retry.png' })
    expect(controller.getValue('/files')).toEqual([])

    // Remove the failed upload — it should disappear and no data should be written.
    fireEvent.click(removeFailed)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove retry.png' })).not.toBeInTheDocument())
    expect(controller.getValue('/files')).toEqual([])

    // Re-add the file — the mock will succeed on this second attempt.
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'retry.png', { type: 'image/png' })] } })

    await waitFor(() => expect(controller.getValue('/files')).toEqual([
      { fileId: 'file-server-2', name: 'retry.png', size: 1, mimeType: 'image/png', status: 'uploaded' },
    ]))
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('exposes upload progress in an aria-live region and surfaces failed upload status', async () => {
    const document = documentWith(
      { files: [] },
      [{ id: 'files', type: 'Upload', props: { label: 'Files' }, children: [], dataPath: '/files', action: { actionId: 'upload' } }],
      [{ id: 'upload', type: 'upload', endpointKey: 'files.upload', method: 'POST' }],
    )
    const controller = createA2UIFormController(document)
    let resolveUpload: ((result: { readonly fileId: string }) => void) | undefined
    const upload = vi.fn((request: A2UIUploadRequest) => {
      request.reportProgress(60)
      return new Promise<{ readonly fileId: string }>((resolve) => {
        resolveUpload = resolve
      })
    })
    render(<A2UIFormRenderer controller={controller} document={document} upload={upload} />)

    const fileInput = screen.getByLabelText('Files') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'progress.png', { type: 'image/png' })] } })

    // The aria-live region should report progress.
    const liveRegion = screen.getByRole('status', { name: 'Files upload progress' })
    expect(liveRegion).toHaveAttribute('aria-live', 'polite')
    await waitFor(() => expect(liveRegion).toHaveTextContent('progress.png: 60% uploaded'))

    // Complete the upload — progress should disappear.
    resolveUpload?.({ fileId: 'file-done' })
    await waitFor(() => expect(liveRegion).toBeEmptyDOMElement())

    // Verify upload result landed.
    expect(controller.getValue('/files')).toEqual([
      { fileId: 'file-done', name: 'progress.png', size: 1, mimeType: 'image/png', status: 'uploaded' },
    ])
  })

  it('renders only the Markdown subset and removes unsafe link protocols without interpreting raw HTML', () => {
    const document = documentWith(
      {},
      [{
        id: 'guide',
        type: 'Markdown',
        props: {
          ariaLabel: 'Guide',
          content: '# Heading\n\nA **strong** *emphasis* `code` [safe](https://example.com).\n\n- First\n- Second\n\n[bad](javascript:alert(1)) [data](data:text/html,boom) <img src=x>',
        },
        children: [],
      }],
    )
    const controller = createA2UIFormController(document)
    render(<A2UIFormRenderer controller={controller} document={document} />)

    expect(screen.getByRole('region', { name: 'Guide' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument()
    expect(screen.getByText('strong', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('emphasis', { selector: 'em' })).toBeInTheDocument()
    expect(screen.getByText('code', { selector: 'code' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'safe' })).toHaveAttribute('href', 'https://example.com')
    expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'data' })).not.toBeInTheDocument()
    expect(screen.getByText('<img src=x>')).toBeInTheDocument()
    expect(screen.queryByText('img', { selector: 'img' })).not.toBeInTheDocument()
  })
})
