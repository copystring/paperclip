# Delegation, dependencies, and signoff — agent access

Product map: [Delegation, dependencies, and
signoff](../feature-map/task-coordination.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `delegation`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/issues`.

Agent access: `available` — Native create_task/reassign_task; REST / CLI / MCP.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Parent/child and provenance paths exist; same-company assignment does not remove
protected task/resource policy.

## `dependencies`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/issues/{id}`.

Agent access: `available` — Native set_dependencies for the current task; agent REST
/ native `call_api` under mutation and checkout policy.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Dedicated set_dependencies is current-task scoped. Generic `call_api`
forwards blockedByIssueIds to the REST route and retains its ownership checks.

## `signoff`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/issues/{id}`.
- `POST /api/issues/{id}/interactions`.

Agent access: `partial` — Native paperclip_finish/paperclip_block and assigned
resolve_review; legacy agent REST disposition.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Review policy determines final completion; formal board approval is a different
boundary.

Execution-stage normal and recovery wakes share the server-owned participant and
allowed-action context. Legacy reviewers record approval or changes through the
existing issue PATCH with a comment and run attribution; a final response alone
does not persist a review decision. Recovery retains its bounded retry policy and
checks the captured issue state before admission. Focused coverage lives in
`issue-execution-policy.test.ts`, `heartbeat-process-recovery.test.ts`, and
`packages/adapter-utils/src/server-utils.test.ts`; these are not a full live
qualification of signoff.

## `tree-control`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/tree-control/preview`.
- `POST /api/issues/{id}/tree-holds`.
- `POST /api/issues/{id}/tree-holds/{holdId}/release`.

Agent access: `restricted` — Board-only task-tree APIs.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Even reads/state/preview require board. There is no agent tree-control path just
from company/task permissions.
