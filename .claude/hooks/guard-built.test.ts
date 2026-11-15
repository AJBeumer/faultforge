/**
 * The guard against text built from a file or a program, GraphQL mutations and other writes, look-alike
 * characters, and commands that switch off git's own guard (#242).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { growth, guardConfig, LINEAR_BOUND, tempRepo } from "./fixtures.ts";
import { decide } from "./guard-target.ts";

const LAB = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";
const CONFIG = guardConfig(tempRepo(true).dir);
const NO_PRIVATE = join(tmpdir(), "guard-built-no-private-folder");

function verdict(tool: string, command: string, cwd = LAB): string | undefined {
  const payload = JSON.stringify({ tool_name: tool, cwd, tool_input: { command } });
  const decision = decide(payload, { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: NO_PRIVATE });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}
const bash = (command: string, cwd?: string) => verdict("Bash", command, cwd);

/** A file holding `text`, by a path with forward slashes that every shell reads the same way. */
function file(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "guard-built-")), "notes.txt");
  writeFileSync(path, text);
  return path.replace(/\\/g, "/");
}

const R = "-R AJBeumer/faultforge-target";

describe("text built from a file is read and checked (#242)", () => {
  it("reads a substituted file in a lab post for a link to the target", () => {
    const link = file("see https://github.com/AJBeumer/faultforge-target/issues/3\n");
    expect(bash(`gh issue create --title x --body "$(cat ${link})"`)).toMatch(/link to the target/);
  });
});

describe("git's own guard can't be switched off in a reviewed checkout (#242)", () => {
  it.each([
    'git commit --no-verify -m "Tidy"',
    'git commit -nm "Tidy"',
    'git commit -n -m "Tidy"',
    "git push --no-verify origin tidy",
    "git -c core.hooksPath=/dev/null push origin tidy",
    "git config core.hooksPath .nothing",
    'git "--no-verify" commit -m Tidy',
    'git commit "-n" -m Tidy',
    "git commit --no-veri -m Tidy",
    "git push --no-verif origin tidy",
    'git -c "$KEY=/dev/null" push origin tidy',
  ])("denies %s", (command) => {
    expect(bash(command, TARGET)).toMatch(/guard hooks must run|git-level guard|go only through the door/);
  });

  it("allows -n inside a message, and --no-verify outside a reviewed checkout", () => {
    expect(bash('git commit -m "Handle the -n option"', TARGET)).toBeUndefined();
    expect(bash('git commit --no-verify -m "Tidy"', LAB)).toBeUndefined();
  });
});

describe("holes found in the second review of PR 266", () => {
  it("reads a file behind a nested substitution in a lab post", () => {
    const link = file("see https://github.com/AJBeumer/faultforge-target/issues/3\n");
    expect(bash(`gh issue create --title x --body "$(echo $(cat ${link}))"`)).toMatch(/link to the target/);
  });

  it("refuses a post chained after a step that could rewrite the file it reads", () => {
    const notes = file("Small cleanup.\n");
    expect(bash(`node gen.js > ${notes}; gh pr comment 1 ${R} --body "$(cat ${notes})"`)).toMatch(
      /must run on its own|runs a script/,
    );
  });

  it("decides a long run of git options that never reaches -C in time linear in their number", () => {
    // 50 options, then 400 (re-grade 7: no wall-clock limit, which a busy machine failed at random).
    expect(growth((k) => bash(`git ${"--a ".repeat(50 * k)}log`))).toBeLessThan(LINEAR_BOUND);
  });
});

describe("holes found in the third review of PR 266", () => {
  it.each([
    "GIT_CONFIG_GLOBAL=/tmp/g git commit -m Tidy",
    "GIT_CONFIG_SYSTEM=/tmp/g git push origin tidy",
    "HOME=/tmp git commit -m Tidy",
    "XDG_CONFIG_HOME=/tmp git push origin tidy",
  ])("refuses %s in a reviewed checkout", (command) => {
    expect(bash(command, TARGET)).toMatch(/guard hooks must run|git-level guard|go only through the door/);
  });
});
