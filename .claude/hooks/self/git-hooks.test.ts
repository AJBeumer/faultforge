/**
 * The git-level guard can't be switched off (N-B, self/git-hooks.ts): in a reviewed checkout, the lab or the
 * private checkout, no command and no file tool changes the guard's git settings or a `.git` folder's hooks and
 * config, however the path is spelled. Reading them stays allowed. Repos are made up under the temp folder.
 */
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askGuard, guardConfig, labWithPrivate, REPOS, scratchFolder, tempRepo } from "../fixtures.ts";

const TARGET_REPO = tempRepo(true);
const CONFIG = guardConfig(TARGET_REPO.dir);
/** The lab checkout, with the private checkout inside it as `private/`, as the owner keeps them. */
const { lab: LAB, privateDir: PRIVATE } = labWithPrivate();
const ELSEWHERE = scratchFolder("guard-elsewhere6-");

const ask = (tool: string, input: object, cwd: string) =>
  askGuard(tool, input, cwd, { config: CONFIG, privateDir: PRIVATE, outsideRun: true });
const bash = (command: string, cwd = ELSEWHERE) => ask("Bash", { command }, cwd);

describe("the git-level guard can't be switched off", () => {
  const places = [
    ["a reviewed checkout", TARGET_REPO.dir],
    ["the lab", LAB.dir],
    ["the private checkout", PRIVATE],
  ];
  it.each(
    places.flatMap(([where, dir]) =>
      [
        "git config review-guard.script /dev/null",
        "git config --unset review-guard.script",
        "git config --unset-all review-guard.script",
        "git config --remove-section review-guard",
        "git config --file .git/config review-guard.script x",
        "git -c review-guard.script=/dev/null commit -m tidy",
        "git config core.hooksPath /tmp",
        "git -c core.hooksPath=/tmp commit -m tidy",
        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp git commit -m tidy",
        `git config --global url.https://github.com/${REPOS.lab}.git.insteadOf https://github.com/${REPOS.private}.git`,
        "rm .git/hooks/pre-push",
        "echo 'exit 0' > .git/hooks/pre-commit",
        "cp /dev/null .git/hooks/pre-push",
        "cd .git && rm hooks/pre-push",
        'rm "$(git rev-parse --git-path hooks)/pre-push"',
      ].map((command) => [where, command, dir]),
    ),
  )("refuses it in %s: %s", (_where, command, dir) => {
    expect(bash(command as string, dir as string)).toMatch(/git-level guard/);
  });

  it("refuses it in PowerShell", () => {
    expect(ask("PowerShell", { command: "Remove-Item .git\\hooks\\pre-push" }, TARGET_REPO.dir)).toMatch(
      /git-level guard/,
    );
  });

  it("refuses the file tools in a .git folder", () => {
    for (const dir of [TARGET_REPO.dir, LAB.dir, PRIVATE]) {
      const hook = join(dir, ".git", "hooks", "pre-push");
      expect(ask("Write", { file_path: hook, content: "#!/bin/sh\nexit 0\n" }, dir)).toMatch(/\.git folder/);
      const config = join(dir, ".git", "config");
      expect(ask("Edit", { file_path: config, old_string: "a", new_string: "b" }, dir)).toMatch(/\.git folder/);
    }
  });

  it("still lets the settings and hooks be read, and the words be written in a message", () => {
    expect(bash("git config --get review-guard.script", TARGET_REPO.dir)).toBeUndefined();
    expect(bash("cat .git/hooks/pre-push", TARGET_REPO.dir)).toBeUndefined();
    expect(bash("ls .git/hooks", LAB.dir)).toBeUndefined();
    expect(bash("grep -rn review-guard .claude", LAB.dir)).toBeUndefined();
    expect(bash('git commit -m "Refuse core.hooksPath and review-guard changes"', LAB.dir)).toBeUndefined();
    expect(ask("Write", { file_path: join(LAB.dir, ".gitignore"), content: "x\n" }, LAB.dir)).toBeUndefined();
    expect(ask("Write", { file_path: join(LAB.dir, ".github", "x.yml"), content: "x\n" }, LAB.dir)).toBeUndefined();
  });

  it("still lets the newer read form of git config through", () => {
    expect(bash("git config get core.hooksPath", LAB.dir)).toBeUndefined();
    expect(bash("git config list", LAB.dir)).toBeUndefined();
  });
});

describe("a .git folder's files are found however a command spells their path", () => {
  it.each([
    "find .git -name pre-push -delete",
    "rm .git/h*/pre-push",
    "mv .git/[h]ooks x",
    "cd .git;rm hooks/pre-push",
    "rm .g*/hooks/pre-push",
    "rm -f .gi?/config",
    "echo $(git config --unset review-guard.script)",
    "cat `git config --unset review-guard.script`",
    "git config core.hooksPath get",
    "git config core.hooksPath list",
  ])("refuses %s", (command) => {
    expect(bash(command, TARGET_REPO.dir)).toMatch(/git-level guard/);
  });

  it("refuses a change through a link that leads into a .git folder", () => {
    const repo = tempRepo();
    try {
      symlinkSync(join(repo.dir, ".git", "config"), join(repo.dir, "settings"));
    } catch {
      return; // this machine can't make links
    }
    expect(ask("Write", { file_path: join(repo.dir, "settings"), content: "x" }, repo.dir)).toMatch(/\.git folder/);
    expect(bash("echo x > settings", repo.dir)).toMatch(/git-level guard/);
  });

  it("lets a wildcard that can't match a dot folder through", () => {
    expect(bash("rm -rf dist/*", LAB.dir)).toBeUndefined();
    expect(bash("rm -f *.log", LAB.dir)).toBeUndefined();
    expect(bash("rm {.git,x}/hooks/pre-push", LAB.dir)).toMatch(/git-level guard/);
  });

  it("reads a PowerShell wildcard that can match a dot folder", () => {
    const command = "Remove-Item -Recurse -Force -Path '[.]git/hooks/pre-push'";
    expect(ask("PowerShell", { command }, LAB.dir)).toMatch(/git-level guard/);
  });

  it.each([".g''*/hooks/*", '.g""i?/hooks/pre-push', ".'g'*/config"])("refuses rm -rf %s", (path) => {
    expect(bash(`rm -rf ${path}`, LAB.dir)).toMatch(/git-level guard/);
  });
});
