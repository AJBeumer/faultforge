// Tries a proof bundle in this checkout, the way the verifier will, then puts everything back.
//
// Usage (from the repository root):
//   node .claude/skills/prove-finding/try-proof.mjs <bundle folder> <cited file> <start>-<end>
//   node .claude/skills/prove-finding/try-proof.mjs <bundle folder> <cited file> <start>-<end> --with-fix
//
// Reads `proof.json` (`testPath`, and `fix` with --with-fix) and `proof.test.ts` from the bundle. Places the test
// at `testPath`, runs it with Vitest on the code as it is, and prints RED (assertion), GREEN or ERROR with the
// first failure line. With --with-fix it then replaces lines `fix.start`-`fix.end` of the cited file with
// `fix.lines`, runs the test again and prints the second result. Always removes the test and restores the
// cited file afterwards, even when a run fails.
//
// Exit codes: 0 the runs happened (read the printed results); 2 bad arguments, a missing bundle file, an existing
// file at `testPath`, or a fix outside the cited lines.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const [bundle, citedFile, range, flag] = process.argv.slice(2);
const lines = /^(\d+)-(\d+)$/.exec(range ?? "");
function fail(message) {
  console.error(`try-proof: ${message}`);
  process.exit(2);
}
if (!bundle || !citedFile || !lines)
  fail("usage: try-proof.mjs <bundle folder> <cited file> <start>-<end> [--with-fix]");
const [start, end] = [Number(lines[1]), Number(lines[2])];
for (const f of ["proof.json", "proof.test.ts"]) if (!existsSync(join(bundle, f))) fail(`the bundle has no ${f}`);
const meta = JSON.parse(readFileSync(join(bundle, "proof.json"), "utf8"));
const testPath = String(meta.testPath ?? "");
if (!/\.test\.ts$/.test(testPath) || testPath.includes(".."))
  fail("testPath must be a relative path ending in .test.ts");
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

const scratch = mkdtempSync(join(tmpdir(), "try-proof-"));
function runTest(name) {
  const report = join(scratch, `${name}.json`);
  const vitest = join("node_modules", "vitest", "vitest.mjs");
  const ran = spawnSync(process.execPath, [vitest, "run", testPath, "--reporter=json", `--outputFile=${report}`], {
    encoding: "utf8",
    timeout: 5 * 60_000,
  });
  if (!existsSync(report)) return `ERROR (no report: ${ran.error?.message ?? (ran.stderr || "").split("\n")[0]})`;
  const files = JSON.parse(readFileSync(report, "utf8")).testResults ?? [];
  const loadError = files.find((f) => f.message && !(f.assertionResults ?? []).length);
  if (loadError) return `ERROR (did not load: ${loadError.message.split("\n")[0]})`;
  const tests = files.flatMap((f) => f.assertionResults ?? []);
  const failed = tests.filter((t) => t.status === "failed");
  if (!tests.length) return "ERROR (no tests ran)";
  if (!failed.length) return "GREEN";
  const first = (failed[0].failureMessages?.[0] ?? "").split("\n")[0];
  return failed.every((t) => /^AssertionError\b/.test(t.failureMessages?.[0] ?? ""))
    ? `RED (${first})`
    : `ERROR (${first})`;
}

const original = readFileSync(citedFile, "utf8");
try {
  mkdirSync(dirname(testPath), { recursive: true });
  writeFileSync(testPath, readFileSync(join(bundle, "proof.test.ts"), "utf8"));
  console.log(`code as it is: ${runTest("as-is")}`);
  if (withFix) {
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const source = original.split(/\r?\n/);
    source.splice(fix.start - 1, fix.end - fix.start + 1, ...fix.lines);
    writeFileSync(citedFile, source.join(eol));
    console.log(`with the fix:  ${runTest("with-fix")}`);
  }
} finally {
  writeFileSync(citedFile, original);
  rmSync(testPath, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
