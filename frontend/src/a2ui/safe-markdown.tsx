import type { ReactNode } from 'react'

interface HeadingBlock {
  readonly type: 'heading'
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6
  readonly content: string
}

interface ParagraphBlock {
  readonly type: 'paragraph'
  readonly content: string
}

interface QuoteBlock {
  readonly type: 'quote'
  readonly content: string
}

interface ListBlock {
  readonly type: 'ordered-list' | 'unordered-list'
  readonly items: readonly string[]
}

type MarkdownBlock = HeadingBlock | ParagraphBlock | QuoteBlock | ListBlock

/**
 * Render the deliberately small A2UI Markdown subset. The schema never
 * reaches an HTML parser: we first parse plain text into a constrained block
 * model and then sanitize link destinations before creating React elements.
 */
export function SafeMarkdown({ content }: { readonly content: string }) {
  return <>{parseMarkdownBlocks(content).map(renderBlock)}</>
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
  const key = `markdown-${index}`
  switch (block.type) {
    case 'heading':
      return renderHeading(block.depth, renderInline(block.content, key), key)
    case 'paragraph':
      return <p key={key}>{renderInline(block.content, key)}</p>
    case 'quote':
      return <blockquote key={key}>{renderInline(block.content, key)}</blockquote>
    case 'ordered-list':
      return <ol key={key}>{renderListItems(block.items, key)}</ol>
    case 'unordered-list':
      return <ul key={key}>{renderListItems(block.items, key)}</ul>
  }
}

function renderHeading(depth: HeadingBlock['depth'], content: ReactNode, key: string): ReactNode {
  switch (depth) {
    case 1:
      return <h1 key={key}>{content}</h1>
    case 2:
      return <h2 key={key}>{content}</h2>
    case 3:
      return <h3 key={key}>{content}</h3>
    case 4:
      return <h4 key={key}>{content}</h4>
    case 5:
      return <h5 key={key}>{content}</h5>
    case 6:
      return <h6 key={key}>{content}</h6>
  }
}

function renderListItems(items: readonly string[], key: string): ReactNode {
  return items.map((item, index) => <li key={`${key}-item-${index}`}>{renderInline(item, `${key}-item-${index}`)}</li>)
}

function parseMarkdownBlocks(source: string): readonly MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let lineIndex = 0

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? ''
    if (line.trim() === '') {
      lineIndex += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading !== null) {
      blocks.push({ type: 'heading', depth: heading[1]!.length as HeadingBlock['depth'], content: heading[2]! })
      lineIndex += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (lineIndex < lines.length && /^>\s?/.test(lines[lineIndex] ?? '')) {
        quoteLines.push((lines[lineIndex] ?? '').replace(/^>\s?/, ''))
        lineIndex += 1
      }
      blocks.push({ type: 'quote', content: quoteLines.join('\n') })
      continue
    }

    const unordered = /^[-*+]\s+(.+)$/.exec(line)
    if (unordered !== null) {
      const items: string[] = []
      while (lineIndex < lines.length) {
        const item = /^[-*+]\s+(.+)$/.exec(lines[lineIndex] ?? '')
        if (item === null) {
          break
        }
        items.push(item[1]!)
        lineIndex += 1
      }
      blocks.push({ type: 'unordered-list', items })
      continue
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(line)
    if (ordered !== null) {
      const items: string[] = []
      while (lineIndex < lines.length) {
        const item = /^\d+\.\s+(.+)$/.exec(lines[lineIndex] ?? '')
        if (item === null) {
          break
        }
        items.push(item[1]!)
        lineIndex += 1
      }
      blocks.push({ type: 'ordered-list', items })
      continue
    }

    const paragraphLines: string[] = []
    while (lineIndex < lines.length) {
      const candidate = lines[lineIndex] ?? ''
      if (candidate.trim() === '' || isBlockStart(candidate)) {
        break
      }
      paragraphLines.push(candidate)
      lineIndex += 1
    }
    blocks.push({ type: 'paragraph', content: paragraphLines.join('\n') })
  }

  return blocks
}

function isBlockStart(line: string): boolean {
  return /^(#{1,6})\s+|^>\s?|^[-*+]\s+|^\d+\.\s+/.test(line)
}

function renderInline(content: string, keyPrefix: string): ReactNode {
  const nodes: ReactNode[] = []
  const matcher = /(\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*)/g
  let previousIndex = 0
  let match: RegExpExecArray | null
  let tokenIndex = 0

  while ((match = matcher.exec(content)) !== null) {
    appendText(nodes, content.slice(previousIndex, match.index), `${keyPrefix}-text-${tokenIndex}`)
    const key = `${keyPrefix}-token-${tokenIndex}`
    if (match[2] !== undefined && match[3] !== undefined) {
      const href = sanitizeMarkdownHref(match[3])
      nodes.push(href === undefined ? <span key={key}>{match[2]}</span> : <a href={href} key={key}>{match[2]}</a>)
    } else if (match[4] !== undefined) {
      nodes.push(<strong key={key}>{match[4]}</strong>)
    } else if (match[5] !== undefined) {
      nodes.push(<code key={key}>{match[5]}</code>)
    } else if (match[6] !== undefined) {
      nodes.push(<em key={key}>{match[6]}</em>)
    }
    previousIndex = matcher.lastIndex
    tokenIndex += 1
  }

  appendText(nodes, content.slice(previousIndex), `${keyPrefix}-tail`)
  return nodes
}

function appendText(nodes: ReactNode[], value: string, keyPrefix: string): void {
  const lines = value.split('\n')
  lines.forEach((line, index) => {
    if (line !== '') {
      nodes.push(<span key={`${keyPrefix}-${index}`}>{line}</span>)
    }
    if (index < lines.length - 1) {
      nodes.push(<br key={`${keyPrefix}-break-${index}`} />)
    }
  })
}

function sanitizeMarkdownHref(rawHref: string): string | undefined {
  const href = rawHref.trim()
  if (href === '' || href.startsWith('//')) {
    return undefined
  }
  const compacted = href.replace(/[\u0000-\u0020]/g, '')
  const protocol = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(compacted)?.[1]?.toLowerCase()
  if (protocol !== undefined) {
    return protocol === 'http' || protocol === 'https' || protocol === 'mailto' ? href : undefined
  }
  return href.startsWith('/') || href.startsWith('./') || href.startsWith('../') || href.startsWith('#')
    ? href
    : undefined
}
