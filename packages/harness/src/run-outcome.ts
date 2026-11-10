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
