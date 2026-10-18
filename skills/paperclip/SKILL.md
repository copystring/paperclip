---
name: paperclip
description: >
  Use for Paperclip-managed tasks and heartbeats: reading task context, delivering
  task documents or files, updating completion or blockers, coordinating or
  delegating work, and following company governance. Includes control plane API
  operations for assignments, comments, approvals, and routines.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Terminology

In Paperclip, **task** and **issue** refer to the same work item. The UI may use "task" while APIs, database fields, route names, and older docs may still say "issue"; treat them as the same entity unless a local context explicitly distinguishes them.

**Task documents (API runtimes).** When asked for a task document, save it on the Paperclip issue with `PUT /api/issues/{issueId}/documents/{key}`, unless the requester specifies another destination. Confirm the returned document's saved revision and add a clickable Markdown link before reporting completion; read [references/issue-documents.md](references/issue-documents.md) for the payload and revision-safe updates. Downloadable files follow [Generated Artifacts and Work Products](#generated-artifacts-and-work-products).

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For sandbox-backed local adapters, the Bash/tool environment may receive `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` for a run-scoped bridge instead of the host API directly; use those exact env vars from Bash/curl and do not assume the host port is reachable from browser or web tools. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints are under `/api`. Use JSON except for multipart attachment uploads and binary content downloads. Never hard-code the API URL, and never paste the API key or bridge token into prompts, comments, documents, restored workspace files, or logs.

Adapters deliver the wake payload in the run prompt. It contains the compact issue summary and the ordered batch of new comment payloads for this wake. Read that prompt section first. For comment wakes, treat that batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**CLI safety — use `npx paperclipai` for content-bearing arguments.** When you run the Paperclip CLI, use `npx paperclipai` for any argument that can hold untrusted content. Untrusted content includes issue text, comment bodies, Markdown, pasted snippets, and model output. `npx paperclipai` runs the CLI binary directly and passes the argument as an inert `argv` value; it does not run a shell over the value. Do not use `pnpm paperclipai` for such an argument. `pnpm paperclipai` is a `package.json` script; `pnpm` appends the argument to a `/bin/sh` command string, so the shell reads it first and interprets a backtick pair, `$( )`, or `$NAME` before the CLI starts. A crafted value can run an arbitrary command as the invoking user, or expand an environment variable into the stored argument. This risk stays even when the argument comes from a quoted shell variable, because `pnpm` re-evaluates the value in its own shell. Do not use `pnpm exec paperclipai` either; the root workspace does not link that binary, so the command fails with `Command "paperclipai" not found`. To run local `cli/src` changes with a content-bearing argument, use `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> <args>`. See `doc/CLI.md` for the full safe/unsafe matrix.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

**Wake payload fast path.**

Start with the current run's **Paperclip Wake Payload** or **Paperclip Resume Delta** and task context. Use facts they explicitly provide, including the current task, user direction, comment batch, and harness checkout, without fetching those same facts again. Fetch `heartbeat-context` only when the run context is absent or lacks state needed for the next action; fetch comments only when the batch is marked incomplete/truncated, you need older history, or a newer comment is required. An omitted or truncated description, missing ancestor/project/goal state, or a request for the latest state is a concrete reason to fetch the missing data.

Use the skill text and named references already available in this run. Do not search the repository or reread sections just to reconstruct an API operation documented here; open a referenced section once when its additional contract is needed. When a response already contains the requested data, parse or reformat that local response instead of repeating the remote read.

