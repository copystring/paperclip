/** Standalone, dependency-free helpers shipped into the private local runtime. */
export const PAPERCLIP_TASK_TOOLS_SOURCE = String.raw`import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const home = path.dirname(fileURLToPath(import.meta.url));
const snapshots = path.join(home, 'document-snapshots');
const hash = body => createHash('sha256').update(body).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValue(ok, message) { if (!ok) throw new Error(message); }
const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  requireValue(args[i]?.startsWith('--') && args[i + 1] !== undefined && !Object.hasOwn(options, args[i]), 'Expected unique --option value pairs.');
  options[args[i]] = args[i + 1];
}
function accept(names) { requireValue(Object.keys(options).every(key => names.includes(key)), 'Unknown option.'); }
function page(body, file, digest, offset) {
  requireValue(Number.isSafeInteger(offset) && offset >= 0 && offset <= body.length, 'Invalid character offset.');
  requireValue(offset === 0 || offset === body.length || !(/[\uD800-\uDBFF]/.test(body[offset - 1]) && /[\uDC00-\uDFFF]/.test(body[offset])), 'Offset splits a Unicode character. Use the returned nextOffset.');
  let end = Math.min(body.length, offset + 6000);
  // Offsets use UTF-16 units; never split a supplementary Unicode character.
  if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end -= 1;
  return { file, sha256: digest, offset, nextOffset: end, totalCharacters: body.length,
    complete: end === body.length, body: body.slice(offset, end) };
}
async function api(route, method = 'GET', body, optional = false) {
  const base = process.env.PAPERCLIP_API_URL?.replace(/\/$/, '').replace(/\/api$/, '');
  requireValue(base && process.env.PAPERCLIP_API_KEY && process.env.PAPERCLIP_RUN_ID, 'Missing run-scoped Paperclip API environment.');
  const response = await fetch(base + '/api' + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + process.env.PAPERCLIP_API_KEY,
      'X-Paperclip-Run-Id': process.env.PAPERCLIP_RUN_ID, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // Do not print arbitrary response bodies, which can contain private metadata.
  if (optional && method === 'GET' && response.status === 404) return null;
  requireValue(response.status === 200 || (method === 'PUT' && response.status === 201), method + ' ' + route + ' returned HTTP ' + response.status + '; not confirmed.');
  const data = await response.json();
  requireValue(object(data), method + ' returned an invalid JSON object.');
  return data;
}
async function currentTask() {
  const issue = process.env.PAPERCLIP_TASK_ID;
  const agent = process.env.PAPERCLIP_AGENT_ID;
  requireValue(issue && agent, 'Operation requires the current task and agent.');
  const route = '/issues/' + encodeURIComponent(issue);
  const task = await api(route);
  requireValue(task.id === issue, 'Task readback does not identify the current task.');
  requireValue(task.assigneeAgentId === agent && task.assigneeUserId === null && ['todo', 'in_progress', 'in_review', 'blocked'].includes(task.status), 'Current task is not assigned to this agent or is already terminal.');
  return { issue, agent, route, task };
}
async function inputFile(file, maxLength) {
  requireValue(typeof file === 'string' && file.length > 0, 'A UTF-8 input file is required.');
  const info = await fs.lstat(file);
  requireValue(info.isFile() && info.size <= maxLength * 4, 'Input must be a bounded regular UTF-8 file.');
  const value = await fs.readFile(file, 'utf8');
  requireValue(value.trim().length > 0 && value.length <= maxLength, 'Input text is empty or too large.');
  return value;
}
async function saveDocument({ issue, route }, key, title, body) {
    const documentRoute = route + '/documents/' + encodeURIComponent(key);
    const before = await api(documentRoute, 'GET', undefined, true);
    requireValue(before === null || typeof before.latestRevisionId === 'string', 'Existing document revision missing; no write attempted.');
    const saved = await api(documentRoute, 'PUT', { title, format: 'markdown', body, baseRevisionId: before?.latestRevisionId ?? null });
    const revisionId = saved.latestRevisionId;
    // A locked document may be preserved by the server under its original key
    // while our authorized revision is created under a new key. Follow that
    // receipt, never unlock/overwrite the original or invent a canonical key.
    requireValue(typeof revisionId === 'string' && typeof saved.key === 'string' && saved.key && saved.issueId === issue, 'Write returned no scoped document receipt; inspect the document before another write.');
    const after = await api(route + '/documents/' + encodeURIComponent(saved.key));
    requireValue(after.issueId === issue && after.key === saved.key && after.body === body && after.title === title && after.format === 'markdown' && after.latestRevisionId === revisionId, 'Document readback differs; no confirmed report. Inspect current state before another write.');
    return { confirmed: true, issueId: issue, key: saved.key, revisionId, sha256: hash(body), bytes: Buffer.byteLength(body) };
}
async function main() {
  if (command === 'write-document') {
    accept(['--key', '--title', '--file']);
    const key = options['--key']?.trim().toLowerCase(), title = options['--title']?.trim();
    requireValue(key && typeof title === 'string' && title.trim() && title.length <= 200, 'write-document requires --key, --title and --file.');
    const body = await inputFile(options['--file'], 524288);
    return saveDocument(await currentTask(), key, title, body);
  }
  if (command === 'complete-task') {
    accept(['--summary-file', '--report-key', '--report-revision']);
    const current = await currentTask();
    const { issue, agent, route, task } = current;
    let reportKey = options['--report-key'], reportRevision = options['--report-revision'];
    requireValue(Boolean(reportKey) === Boolean(reportRevision), 'A report reference requires both --report-key and --report-revision.');
    if (reportKey) {
      const report = await api(route + '/documents/' + encodeURIComponent(reportKey));
      requireValue(report.issueId === issue && report.key === reportKey && report.latestRevisionId === reportRevision, 'Report reference or revision changed; inspect it before requesting completion.');
    } else {
      const summary = await inputFile(options['--summary-file'], 16000);
      const saved = await saveDocument(current, 'completion-' + process.env.PAPERCLIP_RUN_ID, 'Ergebnis der Bearbeitung', summary);
      reportKey = saved.key; reportRevision = saved.revisionId;
    }
    // Free-form summaries may describe a prior failed attempt. Persist them as
    // evidence, never republish them as the current completion/status message.
    const label = String(task.identifier ?? issue).replace(/[\[\]\\]/g, '');
    const comment = 'Abschluss der Bearbeitung angefordert. Ergebnisbericht: [' + label + '](/' + label.split('-')[0] + '/issues/' + label + '#document-' + encodeURIComponent(reportKey) + '). Berichtsrevision: ' + reportRevision + '. Der tatsächliche Aufgabenstatus wird anschließend zurückgelesen.';
    // The server owns review/approval transitions. Never patch the reviewer,
    // execution state or policy to turn an executor request into an approval.
    // expectedExecutionPolicy is exclusively a policy-only CAS in the REST
    // contract. Completion is guarded by the authenticated run and the native
    // workflow transaction; combining that CAS with status is rejected (422).
    await api(route, 'PATCH', { status: 'done', comment });
    const after = await api(route);
    requireValue(after.id === issue, 'Completion readback does not identify the current task.');
    const reportReceipt = reportKey ? { key: reportKey, revisionId: reportRevision } : null;
    if (reportKey) {
      const report = await api(route + '/documents/' + encodeURIComponent(reportKey));
      requireValue(report.issueId === issue && report.key === reportKey && report.latestRevisionId === reportRevision, 'Report changed during completion; inspect current task state before any further write.');
    }
    if (after.status === 'done') return { confirmed: true, issueId: issue, outcome: 'done', taskDone: true, report: reportReceipt };
    const state = after.executionState;
    const participant = state?.currentParticipant;
    const pendingReview = after.status === 'in_review' && state?.status === 'pending'
      && ['review', 'approval'].includes(state.currentStageType)
      && ((participant?.type === 'agent' && typeof participant.agentId === 'string' && participant.agentId && participant.agentId !== agent && after.assigneeAgentId === participant.agentId)
        || (participant?.type === 'user' && typeof participant.userId === 'string' && participant.userId && after.assigneeUserId === participant.userId));
    requireValue(pendingReview, 'Completion was not confirmed by task readback. Inspect current state; do not repeat the write blindly.');
    return { confirmed: true, issueId: issue, outcome: 'handed_off', taskDone: false, pendingStage: state.currentStageType, participant, report: reportReceipt };
  }
  if (command === 'read-document') {
    accept(['--issue-id', '--key']);
    const issue = options['--issue-id'] ?? process.env.PAPERCLIP_TASK_ID;
    const key = options['--key'];
    requireValue(issue && key, 'read-document requires an issue and --key.');
    const doc = await api('/issues/' + encodeURIComponent(issue) + '/documents/' + encodeURIComponent(key));
    requireValue(typeof doc.body === 'string' && typeof doc.latestRevisionId === 'string', 'Document body or revision missing.');
    await fs.mkdir(snapshots, { recursive: true, mode: 0o700 });
    const file = path.join(snapshots, randomUUID() + '.md');
    await fs.writeFile(file, doc.body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const saved = await fs.readFile(file, 'utf8');
    requireValue(saved === doc.body, 'Document snapshot readback differs.');
    return { revisionId: doc.latestRevisionId, bytes: Buffer.byteLength(saved), ...page(saved, file, hash(saved), 0) };
  }
  if (command === 'read-snapshot') {
    accept(['--file', '--sha256', '--offset']);
    const file = path.resolve(options['--file'] ?? '');
    requireValue(path.dirname(file) === snapshots && (await fs.lstat(file)).isFile(), 'Expected a regular private document snapshot.');
    const body = await fs.readFile(file, 'utf8');
    const digest = hash(body);
    requireValue(digest === options['--sha256'], 'Snapshot changed; do not combine different document revisions.');
    return page(body, file, digest, Number(options['--offset']));
  }
  if (command === 'set-monitor') {
    accept(['--at', '--timeout-at', '--notes', '--max-attempts']);
    const issue = process.env.PAPERCLIP_TASK_ID;
    const agent = process.env.PAPERCLIP_AGENT_ID;
    requireValue(issue && agent, 'Monitor requires the current task and agent.');
    const route = '/issues/' + encodeURIComponent(issue);
    const before = await api(route);
    requireValue(before.assigneeAgentId === agent && before.assigneeUserId === null && ['in_progress', 'in_review'].includes(before.status), 'Current task is not eligible for an agent monitor.');
    const policy = before.executionPolicy;
    requireValue(policy === null || object(policy), 'Invalid execution policy snapshot.');
    // The legacy PATCH schema strips unknown policy keys. Refuse before a write
    // rather than silently deleting rules introduced by a newer server version.
    requireValue(Object.keys(policy ?? {}).every(key => ['mode', 'commentRequired', 'stages', 'monitor', 'reviewPreset', 'authorizationPolicy', 'maxReviewRounds'].includes(key)), 'Unsupported execution policy fields; no monitor write was attempted.');
    const policyMonitor = policy?.monitor;
    const retainedMonitor = before.executionState?.monitor;
    requireValue(policyMonitor == null || object(policyMonitor), 'Invalid existing monitor.');
    requireValue(retainedMonitor == null || object(retainedMonitor), 'Invalid retained monitor.');
    const existing = policyMonitor ?? retainedMonitor;
    const at = options['--at'];
    const atMs = Date.parse(at);
    requireValue(Number.isFinite(atMs) && atMs > Date.now(), 'Monitor must be scheduled in the future.');
    const notes = options['--notes'];
    requireValue(typeof notes === 'string' && notes.trim().length > 0 && notes.length <= 500, 'Monitor notes must contain 1 to 500 characters.');
    const requestedLimit = Number(options['--max-attempts'] ?? 1);
    requireValue(Number.isSafeInteger(requestedLimit) && requestedLimit > 0, 'Invalid attempt limit.');
    const priorAttempts = Math.max(before.monitorAttemptCount ?? 0, retainedMonitor?.attemptCount ?? 0);
    const maxAttempts = Math.min(requestedLimit, policyMonitor?.maxAttempts ?? Infinity, retainedMonitor?.maxAttempts ?? Infinity);
    requireValue(Number.isSafeInteger(maxAttempts) && maxAttempts > priorAttempts, 'Existing monitor attempt budget is exhausted.');
    const requestedTimeout = options['--timeout-at'];
    requireValue(Number.isFinite(Date.parse(requestedTimeout)), 'Monitor requires a valid --timeout-at.');
    const timeoutMs = Math.min(Date.parse(requestedTimeout), policyMonitor?.timeoutAt == null ? Infinity : Date.parse(policyMonitor.timeoutAt), retainedMonitor?.timeoutAt == null ? Infinity : Date.parse(retainedMonitor.timeoutAt));
    requireValue(Number.isFinite(timeoutMs) && timeoutMs > atMs, 'Monitor timeout would exceed or outlive its existing budget.');
    const metadata = Object.fromEntries(['externalRef', 'recoveryPolicy'].filter(key => existing && Object.hasOwn(existing, key)).map(key => [key, existing[key]]));
    const monitor = { ...metadata, kind: existing?.kind ?? 'external_service', serviceName: existing?.serviceName ?? 'paperclip-task',
      nextCheckAt: new Date(atMs).toISOString(), timeoutAt: new Date(timeoutMs).toISOString(), maxAttempts, notes };
    // The authenticated server supplies the current scheduler identity.
    // One CAS write, no automatic conflict/transport retry, no status changes.
    await api(route, 'PATCH', { expectedExecutionPolicy: policy, executionPolicy: { ...policy, monitor } });
    const after = await api(route);
    const stored = after.executionPolicy?.monitor;
    requireValue(object(stored) && Object.entries(monitor).every(([key, value]) => isDeepStrictEqual(stored[key], value)), 'Monitor readback differs; scheduling is not confirmed.');
    requireValue(after.assigneeAgentId === agent && after.assigneeUserId === null && ['in_progress', 'in_review'].includes(after.status), 'Monitor readback is not eligible.');
    requireValue(Date.parse(after.monitorNextCheckAt) === atMs, 'Monitor timestamp readback differs.');
    requireValue((after.monitorAttemptCount ?? 0) >= priorAttempts, 'Monitor attempt counter decreased; not confirmed.');
    const withoutMonitor = value => {
      const result = Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => key !== 'monitor'));
      // A previously null/partial policy acquires these equivalent server defaults.
      if (result.mode === 'normal') delete result.mode;
      if (result.commentRequired === true) delete result.commentRequired;
      if (Array.isArray(result.stages) && result.stages.length === 0) delete result.stages;
      return result;
    };
    requireValue(isDeepStrictEqual(withoutMonitor(after.executionPolicy), withoutMonitor(policy)), 'Other execution policy fields changed; not confirmed.');
    return { confirmed: true, issueId: issue, nextCheckAt: stored.nextCheckAt, timeoutAt: stored.timeoutAt, maxAttempts: stored.maxAttempts, notes: stored.notes };
  }
  throw new Error('Use read-document, read-snapshot, write-document, complete-task or set-monitor.');
}
main().then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ confirmed: false, error: error instanceof Error ? error.message : 'Operation failed.' }) + '\n');
  process.exitCode = 1;
});
`;
