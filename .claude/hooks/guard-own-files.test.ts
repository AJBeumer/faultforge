/**
 * The guard's own files in the checkout it runs from (#335; re-grade 6, H12, H14, H18): no shell command and no
 * Write or Edit changes them there, unless the owner has made the unlock file by hand. A worktree or another clone,
 * where a normal PR is made, stays free. The checkout under test is a temporary one, named to the guard with
 * FAULTFORGE_GUARD_ROOT; the real one is never touched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { relation, UNLOCK_FILE } from "./guard-self.ts";
import { decide } from "./guard-target.ts";

const TARGET = tempRepo(true);
const CONFIG = guardConfig(TARGET.dir);
/** The checkout the guard runs from, with its own files in place. */
const OWN = tempRepo(true);
mkdirSync(join(OWN.dir, ".claude", "hooks"), { recursive: true });
mkdirSync(join(OWN.dir, "packages", "harness", "src"), { recursive: true });
writeFileSync(join(OWN.dir, ".claude", "hooks", "git-guard.ts"), "export {};\n");
writeFileSync(join(OWN.dir, ".claude", "settings.json"), "{}\n");
writeFileSync(join(OWN.dir, "packages", "harness", "src", "neutral.ts"), "export {};\n");
/** A worktree elsewhere, where a guard change is made for a PR. */
const WORKTREE = tempRepo(true);
mkdirSync(join(WORKTREE.dir, ".claude", "hooks"), { recursive: true });
const ELSEWHERE = mkdtempSync(join(tmpdir(), "guard-own-elsewhere-"));
const UNLOCK = join(OWN.dir, ".git", UNLOCK_FILE);

function ask(tool: string, input: object, cwd: string): string | undefined {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAULTFORGE_CONFIG: CONFIG,
    FAULTFORGE_GUARD_ROOT: OWN.dir,
    FAULTFORGE_PRIVATE_DIR: join(ELSEWHERE, "no-private"),
  };
  delete env.FAULTFORGE_FACTORY_RUN;
  const decision = decide(JSON.stringify({ tool_name: tool, cwd, tool_input: input }), env);
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}
const bash = (command: string, cwd = OWN.dir) => ask("Bash", { command }, cwd);
const own = (...parts: string[]) => join(OWN.dir, ...parts);

afterEach(() => rmSync(UNLOCK, { force: true }));

describe("the guard's own files can't be changed in its checkout (re-grade 6)", () => {
  it.each([
    ["Write", { file_path: own(".claude", "hooks", "git-guard.ts"), content: "process.exit(0)" }],
    ["Write", { file_path: own(".claude", "hooks", "new-hook.ts"), content: "export {};" }],
    ["Edit", { file_path: own(".claude", "settings.json"), old_string: "{}", new_string: '{"hooks":{}}' }],
    ["Edit", { file_path: own("packages", "harness", "src", "neutral.ts"), old_string: "x", new_string: "y" }],
    ["Write", { file_path: own(".claude", "settings.local.json"), content: '{"disableAllHooks":true}' }],
  ])("refuses %s of a guard file (H12)", (tool, input) => {
    expect(ask(tool, input, OWN.dir)).toMatch(/guard's own files/);
  });

  it.each([
    "rm .claude/hooks/git-guard.ts",
    "rm -rf .claude",
    "rm -r .claude/h*",
    "Remove-Item .claude\\hooks\\git-guard.ts",
    "echo 'process.exit(0)' > .claude/hooks/git-guard.ts",
    "printf x >> packages/harness/src/neutral.ts",
    "cat /dev/null | tee .claude/settings.json",
    "sed -i 's/a/b/' packages/harness/src/neutral.ts",
    "mv .claude/hooks/git-guard.ts /tmp/x",
    "cp /dev/null .claude/hooks/git-guard.ts",
    "cp -r ../other/.claude .",
    "cd .claude/hooks && rm git-guard.ts",
    "truncate -s 0 .claude/hooks/{git-guard,guard-target}.ts",
    "git checkout HEAD~3 -- .claude/hooks",
    "git restore --source=HEAD~1 packages/harness/src/neutral.ts",
    `node -e "require('fs').writeFileSync('.claude/hooks/git-guard.ts', '')"`,
    "F=.claude/hooks/git-guard.ts; rm $F",
  ])("refuses a shell command that changes them (H14): %s", (command) => {
    expect(bash(command)).toMatch(/guard's own files/);
  });

  it("refuses them from another folder, by a path that leads there (H18)", () => {
    const path = own(".claude", "hooks", "git-guard.ts").replace(/\\/g, "/");
    expect(bash(`cp /dev/null ${path}`, ELSEWHERE)).toMatch(/guard's own files/);
    expect(bash(`rm ${path}`, ELSEWHERE)).toMatch(/guard's own files/);
  });

  it("still reads them, and still runs everything else there", () => {
    for (const command of [
      "cat .claude/hooks/git-guard.ts",
      "ls .claude/hooks",
      "grep -n x packages/harness/src/neutral.ts",
      "cp .claude/hooks/git-guard.ts /tmp/copy.ts",
      "git status",
      "git checkout main",
      "git pull",
      "npm run check",
      "rm -rf node_modules/.cache",
      "echo done > notes.txt",
    ]) {
      expect(bash(command), command).toBeUndefined();
    }
    expect(ask("Write", { file_path: own("docs", "x.md"), content: "notes" }, OWN.dir)).toBeUndefined();
  });

  it("leaves a worktree's guard files free, where a normal PR changes them", () => {
    const file = join(WORKTREE.dir, ".claude", "hooks", "git-guard.ts");
    expect(ask("Write", { file_path: file, content: "export {};" }, WORKTREE.dir)).toBeUndefined();
    expect(bash("rm .claude/hooks/git-guard.ts", WORKTREE.dir)).toBeUndefined();
  });

  it("lets them change once the owner has made the unlock file by hand", () => {
    writeFileSync(UNLOCK, "");
    expect(ask("Write", { file_path: own(".claude", "hooks", "git-guard.ts"), content: "x" }, OWN.dir)).toBeUndefined();
    expect(bash("rm .claude/hooks/git-guard.ts")).toBeUndefined();
  });

  it.each([
    `touch .git/${UNLOCK_FILE}`,
    "touch .git/faultforge-guard-{un,}lock",
    `git bundle create .git/${UNLOCK_FILE} HEAD`,
    "git bundle create .git/faultforge-guard-$X HEAD",
    `rm .git/${UNLOCK_FILE}`,
  ])("refuses a command that names or builds the unlock file: %s", (command) => {
    // A program other than git is refused in a git folder already; git itself by the unlock rule.
    expect(bash(command)).toMatch(/unlock file|in a \.git folder/);
  });

  it("refuses a Write of the unlock file", () => {
    expect(ask("Write", { file_path: UNLOCK, content: "" }, OWN.dir)).toBeDefined();
    expect(ask("Write", { file_path: join(ELSEWHERE, UNLOCK_FILE), content: "" }, OWN.dir)).toMatch(/unlock file/);
  });

  it("knows a guard file, a folder holding one, and anything else", () => {
    expect(relation(own(".claude", "hooks", "x.ts"), OWN.dir)).toBe("own");
    expect(relation(own(".claude"), OWN.dir)).toBe("holds");
    expect(relation(OWN.dir, OWN.dir)).toBe("holds");
    expect(relation(own("docs", "x.md"), OWN.dir)).toBeUndefined();
    expect(relation(join(WORKTREE.dir, ".claude", "hooks", "x.ts"), OWN.dir)).toBeUndefined();
  });
});
