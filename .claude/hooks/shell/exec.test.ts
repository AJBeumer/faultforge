/**
 * Code no hook can read before it runs: built text run as a shell, inline
 * interpreter code that reaches the network, and a private template id in other spellings. Each case is a
 * payload both hooks get, judged by their decisions. The private id is made up.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide as policyDecide } from "../factory-policy.ts";
import { askGuard, guardConfig, privateStore, tempRepo } from "../fixtures.ts";
import { decide as guardDecide } from "../guard-target.ts";
import { BUILT_CODE_REASON, builtCodeProblem, INLINE_NETWORK_REASON, inlineNetworkProblem } from "./exec.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const hex = (text: string) => [...Buffer.from(text)].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
const reversed = (text: string) => [...text].reverse().join("");

/** A checkout named like the target, with an origin, so the guard counts commands in it as in the target. */
const TARGET = (() => {
  const repo = tempRepo(true);
  const dir = join(mkdtempSync(join(tmpdir(), "shell-exec-")), ["faultforge", "target"].join("-"));
  mkdirSync(dir);
  repo.git("worktree", "add", "-q", dir, "-b", "work");
  return dir;
})();
const CONFIG = guardConfig(TARGET);
const LAB = mkdtempSync(join(tmpdir(), "shell-exec-lab-"));
const PRIVATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "shell-exec-private-"));
  mkdirSync(join(dir, "templates", "x-secret-v1"), { recursive: true });
  return dir;
})();

