# Zulip intake (p6) — retired

> **Retired with Zulip (cluster_teamwork p5).** WFE has no Zulip intake any more, and the old
> implementation (`server/intake.ts`, `wfe intake`, the transport `agautolab.wfintake`) is in Git
> history only. People request, answer and instruct in WFE (conversation and run views, `wfe
> conversation`, `wfe run answer|instruct`); machine requesters submit
> ([submissions.md](submissions.md)); local delegations are delivered directly
> ([delegation.md](delegation.md)); other installations are reached over HTTP ([peers.md](peers.md)).

From p6 until cluster_teamwork p5 a post in a workflow's Zulip channel (`wf-<project>.<workflow>`) could
become recorded workflow input: a `request-…` topic opened a run, later posts in it became answers and
additional instructions. What that left behind is data, and WFE keeps reading it as such:

| Recorded | Where | Read as |
| --- | --- | --- |
| `input.source`, an answer's or instruction's `source` `{kind: zulip, realm, message, stream, topic, sender, senderName, at}` | run.json history | where the words were said: "Zulip message <id>" (`shared/intake.ts` `sourceLabel`) |
| receipts `zulip:<realm>:<message id>`, `via: zulip` | run.json history | identities of the applications; replay is unchanged |
| a delegation's `transport` `{realm, message, stream, topic}` | the parent's `delegation.bind` | the request post the child was bound from |
| `intake: {zulip: requests | ""}` | workflow definitions | whether the workflow takes requests (`acceptsRequests`; [contract.md](contract.md)) |
| `<area>/.local/intake/intake.sqlite` | the host | not read by WFE; kept by the operator with the realm's export |

The words and whose they were stay in the records; nothing is rewritten. A workflow's opt-out (`zulip:
""`) keeps meaning "no requests", by any route.
