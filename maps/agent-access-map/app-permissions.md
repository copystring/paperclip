# App access, action permissions, and testing — agent access

Product map: [App access, action permissions, and
testing](../feature-map/app-permissions.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `agent-access`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PUT /api/tool-connections/{connectionId}/installs`.

Agent access: `restricted` — Board management API; agents use their resulting assigned
app tools.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Granting access is distinct from using access. No equivalent agent management path
exists in these routes.

The OpenCode local adapter delivers the already assigned runtime MCP servers
through a private, temporary remote-MCP configuration. This delivery does not
change grants, profiles, or action policies. Adapter tests cover authentication,
configuration preservation, and cleanup; a synthetic Linux CLI connection and
tools/list probe checks transport only, not every assigned app action.

On-demand discovery ranks query terms across tool names, application names and
descriptions after deriving the caller's authorized tool set. Punctuation and
word spacing do not require an exact catalog phrase; discovery never adds grants.
An OpenCode exit without assistant text or a completed tool action is reported as
`opencode_empty_response`, rather than successful work.

## `action-policy`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-profiles/{profileId}/entries`.

Agent access: `restricted` — Board management API; agent execution follows
off/ask/allowed.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: An agent cannot authorize itself by editing the policy. Decide whether any
explicitly delegated administration should be supported.

## `catalog-change`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-profiles/{profileId}/new-tools/review`.

Agent access: `restricted` — Board catalog-review API; agents can discover authorized
tools.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Catalog refresh/review and quarantined-action enablement are management
operations.

## `test-action`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-connections/{connectionId}/test-calls`.

Agent access: `restricted` — Board test-as-agent API; agent executes its own assigned
tools normally.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: A board test performed as an agent is not proof the agent can manage or invoke the
testing endpoint.

## `account-maintenance`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-connections/{connectionId}/reconnect`.
- `GET /api/tool-connections/{connectionId}/activity`.

Agent access: `restricted` — Board account management; native
connections_search/connection_request can request human setup.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Agent requests and continued tool use exist; reconnect/revoke/audit management are
human paths.
