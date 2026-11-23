/**
 * `npm run proof:verify`: re-runs a proof bundle against a commit and decides whether it earns a certificate
 * (`proof-verify.ts`). The agent's own verdict is never read as evidence; only these runs are.
 *
 * Usage: npm run proof:verify -- --commit <sha> --file <path> --lines <start>-<end> --bundle <dir> --out <dir> [--repo <dir>]
 *
 * The finding's file and lines come from the arguments, never from the bundle, so a proof can't move its own
 * target. A bundle is a folder with `proof.json` (`verdict`, `testPath`, `cause`, and `fix`: lines `start` to
 * `end` of the cited file replaced by `lines`) and `proof.test.ts`. The verifier builds the patch from `fix`
 * itself and saves it as `fix.patch`. Each run gets its own export of the commit in the OS temp folder: no git history, no private
 * storage, its own `npm ci`, no project, Qodo or GitHub variable in the environment. The test is placed at
 * `testPath` and run with Vitest's JSON reporter; then the patch is applied and the test runs again. Every
 * report and log is saved under `--out` before the decision, then `certificate.json`.
 *
 * Not a sandbox: the test runs as the person running this, with their network. See #27.
 *
 * Exit codes: 0 certificate issued; 1 no certificate (the proof does not hold, or the agent did not claim one);
 * 2 could not run (bad arguments, a missing bundle file, or git, npm or the export failing).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { plainEnv } from "../case/gate-trial-builder.ts";
import { sha256 } from "../shared/provenance.ts";
import { applyPatch, type Cited, type Replacement, replacementPatch } from "./proof-patch.ts";
import {
  classifyRun,
  decide,
  type ProofFacts,
  type RunClass,
  staticProblems,
  type VitestReport,
} from "./proof-verify.ts";

const TEST_TIMEOUT_MS = 5 * 60_000;

/** A failed setup step: the verifier could not run, which is never the same as "no certificate". */
export class SetupError extends Error {}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 10 * 60_000) {
  // npm is a command file on Windows, which only a shell starts; its command is fixed text, never input.
  const shell = cmd.startsWith("npm ");
  return spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout, shell, maxBuffer: 256 * 1024 * 1024 });
}

