// Rules the owner adopted from their own words (user_catalog p7, p8;
// docs/mycatalog.md *Rules*).
//
// A rule is one sentence of a braindump made binding by the owner: `rules.yaml`
// at the catalog's root (ag.catalog-rules.v2; v1 is read too) says what it is
// about, what follows, the sentence with its braindump and commit, and who
// adopted it when. Reading a sentence activates nothing. Three kinds:
//
//   tag rule      (p7) a tag of the owner's conventions (a braindump tagged
//                 mybraindump): never-publish, the public list cannot select a
//                 braindump so tagged or its review; suggest-publish, such a
//                 braindump not in the public list is offered for it
//   project rule  (p8) what a braindump states about a project's disclosure:
//                 never-publish, no tool of this installation publishes the
//                 project (agdev-external-publish refuses it, the publisher
//                 declines it); publish, the project is to be published and
//                 the owner may ask the publisher for it
//   licence rule  (p8) default-licence: the licence of a project's first
//                 publication, from the owner's words; share: never, it is the
//                 owner's own preference and is not part of a style others import
//
// Both statements on one braindump or project: never-publish wins. A rule
// whose source braindump changed since it was adopted stays in force and is
// marked. A project rule proposed by the summoner and not yet answered is kept
// with the link suggestion (server/catalogLinks.ts): a proposed never-publish
// already refuses, a proposed publish does nothing.
//
//   content rule  (improve_publish p2) what a braindump states about a kind of
//                 content (runs, workflows, episodes), optionally of one project:
//                 suggest-publish, the sentence is the criterion the publisher
//                 reads (it selects nothing); never-publish, the publication tool
//                 refuses a contract that selects that content. One project's rule
//                 decides over a general one; never-publish wins between equals.
//                 Without a rule, run records and episodes stay local.
//
// improve_publish p1: `share: never` on any rule keeps it in this installation
// (neither published nor offered by a style import); the public rules.yaml is
// derived by the publication tool (publicRules here is the same reading, for
// `wfe catalog publication status`); and a selected file that names a project
// kept private is refused by the tool unless the contract's [[allow]] with
// found = "private:<id>" records why.
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document } from 'yaml'
import {
  BRAINDUMP_FILE, braindumpPath, braindumpTitle, EPISODES_DIR, globMatch, metadataPath, normalizeTag, PROJECTS_PATH, PUBLICATION_CONTRACT, publishedPaths,
  readPublicationContract, RECOMMENDED_TAG, reviewPath, sameTag,
} from '../shared/catalog.ts'
import { catalogSnapshot, internals, type CatalogContext } from './catalog.ts'
import { readTextOrNull } from './files.ts'
import { git, gitOk } from './git.ts'
import { withLock } from './lock.ts'
import { loadRegistry } from './registry.ts'
import { RequestError } from './workspace.ts'
import { parseSubset, readBraindumpMetadata, STRINGIFY } from './yamlDoc.ts'

export const RULES_PATH = 'rules.yaml'
export const RULES_SCHEMA = 'ag.catalog-rules.v2'
export const RULES_SCHEMAS = ['ag.catalog-rules.v1', RULES_SCHEMA]
export const FOLLOWS = ['never-publish', 'suggest-publish'] as const // of a tag
export const PROJECT_FOLLOWS = ['never-publish', 'publish'] as const
export const LICENCE_FOLLOWS = 'default-licence'
export const CONTENTS = ['runs', 'workflows', 'episodes'] as const
export const CONTENT_FOLLOWS = ['suggest-publish', 'never-publish'] as const
export type Content = typeof CONTENTS[number]
export type Follows = typeof FOLLOWS[number]
export type ProjectFollows = typeof PROJECT_FOLLOWS[number]
export interface RuleSource { braindump: string; commit: string; sentence: string }
export interface Rule { id: string; tag: string; follows: Follows; share?: 'never'; source: RuleSource; adopted: { by: string; at: string } }
export interface ProjectRule { id: string; project: string; follows: ProjectFollows; share?: 'never'; source: RuleSource; adopted: { by: string; at: string } }
export interface ContentRule { id: string; content: Content; project?: string; follows: typeof CONTENT_FOLLOWS[number]; share?: 'never'; source: RuleSource; adopted: { by: string; at: string } }
export interface LicenceRule { id: 'default-licence'; follows: typeof LICENCE_FOLLOWS; licence: string; share: 'never'; source: RuleSource; adopted: { by: string; at: string } }
export type AnyRule = Rule | ProjectRule | LicenceRule | ContentRule
type Body<T> = Omit<T, 'id' | 'adopted'>
export type RuleBody = Body<Rule> | Body<ProjectRule> | Body<LicenceRule> | Body<ContentRule>
// What the page and the CLI read: one flat shape for every kind.
export interface RuleView { id: string; kind: 'tag' | 'project' | 'licence' | 'content'; follows: string; tag?: string; project?: string; licence?: string; content?: string; share?: string; source: RuleSource; adopted: { by: string; at: string }; sourceChanged: boolean; sourceNote?: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => typeof v === 'string' ? v : ''
export const kindOf = (r: AnyRule): RuleView['kind'] => 'content' in r ? 'content' : 'tag' in r ? 'tag' : 'project' in r ? 'project' : 'licence'
export const ruleId = (tag: string, follows: string) => `${tag.toLowerCase()}-${follows}`
export const projectRuleId = (project: string, follows: string) => `project-${project}-${follows}`
export const contentRuleId = (content: string, project: string | undefined, follows: string) => `${content}${project ? `-${project}` : ''}-${follows}`
// White space is compared loosely: a sentence may be wrapped differently than it is quoted.
export const loose = (t: string) => t.replace(/\s+/g, ' ').trim()
export const holds = (text: string, sentence: string) => loose(sentence).length >= 4 && loose(text).includes(loose(sentence))
export const PROJECT_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/
export const LICENCE_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]{1,63}$/

