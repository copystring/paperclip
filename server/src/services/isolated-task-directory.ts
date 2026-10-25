import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseObject } from "../adapters/utils.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/** A repository-free sandbox task needs isolation, but has no Git base. */
export function shouldUseIsolatedTaskDirectory(input: {
  trustPreset: string;
  environmentDriver: string | null;
  mode: string;
  hasProjectWorkspace: boolean;
  projectWorkspaceId: string | null;
  workspaceStrategies: unknown[];
}): boolean {
  return input.trustPreset === "low_trust_review"
    && input.environmentDriver === "sandbox"
    && input.mode === "isolated_workspace"
    && !input.hasProjectWorkspace
    && !input.projectWorkspaceId
    // Never discard an explicit repository/branch requirement or setup hook.
    && input.workspaceStrategies.every((value) => Object.keys(parseObject(value)).length === 0);
}

/** A task directory cannot satisfy a configured repository or workspace setup contract. */
export function hasIsolatedTaskDirectoryIncompatibleWorkspaceRequirements(values: unknown[]): boolean {
  return values.some((value) => {
    const strategy = parseObject(value);
    const type = typeof strategy.type === "string" ? strategy.type : null;
    return (type !== null && type !== "project_primary") ||
      ["baseRef", "branchTemplate", "existingBranch", "worktreeParentDir",
        "provisionCommand", "runtimeProvisionCommand", "teardownCommand"]
        .some((key) => typeof strategy[key] === "string" && strategy[key].trim().length > 0);
  });
}

/** Confirms a retained directory is the canonical task-owned path without recreating it. */
export async function isMaterializedIsolatedTaskDirectory(input: {
  companyId: string;
  issueId: string;
  cwd: string;
}): Promise<boolean> {
  if ([input.companyId, input.issueId].some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))) return false;
  const root = await realpath(resolvePaperclipInstanceRoot()).catch(() => null);
  if (!root) return false;
  const stable = path.join(root, "isolated-workspaces", input.companyId, input.issueId);
  const attemptRoot = path.join(root, "isolated-workspace-attempts", input.companyId, input.issueId);
  const resolvedCwd = path.resolve(input.cwd);
  const attemptRelative = path.relative(attemptRoot, resolvedCwd);
  const attemptParts = attemptRelative.split(path.sep).filter(Boolean);
  const attemptPath = !path.isAbsolute(attemptRelative) &&
    (attemptParts.length === 1 || (attemptParts.length === 2 && attemptParts[1] === "workspace")) &&
    /^[a-zA-Z0-9_-]+$/.test(attemptParts[0] ?? "")
    ? path.join(attemptRoot, ...attemptParts)
    : null;
  const expected = resolvedCwd === stable ? stable : attemptPath;
  if (!expected) return false;

  const relative = path.relative(root, expected);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
    if (await realpath(current).catch(() => null) !== current) return false;
  }
  return true;
}

export async function isReusableRepoLessTaskDirectory(input: {
  companyId: string;
  workspace: {
    companyId: string;
    sourceIssueId: string | null;
    mode: string;
    strategyType: string;
    providerType: string;
    projectId: string | null;
    projectWorkspaceId: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    branchName: string | null;
    cwd: string | null;
    metadata: Record<string, unknown> | null;
  };
}): Promise<boolean> {
  const workspace = input.workspace;
  return workspace.companyId === input.companyId &&
    workspace.sourceIssueId !== null &&
    workspace.mode === "isolated_workspace" &&
    workspace.strategyType === "project_primary" &&
    workspace.providerType === "local_fs" &&
    workspace.projectWorkspaceId === null &&
    workspace.repoUrl === null &&
    (workspace.baseRef === null || workspace.baseRef.trim().length === 0) &&
    workspace.branchName === null &&
    workspace.cwd !== null &&
    parseObject(workspace.metadata).source === "task_session" &&
    await isMaterializedIsolatedTaskDirectory({
      companyId: input.companyId,
      issueId: workspace.sourceIssueId,
      cwd: workspace.cwd,
    });
}

/** Stable across turns, separate from project roots and shared agent homes. */
export async function materializeIsolatedTaskDirectory(input: {
  companyId: string;
  issueId: string;
  attemptId?: string;
}): Promise<string> {
  // Files belong to the task, so reassignment preserves the same workspace.
  const identities = [input.companyId, input.issueId, ...(input.attemptId ? [input.attemptId] : [])];
  if (identities.some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))) {
    throw new Error("Invalid isolated task workspace identity");
  }
  const root = resolvePaperclipInstanceRoot();
  await mkdir(root, { recursive: true });
  let cwd = await realpath(root);
  // A retry is a sibling namespace, never a descendant of the retained root.
  // An old copyback operation must not be able to overwrite its replacement.
  for (const segment of [input.attemptId ? "isolated-workspace-attempts" : "isolated-workspaces", ...identities]) {
    cwd = path.join(cwd, segment);
    await mkdir(cwd, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cwd) !== cwd) {
      throw new Error("Isolated task workspace path is not a private directory");
    }
  }
  return cwd;
}
