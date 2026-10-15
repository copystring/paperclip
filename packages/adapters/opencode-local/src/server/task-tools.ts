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
async function api(route, method = 'GET', body) {
  const base = process.env.PAPERCLIP_API_URL?.replace(/\/$/, '').replace(/\/api$/, '');
  requireValue(base && process.env.PAPERCLIP_API_KEY && process.env.PAPERCLIP_RUN_ID, 'Missing run-scoped Paperclip API environment.');
  const response = await fetch(base + '/api' + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + process.env.PAPERCLIP_API_KEY,
      'X-Paperclip-Run-Id': process.env.PAPERCLIP_RUN_ID, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // Do not print arbitrary response bodies, which can contain private metadata.
  requireValue(response.status === 200, method + ' ' + route + ' returned HTTP ' + response.status + '; not confirmed.');
  const data = await response.json();
  requireValue(object(data), method + ' returned an invalid JSON object.');
  return data;
}
async function main() {
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
  throw new Error('Use read-document, read-snapshot or set-monitor.');
}
main().then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ confirmed: false, error: error instanceof Error ? error.message : 'Operation failed.' }) + '\n');
  process.exitCode = 1;
});
`;
