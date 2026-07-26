import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseA2UIFormDocument, parseA2UIJson } from './parser.ts'
import { componentRegistry, getComponentRegistration, isRegisteredComponentType, supportedComponentTypes } from './registry.ts'

const fixturePath = resolve(process.cwd(), '../docs/a2ui/v1/form-examples-v1.json')
const frozenExamples = (JSON.parse(readFileSync(fixturePath, 'utf8')) as { readonly examples: readonly unknown[] }).examples

describe('A2UI Form Profile v1 parser', () => {
  it('parses and normalizes all three frozen standard fixtures through one entry point', () => {
    expect(frozenExamples).toHaveLength(3)

    for (const fixture of frozenExamples) {
      const result = parseA2UIFormDocument(fixture)
      if (!result.ok) {
        throw new Error(`Expected frozen fixture to parse: ${JSON.stringify(result.errors)}`)
      }

      expect(result.value.schemaVersion).toBe('1.0.0')
      expect(result.value.root.type).toBe('Form')
      expect(result.value.dataSources).toBeInstanceOf(Array)
      expect(result.value.rules).toBeInstanceOf(Array)
      expect(Object.isFrozen(result.value)).toBe(true)
    }
  })

  it('materializes catalog defaults without modifying the submitted fixture', () => {
    const result = parseA2UIFormDocument(frozenExamples[0])
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors))
    }

    expect(result.value.root.props.submitOnEnter).toBe(false)
    const section = result.value.root.children[0]
    expect(section?.type).toBe('Section')
    if (section?.type !== 'Section') {
      throw new Error('Expected a Section fixture node')
    }
    expect(section.props.visible).toBe(true)
  })

  it('returns a stable fatal diagnostic for malformed or unknown schema fields', () => {
    const result = parseA2UIFormDocument({ schemaVersion: '1.0.0' })

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected parsing to fail')
    }
    expect(result.errors.some((error) => error.code === 'SCHEMA_INVALID')).toBe(true)
    expect(result.errors.some((error) => error.path === '/requestId')).toBe(true)
  })

  it('converts malformed JSON transport into a stable protocol diagnostic instead of throwing', () => {
    const result = parseA2UIJson('{not-json')

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({ code: 'SCHEMA_INVALID', path: '/' }),
      ],
    })
  })

  it('rejects a version that was not explicitly advertised by the client', () => {
    const schema = structuredClone(frozenExamples[0]) as { schemaVersion: string }
    schema.schemaVersion = '1.1.0'
    const result = parseA2UIFormDocument(schema)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'SCHEMA_VERSION_UNSUPPORTED')).toBe(true)
    }
  })

  it('allows only the A2UI autocomplete protocol whitelist instead of forwarding arbitrary schema strings', () => {
    const schemaWithAutoComplete = (autoComplete: string) => ({
      schemaVersion: '1.0.0',
      requestId: 'request-autocomplete',
      formId: 'form-autocomplete',
      revision: 1,
      root: {
        id: 'form-root',
        type: 'Form',
        props: {},
        children: [{
          id: 'email',
          type: 'TextInput',
          props: { label: 'Email', autoComplete },
          children: [],
          dataPath: '/email',
        }],
      },
      data: { initialValues: { email: '' } },
      actions: [],
    })

    const allowed = parseA2UIFormDocument(schemaWithAutoComplete('email'))
    expect(allowed.ok).toBe(true)
    if (allowed.ok) {
      const email = allowed.value.root.children[0]
      expect(email?.type).toBe('TextInput')
      if (email?.type === 'TextInput') {
        expect(email.props.autoComplete).toBe('email')
      }
    }

    const rejected = parseA2UIFormDocument(schemaWithAutoComplete('javascript:prompt(1)'))
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'SCHEMA_INVALID',
        path: '/root/children/0/props/autoComplete',
      }))
    }
  })

  it('rejects unknown components rather than resolving an import or executing configuration', () => {
    const schema = {
      schemaVersion: '1.0.0',
      requestId: 'request-1',
      formId: 'form-1',
      revision: 1,
      root: {
        id: 'form-root',
        type: 'Form',
        props: {},
        children: [{ id: 'unexpected-node', type: 'UnknownWidget', props: {}, children: [] }],
      },
      data: { initialValues: {} },
      actions: [],
    }
    const result = parseA2UIFormDocument(schema)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'COMPONENT_UNSUPPORTED', componentId: 'unexpected-node' }),
      )
    }
  })

  it('rejects a missing data binding, dangling action, and forbidden executable field', () => {
    const schema = {
      schemaVersion: '1.0.0',
      requestId: 'request-2',
      formId: 'form-2',
      revision: 1,
      root: {
        id: 'form-root',
        type: 'Form',
        props: {},
        children: [
          {
            id: 'name',
            type: 'TextInput',
            props: { label: 'Name' },
            children: [],
            dataPath: '/profile/name',
          },
          {
            id: 'submit',
            type: 'Button',
            props: { label: 'Submit', script: 'alert(1)' },
            children: [],
            action: { actionId: 'not-declared' },
          },
        ],
      },
      data: { initialValues: { profile: {} } },
      actions: [],
    }
    const result = parseA2UIFormDocument(schema)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'DATA_BINDING_INVALID')).toBe(true)
      expect(result.errors.some((error) => error.code === 'SCHEMA_SEMANTIC_INVALID')).toBe(true)
      expect(result.errors.some((error) => error.code === 'SCHEMA_INVALID' && error.path.endsWith('/script'))).toBe(true)
    }
  })

  it('rejects cyclic setValue rules before any runtime rule executor can consume them', () => {
    const schema = {
      schemaVersion: '1.0.0',
      requestId: 'request-3',
      formId: 'form-3',
      revision: 1,
      root: {
        id: 'form-root',
        type: 'Form',
        props: {},
        children: [
          { id: 'first', type: 'TextInput', props: { label: 'First' }, children: [], dataPath: '/first' },
          { id: 'second', type: 'TextInput', props: { label: 'Second' }, children: [], dataPath: '/second' },
        ],
      },
      data: { initialValues: { first: '', second: '' } },
      actions: [],
      rules: [
        {
          id: 'first-to-second',
          event: 'change',
          sourceDataPath: '/first',
          when: { op: 'exists', path: '/first' },
          then: [{ type: 'setValue', targetDataPath: '/second', value: '' }],
        },
        {
          id: 'second-to-first',
          event: 'change',
          sourceDataPath: '/second',
          when: { op: 'exists', path: '/second' },
          then: [{ type: 'setValue', targetDataPath: '/first', value: '' }],
        },
      ],
    }
    const result = parseA2UIFormDocument(schema)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'RULE_INVALID')).toBe(true)
    }
  })

  it('rejects a setValue value that is incompatible with its bound NumberInput', () => {
    const result = parseA2UIFormDocument({
      schemaVersion: '1.0.0',
      requestId: 'request-rule-number',
      formId: 'form-rule-number',
      revision: 1,
      root: {
        id: 'form-root',
        type: 'Form',
        props: {},
        children: [
          { id: 'amount', type: 'NumberInput', props: { label: 'Amount' }, children: [], dataPath: '/amount' },
        ],
      },
      data: { initialValues: { trigger: true, amount: 0 } },
      actions: [],
      rules: [
        {
          id: 'set-invalid-amount',
          event: 'change',
          sourceDataPath: '/trigger',
          when: { op: 'exists', path: '/trigger' },
          then: [{ type: 'setValue', targetDataPath: '/amount', value: 'not-a-number' }],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'DATA_BINDING_INVALID',
          path: '/rules/set-invalid-amount/then/0/value',
          componentId: 'amount',
        }),
      )
    }
  })

  it('rejects malformed Upload initial values and setValue rule values', () => {
    const result = parseA2UIFormDocument({
      schemaVersion: '1.0.0',
      requestId: 'request-upload-value',
      formId: 'form-upload-value',
      revision: 1,
      root: {
        id: 'form-root',
        type: 'Form',
        props: {},
        children: [
          {
            id: 'files',
            type: 'Upload',
            props: { label: 'Files' },
            children: [],
            dataPath: '/files',
            action: { actionId: 'upload' },
          },
        ],
      },
      data: { initialValues: { trigger: true, files: ['not-a-server-file'] } },
      actions: [{ id: 'upload', type: 'upload', endpointKey: 'forms.upload', method: 'POST' }],
      rules: [
        {
          id: 'set-invalid-upload',
          event: 'change',
          sourceDataPath: '/trigger',
          when: { op: 'exists', path: '/trigger' },
          then: [
            {
              type: 'setValue',
              targetDataPath: '/files',
              value: [{ fileId: 'file-1', name: 'resume.pdf', size: 1200, mimeType: 'application/pdf', status: 'pending' }],
            },
          ],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'DATA_BINDING_INVALID',
            path: '/root/children/0/dataPath',
            componentId: 'files',
          }),
          expect.objectContaining({
            code: 'DATA_BINDING_INVALID',
            path: '/rules/set-invalid-upload/then/0/value',
            componentId: 'files',
          }),
        ]),
      )
    }
  })

  it('rejects setValue writes through child paths that invalidate bound Upload and CheckboxGroup values', () => {
    const result = parseA2UIFormDocument({
      schemaVersion: '1.0.0',
      requestId: 'request-nested-bound-values',
      formId: 'form-nested-bound-values',
      revision: 1,
      root: {
        id: 'form-root',
        type: 'Form',
        props: {},
        children: [
          {
            id: 'files',
            type: 'Upload',
            props: { label: 'Files' },
            children: [],
            dataPath: '/files',
            action: { actionId: 'upload' },
          },
          {
            id: 'choices',
            type: 'CheckboxGroup',
            props: { label: 'Choices', options: [{ label: 'One', value: 'one' }] },
            children: [],
            dataPath: '/choices',
          },
        ],
      },
      data: {
        initialValues: {
          trigger: true,
          files: [{ fileId: 'file-1', name: 'resume.pdf', size: 1200, mimeType: 'application/pdf', status: 'uploaded' }],
          choices: ['one'],
        },
      },
      actions: [{ id: 'upload', type: 'upload', endpointKey: 'forms.upload', method: 'POST' }],
      rules: [
        {
          id: 'set-invalid-upload-status',
          event: 'change',
          sourceDataPath: '/trigger',
          when: { op: 'exists', path: '/trigger' },
          then: [{ type: 'setValue', targetDataPath: '/files/0/status', value: 'pending' }],
        },
        {
          id: 'set-invalid-checkbox-choice',
          event: 'change',
          sourceDataPath: '/trigger',
          when: { op: 'exists', path: '/trigger' },
          then: [{ type: 'setValue', targetDataPath: '/choices/0', value: 'not-an-option' }],
        },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'DATA_BINDING_INVALID',
          path: '/rules/set-invalid-upload-status/then/0/value',
          componentId: 'files',
        }),
        expect.objectContaining({
          code: 'DATA_BINDING_INVALID',
          path: '/rules/set-invalid-checkbox-choice/then/0/value',
          componentId: 'choices',
        }),
      ]))
    }
  })

  describe('pattern validation (RE2 compatibility and safety)', () => {
    function schemaWithPattern(value: string) {
      return {
        schemaVersion: '1.0.0',
        requestId: 'request-pattern',
        formId: 'form-pattern',
        revision: 1,
        root: {
          id: 'form-root',
          type: 'Form' as const,
          props: {},
          children: [
            {
              id: 'input',
              type: 'TextInput' as const,
              props: { label: 'Input' },
              children: [],
              dataPath: '/input',
              validation: [{ type: 'pattern' as const, value }],
            },
          ],
        },
        data: { initialValues: { input: '' } },
        actions: [],
      }
    }

    function expectRejected(value: string) {
      const result = parseA2UIFormDocument(schemaWithPattern(value))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'SCHEMA_INVALID', path: '/root/children/0/validation/0/value' }),
        )
      }
    }

    function expectAccepted(value: string) {
      const result = parseA2UIFormDocument(schemaWithPattern(value))
      expect(result.ok).toBe(true)
    }

    // ── Accepted: RE2-compatible patterns ──────────────────────────
    it('accepts simple literal patterns', () => {
      expectAccepted('^1[3-9][0-9]{9}$')  // phone number
      expectAccepted('[a-z]+')            // lowercase letters
      expectAccepted('\\d{3}-\\d{4}')    // escaped digits with dash
    })

    it('accepts alternation', () => {
      expectAccepted('a|b')
      expectAccepted('^(foo|bar)$')
      expectAccepted('^(red|green|blue)$')
    })

    it('accepts groups', () => {
      expectAccepted('(foo)+')
      expectAccepted('(ab){2,4}')
    })

    it('accepts non-capturing groups', () => {
      expectAccepted('(?:foo|bar)')
    })

    it('accepts character class intersection (RE2-safe)', () => {
      expectAccepted('[a-z&&[^aeiou]]')
    })

    it('accepts escaped ] inside character classes', () => {
      expectAccepted('[\\]]')
      expectAccepted('[\\]]+')
      expectAccepted('[a-z\\]]')
      expectAccepted('[-\\]]')
    })

    it('accepts safe quantified sequences', () => {
      expectAccepted('^[0-9]+[a-z]*$')   // different char classes
      expectAccepted('^[a-z][0-9]+$')    // literal + quantifier
    })

    // ── Rejected: non-RE2 features ─────────────────────────────────
    it('rejects lookahead', () => {
      expectRejected('(?=suffix)')
      expectRejected('(?!suffix)')
    })

    it('rejects lookbehind', () => {
      expectRejected('(?<=prefix)')
      expectRejected('(?<!prefix)')
    })

    it('rejects atomic groups', () => {
      expectRejected('(?>atomic)')
    })

    it('rejects numeric backreferences', () => {
      expectRejected('(a)\\1')
    })

    it('rejects named capture definitions', () => {
      expectRejected('(?P<name>a)')
    })

    it('rejects named backreferences', () => {
      expectRejected('(?P<name>a)(?P=name)')
      expectRejected('\\k<name>')
      expectRejected("\\k'name'")
    })

    it('rejects recursion and subroutine calls', () => {
      expectRejected('(?R)')
      expectRejected('(?&name)')
    })

    it('rejects conditionals', () => {
      expectRejected('(?()|)')
    })

    it('rejects possessive quantifiers', () => {
      expectRejected('a*+')
      expectRejected('a++')
      expectRejected('a?+')
      expectRejected('a{1,2}+')
      expectRejected('a{3}+')
      expectRejected('[a-z]++')    // possessive after char class
      expectRejected('[a-z]*+')
      expectRejected('[a-z]?+')
      expectRejected('[a-z]{2}+')
    })

    // ── Rejected: adjacent overlapping quantifiers (ReDoS) ─────────
    it('rejects adjacent identical literal quantifiers', () => {
      expectRejected('^a*a*b$')          // a* followed by a*
      expectRejected('^a+a+$')           // a+ followed by a+
      expectRejected('^a?a?$')           // a? followed by a?
    })

    it('rejects ReDoS attack pattern with many adjacent quantifiers', () => {
      expectRejected('^a*a*a*a*a*a*a*a*b$')
    })

    it('rejects adjacent identical character class quantifiers', () => {
      expectRejected('[a-z]*[a-z]+')
      expectRejected('[0-9]+[0-9]*')
    })

    it('rejects adjacent identical escape quantifiers', () => {
      expectRejected('\\d*\\d*')
      expectRejected('\\w+\\w+')
    })

    // ── Rejected: nested quantifiers ───────────────────────────────
    it('rejects nested quantifiers via groups', () => {
      expectRejected('^(a+)+$')
      expectRejected('(a*)*')
      expectRejected('([a-z]+)+')
      expectRejected('((a+)+)')
    })

    it('rejects deeply nested quantifiers', () => {
      expectRejected('(((a+)+)+)')
    })

    // ── Rejected: structural issues ────────────────────────────────
    it('rejects unclosed character class', () => {
      expectRejected('[a-z')
    })

    it('rejects unclosed group', () => {
      expectRejected('(foo')
    })

    it('rejects pattern exceeding max length', () => {
      expectRejected('a'.repeat(257))
    })
  })

  it('rejects an excessively deep component tree with a diagnostic rather than overflowing the call stack', () => {
    const root: Record<string, unknown> = { id: 'root', type: 'Form', props: {}, children: [] }
    let parent = root
    for (let index = 0; index < 40; index += 1) {
      const child: Record<string, unknown> = {
        id: `section-${index}`,
        type: 'Section',
        props: { title: `Section ${index}` },
        children: [],
      }
      const children = parent.children
      if (!Array.isArray(children)) {
        throw new Error('Test tree parent must have a children array')
      }
      children.push(child)
      parent = child
    }
    const result = parseA2UIFormDocument({
      schemaVersion: '1.0.0',
      requestId: 'request-5',
      formId: 'form-5',
      revision: 1,
      root,
      data: { initialValues: {} },
      actions: [],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SCHEMA_INVALID' }))
      expect(result.errors.some((error) => error.message.includes('safety depth limit'))).toBe(true)
    }
  })
})

describe('closed component registry', () => {
  it('contains exactly the frozen catalog and has no registration API', () => {
    expect(supportedComponentTypes).toHaveLength(14)
    expect(isRegisteredComponentType('Form')).toBe(true)
    expect(isRegisteredComponentType('UnknownWidget')).toBe(false)
    expect(getComponentRegistration('Upload')).toMatchObject({ requiredActionType: 'upload' })
    expect(getComponentRegistration('UnknownWidget')).toBeUndefined()
    expect(Object.isFrozen(componentRegistry)).toBe(true)
  })
})
