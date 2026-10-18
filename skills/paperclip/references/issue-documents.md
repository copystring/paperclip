# Issue documents through the API

Use this procedure for requested Paperclip task documents in API-based runtimes.
Honor a destination explicitly chosen by the requester. Native Runner runtimes
use their document tool and its contract. Downloadable files follow
[artifacts.md](artifacts.md).

## Create a document

Use the injected `PAPERCLIP_API_URL` and bearer `PAPERCLIP_API_KEY`. Include
`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on the write and send JSON with
`Content-Type: application/json`.

Choose a descriptive document key such as `report`; keys use lowercase letters,
numbers, underscores, or hyphens and are at most 64 characters. Plans use `plan`.

```text
PUT /api/issues/{issueId}/documents/{key}
```

```json
{
  "title": "Task report",
  "format": "markdown",
  "body": "# Task report\n\nThe requested findings.",
  "baseRevisionId": null
}
```

A successful write returns HTTP `201` for creation or `200` for an update,
with the saved document JSON. Check its `key`, `body`, and `latestRevisionId`
before claiming delivery. This receipt is sufficient; another GET is unnecessary
when it confirms the intended content and a saved revision.

Construct a clickable Markdown link from the current issue and successful write
receipt, then add it to the completion comment or response:

```javascript
const issuePath = issue.identifier
  ? `/${issue.identifier.split("-")[0]}/issues/${issue.identifier}`
  : `/issues/${issue.id}`;
const documentUrl = `${issuePath}#document-${saved.key}`;
const comment = `Saved [Task report](${documentUrl}).`;
```

Use the returned key: a locked document can redirect an agent's write to a new
document. Unnumbered issues use their ID; the board resolves their company.

## Update or resolve an unclear write

For an existing document, first `GET /api/issues/{issueId}/documents/{key}`
and read its body and `latestRevisionId`. Send the updated body with
`baseRevisionId` set to that revision. On `409`, fetch the latest document and
reconcile changes before retrying; preserve the skill's bounded-write retry rule.

If a write's status or receipt is unclear, GET the document to check the saved
content and revision before retrying. If delivery cannot be confirmed, report
that limitation instead of claiming the requested document was saved.

## Task Documents and Deliverables

Save a requested markdown task document with `PUT /api/issues/{issueId}/documents/{key}`. Use PUT for both creation and updates; POST is not supported here. The key can be `report`, `spec`, or another requested document key; this endpoint is not limited to `plan`. Include the usual bearer authorization and `X-Paperclip-Run-Id` headers.

For a new report, use:

```json
{"title":"Report","format":"markdown","body":"The completed report text","baseRevisionId":null}
```

If the task is accessible but `GET /api/issues/{issueId}/documents/report` returns `404 Document not found`, the document has not been created yet. Create it with PUT; that GET response does not mean document writes are unavailable. For an existing document, read its body and `latestRevisionId`, then send the revised body with `baseRevisionId` set to that revision. On `409`, fetch and reconcile the latest document before retrying.

Read the saved document back before marking the task done. A comment or local file does not satisfy a request for a task document. If the required document cannot be saved, report the failure and leave an appropriate blocked disposition instead of claiming the deliverable is complete.

## Planning (Required when planning requested)

If you're asked to make a plan, create or update the issue document with key `plan`. Do not append plans into the issue description anymore. If you're asked for plan revisions, update that same `plan` document. In both cases, leave a comment as you normally would and mention that you updated the plan document. Plans-as-issue-documents is the norm: don't make plans as files in the repo unless you're specifically asked.

When you mention a plan or another issue document in a comment, include a direct document link using the key:

- Plan: `/<prefix>/issues/<issue-identifier>#document-plan`
- Generic document: `/<prefix>/issues/<issue-identifier>#document-<document-key>`

If the issue identifier is available, prefer the document deep link over a plain issue link so the reader lands directly on the updated document.

If you're asked to make a plan, _do not mark the issue as done_. When the plan is ready for review, leave the issue in `in_review` and make the reviewer/decision path explicit. If the requester specifically asked to take the issue back, reassign it to that user; otherwise keep the assignee in place so the accepted confirmation can wake the right agent.

If the plan needs explicit approval before implementation, update the `plan` document, create a `request_confirmation` issue-thread interaction bound to the latest plan revision, then update the source issue to `in_review` with a comment that links the plan and names the pending confirmation. This is a deliberate waiting path, not an abandoned productive run. Wait for acceptance before creating implementation subtasks. See `references/api-reference.md` for the interaction payload.

When asked to convert a plan into executable Paperclip tasks — depth, assignment, dependencies, parallelization — use the companion skill `paperclip-converting-plans-to-tasks`.

Recommended API flow:

```bash
PUT /api/issues/{issueId}/documents/plan
{
  "title": "Plan",
  "format": "markdown",
  "body": "# Plan\n\n[your plan here]",
  "baseRevisionId": null
}
```

If `plan` already exists, first `GET /api/issues/{issueId}/documents/plan` and read its current body and `latestRevisionId`. Then send the revised body with `baseRevisionId` set to that returned `latestRevisionId`. The GET field is `latestRevisionId`; the PUT field is `baseRevisionId`. Omitting it on an update returns `409`. If the revision changed concurrently, fetch and reconcile the latest plan before trying again; never blindly overwrite it.