export interface RulesFile { all: AnyRule[]; rules: Rule[]; projects: ProjectRule[]; contents: ContentRule[]; licence: LicenceRule | null; problem?: string }
export function readRules(text: string | null): RulesFile {
  const none: RulesFile = { all: [], rules: [], projects: [], contents: [], licence: null }
  if (text === null || !text.trim()) return none
  const r = parseSubset(text)
  if (!r.ok) return { ...none, problem: r.problem.message }
  const raw = r.doc.toJS() as unknown
  if (!isObj(raw) || !RULES_SCHEMAS.includes(str(raw.schema))) return { ...none, problem: `not ${RULES_SCHEMA}` }
  const out: RulesFile = { all: [], rules: [], projects: [], contents: [], licence: null }
  for (const x of Array.isArray(raw.rules) ? raw.rules : []) {
    if (!isObj(x) || !isObj(x.source)) return { ...none, problem: 'a rule needs its source' }
    const a = isObj(x.adopted) ? x.adopted : {}
    const common = { source: { braindump: str(x.source.braindump), commit: str(x.source.commit), sentence: str(x.source.sentence) }, adopted: { by: str(a.by), at: str(a.at) } }
    if (str(x.follows) === LICENCE_FOLLOWS) {
      if (!LICENCE_ID.test(str(x.licence))) return { ...none, problem: 'a default-licence rule needs its licence (an SPDX id)' }
      const l: LicenceRule = { id: 'default-licence', follows: LICENCE_FOLLOWS, licence: str(x.licence), share: 'never', ...common }
      out.licence = l; out.all.push(l)
    } else if (str(x.content)) {
      // improve_publish p2: before project, a content rule for one project is not a project rule.
      if (!(CONTENTS as readonly string[]).includes(str(x.content))) return { ...none, problem: `a content rule is about ${CONTENTS.join(', ')}; "${str(x.content)}" is none` }
      if (!(CONTENT_FOLLOWS as readonly string[]).includes(str(x.follows))) return { ...none, problem: `a rule on ${str(x.content)} follows suggest-publish or never-publish` }
      const c: ContentRule = { id: str(x.id) || contentRuleId(str(x.content), str(x.project) || undefined, str(x.follows)), content: x.content as Content, ...(str(x.project) ? { project: str(x.project) } : {}), follows: x.follows as ContentRule['follows'], ...(str(x.share) === 'never' ? { share: 'never' as const } : {}), ...common }
      out.contents.push(c); out.all.push(c)
    } else if (str(x.project)) {
      if (!(PROJECT_FOLLOWS as readonly string[]).includes(str(x.follows))) return { ...none, problem: `a rule on project ${str(x.project)} follows never-publish or publish` }
      const p: ProjectRule = { id: str(x.id) || projectRuleId(str(x.project), str(x.follows)), project: str(x.project), follows: x.follows as ProjectFollows, ...(str(x.share) === 'never' ? { share: 'never' as const } : {}), ...common }
      out.projects.push(p); out.all.push(p)
    } else {
      if (!(FOLLOWS as readonly string[]).includes(str(x.follows)) || !str(x.tag)) return { ...none, problem: 'a rule needs tag, follows (never-publish or suggest-publish) and source; or project, follows (never-publish or publish) and source; or follows default-licence, licence and source' }
      const t: Rule = { id: str(x.id) || ruleId(str(x.tag), str(x.follows)), tag: str(x.tag), follows: x.follows as Follows, ...(str(x.share) === 'never' ? { share: 'never' as const } : {}), ...common }
      out.rules.push(t); out.all.push(t)
    }
  }
  return out
}
function writeRules(rules: AnyRule[]): string | null {
  if (!rules.length) return null
  const doc = new Document({ schema: RULES_SCHEMA, rules })
  doc.commentBefore = ` Rules adopted by the owner from their own words (${RULES_SCHEMA}; agdev docs/mycatalog.md, Rules).\n Written with wfe catalog rules adopt | retire, or Do it / OK on the Catalog page.`
  return doc.toString(STRINGIFY)
}

const { commitChanges, checkoutDir, settingFile, needSetting, needId, showAt } = internals
const inCheckout = <T>(ctx: CatalogContext, f: (dir: string) => Promise<T>) => withLock(settingFile(ctx.area), () => f(checkoutDir(ctx.area)), { what: 'the catalog' })

// The sentence a rule is adopted from: in the braindump's text at the commit. Returns the full commit.
async function sourceAt(ctx: CatalogContext, raw: unknown, o: { conventions: boolean }): Promise<RuleSource> {
  const s = isObj(raw) ? raw : {}
  const id = str(s.braindump).trim().replace(/^\/+|\/+$/g, ''), sentence = str(s.sentence).trim()
  needId(id)
  if (loose(sentence).length < 4) throw new RequestError(400, 'a rule needs the sentence of the owner it is adopted from (source.sentence)')
  if (sentence.length > 2000) throw new RequestError(400, 'the sentence is at most 2000 characters')
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  const b = snap.braindumps.find(x => x.id === id)
  if (!b) throw new RequestError(404, `no braindump "${id}" to adopt a rule from`)
  if (o.conventions && !b.tags.some(t => sameTag(t, RECOMMENDED_TAG))) throw new RequestError(409, `braindump "${id}" is not tagged ${RECOMMENDED_TAG}: a tag rule is adopted from the owner's own conventions, which are the braindumps with that tag`)
  return inCheckout(ctx, async dir => {
    const given = str(s.commit) || b.updated?.commit || ''
    if (!/^[0-9a-f]{7,40}$/.test(given)) throw new RequestError(400, 'source.commit is the commit of the braindump the sentence was read at')
    const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${given}^{commit}`])
    if (r.code !== 0) throw new RequestError(404, `the catalog has no commit ${given}`)
    const commit = r.stdout.trim()
    const text = await showAt(dir, commit, braindumpPath(id))
    if (text === null) throw new RequestError(404, `braindump "${id}" does not exist at ${commit.slice(0, 7)}`)
    if (!holds(text, sentence)) throw new RequestError(409, `the sentence is not in braindump "${id}" at ${commit.slice(0, 7)}: copy it from the text as it is written there`)
    return { braindump: id, commit, sentence: loose(sentence) }
  })
}

// The projects a project rule can be about: this installation's plan, projects.yaml, the registry.
export async function knownProjects(ctx: CatalogContext): Promise<string[]> {
  const snap = await catalogSnapshot(ctx)
  const reg = await loadRegistry(ctx.registryFile).catch(() => ({ workspaces: [] as { id: string; project?: string }[] }))
  return [...new Set([
    ...(snap.plans.find(p => p.name === snap.setting.plan)?.plan?.entries ?? []).map(e => e.project),
    ...(snap.projects.doc?.projects ?? []).map(p => p.project),
    ...reg.workspaces.map(w => w.project ?? '').filter(Boolean),
  ])].sort()
}

export type RuleInput = { tag?: unknown; project?: unknown; follows?: unknown; licence?: unknown; content?: unknown; source?: unknown }
// A proposed rule, checked: what it is about, what follows, and its source. Nothing is written.
export async function checkRuleSource(ctx: CatalogContext, o: RuleInput): Promise<RuleBody> {
  const follows = str(o.follows)
  if (follows === LICENCE_FOLLOWS) {
    const licence = str(o.licence).trim()
    if (!LICENCE_ID.test(licence)) throw new RequestError(400, `a default-licence rule names its licence as an SPDX id (for example CC0-1.0); "${licence}" is not one`)
    return { follows: LICENCE_FOLLOWS, licence, share: 'never', source: await sourceAt(ctx, o.source, { conventions: false }) }
  }
  if (str(o.content)) {
    const content = str(o.content).trim(), project = str(o.project).trim()
    if (!(CONTENTS as readonly string[]).includes(content)) throw new RequestError(400, `a content rule is about ${CONTENTS.join(', ')}; "${content}" is none`)
    if (!(CONTENT_FOLLOWS as readonly string[]).includes(follows)) throw new RequestError(400, `what follows for ${content} is one of ${CONTENT_FOLLOWS.join(', ')}; "${follows}" is neither`)
    if (project) {
      if (!PROJECT_ID.test(project)) throw new RequestError(400, `"${project}" is not a project id`)
      if (!(await knownProjects(ctx)).includes(project)) throw new RequestError(404, `no project "${project}" in this installation's plan, ${PROJECTS_PATH} or the registry`)
    }
    return { content: content as Content, ...(project ? { project } : {}), follows: follows as ContentRule['follows'], source: await sourceAt(ctx, o.source, { conventions: false }) }
  }
  if (str(o.project)) {
    const project = str(o.project).trim()
    if (!PROJECT_ID.test(project)) throw new RequestError(400, `"${project}" is not a project id`)
    if (!(PROJECT_FOLLOWS as readonly string[]).includes(follows)) throw new RequestError(400, `what follows for project ${project} is one of ${PROJECT_FOLLOWS.join(', ')}; "${follows}" is neither`)
    const known = await knownProjects(ctx)
    if (!known.includes(project)) throw new RequestError(404, `no project "${project}" in this installation's plan, ${PROJECTS_PATH} or the registry`)
    return { project, follows: follows as ProjectFollows, source: await sourceAt(ctx, o.source, { conventions: false }) }
  }
  const n = normalizeTag(str(o.tag))
  if ('problem' in n) throw new RequestError(400, `a rule needs its tag or its project: ${n.problem}`)
  if (!(FOLLOWS as readonly string[]).includes(follows)) throw new RequestError(400, `what follows from #${n.tag} is one of ${FOLLOWS.join(', ')}; "${follows}" is neither. Other consequences do not exist: say it in words instead`)
  return { tag: n.tag, follows: follows as Follows, source: await sourceAt(ctx, o.source, { conventions: true }) }
}
const idOf = (x: RuleBody) => 'content' in x ? contentRuleId(x.content, x.project, x.follows) : 'tag' in x ? ruleId(x.tag, x.follows) : 'project' in x ? projectRuleId(x.project, x.follows) : 'default-licence'

