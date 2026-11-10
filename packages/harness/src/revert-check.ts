/**
 * Proves a PR's tests fail without its code change.
 *
 *   npm run revert:check -- target 19
 *
 * FaultForge plants bugs to test a reviewer; this does the same to the factory's own tests. In a
 * scratch copy of the PR's head, it first runs the PR's new or changed test files with the change in
 * place (they must pass: a test that fails either way proves nothing), then puts back the base
 * version of every changed code file and runs them again. At least one must fail.
 *
 * Exits 0 when at least one test failed without the change, 1 when every test still passed (the
 * tests don't prove the change), 2 when it can't judge: the PR changes no test file or no code file,
 * the PR changes its dependencies, the PR's tests fail even with the change, or the scratch copy
 * can't be built. A dependency change is a lock file that differs, or a `package.json` whose
 * `dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies` differ between
 * base and head; a `package.json` that only gains a script or changes its description is an ordinary
 * code file, put back to its base version like any other.
 *
 * Read-only for the repository: the scratch copy is made through a temporary git index into a temp
 * folder, so the working tree, the real index and every branch stay as they were (a fetch updates
 * only FETCH_HEAD). The tests run with a stripped environment: they are agent-written code, and the
 * runner that calls this holds the factory's keys.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFactory, repoConfig } from "./factory-config.ts";

export interface Change {
  /** git's name-status letter: A added, M modified, D deleted (renames are split into D and A). */
  status: string;
  path: string;
}

/** Test files (by the repo's pattern) and code files among a PR's changes. */
export function splitFiles(changes: Change[], tests: RegExp): { tests: Change[]; code: Change[] } {
  return {
    tests: changes.filter((c) => tests.test(c.path)),
    code: changes.filter((c) => !tests.test(c.path)),
  };
}

/** The test files a test runner can run: present at the PR's head and named like a test. */
export function runnableTests(tests: Change[]): string[] {
  return tests.filter((c) => c.status !== "D" && /\.(test|spec)\.[cm]?[jt]sx?$/.test(c.path)).map((c) => c.path);
}

/**
 * Parses `git diff --name-status --no-renames -z` output: status and path alternate, NUL-separated.
 * Without -z git quotes names with unusual characters, and the quoted spelling isn't a real path.
 */
export function parseNameStatus(output: string): Change[] {
  const fields = output.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    if (status && path) changes.push({ status: status.charAt(0), path });
  }
  return changes;
}

/** Lock files: any change decides which packages are installed. The copy shares one install, so it can't test both sides. */
const LOCK_FILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const MANIFEST = /(^|\/)package\.json$/;
/** The package.json sections that decide which packages are installed; the rest (scripts, description) is code. */
export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** A file's text at the base and at the head of the PR; null where the file doesn't exist. */
export type Contents = (path: string) => { base: string | null; head: string | null };

