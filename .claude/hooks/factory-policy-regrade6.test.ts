/**
 * The factory policy's share of the sixth re-grade's paths (#332): a run may not switch off git's own guard hooks
 * in the lab either (`--no-verify`, `core.hooksPath`, the guard's settings, a `.git` folder's files), and may not
 * read the owner's secrets in the home folder.
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { homeSecretCommand, homeSecretPath } from "./factory/home.ts";
import { decide, editViolation, gitGuardViolation } from "./factory-policy.ts";

/** A run's own folder, under the temp folder like a real run's scratch, with the lab inside it. */
const RUN = mkdtempSync(join(tmpdir(), "policy-run6-"));
const LAB = join(RUN, "faultforge");
const ENV: NodeJS.ProcessEnv = {
  FAULTFORGE_FACTORY_RUN: "1",
  FAULTFORGE_RUN_ROOT: RUN,
  FAULTFORGE_TICKET_NUMBER: "999",
};

function policy(tool: string, input: object, cwd = LAB): string | undefined {
  const decision = decide(JSON.stringify({ tool_name: tool, cwd, tool_input: input }), ENV);
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

describe("a run can't switch off git's own guard hooks in the lab (re-grade 6)", () => {
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

describe("a run never reads the owner's secrets in the home folder (re-grade 6)", () => {
  const home = homedir();
  it.each([
    join(home, ".qodo", "qodo-key.txt"),
    join(home, ".github", "PAT_GH_X.txt"),
    join(home, ".config", "gh", "hosts.yml"),
    join(home, ".ssh", "id_ed25519"),
    join(home, ".claude", ".credentials.json"),
    join(home, "Documents", "api-token.txt"),
    join(home, "notes", "deploy-key.pem"),
    join(home, "aws-credentials"),
  ])("refuses a read of %s", (path) => {
    expect(homeSecretPath(path, ENV)).toBe(true);
    expect(policy("Read", { file_path: path })).toMatch(/home folder/);
  });

  it("refuses a search that walks the home folder or a folder above it", () => {
    expect(policy("Grep", { pattern: "x", path: home })).toMatch(/home folder/);
    expect(policy("Glob", { pattern: "**/*", path: join(home, "..") })).toMatch(/home folder/);
  });

  it("still reads the run's own files and the temp folder, whatever their names", () => {
    expect(homeSecretPath(join(RUN, "src", "token.ts"), ENV)).toBe(false);
    expect(homeSecretPath(join(tmpdir(), "key.txt"), ENV)).toBe(false);
    expect(homeSecretPath(join(home, "Documents", "notes.md"), ENV)).toBe(false);
  });

  const literal = home.replace(/\\/g, "/");
  it.each([
    "cat ~/.qodo/qodo-key.txt",
    "cat $HOME/.qodo/qodo-key.txt",
    "cat ${HOME}/.github/PAT_GH_X.txt",
    "cat ~/.github/PAT_GH_X.txt",
    "type %USERPROFILE%\\.ssh\\id_rsa",
    "Get-Content $env:USERPROFILE\\.config\\gh\\hosts.yml",
    `cat ${literal}/.qodo/qodo-key.txt`,
    "cat ~/.claude/.credentials.json",
    "ls ~",
    "cd ~ && cat .ssh/id_rsa",
    "cat ~/*",
    "cat $QODO_KEY_FILE",
  ])("refuses %s", (command) => {
    const env = { ...ENV, HOME: home, QODO_KEY_FILE: join(home, ".qodo", "qodo-key.txt") };
    expect(homeSecretCommand(command, env)).toMatch(/home folder/);
  });

  it("refuses one in a run, by the shell", () => {
    expect(policy("Bash", { command: "cat ~/.qodo/qodo-key.txt" })).toMatch(/home folder/);
  });

  it("still lets ordinary commands through", () => {
    for (const command of ["cat README.md", "git log HEAD~1", "git diff @~", "npm run check", `cat ${RUN}/key.ts`])
      expect(homeSecretCommand(command, ENV)).toBeUndefined();
  });
});

describe("a bare cd names the home folder too (Qodo on PR 333)", () => {
  it.each(["cd && cat .ssh/id_ed25519", "cd; cat .qodo/config", "cd\ncat .ssh/id_rsa", "pushd && ls"])(
    "refuses %j",
    (command) => {
      expect(homeSecretCommand(command, ENV)).toMatch(/home folder/);
    },
  );

  it("still lets a cd with a folder through", () => {
    expect(homeSecretCommand("cd src && cat index.ts", ENV)).toBeUndefined();
  });
});
