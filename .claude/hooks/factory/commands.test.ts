/**
 * Commands a factory run may not run (factory/commands.ts): reading stored git credentials, or another process's
 * environment through `ps`, however the command is reached. The run folder is made up under the temp folder.
 */
import { describe, expect, it } from "vitest";
import { policyRun } from "../fixtures.ts";

const { policy } = policyRun("policy-run7-", true);

describe("a run can't read stored credentials", () => {
  it.each([
    "printf 'host=github.com\\nprotocol=https\\n' | git credential fill",
    "git credential fill < req.txt",
    "git -c credential.helper= credential fill",
    "git -C repo credential approve",
    "git credential-store get",
    "git credential-manager get",
    "git-credential-manager get",
    "/usr/lib/git-core/git-credential-store get",
    "gh auth git-credential get",
  ])("refuses %s", (command) => {
    expect(policy("Bash", { command })).toMatch(/stored credentials/);
  });

  it("lets a commit message that says credential through", () => {
    expect(policy("Bash", { command: "git commit -F msg.txt" })).toBeUndefined();
    expect(policy("Bash", { command: 'git log --grep "credential fill"' })).toBeUndefined();
  });
});

describe("a run can't read another process's environment through ps", () => {
  it.each([
    "ps e",
    "ps eww",
    "ps eww -o command",
    "ps auxe",
    "ps axeww",
    "ps e -o pid,command",
    "ps -o pid -e e",
    "sudo ps e",
    "/bin/ps e",
    // Behind a value, an assignment or a shell.
    "ps -p 1 e",
    "ps -o pid,args e",
    "A=1 ps e",
    'sh -c "ps e"',
    "timeout 5 ps e",
    // From inline code.
    "node -e \"require('child_process').execFileSync('ps',['e'])\"",
    "python3 -c \"import subprocess; subprocess.run(['ps', 'eww'])\"",
    // An option before the e, from inline code.
    "node -e \"require('child_process').execFileSync('ps',['-p','1','e'])\"",
  ])("refuses %s", (command) => {
    expect(policy("Bash", { command })).toMatch(/environment \(ps e, ps eww\)/);
  });

  it.each([
    "ps aux",
    "ps -ef",
    "ps -o pid,user",
    "ps -o user -p 1",
    "ps -e | grep node",
    // A format list after a combined option.
    "ps -eo pid,user",
    "ps -axo pid,etime,args",
    "ps -eo pid,ppid,cmd,%mem --sort=-%mem",
  ])("lets %s through", (command) => {
    expect(policy("Bash", { command })).toBeUndefined();
  });
});
