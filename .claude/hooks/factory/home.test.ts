/**
 * A factory run never reads the owner's secrets in the home folder (factory/home.ts): not by a read tool, a
 * search that walks it, or a shell command that names it, however the home folder is spelled. The run's own files
 * and the temp folder stay readable. The run folder is made up under the temp folder.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { policyRun } from "../fixtures.ts";
import { homeSecretCommand, homeSecretPath } from "./home.ts";

const { RUN, ENV, policy } = policyRun("policy-run6-");

describe("a run never reads the owner's secrets in the home folder", () => {
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

describe("a bare cd names the home folder too", () => {
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
