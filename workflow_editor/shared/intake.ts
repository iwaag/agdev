// Where recorded workflow input came from, and the recorded forms of
// additional instructions (shared/run.ts reads and replays them).
//
// Named "intake" after the Zulip intake (p6) that first recorded these
// shapes. That intake is retired (cluster_teamwork p5); people now speak
// through WFE's conversations and run views, machines through submissions,
// delegations are delivered directly and other installations over HTTP.
// Every source kind below stays readable, including the Zulip one recorded
// histories carry.

// Where a recorded input came from: kept with the answer or instruction it
// became, so it can always be traced back to where it was said.
// `zulip`: a post the retired Zulip intake applied (until cluster_teamwork
// p5); recorded histories keep it and it is read as such, never produced now.
export interface ZulipSource { kind: 'zulip'; realm: string; message: number; stream: number; topic: string; sender: number; senderName: string; at: string }
// A message of a conversation (project_migration p8, docs/conversations.md):
// the person's words as they were said at the entrance.
// `invitation`: in a discussion (p16, docs/discussions.md), the invitation
// the run was started for.
// `attachments` (challenge p1, docs/challenges.md): what the message carried,
// each challenge pinned to the revision it was sent with, each file (p19) by
// its occurrence.
export interface ConversationSource { kind: 'conversation'; conversation: string; message: number; author: string; at: string; invitation?: number; attachments?: AttachmentRef[] }
// A challenge attached to a message or a request, at one revision of the
// challenge repository: the commit, the title it had and the file's sha256.
export interface ChallengeAttachmentRef { kind: 'challenge'; id: string; commit: string; title: string; sha256: string }
// A file a person's message carried (workflow_editor p19,
// docs/message-files.md): one occurrence of original bytes on a share, by the
// identity WFE allocated (attachment id, bundle) and the message it was
// accepted with — conversation, message, position — with the original name,
// the client's media type hint, the size and the sha256.
export interface FileAttachmentRef { kind: 'file'; id: string; bundle: string; conversation: string; message: number; ordinal: number; name: string; mime: string; bytes: number; sha256: string; ref: string }
export type AttachmentRef = ChallengeAttachmentRef | FileAttachmentRef
export const attachmentLabel = (a: AttachmentRef) => a.kind === 'file' ? `file "${a.name}" (${a.id}, ${a.bytes} bytes) of ${a.conversation} #${a.message}` : `challenge ${a.id} "${a.title}" at ${a.commit.slice(0, 12)}`
// cluster_teamwork p2: an envelope another installation delivered over HTTP —
// the authenticated sending instance and the envelope's own id, never a
// manufactured Zulip post.
export interface PeerSource { kind: 'peer'; route: 'http'; peer: string; message: string; at: string }
// cluster_teamwork p4: delivered directly by WFE from a local parent's
// delegation (no post): the delegation uid and which item of its record
// (`request`, `answer:<n>`, `instruction:<n>`, `revision:<n>`).
export interface DelegationSource { kind: 'delegation'; route: 'direct'; delegation: string; item: string; at: string }
// cluster_teamwork p4: a machine requester's submission through WFE (Observer's
// recovery request): who submitted it, its receipt, what it is about.
export interface SubmissionSource { kind: 'submission'; requester: string; receipt: string; at: string; about?: string }
export type SourceRef = ZulipSource | ConversationSource | PeerSource | DelegationSource | SubmissionSource
// How a source is named to a reader. The Zulip form is the one recorded
// decisions were written with (their evidence is derived from it on replay).
export const sourceLabel = (s: SourceRef) => s.kind === 'zulip' ? `Zulip message ${s.message}` : s.kind === 'peer' ? `${s.peer}'s ${s.route.toUpperCase()} message ${s.message}` : s.kind === 'delegation' ? `delegation ${s.delegation} ${s.item} (delivered directly)` : s.kind === 'submission' ? `${s.requester}'s submission ${s.receipt}` : `conversation ${s.conversation} message #${s.message}${s.invitation ? ` (invitation ${s.invitation})` : ''}${s.attachments?.length ? `, with ${s.attachments.map(attachmentLabel).join(', ')}` : ''}`

// ---- additional instructions in the run ----------------------------------------------------------

// An additional instruction is run history (shared/run.ts instruction.receive
// / instruction.ack). Receipt by the run is not reading: the executing
// attempt acknowledges it at a node boundary, saying what it will do.
export const INSTRUCTION_RESPONSES = ['incorporate', 'clarify', 'new-run'] as const
