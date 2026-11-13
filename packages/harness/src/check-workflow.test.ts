/**
 * The Check workflow's safety properties, read from the file itself so a later edit can't drop one quietly
 * (AUD-M22, AUD-N9). Plain text checks, as for the factory workflow.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const workflow = readFileSync(join(root, ".github/workflows/check.yml"), "utf8");

/** Each checkout step, from its `uses:` line up to the next step. */
function checkoutSteps(text: string): string[] {
  return text.split(/\n(?=\s*- (?:uses|run|name):)/).filter((step) => /^\s*- uses: actions\/checkout@/.test(step));
}

describe("check workflow", () => {
  it("cancels a superseded run on a branch, never on main", () => {
    const top = workflow.slice(0, workflow.indexOf("\njobs:"));
    expect(top).toMatch(/^concurrency:\s*\n\s*group: check-\$\{\{ github\.ref \}\}/m);
    expect(top).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
    expect(top).not.toMatch(/cancel-in-progress: true/);
  });

  it("keeps no token in any checkout", () => {
    const steps = checkoutSteps(workflow);
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (const step of steps) expect(step).toMatch(/\n\s+persist-credentials: false/);
  });

  it("finds a checkout that keeps its token", () => {
    const steps = checkoutSteps(
      "    steps:\n      - uses: actions/checkout@abc # v4\n      - uses: actions/setup-node@def # v4\n",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).not.toMatch(/persist-credentials: false/);
  });
});
