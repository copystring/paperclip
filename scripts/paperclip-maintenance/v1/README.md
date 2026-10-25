# Paperclip maintenance 1.0.2

Every CLI command acquires the shared kernel mutex before opening SQLite or initializing its schema, and keeps it until the connection closes. An overlapping daily/weekly invocation exits successfully with `overlap_skipped` and no database effects. Other busy commands exit with code 3 and must wait for an ordinary later opportunity; never remove the mutex or replay an acknowledgement blindly.

Responsible owner: CTO. Read the current accepted source evidence and actual routine state before acting; historical setup notes do not define current activation state. Canonical policy and lessons are read from the API before every agent run; this package contains no rule copies. This tool uses only authenticated GET operations plus its own local SQLite state. It neither changes runtime configuration nor manages issues, routine activation, checkouts, recovery or provider credentials.

## Load and invoke

Persistent source: the versioned `scripts/paperclip-maintenance/v1` package in the designated maintenance workspace. Shared durable state: one configured, durable directory on the service-owned filesystem, reused by every invocation. The executable procedure supplies both absolute paths; they must not be derived from task or issue identifiers. Python 3.11+ standard library, ext4, one process; no install/build is required. Current run credentials stay in environment variables. Do not place credentials in arguments, state or logs.

```
python3 maintenance.py daily --state /absolute/shared/state
python3 maintenance.py weekly --state /absolute/shared/state
python3 maintenance.py status --state /absolute/shared/state
```

Use the same state path for daily and weekly invocations, never a fresh per-run database. Collector: 60 seconds cooperative limit, at most 500 file reads, 8 MiB combined API/file bytes, 80 GETs and 20,000 directory enumeration steps. API requests have at most 10-second timeout. Oversized single files remain visible gaps. Kernel flock serializes collection; no PID/age lock reclamation or lock-file unlink. Each file checkpoint is committed. Abrupt process termination leaves the last committed cursor; a later ordinary schedule marks the prior local scan interrupted and resumes. These are local scanner claims, not Paperclip checkout/recovery claims.

Daily scanning reconciles all currently returned registry entries and allowed discovery roots; unchanged files reuse stat/hash/reference evidence. Weekly scanning also hashes unchanged files and schedules their semantic review in oldest-check order. Dynamically discovered root/relative-reference closure is persisted. Issue metadata uses ascending-ID pages of 1,000 rows; a partial scan saves its cursor and does not replace prior watermarks or prune pending candidates until the final page succeeds. This is not a transactional snapshot: records changed behind the saved cursor are reconsidered when the next full scan begins. Content is never stored, only metadata/hash/revision/status, cursors, findings and evidence links. Service/provider configuration is an allowlisted projection; environment-secret files and unsupported command forms are explicit gaps. Supported Python interpreters and systemd prefixes (`+`, `!`, `-`, `@`) in service definitions resolve to their target script paths without command execution. Historical/unobserved records remain preserved and excluded from active review. Directory or API limits leave named residual queues; no complete-scope claim when residuals or inaccessible roots remain. The run list API exposes only a recent 200-run window without supported pagination here; historical coverage is explicitly incomplete, not silently truncated.

## Owner's bounded semantic step

The program outputs at most five source review candidates and persists up to 20 issue candidates. CTO reads the current candidates and relevant original sources, at most 64 KiB of additional source context and 180 seconds for the entire scheduled agent run. The 64-KiB/180-second owner budgets are procedural ceilings, not enforcement by the Python collector; report agent token usage from actual run accounting, or unknown. Zero collector model calls does not mean zero quota for the owning agent.

Review changed instructions/models/loaders against their preserved function and authorization contract. Weekly review includes interactions between the selected sources and their referenced dependencies. Do not infer acceptance from a hash or successful adapter status. Optional absent information defers only that source. Machine findings are leads, not proved production causes. Known waits, dependency gates, checkout/recovery/HOLD and human-only gates defer the affected path. Use `progress_decision` with persisted actual progress markers and known wait deadlines when diagnosing a deep case; it never cancels or reclaims foreign work. A hard collector budget is a resource limit, not proof of a hung external process.

After a source or issue check, store a short source/hash/evidence result and invoke:

Collector output and `status` include `review_details` with each selected source, its exact snapshot hash, `hash_kind` and loader metadata. Use that snapshot hash when acknowledging the reviewed representation. Raw file bytes, JSON-encoded document strings, API projections and safe service/configuration projections have different digest semantics; a raw `sha256sum` is only equivalent for `raw_bytes_sha256`. Projections exclude sensitive fields, so this distinction does not authorize reading or logging credentials. A changed digest still requires a new check; copying a hash alone proves no semantic review.

```
python3 maintenance.py reviewed --state /absolute/shared/state --source SOURCE --hash SHA256_OR_REVISION --evidence EVIDENCE_LINK
```

For issue candidates, pass `--source issue:ISSUE_ID --hash UPDATED_AT_OR_REVISION --evidence EVIDENCE_LINK`. The command rejects changed hashes/revisions and another run's source claim, and retains candidates across collector runs until explicitly acknowledged. A modified issue revision re-enters the candidate set. Diagnostic review acknowledgements are not independent acceptance of code/configuration changes. At the end, release only this run's semantic reservations:

```
python3 maintenance.py release --state /absolute/shared/state
```

If interrupted before release, the next ordinary schedule may reconcile reservations only with actual GET run detail: finished terminal run, terminal execution projection, no retry/recovery/successor. Missing/denied/active/recovery evidence preserves the reservation and other safe candidates continue. No foreign checkout or recovery gate is altered. Do not reopen an old task to force a start.

## Findings, changes and unknown writes

Findings are keyed by source+failure class and emitted only on first occurrence. Repeated unchanged failures update last-seen/count without fresh questions/tasks. CTO compares new leads with existing issues, coach proposals, learning/verification work and monitors before creating at most three necessary handoffs. Existing quota tasks and their owner remain untouched. Maintenance owns source collection and resource/contract triage; Reflection Coach owns coaching proposals, Learning Agent owns verified transferable lessons, CEO owns coordination. No routine no-op needs delegation/review.

A proposed function-preserving change is prepared independently, includes benefit/tradeoff/affected contract and appropriate independent review; only that change waits for missing acceptance. This read-only tool never applies it. For any later authorized write, reserve a durable `Store.intent(key,target,expected)` before dispatch, retain the same key on ambiguity and reconcile observed revision/state using `Store.reconcile`; duplicate intent refuses dispatch. This is a fence API, not an external-write adapter. External writes must additionally obey the installed API's own idempotency/CAS and checkout/recovery contracts. A mismatch remains unknown; never blindly replay. No remote mutation or provider fault was tested by this package.

## Operation and changes

Read status, triggers and next times from the existing native routine objects. This document does not require an active routine to be paused or a paused routine to be activated. Keep the existing owner, shared state, concurrency/catch-up policies and schedules unless a concrete authorized change requires otherwise. Do not create duplicate routines, call Check now or treat a historical build issue as an operational gate.

Prepare function-preserving changes with exact source hashes and appropriate independent review. Apply only the accepted candidate, check current source identity and overlapping work immediately before replacement, then read back the installed files and affected behavior. Preserve real permission, review, recovery and unknown-action gates. Record bounded results and remaining coverage, release only this run's semantic claims, and save the native task disposition so the next ordinary schedule can continue without a new generic user approval.
