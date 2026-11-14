// The catalog (user_catalog p1, docs/mycatalog.md): a user's repository
// <owner>/mycatalog. Braindumps (free text: what is wanted and why) with their
// reviews, the summonplans that make them concrete in an installation, and the
// projects the user shares. Shared by the service, the CLI and the browser:
// the shapes, reading plain data (parsed YAML) into them, and the validation.
// Reading YAML text is server/yamlDoc.ts. Free text stays free; YAML is checked.
import { ID_PATTERN, type Issue, type ShapeIssue } from './model.ts'

export const MYCATALOG_SCHEMA = 'ag.mycatalog.v1'
export const SUMMONPLAN_SCHEMA = 'ag.summonplan.v1'
export const PROJECTS_SCHEMA = 'ag.projects.v1'
export const CATALOG_REPOSITORY = 'mycatalog' // the fixed repository name, under its user
// A user's published catalog is <STYLE_HOST>/<user>/mycatalog: naming a GitHub
// user is enough to import that user's development style (wfe summon style).
export const STYLE_HOST = 'https://github.com'
export const GITHUB_USER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
export const styleCatalogOf = (user: string) => `${STYLE_HOST}/${user}/${CATALOG_REPOSITORY}`
// The marker file is mycatalog.yaml, not catalog.yaml: a reader of the old
// layout that finds a catalog.yaml expects the project list and must fail clearly.
export const CATALOG_FILE = 'mycatalog.yaml'
export const PROJECTS_PATH = 'projects.yaml'
export const BRAINDUMP_DIR = 'braindumps'
export const EPISODES_DIR = 'braindumps/episodes'
export const BRAINDUMP_FILE = 'braindump.md'
export const REVIEW_FILE = 'review.md'
export const SUMMONPLAN_DIR = 'summonplans'
// user_catalog p2: the owner's challenges live in the catalog (challenges/<id>/…,
// docs/challenges.md), and challenges.md at the root is the index of what is not
// yet real: braindumps not carried out and challenges not resolved. An agent
// writes the index; the core stores and shows it and reads nothing from it.
export const CHALLENGES_DIR = 'challenges'
export const INDEX_PATH = 'challenges.md'
export const PUBLICATION_CONTRACT = 'publication/github.toml'
// The layout before user_catalog p1; never read, only recognized (wfe catalog migrate).
export const OLD_LAYOUT = { marker: 'mind.yaml', schema: 'ag.mind.v1', projects: 'catalog.yaml', projectsSchema: 'ag.catalog.v1' } as const
export const OLD_LAYOUT_PROBLEM = 'an old layout (mind.yaml, catalog.yaml, braindumps/<slug>.md): run `wfe catalog migrate`'

// The one rule for braindumps: any braindump.md under braindumps/episodes/, at
// any depth, is a braindump. Its folder path below braindumps/episodes/ is its
// identity; a review.md beside it is its review. Every other file there is the
// owner's and is not read. Moving a folder makes a different braindump.
export const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/
export const MAX_BRAINDUMP_DEPTH = 8
export const PLAN_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/
export const isBraindumpId = (id: string): boolean => {
  const segs = id.split('/')
  return segs.length <= MAX_BRAINDUMP_DEPTH && segs.every(s => SEGMENT_PATTERN.test(s))
}
export const braindumpPath = (id: string) => `${EPISODES_DIR}/${id}/${BRAINDUMP_FILE}`
export const reviewPath = (id: string) => `${EPISODES_DIR}/${id}/${REVIEW_FILE}`
export const summonplanPath = (name: string) => `${SUMMONPLAN_DIR}/${name}.yaml`
// braindumps/episodes/<id>/braindump.md → <id>; anything else → null.
export const braindumpIdOfPath = (path: string): string | null => {
  const pre = `${EPISODES_DIR}/`, post = `/${BRAINDUMP_FILE}`
  if (!path.startsWith(pre) || !path.endsWith(post) || path.length <= pre.length + post.length) return null
  const id = path.slice(pre.length, -post.length)
  return isBraindumpId(id) ? id : null
}

// Roles the core needs someone to fill (docs/mycatalog.md, "Roles"). A workflow
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

export interface CatalogDoc { schema: string; owner: string; title: string }

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
export interface SharedProject { project: string; source: string; commit?: string; description: string; because: string[]; roles: Record<string, string | true> }
export interface ProjectsDoc { schema: string; owner: string; projects: SharedProject[] }

