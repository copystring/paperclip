# Issue Workspace Runtime Controls

Use this reference to choose task file placement or inspect and run workspace services. A workspace may be a plain task directory without a project or Git repository.

## Discover the Workspace

Start from the issue, not from memory:

```sh
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/heartbeat-context"
```

Read `currentExecutionWorkspace`:

- `id` — execution workspace id for control endpoints
- `cwd` / `branchName` — local checkout context
- `status` / `closedAt` — whether the workspace is usable
- `runtimeServices[]` — current services, including `serviceName`, `status`, `healthStatus`, `url`, `port`, and `runtimeServiceId`

If `currentExecutionWorkspace` is `null`, the issue does not currently have a realized execution workspace. For child/follow-up work, create the child with `parentId` or use `inheritExecutionWorkspaceFromIssueId` so Paperclip preserves workspace continuity.

## Choose Files and Repositories

`GET /api/issues/:issueId/workspace` returns the current binding, revision, pending selection, repository inventory, and available preparation capabilities. The Runner equivalents are `get_workspace` and `list_workspaces`.

`PUT /api/issues/:issueId/workspace` accepts a stable `requestKey`, the inspected `expectedBindingRevision`, and one typed `selection`:

- `{ "kind": "task_directory" }`: the task's separate directory.
- `{ "kind": "existing", "workspaceId": "<authorized-id>" }`: intentionally reuse a workspace.
- `{ "kind": "configured_source", "projectWorkspaceId": "<authorized-source-id>", "mode": "shared" }`: use its configured folder; `managed_isolated` requests an isolated checkout.

`POST /api/issues/:issueId/workspace/repositories` accepts a stable `requestKey`, optional `ref`, and `repository: { kind: "catalog", id: "<authorized-repository-id>" }`. Discover IDs with `list_project_repositories`. Existing public HTTPS GitHub URLs can use `{ kind: "url", url: "https://github.com/owner/repo" }`; URLs do not grant private credentials or create a remote repository.

Root selections and repository preparation return `next_normal_admission`. The active process retains its root. Do not claim a queued checkout is ready or repeatedly request it. A different ref cannot silently reset an existing checkout. New noncoding work can proceed immediately in task files without any repository. Explicitly shared folders remain shared; do not remove them when finishing one task.

## Control Services

Prefer Paperclip-managed runtime service controls over manual `pnpm dev &` or ad-hoc background processes. These endpoints keep service state, URLs, logs, and ownership visible to other agents and the board.

```sh
# Start all configured services; waits for configured readiness checks.
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/execution-workspaces/<workspace-id>/runtime-services/start" \
  -d '{}'

# Restart all configured services.
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/execution-workspaces/<workspace-id>/runtime-services/restart" \
  -d '{}'

# Stop all running services.
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/execution-workspaces/<workspace-id>/runtime-services/stop" \
  -d '{}'
```

To target a configured service, pass one of:

```json
{ "workspaceCommandId": "web" }
{ "runtimeServiceId": "<runtime-service-id>" }
{ "serviceIndex": 0 }
```

The response includes an updated `workspace.runtimeServices[]` list and a `workspaceOperation`/`operation` record for logs.

## Read the URL

After `start` or `restart`, read the service URL from:

- response `workspace.runtimeServices[].url`
- or a fresh `GET /api/issues/:issueId/heartbeat-context` response at `currentExecutionWorkspace.runtimeServices[].url`

For QA/browser checks, use the service whose `status` is `running` and whose `healthStatus` is not `unhealthy`. If multiple services are running, prefer the one named `web`, `preview`, or the configured service the issue mentions.

## MCP Tools

When the Paperclip MCP tools are available, prefer these issue-scoped tools:

- `paperclipGetIssueWorkspaceRuntime` — reads `currentExecutionWorkspace` and service URLs for an issue.
- `paperclipControlIssueWorkspaceServices` — starts, stops, or restarts the current issue workspace services.
- `paperclipWaitForIssueWorkspaceService` — waits until a selected service is running and returns its URL when exposed.

These tools resolve the issue's workspace id for you, so QA agents do not need to know the lower-level execution workspace endpoint first.

**Operational constraints retained from the skill entrypoint**

Use the task's provided working directory for task files. `AGENT_HOME` holds personal instructions and memory; provider home is runtime-managed. A task does not need a project or Git repository. Do not clone unrelated repositories or place task output in home to compensate for a missing project.

Use `get_workspace` to inspect the current folder, pending selection, and capabilities. Use `list_workspaces` for authorized existing folders and `list_project_repositories` for repository choices. `select_workspace` and `prepare_repository` express intent; the harness validates and prepares it. Respect `next_normal_admission` responses: keep the current root, do not claim the requested checkout exists, and do not retry in a loop or interrupt the run. Project assignment alone does not relocate files. See this reference for the API equivalents.

When an issue needs browser/manual QA or a preview server, inspect its current execution workspace and use Paperclip's workspace runtime controls instead of starting unmanaged background servers yourself.