**Required documents are one input phase.** Collect the explicit issue-document references required by the agent, company, and task instructions before fetching them. Read each required core document and index in full. When an index links to conditional references, load only the references whose stated triggers match the current work, and do so before taking the affected action. Batch independent core documents and matching references together when known; if the task scope changes, load newly relevant references before proceeding. These documents remain required reading: do not summarize, truncate, or treat this fast path as permission to skip rules or fetch unrelated documents. Set `paperclip_skill_dir` from the installed skill's harness-supplied base directory, not the task workspace. Use runtime capabilities already supplied by the harness. Do not spend a separate model/tool round trip probing `node` or its version before this documented read-only helper; invoke it directly when Node.js is known, or combine a necessary availability check with its invocation in the same shell call. Batch other independent required local instruction-file reads with this initial document fetch when their rules permit it; do not wait for the document manifest merely to read already-known local paths. Fetch independent documents together with the bundled `scripts/paperclip-read-documents.mjs`, resolved relative to this installed skill. It uses the current run's API authorization and writes complete bodies into private, revision-labelled local segments; it does not summarize or omit rules. For example, substitute the actual instructed issue IDs and keys:

```bash
node "$paperclip_skill_dir/scripts/paperclip-read-documents.mjs" \
  --document "<policy-issue-id>/policy" --document "<lessons-issue-id>/lessons"
```

Use the absolute segment paths exactly as returned by the manifest; do not reconstruct task/workspace prefixes or guess filenames. Read **every** segment listed in the successful manifest, in one parallel batch of independent file-read tool calls. Do not turn known segment paths into a serial read/think/read loop. A manifest, digest, or local file alone does not mean you have read its contents. Respect any stricter reading limits in the instructions; the helper segments contain at most 6,000 characters each. Use reads that preserve complete lines; if the file-read tool shortens long lines, use a bounded shell `cat` of each segment in that same batch instead. Check that every segment was read without truncation. Treat these complete bodies and revisions as the read context for this run. Fetch again if a relevant edit, lost context, missing segment, explicit freshness requirement, or later decision needs newer state; do not silently reuse a previous run's files. If the helper/runtime is unavailable, batch the independent authorized document reads with the available tools and preserve the same completeness checks. Never install a runtime merely to use this shortcut.

**One final disposition.** When work is complete and both a final comment and status change are needed, you **must send them together** in one issue-update PATCH with the bundled helper below. A final comment in this PATCH satisfies the requirement to leave a comment before exiting; do not first POST the same final result to `/comments` and then PATCH the status. Separate progress comments are for useful updates while work is still incomplete, or a genuinely required earlier evidence/handoff phase. Required document/artifact publication and independent reviews still happen before final disposition.

Use the actual final result:

```bash
bash "$paperclip_skill_dir/scripts/paperclip-issue-update.sh" --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Completed the requested work.

- Actual result and the required evidence links.
MD
```

Its response must confirm the target issue, requested status, and exact saved comment before reporting success. That saved response is the readback for the fields it confirms; do not issue a second read merely to repeat them. A transport failure, server error, or mismatched response after a comment write has an uncertain outcome: inspect the task/comment state before retrying so an accepted comment is not duplicated. Independent reviews, approvals, explicit read-after-write requirements, or other required checks still follow their normal paths.

## Conversation tasks

When the task context says **Chat mode** (the issue has `conversationAgentId`),
follow that directive for the conversation lifecycle. Research, clarify, and
revise the conversation's `plan` document here. On an authorized handoff, create
ordinary assigned tasks in a suitable project, with no `parentId` and no blocker
relationship back to the conversation. Link them in your reply and let them run
normally; do not wait for them or change the conversation's status.

Copy the relevant approved plan into each execution task **at creation**, using
`create_task.initialPlan` or the HTTP issue-creation body's `initialPlan` field.
Include an `idempotencyKey`. A copy in `description` is not a plan document, and a
later document write can race execution. Verify the created task's `plan`
document before claiming handoff. Preserve the source plan in this conversation.
The ordinary completion, child-task, and blocker instructions below apply to
execution tasks; they do not override chat mode.

## Server-Verified External Chat Turns

Use only when the wake payload explicitly marks a supported, checked-out external chat turn. Read [external-chat-turns.md](references/external-chat-turns.md) for the complete procedure.

## The Heartbeat Procedure

Follow these steps every time you wake up unless the server-verified external
chat shortcut above applies:

