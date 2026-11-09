import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { commandViolations, editViolation } from "./factory-policy.ts";

const HOOK = join(import.meta.dirname, "factory-policy.ts");
// Native absolute paths, so the tests mean the same on Windows and on CI's Linux.
const RUN = resolve("/runs/20261109-1200-target-18");
const TEMP = resolve("/scratch-temp");

describe("factory policy: commands", () => {
  it.each([
    "gh pr merge 12 --repo AJBeumer/faultforge-target --squash",
    "cd x && gh pr comment 12 --body 'not a bug'",
    "gh pr review 12 --approve",
    "gh pr close 12",
    "gh issue comment 18 --body done",
    "gh issue edit 18 --remove-label agent-working",
    "gh issue close 18",
    "gh api repos/a/b/pulls/12/comments/9/replies -f body=no",
    "gh api -X PATCH repos/a/b/issues/18 --input x.json",
    "gh api --method DELETE repos/a/b/git/refs/heads/x",
    "gh repo edit --delete-branch-on-merge",
    "gh label create agent-done",
    "gh secret set QODO_API_KEY",
    "git push --force origin feature",
    "git push -f",
    "git push --force-with-lease origin x",
    "git push origin +feature",
    "git push origin :feature",
    "git push origin --delete feature",
    "git push origin main",
    "git push origin HEAD:main",
    "git -C ../faultforge-target push origin refs/heads/main",
    "schtasks /Change /TN x /ENABLE",
    "setx GH_TOKEN x",
    "node dismiss-finding.js",
  ])("blocks %s", (command) => {
    expect(commandViolations(command)).not.toEqual([]);
  });

  it.each([
    "gh issue view 18 --repo AJBeumer/faultforge-target",
    "gh issue edit 18 --body-file body.md",
    "gh pr create --title 'Filter bookings' --body-file pr.md",
    "gh pr edit 12 --body-file pr.md",
    "gh pr view 12 --json state",
    "gh pr diff 12 --name-only",
    "gh api repos/a/b/pulls/12/comments",
    "gh api -X GET repos/a/b/issues",
    "gh repo view AJBeumer/faultforge",
    "gh label list",
    "git push -u origin status-filter",
    "git push origin maintenance-window",
    "git merge origin/main",
    "npm run review:wait -- target 12",
    "npm run check",
  ])("allows %s", (command) => {
    expect(commandViolations(command)).toEqual([]);
  });
});

describe("factory policy: file edits", () => {
  it("allows files in the run's folder and the temp folder", () => {
    expect(editViolation(join(RUN, "faultforge-target", "src", "a.ts"), RUN, TEMP)).toBeUndefined();
    expect(editViolation(join(TEMP, "pr-body.md"), RUN, TEMP)).toBeUndefined();
  });

  it("blocks the owner's checkouts and look-alike folders", () => {
    expect(editViolation(resolve("/Projects/faultforge-target/src/a.ts"), RUN, TEMP)).toMatch(/only files under/);
    expect(editViolation(join(`${RUN}-other`, "a.ts"), RUN, TEMP)).toMatch(/only files under/);
    expect(editViolation(`${RUN}/../a.ts`, RUN, TEMP)).toMatch(/only files under/);
  });

  it("blocks edits to the guardrails inside the run folder", () => {
    expect(editViolation(join(RUN, "FaultForge", ".claude", "hooks", "factory-policy.ts"), RUN, TEMP)).toMatch(
      /own guardrails/,
    );
    expect(editViolation(join(RUN, "FaultForge", ".claude", "settings.json"), RUN, TEMP)).toMatch(/own guardrails/);
    expect(editViolation(join(RUN, "FaultForge", ".claude-notes.md"), RUN, TEMP)).toBeUndefined();
  });

  it("follows a link inside the run folder to where it really lands", () => {
    const base = mkdtempSync(join(tmpdir(), "policy-link-"));
    const run = join(base, "run");
    const owner = join(base, "owner-checkout");
    mkdirSync(run);
    mkdirSync(owner);
    // A junction needs no admin rights on Windows; elsewhere it is an ordinary directory symlink.
    symlinkSync(owner, join(run, "linked"), "junction");
    try {
      expect(editViolation(join(run, "linked", "README.md"), run, join(base, "temp"))).toMatch(/only files under/);
      expect(editViolation(join(run, "own", "new-file.ts"), run, join(base, "temp"))).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("blocks every edit when the run folder is unknown", () => {
    expect(editViolation(join(RUN, "a.ts"), undefined, TEMP)).toMatch(/no FAULTFORGE_RUN_ROOT/);
  });
});

describe("factory policy hook", () => {
  const run = (env: Record<string, string>, payload: object) =>
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, FAULTFORGE_FACTORY_RUN: "", FAULTFORGE_RUN_ROOT: "", ...env },
    });

  it("does nothing outside a factory run", () => {
    const result = run({}, { tool_name: "Bash", tool_input: { command: "gh pr merge 1" } });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("denies a merge inside a run, with the reason", () => {
    const result = run(
      { FAULTFORGE_FACTORY_RUN: "test", FAULTFORGE_RUN_ROOT: RUN },
      { tool_name: "Bash", tool_input: { command: "gh pr merge 1" } },
    );
    const decision = JSON.parse(result.stdout).hookSpecificOutput;
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toMatch(/only the owner merges/);
  });

  it("denies an edit outside the run folder inside a run", () => {
    const result = run(
      { FAULTFORGE_FACTORY_RUN: "test", FAULTFORGE_RUN_ROOT: RUN },
      { tool_name: "Edit", cwd: RUN, tool_input: { file_path: resolve("/Projects/FaultForge/README.md") } },
    );
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
