// A small Markdown renderer for the catalog's free text (user_catalog p2):
// braindumps, reviews and the index. It builds DOM nodes and never sets
// markup from the source, so HTML in a text is shown as written, not run.
// Covered: headings, paragraphs, lists (nested by indent), fenced code,
// block quotes, rules, tables, and inline code, emphasis, strong and links.
// Anything else stays as its text.
import { h } from './dom.ts'

// Where a link of the text leads: return a URL, or a handler, or null to show it as text.
// `data`: what the link is, for the page that renders the text (set on the anchor's dataset).
export type LinkResolver = (target: string) => { href: string; onclick?: (e: Event) => void; external?: boolean; data?: Record<string, string> } | null

const SAFE = /^(https?:|mailto:|#)/i
const defaultLink: LinkResolver = t => SAFE.test(t) ? { href: t, external: /^https?:/i.test(t) } : null

function inline(text: string, link: LinkResolver): (Node | string)[] {
  const out: (Node | string)[] = []
  // code, link, strong, emphasis (which may hold code); the first match in the text wins.
  const re = /(`+)([\s\S]+?)\1|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+?)\*\*|__([^_]+?)__|\*((?!\s)(?:`[^`]+`|[^*`])+?)\*|(?<![A-Za-z0-9])_((?!\s)(?:`[^`]+`|[^_`])+?)_(?![A-Za-z0-9])|<(https?:\/\/[^>\s]+)>/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1]) out.push(h('code', m[2]))
    else if (m[3] !== undefined) {
      const l = link(m[4]) ?? defaultLink(m[4])
      out.push(l ? h('a', { href: l.href, ...(l.onclick ? { onclick: l.onclick } : {}), ...(l.external ? { target: '_blank', rel: 'noopener' } : {}), ...(l.data ? { dataset: l.data } : {}) }, inline(m[3], link)) : h('span', { title: m[4] }, inline(m[3], link)))
    } else if (m[5] !== undefined || m[6] !== undefined) out.push(h('strong', inline(m[5] ?? m[6], link)))
    else if (m[7] !== undefined || m[8] !== undefined) out.push(h('em', inline(m[7] ?? m[8], link)))
    else if (m[9]) out.push(h('a', { href: m[9], target: '_blank', rel: 'noopener' }, m[9]))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const startsBlock = (l: string) => /^\s*(#{1,6}\s|```|~~~|>|([-*_])(\s*\2){2,}\s*$)/.test(l) || LIST.test(l)

export function renderMarkdown(source: string, link: LinkResolver = defaultLink): HTMLElement {
  const root = h('div.md')
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  const list = (indent: number): HTMLElement => {
    const first = LIST.exec(lines[i])!
    const el = h(/\d/.test(first[2]) ? 'ol' : 'ul')
    while (i < lines.length) {
      const m = LIST.exec(lines[i])
      if (!m || m[1].length < indent) break
      if (m[1].length > indent) { (el.lastElementChild ?? el.appendChild(h('li'))).append(list(m[1].length)); continue }
      let text = m[3]
      i++
      // Continuation lines of the item: indented text that starts no block.
      while (i < lines.length && lines[i].trim() && /^\s+/.test(lines[i]) && !LIST.test(lines[i])) text += ` ${lines[i++].trim()}`
      const box = /^\[([ xX])\]\s+(.*)$/.exec(text)
      el.append(h('li', box ? [h('input', { type: 'checkbox', disabled: true, checked: box[1] !== ' ' }), ' ', inline(box[2], link)] : inline(text, link)))
      while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && LIST.test(lines[i + 1]) && LIST.exec(lines[i + 1])![1].length >= indent) i++
    }
    return el
  }
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      root.append(h('pre', h('code', body.join('\n'))))
      continue
    }
    const head = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (head) { root.append(h(`h${head[1].length}` as 'h1', inline(head[2], link))); i++; continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { root.append(h('hr')); i++; continue }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      root.append(h('blockquote', [...renderMarkdown(body.join('\n'), link).childNodes]))
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]))
      root.append(h('div.md-table', h('table', h('thead', h('tr', header.map(c => h('th', inline(c, link))))), h('tbody', rows.map(r => h('tr', header.map((_, k) => h('td', inline(r[k] ?? '', link)))))))))
      continue
    }
    if (LIST.test(line)) { root.append(list(LIST.exec(line)![1].length)); continue }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i]))) para.push(lines[i++].trim())
    // A line break in the source is kept: braindumps are often written line by line.
    root.append(h('p', para.flatMap((l, k) => k ? [h('br'), ...inline(l, link)] : inline(l, link))))
  }
  return root
}
