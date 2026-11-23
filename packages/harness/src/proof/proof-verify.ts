/**
 * The verifier's decision: does a proof bundle earn a certificate? Pure: it reads facts the runner gathered
 * (`proof-run.ts`) and never trusts what the agent says about its own proof.
 *
 * A certificate needs all four:
 *  1. the test fails on the reviewed commit, and every failure is an assertion (not a crash, a load error or a
 *     timeout);
 *  2. the same test passes once the patch is applied;
 *  3. the patch changes only the cited lines of the cited file (`patchProblem`);
 *  4. the test is a new file, and no existing file changed while it ran.
 */
import { changeProblems } from "../case/gate-trial-builder.ts";
import { type Cited, patchProblem } from "./proof-patch.ts";

/** How one test run ended. */
export type RunClass = "assertion-red" | "green" | "error" | "no-tests";

/** The parts of Vitest's JSON report the verifier reads. */
export interface VitestReport {
  numTotalTests?: number;
  testResults?: {
    status?: string;
    message?: string;
    assertionResults?: { status?: string; failureMessages?: string[] }[];
  }[];
}

/**
 * How a run ended, from its JSON report (null when the run wrote none: it crashed or timed out). Red counts as
 * an assertion only when every failed test failed on an `AssertionError`, the error `expect` throws.
 */
export function classifyRun(report: VitestReport | null): RunClass {
  if (!report?.testResults) return "error";
  const files = report.testResults;
  if (files.some((f) => f.message && !(f.assertionResults ?? []).length)) return "error";
  const tests = files.flatMap((f) => f.assertionResults ?? []);
  if (tests.length === 0) return "no-tests";
  const failed = tests.filter((t) => t.status === "failed");
  if (failed.length === 0) return tests.some((t) => t.status === "passed") ? "green" : "no-tests";
  const assertion = (t: (typeof failed)[number]) => /^AssertionError\b/.test(t.failureMessages?.[0] ?? "");
  return failed.every(assertion) ? "assertion-red" : "error";
}

/**
 * The run's class, held against the process's exit code: green only with exit 0, red only with exit 1 (Vitest's
 * code for failed tests). Anything else, such as a passing report from a process that then failed, is an error.
 */
export function agreedClass(fromReport: RunClass, status: number | null): RunClass {
  if (fromReport === "green" && status !== 0) return "error";
  if (fromReport === "assertion-red" && status !== 1) return "error";
  return fromReport;
}

/** The folders under `node_modules` Vitest writes during a run: emptied before each run, so nothing carries over. */
export const SANDBOX_CACHES = [".vitest", ".vitest-cache", ".vite"] as const;

/**
 * The command line that runs one test file under Node's permission model: it reads only the export (and the
 * workspace marker files Vite looks for in each parent folder), and writes only its own temp folder, Vitest's
 * cache folders and the report. Native addons are allowed, since Vite's bundler needs one; only those `npm ci`
 * installed from the lockfile exist.
 *
 * The test itself runs in a child process (`--pool=forks`) started with the same model and no right to start a
 * process. Worker threads don't work: Vitest starts them with its own arguments, and the test ran free (checked
 * from inside a test on 23 November). Only Vitest's main process, which runs no agent code, may start the child.
 */
export function sandboxArgs(dir: string, tmp: string, report: string, testPath: string): string[] {
  const sep = dir.includes("\\") ? "\\" : "/";
  const parents: string[] = [];
  for (let p = dir; ; ) {
    const up = p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
    if (!up || up === p || /^[a-zA-Z]:$/.test(p)) break;
    parents.push(/^[a-zA-Z]:$/.test(up) ? `${up}${sep}` : up);
    p = up;
  }
  const markers = parents.flatMap((p) =>
    ["pnpm-workspace.yaml", "lerna.json", "package.json"].map(
      (f) => `--allow-fs-read=${p.replace(/[\\/]$/, "")}${sep}${f}`,
    ),
  );
  const cache = (name: string) => `--allow-fs-write=${dir}${sep}node_modules${sep}${name}${sep}*`;
  const model = [
    "--permission",
    "--allow-addons",
    "--allow-worker",
    `--allow-fs-read=${dir}`,
    ...markers,
    `--allow-fs-write=${tmp}`,
    ...SANDBOX_CACHES.map(cache),
    `--allow-fs-write=${report}`,
  ];
  return [
    ...model,
    "--allow-child-process",
    `${dir}${sep}node_modules${sep}vitest${sep}vitest.mjs`,
    "run",
    testPath,
    "--pool=forks",
    // The test runs in a child process started with the model itself, and without the right to start another.
    ...model.map((flag) => `--execArgv=${flag}`),
    "--configLoader=native",
    "--reporter=json",
    `--outputFile=${report}`,
  ];
}