// A braindump as read: free Markdown. Its title is the first-level heading on
// its first line, otherwise its identity.
export interface Braindump { id: string; path: string; title: string; text: string }
export function braindumpTitle(id: string, text: string): string {
  const m = /^#\s+(.+?)\s*#*\s*$/.exec(text.split('\n', 1)[0] ?? '')
  return m ? m[1] : id
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

export function mycatalogFromData(raw: unknown): { catalog: CatalogDoc; issues: ShapeIssue[] } {
  const issues: ShapeIssue[] = []
  const r = top(raw, issues)
  if (!r) return { catalog: { schema: '', owner: '', title: '' }, issues }
  return { catalog: { schema: text(r, 'schema', '$', issues), owner: text(r, 'owner', '$', issues), title: text(r, 'title', '$', issues) }, issues }
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

export function projectsFromData(raw: unknown): { projects: ProjectsDoc; issues: ShapeIssue[] } {
  const issues: ShapeIssue[] = []
  const doc: ProjectsDoc = { schema: '', owner: '', projects: [] }
  const r = top(raw, issues)
  if (!r) return { projects: doc, issues }
  doc.schema = text(r, 'schema', '$', issues)
  doc.owner = text(r, 'owner', '$', issues)
  const ps = r.projects === undefined || r.projects === null ? [] : Array.isArray(r.projects) ? r.projects : (issues.push({ path: '$.projects', message: 'expected a sequence' }), [])
  ps.forEach((e, i) => {
    const p = `$.projects[${i}]`
    if (!isRecord(e)) { issues.push({ path: p, message: 'expected a mapping' }); return }
    const commit = text(e, 'commit', p, issues)
    doc.projects.push({ project: text(e, 'project', p, issues), source: text(e, 'source', p, issues), description: text(e, 'description', p, issues), because: texts(e, 'because', p, issues), roles: rolesFrom(e, p, issues), ...(commit ? { commit } : {}) })
  })
  return { projects: doc, issues }
}

// ---- validation ------------------------------------------------------------------

const err = (code: string, message: string, field?: string): Issue => ({ severity: 'error', code, message, ...(field ? { field } : {}) })
const warn = (code: string, message: string, field?: string): Issue => ({ severity: 'warning', code, message, ...(field ? { field } : {}) })

// What the repository offers to resolve references against.
export interface CatalogRefs { braindumps?: string[] /* paths present, e.g. braindumps/episodes/x/braindump.md */ }

export function validateMycatalog(m: CatalogDoc): Issue[] {
  const issues: Issue[] = []
  if (m.schema !== MYCATALOG_SCHEMA) issues.push(err('schema', m.schema ? `Unsupported schema "${m.schema}"; expected ${MYCATALOG_SCHEMA}.` : `Missing schema; expected ${MYCATALOG_SCHEMA}.`, 'schema'))
  if (!m.owner.trim()) issues.push(err('owner-missing', 'owner (the user this catalog belongs to) is missing.', 'owner'))
  if (!m.title.trim()) issues.push(warn('title-missing', 'title is empty.', 'title'))
  return issues
}

// A source is any Git URL: http(s), ssh, git, scp-like or a local path.
const looksLikeGitUrl = (s: string) => /^(https?|ssh|git|file):\/\/\S+$/.test(s) || /^[\w.-]+@[\w.-]+:\S+$/.test(s) || /^\/\S+$/.test(s)

function becauseIssues(because: string[], at: string, ctx: CatalogRefs): Issue[] {
  const issues: Issue[] = []
  because.forEach(b => {
    if (braindumpIdOfPath(b) === null) issues.push(err('because-path', `${at}: because "${b}" is not ${EPISODES_DIR}/<path>/${BRAINDUMP_FILE}.`, 'because'))
    else if (ctx.braindumps && !ctx.braindumps.includes(b)) issues.push(err('because-missing', `${at}: because "${b}" does not exist in the catalog.`, 'because'))
  })
  if (new Set(because).size !== because.length) issues.push(warn('because-duplicate', `${at}: because lists a braindump twice.`, 'because'))
  return issues
}

export function validateSummonplan(p: Summonplan, ctx: CatalogRefs = {}, fileName?: string): Issue[] {
  const issues: Issue[] = []
  if (p.schema !== SUMMONPLAN_SCHEMA) issues.push(err('schema', p.schema ? `Unsupported schema "${p.schema}"; expected ${SUMMONPLAN_SCHEMA}.` : `Missing schema; expected ${SUMMONPLAN_SCHEMA}.`, 'schema'))
  if (!PLAN_NAME_PATTERN.test(p.name)) issues.push(err('name-invalid', `name "${p.name}" must match ${PLAN_NAME_PATTERN.source}.`, 'name'))
  else if (fileName && fileName !== p.name) issues.push(err('name-file', `name "${p.name}" differs from its file name "${fileName}".`, 'name'))
  if (!p.intent.trim()) issues.push(warn('intent-missing', 'intent is empty.', 'intent'))
  if (!p.grounds) issues.push(warn('grounds-missing', 'grounds (the catalog commit the plan was written against) is missing.', 'grounds'))
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

// The shape of each role value; filling a role twice is the plan's concern (projects.yaml may offer alternatives).
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

export function validateProjects(c: ProjectsDoc, ctx: CatalogRefs = {}): Issue[] {
  const issues: Issue[] = []
  if (c.schema !== PROJECTS_SCHEMA) issues.push(err('schema', c.schema ? `Unsupported schema "${c.schema}"; expected ${PROJECTS_SCHEMA}.` : `Missing schema; expected ${PROJECTS_SCHEMA}.`, 'schema'))
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

// ---- the published part (user_catalog p2) -------------------------------------------

// What publication/github.toml (agdev.publication.v1, docs/external-publication.md)
// selects from the source: [[file]] from = "source:<path>" and [[tree]] from =
// "source:<dir>" minus its exclude globs. Only those keys are read here; the
// publication tool is the authority on the contract.
export interface PublicationSelection { destination: string; files: { public: string; from: string }[]; trees: { public: string; from: string; exclude: string[] }[] }

export function readPublicationContract(text: string): PublicationSelection {
  const out: PublicationSelection = { destination: '', files: [], trees: [] }
  let cur: Record<string, unknown> | null = null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const table = /^\[\[?([A-Za-z0-9_.-]+)\]?\]/.exec(line)
    if (table) {
      cur = {}
      if (line.startsWith('[[file]]')) out.files.push(cur as never)
      else if (line.startsWith('[[tree]]')) out.trees.push(Object.assign(cur, { exclude: [] }) as never)
      continue
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2]
    // An array may span lines: read to its closing bracket.
    if (value.startsWith('[')) while (!/\]\s*(#.*)?$/.test(value) && i + 1 < lines.length) value += ` ${lines[++i].trim()}`
    const strings = [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(m => m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2])
    const v: unknown = value.startsWith('[') ? strings : strings[0] ?? ''
    if (cur) cur[kv[1]] = v
    else if (kv[1] === 'destination' && typeof v === 'string') out.destination = v
  }
  const src = (from: unknown) => typeof from === 'string' && from.startsWith('source:') ? from.slice(7).replace(/^\/+|\/+$/g, '') : null
  return {
    destination: out.destination,
    files: out.files.flatMap(f => src(f.from) !== null && typeof f.public === 'string' ? [{ public: f.public, from: src(f.from)! }] : []),
    trees: out.trees.flatMap(t => src(t.from) !== null ? [{ public: typeof t.public === 'string' ? t.public.replace(/^\.?\/+|\/+$/g, '').replace(/^\.$/, '') : '', from: src(t.from)!, exclude: Array.isArray(t.exclude) ? t.exclude.filter((x): x is string => typeof x === 'string') : [] }] : []),
  }
}

// A glob as the publication tool reads it: `*` crosses "/"; a glob that
// matches a directory excludes everything below it.
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
const excluded = (rel: string, patterns: string[]) => patterns.some(p => globRe(p).test(rel) || globRe(`${p.replace(/\/+$/, '')}/*`).test(rel))

// The public path of each source path the contract selects (source path → public path).
export function publishedPaths(sel: PublicationSelection, sourcePaths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const present = new Set(sourcePaths)
  for (const f of sel.files) if (present.has(f.from)) out.set(f.from, f.public)
  for (const t of sel.trees) for (const p of sourcePaths) {
    if (t.from && !p.startsWith(`${t.from}/`)) continue
    if (p === '.gitmodules' || p.startsWith('publication/')) continue
    const rel = t.from ? p.slice(t.from.length + 1) : p
    if (!excluded(rel, t.exclude)) out.set(p, t.public ? `${t.public}/${rel}` : rel)
  }
  return out
}
