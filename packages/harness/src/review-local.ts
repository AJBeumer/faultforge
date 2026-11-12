/**
 * Runs Qodo's local review on the current uncommitted changes (staged, unstaged and untracked) and
 * saves everything needed to check it afterwards.
 *
 *   npm run review:local -- faultforge
 *   npm run review:local -- target --isolated
 *   npm run review:local -- faultforge --timeout 15
 *
 * Qodo keeps a local review's open findings per working folder: a finding from one change can
 * reappear on an unrelated one reviewed from the same checkout later, so a rerun can look like
 * independent agreement when it only repeated the first run's finding (12 November). `--isolated`
 * avoids that by reviewing from a fresh temporary worktree, removed afterwards.
 *
 * Before submitting anything, the working tree's split (staged, unstaged, untracked paths and
 * counts) is saved under `private/raw-artifacts/local-reviews/<request id>/split.json`, so what was
 * uncommitted at review time never has to be read back out of a session transcript (12 November).
 * `<request id>` is generated here, never taken from Qodo's answer, so a crafted response can't steer
 * a write outside that folder.
 *
 * Submits the review (`start-pre-pr-review`), returning at once with an operation id, then polls
 * (`get-managed-agent-operation`) at the interval Qodo itself asks for (`poll_interval_seconds`, the
 * ticket's "retry_after") and reads the result back in chunks (`get-managed-agent-result`). Every raw
 * answer is saved as it arrives, including a failed call's body and any body recovered from a dropped
 * session, never only once a call has already succeeded.
 *
 * Each finding is printed with its file, lines, category and severity, labelled "new" (in this run's
 * `finding_state.introduced`) or "carried over" (anything else), since a carried-over finding proves
 * nothing about this run's own change.
 *
 * Exit codes: 0 completed, no open action-required finding; 1 completed, at least one open
 * action-required finding; 2 could not run (no uncommitted change, a transport failure, the operation
 * failed or timed out, the result didn't verify); 3 Qodo skipped the review, its coverage was
 * incomplete, or its finding inventory wasn't reported complete (never exit 0 or 1 in that case).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { buildLocalDiff, git, readWorkingTreeSplit, streamId } from "./local-diff.ts";
import { formatFinding, type LocalReviewPayload, labelFindings } from "./local-findings.ts";
import {
  callAndSaveRaw,
  type OperationState,
  type ResultChunkPage,
  type StartParams,
  unwrapResult,
} from "./local-review-wire.ts";
import { evidenceDir, ROOT } from "./paths.ts";
import { QodoLocalReviewApi } from "./qodo-local-review-api.ts";

export interface ReviewLocalDeps {
  startParams: StartParams;
  submit: (requestId: string, params: StartParams) => Promise<OperationState>;
  poll: (operationId: string) => Promise<OperationState>;
  cancel?: (operationId: string) => Promise<void>;
  fetchResultChunk: (operationId: string, cursor: string | null) => Promise<ResultChunkPage>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  newRequestId: () => string;
  /** Called with the final, decoded review payload; not a raw Qodo answer (`callAndSaveRaw` covers those). */
  saveArtifact: (name: string, data: string) => void;
}

export interface ReviewLocalResult {
  exitCode: 0 | 1 | 2 | 3;
  message: string;
  findings: ReturnType<typeof labelFindings>;
  operationId: string | null;
}

/** How many result pages `get-managed-agent-result` may be followed through before this gives up,
 * so a cyclic or endless `next_cursor` can never keep the command running past its own time limit. */
const MAX_RESULT_PAGES = 1000;

/**
 * Submits the diff, polls at Qodo's own interval until the operation is terminal, reads the result
 * back in chunks (bounded by the time limit, a page cap, and a check for a repeating cursor) and
 * verifies its hash, then decides the exit code from the review's own state: never 0 or 1 when Qodo
 * skipped the review, its coverage was incomplete, or it didn't report its finding inventory complete
 * — however few, or many, findings came back.
 */
