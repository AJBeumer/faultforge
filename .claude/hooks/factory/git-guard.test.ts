/**
 * A factory run can't switch off git's own guard hooks in the lab either: no `--no-verify`, no `core.hooksPath`,
 * no change to the guard's git settings, and no file tool in a `.git` folder. The run folder is made up under the
 * temp folder.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editViolation, gitGuardViolation } from "../factory-policy.ts";
import { policyRun } from "../fixtures.ts";

const { RUN, LAB, policy } = policyRun("policy-run6-");

describe("a run can't switch off git's own guard hooks in the lab", () => {
  it.each([
    "git commit --no-verify -m x",
    "git commit -n -m x",
    "git push --no-verify origin tidy",
    "git -c core.hooksPath=/tmp push",
    "git config core.hooksPath /tmp",
    "git config review-guard.script /dev/null",
    "git config --unset review-guard.script",
    "rm .git/hooks/pre-push",
  ])("refuses %s", (command) => {
    expect(gitGuardViolation(command)).toMatch(/guard hooks run/);
    expect(policy("Bash", { command })).toMatch(/guard hooks run/);
  });

  it("refuses the file tools in a .git folder", () => {
    expect(editViolation(join(LAB, ".git", "hooks", "pre-push"), RUN)).toMatch(/\.git folder/);
    expect(policy("Write", { file_path: join(LAB, ".git", "hooks", "pre-push"), content: "exit 0" })).toMatch(
      /\.git folder/,
    );
  });

  it("still lets an ordinary commit through", () => {
    expect(gitGuardViolation('git commit -m "Tidy the list"')).toBeUndefined();
    expect(editViolation(join(LAB, "docs", "x.md"), RUN)).toBeUndefined();
  });
});