export async function adoptRule(ctx: CatalogContext, o: RuleInput & { author: string; proposedBy?: string }) {
  if (!o.author.trim()) throw new RequestError(400, 'adopting a rule needs your name: the owner adopts it')
  const x = await checkRuleSource(ctx, o)
  const s = await needSetting(ctx)
  const rule = { id: idOf(x), ...x, adopted: { by: o.author.trim(), at: new Date().toISOString() } } as AnyRule
  let replaced = false
  const r = await commitChanges(ctx, s, async dir => {
    const cur = readRules(await readTextOrNull(join(dir, RULES_PATH)))
    if (cur.problem) throw new RequestError(409, `${RULES_PATH} cannot be read (${cur.problem}): correct it first; nothing was written`)
    const old = cur.all.find(y => y.id === rule.id)
    replaced = !!old
    // A rule adopted again keeps the owner's share: never (improve_publish p1 decision 5).
    const next = old && 'share' in old && old.share === 'never' && !('share' in rule) ? withShare(rule, 'never') : rule
    return [{ path: RULES_PATH, text: writeRules([...cur.all.filter(y => y.id !== rule.id), next]) }]
  }, o.author, () => [`${replaced ? 'Adopt again' : 'Adopt'} rule ${rule.id}: ${subjectOf(rule)} → ${rule.follows}`, '',
    `From braindump ${rule.source.braindump} at ${rule.source.commit.slice(0, 12)}: "${rule.source.sentence}"`, ...(o.proposedBy ? ['', `Proposed by ${o.proposedBy}; adopted by ${o.author.trim()}.`] : [])].join('\n'))
  return { ok: true, message: `${replaced ? 'Adopted again' : 'Adopted'} rule ${rule.id} (${r.commit.slice(0, 7)}): ${followsWords(rule)}.`, commit: r.commit, changed: r.changed, rule }
}
// The rule with its fields in the file's order: id, what it is about, follows, share, source, adopted.
function withShare(r: AnyRule, share: 'never' | null): AnyRule {
  const { share: _s, source, adopted, ...head } = r as AnyRule & { share?: string }
  return { ...head, ...(share ? { share } : {}), source, adopted } as AnyRule
}
// wfe catalog rules share <id> never|default: never keeps a rule in this installation (not published, never
// offered by a style import); default lets it follow the public list. default-licence is always never.
export async function shareRule(ctx: CatalogContext, o: { id: string; share: string; author: string }) {
  if (!o.author.trim()) throw new RequestError(400, 'changing a rule needs your name')
  if (o.share !== 'never' && o.share !== 'default') throw new RequestError(400, `share is never or default; "${o.share}" is neither`)
  const s = await needSetting(ctx)
  const r = await commitChanges(ctx, s, async dir => {
    const cur = readRules(await readTextOrNull(join(dir, RULES_PATH)))
    if (cur.problem) throw new RequestError(409, `${RULES_PATH} cannot be read (${cur.problem}): correct it first; nothing was written`)
    const x = cur.all.find(y => y.id === o.id)
    if (!x) throw new RequestError(404, `no rule "${o.id}" (${cur.all.map(y => y.id).join(', ') || 'no rule is adopted'})`)
    if (kindOf(x) === 'licence' && o.share === 'default') throw new RequestError(409, 'the default licence is the owner\'s own preference and is never shared (user_catalog p8 decision 16)')
    return [{ path: RULES_PATH, text: writeRules(cur.all.map(y => y.id === o.id ? withShare(y, o.share === 'never' ? 'never' : null) : y)) }]
  }, o.author, () => `Rule ${o.id}: share ${o.share}`)
  return { ok: true, message: `${r.changed ? `Rule ${o.id}: share ${o.share} (${r.commit.slice(0, 7)})` : `Rule ${o.id} is share ${o.share} already`}: ${o.share === 'never' ? 'it stays in this installation; it is neither published nor offered by a style import' : 'it is public when its braindump is in the public list and it names nothing private'}.`, commit: r.commit, changed: r.changed }
}

// What of rules.yaml the publication tool publishes (improve_publish p1 decision 4; the tool's public_rules is the
// authority): a rule whose source braindump the list selects, not never-publish on a project, not share: never.
export interface PublicRule { id: string; public: boolean; why: string }
export function publicRules(rd: RulesFile, selected: Map<string, string>, privateIds: string[] = []): PublicRule[] {
  if (!selected.has(RULES_PATH)) return rd.all.map(r => ({ id: r.id, public: false, why: `${RULES_PATH} is not in the public list` }))
  return rd.all.map(r => {
    if (kindOf(r) === 'licence' || ('share' in r && r.share === 'never')) return { id: r.id, public: false, why: 'share: never' }
    if (kindOf(r) === 'project' && r.follows === 'never-publish') return { id: r.id, public: false, why: 'it names a project kept private' }
    if (kindOf(r) === 'content' && 'project' in r && r.project && privateIds.includes(r.project)) return { id: r.id, public: false, why: `it names ${r.project}, kept private` }
    if (!selected.has(braindumpPath(r.source.braindump))) return { id: r.id, public: false, why: `its braindump ${r.source.braindump} is not in the public list` }
    return { id: r.id, public: true, why: `its braindump ${r.source.braindump} is public` }
  })
}