/** A value with its object keys sorted, so two manifests that only order their entries differently compare equal. */
function canonical(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The dependency sections of a package.json that differ between its base and head texts. A missing
 * file has no sections; a text that isn't a JSON object can't be compared, so every section counts as
 * changed (the safe answer: a check that can't tell declines rather than guesses).
 */
export function dependencySectionsChanged(base: string | null, head: string | null): string[] {
  const parse = (text: string | null): Record<string, unknown> | undefined => {
    if (text === null) return {};
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const before = parse(base);
  const after = parse(head);
  if (!before || !after) return [...DEPENDENCY_SECTIONS];
  return DEPENDENCY_SECTIONS.filter(
    (section) => canonical(before[section] ?? null) !== canonical(after[section] ?? null),
  );
}

export interface TestRun {
  /** False when the runner produced no result at all: the copy couldn't run its tests. */
  ran: boolean;
  /** Names of the tests that failed, including files that failed before any test ran. */
  failed: string[];
  passed: number;
  /** Why the run produced no result, when `ran` is false. */
  error?: string;
}

/** The tests that failed and passed, from vitest's JSON report. */
export function parseVitestReport(report: {
  testResults?: {
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: { fullName?: string; title?: string; status?: string }[];
  }[];
}): Omit<TestRun, "ran"> {
  const failed: string[] = [];
  let passed = 0;
  for (const file of report.testResults ?? []) {
    const assertions = file.assertionResults ?? [];
    for (const a of assertions) {
      if (a.status === "failed") failed.push(a.fullName ?? a.title ?? "(unnamed test)");
      else if (a.status === "passed") passed++;
    }
    // A file that failed to load has no failed assertion, only its own status and message.
    if (file.status === "failed" && !assertions.some((a) => a.status === "failed")) {
      failed.push(`${file.name ?? "(file)"}: ${(file.message ?? "failed to run").split("\n")[0]}`);
    }
  }
  return { failed, passed };
}

export interface Outcome {
  exit: 0 | 1 | 2;
  message: string;
  failedWithoutChange: string[];
}

/**
 * Why the PR's files alone rule out a check, before anything runs; null when a check can run. A
 * changed package.json is a dependency change only when `contents` shows one of its dependency
 * sections differs; without `contents` to read it, it counts as one (the safe answer).
 */
export function filesProblem(files: { tests: string[]; code: Change[] }, contents?: Contents): string | null {
  if (!files.tests.length) return "the PR changes no test file, so there is nothing to prove";
  if (!files.code.length) return "the PR changes no code file, so there is no change to take away";
  const deps: string[] = [];
  for (const change of files.code) {
    if (LOCK_FILES.test(change.path)) deps.push(change.path);
    else if (MANIFEST.test(change.path)) {
      const texts = contents?.(change.path);
      const sections = texts ? dependencySectionsChanged(texts.base, texts.head) : [...DEPENDENCY_SECTIONS];
      if (sections.length) deps.push(`${change.path} (${sections.join(", ")})`);
    }
  }
  if (deps.length) {
    return `the PR changes its dependencies (${deps.join(", ")}), and the copy has only one set of installed packages, so it can't run both sides`;
  }
  return null;
}

/** The verdict, from the PR's files and the two runs; `contents` reads a changed package.json at base and head. */
export function verdict(
  files: { tests: string[]; code: Change[] },
  withChange?: TestRun,
  without?: TestRun,
  contents?: Contents,
): Outcome {
  const none = (message: string): Outcome => ({ exit: 2, message, failedWithoutChange: [] });
  const problem = filesProblem(files, contents);
  if (problem) return none(problem);
  if (!withChange?.ran)
    return none(`the PR's tests couldn't run in the scratch copy: ${withChange?.error ?? "no result"}`);
  if (withChange.failed.length) {
    return none(
      `the PR's tests fail even with its change, so they prove nothing either way: ${withChange.failed.join("; ")}`,
    );
  }
  if (!without?.ran) return none(`the tests couldn't run without the change: ${without?.error ?? "no result"}`);
  if (!without.failed.length) {
    return {
      exit: 1,
      message: `every test still passes without the change, so these tests don't prove it: ${files.tests.join(", ")}`,
      failedWithoutChange: [],
    };
  }
  return {
    exit: 0,
    message: `${without.failed.length} test(s) fail without the change, as they should`,
    failedWithoutChange: without.failed,
  };
}

/**
 * Only what a test runner needs: no tokens, keys or other secrets from the caller's environment, and
 * `home` (the scratch folder) as the home directory, so tools that look for credentials there find none.
 * This is not a sandbox: the tests still run with the caller's file access, exactly as `npm run check`
 * already runs them. A real sandbox (no network, its own user) is the charter's Devil's Advocate work.
 */
export function strippedEnv(env: NodeJS.ProcessEnv, home?: string): NodeJS.ProcessEnv {
  const keep =
    /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|HOME|USERPROFILE|TEMP|TMP|TMPDIR|LANG|LC_ALL|TZ)$/i;
  const out: NodeJS.ProcessEnv = { CI: "1", NODE_ENV: "test" };
  for (const [key, value] of Object.entries(env)) if (keep.test(key)) out[key] = value;
  if (home) {
    out.HOME = home;
    out.USERPROFILE = home;
  }
  return out;
}

export interface CheckInput {
  /** The repository's local checkout. */
  repo: string;
  head: string;
  base: string;
  /** The repo's test-file pattern from factory.json. */
  tests: RegExp;
  /** Runs the given test files in a folder and reports. */
  runTests: (dir: string, files: string[]) => TestRun;
  temp?: string;
}

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The check itself, given the two commits. Builds the scratch copy, runs the PR's tests with and
 * without the change, removes the copy, and returns the verdict.
 */
export function revertCheck(input: CheckInput): Outcome & { changes: Change[] } {
  const changes = parseNameStatus(
    git(input.repo, ["diff", "--name-status", "--no-renames", "-z", input.base, input.head]),
  );
  const split = splitFiles(changes, input.tests);
  const files = { tests: runnableTests(split.tests), code: split.code };
  const show = (ref: string, path: string): string | null => {
    try {
      return git(input.repo, ["show", `${ref}:${path}`]);
    } catch {
      return null;
    }
  };
  const contents: Contents = (path) => ({ base: show(input.base, path), head: show(input.head, path) });
  const judge = (withChange?: TestRun, without?: TestRun) => ({
    ...verdict(files, withChange, without, contents),
    changes,
  });
  // Nothing to run (no tests, no code, or changed dependencies): answer without building a copy.
  if (filesProblem(files, contents)) return judge();

  const scratch = mkdtempSync(join(input.temp ?? tmpdir(), "revert-check-"));
  const link = join(scratch, "copy", "node_modules");
  try {
    const copy = join(scratch, "copy");
    // A temporary index: the repository's own index and working tree are never touched.
    const index = { GIT_INDEX_FILE: join(scratch, "index") };
    try {
      git(input.repo, ["read-tree", input.head], index);
      git(input.repo, ["checkout-index", "-a", "-f", `--prefix=${copy.replace(/\\/g, "/")}/`], index);
      const modules = join(input.repo, "node_modules");
      if (existsSync(modules)) symlinkSync(modules, link, "junction");
    } catch (error) {
      const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
      return judge({ ran: false, failed: [], passed: 0, error: `couldn't build the copy: ${why}` });
    }
    const withChange = input.runTests(copy, files.tests);
    if (!withChange.ran || withChange.failed.length) return judge(withChange);
    // Added files go; modified and deleted ones come back from the base, checked out the same way as
    // the head (same line-ending conversion), so the only difference is the change itself.
    for (const change of files.code) if (change.status === "A") rmSync(join(copy, change.path), { force: true });
    const restore = files.code.filter((c) => c.status !== "A").map((c) => c.path);
    if (restore.length) {
      const baseIndex = { GIT_INDEX_FILE: join(scratch, "index-base") };
      git(input.repo, ["read-tree", input.base], baseIndex);
      git(input.repo, ["checkout-index", "-f", `--prefix=${copy.replace(/\\/g, "/")}/`, "--", ...restore], baseIndex);
    }
    return judge(withChange, input.runTests(copy, files.tests));
  } finally {
    // Remove the link to node_modules by itself first, so deleting the copy can never reach the real one.
    try {
      if (lstatSync(link).isSymbolicLink() || existsSync(link)) unlinkSync(link);
    } catch {
      // No link was made, or it is already gone.
    }
    // If the link is somehow still there, leave the copy behind rather than risk the real packages.
    if (existsSync(link))
      console.error(`revert:check left ${scratch} in place: its node_modules link couldn't be removed`);
    else rmSync(scratch, { recursive: true, force: true });
  }
}

type Spawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; encoding: "utf8"; timeout: number },
) => { status: number | null; stderr?: string; error?: Error };