/** Why the test can't go where the bundle puts it, or null. `existing` holds every file of the commit. */
export function testPathProblem(testPath: string, existing: ReadonlySet<string>): string | null {
  const path = testPath.replace(/\\/g, "/");
  if (!/^[\w.@-]+(\/[\w.@-]+)*\.test\.ts$/.test(path) || path.split("/").includes("..")) {
    return `the test path ${testPath} is not a relative path ending in .test.ts`;
  }
  if (path.split("/").includes("node_modules")) return "the test path is inside node_modules";
  if (existing.has(path)) return `the test path ${path} is an existing file; a proof adds a new one`;
  return null;
}

/** Everything the verifier gathered about one bundle. */
export interface ProofFacts {
  cited: Cited;
  testPath: string;
  testText: string;
  patch: string;
  /** Every file of the reviewed commit, by its path from the repository root. */
  existing: ReadonlySet<string>;
  /** Unset when a static problem stopped the runs. */
  reviewed?: RunClass;
  patched?: RunClass;
  /** Existing files whose content changed during a run (the cited file excluded after the patch). */
  changedFiles?: string[];
}

export interface Decision {
  certified: boolean;
  reasons: string[];
}

/**
 * Why a relative path in the test climbs above the repository, or null. A run of `../` deeper than the test's own
 * folder leaves the repository; one that stays within it (`../../deps.ts` from `src/a/b/`) is ordinary. Exam v2's
 * p11 was refused by a cruder check that called any `../../` a climb out.
 */
export function climbProblem(testPath: string, testText: string): string | null {
  const depth = testPath.replace(/\\/g, "/").split("/").length - 1;
  // Every path-like token with a `..` in it, walked segment by segment from the test's folder, so separate
  // climbs (`../../x/../../y`) add up as they would when the path resolves.
  for (const [token] of testText.matchAll(/[^\s"'`()]*\.\.[\\/][^\s"'`()]*/g)) {
    let level = depth;
    for (const segment of token.split(/[\\/]/)) {
      if (segment === "..") level -= 1;
      else if (segment !== "." && segment !== "") level += 1;
      if (level < 0) return `the relative path ${token} climbs above the repository (the test is ${depth} deep)`;
    }
  }
  return null;
}

/** The problems that need no run: where the test goes, what it reaches for, and what the patch touches. */
export function staticProblems(facts: Pick<ProofFacts, "cited" | "testPath" | "testText" | "patch" | "existing">) {
  const problems: string[] = [];
  const path = testPathProblem(facts.testPath, facts.existing);
  if (path) problems.push(path);
  const asDiff = facts.testText
    .split(/\r?\n/)
    .map((l) => `+${l}`)
    .join("\n");
  // Only the absolute-path check: a proof about this repository's own code may name it or read the environment,
  // which `plainEnv` strips of every token. shortcut: catches a path written plainly, not one built at run time;
  // the sandbox stops the rest.
  for (const p of changeProblems(asDiff).filter((p) => /absolute path/.test(p))) problems.push(`the test: ${p}`);
  const climb = climbProblem(facts.testPath, facts.testText);
  if (climb) problems.push(`the test: ${climb}`);
  const patch = patchProblem(facts.patch, facts.cited);
  if (patch) problems.push(patch);
  return problems;
}

/** The certificate decision: certified only when every condition holds; otherwise every reason it doesn't. */
export function decide(facts: ProofFacts): Decision {
  const reasons = staticProblems(facts);
  if (facts.reviewed === undefined || facts.patched === undefined) {
    if (!reasons.length) reasons.push("the test was not run");
  } else {
    if (facts.reviewed !== "assertion-red") {
      reasons.push(`on the reviewed commit the test ended ${facts.reviewed}, not as an assertion failure`);
    }
    if (facts.patched !== "green") reasons.push(`with the patch applied the test ended ${facts.patched}, not green`);
  }
  if (facts.changedFiles?.length)
    reasons.push(`existing files changed while the test ran: ${facts.changedFiles.join(", ")}`);
  return { certified: reasons.length === 0, reasons };
}
