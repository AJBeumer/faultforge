/**
 * The runner's own check of a pull request the agent says is ready: its state, head and checks on GitHub,
 * Qodo's review of its head (`review:wait`) and its tests (`revert:check`), both run from a trusted checkout
 * of `main`. Split from factory-tick.ts (#227).
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type FactoryConfig, repoConfig } from "./factory-config.ts";
import { REVERT_CHECK_TIMEOUT_MS } from "./factory-exec.ts";
import { reviewerRuleGates } from "./factory-gates.ts";
import type { Workspace } from "./factory-tick.ts";
import { ROOT as LAB_ROOT } from "./paths.ts";
import { buildTrustedCheckout, removeTrustedCheckout } from "./trusted-checkout.ts";

export interface Verification {
  /** Problems that stop a PR from counting as delivered; empty when it checks out. */
  problems: string[];
  /** Where `revert:check`'s saved record was read back from, for the run log; null when the check
   * never ran (an earlier problem, such as an incomplete review, stopped verification first). */
  revertCheckRecord?: string | null;
  /** Why the PR waits for the owner whatever the agent reported, such as a change to the reviewer's rules (#215). */
  ownerGates?: string[];
}

/** Problems with a PR's checks: none may be pending or failed, and at least one must have run. */
/**
 * The commit the runner must see reviewed: the agent's own branch tip in its worktree. GitHub's PR view
 * can still show the previous head right after a push (PR 65), so it is used only when the branch isn't
 * in the worktree. Null when neither is a commit id: the result goes on an npm command line.
 */
export function commitToVerify(localTip: string | null, viewHead: string): string | null {
  const commit = localTip ?? viewHead;
  return /^[0-9a-f]{40}$/i.test(commit) ? commit : null;
}

/** Problems with the PR as GitHub shows it once the review of `pushed` is complete. */
export function prViewProblems(
  view: { state: string; headRefOid: string; statusCheckRollup?: Parameters<typeof checkProblems>[0] },
  pushed: string,
): string[] {
  const problems: string[] = [];
  if (view.state !== "OPEN") problems.push(`the pull request is ${String(view.state).toLowerCase()}, not open`);
  if (view.headRefOid !== pushed) {
    problems.push(
      `GitHub shows the head as ${view.headRefOid.slice(0, 7)}, not the agent's last commit ${pushed.slice(0, 7)}`,
    );
  }
  problems.push(...checkProblems(view.statusCheckRollup ?? []));
  return problems;
}

export function checkProblems(
  rollup: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[],
): string[] {
  if (!rollup.length) return ["no checks ran on the pull request"];
  const bad = rollup.filter((c) => {
    const state = (c.conclusion || c.state || c.status || "").toUpperCase();
    return !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state);
  });
  return bad.length
    ? [
        `checks not green: ${bad.map((c) => `${c.name ?? c.context} ${c.conclusion || c.state || c.status}`).join(", ")}`,
      ]
    : [];
}

/** Titles of the action-required findings still open in a `review:wait` record. */
export function openActionRequired(record: {
  openFindings?: { severity?: string | null; title?: string | null }[];
}): string[] {
  return (record.openFindings ?? [])
    .filter((f) => f.severity === "action_required")
    .map((f) => f.title ?? "(untitled)");
}

/**
 * A problem for `revert:check`'s exit code; empty only when the process exited 0 *and* its saved
 * record agrees the change was caught. A bare zero exit is never enough on its own: a forged or
 * stubbed script could exit 0 without ever writing one, so an exit with no matching record is treated
 * as unverified, the same way a missing review record already is (Qodo on PR 155). Only the exit code
 * and category reach a problem, never the record's own `message` or `failedWithoutChange`: those can
 * hold agent-written test names and file-load errors, which must never reach a ticket a reviewer can
 * read - the full detail stays in the saved `revert-check.json` record for the owner to read directly.
 * When no record exists at all, the last line of the process's own output is used instead, bounded in
 * size for the same reason.
 */
export function revertCheckProblems(status: number | null, record: { exit?: 0 | 1 | 2 } | null, output = ""): string[] {
  if (status === 0 && record?.exit === 0) return [];
  const category: Record<number, string> = {
    1: "every test still passes without the change, so it doesn't prove it",
    2: "it couldn't judge the change (no test or code file changed, a dependency change, or the tests failed with the change too)",
  };
  if (status === 0) {
    return [
      `revert:check exited 0 but its saved record ${record ? `says exit ${record.exit}` : "is missing"}, so its verdict can't be trusted`,
    ];
  }
  if (record && record.exit !== undefined && record.exit in category) {
    return [`revert:check: ${category[record.exit]} (full detail in its saved record)`];
  }
  const tail = output.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
  return [`revert:check gave no result (exit ${status}${tail ? `: ${tail}` : ""})`];
}

