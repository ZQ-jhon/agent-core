import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createA2UIFormController } from './form-state.ts'
import { parseA2UIFormDocument } from './parser.ts'
import { A2UIFormRenderer } from './renderer.tsx'
import type { NormalizedA2UIFormDocumentV1 } from './types.ts'

afterEach(cleanup)

function parseDocument(input: unknown): NormalizedA2UIFormDocumentV1 {
  const result = parseA2UIFormDocument(input)
  if (!result.ok) {
    throw new Error(JSON.stringify(result.errors))
  }
  return result.value
}

function allComponentsDocument(): NormalizedA2UIFormDocumentV1 {
  return parseDocument({
    schemaVersion: '1.0.0',
    requestId: 'request-1',
    formId: 'profile-form',
    revision: 1,
    root: {
      id: 'form',
      type: 'Form',
      props: {
        title: 'Profile details',
        description: 'Update the minimum details needed for this task.',
        submitOnEnter: true,
      },
      children: [
        {
          id: 'notice',
          type: 'Alert',
          props: { title: 'Before you start', message: 'Fields marked required must be completed.', variant: 'info' },
          children: [],
        },
        {
          id: 'guide',
          type: 'Markdown',
          props: { content: '## Guidance\n\nUse **accurate** details. [Help](https://example.com/help) <img src=x>' },
          children: [],
        },
        {
          id: 'profile-section',
          type: 'Section',
          props: { title: 'Profile', description: 'Basic profile fields.', collapsible: true },
          children: [
            {
              id: 'name',
              type: 'TextInput',
              props: { label: 'Name', helpText: 'Use the name shown on your account.', inputMode: 'text' },
              children: [],
              dataPath: '/profile/name',
              validation: [{ type: 'required', message: 'Name is required.' }],
            },
            {
              id: 'notes',
              type: 'TextArea',
              props: { label: 'Notes', rows: 3, maxRows: 6 },
              children: [],
              dataPath: '/profile/notes',
            },
            {
              id: 'amount',
              type: 'NumberInput',
              props: { label: 'Amount', step: 0.5, unit: 'USD' },
              children: [],
              dataPath: '/profile/amount',
            },
            {
              id: 'choice',
              type: 'Select',
              props: {
                label: 'Choice',
                placeholder: 'Choose one',
                options: [
                  { label: 'Basic', value: 'basic' },
                  { label: 'Pro', value: 'pro' },
                ],
              },
              children: [],
              dataPath: '/profile/choice',
            },
            {
              id: 'plan',
              type: 'RadioGroup',
              props: {
                label: 'Plan',
                options: [
                  { label: 'Monthly', value: 'monthly' },
                  { label: 'Annual', value: 'annual' },
                ],
              },
              children: [],
              dataPath: '/profile/plan',
            },
            {
              id: 'features',
              type: 'CheckboxGroup',
              props: {
                label: 'Features',
                options: [
                  { label: 'Reports', value: 'reports' },
                  { label: 'Exports', value: 'exports' },
                ],
              },
              children: [],
              dataPath: '/profile/features',
            },
            {
              id: 'date',
              type: 'DatePicker',
              props: { label: 'Start date', minDate: '2026-01-01', maxDate: '2026-12-31' },
              children: [],
              dataPath: '/profile/date',
            },
            {
              id: 'enabled',
              type: 'Switch',
              props: { label: 'Enabled', onLabel: 'Enabled', offLabel: 'Disabled' },
              children: [],
              dataPath: '/profile/enabled',
            },
            {
              id: 'files',
              type: 'Upload',
              props: { label: 'Evidence', buttonLabel: 'Select a file', accept: ['text/plain'], maxFiles: 2 },
              children: [],
              dataPath: '/profile/files',
              action: { actionId: 'upload-files' },
            },
          ],
        },
        {
          id: 'save',
          type: 'Button',
          props: { label: 'Save profile', variant: 'primary', loadingLabel: 'Saving profile' },
          children: [],
          action: { actionId: 'save-profile' },
        },
        {
          id: 'reset',
          type: 'Button',
          props: { label: 'Reset profile', variant: 'secondary' },
          children: [],
          action: { actionId: 'reset-profile' },
        },
      ],
    },
    data: {
      initialValues: {
        profile: {
          name: '',
          notes: '',
          amount: 1,
          choice: null,
          plan: null,
          features: [],
          date: null,
          enabled: false,
          files: [],
        },
      },
    },
    actions: [
      { id: 'save-profile', type: 'submit', endpointKey: 'profile.save', method: 'POST' },
      { id: 'reset-profile', type: 'reset' },
      { id: 'upload-files', type: 'upload', endpointKey: 'profile.upload', method: 'POST' },
    ],
  })
}