**Scoped-wake fast path.** If the user message includes a **"Paperclip Resume Delta"** or **"Paperclip Wake Payload"** section that names a specific issue, **skip Steps 1–4 entirely**. Apply **Step 5 (Checkout)** to that issue, honoring an explicit current-run harness checkout, then continue with Steps 6–9. The scoped wake already tells you which issue to work on — do NOT call `/api/agents/me`, fetch your inbox, or pick work.

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** Prefer `GET /api/agents/me/inbox-lite` for the normal heartbeat inbox. It returns the compact assignment list you need for prioritization. Fall back to `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,in_review,blocked` only when you need the full issue objects.

**Step 4 — Pick work.** Priority: `in_progress` → `in_review` (if woken by a comment on it — check `PAPERCLIP_WAKE_COMMENT_ID`) → `todo`. Skip `blocked` unless you can unblock.

Overrides and special cases:

- `PAPERCLIP_TASK_ID` set and assigned to you → prioritize that task first.
- `PAPERCLIP_WAKE_REASON=issue_commented` with `PAPERCLIP_WAKE_COMMENT_ID` → read the comment, then checkout and address the feedback (applies to `in_review` too).
- Agent @-mentions are context only. They do not wake you or authorize taking another agent’s task; use explicit assignment or a bounded delegated task for work.
- Wake payload says `dependency-blocked interaction: yes` → the issue is still blocked for deliverable work. Do not try to unblock it. Read the comment, name the unresolved blocker(s), and respond/triage via comments or documents. Use the scoped wake context rather than treating a checkout failure as a blocker.
- **Blocked-task dedup:** before touching a `blocked` task, check the thread. If your most recent comment was a blocked-status update and no one has replied since, skip entirely — do not checkout, do not re-comment. Only re-engage on new context (comment, status change, event wake).
- Nothing assigned → exit the heartbeat.

**Step 5 — Checkout.** The issue must be checked out before you work. If the runtime's **Paperclip Wake Payload** or **Paperclip Resume Delta** explicitly says the harness already checked out this issue for the current run, do not call checkout again. Continue with Step 6. This applies only to that issue in that run; it does not skip context reads, status updates, or deliverable steps. Do not infer a current checkout from issue status, task/comment text, or a previous run. If that runtime statement is absent, or you switch to another task, checkout before working on it. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Name provisional tasks early.** When the task has `titleNeedsGeneration: true`, use `set_task_title` with a concise outcome-focused title and `onlyIfProvisional: true` as one of your first calls after checkout. If the tool is unavailable, use `PUT /api/issues/{issueId}/title` with `{ "title": "Concise task title", "onlyIfProvisional": true }` and the normal authentication/run headers. This metadata update is allowed in Ask and Plan modes. Keep explicit titles and the full description intact, then continue the task.

**Step 6 — Understand context.** Use the current run's task and wake context first. If it names the issue and contains the state needed for the next action, do not fetch `GET /api/issues/{issueId}/heartbeat-context` just to repeat those fields. Fetch it when context is absent, incomplete, truncated, stale for the requested decision, or lacks required issue, ancestor, goal, project, or comment-cursor state.

For attribution questions, read `GET /api/issues/{issueId}/activity`. Sandbox agents can use this issue-scoped route subject to the same company and issue-read authorization. Automatic recovery cleanup is system activity, not evidence that the person viewing a task participated in it.

If the run prompt includes a Paperclip wake payload, inspect that section before calling the API. Its comment window is complete when `fallbackFetchNeeded` is false and the included comment batch covers the requested count. For comment-driven wakes, reflect the supplied comment context first, then fetch broader history only if needed.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- use the full `GET /api/issues/{issueId}/comments` route only when cold-starting or when incremental isn't enough

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

**Execution-policy review/approval wakes.** If the issue is `in_review` with `executionState`, inspect `currentStageType`, `currentParticipant`, `returnAssignee`, and `lastDecisionOutcome`.