export async function runReviewLocal(deps: ReviewLocalDeps, opts: { timeoutMs: number }): Promise<ReviewLocalResult> {
  if (!deps.startParams.diff.trim()) {
    return { exitCode: 2, message: "no uncommitted changes to review", findings: [], operationId: null };
  }

  const deadline = deps.now() + opts.timeoutMs;
  const requestId = deps.newRequestId();
  let state = await deps.submit(requestId, deps.startParams);
  const operationId = state.operation_id;
  // The folder is named by our own request id; this file lets an auditor starting from Qodo's operation
  // id find it (searching the folders for this file's contents).
  deps.saveArtifact(
    "operation.json",
    `${JSON.stringify({ requestId, operationId }, null, 2)}
`,
  );

  while (!state.terminal) {
    if (deps.now() + state.poll_interval_seconds * 1000 > deadline) {
      if (deps.cancel) {
        try {
          await deps.cancel(operationId);
        } catch {
          // Best-effort: the operation is reported as unfinished either way.
        }
      }
      return { exitCode: 2, message: "review did not finish within the time limit", findings: [], operationId };
    }
    await deps.sleep(state.poll_interval_seconds * 1000);
    state = await deps.poll(operationId);
  }

  if (state.status !== "completed" || !state.result_available) {
    const why = state.error ? `: ${state.error.message}` : "";
    return { exitCode: 2, message: `Qodo reported the review as ${state.status}${why}`, findings: [], operationId };
  }

  let text = "";
  let cursor: string | null = null;
  let expectedSha256: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; ; page++) {
    if (deps.now() > deadline) {
      return { exitCode: 2, message: "fetching the review result exceeded the time limit", findings: [], operationId };
    }
    if (page >= MAX_RESULT_PAGES) {
      return {
        exitCode: 2,
        message: `the review result did not finish within ${MAX_RESULT_PAGES} pages`,
        findings: [],
        operationId,
      };
    }
    const chunk = await deps.fetchResultChunk(operationId, cursor);
    // Checked again, not only before the request: a single fetch can itself take up to the
    // transport's own timeout, well past the deadline this loop otherwise only checked on the way in.
    if (deps.now() > deadline) {
      return { exitCode: 2, message: "fetching the review result exceeded the time limit", findings: [], operationId };
    }
    text += chunk.chunk ?? "";
    expectedSha256 ??= chunk.sha256;
    const next = chunk.next_cursor ?? null;
    if (next !== null) {
      if (seenCursors.has(next)) {
        return {
          exitCode: 2,
          message: "the review result's cursor repeated; refusing to fetch forever",
          findings: [],
          operationId,
        };
      }
      seenCursors.add(next);
    }
    cursor = next;
    if (!cursor) break;
  }
  if (!expectedSha256) {
    return {
      exitCode: 2,
      message: "the review result had no checksum to verify it against",
      findings: [],
      operationId,
    };
  }
  const actual = createHash("sha256").update(text, "utf8").digest("hex");
  if (actual !== expectedSha256) {
    return {
      exitCode: 2,
      message: "the review result's hash didn't match what Qodo reported",
      findings: [],
      operationId,
    };
  }

  let payload: LocalReviewPayload;
  try {
    payload = unwrapResult(text);
  } catch (error) {
    return {
      exitCode: 2,
      message: `the review result didn't parse: ${(error as Error).message}`,
      findings: [],
      operationId,
    };
  }
  deps.saveArtifact("review.json", `${JSON.stringify(payload, null, 2)}\n`);

  const findings = labelFindings(payload);
  const effort = payload.meta?.run?.effort?.effective ?? null;
  // Absent coverage counts as incomplete, same as an explicit `false`: a result that marks its finding
  // inventory complete without saying what it actually covered is not evidence of a clean review.
  const coverageComplete = payload.meta?.coverage?.complete === true;
  const findingsComplete = payload.finding_state?.complete === true;
  const scopeComplete = deps.startParams.review_scope.complete;

  if (effort === "skip") {
    return { exitCode: 3, message: "Qodo skipped this review (review_effort: skip)", findings, operationId };
  }
  if (!coverageComplete) {
    return { exitCode: 3, message: "Qodo's coverage of this review was incomplete", findings, operationId };
  }
  if (!findingsComplete) {
    return {
      exitCode: 3,
      message: "Qodo did not report this review's finding inventory as complete",
      findings,
      operationId,
    };
  }
  if (!scopeComplete) {
    return {
      exitCode: 3,
      message: "the local snapshot sent for review was incomplete (some files were excluded)",
      findings,
      operationId,
    };
  }

  const openActionRequired = findings.filter((f) => f.open && f.severity === "action_required");
  if (openActionRequired.length) {
    return {
      exitCode: 1,
      message: `${openActionRequired.length} open action-required finding(s)`,
      findings,
      operationId,
    };
  }
  return { exitCode: 0, message: "completed, no open action-required finding", findings, operationId };
}