export async function retireRule(ctx: CatalogContext, o: { id: string; author: string }) {
  if (!o.author.trim()) throw new RequestError(400, 'retiring a rule needs your name')
  const s = await needSetting(ctx)
  let gone: AnyRule | undefined
  const r = await commitChanges(ctx, s, async dir => {
    const cur = readRules(await readTextOrNull(join(dir, RULES_PATH)))
    gone = cur.all.find(y => y.id === o.id)
    if (!gone) throw new RequestError(404, `no rule "${o.id}" (${cur.all.map(y => y.id).join(', ') || 'no rule is adopted'})`)
    return [{ path: RULES_PATH, text: writeRules(cur.all.filter(y => y.id !== o.id)) }]
  }, o.author, () => `Retire rule ${o.id}: ${subjectOf(gone!)} → ${gone!.follows}`)
  const g = gone!
  return { ok: true, message: `Retired rule ${o.id} (${r.commit.slice(0, 7)}): nothing follows from ${subjectOf(g)} any more${g.follows === 'never-publish' ? '; what was public of it before is not unpublished by this, and nothing becomes public by it' : g.follows === 'publish' ? '; what is public of it stays public' : ''}.`, commit: r.commit, changed: r.changed }
}
const subjectOf = (r: { tag?: string; project?: string; licence?: string; content?: string }) => r.content ? `${r.content}${r.project ? ` of ${r.project}` : ''}` : r.tag ? `#${r.tag}` : r.project ? `project ${r.project}` : `the default licence ${r.licence}`
export const contentNames: Record<string, string> = { runs: 'run records', workflows: 'workflows', episodes: 'episodes' }
export const followsWords = (r: { tag?: string; project?: string; licence?: string; content?: string; follows: string }) =>
  r.content ? (r.follows === 'never-publish' ? `${contentNames[r.content] ?? r.content} of ${r.project ?? 'any project'} are never published` : `${contentNames[r.content] ?? r.content} of ${r.project ?? 'a public project'} are proposed for publication by this sentence (the publisher reads it; it selects nothing)`)
  : r.follows === LICENCE_FOLLOWS ? `a project published for the first time is licensed ${r.licence}, unless it holds another's material or states another licence (your own preference: never shared as style)`
  : r.project ? (r.follows === 'never-publish' ? `project ${r.project} is never published` : `project ${r.project} is to be published (the publisher may make it public when you ask)`)
  : r.follows === 'never-publish' ? `a braindump tagged #${r.tag} is never published` : `a braindump tagged #${r.tag} is suggested for the public list`

