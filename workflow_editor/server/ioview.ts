// Reading an attempt's IO in full (p10): one entry of its log, redacted
// (server/io.ts); never the raw log.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { entryAt, redact } from './io.ts'
import type { ExecStore } from './exec.ts'
import { RequestError, type Workspace } from './workspace.ts'
import type { RunRef } from '../shared/run.ts'

// Values of this host's credential files (<area>/redaction.json {"secretFiles": [paths]}, cluster_teamwork p5),
// masked wherever they appear, besides the shapes `redact` knows. A file that cannot be read masks nothing.
function secretValues(area: string): string[] {
  let files: unknown
  try { files = (JSON.parse(readFileSync(join(area, 'redaction.json'), 'utf8')) as { secretFiles?: unknown }).secretFiles } catch { return [] }
  const out = new Set<string>()
  const add = (v: unknown) => { if (typeof v === 'string' && v.trim().length >= 8) out.add(v.trim()) }
  const walk = (v: unknown, key = ''): void => { if (typeof v === 'string') { if (/token|key|secret|password|passwd/i.test(key)) add(v) } else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, Array.isArray(v) ? key : k)) }
  for (const f of Array.isArray(files) ? files : []) {
    let text: string
    try { text = readFileSync(String(f), 'utf8') } catch { continue }
    try { walk(JSON.parse(text)); continue } catch { /* not JSON */ }
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    if (lines.length && lines.every(l => /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l))) lines.forEach(l => add(l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')))
    else add(text)
  }
  return [...out].sort((a, b) => b.length - a.length)
}
const masked = (text: string, values: string[]) => values.reduce((t, v) => t.split(v).join('***'), redact(text))

export async function ioEntries(exec: ExecStore, ws: Workspace, ref: RunRef, attempt?: string, line?: number) {
  if (!attempt) return { attempt: '', line: 0, entries: [] }
  const a = exec.attemptRow(attempt)
  if (!a || a.workspace !== ws.shared.reg.id || a.workflow !== ref.workflow || a.run !== ref.run) throw new RequestError(404, `attempt ${attempt} is not an attempt of run ${ref.workflow}/${ref.run} on this host`)
  if (!a.log) throw new RequestError(404, `attempt ${attempt} kept no log`)
  if (!line || !Number.isInteger(line) || line < 1) throw new RequestError(400, 'line is a positive line number of the attempt\'s log')
  const values = secretValues(exec.ctx.area)
  const entries = (await entryAt(a.log, line).catch(() => { throw new RequestError(404, `the log of attempt ${attempt} is not readable on this host`) }))
    .map(e => ({ line: e.line, kind: e.kind, head: masked(e.head, values), ...(e.body !== undefined ? { body: masked(e.body, values) } : {}) }))
  return { attempt, line, entries }
}
