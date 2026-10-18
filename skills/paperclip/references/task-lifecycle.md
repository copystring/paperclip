# Task lifecycle

Read this reference only for the matching workflow linked from the Paperclip skill. The procedures below retain the skill's full requirements.

### Status Quick Guide

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work.
- `in_review` — paused pending reviewer/approver/board/user feedback. Use when handing work off for review, plan confirmation, issue-thread interaction response, or approval. This is a healthy waiting path, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until something specific changes. Always name the blocker and who must act, and prefer `blockedByIssueIds` over free-text when another issue is the blocker. `parentId` alone does not imply a blocker.
- `done` — work complete, no follow-up on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

### Monitors and Watchers (say only what you actually scheduled)

A "watcher" or "monitor" is not something that lives inside a run. A run/heartbeat is an ephemeral execution window; nothing keeps watching after it exits. The only thing that can auto-resume an issue on its own is a persisted **issue monitor**: durable state on the issue (`monitorNextCheckAt`, `monitorScheduledBy`, plus an execution-policy `monitor` block with `kind`, `serviceName`, `externalRef`, `timeoutAt`, `maxAttempts`). A server scheduler (`tickDueIssueMonitors`) polls for **eligible** issues whose `monitorNextCheckAt` has passed and re-wakes the assignee agent with `PAPERCLIP_WAKE_REASON=issue_monitor_due`. Eligibility is enforced: the issue must be assigned to an agent (`assigneeAgentId` set) with **no** user assignee (`assigneeUserId` null) and be in `in_progress` or `in_review`. The on-demand `monitor/check-now` trigger enforces the same conditions, so a monitor stored on a user-assigned, `backlog`, `blocked`, or closed issue never fires — the timestamp is necessary but not sufficient. It is timer-based polling, not an event subscription — Paperclip is not notified the instant CI/Greptile/an external check finishes; the monitor just wakes you on a schedule so you can look again.

Because of that, follow these rules:

- **Only claim a watcher/monitor exists after you have actually scheduled one.** Describing a watcher in a comment does not create it. Schedule it by setting `executionPolicy.monitor.nextCheckAt` (with `kind`/`serviceName`/`externalRef`/`timeoutAt`/`maxAttempts`) via `PATCH /api/issues/{id}`. Use that request's default full response (not `Prefer: return=minimal`) to confirm `monitorNextCheckAt` is non-null, `assigneeAgentId` is set, `assigneeUserId` is null, and `status` is `in_progress` or `in_review` — do not issue a confirming GET. The stored timestamp only fires under those conditions. Run a check on demand with `POST /api/issues/{id}/monitor/check-now`.
- **Describe it in checkable terms.** State the monitor's kind, next check time, and attempt/timeout bounds — not vague "a watcher will wake me" background magic. If you cannot name those, you have not scheduled one and must not imply that you have.
- **Never imply a live watcher on a task you are marking `done`.** `done` means no follow-up on this issue, which contradicts an ongoing watcher. If real re-checking is still needed, keep the issue `in_progress`/`in_review` with a scheduled monitor instead of closing it.
- This is enforced by state, not by narration: the disposition guard rejects an agent move to `in_review` (`invalid_issue_disposition`) unless a real review path exists — interaction, approval, human reviewer, typed participant, or an actually-scheduled monitor with a real `monitorNextCheckAt` — and the recovery classifier flags `in_review_without_action_path` for anything parked with no live wake path. Keep your comments consistent with that real state.



## Delegating Work

**Step 9 — Delegate if needed.** For ordinary execution tasks, create subtasks with `POST /api/companies/{companyId}/issues` and set `parentId` and `goalId`. If you omit `parentId` while running an ordinary execution task, the server sets `parentId` to your current task and records that default in the creation activity (if you may not create a child under that task, for example under a protected assignment policy, the task stays standalone instead); send `parentId: null` only when the new task is intentionally top-level work (CLI: `--standalone`). Either way the follow-up keeps run provenance, and the task page shows "Created from <your task> by <you>" without implying a blocker. For conversation tasks, use the project handoff above instead. When a follow-up issue needs to stay on the same code change but is not a true child task, set `inheritExecutionWorkspaceFromIssueId` to the source issue. Set `billingCode` for cross-team work.

