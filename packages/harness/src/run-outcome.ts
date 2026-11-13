/**
 * A proof or public-test run's outcome: "pass", "fail", or "not_run" when the run itself never
 * finished (hit its time limit, or could not even be spawned). "fail" means the test ran and found
 * the problem; a tooling failure to run must never be recorded with that word, since the evidence
 * it would represent was never produced.
 */
export type Outcome = "pass" | "fail" | "not_run";

/**
 * Classifies a `spawnSync`-shaped result. `status` is `null` when the process was killed for
 * exceeding its time limit; `error` is set when it could not be spawned at all (e.g. `ENOENT`).
 * Either case is `not_run`, independent of whatever `status` happens to hold alongside it.
 */
export function outcomeOf(result: { status: number | null; error?: unknown }): Outcome {
  if (result.error || result.status === null) return "not_run";
  return result.status === 0 ? "pass" : "fail";
}

/** A `spawnSync` result, as much of it as a step's log needs. */
export interface RunResult {
  status: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}

/**
 * The text for a run's log artefact: the command, its outcome, and its output. The outcome is
 * written for every result, not only when `error` is set, so a process a signal killed without a
 * spawn error (its own time limit, outside this one, or an external kill) still reads as `not_run`
 * here instead of a bare "exit null" that leaves the reader to guess why.
 */
export function stepLogText(cmdArgs: string[], result: RunResult, outcome: Outcome): string {
  const detail = [
    result.signal ? `signal ${result.signal}` : null,
    result.error instanceof Error ? result.error.message : null,
  ]
    .filter((line) => line !== null)
    .join(": ");
  return `$ ${cmdArgs.join(" ")}\nexit ${result.status}\noutcome ${outcome}${detail ? ` (${detail})` : ""}\n\n${result.stdout}${result.stderr}`;
}

/** The parts of vitest's JSON report the harness reads. */
export interface VitestReport {
  testResults?: {
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: { fullName?: string; title?: string; status?: string }[];
  }[];
}

/**
 * The tests that failed and passed, from vitest's JSON report, with the files that failed before any
 * test ran kept apart: a file that can't load proves only that it imports something, not that any
 * assertion about behaviour failed (#217).
 */
export function parseVitestReport(report: VitestReport): { failed: string[]; loadFailed: string[]; passed: number } {
  const failed: string[] = [];
  const loadFailed: string[] = [];
  let passed = 0;
  for (const file of report.testResults ?? []) {
    const assertions = file.assertionResults ?? [];
    for (const a of assertions) {
      if (a.status === "failed") failed.push(a.fullName ?? a.title ?? "(unnamed test)");
      else if (a.status === "passed") passed++;
    }
    // A file that failed to load has no failed assertion, only its own status and message.
    if (file.status === "failed" && !assertions.some((a) => a.status === "failed")) {
      loadFailed.push(`${file.name ?? "(file)"}: ${(file.message ?? "failed to run").split("\n")[0]}`);
    }
  }
  return { failed, loadFailed, passed };
}

/**
 * A proof's outcome from its run and its JSON report. "fail" only when a test ran and failed; a file
 * that failed to load, a run with no test, a non-zero exit with no failed test, or a missing report
 * is "not_run", since none of them shows the invariant broken (#217).
 */
export function proofOutcomeOf(result: { status: number | null; error?: unknown }, report?: VitestReport): Outcome {
  if (outcomeOf(result) === "not_run" || !report) return "not_run";
  const { failed, loadFailed, passed } = parseVitestReport(report);
  if (loadFailed.length || failed.length + passed === 0) return "not_run";
  if (failed.length) return "fail";
  return result.status === 0 ? "pass" : "not_run";
}