const viewOf = (r: AnyRule, sourceChanged: boolean, sourceNote?: string): RuleView => ({
  id: r.id, kind: kindOf(r), follows: r.follows, ...('content' in r ? { content: r.content } : {}), ...('tag' in r ? { tag: r.tag } : {}), ...('project' in r && r.project ? { project: r.project } : {}),
  ...('licence' in r ? { licence: r.licence, share: r.share } : 'share' in r && r.share ? { share: r.share } : {}), source: r.source, adopted: r.adopted, sourceChanged, ...(sourceNote ? { sourceNote } : {}),
})
// The adopted rules, each with whether its source changed since (derived from Git).
export async function rules(ctx: CatalogContext, o: { maxAgeMs?: number } = {}): Promise<{ head: string; rules: RuleView[]; problem?: string }> {
  const snap = await catalogSnapshot(ctx, o)
  return inCheckout(ctx, async dir => {
    const cur = readRules(await readTextOrNull(join(dir, RULES_PATH)))
    const out: RuleView[] = []
    for (const r of cur.all) {
      const path = braindumpPath(r.source.braindump)
      const now = await git(dir, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`])
      const then = await git(dir, ['rev-parse', '--verify', '--quiet', `${r.source.commit}:${path}`])
      const text = now.code === 0 ? await readTextOrNull(join(dir, path)) : null
      const note = now.code !== 0 ? `its source braindump ${r.source.braindump} is no longer in the catalog`
        : now.stdout.trim() !== then.stdout.trim() ? `${r.source.braindump} changed after ${r.source.commit.slice(0, 7)}${text !== null && holds(text, r.source.sentence) ? '; the sentence is still there' : '; the sentence is no longer there'}` : ''
      out.push(viewOf(r, !!note, note || undefined))
    }
    return { head: snap.head, rules: out, ...(cur.problem ? { problem: cur.problem } : {}) }
  })
}

// ---- disclosure: what the owner's words make of each project ----------------------------

export type DisclosureState = 'private' | 'to be published' | 'public' | 'public without a statement' | 'not stated'
export interface Statement { follows: ProjectFollows; braindump: string; sentence: string; commit?: string; rule?: string; proposal?: { suggestion: string; n: number; by: string } }
export interface DisclosureLine {
  project: string; state: DisclosureState
  // The statement that decides (an adopted rule, or a proposal not yet answered), and any other.
  decides?: Statement; also: Statement[]
  public: { destination: string; commit: string; at: string }[] // from the journal of its workspace
  workspace?: string; note?: string
}
// improve_publish p2: what the owner's words say about a kind of content, in force (an adopted rule, a proposed
// never-publish) or waiting for OK (a proposed suggest-publish).
export interface ContentLine { content: string; project?: string; follows: string; braindump: string; sentence: string; rule?: string; proposal?: { suggestion: string; n: number; by: string }; inForce: boolean }
export interface Disclosure {
  head: string; projects: DisclosureLine[]; contents: ContentLine[]
  licence: { rule?: RuleView; proposal?: { licence: string; braindump: string; sentence: string; suggestion: string; by: string } } | null
  // Where a first publication goes: the owner of the catalog's own destination (github.com/<owner>/mycatalog).
  publicOwner: string | null
}
export async function journalOf(path: string): Promise<DisclosureLine['public']> {
  try {
    const j = JSON.parse((await readTextOrNull(join(path, '.agdev', 'publication', 'github.json'))) ?? 'null') as { repositories?: Record<string, { destination?: string; publications?: { status?: string; public_commit?: string; published_at?: string; destination?: string }[] }> } | null
    const out: DisclosureLine['public'] = []
    for (const r of Object.values(j?.repositories ?? {})) {
      const l = (r.publications ?? []).filter(x => x.status === 'published' && x.public_commit).sort((a, b) => (a.published_at ?? '').localeCompare(b.published_at ?? '')).at(-1)
      if (l) out.push({ destination: r.destination ?? l.destination ?? '', commit: l.public_commit!, at: l.published_at ?? '' })
    }
    return out
  } catch { return [] }
}
export async function disclosure(ctx: CatalogContext, o: { maxAgeMs?: number; project?: string } = {}): Promise<Disclosure> {
  const snap = await catalogSnapshot(ctx, o)
  const reg = await loadRegistry(ctx.registryFile).catch(() => ({ workspaces: [] as { id: string; path: string; project?: string }[] }))
  const cur = await inCheckout(ctx, async dir => readRules(await readTextOrNull(join(dir, RULES_PATH))))
  const ruleViews = (await rules(ctx).catch(() => ({ rules: [] as RuleView[] }))).rules
  const { readLinkSuggestion } = await import('./catalogLinks.ts')
  const s = await readLinkSuggestion(ctx.area)
  const proposals = (s?.disclosure ?? []).filter(x => x.state === 'suggested')
  const projects = o.project ? [o.project] : await knownProjects(ctx)
  const contract = await inCheckout(ctx, async dir => readTextOrNull(join(dir, PUBLICATION_CONTRACT)))
  const publicOwner = contract ? /github\.com\/([^/]+)\//.exec(readPublicationContract(contract).destination)?.[1] ?? null : null
  const lines: DisclosureLine[] = []
  for (const p of projects) {
    const ws = reg.workspaces.find(w => w.project === p) ?? reg.workspaces.find(w => w.id === p)
    const pub = ws ? await journalOf(ws.path) : []
    const stated: Statement[] = [
      ...cur.projects.filter(r => r.project === p).map(r => ({ follows: r.follows, braindump: r.source.braindump, sentence: r.source.sentence, commit: r.source.commit, rule: r.id })),
      ...proposals.filter(x => x.project === p && !x.content).map(x => ({ follows: x.follows as ProjectFollows, braindump: x.braindump, sentence: x.quote, proposal: { suggestion: s!.id, n: x.n, by: s!.by } })),
    ]
    // An adopted rule before a proposal; never-publish before publish.
    const never = stated.find(x => x.follows === 'never-publish' && x.rule) ?? stated.find(x => x.follows === 'never-publish')
    const publish = stated.find(x => x.follows === 'publish' && x.rule)
    const decides = never ?? publish ?? stated.find(x => x.follows === 'publish')
    const state: DisclosureState = never ? 'private' : publish ? (pub.length ? 'public' : 'to be published') : pub.length ? 'public without a statement' : 'not stated'
    const note = never && stated.some(x => x.follows === 'publish') ? 'stated public and private: private wins'
      : never && pub.length ? 'it was public before this statement: nothing further is published, and what is public is not withdrawn'
      : !never && !publish && decides ? 'proposed public: nothing follows until you answer OK' : undefined
    lines.push({ project: p, state, ...(decides ? { decides } : {}), also: stated.filter(x => x !== decides), public: pub, ...(ws ? { workspace: ws.id } : {}), ...(note ? { note } : {}) })
  }
  const lv = ruleViews.find(r => r.kind === 'licence')
  const lp = s?.licence && s.licence.state === 'suggested' ? { licence: s.licence.licence, braindump: s.licence.braindump, sentence: s.licence.quote, suggestion: s.id, by: s.by } : undefined
  const contents: ContentLine[] = [
    ...cur.contents.map(r => ({ content: r.content, ...(r.project ? { project: r.project } : {}), follows: r.follows, braindump: r.source.braindump, sentence: r.source.sentence, rule: r.id, inForce: true })),
    ...proposals.filter(x => x.content).map(x => ({ content: x.content!, ...(x.project ? { project: x.project } : {}), follows: x.follows, braindump: x.braindump, sentence: x.quote, proposal: { suggestion: s!.id, n: x.n, by: s!.by }, inForce: x.follows === 'never-publish' })),
  ].filter(x => !o.project || !x.project || x.project === o.project)
  return { head: snap.head, projects: lines, contents, licence: lv || lp ? { ...(lv ? { rule: lv } : {}), ...(lp ? { proposal: lp } : {}) } : null, publicOwner }
}
export function disclosureLines(d: Disclosure): string[] {
  const st = (x: Statement) => `${x.rule ? `rule ${x.rule}` : `proposed by ${x.proposal?.by} (suggestion ${x.proposal?.suggestion}, ${x.proposal?.n})`}, from ${x.braindump}: “${x.sentence}”`
  return [
    ...d.projects.map(l => [`${l.project.padEnd(16)} ${l.state}${l.public.length ? `  (${l.public.map(p => p.destination.replace(/^https:\/\//, '').replace(/\.git$/, '')).join(', ')})` : ''}`,
      ...(l.decides ? [`  ${st(l.decides)}`] : []), ...l.also.map(x => `  also: ${x.follows}, ${st(x)}`), ...(l.note ? [`  ${l.note}`] : [])].join('\n')),
    ...(d.contents.length ? ['', ...d.contents.map(x => `${(contentNames[x.content] ?? x.content).padEnd(16)} ${x.project ? `of ${x.project}` : 'of every project'}: ${x.follows}${x.inForce ? '' : ' (proposed: nothing follows until you answer OK)'}\n  ${st({ follows: x.follows as ProjectFollows, braindump: x.braindump, sentence: x.sentence, ...(x.rule ? { rule: x.rule } : {}), ...(x.proposal ? { proposal: x.proposal } : {}) })}`)]
      : ['', 'run records and episodes: no rule states a criterion, so they stay local (the publisher proposes none)']),
    '', d.licence?.rule ? `default licence ${d.licence.rule.licence} (rule default-licence, from ${d.licence.rule.source.braindump}: “${d.licence.rule.source.sentence}”; never shared as style)`
      : d.licence?.proposal ? `default licence: ${d.licence.proposal.licence} proposed by ${d.licence.proposal.by}, from ${d.licence.proposal.braindump}: “${d.licence.proposal.sentence}” (not in force until you answer OK)` : 'default licence: none adopted (the publisher asks for the licence of a first publication)',
  ]
}

// ---- run records: the publisher's first look (improve_publish p2 decision 17) --------------

export interface RunLine { id: string; kinds: Record<string, number>; development: string[]; outside: string[]; texts: string[]; 'request.md': { bytes: number; private: string[]; forbidden: string[] } | null; 'report.md': RunLine['request.md'] }
export interface RunsListing { project: string; source_rev: string; criterion: { rule?: string; proposal?: string; follows: string; braindump: string; sentence: string; project?: string | null } | null; judged: string; selected: { id: string; files: string[]; because?: string }[]; local: string[]; unchanged_since_judged: number; runs: RunLine[] }
// The installed publication tool (<root>/config/install, beside the area), else the copy in this release.
export async function publishTool(area: string): Promise<string> {
  for (const p of [resolve(area, '..', '..', 'config', 'install', 'agdev-external-publish'), fileURLToPath(new URL('../../install/agdev-external-publish', import.meta.url))]) {
    try { await access(p); return p } catch { /* next */ }
  }
  throw new RequestError(500, 'agdev-external-publish is not installed beside this area or in this release')
}
// The tool's `runs` reading of a project's workspace (its source, or a draft clone): the contract, the rules and the
// open proposals are read in one place, the tool.
export async function disclosureRuns(ctx: CatalogContext, o: { project: string; source?: string }): Promise<RunsListing> {
  const reg = await loadRegistry(ctx.registryFile)
  const ws = reg.workspaces.find(w => w.project === o.project) ?? reg.workspaces.find(w => w.id === o.project)
  if (!ws) throw new RequestError(404, `no workspace of project "${o.project}" here`)
  const tool = await publishTool(ctx.area)
  const args = [tool, '--workspace', ws.path, ...(o.source ? ['--source', resolve(o.source)] : []), 'runs']
  return new Promise((ok, fail) => execFile('python3', args, { env: { ...process.env, WFE_AREA: ctx.area }, maxBuffer: 64 * 1024 * 1024 }, (e, stdout, stderr) => {
    if (e) return fail(new RequestError(409, (stderr || e.message).trim()))
    try { ok(JSON.parse(stdout) as RunsListing) } catch (x) { fail(new RequestError(500, `the tool's listing cannot be read: ${(x as Error).message}`)) }
  }))
}
const kb = (n: number) => n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)} kB`
export function disclosureRunsLines(x: RunsListing): string[] {
  const c = x.criterion
  const text = (t: RunLine['request.md'], name: string) => t ? `${name} ${kb(t.bytes)}${t.private.length ? ` (names ${t.private.join(', ')}, kept private)` : ''}${t.forbidden.length ? ` (forbidden: ${t.forbidden.join(', ')})` : ''}` : `no ${name}`
  return [
    `run records of ${x.project} at ${x.source_rev.slice(0, 12)}`,
    c ? `criterion: ${c.follows} — ${c.rule ? `rule ${c.rule}` : `proposed (${c.proposal})`}, from ${c.braindump}: “${c.sentence}”` : 'criterion: none — no rule states one, so run records stay local and the publisher proposes none',
    `judged: ${x.judged}`,
    ...(x.selected.length ? [`public by [[run]]: ${x.selected.map(r => `${r.id} (${r.files.join(', ')}; ${r.because ?? 'no because'})`).join(', ')}`] : []),
    ...(x.local.length ? [`kept local by [[local]]: ${x.local.join(', ')}`] : []),
    ...(x.unchanged_since_judged ? [`${x.unchanged_since_judged} run${x.unchanged_since_judged === 1 ? '' : 's'} judged before and unchanged: not listed`] : []),
    `not yet judged: ${x.runs.length}`,
    ...x.runs.map(r => `  ${r.id.padEnd(26)} ${Object.keys(r.kinds).length ? `changed outside its folder: ${Object.entries(r.kinds).map(([k, n]) => `${n} ${k}`).join(', ')}` : 'changed nothing outside its folder'}; ${text(r['request.md'], 'request.md')}, ${text(r['report.md'], 'report.md')}${r.development.length ? `\n  ${''.padEnd(26)} ${r.development.slice(0, 6).join(', ')}${r.development.length > 6 ? `, … (${r.development.length})` : ''}` : ''}`),
  ]
}

// ---- the check before a publication ---------------------------------------------------

export interface PublicationCheck {
  contract: boolean; rules: number; problem?: string
  // A candidate that holds any of these is refused.
  refusals: { rule: string; tag: string; braindump: string; path: string; public: string; source: RuleSource; kind?: 'file' | 'because' }[]
  // Other selected files that name a braindump a never-publish rule covers: reported, for the owner to read.
  mentions: { rule: string; braindump: string; path: string; public: string; by: 'path' | 'title' }[]
  suggestions: { rule: string; tag: string; braindump: string }[]
  // Per braindump a rule says something about.
  braindumps: Record<string, { never?: string; suggest?: string; selected: boolean }>
  // p8, improve_publish p1: selected files that name a project kept private. The publication tool refuses each
  // unless the contract's [[allow]] (found = "private:<id>") records why the name is needed: allowed holds that why.
  projectMentions: { project: string; path: string; public: string; why: string; allowed?: string }[]
  // improve_publish p1: what of rules.yaml is public (when it is selected), per rule.
  publicRules: PublicRule[]
  // p8: braindumps no tag rule covers (neither published nor kept private by a rule).
  undecided: string[]
  // p8: rules.yaml in the public list: selected, suggested (a braindump tagged mybraindump is), or neither.
  rulesFile: 'selected' | 'suggested' | 'internal' | 'absent'
}
const TEXTUAL = /\.(md|markdown|txt|ya?ml|toml|json)$/i
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The name of a private project as the publication tool searches it: case-insensitive, not next to [A-Za-z0-9].
export const privateNameRe = (project: string) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(project)}(?![A-Za-z0-9])`, 'i')
export type PrivateProject = { project: string; why: string }
// Reads a catalog as files of a folder (the service's clone, or any copy of the repository).
export async function checkFolder(dir: string, files: string[], o: { privateProjects?: PrivateProject[] } = {}): Promise<PublicationCheck> {
  const rd = readRules(await readTextOrNull(join(dir, RULES_PATH)))
  const ct = await readTextOrNull(join(dir, PUBLICATION_CONTRACT))
  const out: PublicationCheck = { contract: ct !== null, rules: rd.all.length, ...(rd.problem ? { problem: `${RULES_PATH} cannot be read (${rd.problem})` } : {}), refusals: [], mentions: [], suggestions: [], braindumps: {}, projectMentions: [], publicRules: [], undecided: [], rulesFile: files.includes(RULES_PATH) ? 'internal' : 'absent' }
  const contract = ct === null ? null : readPublicationContract(ct)
  const selected = contract === null ? new Map<string, string>() : publishedPaths(contract, files)
  if (selected.has(RULES_PATH)) out.rulesFile = 'selected'
  if (selected.has(RULES_PATH)) out.publicRules = publicRules(rd, selected, (o.privateProjects ?? []).map(p => p.project))
  const ids = files.filter(f => f.startsWith(`${EPISODES_DIR}/`) && f.endsWith(`/${BRAINDUMP_FILE}`)).map(f => f.slice(EPISODES_DIR.length + 1, -BRAINDUMP_FILE.length - 1))
  const never: { id: string; rule: Rule; title: string }[] = []
  for (const id of ids) {
    const tags = readBraindumpMetadata(await readTextOrNull(join(dir, metadataPath(id)))).tags
    if (out.rulesFile === 'internal' && selected.has(braindumpPath(id)) && tags.some(t => sameTag(t, RECOMMENDED_TAG))) out.rulesFile = 'suggested'
    const n = rd.rules.find(r => r.follows === 'never-publish' && tags.some(t => sameTag(t, r.tag)))
    const s = rd.rules.find(r => r.follows === 'suggest-publish' && tags.some(t => sameTag(t, r.tag)))
    if (!n && !s) { if (rd.rules.length) out.undecided.push(id); continue }
    const isSelected = selected.has(braindumpPath(id))
    out.braindumps[id] = { ...(n ? { never: n.id } : {}), ...(s ? { suggest: s.id } : {}), selected: isSelected }
    if (n) {
      never.push({ id, rule: n, title: braindumpTitle(id, (await readTextOrNull(join(dir, braindumpPath(id)))) ?? '') })
      for (const p of [braindumpPath(id), reviewPath(id)]) if (selected.has(p)) out.refusals.push({ rule: n.id, tag: n.tag, braindump: id, path: p, public: selected.get(p)!, source: n.source, kind: 'file' })
    } else if (s && !isSelected) out.suggestions.push({ rule: s.id, tag: s.tag, braindump: id })
  }
  const priv = o.privateProjects ?? []
  if (never.length || priv.length) for (const [from, pub] of selected) {
    if (!TEXTUAL.test(from)) continue
    const text = await readFile(join(dir, from), 'utf8').catch(() => '')
    for (const n of never) {
      if (from === braindumpPath(n.id) || from === reviewPath(n.id)) continue
      const by = text.includes(`${EPISODES_DIR}/${n.id}/`) || text.includes(`${n.id}/${BRAINDUMP_FILE}`) ? 'path' as const : n.title !== n.id && n.title.length >= 6 && text.includes(n.title) ? 'title' as const : null
      // p8 decision 4: a because of the public projects.yaml that names a braindump kept private is refused.
      if (by === 'path' && from === PROJECTS_PATH) out.refusals.push({ rule: n.rule.id, tag: n.rule.tag, braindump: n.id, path: from, public: pub, source: n.rule.source, kind: 'because' })
      else if (by) out.mentions.push({ rule: n.rule.id, braindump: n.id, path: from, public: pub, by })
    }
    // rules.yaml is published in its derived form, which leaves out every rule that names a private project.
    if (from === RULES_PATH) continue
    for (const p of priv) if (privateNameRe(p.project).test(text)) {
      const a = contract?.allows.find(x => x.found === `private:${p.project}` && globMatch(pub, x.file))
      out.projectMentions.push({ project: p.project, path: from, public: pub, why: p.why, ...(a ? { allowed: a.why || '(no why given)' } : {}) })
    }
  }
  return out
}
const listFiles = async (dir: string, withUntracked: boolean) => (await gitOk(dir, ['-c', 'core.quotePath=false', 'ls-files', '-z', ...(withUntracked ? ['--cached', '--others', '--exclude-standard'] : [])])).split('\0').filter(Boolean)
// The projects kept private now: adopted never-publish rules and proposals not declined.
export async function privateProjects(ctx: CatalogContext): Promise<PrivateProject[]> {
  const d = await disclosure(ctx).catch(() => null)
  return (d?.projects ?? []).filter(l => l.state === 'private').map(l => ({ project: l.project, why: l.decides?.rule ? `rule ${l.decides.rule}` : 'a proposal not yet answered' }))
}

