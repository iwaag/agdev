// Reading an attempt's IO (p10 step 4): what its harness output recorded —
// the agent's public messages, tool calls and their results, and the
// attempts' lifecycle — one entry at a time, redacted, for the full-output
// view (`wfe run io`, GET …/io). Output only.
//
// The source is each attempt's own log (the agent's stdout, written by the
// execution host at <area>/.local/exec/logs/<attempt>.jsonl; server/activity.ts
// reads the same files). (Until cluster_teamwork p5 these entries were also
// copied to a Zulip channel per run; that copy is retired.)
//
// What is never shown: model reasoning (`thinking` blocks — they are not
// public output), the harness's configuration (its init event beyond the
// session, model and version), rate-limit and token-accounting events, and
// anything the redaction below recognizes as a credential.
import { readFile } from 'node:fs/promises'

// ---- redaction ----------------------------------------------------------------------------

const PATTERNS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-***'],
  [/\bsk-[A-Za-z0-9]{20,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, 'glpat-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt ***>'],
  [/(\b[Bb]earer\s+)[A-Za-z0-9._~+/=-]{12,}/g, '$1***'],
  [/(\b[Bb]asic\s+)[A-Za-z0-9+/=]{12,}/g, '$1***'],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1***@'],
  [/((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|credentials?)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1***'],
]
// Credentials recognized by their shape, masked wherever they appear.
export const redact = (text: string): string => PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text)

// ---- reading a log -----------------------------------------------------------------------

// One entry of an attempt's IO: a line of its log (stream-json events
// become a heading and an optional body; other formats are raw text).
export interface IoEntry { line: number; kind: 'session' | 'text' | 'tool' | 'result' | 'end' | 'note' | 'raw'; head: string; body?: string; error?: boolean }
// What the reader keeps while reading a log: tool names by call id, so a
// result names the call it answers.
export interface ReaderState { tools: Record<string, string>; format: 'stream-json' | 'other' | null }

const toolSummary = (name: string, input: Record<string, unknown>) => {
  const pick = input.command ?? input.description ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.prompt
  const words = typeof pick === 'string' ? pick : JSON.stringify(input)
  return { head: `→ ${name}`, body: words }
}
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : (c && typeof c === 'object' && (c as { type?: string }).type === 'image' ? '[image]' : ''))).filter(Boolean).join('\n')
  return ''
}

export function entriesOf(lines: { n: number; text: string }[], st: ReaderState): IoEntry[] {
  const out: IoEntry[] = []
  for (const { n, text } of lines) {
    const t = text.trim()
    if (!t) continue
    let ev: Record<string, unknown> | null = null
    try { const v = JSON.parse(t); ev = v && typeof v === 'object' && !Array.isArray(v) ? v : null } catch { ev = null }
    if (st.format === null) st.format = ev && typeof ev.type === 'string' ? 'stream-json' : 'other'
    if (st.format !== 'stream-json' || !ev) { out.push({ line: n, kind: 'raw', head: '', body: text }); continue }
    if (ev.type === 'system' && ev.subtype === 'init') {
      out.push({ line: n, kind: 'session', head: `session ${String(ev.session_id ?? '?')} started — ${String(ev.model ?? 'model ?')}${ev.claude_code_version ? `, Claude Code ${String(ev.claude_code_version)}` : ''}` })
    } else if (ev.type === 'assistant' || ev.type === 'user') {
      const content = (ev.message as { content?: unknown } | undefined)?.content
      for (const c of Array.isArray(content) ? content as Record<string, unknown>[] : []) {
        if (c.type === 'text' && ev.type === 'assistant' && String(c.text ?? '').trim()) out.push({ line: n, kind: 'text', head: '', body: String(c.text) })
        else if (c.type === 'tool_use') {
          st.tools[String(c.id)] = String(c.name ?? '?')
          const s = toolSummary(String(c.name ?? '?'), (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>)
          out.push({ line: n, kind: 'tool', head: s.head, body: s.body })
        } else if (c.type === 'tool_result') {
          const name = st.tools[String(c.tool_use_id)] ?? 'tool'
          delete st.tools[String(c.tool_use_id)]
          out.push({ line: n, kind: 'result', head: `← ${name}${c.is_error ? ' (error)' : ''}`, body: textOf(c.content), error: !!c.is_error })
        }
        // `thinking` and `redacted_thinking` blocks are the model's reasoning, not public output.
      }
    } else if (ev.type === 'result') {
      const cost = typeof ev.total_cost_usd === 'number' ? `, $${ev.total_cost_usd.toFixed(2)}` : ''
      const turns = typeof ev.num_turns === 'number' ? `, ${ev.num_turns} turns` : ''
      const dur = typeof ev.duration_ms === 'number' ? `, ${Math.round(ev.duration_ms / 1000)} s` : ''
      out.push({ line: n, kind: 'end', head: `session ended: ${String(ev.subtype ?? '?')}${ev.is_error ? ' (error)' : ''}${turns}${dur}${cost}`, error: !!ev.is_error })
    } else if (ev.type === 'system' && ev.subtype === 'task_notification') {
      out.push({ line: n, kind: 'note', head: `background task ${String(ev.status ?? '')}: ${String(ev.summary ?? ev.description ?? '')}`.trim() })
    }
    // rate_limit_event, thinking_tokens and other bookkeeping are not output.
  }
  return out
}

// One entry in full, for the full-output view (`wfe run io`, GET …/io).
export async function entryAt(path: string, n: number): Promise<IoEntry[]> {
  const text = await readFile(path, 'utf8')
  const all = text.split('\n')
  const st: ReaderState = { tools: {}, format: null }
  // Tool names come from earlier lines: read up to n.
  const entries = entriesOf(all.slice(0, n).map((t, i) => ({ n: i + 1, text: t })), st)
  return entries.filter(e => e.line === n)
}
