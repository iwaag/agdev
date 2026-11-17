// Links between braindumps and projects, suggested by the summoner and agreed
// by the owner (user_catalog p7, docs/mycatalog.md *Links*).
//
// A link is one item of a `because`: braindump → project. The summoner's
// workflow `ground` reads the whole catalog at one commit and suggests links,
// each with the sentences of the braindump that say so; drops of links that
// exist, with why; what no project serves; which projects are left without a
// ground. The suggestion waits here, outside Git, until the owner answers each
// link: an agreed set is one commit in the owner's name writing `because` in
// this installation's plan and, where the project is listed there, in
// projects.yaml. A newer suggestion replaces the one before.
//
//   <area>/.local/catalog-links.json   ag.catalog-links.v1
//
// It holds quotations of braindumps that are in the catalog; nothing of a draft.
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { braindumpPath, isBraindumpId, PROJECTS_PATH, summonplanPath } from '../shared/catalog.ts'
import { catalogSnapshot, internals, type CatalogContext, type CatalogSnapshot } from './catalog.ts'
import { noteFollowUp } from './catalogFollowUp.ts'
import { holds, loose } from './catalogRules.ts'
import { atomicWrite, readTextOrNull } from './files.ts'
import { git, gitOk } from './git.ts'
import { withLock } from './lock.ts'
import { loadRegistry } from './registry.ts'
import { RequestError } from './workspace.ts'
import { changeBecause } from './yamlDoc.ts'

export const LINKS_SCHEMA = 'ag.catalog-links.v1'
export const GROUND = { project: 'summoner', workflow: 'ground' } as const
export interface SuggestedLink {
  n: number; kind: 'add' | 'drop'; braindump: string; project: string; quote?: string; why?: string
  state: 'suggested' | 'agreed' | 'declined' | 'gone'
  decided?: { by: string; at: string; commit?: string; reason?: string }
}
// p8: what a braindump states about a project's disclosure, and the owner's default licence, proposed with the links.
// A proposed never-publish refuses a publication of the project until the owner answers No; a proposed publish does nothing until OK.
export interface ProposedDisclosure {
  n: number; project: string; follows: 'never-publish' | 'publish'; braindump: string; quote: string; why?: string
  state: 'suggested' | 'agreed' | 'declined' | 'gone'
  decided?: { by: string; at: string; commit?: string; reason?: string }
}
export interface ProposedLicence { licence: string; braindump: string; quote: string; why?: string; state: ProposedDisclosure['state']; decided?: ProposedDisclosure['decided'] }
export interface LinkSuggestion {
  schema: typeof LINKS_SCHEMA; id: string; head: string; at: string; by: string; run?: string
  links: SuggestedLink[]; uncovered: { braindump: string; why: string }[]; ungrounded: string[]; note?: string
  existing: number // links it named that existed already
  disclosure?: ProposedDisclosure[]; licence?: ProposedLicence | null
}
export interface LinksView {
  suggestion: (LinkSuggestion & { open: number; openDisclosure: number; behind: boolean }) | null
  // Braindumps put in or changed since the last suggestion (without one: those that ground no project).
  pending: string[]
}

const { commitChanges, checkoutDir, settingFile, needSetting, showAt } = internals
const file = (area: string) => join(area, '.local', 'catalog-links.json')
const exists = (p: string) => stat(p).then(() => true, () => false)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => typeof v === 'string' ? v.trim() : ''
const inCheckout = <T>(ctx: CatalogContext, f: (dir: string) => Promise<T>) => withLock(settingFile(ctx.area), () => f(checkoutDir(ctx.area)), { what: 'the catalog' })

async function read(area: string): Promise<LinkSuggestion | null> {
  const t = await readTextOrNull(file(area)).catch(() => null)
  if (!t) return null
  try { const s = JSON.parse(t) as LinkSuggestion; return s?.schema === LINKS_SCHEMA ? s : null } catch { return null }
}
export const readLinkSuggestion = read
const write = (area: string, s: LinkSuggestion) => atomicWrite(file(area), `${JSON.stringify(s, null, 1)}\n`)

