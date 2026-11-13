// Which code this process runs. An installed release carries RELEASE.json,
// written by agdev's scripts/wfe-release.sh: the agdev commit it was
// built from. A source checkout has none. The service (GET api/version) and
// the CLI (wfe version) report the same thing, so the browser, the API and the
// launcher can be traced to one commit.
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface Release { agdevworld: string; tree: string; built: string; pyagag?: string; runtime?: string; source?: string }
export interface CodeVersion { package: string; release: Release | null; source: 'release' | 'checkout' }

// The installation this area belongs to: <area>/instance.json, written when it was
// initialized and kept across a move. A process given AGDEV_INSTANCE_ID (or a client
// that sends it) names the installation it means to act on; a difference is reported
// before anything is done. A destination check, not an approval (docs/install.md).
export function areaInstance(area: string): string | null {
  try { return String((JSON.parse(readFileSync(join(area, 'instance.json'), 'utf8')) as { id?: string }).id ?? '') || null } catch { return null }
}

export function instanceMismatch(area: string, expected = process.env.AGDEV_INSTANCE_ID): string | null {
  const here = areaInstance(area)
  if (!expected || !here || expected === here) return null
  return `wrong instance: this client belongs to ${expected}, but ${area} is instance ${here}; nothing was done`
}

export function codeVersion(): CodeVersion {
  const pkg = realpathSync(PACKAGE_DIR)
  try {
    const release = JSON.parse(readFileSync(join(pkg, 'RELEASE.json'), 'utf8')) as Release
    return { package: pkg, release, source: 'release' }
  } catch { return { package: pkg, release: null, source: 'checkout' } }
}