function must(result: ReturnType<typeof run>, what: string): string {
  if (result.status !== 0) throw new SetupError(`${what} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

/** The commit's files, by path from the repository root. */
export function commitFiles(repo: string, commit: string): Set<string> {
  const out = must(run("git", ["-C", repo, "ls-tree", "-r", "--name-only", commit], repo, process.env), "git ls-tree");
  return new Set(out.split("\n").filter(Boolean));
}

/**
 * The commit's files in a new temp folder, with dependencies installed. Uses its own index file, so this
 * checkout's index and working tree are never touched, and the folder holds no `.git` of the repository.
 */
export function exportCommit(repo: string, commit: string): string {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  const index = join(dir, ".export-index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  must(run("git", ["-C", repo, "read-tree", commit], repo, env), "git read-tree");
  // Byte for byte as committed: with this machine's autocrlf, a patch made from the commit would not apply.
  const checkout = ["-c", "core.autocrlf=false", "-C", repo, `--work-tree=${dir}`, "checkout-index", "-a", "-f"];
  must(run("git", checkout, repo, env), "git checkout-index");
  rmSync(index);
  must(run("npm ci --ignore-scripts --no-audit --no-fund --prefer-offline", [], dir, plainEnv(process.env)), "npm ci");
  return dir;
}

function hashes(dir: string, files: ReadonlySet<string>): Map<string, string> {
  return new Map([...files].map((f) => [f, existsSync(join(dir, f)) ? sha256(readFileSync(join(dir, f))) : "missing"]));
}

/** Existing files whose content differs from `before`, except those in `allowed`. */
function changed(dir: string, before: Map<string, string>, allowed: string[] = []): string[] {
  const after = hashes(dir, new Set(before.keys()));
  return [...before].filter(([f, h]) => !allowed.includes(f) && after.get(f) !== h).map(([f]) => f);
}

/** Runs one test file in `dir` and saves its report and log as `<out>/<name>.*`. */
export function runTest(dir: string, testPath: string, out: string, name: string): RunClass {
  const report = join(out, `${name}.report.json`);
  const vitest = join(dir, "node_modules", "vitest", "vitest.mjs");
  const args = [vitest, "run", testPath, "--reporter=json", `--outputFile=${report}`];
  const result = run(process.execPath, args, dir, plainEnv(process.env), TEST_TIMEOUT_MS);
  const timedOut = result.error ? `\n[ended: ${result.error.message}]` : "";
  writeFileSync(join(out, `${name}.log`), `exit ${result.status}${timedOut}\n${result.stdout}\n${result.stderr}`);
  if (!existsSync(report)) return "error";
  return classifyRun(JSON.parse(readFileSync(report, "utf8")) as VitestReport);
}

/** Places the test in a fresh export of `commit`, runs it, and reports how it ended and what it changed. */
export function testOnCommit(
  repo: string,
  commit: string,
  testPath: string,
  testText: string,
  out: string,
  name: string,
) {
  const files = commitFiles(repo, commit);
  const dir = exportCommit(repo, commit);
  try {
    const before = hashes(dir, files);
    mkdirSync(dirname(join(dir, testPath)), { recursive: true });
    writeFileSync(join(dir, testPath), testText);
    const result = runTest(dir, testPath, out, name);
    return { result, changedFiles: changed(dir, before), dir };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

export interface Certificate {
  certified: boolean;
  reasons: string[];
  claimed: string;
  commit: string;
  cited: Cited;
  testPath?: string;
  testSha256?: string;
  patchSha256?: string;
  reviewed?: RunClass;
  patched?: RunClass;
  verifiedAt: string;
}

/** Verifies one bundle against `commit` and writes everything to `out`, `certificate.json` last. */
export function verifyBundle(repo: string, commit: string, cited: Cited, bundle: string, out: string): Certificate {
  mkdirSync(out, { recursive: true });
  if (!existsSync(join(bundle, "proof.json"))) throw new SetupError(`the bundle ${bundle} has no proof.json`);
  const meta = JSON.parse(readFileSync(join(bundle, "proof.json"), "utf8")) as {
    verdict?: string;
    testPath?: string;
    fix?: Replacement;
  };
  const base = { claimed: String(meta.verdict), commit, cited, verifiedAt: new Date().toISOString() };
  const finish = (cert: Certificate) => {
    writeFileSync(join(out, "certificate.json"), `${JSON.stringify(cert, null, 2)}\n`);
    return cert;
  };
  if (meta.verdict !== "supported") {
    return finish({ ...base, certified: false, reasons: [`the agent claimed ${meta.verdict}, not supported`] });
  }
  if (!existsSync(join(bundle, "proof.test.ts"))) {
    return finish({ ...base, certified: false, reasons: ["the bundle claims supported but has no proof.test.ts"] });
  }
  const testText = readFileSync(join(bundle, "proof.test.ts"), "utf8");
  const original = must(run("git", ["-C", repo, "show", `${commit}:${cited.file}`], repo, process.env), "git show");
  const patch = meta.fix ? (replacementPatch(original, cited.file, meta.fix) ?? "") : "";
  writeFileSync(join(out, "fix.patch"), patch);
  const testPath = String(meta.testPath ?? "");
  const facts: ProofFacts = { cited, testPath, testText, patch, existing: commitFiles(repo, commit) };
  const hashed = { testPath, testSha256: sha256(testText), patchSha256: sha256(patch) };
  if (staticProblems(facts).length) return finish({ ...base, ...hashed, ...decide(facts) });

  const first = testOnCommit(repo, commit, testPath, testText, out, "reviewed");
  try {
    const before = hashes(first.dir, facts.existing);
    // Applied here, not with `git apply`: the patch is confined to one file, and a strict match needs no git setup.
    const citedPath = join(first.dir, cited.file);
    const applied = applyPatch(readFileSync(citedPath, "utf8"), patch);
    if (applied !== null) writeFileSync(citedPath, applied);
    const patched: RunClass = applied !== null ? runTest(first.dir, testPath, out, "patched") : "error";
    const changedFiles = [...first.changedFiles, ...changed(first.dir, before, [cited.file])];
    const decision = decide({ ...facts, reviewed: first.result, patched, changedFiles });
    if (applied === null) decision.reasons.push("the patch did not apply to the reviewed commit");
    return finish({ ...base, ...hashed, reviewed: first.result, patched, ...decision });
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const [commit, file, lines, bundle, out] = ["commit", "file", "lines", "bundle", "out"].map((n) => flag(argv, n));
  const range = /^(\d+)-(\d+)$/.exec(lines ?? "");
  if (!commit || !file || !range || !bundle || !out) {
    console.error(
      "usage: proof:verify --commit <sha> --file <path> --lines <start>-<end> --bundle <dir> --out <dir> [--repo <dir>]",
    );
    return 2;
  }
  const cited = { file, start: Number(range[1]), end: Number(range[2]) };
  try {
    const cert = verifyBundle(resolve(flag(argv, "repo") ?? "."), commit, cited, resolve(bundle), resolve(out));
    console.log(cert.certified ? "certificate issued" : `no certificate:\n- ${cert.reasons.join("\n- ")}`);
    return cert.certified ? 0 : 1;
  } catch (e) {
    console.error(`proof:verify could not run: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