// Where each project is listed, and which braindump paths its because holds there.
function listed(snap: CatalogSnapshot) {
  const plan = new Map((snap.plans.find(p => p.name === snap.setting.plan)?.plan?.entries ?? []).map(e => [e.project, e.because]))
  const shared = new Map((snap.projects.doc?.projects ?? []).map(p => [p.project, p.because]))
  const has = (project: string, path: string) => !!(plan.get(project)?.includes(path) || shared.get(project)?.includes(path))
  const everywhere = (project: string, path: string) => (plan.has(project) || shared.has(project)) && (!plan.has(project) || plan.get(project)!.includes(path)) && (!shared.has(project) || shared.get(project)!.includes(path))
  return { plan, shared, has, everywhere, known: (project: string) => plan.has(project) || shared.has(project) }
}

// The run's only write: its suggestion for the whole catalog at the commit it read.
export async function suggestLinks(ctx: CatalogContext, o: { suggestion: unknown; head: string; by: string; run?: string }) {
  if (!o.by.trim()) throw new RequestError(400, 'a suggestion needs its author (--author)')
  if (!/^[0-9a-f]{7,40}$/.test(o.head ?? '')) throw new RequestError(400, '--head <commit> is required: the catalog commit the suggestion was made on')
  const raw = isObj(o.suggestion) ? o.suggestion : null
  if (!raw) throw new RequestError(400, 'the suggestion is a JSON object: {"links": [{"braindump", "project", "quote"}], "drop": [...], "uncovered": [...], "ungrounded": [...]}')
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  const l = listed(snap)
  const problems: string[] = []
  const list = (k: string) => Array.isArray(raw[k]) ? raw[k] as unknown[] : []
  const out: SuggestedLink[] = []
  let existing = 0
  const disclosure: ProposedDisclosure[] = []
  let licence: ProposedLicence | null = null
  const head = await inCheckout(ctx, async dir => {
    const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${o.head}^{commit}`])
    if (r.code !== 0) throw new RequestError(404, `the catalog has no commit ${o.head}`)
    const head = r.stdout.trim()
    const texts = new Map<string, string | null>()
    const textOf = async (id: string) => { if (!texts.has(id)) texts.set(id, isBraindumpId(id) ? await showAt(dir, head, braindumpPath(id)) : null); return texts.get(id)! }
    for (const [i, x] of list('links').entries()) {
      const at = `links[${i + 1}]`
      if (!isObj(x)) { problems.push(`${at}: not an object`); continue }
      const b = str(x.braindump).replace(/^\/+|\/+$/g, ''), p = str(x.project), quote = str(x.quote)
      const text = await textOf(b)
      if (text === null) { problems.push(`${at}: no braindump "${b}" in the catalog at ${head.slice(0, 7)}`); continue }
      if (!l.known(p)) { problems.push(`${at}: project "${p}" is neither in the plan ${snap.setting.plan || '(none)'} nor in ${PROJECTS_PATH}`); continue }
      if (!quote) { problems.push(`${at} (${b} → ${p}): a link needs the sentences of the braindump that say so (quote)`); continue }
      if (!holds(text, quote)) { problems.push(`${at} (${b} → ${p}): the quote is not in the braindump's text at ${head.slice(0, 7)}; copy the sentences as they are written`); continue }
      if (out.some(y => y.kind === 'add' && y.braindump === b && y.project === p)) continue
      if (l.everywhere(p, braindumpPath(b))) { existing++; continue }
      out.push({ n: 0, kind: 'add', braindump: b, project: p, quote: loose(quote).slice(0, 2000), ...(str(x.why) ? { why: str(x.why).slice(0, 1000) } : {}), state: 'suggested' })
    }
    for (const [i, x] of list('drop').entries()) {
      const at = `drop[${i + 1}]`
      if (!isObj(x)) { problems.push(`${at}: not an object`); continue }
      const b = str(x.braindump).replace(/^\/+|\/+$/g, ''), p = str(x.project)
      if (!l.has(p, braindumpPath(b))) { problems.push(`${at}: there is no link ${b} → ${p} to drop`); continue }
      if (!str(x.why)) { problems.push(`${at} (${b} → ${p}): say why the link would be dropped (why)`); continue }
      out.push({ n: 0, kind: 'drop', braindump: b, project: p, why: str(x.why).slice(0, 1000), state: 'suggested' })
    }
    // p8: statements about disclosure, each with its sentence; and the default licence.
    for (const [i, x] of list('disclosure').entries()) {
      const at = `disclosure[${i + 1}]`
      if (!isObj(x)) { problems.push(`${at}: not an object`); continue }
      const b = str(x.braindump).replace(/^\/+|\/+$/g, ''), p = str(x.project), quote = str(x.quote), follows = str(x.follows)
      if (follows !== 'never-publish' && follows !== 'publish') { problems.push(`${at} (${p}): follows is never-publish (stated private) or publish (stated public)`); continue }
      const text = await textOf(b)
      if (text === null) { problems.push(`${at}: no braindump "${b}" in the catalog at ${head.slice(0, 7)}`); continue }
      if (!l.known(p)) { problems.push(`${at}: project "${p}" is neither in the plan ${snap.setting.plan || '(none)'} nor in ${PROJECTS_PATH}`); continue }
      if (!quote || !holds(text, quote)) { problems.push(`${at} (${b}: ${p} ${follows}): the quote is not in the braindump's text at ${head.slice(0, 7)}; a statement needs the sentence, copied as it is written`); continue }
      if (disclosure.some(y => y.project === p && y.follows === follows)) continue
      disclosure.push({ n: disclosure.length + 1, project: p, follows, braindump: b, quote: loose(quote).slice(0, 2000), ...(str(x.why) ? { why: str(x.why).slice(0, 1000) } : {}), state: 'suggested' })
    }
    if (isObj(raw.licence)) {
      const x = raw.licence, b = str(x.braindump).replace(/^\/+|\/+$/g, ''), quote = str(x.quote), lic = str(x.licence)
      const text = await textOf(b)
      if (!/^[A-Za-z0-9][A-Za-z0-9.+-]{1,63}$/.test(lic)) problems.push(`licence: "${lic}" is not an SPDX id`)
      else if (text === null) problems.push(`licence: no braindump "${b}" in the catalog at ${head.slice(0, 7)}`)
      else if (!quote || !holds(text, quote)) problems.push(`licence (${b}): the quote is not in the braindump's text at ${head.slice(0, 7)}`)
      else licence = { licence: lic, braindump: b, quote: loose(quote).slice(0, 2000), ...(str(x.why) ? { why: str(x.why).slice(0, 1000) } : {}), state: 'suggested' }
    }
    return head
  })
  const uncovered: LinkSuggestion['uncovered'] = []
  for (const [i, x] of list('uncovered').entries()) {
    if (!isObj(x) || !snap.braindumps.some(b => b.id === str(x.braindump))) { problems.push(`uncovered[${i + 1}]: no braindump "${isObj(x) ? str(x.braindump) : ''}"`); continue }
    uncovered.push({ braindump: str(x.braindump), why: str(x.why).slice(0, 1000) })
  }
  const ungrounded = list('ungrounded').map(x => str(x)).filter(Boolean)
  for (const p of ungrounded) if (!l.known(p)) problems.push(`ungrounded: project "${p}" is neither in the plan nor in ${PROJECTS_PATH}`)
  if (problems.length) throw new RequestError(400, `the suggestion was not taken; nothing was kept:\n${problems.map(p => `  ${p}`).join('\n')}`)
  out.forEach((x, i) => { x.n = i + 1 })
  const s: LinkSuggestion = { schema: LINKS_SCHEMA, id: `ls-${head.slice(0, 12)}-${randomBytes(3).toString('hex')}`, head, at: new Date().toISOString(), by: o.by.trim(), ...(o.run ? { run: o.run } : {}),
    links: out, uncovered, ungrounded, ...(str(raw.note) ? { note: str(raw.note).slice(0, 2000) } : {}), existing, disclosure, licence }
  await withLock(file(ctx.area), () => write(ctx.area, s), { what: 'the link suggestion' })
  const adds = out.filter(x => x.kind === 'add').length
  const priv = disclosure.filter(x => x.follows === 'never-publish').length
  const lic = licence as ProposedLicence | null
  return { ok: true, message: `Kept the suggestion for catalog ${head.slice(0, 7)}: ${adds} link${adds === 1 ? '' : 's'} to add, ${out.length - adds} to drop, ${uncovered.length} braindump${uncovered.length === 1 ? '' : 's'} no project serves, ${ungrounded.length} project${ungrounded.length === 1 ? '' : 's'} without a ground${existing ? `; ${existing} named link${existing === 1 ? ' exists' : 's exist'} already` : ''}; ${disclosure.length} statement${disclosure.length === 1 ? '' : 's'} on disclosure (${priv} private, ${disclosure.length - priv} public)${lic ? `, the default licence ${lic.licence}` : ''}. Nothing is written to any because or rule until the owner agrees on the Catalog page${priv ? '; a project proposed private is refused by the publication tool from now on, until the owner answers No' : ''}.`, suggestion: s }
}