/** A saved JSON record, or null when the file is missing, or so damaged it can't be parsed. A reader
 * must never throw on it: a record a process died before finishing writing is no different from one
 * that was never written at all - both read as no result, not as a crash (#161). */
export function readJsonRecord(file: string): unknown | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The external calls `verifyPrWith` needs, so a test can hand it fakes for `gh` and `npm` while still
 * exercising the real `buildTrustedCheckout` (a real git clone of a real `main`) underneath it. */
export interface VerifyPrIo {
  ghJson: <T>(...args: string[]) => T;
  git: (cwd: string, ...args: string[]) => string;
  npm: (cwd: string, args: string[], timeoutMs?: number) => { status: number | null; output: string };
}

/**
 * Checks one pull request the agent says is ready: that Qodo's review of its head is complete with no
 * action-required finding open (`review:wait`), and that its own new or changed tests actually catch
 * the change (`revert:check`). Both run from the same freshly fetched checkout of `main`, built once by
 * `buildTrustedCheckout` and removed when this call returns - never from `ws.lab`, the agent's own
 * writable worktree. Otherwise a committed edit to `review-wait.ts`, `revert-check.ts` or a module
 * either imports, on the very pull request being checked, could change the verdict the runner reads
 * about its own review (#161, #170).
 *
 * `trustedRemoteUrl` turns the harness's GitHub address into the address `buildTrustedCheckout` fetches
 * from; a test can pass a local bare repository's path instead, so the whole check runs with no network
 * and no GitHub credentials, the same way `buildTrustedCheckout`'s own tests do (#161).
 */