function guard(command: string, cwd = TARGET, tool = "Bash"): string | undefined {
  const payload = JSON.stringify({ tool_name: tool, cwd, tool_input: { command } });
  const decision = guardDecide(payload, { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: PRIVATE });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

const RUN_ENV = { FAULTFORGE_FACTORY_RUN: "1", FAULTFORGE_RUN_ROOT: LAB, FAULTFORGE_TICKET_NUMBER: "7" };
function policy(command: string, tool = "Bash"): string | undefined {
  const payload = JSON.stringify({ tool_name: tool, cwd: LAB, tool_input: { command } });
  const decision = policyDecide(payload, { ...process.env, ...RUN_ENV });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

// Decodes to a comment on a target PR with a giveaway word.
const COMMENT = "gh pr comment 3 -b sabotage";

describe("decoded or built text run as a shell is refused by both hooks", () => {
  const cases: [string, string][] = [
    ["base64 piped into bash", `echo ${b64(COMMENT)} | base64 -d | bash`],
    ["base64 piped into sh", `echo ${b64(COMMENT)} | base64 --decode | sh`],
    ["bash -c with a decoded substitution", `bash -c "$(echo ${b64(COMMENT)} | base64 -d)"`],
    ["sh -c with a decoded substitution", `sh -c "$(echo ${b64(COMMENT)} | base64 -d)"`],
    ["bash -lc with backticks", `bash -lc "\`echo ${b64(COMMENT)} | base64 -d\`"`],
    ["eval of a decoded substitution", `eval "$(echo ${b64(COMMENT)} | base64 -d)"`],
    ["source of a process substitution", `source <(echo ${b64(COMMENT)} | base64 -d)`],
    ["dot of a process substitution", `. <(echo ${b64(COMMENT)} | base64 -d)`],
    ["bash of a process substitution", `bash <(echo ${b64(COMMENT)} | base64 -d)`],
    ["a substitution run as the command", `$(echo ${b64(COMMENT)} | base64 -d)`],
    ["xxd -r", `$(echo ${Buffer.from(COMMENT).toString("hex")} | xxd -r -p)`],
    ["rev", `echo '${reversed(COMMENT)}' | rev | bash`],
    ["openssl enc -d", `bash -c "$(echo ${b64(COMMENT)} | openssl enc -d -base64)"`],
    ["printf hex escapes", `printf '${hex(COMMENT)}' | sh`],
    ["printf hex in a substitution", `sh -c "$(printf '${hex(COMMENT)}')"`],
    ["a variable as the code", `C=$(echo ${b64(COMMENT)} | base64 -d); bash -c "$C"`],
    ["a variable as the command", `C=$(echo ${b64(COMMENT)} | base64 -d); $C`],
    ["eval of a variable", `C=$(echo ${b64(COMMENT)} | base64 -d); eval $C`],
    ["a here-string of a substitution", `bash <<< "$(echo ${b64(COMMENT)} | base64 -d)"`],
    ["an expanding heredoc", `bash <<EOF\n$(echo ${b64(COMMENT)} | base64 -d)\nEOF`],
    ["xargs into sh -c", `echo ${b64(COMMENT)} | base64 -d | xargs -I{} sh -c {}`],
    ["a quoted shell name", `echo ${b64(COMMENT)} | base64 -d | b''ash`],
    ["an escaped shell name", `echo ${b64(COMMENT)} | base64 -d | \\bash`],
    ["an ANSI-C shell name", `$'\\x62ash' -c "$(echo ${b64(COMMENT)} | base64 -d)"`],
    ["a shell inside a posted substitution", `gh pr create -t x -b "$(echo ${b64("ls")} | base64 -d | sh)"`],
    ["a shell's literal code that pipes into a shell", `bash -c 'echo ${b64(COMMENT)} | base64 -d | sh'`],
    ["cmd /c of a variable", `cmd /c "%C%"`],
  ];

  it.each(cases)("the guard refuses %s, in the target and anywhere else", (_name, command) => {
    expect(guard(command)).toBe(BUILT_CODE_REASON);
    expect(guard(command, LAB)).toBe(BUILT_CODE_REASON);
  });

  it.each(cases)("the factory policy refuses %s", (_name, command) => {
    expect(policy(command)).toContain(BUILT_CODE_REASON.replace(/\.$/, ""));
  });

  it.each([
    ["Invoke-Expression", "Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('Z2g=')))"],
    ["iex in a pipe", "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('Z2g=')) | iex"],
    ["the call operator on a variable", "$c = 'gh'; & $c pr comment 3"],
    ["a script block built from text", "& ([scriptblock]::Create($t))"],
    ["an encoded command", "pwsh -EncodedCommand Z2g="],
  ])("both hooks refuse PowerShell's %s", (_name, command) => {
    expect(guard(command, LAB, "PowerShell")).toBe(BUILT_CODE_REASON);
    expect(policy(command, "PowerShell")).toContain(BUILT_CODE_REASON.replace(/\.$/, ""));
  });

  it.each([
    "bash -c 'npm test'",
    "sh -c 'npm run check'",
    "echo 'npm test' | sh",
    "bash scripts/setup.sh",
    "bash <<'EOF'\necho $HOME\nEOF",
    'git commit -F msg.txt && echo "$(git rev-parse HEAD)"',
    'cd "$(git rev-parse --show-toplevel)" && npm test',
    "eval 'echo hi'",
    "source ./env.sh",
    "echo $HOME | tr a-z A-Z",
  ])("allows a literal the hooks can read: %s", (command) => {
    expect(builtCodeProblem(command)).toBeUndefined();
  });

  it("allows PowerShell's own variables and subexpressions, which run no text as code", () => {
    expect(builtCodeProblem("$env:X = 'y'; Write-Output $(Get-Date)", false)).toBeUndefined();
  });
});

describe("inline interpreter code that makes a network call is refused by the guard, not only the policy", () => {
  const T = ["AJBeumer", "faultforge-target"].join("/");
  it.each([
    ["node fetch", `node -e "fetch('https://api.github.com/repos/${T}/issues/3/comments',{method:'POST',body:'{}'})"`],
    [
      "node fetch to a built repo",
      `node -e "fetch('https://api.github.com/repos/AJBeumer/'+'faultforge-'+'target/issues')"`,
    ],
    ["node https", `node -e "require('https').request({host:'api.github.com'}).end()"`],
    ["python urllib", `python -c "import urllib.request as u;u.urlopen('https://api.github.com/x')"`],
    ["python requests", `python3 -c "import requests; requests.post('https://api.github.com/x')"`],
    ["python socket", `python -c "import socket; socket.create_connection(('api.github.com', 443))"`],
    ["perl LWP", `perl -MLWP::UserAgent -e "LWP::UserAgent->new->get('https://api.github.com')"`],
    ["perl HTTP::Tiny", `perl -e "use HTTP::Tiny; HTTP::Tiny->new->post('https://api.github.com/x')"`],
    ["ruby net/http", `ruby -rnet/http -e "Net::HTTP.post(URI('https://api.github.com/x'), '{}')"`],
    [
      "python fed a heredoc",
      "python3 - <<'EOF'\nimport urllib.request\nurllib.request.urlopen('https://api.github.com')\nEOF",
    ],
    ["node fed by a pipe", `echo "fetch('https://api.github.com')" | node`],
    ["npx tsx -e", `npx tsx -e "fetch('https://api.github.com')"`],
  ])("refuses %s", (_name, command) => {
    expect(inlineNetworkProblem(command)).toBe(INLINE_NETWORK_REASON);
    expect(guard(command, LAB)).toBe(INLINE_NETWORK_REASON);
  });

  it("allows a call to the app on localhost, and code that makes no call", () => {
    expect(
      guard(`node -e "fetch('http://localhost:3000/health').then(r => console.log(r.status))"`, LAB),
    ).toBeUndefined();
    expect(guard(`python -c "print(1 + 1)"`, LAB)).toBeUndefined();
    expect(guard("node scripts/build.mjs", LAB)).toBeUndefined();
  });
});

describe("a private template id under other spellings, and inside inline code", () => {
  it.each([
    ["doubled separators", 'gh pr create -t x -b "about x--secret--v1"'],
    ["mixed separators", 'gh pr create -t x -b "about x_secret.v1"'],
    ["spaces", 'gh pr create -t x -b "about x  secret  v1"'],
    ["spaced dashes", 'gh pr create -t x -b "about x - secret - v1"'],
    ["slashes", 'gh pr create -t x -b "about x/secret/v1"'],
    ["inside node -e", `node -e "console.log('x-secret-v1')"`],
    ["split inside node -e", `node -e "console.log('x-sec'+'ret-v1')"`],
  ])("refuses %s, without repeating the id", (_name, command) => {
    const reason = guard(command, LAB);
    expect(reason).toMatch(/names? a bug template that is still private/);
    expect(reason).not.toMatch(/secret/i);
  });

  it("still allows text that only shares a part of the id", () => {
    expect(guard('gh pr create -t x -b "a secret v1 note"', LAB)).toBeUndefined();
    expect(guard('gh pr create -t x -b "box-secret-v1"', LAB)).toBeUndefined();
  });
});

describe("code an interpreter runs as a subprocess is built code", () => {
  const config = guardConfig(tempRepo(true).dir);
  const privateDir = privateStore("guard~private-");
  const inTarget = (command: string) =>
    askGuard("Bash", { command }, "D:\\Projects\\faultforge-target", { config, privateDir });

  it.each([
    ["perl system", `perl -e 'system("git","push","--force")'`],
    ["perl backticks", "perl -e 'print `git push -f`'"],
    ["perl exec", `perl -e 'exec "git push -f"'`],
    ["python subprocess", `python -c "import subprocess;subprocess.run(['g'+'it','pu'+'sh','--for'+'ce'])"`],
    ["python os.system", `python3 -c "import os;os.system('git push -f')"`],
    ["python decode then exec", `python3 -c "import base64,os;os.system(base64.b64decode('Z2l0IHB1c2ggLWY='))"`],
    ["python exec of decoded code", `python -c "import base64;exec(base64.b64decode('cHJpbnQoMSk='))"`],
    ["python os.popen", `python -c "import os;os.popen('git push -f')"`],
    ["node child_process", `node -e "require('child_process').execSync('git push --force')"`],
    ["node child_process import", `node -e "import('node:child_process').then(c=>c.spawnSync('git',['push']))"`],
    ["node eval of decoded code", `node -e "eval(atob('Y29uc29sZS5sb2coMSk='))"`],
    ["ruby system", `ruby -e 'system("git push -f")'`],
    ["php shell_exec", `php -r 'shell_exec("git push -f");'`],
    ["a heredoc to python", "python3 <<'EOF'\nimport subprocess\nsubprocess.run(['git','push'])\nEOF"],
  ])("refuses %s", (_name, command) => {
    expect(builtCodeProblem(command)).toBeDefined();
    expect(inTarget(command)).toBeDefined();
  });

  it("allows inline code that runs nothing", () => {
    expect(builtCodeProblem(`node -e "console.log(require('fs').readdirSync('.'))"`)).toBeUndefined();
    expect(builtCodeProblem(`python -c "import json;print(json.dumps({'a':1}))"`)).toBeUndefined();
    expect(builtCodeProblem(`perl -ne 'print if /x/' file.txt`)).toBeUndefined();
    expect(builtCodeProblem("node scripts/build.js")).toBeUndefined();
  });
});