export interface Args {
  repoKey: string;
  isolated: boolean;
  timeoutMinutes: number;
}

/** The command line, or null when it's wrong. */
export function parseArgs(argv: string[]): Args | null {
  let values: { isolated?: boolean; timeout?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseNodeArgs({
      args: argv,
      options: { isolated: { type: "boolean" }, timeout: { type: "string" } },
      allowPositionals: true,
    }));
  } catch {
    return null;
  }
  const [repoKey] = positionals;
  const timeoutMinutes = values.timeout === undefined ? 20 : Number(values.timeout);
  if (!repoKey) return null;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return null;
  return { repoKey, isolated: Boolean(values.isolated), timeoutMinutes };
}

/**
 * Removes a temporary worktree through git, so the source repository's own worktree list is updated,
 * and only then deletes its folder. If git refuses, the folder is kept and its path reported: deleting
 * it anyway would leave a registered worktree pointing at nothing. Returns whether it is fully gone.
 */
export function removeWorktree(
  repoRoot: string,
  worktree: string,
  parent: string,
  run: (root: string, args: string[]) => unknown = git,
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
  report: (message: string) => void = (message) => console.error(message),
): boolean {
  try {
    run(repoRoot, ["worktree", "remove", "--force", worktree]);
  } catch (error) {
    report(
      `Could not remove the temporary worktree ${worktree}: ${(error as Error).message}. It is still registered, so the folder was kept; remove it with: git -C ${repoRoot} worktree remove --force ${worktree}`,
    );
    return false;
  }
  remove(parent);
  return true;
}

/** Builds and runs one review, returning the exit code. Never calls `process.exit` itself: a caller
 * that did, from inside this function's own `try`, would skip the `finally` cleanup below it — a real
 * bug on this command's own first run on itself, 12 November (every `--isolated` run left its
 * worktree behind). */
