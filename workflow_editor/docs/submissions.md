# Requests by any route and machine submissions (`cluster_teamwork` p4)

## Whether a workflow takes requests

`intake.requests: true|false` in a workflow definition says whether it takes requests at all — a local
delegation (delivered directly by WFE, [delegation.md](delegation.md)), a request from another
installation ([peers.md](peers.md)) or a machine submission. Absent, it means what the older
`intake.zulip` key says (requests unless `zulip: ""`; the key is named after the retired Zulip intake,
[intake.md](intake.md), and is kept as data), so an opt-out is never opened silently. New workflow files
declare `intake: {requests: true}`. A wrong type makes the file unreadable; it is never read as either
value. An opt-out describes what the workflow's runs are for, not whether its project takes work from
others.

## Submissions

A machine requester on this installation (Observer asking a recovery agent) opens a run through WFE
itself, durably and idempotently (`server/submissions.ts`):

- `wfe submit --requester <name> --workflow <project>/<workflow> --key <key> --text-file <file|->
  [--about <text>] [--workspace <id>]`, or `POST /api/submissions` `{requester, workflow, key, text,
  about?, workspace?}`.
- Receipt `submission:<requester>:<key>`: the same receipt is the same run (`200`, `duplicate`); a new
  one is created once (`201`) and started by the execution queue (job receipt `request:<receipt>`).
  `GET /api/submissions/<receipt>` (`wfe submit --show <receipt>`) names the bound run.
- The run's input is an ordinary `request` in the requester's name, with `source {kind: submission,
  requester, receipt, at, about}`.
- Permission: `<area>/submitters.json` `{version: 1, submitters: [{name, workflows:
  ["<project>/<workflow>", …]}]}` and nothing else — without that file nobody may submit. A malformed
  file is refused (`503`), never read as empty. The workflow must take requests.
- Without `--workspace`, a project with several workspaces here is resolved by `<area>/workspaces.json`
  as for delegations ([delegation.md](delegation.md)); ambiguity is refused.
