/**
 * Qodo's review of a PR as its API answers it (`get-pr-review-findings`, extended), and the pure reads of
 * it that `review:wait` and the case scripts use: whether the run for a commit is finished, and its findings.
 */

/** The parts of Qodo's `get-pr-review-findings` (extended) response this uses. */
export interface QodoReview {
  ab_test_name?: string | null;
  ab_arm?: string | null;
  review_session?: { commit_sha?: string; status?: string; review_complete?: boolean; started_at?: string } | null;
  review_runs?: { commit_sha?: string; run_id?: number; review_effort?: string | null; status?: string }[];
  findings?: {
    id: string;
    git_sha: string;
    file_path?: string | null;
    start_line?: number | null;
    end_line?: number | null;
    action_level?: string | null;
    category?: string | null;
    title?: string | null;
    description?: string | null;
    attribution_status?: string | null;
    dismiss_reason?: string | null;
  }[];
  finding_count?: number;
}

/**
 * Why a review Qodo calls complete can't be read as a list of findings, or undefined. A missing or renamed
 * `findings` list would otherwise read as zero findings, which for a case is a miss: the one answer the
 * evidence doesn't support (#196). `finding_count`, when present, must agree with the list.
 */
export function findingsShapeProblem(review: QodoReview): string | undefined {
  if (!Array.isArray(review.findings)) return "Qodo's complete review holds no findings list";
  if (typeof review.finding_count === "number" && review.finding_count !== review.findings.length) {
    return `Qodo's complete review counts ${review.finding_count} findings but lists ${review.findings.length}`;
  }
  return undefined;
}

export interface Finding {
  id: string;
  file: string | null;
  lines: [number, number] | null;
  severity: string | null;
  category: string | null;
  title: string | null;
  description: string | null;
}

/**
 * "complete" only when the run for exactly this commit is completed. "skipped" when Qodo finished the
 * run but chose not to review it (`review_effort: "skip"`, seen on a docs-only PR): its comment then
 * shows zero findings, which looks like a clean review but isn't one.
 */
export function reviewState(review: QodoReview, headSha: string): "complete" | "skipped" | "running" | "not-started" {
  const session = review.review_session;
  if (!session || session.commit_sha !== headSha) return "not-started";
  if (session.status !== "completed") return "running";
  if (session.review_complete) return "complete";
  const run = review.review_runs?.find((r) => r.commit_sha === headSha);
  return run?.review_effort === "skip" ? "skipped" : "running";
}

/** The findings Qodo raised on this commit, in a stable shape. */
export function findingsFor(review: QodoReview, headSha: string): Finding[] {
  return (review.findings ?? [])
    .filter((f) => f.git_sha === headSha)
    .map((f) => ({
      id: f.id,
      file: f.file_path ?? null,
      lines: f.start_line && f.end_line ? [f.start_line, f.end_line] : null,
      severity: f.action_level ?? null,
      category: f.category ?? null,
      title: f.title ?? null,
      description: f.description ?? null,
    }));
}

/** How deeply Qodo reviewed this commit ("standard", "lite", "skip"…), if it says. */
export function reviewEffort(review: QodoReview, headSha: string): string | null {
  return review.review_runs?.find((r) => r.commit_sha === headSha)?.review_effort ?? null;
}

/**
 * Every finding on the PR that Qodo hasn't marked implemented or dismissed, from any commit. A later
 * "lite" review of a new commit doesn't repeat earlier findings, so looking only at the head commit
 * can show zero while earlier ones are still open.
 */
export function openFindings(review: QodoReview): (Finding & { commit: string })[] {
  return (review.findings ?? [])
    .filter((f) => !f.dismiss_reason && f.attribution_status !== "implemented")
    .map((f) => ({ ...(findingsFor({ findings: [f] }, f.git_sha)[0] as Finding), commit: f.git_sha.slice(0, 7) }));
}