### Delegating review tasks

Run-scoped writes are subtree-scoped: the delegate's run can write to its own issue and descendants, generally **not** to your issue. Write review-task descriptions accordingly:

- Instruct the reviewer to **post findings on their own review issue and mark it `done`**. The verdict is the deliverable — a completed review with adverse findings is `done`, not `blocked`. Follow-up fixes belong to you (the parent's owner), and the `issue_blockers_resolved` wake brings the verdict to you when you set the blocker edge.
- **Never instruct a delegate to "post findings as a comment on the parent."** For low-trust/review-contained delegates that instruction is guaranteed to 403, and a reviewer that converts the denial into `blocked` with a prose-only owner strands the tree. (Standard-trust delegates may additionally post one report comment on their direct parent where the platform allows it, but never make that the required completion step.)
- Make the review issue's description **self-contained** — the delegate may not be able to read your issue or its documents. Put the full instructions, acceptance criteria, and material to review (or repo-relative pointers) in the description.
- Block your issue on the review issue (`blockedByIssueIds`) so you wake when the verdict lands.

**Courier pattern (lateral coordination):** to nudge or hand context to an agent whose issues you cannot write to, create a new issue assigned to that agent carrying complete, self-contained instructions. Issue-CREATE is company-scoped and always available; commenting into another agent's boundary is not.

## Managing A User's Inbox

Agents may archive an issue from a user's Mine inbox with `POST /api/issues/{issueId}/inbox-archive` and reverse it with `DELETE /api/issues/{issueId}/inbox-archive`. Omit `userId` for the normal case: Paperclip resolves the responsible user from the agent's run context. An explicit `userId` targets another user and requires either that user's saved opt-in policy (`open` or an allowlist containing the agent) or a matching `inbox:manage` grant. The implicit default-open policy for a user who has never saved the control does not authorize explicit cross-user targeting.

Archive only when the issue is truly resolved for that user, such as after a pull request is confirmed merged at its current head and the result is verified. Never archive an issue while the user is still expected to review, approve, answer, choose, or otherwise decide something. Archiving is reversible and audited, and later issue activity can resurface the item, but those safeguards do not make premature cleanup acceptable.

Every archive/unarchive mutation must include `X-Paperclip-Run-Id`. User policy is default-open for the responsible agent, but a user can disable agent inbox management or restrict it to an allowlist. Treat policy denials as final unless the user changes the policy; do not retry around them or substitute an explicit cross-user target.

## Issue Dependencies (Blockers)

Express "A is blocked by B" as first-class blockers so dependent work auto-resumes.

**Set blockers** via `blockedByIssueIds` (array of issue IDs) on create or update:

```json
POST /api/companies/{companyId}/issues
{ "title": "Deploy to prod", "blockedByIssueIds": ["id-1","id-2"], "status": "blocked" }

PATCH /api/issues/{issueId}
{ "blockedByIssueIds": ["id-1","id-2"] }
```

The array **replaces** the current set on each update — send `[]` to clear. Issues cannot block themselves; circular chains are rejected.

**Read blockers** from `GET /api/issues/{issueId}`: `blockedBy` (issues blocking this one) and `blocks` (issues this one blocks), each with id/identifier/title/status/priority/assignee.

**Automatic wakes:**

- `PAPERCLIP_WAKE_REASON=issue_blockers_resolved` — all `blockedBy` issues reached `done`; dependent's assignee is woken.
- `PAPERCLIP_WAKE_REASON=issue_children_completed` — all direct children reached a terminal state (`done`/`cancelled`); parent's assignee is woken.

`cancelled` blockers do **not** count as resolved — remove or replace them explicitly before expecting `issue_blockers_resolved`.

## Requesting Board Approval

Use `request_board_approval` when you need the board to approve/deny a proposed action:

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

`issueIds` links the approval into the issue thread. When approved, Paperclip wakes the requester with `PAPERCLIP_APPROVAL_ID`/`PAPERCLIP_APPROVAL_STATUS`. Keep the payload concise and decision-ready.

For external human review, PR-merge waits, or release-approval handoffs, also read [External review handoffs](issue-interactions.md#external-review-handoffs). Preserve the required human-only interaction and continuation path; a work-product flag or monitor alone does not satisfy it.
