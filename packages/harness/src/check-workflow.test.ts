/**
 * The Check workflow's safety properties, read from the file itself so a later edit can't drop one quietly
 * (AUD-M20, AUD-N9). Plain text checks, as for the factory workflow.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const workflow = readFileSync(join(root, ".github/workflows/check.yml"), "utf8");

/** Every step that uses `actions/checkout`, whichever of its keys comes first (`name`, `if`, `uses`). */
function checkoutSteps(text: string): string[] {
  return text.split(/\n(?=[ \t]*- )/).filter((step) => /(?:^|\s)uses: actions\/checkout@/.test(step));
}

describe("check workflow", () => {
  const top = workflow.slice(0, workflow.indexOf("\njobs:"));

  it("gives each run on main its own group, so no main run is cancelled or replaced while queued", () => {
    // One group per ref would still let a newer main push replace a pending one, cancel-in-progress or not.
    expect(top).toMatch(
      /^concurrency:\s*\n\s*group: check-\$\{\{ github\.ref == 'refs\/heads\/main' && github\.sha \|\| github\.ref \}\}/m,
    );
  });

  it("cancels a superseded run on a branch, never on main", () => {
    expect(top).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
    expect(top).not.toMatch(/cancel-in-progress: true/);
  });

  it("keeps no token in any checkout", () => {
    const steps = checkoutSteps(workflow);
    expect(steps).toHaveLength(workflow.match(/actions\/checkout@/g)?.length ?? 0);
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (const step of steps) expect(step).toMatch(/\n\s+persist-credentials: false/);
  });

  it("finds a checkout that keeps its token, whether `uses` comes first or not", () => {
    const steps = checkoutSteps(
      [
        "    steps:",
        "      - uses: actions/checkout@abc # v4",
        "      - name: Second copy",
        "        if: always()",
        "        uses: actions/checkout@abc # v4",
        "      - uses: actions/setup-node@def # v4",
        "",
      ].join("\n"),
    );
    expect(steps).toHaveLength(2);
    for (const step of steps) expect(step).not.toMatch(/persist-credentials: false/);
  });
});