export async function linksView(ctx: CatalogContext, snap: CatalogSnapshot): Promise<LinksView> {
  const s = await read(ctx.area)
  const l = listed(snap)
  const ids = new Set(snap.braindumps.map(b => b.id))
  if (!s) return { suggestion: null, pending: snap.braindumps.filter(b => ![...l.plan.values(), ...l.shared.values()].some(bc => bc.includes(b.path))).map(b => b.id) }
  const pending = await inCheckout(ctx, async dir => {
    const out: string[] = []
    for (const b of snap.braindumps) if (!b.updated || (b.updated.commit !== s.head && (await git(dir, ['merge-base', '--is-ancestor', b.updated.commit, s.head])).code !== 0)) out.push(b.id)
    return out
  })
  // What is gone by now is shown as such, never written.
  const links = s.links.map(x => x.state === 'suggested' && (!ids.has(x.braindump) || !l.known(x.project)) ? { ...x, state: 'gone' as const } : x)
  const disclosure = (s.disclosure ?? []).map(x => x.state === 'suggested' && (!ids.has(x.braindump) || !l.known(x.project)) ? { ...x, state: 'gone' as const } : x)
  return { suggestion: { ...s, links, disclosure, uncovered: s.uncovered.filter(u => ids.has(u.braindump)), open: links.filter(x => x.state === 'suggested').length, openDisclosure: disclosure.filter(x => x.state === 'suggested').length + (s.licence?.state === 'suggested' ? 1 : 0), behind: s.head !== snap.head }, pending }
}
export async function links(ctx: CatalogContext, o: { maxAgeMs?: number } = {}) { return linksView(ctx, await catalogSnapshot(ctx, o)) }