export function verifyPrWith(
  io: VerifyPrIo,
  factory: FactoryConfig,
  runsRoot: string,
  trustedRemoteUrl: (github: string) => string,
  ws: Workspace,
  repoKey: string,
  pr: number,
): Verification {
  const repo = repoConfig(factory, repoKey);
  const { github } = repo;
  const first = io.ghJson<{ headRefOid: string; headRefName: string }>(
    "pr",
    "view",
    String(pr),
    "--repo",
    github,
    "--json",
    "headRefOid,headRefName",
  );
  // The agent's branch tip is what it pushed; GitHub's view of the head can lag a push.
  const dir = repo.path === "." ? ws.lab : resolve(ws.lab, repo.path);
  let localTip: string | null = null;
  try {
    localTip = io.git(dir, "rev-parse", "--verify", `refs/heads/${String(first.headRefName)}`);
  } catch {
    localTip = null;
  }
  const pushed = commitToVerify(localTip, String(first.headRefOid));
  if (!pushed) return { problems: ["no commit id for the pull request's head"] };

  const runId = basename(ws.root);
  const verifyRoot = join(runsRoot, `verify-${runId}-${repoKey}-pr${pr}`);
  rmSync(verifyRoot, { recursive: true, force: true });
  // The repo whose `factory.json` path is "." is the harness itself: its GitHub address, never any
  // checkout's own (mutable, untracked) `origin`, says where the trusted fetch must come from.
  const labRepo = Object.values(factory.repos).find((r) => r.path === ".");
  if (!labRepo)
    return { problems: ['factory.json names no repo at path ".", so there\'s nowhere trusted to fetch main from'] };
  let trustedLab: string;
  try {
    trustedLab = buildTrustedCheckout(
      verifyRoot,
      basename(LAB_ROOT),
      trustedRemoteUrl(labRepo.github),
      repo.path === "." ? undefined : { source: resolve(LAB_ROOT, repo.path), path: repo.path },
    );
  } catch (error) {
    return { problems: [error instanceof Error ? error.message : String(error)] };
  }

  const problems: string[] = [];
  let revertCheckRecord: string | null = null;
  let ownerGates: string[] = [];
  try {
    // --commit: it waits until GitHub shows the pushed commit, then for that commit's review.
    const review = io.npm(trustedLab, [
      "run",
      "-s",
      "review:wait",
      "--",
      repoKey,
      String(pr),
      "--commit",
      pushed,
      "--timeout",
      "5",
    ]);
    const short = pushed.slice(0, 7);
    // Copied over whatever review:wait saved before this call's own trusted checkout is removed, win
    // or lose: a timed-out or skipped review still writes which Qodo comments it saw and the raw API
    // answers, which are worth keeping even when the PR doesn't count as verified (Qodo on PR 171).
    // The whole per-PR folder, not just the final record: this is the same permanent path
    // `saveEvidence` already carries to the private repo.
    const trustedReviewDir = join(trustedLab, factory.evidence, "reviews", `${repoKey}-pr${pr}`);
    const reviewRecordFile = join(trustedReviewDir, `${short}.review.json`);
    if (existsSync(trustedReviewDir)) {
      const permanentReviewDir = join(ws.lab, factory.evidence, "reviews", `${repoKey}-pr${pr}`);
      try {
        mkdirSync(permanentReviewDir, { recursive: true });
        cpSync(trustedReviewDir, permanentReviewDir, { recursive: true });
      } catch (error) {
        problems.push(
          `couldn't save review:wait's evidence where the run log points: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const meaning: Record<number, string> = {
      1: "Qodo's review of the agent's last commit isn't complete, or the pull request's head never became it",
      2: "review:wait couldn't run",
      3: "Qodo skipped the review of the head commit",
    };
    if (review.status !== 0)
      return { problems: [meaning[review.status ?? 2] ?? `review:wait exited ${review.status}`, ...problems] };
    // Read again after the review: state, head and checks must all be of the pushed commit.
    const view = io.ghJson<Parameters<typeof prViewProblems>[0]>(
      "pr",
      "view",
      String(pr),
      "--repo",
      github,
      "--json",
      "state,headRefOid,statusCheckRollup",
    );
    problems.push(...prViewProblems(view, pushed));
    // Read from GitHub by the runner, never taken from the agent's report (#215).
    try {
      ownerGates = reviewerRuleGates(io.ghJson("api", "--paginate", "--slurp", `repos/${github}/pulls/${pr}/files`));
    } catch {
      ownerGates = reviewerRuleGates(null);
    }
    // A complete review can still have findings open: only none action-required counts as ready.
    if (!existsSync(reviewRecordFile)) problems.push("review:wait saved no review record for the head commit");
    else {
      // A damaged record is a problem to report, never a crash that loses the rest of this verdict (audit N-12).
      const record = readJsonRecord(reviewRecordFile) as Parameters<typeof openActionRequired>[0] | null;
      if (!record) problems.push("review:wait's record for the head commit couldn't be read");
      else {
        const open = openActionRequired(record);
        if (open.length) problems.push(`${open.length} action-required finding(s) still open: ${open.join("; ")}`);
      }
    }

    // Prove the tests, after the review check: the PR's own new or changed tests must fail without
    // its change. The runner checks this itself rather than trusting the agent to have run it (#101).
    // Same trusted checkout as review:wait, for the same reason (#161).
    const revertRecordFile = join(
      trustedLab,
      factory.evidence,
      "revert-checks",
      `${repoKey}-pr${pr}`,
      `${short}.revert-check.json`,
    );
    const permanentRecordFile = join(
      ws.lab,
      factory.evidence,
      "revert-checks",
      `${repoKey}-pr${pr}`,
      `${short}.revert-check.json`,
    );
    const revert = io.npm(
      trustedLab,
      ["run", "-s", "revert:check", "--", repoKey, String(pr)],
      REVERT_CHECK_TIMEOUT_MS,
    );
    // A damaged or missing record reads as no result, never throws: the rest of this verdict (the
    // review checks above) must still reach the caller.
    const revertRecord = readJsonRecord(revertRecordFile) as { exit?: 0 | 1 | 2 } | null;
    if (existsSync(revertRecordFile)) {
      try {
        mkdirSync(dirname(permanentRecordFile), { recursive: true });
        copyFileSync(revertRecordFile, permanentRecordFile);
        revertCheckRecord = permanentRecordFile;
      } catch (error) {
        problems.push(
          `couldn't save revert:check's record where the run log points: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    problems.push(...revertCheckProblems(revert.status, revertRecord, revert.output));
  } finally {
    const leftover = removeTrustedCheckout(verifyRoot);
    if (leftover) console.error(leftover);
  }
  return { problems, revertCheckRecord, ownerGates };
}
