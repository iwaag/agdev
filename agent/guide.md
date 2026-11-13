# agdev-agent

You develop agdev, the system you are running on. You speak with the person or agent who asked
for the work, through your run. You can see your run copy of this repository, the installation's
`wfe`, `agdev-remote` and `agdev-update` (each has `--help`), and the checks below.

## Where you are

Every installation (a main one and its children) runs an installed release, built from an exact
commit on `main` of the canonical repository, which is on the main installation's Gitea. Editing your copy changes nothing that runs. Your copy, your project's repository and any
installation's release are separate things. If your project's repository is not the canonical one
(a child's own `owner/agdev` may not be), integration there reaches no installation until a developer publishes
the commit to canonical `main`; say so in your result.

A child gets its release through its parent: `wfe manage update <child> <commit>` on the parent, which the
child's own lifecycle builds, drains and switches. The main installation adopts its own releases with `agdev-update`.

## Candidates

A change may be tried on a candidate installation: another agdev on another machine, with its own
identity, services, stores, credentials, agents and projects, that its owner designated as
disposable for trials. `agdev-remote targets` lists what your installation may operate, with each
target's `role`:

- `candidate`: you may `agdev-remote deploy` your exact commit to it, observe it and repair it.
- `recovery`: a node with durable work (a child's own child, for example). Read its status and logs, and
  repair a stopped service if asked; never deploy to it (it refuses: `not-a-candidate`).

Enrollment under a parent, reachability or an SSH route never make an installation a candidate.
Today no candidate is designated.

## The development contract

1. Change and check the change in your copy, and commit it.
2. If a candidate is listed, deploy that exact commit (`agdev-remote deploy`) and wait for its update
   to end. A build can take tens of minutes; keep working meanwhile. If the answer is lost, the
   request id finds it, and asking again never makes a second update. Observe the change through what
   the candidate actually serves: its API, its pages and its agents. An HTTP status or a passing test
   alone is not that observation. Read the records behind what you conclude.
3. Without a candidate, say plainly in your result that the change was not tried on a running
   installation and what was checked instead. Do not overwrite a node's release to try it.
4. Finish the run. Integration puts your work on `main` of your project's repository with a
   checkpoint commit.
5. Adoption is a separate decision: publishing to canonical `main`, then `wfe manage update` from the parent for
   a child (or `agdev-update request <commit>` on the installation itself). Check a tried candidate
   against the adopted commit with `agdev-remote same-runtime <tested> <commit>`.

Publishing is not adoption, and `main` moving activates nothing. Record the commits you tested and
adopted, and any difference between them. Store and configuration compatibility is part of
adoption: a fresh candidate's success does not show that a node's existing state upgrades. When the
change touches stores or configuration, try it on a copy of a suitable state first.

## Checks

This repository has no automated test suites; do not add any. Verify a change minimally: run
`cd workflow_editor && npm ci --no-audit --no-fund && npm run build` when TypeScript or the UI
changed, then check the affected behaviour directly once. Fix problems when they appear. Keep a
one-off verification script outside the repository, in your run envelope (`$AGDEV_WORKSPACE`),
not in tracked source.

`PROVENANCE.md` says what this repository came from. Contract documents live beside the code they
describe and change in the same work. `docs/install.md` describes installations, updates, children
and candidates.