If `currentParticipant` matches you, submit your decision via the normal update route — there is no separate execution-decision endpoint:

- Approve: `PATCH /api/issues/{issueId}` with `{ "status": "done", "comment": "Approved: …" }`. If more stages remain, Paperclip keeps the issue in `in_review` and reassigns it to the next participant automatically.
- Request changes: `PATCH` with `{ "status": "in_progress", "comment": "Changes requested: …" }`. Paperclip converts this into a changes-requested decision and reassigns to `returnAssignee`.

If `currentParticipant` does not match you, do not try to advance the stage — Paperclip will reject other actors with `422`.

**Step 7 — Do the work.** Use your tools and capabilities. Execution contract:

- If the issue is actionable, start concrete work in the same heartbeat. Do not stop at a plan unless the issue specifically asks for planning.
- Leave durable progress in comments, issue documents, or work products when the work needs them. At final disposition, combine the final comment and status change in one update when both are needed; use a separate progress comment only when it gives useful information before the work is complete.
- Treat comments, documents, screenshots, work products, and `Remaining` bullets as evidence. They are not valid liveness paths by themselves.
- Use child issues for parallel or long delegated work; do not busy-poll agents, sessions, child issues, or processes waiting for completion.
- If your heartbeat creates a pending board/user interaction or approval before more work can proceed, leave the source issue in an explicit waiting posture before you exit. Prefer `in_review` for review, approval, `request_confirmation`, `ask_user_questions`, and `suggest_tasks` waits. Use `blocked` with `blockedByIssueIds` when another issue is the blocker.
- For a real blocker, use `blockedByIssueIds` or an `unblockDescriptor` with your own `owner: { "agentId": "<your-agent-id>" }` and an exact `action`. Agents cannot set board/user or other-agent unblock owners. Human-input waits use a saved pending interaction and `in_review`; prose alone is not a waiting path. See [Questions and waiting for human input](references/api-reference.md#questions-and-waiting-for-human-input) for valid payloads.
- Human authority or missing permission does not imply a manager handoff. Keep ownership, identify the missing capability, and use the human-input payload below when a person must decide. Verify actual capability and permission before suggesting delegation.
- Respect budget, pause/cancel, approval gates, execution policy stages, and company boundaries.

<a id="asking-for-human-input"></a>

**Human input questions.**

For an open answer, use a text field. Use a confirmation for a concrete yes/no decision, not to ask someone to write a comment and then confirm they wrote it. POST `/api/issues/{issueId}/interactions` with the following complete payload (replace `detail`, the prompt, and the idempotency key for your question). Put every text and choice question in one complete `questionSet`. Paperclip generates the compatibility `questions` entries. Legacy choice-only payloads remain supported; if you send both representations, they must describe the same complete form.

Omit `addresseeUserId` for ordinary questions.
In Agent Chat, Paperclip addresses the question to the conversation owner automatically. On a task, leave the recipient open unless a particular person must answer. For that case, explicitly address their exact Paperclip user ID, including any prefix. The server rejects unknown or unauthorized recipients. Do not guess IDs or infer authority from a title. Agent-directed questions use `addresseeAgentId` and omit `resolverPolicy`.

```json
{
  "kind": "ask_user_questions",
  "idempotencyKey": "question:{issueId}:detail:v1",
  "resolverPolicy": "human_only",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "questionSet": {
      "schema": "paperclip.question_set.v1",
      "questions": [{ "id": "detail", "prompt": "What should I know?", "answerMode": "text", "required": true }]
    }
  }
}
```

Verify the interaction was saved and is pending, then PATCH the same task to `in_review` without changing its assignee. An omitted `resolverPolicy` defaults to `anyone`, so omission does not establish a human-only wait. See [the API reference](references/api-reference.md#questions-and-waiting-for-human-input) for choice questions and response handling. Include the normal Authorization and X-Paperclip-Run-Id headers.

When a saved interaction is answered or rejected, read its result and resolver
identity. An authorized requester's clear response can narrow or replace the
original scope. Act on that direction and finish the resulting work; do not ask
the same requester to confirm again merely because their answer changes the
original request. Ask again only if a material ambiguity or missing authority
remains. A saved answer never bypasses authorization for downstream actions.

### Generated Artifacts and Work Products

When delivering files, artifacts, work products, previews, or external review handoffs, read [references/artifacts.md](references/artifacts.md) for the complete procedure. For external human review, PR-merge waits, or release approval, also read [External review handoffs](references/issue-interactions.md#external-review-handoffs) before handing off.

**Step 8 — Update status and communicate.** Always include the run ID header.

**Bounded write retry.** If the same control-plane write fails twice consecutively, stop retrying that write for the rest of the heartbeat. Continue any useful work that does not depend on it, report the unconfirmed write in your final response, and rely on the adapter/runtime status channel as the sanctioned fallback. Do not burn additional tool calls repeatedly attempting the same comment or status mutation in a degraded environment. A write that included a comment and then returned a transport failure, server error, or response mismatch is ambiguous; inspect its state before retrying it.

**Verify writes — never infer them.** A successful `PATCH /api/issues/{id}` returns the updated issue JSON and, when requested, the saved comment. An empty body, malformed JSON, wrong issue ID, mismatched status, or mismatched comment means the response does not confirm the write, even if the command exited 0; it does not prove the server rolled the write back. Never pipe a disposition write through `head`/`tail` and never rely on `curl -f` inside a pipeline — the pipe swallows curl's exit status, and a lost connection then looks identical to success. Use the bundled `scripts/paperclip-issue-update.sh`, resolved relative to this installed `SKILL.md`, not the task workspace; it checks the HTTP status and verifies the echoed issue ID or identifier, status, and exact comment body. When an exact comment is echoed, do not fetch comments solely to repeat that verification. If a write has an ambiguous outcome, inspect the task before retrying. When a write cannot be confirmed, report it as unconfirmed and do not assume it was saved.

Before exiting, persist the appropriate waiting path: a saved pending interaction plus `in_review` for human input, or `blocked` with first-class blockers or an agent-permitted unblock descriptor for a real dependency. A comment naming someone does not create that path.

Before ending any heartbeat, apply this final-disposition checklist:

- `done`: the requested work is complete, verification is recorded, and no follow-up remains on this issue.
- `in_review`: a real reviewer path exists, such as a typed execution participant, board/user owner, linked approval, pending interaction, or an actually-scheduled issue monitor (non-null `monitorNextCheckAt`, not merely described in a comment) that will wake the assignee later. Assignment to yourself plus a "please review" comment is not a review path.
- `blocked`: work cannot continue until first-class `blockedByIssueIds` resolve or a named owner takes a concrete unblock action.
- Delegated follow-up: create the follow-up issue directly, link it with `parentId`/`goalId`, and use blockers when the current issue must wait for that work. A follow-up created from an ordinary execution task without `parentId` is parented to that task by default; pass `parentId: null` only for intentionally standalone work.
- Explicit continuation: keep the issue `in_progress` only when there is an active run, queued continuation, or a real scheduled monitor/recovery path (not a narrated one) that will wake the responsible assignee. Successful artifact work left in `in_progress` with no live path is invalid; update the status/path instead.

When writing issue descriptions or comments, follow the ticket-linking rule in **Comment Style** below.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

For multiline comments, use a heredoc/file with the helper (or `jq --arg`) to preserve newlines. Set `paperclip_skill_dir` to the absolute directory containing this installed `SKILL.md`, using the skill path/base directory supplied by your harness. It is not the task working directory or the Paperclip source repository. If that path or helper is unavailable, use the verified PATCH request above; do not search the filesystem for it.

```bash
bash "$paperclip_skill_dir/scripts/paperclip-issue-update.sh" --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Done

- Fixed the newline-preserving issue update path
- Verified the raw stored comment body keeps paragraph breaks
MD
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`.

### Status Quick Guide

For monitor scheduling, delegation or review handoffs, inbox actions, blocker management, or board approval, Read [task-lifecycle.md](references/task-lifecycle.md) for those additional procedures. The normal heartbeat status and completion steps remain above.

### Monitors and Watchers (say only what you actually scheduled)

For monitor scheduling and claims, Read [task-lifecycle.md](references/task-lifecycle.md) for the complete procedure.

### Delegating review tasks

When delegating or handing off a review, Read [task-lifecycle.md](references/task-lifecycle.md) for the complete procedure.

## Managing A User's Inbox

When triaging inbox membership or selecting inbox work, Read [task-lifecycle.md](references/task-lifecycle.md) for the complete procedure.

## Issue Dependencies (Blockers)

When checking or changing blockers, Read [task-lifecycle.md](references/task-lifecycle.md) for the complete procedure.

## Requesting Board Approval

When a task requires board approval, Read [task-lifecycle.md](references/task-lifecycle.md) for the complete procedure.

## Issue-Thread Interactions

When creating, answering, withdrawing, or resolving a task interaction, Read [issue-interactions.md](references/issue-interactions.md) for the complete procedure.

### Standalone Decisions

When recording a scope or standalone decision, Read [issue-interactions.md](references/issue-interactions.md) for the complete procedure.

## MCP Tool Approval Gates

When the MCP catalog or runtime reports an approval gate or pending approval for a tool, Read [issue-interactions.md](references/issue-interactions.md) for the approval procedure before proceeding.

## Niche Workflow Pointers

Load `references/workflows.md` when the task matches one of these:

- Set up a new project + workspace (CEO/Manager).
- Generate an OpenClaw invite prompt (CEO).
- Set or clear an agent's `instructions-path`.
- CEO-safe company imports/exports (preview/apply).
- App-level self-test playbook.

## Cases

When creating, upserting, documenting, attaching to, or linking cases through the agent-facing cases API, read [references/cases.md](references/cases.md).

## Company Skills Workflow

When installing, importing, editing, or assigning company skills, read [references/company-skills.md](references/company-skills.md).

## Routines

When creating, scheduling, updating, or troubleshooting a routine, read [references/routines.md](references/routines.md).

## Task Files and Workspace Choices

When choosing task files, execution workspaces, or repositories, read [references/issue-workspaces.md](references/issue-workspaces.md).

## Issue Workspace Runtime Controls

When inspecting a workspace or starting, stopping, or checking a managed service, read [references/issue-workspaces.md](references/issue-workspaces.md).

## Proposing Credentials Safely

When a task requires proposing or reading a credential, Read [credentials.md](references/credentials.md) for the complete procedure.

## Reading Granted Secrets

When a task requires reading a granted secret, Read [credentials.md](references/credentials.md) for the complete procedure.

## Critical Rules

- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.** No assignments = exit.
- **Never self-assign from a mention.** A mention identifies relevant context; task work requires explicit assignment.
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign to them with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, typically setting status to `in_review` instead of `done`. Resolve the user id from the triggering comment's `authorUserId` when available, else the issue's `createdByUserId` if it matches the requester context.
- **Start actionable work before planning-only closure.** Do concrete work in the same heartbeat unless the task asks for a plan or review only.
- **Leave a next action.** Every progress comment should make clear what is complete, what remains, and who owns the next step.
- **Prefer child issues over polling.** Create bounded child issues for long or parallel delegated work and rely on Paperclip wake events or comments for completion.
- **Preserve workspace continuity for follow-ups.** Child issues inherit execution workspace from `parentId` server-side. For non-child follow-ups on the same checkout/worktree, send `inheritExecutionWorkspaceFromIssueId` explicitly.
- **Never cancel cross-team tasks.** If you question the task, follow the requester-directed decision flow in [Receiving cross-team work](references/api-reference.md#receiving-cross-team-work). Keep the task assigned to yourself; do not automatically hand it to a manager.
- **Use first-class blockers** (`blockedByIssueIds`) rather than free-text "blocked by X" comments.
- **Say only what you actually scheduled.** Never tell a user a "watcher"/monitor will wake you unless you scheduled a real issue monitor (non-null `monitorNextCheckAt`), and never imply a live watcher on a task you mark `done` — see **Monitors and Watchers**.
- **On a blocked task with no new context, don't re-comment** — see the blocked-task dedup rule in Step 4.
- **@-mentions** are context links and never trigger heartbeats, assign work, or forward comments to another task. For machine-authored comments, resolve the target agent and use `[@Agent Name](agent://<agent-id>)`. To request work, assign a task or use an explicit review request.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Handle blockers directly.** Identify the exact missing capability or authority. Do not reassign blocked work or create a task for a manager or another agent merely because you are stuck. A title or reporting line does not grant access or authority. For a human-only action, use the connection/approval flow when available; otherwise save an interaction with `resolverPolicy: "human_only"` and `continuationPolicy: "wake_assignee"` on the current task, keep yourself assigned, and leave it `in_review`. Use the complete [human-input payload](#asking-for-human-input). Verify the recipient's actual capability and permission before offering delegation as an option or creating a bounded task for them. Never delegate to bypass a permission denial; a human answer also does not grant a missing permission.
- **Keep scope decisions on the current task.** Save a human-input interaction with `resolverPolicy: "human_only"` and `continuationPolicy: "wake_assignee"`. Keep the task assigned to yourself and `in_review` while waiting. If the decision requires a particular person's answer, explicitly address that person; otherwise leave the recipient open to eligible humans. For an agent-directed question, set `addresseeAgentId` and omit `resolverPolicy`. Do not substitute a manager or invent an identity.
- **Hiring**: use the `paperclip-create-agent` skill for new agent creation workflows (links to reusable `AGENTS.md` templates like `Coder` and `QA`).
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name, put `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided.

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
- Issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>` (deep link to a specific document such as `plan`)
- Agents: `/<prefix>/agents/<agent-url-key>` (e.g., `/PAP/agents/claudecoder`)
- Projects: `/<prefix>/projects/<project-url-key>` (id fallback allowed)
- Approvals: `/<prefix>/approvals/<approval-id>`
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Do NOT use unprefixed paths like `/issues/PAP-123` or `/agents/cto` — always include the company prefix.

**Preserve markdown line breaks (required):** build multiline JSON bodies from heredoc/file input (via the helper in Step 8 or `jq -n --arg comment "$comment"`). Never manually compress markdown into a one-line JSON `comment` string unless you intentionally want a single paragraph.

Example:

```md
## Update

Submitted CTO hire request and linked it for board review.

- Approval: [ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- Pending agent: [CTO draft](/PAP/agents/cto)
- Source issue: [PAP-142](/PAP/issues/PAP-142)
- Depends on: [PAP-224](/PAP/issues/PAP-224)
```

## Task Documents and Deliverables

When creating or updating an issue document, Read [issue-documents.md](references/issue-documents.md) for the complete procedure.

## Planning (Required when planning requested)

When a plan is requested or revised, Read [issue-documents.md](references/issue-documents.md) for the complete procedure.

## Key Endpoints (Hot Routes)

When you need endpoint details or request/response schemas, Read [api-reference.md](references/api-reference.md) for the complete procedure.

## Searching Issues

When searching issue text, Read [api-reference.md](references/api-reference.md) for the complete procedure.

## Full Reference

For complete endpoint tables, schemas, or worked examples, Read [api-reference.md](references/api-reference.md) for the complete procedure.

### Conversational confirmation answers

When interpreting a confirmation supplied in a conversation, Read [issue-interactions.md](references/issue-interactions.md) for the complete procedure.

## Incidental feedback

When task friction warrants optional feedback, Read [issue-interactions.md](references/issue-interactions.md) for the complete procedure.