const pick = (s: LinkSuggestion, o: { numbers?: number[]; all?: boolean }) => {
  if (o.all) return s.links.filter(x => x.state === 'suggested' && x.kind === 'add')
  const wanted = new Set(o.numbers ?? [])
  if (!wanted.size) throw new RequestError(400, 'name the links by their numbers, or all of them')
  const chosen = s.links.filter(x => wanted.has(x.n))
  const missing = [...wanted].filter(n => !s.links.some(x => x.n === n))
  if (missing.length) throw new RequestError(404, `the suggestion has no link ${missing.join(', ')} (it has 1 to ${s.links.length})`)
  const decided = chosen.filter(x => x.state !== 'suggested')
  if (decided.length) throw new RequestError(409, `already answered: ${decided.map(x => `${x.n} (${x.state})`).join(', ')}`)
  return chosen
}

// One click is one commit in the owner's name. `all` is every suggested addition; a drop is agreed by its number.
export async function agreeLinks(ctx: CatalogContext, o: { numbers?: number[]; all?: boolean; author: string }) {
  if (!o.author.trim()) throw new RequestError(400, 'agreeing a link needs your name: it is written in your name')
  const setting = await needSetting(ctx)
  return withLock(file(ctx.area), async () => {
    const s = await read(ctx.area)
    if (!s) throw new RequestError(404, 'no links are suggested (wfe catalog links request)')
    const chosen = pick(s, o)
    if (!chosen.length) throw new RequestError(409, 'no suggested link is open')
    const planFile = setting.plan ? summonplanPath(setting.plan) : null
    const written: SuggestedLink[] = [], gone = new Map<number, string>()
    const r = await commitChanges(ctx, setting, async dir => {
      written.length = 0; gone.clear()
      const head = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim()
      const add = new Map<string, string[]>(), drop = new Map<string, string[]>()
      for (const x of chosen) {
        if (!await exists(join(dir, braindumpPath(x.braindump)))) { gone.set(x.n, `braindump ${x.braindump} is no longer in the catalog`); continue }
        const m = x.kind === 'add' ? add : drop
        m.set(x.project, [...(m.get(x.project) ?? []), braindumpPath(x.braindump)])
      }
      const changes: { path: string; text: string }[] = []
      const touched = new Set<string>()
      for (const [path, key] of [[planFile, 'entries'], [PROJECTS_PATH, 'projects']] as const) {
        if (!path) continue
        const t = await readTextOrNull(join(dir, path))
        if (t === null) continue
        const c = changeBecause(t, key, add, drop, key === 'entries' ? head : undefined)
        if (!c) throw new RequestError(409, `${path} cannot be read as YAML: nothing was written`)
        if (c.changed.length) changes.push({ path, text: c.text })
        for (const e of c.changed) touched.add(e.entry)
        // A project listed in this file counts as found even when its because already said so.
        for (const p of [...add.keys(), ...drop.keys()]) if (new RegExp(`^\\s*-?\\s*project:\\s*["']?${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`, 'm').test(t)) touched.add(p)
      }
      for (const x of chosen) {
        if (gone.has(x.n)) continue
        if (!touched.has(x.project)) gone.set(x.n, `project ${x.project} is no longer in the plan or in ${PROJECTS_PATH}`)
        else written.push(x)
      }
      return changes
    }, o.author, () => [`${written.every(x => x.kind === 'add') ? 'Agree' : 'Change'} ${written.length} link${written.length === 1 ? '' : 's'}: ${written.slice(0, 4).map(x => `${x.braindump} ${x.kind === 'add' ? '→' : '✕'} ${x.project}`).join(', ')}${written.length > 4 ? ', …' : ''}`, '',
      ...written.map(x => `${x.kind === 'add' ? 'because +' : 'because -'} ${x.project}: ${braindumpPath(x.braindump)}`), '',
      `Suggested by ${s.by}${s.run ? ` (${s.run})` : ''} on catalog ${s.head.slice(0, 12)}; agreed by ${o.author.trim()}.`].join('\n'))
    const at = new Date().toISOString()
    for (const x of s.links) {
      if (gone.has(x.n)) { x.state = 'gone'; x.decided = { by: o.author.trim(), at, reason: gone.get(x.n) } }
      else if (written.includes(x)) { x.state = 'agreed'; x.decided = { by: o.author.trim(), at, commit: r.commit } }
    }
    await write(ctx.area, s)
    // A review reads the projects its braindump grounds: the follow-up asks for it again, then for the index.
    if (r.changed) for (const b of new Set(written.map(x => x.braindump))) await noteFollowUp(ctx.area, { review: b, by: o.author.trim() })
    return { ok: true, message: `${written.length ? `${r.changed ? 'Wrote' : 'Already written:'} ${written.length} link${written.length === 1 ? '' : 's'} (${r.commit.slice(0, 7)}): ${written.map(x => `${x.braindump} ${x.kind === 'add' ? '→' : '✕'} ${x.project}`).join(', ')}.` : 'Nothing was written.'}${gone.size ? ` Dropped, not written: ${[...gone.values()].join('; ')}.` : ''}${r.changed ? ' The summoner reviews the braindumps whose links changed within a few minutes.' : ''}`,
      commit: r.changed ? r.commit : null, changed: r.changed, written: written.map(x => x.n), gone: [...gone.keys()] }
  }, { what: 'the link suggestion' })
}

