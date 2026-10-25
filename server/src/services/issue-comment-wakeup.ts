type IssueCommentWakeInput = {
  selfComment: boolean;
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    status?: string | null;
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  currentStatus: string | null | undefined;
};

/** An explicit work handback is a successor request, not a self-comment loop. */
export function isCurrentRunWorkHandback(input: IssueCommentWakeInput) {
  return input.selfComment && input.resumeRequested &&
    input.issueAtCommentStart.status === "in_progress" && input.currentStatus === "todo" &&
    Boolean(input.commentCreatedByRunId && (
      input.commentCreatedByRunId === input.issueAtCommentStart.checkoutRunId ||
      input.commentCreatedByRunId === input.issueAtCommentStart.executionRunId
    ));
}

export function shouldWakeAssigneeForIssueComment(input: IssueCommentWakeInput) {
  const sourceRunId = input.commentCreatedByRunId;
  const commentIsFromCurrentIssueRun = Boolean(
    sourceRunId &&
    (sourceRunId === input.issueAtCommentStart.checkoutRunId ||
      sourceRunId === input.issueAtCommentStart.executionRunId),
  );
  if (
    input.selfComment &&
    (!input.resumeRequested || (commentIsFromCurrentIssueRun && !isCurrentRunWorkHandback(input)))
  ) {
    return false;
  }
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}