async function main(): Promise<number> {
  const factory = loadFactory();
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      `usage: npm run review:local -- <${Object.keys(factory.repos).join("|")}> [--isolated] [--timeout minutes]`,
    );
    return 2;
  }
  const { repoKey, isolated, timeoutMinutes } = args;
  const config = repoConfig(factory, repoKey);
  const repoRoot = resolve(ROOT, config.path);

  // `--untracked-files=all` so a new directory is listed file by file, never as one `?? dir/` entry
  // that `buildLocalDiff` would then try to diff as if it were a single file (a real gap, 12 November).
  const split = readWorkingTreeSplit(repoRoot);
  const baseSha = git(repoRoot, ["rev-parse", "HEAD"]).trim();

  // Our own id, never Qodo's: an operation id from its answer must not decide where this writes (a
  // real finding on this command's own first run on itself, 12 November).
  const requestId = randomUUID();
  const dir = join(evidenceDir(factory), "local-reviews", requestId);
  mkdirSync(dir, { recursive: true });
  const saveArtifact = (name: string, data: string) => writeFileSync(join(dir, name), data);

  let worktree: string | null = null;
  let worktreeParent: string | null = null;
  try {
    if (isolated) {
      worktreeParent = mkdtempSync(join(tmpdir(), "review-local-"));
      worktree = join(worktreeParent, "worktree");
      git(repoRoot, ["worktree", "add", "--detach", "--quiet", worktree, baseSha]);
    }
    const scopeRoot = worktree ?? repoRoot;
    const writeSplit = (
      diffOutcome: { excludedFiles: string[]; skippedFiles: unknown[]; noNetChangeFiles: string[] } | null,
    ) =>
      saveArtifact(
        "split.json",
        `${JSON.stringify(
          {
            repo: config.github,
            repoRoot,
            isolated,
            baseSha,
            staged: split.staged,
            unstaged: split.unstaged,
            untracked: split.untracked,
            counts: { staged: split.staged.length, unstaged: split.unstaged.length, untracked: split.untracked.length },
            diffBuilt: diffOutcome !== null,
            excludedFiles: diffOutcome?.excludedFiles ?? null,
            skippedFiles: diffOutcome?.skippedFiles ?? null,
            noNetChangeFiles: diffOutcome?.noNetChangeFiles ?? null,
            recordedAt: new Date().toISOString(),
          },
          null,
          2,
        )}
`,
      );

    // Written before the diff is built, and again after: a diff that cannot be built (git failing, a
    // patch too large) still leaves a record of what the working tree held.
    writeSplit(null);
    const diffResult = buildLocalDiff(repoRoot, baseSha, split);
    writeSplit(diffResult);

    const startParams: StartParams = {
      repo_full_name: config.github,
      base_sha: baseSha,
      diff: diffResult.diff,
      review_scope: {
        stream_id: streamId(scopeRoot),
        paths: [],
        complete: diffResult.complete,
        excluded_files: diffResult.excludedFiles,
        skipped_files: diffResult.skippedFiles,
      },
    };

    const api = new QodoLocalReviewApi();
    let pollN = 0;
    let chunkN = 0;
    const result = await runReviewLocal(
      {
        startParams,
        submit: async (reqId, params) =>
          (await callAndSaveRaw(
            api,
            "start-pre-pr-review",
            { request_id: reqId, params },
            "submit",
            saveArtifact,
          )) as OperationState,
        poll: async (operationId) => {
          pollN++;
          return (await callAndSaveRaw(
            api,
            "get-managed-agent-operation",
            { operation_id: operationId },
            `poll-${pollN}`,
            saveArtifact,
          )) as OperationState;
        },
        cancel: async (operationId) => {
          await callAndSaveRaw(
            api,
            "cancel-managed-agent-operation",
            { operation_id: operationId },
            "cancel",
            saveArtifact,
          );
        },
        fetchResultChunk: async (operationId, cursor) => {
          chunkN++;
          return (await callAndSaveRaw(
            api,
            "get-managed-agent-result",
            { operation_id: operationId, cursor },
            `result-${chunkN}`,
            saveArtifact,
          )) as ResultChunkPage;
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
        newRequestId: () => requestId,
        saveArtifact,
      },
      { timeoutMs: timeoutMinutes * 60_000 },
    );

    console.log(
      `Working tree: ${split.staged.length} staged, ${split.unstaged.length} unstaged, ${split.untracked.length} untracked.`,
    );
    if (diffResult.noNetChangeFiles.length > 0) {
      console.log(`No net change from the base, so not sent: ${diffResult.noNetChangeFiles.join(", ")}.`);
    }
    for (const f of result.findings) console.log(formatFinding(f));
    console.log(result.message);
    console.log(`Saved in ${dir}`);
    return result.exitCode;
  } finally {
    if (worktree && worktreeParent) removeWorktree(repoRoot, worktree, worktreeParent);
  }
}

// Run only when called as a script, not when the tests import it.
// Exit codes: 0 completed clean, 1 completed with an open action-required finding, 2 could not run or
// failed, 3 skipped, coverage incomplete, or finding inventory not reported complete (never exit 0 or 1).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const code = await main().catch((error: unknown) => {
    console.error(`review:local could not run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  });
  // Not process.exit: that can end the process before piped output is written out.
  process.exitCode = code;
}
