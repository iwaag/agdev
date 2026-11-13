// The site's own places outside this app (retire_old_ui p1, workflow_editor
// p15). The dashboard is the site's Home; aghangout, a managed project's
// application where a person talks with the project agents, is served beside
// it on the agdev origin at /hangout/. Through agdev's /wfe/ route that
// is this origin's `/hangout/`; elsewhere (the service's own port, the dev
// server) it is this installation's configured web origin, which the service
// reports on GET api/version (webOrigin, from present.json answerBase).
import type { SiteView } from '../shared/api.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'

let webOrigin: string | null = null

// Called once at start with the service's reported web origin.
export function setWebOrigin(origin: string | null | undefined) { webOrigin = origin ? origin.replace(/\/+$/, '') : null }

export function hangoutHref(): string {
  if (location.pathname.startsWith('/wfe/') || !webOrigin) return '/hangout/'
  return `${webOrigin}/hangout/`
}

// A discussion's meeting room in aghangout (p16).
export const conversationHref = (id: string) => `${hangoutHref()}?conv=${encodeURIComponent(id)}`

// The links every top-level screen offers beside its own actions.
export function siteLinks(current?: 'usage'): HTMLElement[] {
  return [
    current === 'usage' ? null : h('a.button', { href: '#/usage', title: 'Subscription windows and what executions used' }, 'Usage'),
    h('a.button', { href: hangoutHref(), title: 'Talk with the project agents (aghangout)' }, 'aghangout ↗'),
  ].filter((x): x is HTMLAnchorElement => !!x)
}

// ---- this installation's identity (agedev_selfassembly p2, docs/site.md) ----

let site: SiteView | null = null
let siteError = ''

// Called once at start, before the first view. A failure is shown on Home.
export async function loadSite(): Promise<void> {
  try {
    const r = await fetch('api/site')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    site = await r.json() as SiteView
  } catch (e) { siteError = `This installation's identity could not be read (${(e as Error).message}).` }
  document.title = siteTitle(site)
}

export const siteTitle = (s: SiteView | null) => s?.name ? `${s.name} · Workflow Editor` : 'Workflow Editor'

// The parent to link: the service checks against its configuration, this
// against the address the page was really opened under.
export function parentLink(s: SiteView, origin: string): SiteView['parent'] {
  if (!s.parent) return null
  try { return new URL(s.parent.url).origin === origin ? null : s.parent } catch { return null }
}

const external = (href: string, name: string, label: string, title: string) =>
  h('a.button.site-service', { href, title, rel: 'noopener' }, icon(name, 'icon small'), `${label} ↗`)

// The active release beside the instance id: short commit (a link to it when the source is known),
// the full commit and build time on hover; a plain statement when the service has no release record.
export function releaseBadge(r: SiteView['release']): HTMLElement {
  if (!r) return h('span.site-release', { title: 'This service runs from a source checkout, not an installed release' }, 'no release record')
  const title = `Release ${r.commit}${r.built ? `, built ${r.built}` : ''}`
  const short = r.commit.slice(0, 7)
  return h('span.site-release', {},
    r.commitUrl ? h('a', { href: r.commitUrl, rel: 'noopener', title }, h('code', short)) : h('code', { title }, short))
}

// The band at the top of Home. The name is text: the dashboard links to itself nowhere.
export function siteIdentity(): HTMLElement {
  if (!site) return h('section.site-identity', { 'aria-label': 'This installation' }, h('div.banner.warn', siteError))
  const parent = parentLink(site, location.origin)
  const problems = [...site.problems, ...(site.parent && !parent ? ['No parent link: the configured parent is the address this page was opened under.'] : [])]
  return h('section.site-identity', { 'aria-label': 'This installation' },
    h('div.site-head',
      h('h1.site-name', site.name ?? 'Unnamed agdev'),
      site.instance ? h('code.site-instance', { title: 'The generated instance id' }, site.instance) : null,
      releaseBadge(site.release),
      parent ? h('a.site-parent', { href: parent.url, rel: 'noopener', title: `Open the parent agdev, ${parent.name}. This page is ${site.name ?? 'not it'}.` },
        icon('parent', 'icon small'), h('span.site-parent-label', 'Parent'), h('strong', parent.name), h('span', { 'aria-hidden': 'true' }, '↗')) : null),
    h('nav.site-services', { 'aria-label': 'This installation\'s services' },
      site.gitea ? external(site.gitea, 'gitea', 'Gitea', 'This installation\'s Gitea') : null),
    problems.length ? h('ul.site-problems', problems.map(p => h('li', p))) : null)
}
