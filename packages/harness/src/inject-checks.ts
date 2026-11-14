/**
 * The checks `inject` runs on a variant besides the proofs: the target's typecheck, and its public tests; in
 * `--validate-only` its whole check, Biome included, as the target's own `npm run check` runs it, so a variant
 * is never called valid while the target's check is red; and the test a template's `testChange` adds, which
 * must pass on the variant (it tests the asked-for change, not the bug).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StepPlaces } from "./inject-run.ts";
import type { Template } from "./inject-template.ts";
import type { Outcome } from "./run-outcome.ts";

export interface VariantChecks {
  typecheck: Outcome;
  publicTests: Outcome;
  /** Run only in `--validate-only`. */
  lint?: Outcome;
  /** Run only when the template adds a test. */
  addedTest?: Outcome;
}

type RunStep = (places: StepPlaces, name: string, cmd: string, args: string[]) => Outcome;

/** Runs the checks on the variant now in `places.targetDir`. */
export function runVariantChecks(
  runStep: RunStep,
  places: StepPlaces,
  template: Pick<Template, "testChange">,
  validateOnly: boolean,
): VariantChecks {
  const { targetDir } = places;
  const node = process.execPath;
  const vitest = join(targetDir, "node_modules/vitest/vitest.mjs");
  // With the target's own test config when it has one: that is what its own check compiles (AUD-N7).
  const tsconfig = existsSync(join(targetDir, "tsconfig.test.json")) ? "tsconfig.test.json" : "tsconfig.json";
  const typecheck = runStep(places, "typecheck", node, [
    join(targetDir, "node_modules/typescript/bin/tsc"),
    "-p",
    tsconfig,
    "--noEmit",
  ]);
  const checks: VariantChecks = { typecheck, publicTests: "pass" };
  if (validateOnly) {
    checks.lint = runStep(places, "lint", node, [
      join(targetDir, "node_modules/@biomejs/biome/bin/biome"),
      "check",
      ".",
    ]);
  }
  checks.publicTests = runStep(places, "public-tests", node, [vitest, "run"]);
  if (template.testChange) {
    checks.addedTest = runStep(places, "added-test", node, [vitest, "run", template.testChange.file]);
  }
  return checks;
}

/**
 * Why these checks make the variant invalid, or undefined. In `--validate-only` the target's whole check must
 * pass, for a bug as for a control: a red check would tell the reviewer something is wrong. An added test must
 * pass in every run. (The typecheck, and a control's public tests, are judged by `variantFailure`.)
 */
export function checksFailure(checks: VariantChecks, validateOnly: boolean): string | undefined {
  if (checks.addedTest === "not_run") return "the test the change adds did not finish on the variant";
  if (checks.addedTest === "fail") return "the test the change adds fails on the variant";
  if (!validateOnly) return undefined;
  if (checks.lint !== "pass")
    return `the target's lint (Biome) ${checks.lint === "fail" ? "fails" : "did not finish"} on the variant`;
  if (checks.publicTests !== "pass") {
    return `the target's public tests ${checks.publicTests === "fail" ? "fail" : "did not finish"} on the variant`;
  }
  return undefined;
}
