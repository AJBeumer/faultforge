// Tries a proof bundle in a throwaway checkout, the way the verifier will, then puts everything back.
//
// Usage (from the root of a throwaway export of the reviewed commit, never a git checkout):
//   node .claude/skills/prove-finding/try-proof.mjs <bundle folder> <cited file> <start>-<end>
//   node .claude/skills/prove-finding/try-proof.mjs <bundle folder> <cited file> <start>-<end> --with-fix
//
// Reads `proof.json` (`testPath`, and `fix` with --with-fix) and `proof.test.ts` from the bundle. Places the test
// at `testPath`, runs it with Vitest on the code as it is, and prints RED (assertion), GREEN or ERROR with the
// first failure line. With --with-fix it then replaces lines `fix.start`-`fix.end` of the cited file with
// `fix.lines`, runs the test again and prints the second result. Always removes the test and restores the
// cited file afterwards, even when a run fails.
//
// Each run is under Node's permission model, as in the verifier (`packages/harness/src/proof/proof-verify.ts`,
// `sandboxArgs`): the test reads only this folder and writes only a temp folder and Vitest's caches. This is a
// copy, not an import, because the skill travels to checkouts of commits that predate the verifier.
//
// Exit codes: 0 the runs happened (read the printed results); 2 bad arguments, a git checkout as the working
// folder, a missing bundle file, a path outside the working folder, an existing file at `testPath`, or a fix
// outside the cited lines.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = process.cwd();
const [bundle, citedFile, range, flag] = process.argv.slice(2);
const lines = /^(\d+)-(\d+)$/.exec(range ?? "");
function fail(message) {
  console.error(`try-proof: ${message}`);
  process.exit(2);
}
/** True when `p` is a relative path that stays inside the working folder. */
const inside = (p) =>
  !isAbsolute(p) && !relative(root, resolve(root, p)).startsWith("..") && !p.split(/[\\/]/).includes("..");

if (!bundle || !citedFile || !lines)
  fail("usage: try-proof.mjs <bundle folder> <cited file> <start>-<end> [--with-fix]");
if (existsSync(join(root, ".git"))) {
  fail(
    "this folder is a git checkout; run the skill in a throwaway export of the commit, where a crash can't leave a test behind",
  );
}
const [start, end] = [Number(lines[1]), Number(lines[2])];
for (const f of ["proof.json", "proof.test.ts"]) if (!existsSync(join(bundle, f))) fail(`the bundle has no ${f}`);
const meta = JSON.parse(readFileSync(join(bundle, "proof.json"), "utf8"));
const testPath = String(meta.testPath ?? "");
if (!/\.test\.ts$/.test(testPath) || !inside(testPath))
  fail("testPath must be a relative path inside this folder ending in .test.ts");
if (!inside(citedFile)) fail("the cited file must be a relative path inside this folder");
if (existsSync(testPath)) fail(`${testPath} already exists; a proof test is a new file`);
if (!existsSync(citedFile)) fail(`${citedFile} does not exist`);
const withFix = flag === "--with-fix";
const fix = meta.fix;
if (withFix) {
  if (!fix || !Number.isInteger(fix.start) || !Number.isInteger(fix.end) || !Array.isArray(fix.lines)) {
    fail("--with-fix needs proof.json's fix: { start, end, lines }");
  }
  if (fix.start < start || fix.end > end || fix.end < fix.start)
    fail(`fix ${fix.start}-${fix.end} is not inside ${start}-${end}`);
}

const tmp = join(root, ".try-proof-tmp");
const CACHES = [".vitest", ".vitest-cache", ".vite"]; // the folders Vitest writes under node_modules
/** The same confinement as the verifier's `sandboxArgs`: reads this folder, writes temp and caches only. */
function sandboxed(report) {
  const parents = [];
  for (let p = root, up = dirname(p); up !== p; p = up, up = dirname(p)) parents.push(up);
  const markers = parents.flatMap((p) =>
    ["pnpm-workspace.yaml", "lerna.json", "package.json"].map((f) => `--allow-fs-read=${join(p, f)}`),
  );
  const cache = (name) => `--allow-fs-write=${join(root, "node_modules", name)}${sep}*`;
  const model = [
    "--permission",
    "--allow-addons",
    "--allow-worker",
    `--allow-fs-read=${root}`,
    ...markers,
    `--allow-fs-write=${tmp}`,
    ...CACHES.map(cache),
    `--allow-fs-write=${report}`,
  ];
  // The test runs in a child process with the same model and no right to start another (see sandboxArgs).
  return [
    ...model,
    "--allow-child-process",
    join(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    testPath,
    "--pool=forks",
    ...model.map((f) => `--execArgv=${f}`),
    "--configLoader=native",
    "--reporter=json",
    `--outputFile=${report}`,
  ];
}

function runTest(name) {
  const report = join(tmp, `${name}.json`);
  rmSync(report, { force: true });
  // Emptied before every run, so nothing one run wrote can reach the next.
  for (const d of [tmp, ...CACHES.map((c) => join(root, "node_modules", c))]) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }
  // Vitest creates this token on its first start, which the sandbox doesn't let it do; a fresh one per run.
  writeFileSync(join(root, "node_modules", ".vitest", ".vitest-secret-token"), randomBytes(32).toString("hex"));
  const env = { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp };
  const ran = spawnSync(process.execPath, sandboxed(report), { encoding: "utf8", timeout: 5 * 60_000, env });
  if (!existsSync(report))
    return `ERROR (no report: ${ran.error?.message ?? (ran.stderr || "").split("\n").find((l) => /error/i.test(l)) ?? "none"})`;
  const files = JSON.parse(readFileSync(report, "utf8")).testResults ?? [];
  const loadError = files.find((f) => f.message && !(f.assertionResults ?? []).length);
  if (loadError) return `ERROR (did not load: ${loadError.message.split("\n")[0]})`;
  const tests = files.flatMap((f) => f.assertionResults ?? []);
  const failed = tests.filter((t) => t.status === "failed");
  if (!failed.length) {
    if (!tests.some((t) => t.status === "passed")) return "ERROR (no test ran: none, or all skipped)";
    return ran.status === 0 ? "GREEN" : `ERROR (the report passed but Vitest exited ${ran.status})`;
  }
  const first = (failed[0].failureMessages?.[0] ?? "").split("\n")[0];
  const assertions = failed.every((t) => /^AssertionError\b/.test(t.failureMessages?.[0] ?? ""));
  return assertions && ran.status === 1 ? `RED (${first})` : `ERROR (${first})`;
}

const original = readFileSync(citedFile, "utf8");
try {
  mkdirSync(dirname(testPath), { recursive: true });
  writeFileSync(testPath, readFileSync(join(bundle, "proof.test.ts"), "utf8"));
  console.log(`code as it is: ${runTest("as-is")}`);
  if (withFix) {
    // Each line keeps its own end; the new lines take the end of the first line they replace.
    const source = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const eol = /\r?\n$/.exec(source[fix.start - 1] ?? "")?.[0] ?? "\n";
    source.splice(fix.start - 1, fix.end - fix.start + 1, ...fix.lines.map((l) => `${l}${eol}`));
    writeFileSync(citedFile, source.join(""));
    console.log(`with the fix:  ${runTest("with-fix")}`);
  }
} finally {
  writeFileSync(citedFile, original);
  rmSync(testPath, { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