// source: a folder holding a copy of the catalog (its working tree is read as it is); absent: the catalog's head.
export async function publicationCheck(ctx: CatalogContext, o: { source?: string; maxAgeMs?: number } = {}): Promise<PublicationCheck & { where: string }> {
  const privateProjects_ = await privateProjects(ctx)
  if (o.source) {
    const files = await listFiles(o.source, true).catch(() => { throw new RequestError(400, `${o.source} is not a Git working tree of a catalog`) })
    return { ...await checkFolder(o.source, files, { privateProjects: privateProjects_ }), where: o.source }
  }
  const snap = await catalogSnapshot(ctx, { maxAgeMs: o.maxAgeMs })
  return inCheckout(ctx, async dir => ({ ...await checkFolder(dir, await listFiles(dir, false), { privateProjects: privateProjects_ }), where: `catalog ${snap.head.slice(0, 7)}` }))
}
export function checkLines(c: PublicationCheck): string[] {
  return [
    ...(c.problem ? [`problem ${c.problem}`] : []),
    ...c.refusals.map(r => r.kind === 'because'
      ? `refused ${r.path}: a because names braindump ${r.braindump}, which is tagged #${r.tag} and never published (rule ${r.rule}). Take the link out of the shared project, or keep ${r.path} out of the public list`
      : `refused ${r.path}: braindump ${r.braindump} is tagged #${r.tag}, which is never published (rule ${r.rule}, adopted from ${r.source.braindump}@${r.source.commit.slice(0, 7)}: "${r.source.sentence}"). Take it out of ${PUBLICATION_CONTRACT}, or change the tag or the rule`),
    ...c.mentions.map(m => `names   ${m.path} names braindump ${m.braindump} by its ${m.by} (kept private by rule ${m.rule}): read what it says of it before publishing`),
    ...c.projectMentions.map(m => m.allowed !== undefined
      ? `project ${m.path} names project ${m.project}, kept private (${m.why}); kept by [[allow]]: ${m.allowed}. What it tells beyond the name is not allowed`
      : `refused ${m.path} names project ${m.project}, kept private (${m.why}): the publication tool refuses it (private:${m.project}). Generalize it, or record why the name is needed: [[allow]] file = "${m.public}", found = "private:${m.project}", why = "…"`),
    ...(c.publicRules.length ? [`rules   ${RULES_PATH} is published in its derived form: ${c.publicRules.filter(r => r.public).map(r => r.id).join(', ') || 'no rule'}${c.publicRules.some(r => !r.public) ? `; not: ${c.publicRules.filter(r => !r.public).map(r => `${r.id} (${r.why})`).join(', ')}` : ''}`] : []),
    ...c.suggestions.map(s => `suggest braindump ${s.braindump} is tagged #${s.tag} and is not in the public list (rule ${s.rule}): wfe catalog publication add ${s.braindump}`),
    ...(c.rulesFile === 'suggested' ? [`suggest ${RULES_PATH} is not in the public list, and a braindump tagged ${RECOMMENDED_TAG} is: wfe catalog publication add ${RULES_PATH}`] : []),
    ...(c.undecided.length ? [`undecided braindumps no rule covers (internal, not decided): ${c.undecided.join(', ')}`] : []),
  ]
}

