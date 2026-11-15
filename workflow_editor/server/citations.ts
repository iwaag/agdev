// Back references of the catalog's braindumps (user_catalog p4,
// docs/mycatalog.md *Citing a braindump*): one record per citation, written
// when it is made — a message posted with it, or a run created with it — in
// <area>/.local/citations.jsonl, and read from there. Runs and conversations
// are never scanned for them. A record is appended once and never changed.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type CitationPlace =
  | { kind: 'conversation'; conversation: string; message: number }
  | { kind: 'run'; workspace: string; project?: string; workflow: string; run: string }
export interface Citation { braindump: string; commit: string; at: string; by: string; where: CitationPlace }

const file = (area: string) => join(area, '.local', 'citations.jsonl')

export function recordCitations(area: string, refs: { kind: string; id: string; commit?: string }[], by: string, where: CitationPlace): void {
  const cited = refs.filter(r => r.kind === 'braindump')
  if (!cited.length) return
  const at = new Date().toISOString()
  try {
    mkdirSync(join(area, '.local'), { recursive: true })
    appendFileSync(file(area), cited.map(r => `${JSON.stringify({ braindump: r.id, commit: r.commit ?? '', at, by, where } satisfies Citation)}\n`).join(''))
  } catch (e) { console.error(`citations: not recorded (${(e as Error).message})`) }
}

// Every citation, newest first; of one braindump when named.
export function citations(area: string, braindump?: string): Citation[] {
  let text = ''
  try { text = readFileSync(file(area), 'utf8') } catch { return [] }
  const out: Citation[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { const c = JSON.parse(line) as Citation; if (!braindump || c.braindump === braindump) out.push(c) } catch { /* a torn line is not a citation */ }
  }
  return out.reverse()
}
export function citationCounts(area: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of citations(area)) out.set(c.braindump, (out.get(c.braindump) ?? 0) + 1)
  return out
}
