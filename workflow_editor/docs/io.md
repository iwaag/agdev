# Detailed IO (`workflow_editor` p10)

An attempt's harness output is its log, `<area>/.local/exec/logs/<attempt>.jsonl` on the execution host
(the agent's stdout, written by the execution host and kept with the execution store; nothing deletes
it). WFE reads it in two places and never copies it elsewhere:

- the run view's activity line and `wfe exec` (`server/activity.ts`): turns and the last write, never
  the text;
- one entry in full (`server/io.ts`, `server/ioview.ts`): `wfe run io <run> --attempt <id> --line <n>`,
  `GET /api/workspaces/<ws>/runs/<workflow>/<run>/io?attempt=&line=`, and the page
  `#/ws/<workspace>/run/<workflow>/<run>/io/<attempt>/<line>`.

## What an entry shows

A stream-json log line becomes a heading and an optional body: the session start (session, model,
harness version), the agent's public text, a tool call (`→ <tool>` and its command, path or query), a
tool result (`← <tool>`, `(error)` when it failed), the session end (outcome, turns, duration, cost) and
background-task notices. A log in another format is shown as raw text. Never shown: model reasoning
(`thinking` blocks), the harness's configuration beyond session, model and version, rate-limit and
token-accounting events. Credentials recognized by their shape (API keys, tokens, bearer and basic
credentials, URL user:password, `key=value` secrets) are masked as `***`. The raw log is never served.

## History (retired with Zulip, cluster_teamwork p5)

Until cluster_teamwork p5 the notifier also copied every run's entries into a Zulip channel of its own
(`wf-<project>.<workflow>.<run>.io`, configured by `zulip.json` `io`), cutting long bodies with a link to
the page above; its positions were kept in the notifier's store. That copy, its configuration and the `io`
status in the run view are retired (the list of credential files whose values are masked moved to
`<area>/redaction.json` `{"secretFiles": [paths]}`: values of env-style lines, secret-named JSON keys, or the
whole file, masked in the entry view besides the credential shapes); the
old implementation is in Git history only. Links in those archived messages still open the entry page.