export async function declineLinks(ctx: CatalogContext, o: { numbers?: number[]; all?: boolean; author: string }) {
  if (!o.author.trim()) throw new RequestError(400, 'declining a link needs your name')
  return withLock(file(ctx.area), async () => {
    const s = await read(ctx.area)
    if (!s) throw new RequestError(404, 'no links are suggested')
    const chosen = o.all ? s.links.filter(x => x.state === 'suggested') : pick(s, o)
    for (const x of chosen) { x.state = 'declined'; x.decided = { by: o.author.trim(), at: new Date().toISOString() } }
    await write(ctx.area, s)
    return { ok: true, message: `Declined ${chosen.length} suggested link${chosen.length === 1 ? '' : 's'}; nothing was written.`, declined: chosen.map(x => x.n) }
  }, { what: 'the link suggestion' })
}

// What a request for the summoner's workflow `ground` says; the caller queues it (one open request per head).
export async function linksRequest(ctx: CatalogContext, o: { by?: string } = {}) {
  const snap = await catalogSnapshot(ctx, { maxAgeMs: 0 })
  if (!snap.braindumps.length) throw new RequestError(409, 'the catalog has no braindump: there is nothing to link')
  const reg = await loadRegistry(ctx.registryFile)
  const ws = reg.workspaces.find(w => w.id === GROUND.project || w.project === GROUND.project)
  if (!ws) throw new RequestError(409, `no ${GROUND.project} here to suggest links: run agdevctl bootstrap-projects first`)
  const repo = `${snap.setting.repository.owner}/${snap.setting.repository.name}`
  const text = `# Suggest which braindump grounds which project\n\nFor the catalog ${repo} at head ${snap.head}: for every project of the plan ${snap.setting.plan || '(none named)'} and of ${PROJECTS_PATH}, the braindumps that ground it, each with the sentences that say so; links that exist and that you would drop; braindumps no project serves; projects left without a ground. Put it with \`wfe catalog links suggest\` (agent/ground.md). The owner agrees per link on the Catalog page; write no plan and do not read braindumps/archive/.\n\n(Requested from the Catalog page${o.by ? ` by ${o.by}` : ''}: ${snap.braindumps.length} braindump${snap.braindumps.length === 1 ? '' : 's'}.)\n`
  return { ok: true, head: snap.head, workspace: ws.id, workflow: GROUND.workflow, text, receipt: `catalog-ground-${snap.head.slice(0, 12)}` }
}

