# Telling installations apart (agedev_selfassembly p2)

Home shows which agdev this is, its own Gitea, and its parent agdev if it has
one. The browser title carries the same name. Code: `server/site.ts`, `src/site.ts`.

## Source of truth

| Shown | Read from, in the operating area | Notes |
| --- | --- | --- |
| Name, browser title | `site.json` `name` | Text of at most 64 characters. Not the instance id |
| Parent link | `site.json` `parent` (`name`, `url`) | Optional. Without it, no parent is shown |
| Gitea link | `gitea.json` `url` | Already this installation's configuration; not repeated |
| Instance id, small and beside the name | `instance.json` `id` | Generated. Still the wrong-destination check; unchanged by a name |

```json
{
  "name": "agdev-C",
  "parent": { "name": "agdev-B", "url": "http://parent.example:8082/wfe/" },
  "boastLinks": { "child": { "workflow-editor": "http://child.example:8082/wfe/" } }
}
```

`boastLinks` is for Boast pages ([boast.md](boast.md)) and is not sent to the page.
`site.json` stays in the ignored area: its values are facts of one deployment.

`GET api/site` returns the shown values only (`shared/api.ts` `SiteView`). It carries no
token path, secret list or `boastLinks`.

## When a change takes effect

The files are read on each request, so a change shows on the next page load. It needs no
restart or release, and neither of those touches `site.json`.

- **This installer**: `[display]` in `instance.toml` is the source of truth; `site.json` is generated from it
  ([install.md](../../docs/install.md#display-name-and-parent)). A fresh installation gets it from `area-init`.
  An installed one gets it from `agdevctl display`. An update never rewrites it.

## What an unusable value does

Each one is left out and listed in the band on Home, instead of showing a misleading link:
no `site.json`, unreadable JSON, a name that is not usable, a parent without a name or URL,
a URL that is not http(s), carries credentials or names the loopback, and a parent that is
this installation (same name, same configured web origin, or the address the page was opened
under). Without a name the band says "Unnamed agdev" and the title stays "Workflow Editor".