/**
 * Runs vitest on the files, in the folder, with the stripped environment, and reads its JSON report.
 * The report from an earlier run is removed first: a run that dies before writing one must read as
 * "didn't run", never as the earlier run's result.
 */
export function runVitest(dir: string, files: string[], spawn: Spawn = spawnSync): TestRun {
  const vitest = join(dir, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitest)) return { ran: false, failed: [], passed: 0, error: "vitest isn't installed in the repo" };
  const report = join(dir, ".revert-check-report.json");
  rmSync(report, { force: true });
  const result = spawn(process.execPath, [vitest, "run", ...files, "--reporter=json", `--outputFile=${report}`], {
    cwd: dir,
    env: strippedEnv(process.env, dirname(dir)),
    encoding: "utf8",
    timeout: 10 * 60_000,
  });
  if (!existsSync(report)) {
    const why = (result.error?.message ?? result.stderr ?? "").trim().split("\n").slice(-3).join(" ");
    return { ran: false, failed: [], passed: 0, error: `vitest wrote no report (exit ${result.status}): ${why}` };
  }
  return { ran: true, ...parseVitestReport(JSON.parse(readFileSync(report, "utf8"))) };
}

function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 60_000 });
}

async function main() {
  const factory = loadFactory();
  const [repoKey, prArg] = process.argv.slice(2);
  const pr = Number(prArg);
  if (!repoKey || !Number.isInteger(pr) || pr <= 0) {
    console.error(`usage: npm run revert:check -- <${Object.keys(factory.repos).join("|")}> <pr>`);
    process.exit(2);
  }
  const config = repoConfig(factory, repoKey);
  const lab = fileURLToPath(new URL("../../..", import.meta.url));
  const repo = resolve(lab, config.path);
  const view = JSON.parse(
    gh("pr", "view", String(pr), "--repo", config.github, "--json", "headRefOid,baseRefOid,mergeCommit,state"),
  ) as { headRefOid: string; baseRefOid: string; mergeCommit: { oid: string } | null; state: string };
  // A merged PR's change is already in main, so its base is where it forked from main as it was before the merge.
  const fork = view.mergeCommit?.oid ?? view.baseRefOid;
  git(repo, ["fetch", "-q", "origin", `pull/${pr}/head`, fork]);
  const head = view.headRefOid;
  const base = git(repo, ["merge-base", head, view.mergeCommit ? `${fork}^1` : fork]).trim();
  console.log(
    `revert:check ${repoKey} PR ${pr}: head ${head.slice(0, 7)}, base ${base.slice(0, 7)} (${view.state.toLowerCase()})`,
  );

  const result = revertCheck({ repo, head, base, tests: new RegExp(config.tests), runTests: runVitest });
  const split = splitFiles(result.changes, new RegExp(config.tests));
  console.log(`Test files: ${split.tests.map((c) => c.path).join(", ") || "none"}`);
  console.log(`Code files: ${split.code.map((c) => c.path).join(", ") || "none"}`);
  for (const name of result.failedWithoutChange) console.log(`- fails without the change: ${name}`);
  console.log(`${["Caught", "Not proven", "Can't judge"][result.exit]}: ${result.message}.`);

  const record = { repo: config.github, pr, head, base, ...result, recordedAt: new Date().toISOString() };
  const dir = join(lab, factory.evidence, "revert-checks", `${repoKey}-pr${pr}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${head.slice(0, 7)}.revert-check.json`), `${JSON.stringify(record, null, 2)}\n`);
  process.exit(result.exit);
}

// Exit codes: 0 caught, 1 not proven, 2 can't judge (no tests, no code, a dependency change, tests that fail with the change, or couldn't run).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch((error: unknown) => {
    console.error(`revert:check could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
