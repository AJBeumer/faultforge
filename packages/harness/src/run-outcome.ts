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