const rulesFileEntry = (by: string) => `\n\n[[file]]                            # the adopted rules: added by ${by} (with the conventions tagged ${RECOMMENDED_TAG})\npublic = "${RULES_PATH}"\nfrom = "source:${RULES_PATH}"\nbecause = "project"\n`
// *Add to the public list*: the braindump's own files as one [[tree]] of the contract, in one commit (with rules.yaml, the first time a
// braindump tagged mybraindump is added). `rules.yaml` as the id adds that file alone. Nothing is pushed.
export async function publicationAdd(ctx: CatalogContext, o: { id: string; author: string }) {
  if (!o.author.trim()) throw new RequestError(400, 'adding to the public list needs your name')
  const isRules = o.id === RULES_PATH
  if (!isRules) needId(o.id)
  const s = await needSetting(ctx)
  let rule = '', withRules = false
  const r = await commitChanges(ctx, s, async dir => {
    const ct = await readTextOrNull(join(dir, PUBLICATION_CONTRACT))
    if (ct === null) throw new RequestError(409, `the catalog has no ${PUBLICATION_CONTRACT}: nothing of it is published, so there is no public list to add to (agdev docs/external-publication.md)`)
    const files = await listFiles(dir, false)
    const selected = publishedPaths(readPublicationContract(ct), files)
    if (isRules) {
      if (!files.includes(RULES_PATH)) throw new RequestError(404, `the catalog has no ${RULES_PATH}: no rule is adopted`)
      if (selected.has(RULES_PATH)) throw new RequestError(409, `${RULES_PATH} is in the public list already`)
      return [{ path: PUBLICATION_CONTRACT, text: `${ct.trimEnd()}${rulesFileEntry(o.author.trim())}` }]
    }
    if (!files.includes(braindumpPath(o.id))) throw new RequestError(404, `no braindump "${o.id}"`)
    const c = await checkFolder(dir, files)
    const b = c.braindumps[o.id]
    if (b?.never) { const x = readRules(await readTextOrNull(join(dir, RULES_PATH))).rules.find(y => y.id === b.never)!; throw new RequestError(409, `braindump "${o.id}" is tagged #${x.tag}, which is never published (rule ${x.id}, from ${x.source.braindump}: "${x.source.sentence}"); it was not added`, { code: 'rule' }) }
    if (selected.has(braindumpPath(o.id))) throw new RequestError(409, `braindump "${o.id}" is in the public list already`)
    rule = b?.suggest ?? ''
    const tags = readBraindumpMetadata(await readTextOrNull(join(dir, metadataPath(o.id)))).tags
    withRules = files.includes(RULES_PATH) && !selected.has(RULES_PATH) && tags.some(t => sameTag(t, RECOMMENDED_TAG))
    const folder = `${EPISODES_DIR}/${o.id}`
    return [{ path: PUBLICATION_CONTRACT, text: `${ct.trimEnd()}\n\n[[tree]]                            # braindump ${o.id}: added by ${o.author.trim()}${rule ? ` (rule ${rule})` : ''}\nfrom = "source:${folder}"\npublic = "${folder}"\nexclude = ["*/*"]                   # its own files only, not the braindumps below it\nbecause = "${rule ? `rule:${rule}` : `owner:${o.author.trim().replace(/"/g, '')}`}"\n${withRules ? rulesFileEntry(o.author.trim()).replace(/^\n/, '') : ''}` }]
  }, o.author, () => isRules ? [`Add ${RULES_PATH} to the public list`, '', `${PUBLICATION_CONTRACT}: the adopted rules as a [[file]]. Nothing is published by this commit.`].join('\n')
    : [`Add braindump ${o.id} to the public list`, '', `${PUBLICATION_CONTRACT}: its folder as a [[tree]]${rule ? ` (suggested by rule ${rule})` : ''}${withRules ? `, and ${RULES_PATH}` : ''}. Nothing is published by this commit.`].join('\n'))
  return { ok: true, message: `${isRules ? RULES_PATH : `Braindump ${o.id}${withRules ? ` (with ${RULES_PATH})` : ''}`} is in the public list (${r.commit.slice(0, 7)}). Nothing was published: ask the publisher for that.`, commit: r.commit, changed: r.changed }
}

// The catalog's side of a publication, written by its owning agent (the summoner's catalog-publication-edit) or the owner:
// publication/github.toml or a file of publication/overlay/, whole. The check runs on the result: a selection a rule refuses is not written.
export const PUBLICATION_FILE = /^publication\/(github\.toml|overlay\/(?!.*\.\.)[A-Za-z0-9._/-]+)$/
export async function putPublicationFile(ctx: CatalogContext, o: { path: string; text: string | null; author: string; base?: string; message?: string }) {
  if (!o.author.trim()) throw new RequestError(400, 'a change to the publication needs its author')
  if (!PUBLICATION_FILE.test(o.path)) throw new RequestError(400, `"${o.path}" is not ${PUBLICATION_CONTRACT} or a file of publication/overlay/`)
  if (o.path === PUBLICATION_CONTRACT && o.text === null) throw new RequestError(400, `${PUBLICATION_CONTRACT} is not removed this way: without it nothing is published, which is the owner's decision`)
  const s = await needSetting(ctx)
  const priv = await privateProjects(ctx)
  let lines: string[] = []
  const r = await commitChanges(ctx, s, async dir => {
    if (o.base) {
      const now = (await git(dir, ['log', '-1', '--format=%H', '--', o.path])).stdout.trim()
      if (now && !now.startsWith(o.base) && (await git(dir, ['merge-base', '--is-ancestor', now, o.base])).code !== 0) throw new RequestError(409, `${o.path} changed after ${o.base.slice(0, 7)} (last ${now.slice(0, 7)}): read it again; nothing was written`)
    }
    return [{ path: o.path, text: o.text }]
  }, o.author, () => o.message?.trim() || `${o.text === null ? 'Remove' : 'Write'} ${o.path}`, undefined, async dir => {
    const c = await checkFolder(dir, await listFiles(dir, false), { privateProjects: priv })
    lines = checkLines(c)
    if (c.problem || c.refusals.length) throw new RequestError(409, `${o.path} was not written: the check refuses the result:\n${lines.map(l => `  ${l}`).join('\n')}`, { code: 'rule' })
  })
  return { ok: true, message: `${r.changed ? `Wrote ${o.path} (${r.commit.slice(0, 7)})` : `${o.path} is unchanged`}. Nothing was published by it.`, commit: r.commit, changed: r.changed, check: lines }
}

// ---- asking the publisher (p8 decision 13) ----------------------------------------------

export const PUBLISHER = { project: 'publisher', workflow: 'publish' } as const
export const CATALOG_TARGET = 'mycatalog'
export const CATALOG_EDIT = { project: 'summoner', workflow: 'catalog-publication-edit' } as const
// What a request for the publisher's publish says; the caller queues it. A project kept private is refused here.
export async function publicationRequest(ctx: CatalogContext, o: { target?: string; by?: string; note?: string }) {
  const target = (o.target ?? '').trim() || CATALOG_TARGET
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  const reg = await loadRegistry(ctx.registryFile)
  const ws = reg.workspaces.find(w => w.project === PUBLISHER.project) ?? reg.workspaces.find(w => w.id === PUBLISHER.project)
  if (!ws) throw new RequestError(409, `no ${PUBLISHER.project} here: there is nobody to ask for a publication`)
  const d = await disclosure(ctx)
  const priv = d.projects.filter(l => l.state === 'private').map(l => l.project)
  const lic = d.licence?.rule ? `The default licence of a first publication is ${d.licence.rule.licence} (rule default-licence, from ${d.licence.rule.source.braindump}: “${d.licence.rule.source.sentence}”).` : 'No default licence is adopted: a first publication asks for its licence.'
  const privLine = priv.length ? `Kept private by the owner's words (wfe catalog disclosure): ${priv.join(', ')}. A name of one of them stays only where the public text needs it; nothing beyond the name.` : 'No project is kept private by a rule.'
  const repo = `${snap.setting.repository.owner}/${snap.setting.repository.name}`
  let text: string
  if (target === CATALOG_TARGET) {
    if (!snap.setting.publicationWorkspace) throw new RequestError(409, 'no publication workspace is recorded for the catalog (wfe catalog publication use <folder>)')
    const check = await publicationCheck(ctx)
    if (check.refusals.length || check.problem) throw new RequestError(409, `the catalog's public list is refused by its rules:\n${checkLines(check).map(l => `  ${l}`).join('\n')}`, { code: 'rule' })
    text = [`# Publish the catalog`, '', `Target: \`${CATALOG_TARGET}\` — the catalog ${repo} at head ${snap.head}, published from the folder \`wfe catalog publication status\` names (its source/ is a clone of the catalog, its journal is the record).`,
      '', `Publish what its public list (publication/github.toml) selects, as the publisher: read every selected file, the reviews above all, as an outside reader would; the catalog's changes go to its owning agent, the summoner's workflow \`${CATALOG_EDIT.workflow}\` (a delegation to project \`${CATALOG_EDIT.project}\`), never a direct push.`,
      '', privLine, lic, ...(o.note ? ['', o.note] : []), '', `(Asked from the Catalog page${o.by ? ` by ${o.by}` : ''}.)`, ''].join('\n')
  } else {
    const l = d.projects.find(x => x.project === target)
    if (!l) throw new RequestError(404, `no project "${target}" here`)
    if (l.state === 'private') throw new RequestError(409, `project ${target} is kept private (${l.decides?.rule ? `rule ${l.decides.rule}` : 'a proposal not yet answered'}, from ${l.decides?.braindump}: “${l.decides?.sentence}”): it is not published`, { code: 'rule' })
    const auth = l.decides?.rule && l.decides.follows === 'publish'
      ? `The owner stated it public (rule ${l.decides.rule}, from ${l.decides.braindump}: “${l.decides.sentence}”). That rule authorizes a new public repository ${d.publicOwner ? `github.com/${d.publicOwner}/pj-${target}` : `pj-${target}`} with visibility public; what is worth publishing, the edits and the assessment stay yours, and "nothing worth publishing now" is a valid result.`
      : l.public.length ? `It is public already (${l.public.map(p => p.destination).join(', ')}): an update inside the scope of its contract.` : `No rule states it public: a first publication needs the owner's decision on the destination.`
    text = [`# Publish ${target}`, '', `Target: \`${target}\`.`, '', auth, '', privLine, lic, ...(o.note ? ['', o.note] : []), '', `(Asked from the Catalog page${o.by ? ` by ${o.by}` : ''}; catalog ${repo} at ${snap.head.slice(0, 12)}.)`, ''].join('\n')
  }
  return { ok: true, target, head: snap.head, workspace: ws.id, workflow: PUBLISHER.workflow, text, receipt: `publish-${target}-${snap.head.slice(0, 12)}` }
}
