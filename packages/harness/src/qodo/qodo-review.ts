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

const FULL_SHA = /^[0-9a-f]{40}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLine(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1;
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Why one finding can't be read the way `findingsFor` reads it, or undefined. */
function findingProblem(finding: unknown, index: number): string | undefined {
  const at = `finding ${index + 1}`;
  if (typeof finding !== "object" || finding === null) return `${at} is not an object`;
  const f = finding as Record<string, unknown>;
  if (typeof f.id !== "string" || !f.id) return `${at} has no id`;
  // Compared with the head exactly, so a short or upper-case SHA would silently drop the finding (AUD-M9).
  if (typeof f.git_sha !== "string" || !FULL_SHA.test(f.git_sha)) {
    return `${at} (${f.id}) has git_sha ${JSON.stringify(f.git_sha)}, not a full lower-case commit id`;
  }
  // A renamed field would read as "placed nowhere", which can never match: only an explicit null may say that.
  if (f.file_path !== null && typeof f.file_path !== "string") return `${at} (${f.id}) has no file_path`;
  const start = f.start_line;
  const end = f.end_line;
  // Both lines or neither: a finding with one of them would be kept with no lines, and could never match.
  const placed = isLine(start) && isLine(end) && (start as number) <= (end as number);
  if (!placed && !(isAbsent(start) && isAbsent(end))) {
    return `${at} (${f.id}) has start_line ${JSON.stringify(start)} and end_line ${JSON.stringify(end)}, not a line range`;
  }
  for (const field of ["title", "category", "description", "action_level"]) {
    if (!isAbsent(f[field]) && typeof f[field] !== "string") return `${at} (${f.id}) has a ${field} that isn't text`;
  }
  return undefined;
}

/**
 * Why a review Qodo calls complete can't be read as a list of findings, or undefined. A missing or renamed
 * `findings` list would otherwise read as zero findings, which for a case is a miss: the one answer the
 * evidence doesn't support (#196). `finding_count`, when present, must agree with the list. Every finding
 * must carry the fields `findingsFor` reads, in the form it compares them (AUD-M9). And findings that are
 * all on commits Qodo reports no run for, with none on `headSha`, mean the commit ids changed form: an
 * error, never an empty review. Findings on earlier commits of the same PR, which Qodo did review, are fine.
 */
export function findingsShapeProblem(review: QodoReview, headSha?: string): string | undefined {
  if (!Array.isArray(review.findings)) return "Qodo's complete review holds no findings list";
  // Read below and by `reviewState`: each run must be an object, never a list or a bare value, which would throw
  // there (Qodo on PR 286). A run still being filled may lack its commit, and no runs at all may be null: both
  // are read as they always were, as no run for that commit.
  const runs: unknown = review.review_runs;
  if (runs !== undefined && runs !== null && (!Array.isArray(runs) || !runs.every(isPlainObject))) {
    return "Qodo's complete review lists its runs in something other than a list of runs";
  }
  const session: unknown = review.review_session;
  if (session !== undefined && session !== null && !isPlainObject(session)) {
    return "Qodo's complete review has a review session that isn't an object";
  }
  if (typeof review.finding_count === "number" && review.finding_count !== review.findings.length) {
    return `Qodo's complete review counts ${review.finding_count} findings but lists ${review.findings.length}`;
  }
  for (const [i, finding] of review.findings.entries()) {
    const problem = findingProblem(finding, i);
    if (problem) return `Qodo's complete review can't be read: ${problem}`;
  }
  if (headSha === undefined || !review.findings.length) return undefined;
  const reviewed = new Set([
    headSha,
    ...(review.review_runs ?? []).map((r) => r.commit_sha),
    review.review_session?.commit_sha,
  ]);
  if (!review.findings.some((f) => f.git_sha === headSha) && review.findings.every((f) => !reviewed.has(f.git_sha))) {
    return `Qodo's complete review lists ${review.findings.length} findings, none on ${headSha} or on any commit it reports reviewing`;
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
  // A skip is checked first: Qodo marking a skipped run complete must still read as skipped (AUD-N8). Only
  // the boolean true counts as complete, never a string that merely looks like it.
  const run = review.review_runs?.find((r) => r.commit_sha === headSha);
  if (run?.review_effort === "skip") return "skipped";
  return session.review_complete === true ? "complete" : "running";
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
