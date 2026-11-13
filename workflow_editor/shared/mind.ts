// The mind repository (summoner p1, docs/mind.md): the braindumps that ground
// an installation's projects, the summonplans that make them concrete, and the
// catalog of projects a user shares. Shared by the service, the CLI and the
// browser: the shapes, reading plain data (parsed YAML) into them, and the
// validation. Reading YAML text is server/yamlDoc.ts.
import { ID_PATTERN, type Issue, type ShapeIssue } from './model.ts'

export const MIND_SCHEMA = 'ag.mind.v1'
export const SUMMONPLAN_SCHEMA = 'ag.summonplan.v1'
export const PROJECT_CATALOG_SCHEMA = 'ag.catalog.v1'
export const MIND_REPOSITORY = 'agdev-mind' // the fixed repository name, under its user
export const MIND_FILE = 'mind.yaml'
export const CATALOG_PATH = 'catalog.yaml'
export const BRAINDUMP_DIR = 'braindumps'
export const SUMMONPLAN_DIR = 'summonplans'

// A braindump's identity is its file name: braindumps/<slug>.md.
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const PLAN_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/
export const braindumpPath = (slug: string) => `${BRAINDUMP_DIR}/${slug}.md`
export const summonplanPath = (name: string) => `${SUMMONPLAN_DIR}/${name}.yaml`
export const slugOfPath = (path: string): string | null => {
  const m = /^braindumps\/([^/]+)\.md$/.exec(path)
  return m && SLUG_PATTERN.test(m[1]) ? m[1] : null
}

// Roles the core needs someone to fill (docs/mind.md, "Roles"). A workflow
// role names the workflow of the entry's project that fills it; a project
// role is filled by the project as a whole (`true`). Consumed from phase 2.
export const ROLES = {
  recovery: { kind: 'workflow', what: 'recovers runs the observer finds stuck or failed' },
  coordination: { kind: 'workflow', what: 'coordinates runs across workers and projects' },
  facilitation: { kind: 'workflow', what: 'conducts facilitated conversations' },
  'conversation-archive': { kind: 'project', what: 'holds archived conversations' },
  'conversation-page': { kind: 'project', what: 'serves the conversation page (/hangout/)' },
  'dialogue-renderer': { kind: 'project', what: 'renders character dialogue lines' },
} as const satisfies Record<string, { kind: 'workflow' | 'project'; what: string }>
export type RoleName = keyof typeof ROLES
export const ROLE_NAMES = Object.keys(ROLES) as RoleName[]

// adopted: already present in the installation, described after the fact;
// summoned: to be obtained from `source` at `commit` (apply, phase 2).
export const ENTRY_STATES = ['adopted', 'summoned'] as const
export type EntryState = typeof ENTRY_STATES[number]

export interface MindDoc { schema: string; owner: string; title: string }

export interface SummonEntry {
  project: string
  source: string
  commit: string
  because: string[]
  roles: Record<string, string | true>
  state: string
  note?: string
}
export interface Summonplan {
  schema: string
  name: string
  intent: string
  grounds: string
  entries: SummonEntry[]
}

// `roles`: the core roles the project can fill, in a plan entry's shape (a summoner copies it into a plan).
export interface CatalogProject { project: string; source: string; commit?: string; description: string; because: string[]; roles: Record<string, string | true> }
export interface ProjectCatalog { schema: string; owner: string; projects: CatalogProject[] }

// A braindump as read: free Markdown; an optional first-level heading is its title.
export interface Braindump { slug: string; path: string; title: string; text: string }
export function braindumpTitle(slug: string, text: string): string {
  const first = text.split('\n').find(l => l.trim() !== '')
  const m = first && /^#\s+(.+?)\s*#*\s*$/.exec(first)
  return m ? m[1] : slug
}
// The first lines after the title, for listings.
export function braindumpExcerpt(text: string, chars = 480): string {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trim() !== '')
  const body = (start >= 0 && /^#\s/.test(lines[start]) ? lines.slice(start + 1) : lines).join('\n').trim()
  return body.length > chars ? `${body.slice(0, chars).trimEnd()}…` : body
}

