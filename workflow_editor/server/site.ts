// What tells this installation from another (agedev_selfassembly p2,
// docs/site.md): a display name, an optional parent agdev, and the public URLs
// of its own Gitea. Read on every request from the area's files, so a
// change shows on the next page load. Distinct from the generated instance id,
// which remains the destination check (version.ts). Only what the pages show
// leaves this module: gitea.json also names credentials.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SiteView } from '../shared/api.ts'
import { codeVersion, type Release } from './version.ts'

export const SITE_FILE = 'site.json'
export const SITE_SCHEMA = 'ag.wfe-site.v1'
const MAX_NAME = 64

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

// A settings file: null when absent; an unreadable one is a problem, not an absence.
function readSettings(area: string, file: string, problems: string[]): Json | null {
  let text: string
  try { text = readFileSync(join(area, file), 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    problems.push(`${file} cannot be read: ${(e as Error).message}`)
    return null
  }
  try {
    const value = JSON.parse(text) as unknown
    if (isObject(value)) return value
    problems.push(`${file} is not a JSON object`)
  } catch (e) { problems.push(`${file} is not valid JSON: ${(e as Error).message}`) }
  return null
}

// A destination for a person's browser: http(s), no credentials, not this machine's loopback.
export function browserUrl(value: unknown): { url: string } | { problem: string } {
  if (typeof value !== 'string' || !value.trim()) return { problem: 'no URL is set' }
  let u: URL
  try { u = new URL(value.trim()) } catch { return { problem: 'it is not a URL' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { problem: 'it is not http or https' }
  if (u.username || u.password) return { problem: 'it carries credentials' }
  if (/^(localhost|127\.|0\.0\.0\.0$|\[::1?\]$)/i.test(u.hostname)) return { problem: 'it names the loopback, which other machines cannot follow' }
  return { url: u.href }
}

function displayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  // eslint-disable-next-line no-control-regex
  return name && name.length <= MAX_NAME && !/[\u0000-\u001f\u007f]/.test(name) ? name : null
}

function serviceUrl(what: string, file: string, value: unknown, problems: string[]): string | null {
  const r = browserUrl(value)
  if ('url' in r) return r.url
  problems.push(`No ${what} link: in ${file}, ${r.problem}.`)
  return null
}

// The running release as Home shows it. The commit link needs a source the release record names
// and a browser can follow; without one the commit is text.
export function releaseView(release: Release | null = codeVersion().release): SiteView['release'] {
  if (!release?.agdevworld) return null
  const src = release.source ? browserUrl(release.source) : null
  const base = src && 'url' in src ? src.url.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '') : null
  return { commit: release.agdevworld, built: release.built ?? null, commitUrl: base ? `${base}/commit/${release.agdevworld}` : null }
}

export function siteView(area: string, release: Release | null = codeVersion().release): SiteView {
  const problems: string[] = []
  const site = readSettings(area, SITE_FILE, problems)
  const name = displayName(site?.name)
  if (!name) problems.push(site ? `${SITE_FILE} has no usable name (text of at most ${MAX_NAME} characters).` : `No display name: ${SITE_FILE} sets none.`)

  let parent: SiteView['parent'] = null
  if (site && site.parent !== undefined) {
    const p = site.parent
    const parentName = isObject(p) ? displayName(p.name) : null
    const url = isObject(p) ? browserUrl(p.url) : { problem: 'it is not an object' }
    const own = readSettings(area, 'present.json', [])?.answerBase
    const ownOrigin = typeof own === 'string' && URL.canParse(own) ? new URL(own).origin : null
    if (!parentName) problems.push(`No parent link: ${SITE_FILE} parent needs a name.`)
    else if ('problem' in url) problems.push(`No parent link: in ${SITE_FILE} parent url, ${url.problem}.`)
    else if (parentName === name || new URL(url.url).origin === ownOrigin) problems.push(`No parent link: ${SITE_FILE} parent names this installation itself.`)
    else parent = { name: parentName, url: url.url }
  }

  return {
    schema: SITE_SCHEMA,
    name,
    instance: displayName(readSettings(area, 'instance.json', [])?.id),
    gitea: serviceUrl('Gitea', 'gitea.json', readSettings(area, 'gitea.json', problems)?.url, problems),
    parent,
    release: releaseView(release),
    problems,
  }
}

// Where people on other machines reach this installation's editor (the base of
// run, review and conversation links in what is sent elsewhere): present.json
// answerBase, the base the presentation server already gives for answers
// (an http(s) URL, server/present.ts). null when it is not set.
export function editorBase(area: string): string | null {
  const v = readSettings(area, 'present.json', [])?.answerBase
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v : null
}

// A Boast page's deployment-specific destination (docs/boast.md): site.json
// boastLinks.<project>.<key>. Not part of siteView: a page asks for one by name.
export function boastLink(area: string, project: string, key: string): { url: string } | { problem: string } {
  const problems: string[] = []
  const links = readSettings(area, SITE_FILE, problems)?.boastLinks
  const of = isObject(links) && Object.hasOwn(links, project) ? links[project] : undefined
  if (!isObject(of) || !Object.hasOwn(of, key)) return { problem: problems[0] ?? `this installation configures no link named ${key} for project ${project}` }
  const r = browserUrl(of[key])
  return 'url' in r ? r : { problem: `link ${key} of project ${project} is not usable: ${r.problem}` }
}
