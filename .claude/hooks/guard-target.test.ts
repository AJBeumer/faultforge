import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOOK = join(import.meta.dirname, "guard-target.ts");
const HARNESS = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";

/** Runs the hook with a payload and returns the deny reason, or undefined if allowed. */
function decide(tool: string, toolInput: object, cwd = HARNESS): string | undefined {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: toolInput }),
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  if (!result.stdout.trim()) return undefined;
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
}

const bash = (command: string, cwd?: string) => decide("Bash", { command }, cwd);

describe("guard-target hook", () => {
  describe("blocks", () => {
    it("a PR body that names the lab", () => {
      expect(bash('gh pr create --repo AJBeumer/faultforge-target --title "Tidy" --body "FaultForge case"')).toMatch(/names the lab/);
    });

    it("a target commit that says planted", () => {
      expect(bash('git -C /d/Projects/faultforge-target commit -m "Fix planted bug"')).toMatch(/says planted/);
    });

    it("a force push to the target", () => {
      expect(bash("cd /d/Projects/faultforge-target && git push --force origin main")).toMatch(/Force pushes/);
    });

    it("a comment with a case id posted through gh api", () => {
      expect(bash('gh api repos/AJBeumer/faultforge-target/issues/1/comments -f body="FF-0002 closed"')).toMatch(/case id/);
    });

    it("an edit to a target file that names the lab", () => {
      expect(decide("Edit", { file_path: "D:/Projects/faultforge-target/README.md", new_string: "Used by FaultForge" })).toMatch(/names the lab/);
    });

    it("a commit made from inside the target that mentions the ledger", () => {
      expect(bash('git commit -m "Update ledger"', TARGET)).toMatch(/ledger/);
    });
  });

  describe("allows", () => {
    it("a neutral PR on the target", () => {
      expect(bash('gh pr create --repo AJBeumer/faultforge-target --title "Simplify replay lookup" --body "Small cleanup."')).toBeUndefined();
    });

    it("read-only gh api calls on the target", () => {
      expect(bash("gh api repos/AJBeumer/faultforge-target/issues/1/comments")).toBeUndefined();
    });

    it("a neutral target commit", () => {
      expect(bash('cd /d/Projects/faultforge-target && git commit -m "Shorten README intro"')).toBeUndefined();
    });

    it("commits in this repository that mention the lab", () => {
      expect(bash('git commit -m "Add FaultForge proof test and ledger"')).toBeUndefined();
    });

    it("Fastify's app.inject in target tests", () => {
      expect(decide("Edit", { file_path: "D:/Projects/faultforge-target/test/x.test.ts", new_string: "await app.inject(req) // deps are injected" })).toBeUndefined();
    });

    it("a normal push to the target", () => {
      expect(bash("git -C D:/Projects/faultforge-target push -u origin tidy-x")).toBeUndefined();
    });
  });
});