// ---- reading plain data --------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
function text(raw: Record<string, unknown>, key: string, path: string, issues: ShapeIssue[]): string {
  const v = raw[key]
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  issues.push({ path: `${path}.${key}`, message: 'expected text' })
  return String(v)
}
function texts(raw: Record<string, unknown>, key: string, path: string, issues: ShapeIssue[]): string[] {
  const v = raw[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) { issues.push({ path: `${path}.${key}`, message: 'expected a sequence' }); return [] }
  return v.flatMap((x, i) => typeof x === 'string' ? [x] : (issues.push({ path: `${path}.${key}[${i}]`, message: 'expected text' }), []))
}
const top = (raw: unknown, issues: ShapeIssue[]): Record<string, unknown> | null => {
  if (isRecord(raw)) return raw
  issues.push({ path: '$', message: raw === null || raw === undefined ? 'empty document' : 'top level must be a mapping' })
  return null
}

export function mindFromData(raw: unknown): { mind: MindDoc; issues: ShapeIssue[] } {
  const issues: ShapeIssue[] = []
  const r = top(raw, issues)
  if (!r) return { mind: { schema: '', owner: '', title: '' }, issues }
  return { mind: { schema: text(r, 'schema', '$', issues), owner: text(r, 'owner', '$', issues), title: text(r, 'title', '$', issues) }, issues }
}

export function summonplanFromData(raw: unknown): { plan: Summonplan; issues: ShapeIssue[] } {
  const issues: ShapeIssue[] = []
  const plan: Summonplan = { schema: '', name: '', intent: '', grounds: '', entries: [] }
  const r = top(raw, issues)
  if (!r) return { plan, issues }
  plan.schema = text(r, 'schema', '$', issues)
  plan.name = text(r, 'name', '$', issues)
  plan.intent = text(r, 'intent', '$', issues)
  plan.grounds = text(r, 'grounds', '$', issues)
  const entries = r.entries === undefined || r.entries === null ? [] : Array.isArray(r.entries) ? r.entries : (issues.push({ path: '$.entries', message: 'expected a sequence' }), [])
  entries.forEach((e, i) => {
    const p = `$.entries[${i}]`
    if (!isRecord(e)) { issues.push({ path: p, message: 'expected a mapping' }); return }
    const roles = rolesFrom(e, p, issues)
    plan.entries.push({
      project: text(e, 'project', p, issues), source: text(e, 'source', p, issues), commit: text(e, 'commit', p, issues),
      because: texts(e, 'because', p, issues), roles, state: text(e, 'state', p, issues),
      ...(e.note !== undefined && e.note !== null ? { note: text(e, 'note', p, issues) } : {}),
    })
  })
  return { plan, issues }
}

function rolesFrom(e: Record<string, unknown>, p: string, issues: ShapeIssue[]): Record<string, string | true> {
  const roles: Record<string, string | true> = {}
  if (e.roles !== undefined && e.roles !== null) {
    if (!isRecord(e.roles)) issues.push({ path: `${p}.roles`, message: 'expected a mapping {<role>: <workflow> | true}' })
    else for (const [k, v] of Object.entries(e.roles)) {
      if (typeof v === 'string' || v === true) roles[k] = v
      else issues.push({ path: `${p}.roles.${k}`, message: 'expected a workflow id or true' })
    }
  }
  return roles
}

export function catalogFromData(raw: unknown): { catalog: ProjectCatalog; issues: ShapeIssue[] } {
  const issues: ShapeIssue[] = []
  const catalog: ProjectCatalog = { schema: '', owner: '', projects: [] }
  const r = top(raw, issues)
  if (!r) return { catalog, issues }
  catalog.schema = text(r, 'schema', '$', issues)
  catalog.owner = text(r, 'owner', '$', issues)
  const ps = r.projects === undefined || r.projects === null ? [] : Array.isArray(r.projects) ? r.projects : (issues.push({ path: '$.projects', message: 'expected a sequence' }), [])
  ps.forEach((e, i) => {
    const p = `$.projects[${i}]`
    if (!isRecord(e)) { issues.push({ path: p, message: 'expected a mapping' }); return }
    const commit = text(e, 'commit', p, issues)
    catalog.projects.push({ project: text(e, 'project', p, issues), source: text(e, 'source', p, issues), description: text(e, 'description', p, issues), because: texts(e, 'because', p, issues), roles: rolesFrom(e, p, issues), ...(commit ? { commit } : {}) })
  })
  return { catalog, issues }
}