describe('A2UI component renderer', () => {
  it('renders the v1 allowlist with native labels, help, and safe Markdown output', () => {
    const document = allComponentsDocument()
    const controller = createA2UIFormController(document)

    render(<A2UIFormRenderer controller={controller} document={document} />)

    const name = screen.getByLabelText(/Name/)
    expect(name).toHaveAttribute('aria-required', 'true')
    expect(name).toHaveAttribute('aria-describedby')
    expect(screen.getByText('Use the name shown on your account.')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /Choice/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Monthly' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Reports' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /Enabled/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText(/Start date/)).toHaveAttribute('type', 'date')
    expect(screen.getByRole('button', { name: /Select a file/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', 'https://example.com/help')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('writes field values, keeps hidden data out of the DOM, and focuses the error summary after submit validation', async () => {
    const document = allComponentsDocument()
    const controller = createA2UIFormController(document, {
      submit: async () => ({ status: 'success', result: { submissionId: 'submission-1' } }),
    })

    render(<A2UIFormRenderer controller={controller} document={document} />)

    const name = screen.getByLabelText(/Name/) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Ada' } })
    expect(controller.getValue('/profile/name')).toBe('Ada')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Reports' }))
    expect(controller.getValue('/profile/features')).toEqual(['reports'])

    fireEvent.change(screen.getByRole('combobox', { name: /Choice/ }), {
      target: { value: 'string:pro' },
    })
    expect(controller.getValue('/profile/choice')).toBe('pro')

    fireEvent.change(name, { target: { value: '' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Profile details' }))

    const summary = await screen.findByRole('alert', { name: /Please check the following items/ })
    expect(summary).toHaveTextContent('Name is required.')
    expect(name).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => {
      expect(summary).toHaveFocus()
    })

    fireEvent.click(screen.getByRole('link', { name: 'Name is required.' }))
    await waitFor(() => {
      expect(name).toHaveFocus()
    })
  })

  it('updates a rule-controlled field without leaving the hidden control in the accessibility tree', async () => {
    const document = parseDocument({
      schemaVersion: '1.0.0',
      requestId: 'request-2',
      formId: 'conditional-form',
      revision: 1,
      root: {
        id: 'form',
        type: 'Form',
        props: { title: 'Conditional form' },
        children: [
          {
            id: 'enabled',
            type: 'Switch',
            props: { label: 'Needs detail' },
            children: [],
            dataPath: '/enabled',
          },
          {
            id: 'detail',
            type: 'TextInput',
            props: { label: 'Conditional detail' },
            children: [],
            dataPath: '/detail',
          },
        ],
      },
      data: { initialValues: { enabled: false, detail: '' } },
      actions: [],
      rules: [
        {
          id: 'show-detail',
          event: 'change',
          sourceDataPath: '/enabled',
          when: { op: 'equals', path: '/enabled', value: true },
          then: [{ type: 'setVisible', targetComponentId: 'detail', value: true }],
          else: [{ type: 'setVisible', targetComponentId: 'detail', value: false }],
        },
      ],
    })
    const controller = createA2UIFormController(document)

    render(<A2UIFormRenderer controller={controller} document={document} />)

    expect(screen.queryByLabelText('Conditional detail')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: /Needs detail/ }))
    const detail = await screen.findByLabelText('Conditional detail')
    detail.focus()
    expect(detail).toHaveFocus()
    act(() => {
      controller.setValue('/enabled', false)
    })
    await waitFor(() => {
      expect(screen.queryByLabelText('Conditional detail')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /Needs detail/ })).toHaveFocus()
    })
    expect(screen.getByRole('status')).toHaveTextContent('Focus returned to the control that changed it.')
    expect(controller.getSubmissionData()).toEqual({ enabled: false })
  })

  it('renders a keyboard-accessible confirmation dialog for confirmed submit actions', async () => {
    const document = parseDocument({
      schemaVersion: '1.0.0',
      requestId: 'request-3',
      formId: 'confirmed-form',
      revision: 1,
      root: {
        id: 'form',
        type: 'Form',
        props: { title: 'Confirmed form' },
        children: [
          {
            id: 'save',
            type: 'Button',
            props: { label: 'Save changes' },
            children: [],
            action: {
              actionId: 'save',
              confirm: {
                title: 'Save changes?',
                message: 'This action will save the current form.',
                confirmLabel: 'Save now',
                cancelLabel: 'Keep editing',
              },
            },
          },
        ],
      },
      data: { initialValues: {} },
      actions: [{ id: 'save', type: 'submit', endpointKey: 'form.save', method: 'POST' }],
    })
    const controller = createA2UIFormController(document, {
      submit: async () => ({ status: 'success', result: { submissionId: 'submission-1' } }),
    })

    render(<A2UIFormRenderer controller={controller} document={document} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const dialog = await screen.findByRole('dialog', { name: 'Save changes?' })
    expect(dialog).toHaveAccessibleDescription('This action will save the current form.')
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Save now' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Action completed')
  })

  it('uses a host upload result and never writes the local File object into form data', async () => {
    const document = allComponentsDocument()
    const controller = createA2UIFormController(document)
    const uploaded = {
      fileId: 'file-1',
      name: 'evidence.txt',
      size: 4,
      mimeType: 'text/plain',
      status: 'uploaded' as const,
    }
    const { container } = render(
      <A2UIFormRenderer
        controller={controller}
        document={document}
        onUpload={async () => uploaded}
      />,
    )
    const fileInput = container.querySelector('input[type="file"]')
    if (fileInput === null) {
      throw new Error('Expected upload input')
    }
    const localFile = new File(['test'], 'evidence.txt', { type: 'text/plain' })

    fireEvent.change(fileInput, { target: { files: [localFile] } })

    await waitFor(() => {
      expect(controller.getValue('/profile/files')).toEqual([uploaded])
    })
    expect(controller.getValue('/profile/files')).not.toEqual([localFile])
  })

  it('contains forged unknown components in the local unsupported placeholder', () => {
    const document = allComponentsDocument()
    const forged = structuredClone(document)
    Object.defineProperty(forged.root, 'children', {
      value: [
        ...forged.root.children,
        { id: 'unknown', type: 'NotInRegistry', props: {}, children: [] },
      ],
    })
    const controller = createA2UIFormController(forged)

    render(<A2UIFormRenderer controller={controller} document={forged} />)

    expect(screen.getByRole('status')).toHaveTextContent('Unsupported form component')
    expect(screen.getByRole('status')).toHaveTextContent('NotInRegistry')
  })
})
