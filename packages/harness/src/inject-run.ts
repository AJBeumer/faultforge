/**
 * How `inject` runs things: commands with a time limit, git in the target, each step's log saved as an
 * artefact, and one proof test at a time in its own scratch folder. Also the answer key's jsonl helpers.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Proof } from "./inject-template.ts";
import { readJsonLines } from "./jsonl.ts";
import { ROOT } from "./paths.ts";
import { type Outcome, outcomeOf, proofOutcomeOf, readVitestReport, stepLogText } from "./run-outcome.ts";

/** Where a run's steps happen and leave their logs. */
export interface StepPlaces {
  targetDir: string;
  artefactDir: string;
  templateDir: string;
}

/** Runs one proof test in a scratch folder holding only that file, so proof file names never collide. */
export function runProof(places: StepPlaces, stage: "base" | "variant", proof: Proof, index: number): Outcome {
  const scratch = mkdtempSync(join(tmpdir(), "faultforge-proof-"));
  try {
    const dest = join(scratch, proof.proofTest);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(places.templateDir, proof.proofTest), dest);
    // The JSON report says whether a test ran and failed; an exit code alone can't tell that from a
    // proof that failed to load (#217).
    const report = join(scratch, "proof-report.json");
    const outcome = runStep(
      places,
      // Numbered: two proofs may share an invariant id, and each keeps its own log (#193).
      `proof-${stage}-${index + 1}-${proof.invariantId}`,
      process.execPath,
      [
        join(ROOT, "node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        scratch,
        "--config",
        join(ROOT, "vitest.proof.config.ts"),
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${report}`,
      ],
      ROOT,
      { FAULTFORGE_TARGET_DIR: places.targetDir },
      (result) => proofOutcomeOf(result, readVitestReport(report)),
    );
    log(`proof ${proof.invariantId} on ${stage}: ${outcome}`);
    return outcome;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs a command, stores its output as an artefact, and reports the outcome: "not_run", never
 * "fail", when the command hit its time limit or could not be spawned at all, since no test result
 * was ever produced for either.
 */
export function runStep(
  places: Pick<StepPlaces, "targetDir" | "artefactDir">,
  name: string,
  cmd: string,
  cmdArgs: string[],
  cwd = places.targetDir,
  env: Record<string, string> = {},
  judge: (result: ReturnType<typeof run>) => Outcome = outcomeOf,
): Outcome {
  const result = run(cmd, cmdArgs, cwd, env);
  const outcome = judge(result);
  writeFileSync(join(places.artefactDir, `${name}.log`), stepLogText(cmdArgs, result, outcome));
  return outcome;
}

export function run(cmd: string, cmdArgs: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, NO_COLOR: "1" },
    timeout: 120_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export function git(targetDir: string, ...gitArgs: string[]): string {
  const result = run("git", gitArgs, targetDir);
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The file's lines (`readJsonLines`), or none when there is no file yet. */
export function readJsonl(path: string): Record<string, unknown>[] {
  return existsSync(path) ? readJsonLines(path) : [];
}

export function appendJsonl(path: string, value: object) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export function log(message: string) {
  console.log(`[inject] ${message}`);
}
