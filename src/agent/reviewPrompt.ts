/**
 * Ask a *different* provider to review what the first one wrote. A second model reading the diff
 * cold catches things the author misses, and because it never edits anything the risk is low.
 *
 * The reviewer answers in the normal structured format with an empty `files` array: the verdict goes
 * in `summary` and the individual findings in `nextSteps`, so no protocol change is needed and the
 * existing parser handles the reply.
 *
 * Pure (no vscode import) so it is unit-testable.
 */

export interface ReviewRequest {
  /** What the task was supposed to achieve. */
  readonly objective: string;
  /** Unified diff of the work. */
  readonly diff: string;
  readonly changedFiles: readonly { readonly path: string; readonly action: string }[];
  /** The implementer's own summary, so the reviewer can check intent against the code. */
  readonly implementerSummary?: string;
  /** Output of builds/tests that were run, if any. */
  readonly verification?: readonly string[];
  readonly implementerLabel?: string;
}

export function buildReviewPrompt(request: ReviewRequest): string {
  const lines: string[] = [
    "You are reviewing code written by another AI assistant for this developer. You have no history of that conversation, so everything you need is below.",
    "",
    "REVIEW ONLY — this turn must not change anything:",
    "- Return an empty \"files\" array and an empty \"tools\" array. Do not propose edits, do not request tools, do not run commands.",
    "- Put your verdict in `summary`, starting with one of: APPROVE / MINOR ISSUES / NEEDS CHANGES.",
    "- Put each finding in `nextSteps` as one short line: `file:line — what is wrong and why it matters`.",
    "- Order findings by severity, worst first. If you find nothing real, say so instead of inventing nits.",
    "",
    "Look for things that actually break: logic errors, unhandled failures and edge cases, wrong async/await or error handling, off-by-one and boundary bugs, race conditions, missing input validation, security problems (injection, path traversal, leaked secrets, missing authorisation), performance traps, resource leaks, and changes that contradict the stated objective. Also flag code the diff clearly breaks elsewhere. Ignore formatting and style preferences.",
    "",
    "<review_request>",
    `<objective>${request.objective.trim() || "(not recorded)"}</objective>`
  ];

  if (request.implementerSummary?.trim()) {
    lines.push(
      `<what_the_author_says${request.implementerLabel ? ` by="${request.implementerLabel}"` : ""}>`,
      request.implementerSummary.trim(),
      "</what_the_author_says>"
    );
  }

  if (request.changedFiles.length > 0) {
    lines.push(
      "<files_changed>",
      ...request.changedFiles.map((file) => `- ${file.action}: ${file.path}`),
      "</files_changed>"
    );
  }

  if (request.verification && request.verification.length > 0) {
    lines.push("<verification_already_run>", ...request.verification, "</verification_already_run>");
  }

  lines.push(
    "<diff>",
    request.diff.trim() || "(no diff available — judge from the file list and the author's summary, and say that the diff was missing)",
    "</diff>",
    "</review_request>"
  );

  return lines.join("\n");
}

export interface ReviewOutcome {
  /** APPROVE / MINOR ISSUES / NEEDS CHANGES, when the reviewer followed the format. */
  readonly verdict: "approve" | "minor" | "changes" | "unclear";
  readonly summary: string;
  readonly findings: readonly string[];
}

/** Read the verdict out of a review reply. */
export function readReviewOutcome(summary: string, nextSteps: readonly string[]): ReviewOutcome {
  const head = summary.trim().toUpperCase();
  const verdict: ReviewOutcome["verdict"] = head.startsWith("APPROVE")
    ? "approve"
    : head.startsWith("NEEDS CHANGES") || head.startsWith("NEEDS_CHANGES")
      ? "changes"
      : head.startsWith("MINOR")
        ? "minor"
        : "unclear";
  return { verdict, summary: summary.trim(), findings: nextSteps.filter((step) => step.trim().length > 0) };
}

/** One-line status for the panel. */
export function describeReview(outcome: ReviewOutcome, reviewerLabel: string): string {
  const count = outcome.findings.length;
  const found = count === 0 ? "no findings" : `${count} finding${count === 1 ? "" : "s"}`;
  switch (outcome.verdict) {
    case "approve":
      return `${reviewerLabel} approved the changes (${found}).`;
    case "minor":
      return `${reviewerLabel} found minor issues (${found}).`;
    case "changes":
      return `${reviewerLabel} thinks changes are needed (${found}).`;
    default:
      return `${reviewerLabel} reviewed the changes (${found}).`;
  }
}

/** Turn a review into a follow-up task for the original implementer. */
export function buildFixPrompt(outcome: ReviewOutcome, reviewerLabel: string): string {
  return [
    `Another assistant (${reviewerLabel}) reviewed your changes and reported the following. Verify each point against the real code before acting — read the files again, since a reviewer working from a diff can be wrong.`,
    "",
    `Verdict: ${outcome.summary}`,
    "",
    ...outcome.findings.map((finding, index) => `${index + 1}. ${finding}`),
    "",
    "Fix the findings that are genuine, and for each one you reject say briefly why. Then verify with a build/tests."
  ].join("\n");
}