// p8: the owner's answer to a statement on disclosure (by its number) or to the default licence ('licence').
// OK adopts the rule (one commit of rules.yaml in the owner's name); No keeps nothing, and lifts the refusal of a proposed never-publish.
export async function answerDisclosure(ctx: CatalogContext, o: { n: number | 'licence'; agree: boolean; author: string }) {
  if (!o.author.trim()) throw new RequestError(400, 'answering needs your name')
  const { adoptRule } = await import('./catalogRules.ts')
  return withLock(file(ctx.area), async () => {
    const s = await read(ctx.area)
    if (!s) throw new RequestError(404, 'nothing is suggested')
    const x = o.n === 'licence' ? s.licence : (s.disclosure ?? []).find(y => y.n === o.n)
    if (!x) throw new RequestError(404, o.n === 'licence' ? 'no default licence is proposed' : `the suggestion has no statement ${o.n}`)
    if (x.state !== 'suggested') throw new RequestError(409, `already answered (${x.state})`)
    const at = new Date().toISOString()
    let message: string
    if (o.agree) {
      const r = await adoptRule(ctx, 'project' in x ? { project: x.project, follows: x.follows, source: { braindump: x.braindump, commit: s.head, sentence: x.quote }, author: o.author, proposedBy: s.by }
        : { follows: 'default-licence', licence: x.licence, source: { braindump: x.braindump, commit: s.head, sentence: x.quote }, author: o.author, proposedBy: s.by })
      x.state = 'agreed'; x.decided = { by: o.author.trim(), at, commit: r.commit }
      message = r.message
    } else {
      x.state = 'declined'; x.decided = { by: o.author.trim(), at }
      message = 'project' in x ? `Declined: nothing follows for ${x.project} from this sentence${x.follows === 'never-publish' ? '; the publication tool no longer refuses it on this proposal' : ''}.` : 'Declined: no default licence is adopted.'
    }
    await write(ctx.area, s)
    return { ok: true, message }
  }, { what: 'the link suggestion' })
}