// ---- validation ------------------------------------------------------------------

const err = (code: string, message: string, field?: string): Issue => ({ severity: 'error', code, message, ...(field ? { field } : {}) })
const warn = (code: string, message: string, field?: string): Issue => ({ severity: 'warning', code, message, ...(field ? { field } : {}) })

// What the repository offers to resolve references against.
export interface MindContext { braindumps?: string[] /* paths present, e.g. braindumps/x.md */ }

export function validateMind(m: MindDoc): Issue[] {
  const issues: Issue[] = []
  if (m.schema !== MIND_SCHEMA) issues.push(err('schema', m.schema ? `Unsupported schema "${m.schema}"; expected ${MIND_SCHEMA}.` : `Missing schema; expected ${MIND_SCHEMA}.`, 'schema'))
  if (!m.owner.trim()) issues.push(err('owner-missing', 'owner (the user this mind belongs to) is missing.', 'owner'))
  if (!m.title.trim()) issues.push(warn('title-missing', 'title is empty.', 'title'))
  return issues
}

// A source is any Git URL: http(s), ssh, git, scp-like or a local path.
const looksLikeGitUrl = (s: string) => /^(https?|ssh|git|file):\/\/\S+$/.test(s) || /^[\w.-]+@[\w.-]+:\S+$/.test(s) || /^\/\S+$/.test(s)

function becauseIssues(because: string[], at: string, ctx: MindContext): Issue[] {
  const issues: Issue[] = []
  because.forEach(b => {
    if (slugOfPath(b) === null) issues.push(err('because-path', `${at}: because "${b}" is not braindumps/<slug>.md.`, 'because'))
    else if (ctx.braindumps && !ctx.braindumps.includes(b)) issues.push(err('because-missing', `${at}: because "${b}" does not exist in the mind repository.`, 'because'))
  })
  if (new Set(because).size !== because.length) issues.push(warn('because-duplicate', `${at}: because lists a braindump twice.`, 'because'))
  return issues
}

export function validateSummonplan(p: Summonplan, ctx: MindContext = {}, fileName?: string): Issue[] {
  const issues: Issue[] = []
  if (p.schema !== SUMMONPLAN_SCHEMA) issues.push(err('schema', p.schema ? `Unsupported schema "${p.schema}"; expected ${SUMMONPLAN_SCHEMA}.` : `Missing schema; expected ${SUMMONPLAN_SCHEMA}.`, 'schema'))
  if (!PLAN_NAME_PATTERN.test(p.name)) issues.push(err('name-invalid', `name "${p.name}" must match ${PLAN_NAME_PATTERN.source}.`, 'name'))
  else if (fileName && fileName !== p.name) issues.push(err('name-file', `name "${p.name}" differs from its file name "${fileName}".`, 'name'))
  if (!p.intent.trim()) issues.push(warn('intent-missing', 'intent is empty.', 'intent'))
  if (!p.grounds) issues.push(warn('grounds-missing', 'grounds (the mind commit the plan was written against) is missing.', 'grounds'))
  else if (!COMMIT_PATTERN.test(p.grounds)) issues.push(err('grounds-shape', `grounds "${p.grounds}" is not a full commit id.`, 'grounds'))
  const seen = new Set<string>()
  const filled = new Map<string, string>()
  p.entries.forEach((e, i) => {
    const at = e.project ? `entry "${e.project}"` : `entries[${i}]`
    if (!e.project) issues.push(err('project-missing', `${at}: project is missing.`, 'project'))
    else if (!ID_PATTERN.test(e.project)) issues.push(err('project-invalid', `${at}: project must match ${ID_PATTERN.source}.`, 'project'))
    else if (seen.has(e.project)) issues.push(err('project-duplicate', `${at}: the project is listed twice.`, 'project'))
    seen.add(e.project)
    if (!e.source) issues.push(err('source-missing', `${at}: source (a Git URL) is missing.`, 'source'))
    else if (!looksLikeGitUrl(e.source)) issues.push(err('source-shape', `${at}: source "${e.source}" is not a Git URL.`, 'source'))
    if (!(ENTRY_STATES as readonly string[]).includes(e.state)) issues.push(err('state', `${at}: state "${e.state}" is not one of ${ENTRY_STATES.join(', ')}.`, 'state'))
    if (!e.commit) issues.push((e.state === 'adopted' ? warn : err)('commit-missing', `${at}: commit is missing; ${e.state === 'adopted' ? 'an adopted entry still says which revision was described' : 'apply needs an exact revision'}.`, 'commit'))
    else if (!COMMIT_PATTERN.test(e.commit)) issues.push(err('commit-shape', `${at}: commit "${e.commit}" is not a full commit id.`, 'commit'))
    issues.push(...becauseIssues(e.because, at, ctx))
    issues.push(...roleIssues(e.roles, at))
    for (const role of Object.keys(e.roles)) {
      if (!(role in ROLES)) continue
      const other = filled.get(role)
      if (other) issues.push(err('role-twice', `${at}: role "${role}" is already filled by "${other}".`, 'roles'))
      else filled.set(role, e.project)
    }
  })
  return issues
}

// The shape of each role value; filling a role twice is the plan's concern (a catalog may offer alternatives).
function roleIssues(roles: Record<string, string | true>, at: string): Issue[] {
  const issues: Issue[] = []
  for (const [role, v] of Object.entries(roles)) {
    const def = (ROLES as Record<string, { kind: string }>)[role]
    if (!def) { issues.push(err('role-unknown', `${at}: role "${role}" is not known (${ROLE_NAMES.join(', ')}).`, 'roles')); continue }
    if (def.kind === 'workflow' && (typeof v !== 'string' || !ID_PATTERN.test(v))) issues.push(err('role-value', `${at}: role "${role}" names the workflow that fills it.`, 'roles'))
    if (def.kind === 'project' && v !== true) issues.push(err('role-value', `${at}: role "${role}" is filled by the project as a whole: write true.`, 'roles'))
  }
  return issues
}

export function validateCatalog(c: ProjectCatalog, ctx: MindContext = {}): Issue[] {
  const issues: Issue[] = []
  if (c.schema !== PROJECT_CATALOG_SCHEMA) issues.push(err('schema', c.schema ? `Unsupported schema "${c.schema}"; expected ${PROJECT_CATALOG_SCHEMA}.` : `Missing schema; expected ${PROJECT_CATALOG_SCHEMA}.`, 'schema'))
  if (!c.owner.trim()) issues.push(err('owner-missing', 'owner is missing.', 'owner'))
  const seen = new Set<string>()
  c.projects.forEach((e, i) => {
    const at = e.project ? `project "${e.project}"` : `projects[${i}]`
    if (!ID_PATTERN.test(e.project)) issues.push(err('project-invalid', `${at}: project must match ${ID_PATTERN.source}.`, 'project'))
    else if (seen.has(e.project)) issues.push(err('project-duplicate', `${at}: listed twice.`, 'project'))
    seen.add(e.project)
    if (!looksLikeGitUrl(e.source)) issues.push(err('source-shape', `${at}: source "${e.source}" is not a Git URL.`, 'source'))
    if (e.commit && !COMMIT_PATTERN.test(e.commit)) issues.push(err('commit-shape', `${at}: commit "${e.commit}" is not a full commit id.`, 'commit'))
    if (!e.description.trim()) issues.push(warn('description-missing', `${at}: description is empty.`, 'description'))
    issues.push(...becauseIssues(e.because, at, ctx))
    issues.push(...roleIssues(e.roles, at))
  })
  return issues
}
