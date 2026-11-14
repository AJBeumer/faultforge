import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandViolations, decide, editViolation } from "./factory-policy.ts";
import { scriptsRun } from "./factory-policy-paths.ts";
import { codeAsWords, decodeAnsiC, spokenWords } from "./shell-decode.ts";

/**
 * The re-grade after round 4 found these still allowed inside an unattended run (#284). Each is a payload the
 * hook gets, judged by its decision.
 */
const RUN = resolve("/runs/20261114-0000-target-5");
const runEnv = (extra: Record<string, string> = {}) => ({
  FAULTFORGE_FACTORY_RUN: "r",
  FAULTFORGE_RUN_ROOT: RUN,
  FAULTFORGE_TICKET_NUMBER: "5",
  ...extra,
});
const ask = (tool: string, input: Record<string, unknown>, cwd = RUN, env = runEnv()) =>
  decide(JSON.stringify({ tool_name: tool, tool_input: input, cwd }), env);
const bash = (command: string, cwd = RUN, env = runEnv()) => ask("Bash", { command }, cwd, env);

describe("shell-decode: the words a command runs", () => {
  it("decodes ANSI-C strings as bash does", () => {
    expect(decodeAnsiC(String.raw`echo $'pla\x6eted' $'\160' $'a\'b' $'A'`)).toBe(
      String.raw`echo 'planted' 'p' 'a'\''b' 'A'`,
    );
    expect(decodeAnsiC("echo 'plain'")).toBe("echo 'plain'");
  });

  it("joins words split by empty quotes, escapes and an empty variable", () => {
    expect(spokenWords(`g''h p""r mer\\ge 1`)).toBe("gh pr merge 1");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a JS template
    expect(spokenWords("\\gh g${x}h")).toBe("gh gh");
    expect(codeAsWords(`execFileSync('g'+'h',['pr','merge'])`)).toBe("execFileSync gh pr merge ");
  });
});

describe("factory policy: normalised spellings of a command (#284)", () => {
  it.each([
    "g''h pr merge 1",
    "gh p''r merge 1",
    "gh pr mer''ge 1",
    "\\gh pr merge 1",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a JS template
    "g${x}h pr merge 1",
    "$'\\x67h' pr merge 1",
    `node -e "require('child_process').execFileSync('g'+'h',['pr','comment','3','-b','x'])"`,
    "gh alias set c 'pr merge'",
    "git config alias.p 'push --force'",
    "git push -fu origin feature",
    "git push -uf origin feature",
  ])("denies %s", (command) => {
    expect(bash(command).kind).toBe("deny");
  });

  it("still allows the run's ordinary commands", () => {
    for (const command of [
      "npm run check",
      "gh pr create --title 'Filter bookings' --body-file pr.md",
      "git push -u origin status-filter",
      "npm run review:wait -- target 12 --commit $(git rev-parse HEAD)",
    ])
      expect(commandViolations(command)).toEqual([]);
  });
});

describe("factory policy: the environment through any interpreter (#284)", () => {
  it.each([
    `node -e "console.log(process['en'+'v'])"`,
    `node -e "const e=globalThis.process; console.log(JSON.stringify(e[String.fromCharCode(101,110,118)]))"`,
    `node -e "console.log(Reflect.get(globalThis, 'pro'+'cess'))"`,
    `node -e "console.log(globalThis['pro'+'cess'])"`,
    `python3 -c "import os; print(getattr(os,'envi'+'ron'))"`,
    `python3 -c "import os; print(os.environ)"`,
    `perl -e 'print %ENV'`,
    `perl -e 'print $ENV{GH_TO}'`,
    `ruby -e 'p ENV.to_h'`,
    "env",
    "printenv",
    "set",
    "export -p",
    "declare -x",
    "declare -p",
    "typeset -x",
    "compgen -e",
    "bash -c 'e''nv'",
    "cat /proc/self/environ",
    "cat /proc/$PPID/environ",
  ])("denies %s", (command) => {
    expect(bash(command).kind).toBe("deny");
  });

  it("denies a network module whose name is built, and ssh to anywhere", () => {
    expect(bash(`node -e "require('ht'+'tps').get('https://example.com')"`).kind).toBe("deny");
    expect(bash("ssh example.com").kind).toBe("deny");
  });

  it("allows one variable by name, and NODE_ENV", () => {
    expect(commandViolations('node -e "console.log(process.env.FAULTFORGE_TICKET_FILE)"')).toEqual([]);
    expect(commandViolations("NODE_ENV=test npm run check")).toEqual([]);
  });

  it("doesn't take a file name or a read-only git command for an env read or a write (Qodo on PR 288)", () => {
    expect(commandViolations("node scripts/process-data.mjs")).toEqual([]);
    expect(commandViolations(`node -e "console.log(globalThis.process)"`)).not.toEqual([]);
    expect(bash("git diff $(git merge-base origin/main HEAD) --stat").kind).toBe("allow");
  });

  it.skipIf(process.platform === "win32")("denies a search from a folder that holds /proc", () => {
    expect(ask("Grep", { pattern: "GH_TOKEN", path: "/" }).kind).toBe("deny");
  });
});

describe("factory policy: the read tools (#284)", () => {
  it.each(["/proc/self/environ", "/proc/1234/environ", "/proc/self/mem"])("denies reading %s", (path) => {
    expect(ask("Read", { file_path: path }).kind).toBe("deny");
    expect(ask("Grep", { pattern: "TOKEN", path }).kind).toBe("deny");
    expect(ask("Glob", { pattern: `${path}*` }).kind).toBe("deny");
  });

  it("denies the private checkout and private files by name in a target ticket's run, not in a lab ticket's", () => {
    const priv = resolve("/owner/FaultForge/private");
    const target = runEnv({ FAULTFORGE_PRIVATE_CHECKOUTS: [priv, resolve("/runs/private-source")].join(delimiter) });
    expect(ask("Read", { file_path: join(priv, "notes.md") }, RUN, target).kind).toBe("deny");
    expect(ask("Grep", { pattern: "x", path: priv }, RUN, target).kind).toBe("deny");
    expect(ask("Glob", { pattern: "**/ground-truth.jsonl" }, RUN, target).kind).toBe("deny");
    expect(ask("Read", { file_path: join(RUN, "lab", "private", "templates", "x", "t.json") }, RUN, target).kind).toBe(
      "deny",
    );
    // The run's own saved reviews are its to read.
    const review = join(RUN, "lab", "private", "raw-artifacts", "reviews", "target-pr3", "review.json");
    expect(ask("Read", { file_path: review }, RUN, target).kind).toBe("allow");
    // A lab ticket's run works in private/ and may read it.
    expect(ask("Read", { file_path: join(priv, "notes.md") }).kind).toBe("allow");
  });

  it("denies shell commands that name the private repo in a target ticket's run", () => {
    const priv = resolve("/owner/FaultForge/private");
    const target = runEnv({ FAULTFORGE_PRIVATE_CHECKOUTS: priv });
    expect(bash("cat ../faultforge/private/ground-truth.jsonl", RUN, target).kind).toBe("deny");
    expect(bash(`ls ${priv.replace(/\\/g, "/")}/templates`, RUN, target).kind).toBe("deny");
    expect(bash("ls private/raw-artifacts/reviews", RUN, target).kind).toBe("allow");
  });

  it("denies the answer key, the audit log and the templates in a lab ticket's run too", () => {
    for (const command of ["cat private/ground-truth.jsonl", "ls private/templates", "tail private/audit-events.jsonl"])
      expect(bash(command).kind).toBe("deny");
    expect(ask("Read", { file_path: join(RUN, "FaultForge", "private", "ground-truth.jsonl") }).kind).toBe("deny");
    expect(ask("Glob", { pattern: "private/templates/**" }).kind).toBe("deny");
    // Its own evidence is its to write and read.
    expect(bash("git -C private add raw-artifacts/reviews").kind).toBe("allow");
  });

  it("denies /proc however it is spelled or linked (Qodo on PR 288)", () => {
    for (const path of ["/proc/./self/environ", "/proc//self/environ"])
      expect(ask("Read", { file_path: path }).kind).toBe("deny");
    expect(bash("ln -s /proc p").kind).toBe("deny");
  });

  it("denies a search from a folder that holds a private checkout, and a glob into one (Qodo on PR 288)", () => {
    const owner = resolve("/owner/FaultForge");
    const runs = resolve("/runs");
    const target = runEnv({ FAULTFORGE_PRIVATE_CHECKOUTS: [join(owner, "private"), runs].join(delimiter) });
    expect(ask("Grep", { pattern: "x", path: owner }, RUN, target).kind).toBe("deny");
    expect(ask("Glob", { pattern: `${join(owner, "private").replace(/\\/g, "/")}/*.md` }, RUN, target).kind).toBe(
      "deny",
    );
    // Another run's leftovers in the runs folder, but not this run's own folder inside it.
    expect(ask("Read", { file_path: join(runs, "qodo-check-x", "private", "a.md") }, RUN, target).kind).toBe("deny");
    expect(ask("Read", { file_path: join(RUN, "FaultForge", "README.md") }, RUN, target).kind).toBe("allow");
    expect(bash(`cat ${join(RUN, "ticket.md").replace(/\\/g, "/")}`, RUN, target).kind).toBe("allow");
  });

  it("denies shell paths that climb out of the run or glob into a checkout, in a target ticket's run (Qodo on PR 288)", () => {
    const owner = resolve("/owner/FaultForge");
    const target = runEnv({ FAULTFORGE_PRIVATE_CHECKOUTS: join(owner, "private") });
    const lab = join(RUN, "FaultForge");
    expect(bash("cat ../../../owner/FaultForge/private/notes.md", lab, target).kind).toBe("deny");
    expect(bash(`ls ${owner.replace(/\\/g, "/")}/priv*/`, lab, target).kind).toBe("deny");
    expect(
      bash(`cat ${join(RUN, "..", "..", "owner", "FaultForge", "private", "x").replace(/\\/g, "/")}`, lab, target).kind,
    ).toBe("deny");
    // Inside the run's own folder, `..` is fine.
    expect(bash("git -C ../faultforge-target status", lab, target).kind).toBe("allow");
  });

  it("denies the private repo by name or by numeric id through gh and git, in any run", () => {
    for (const command of [
      "gh api repos/AJBeumer/faultforge-private/contents/x",
      "gh api repositories/123456789/contents/x",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a JS template
      "gh api repositories/${id}/contents/README.md",
      "gh api repos/AJBeumer/$(printf x)/contents",
      "gh repo clone AJBeumer/faultforge-private",
      "git clone https://github.com/AJBeumer/faultforge-private x",
    ])
      expect(bash(command).kind).toBe("deny");
  });
});

describe("factory policy: the guardrails from the shell (#284)", () => {
  it.each([
    "sed -i 's/TELLTALES.filter/[].filter/' packages/harness/src/neutral.ts",
    `node -e "require('fs').writeFileSync('.claude/hooks/guard-target.ts','')"`,
    "cp x .claude/settings.json",
    "cp x .claude/settings.local.json",
    "echo '' > .claude/hooks/guard-target.ts",
    "tee packages/harness/src/neutral.ts < x",
    "mv x .claude/hooks/fail-closed.ts",
    "git checkout HEAD~1 -- .claude/hooks",
  ])("denies %s", (command) => {
    expect(bash(command).kind).toBe("deny");
  });

  it.each([
    "cd .claude; echo x > settings.json",
    "cd .claude&& echo x > hooks/guard.ts",
    `cp x "$(printf '\\056claude')/settings.json"`,
    'cp x "$DIR/settings.json"',
  ])("denies %s, a write it can't tell is clear of them (Qodo on PR 288)", (command) => {
    expect(bash(command).kind).toBe("deny");
  });

  it("denies a write from inside a .claude folder, where the Bash tool stayed after a cd (Qodo on PR 288)", () => {
    expect(bash("echo x > factory-policy.ts", join(RUN, "FaultForge", ".claude", "hooks")).kind).toBe("deny");
  });

  it("allows reading them, and the run's own commands with harmless redirects", () => {
    for (const command of [
      "cat .claude/hooks/guard-target.ts",
      "git diff -- .claude",
      "grep -n x neutral.ts",
      "npm run review:wait -- target 12 --commit $(git rev-parse HEAD) 2>&1",
      "npm run check > /dev/null 2>&1",
    ])
      expect(bash(command).kind).toBe("allow");
  });

  it("denies the Write tool on the giveaway word list", () => {
    const file = join(RUN, "FaultForge", "packages", "harness", "src", "neutral.ts");
    expect(editViolation(file, RUN)).toMatch(/neutral\.ts/);
    expect(ask("Write", { file_path: file, content: "export const telltales = () => [];" }).kind).toBe("deny");
  });
});

describe("factory policy: a script this run wrote may not run (#284)", () => {
  let repo: string;
  let env: ReturnType<typeof runEnv>;
  const gitIn = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ff-scripts-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "server.ts"), "console.log(1)\n");
    writeFileSync(join(repo, "src", "tool.ts"), "console.log(2)\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-qm", "init");
    // The run's base is the commit it started from; what the agent commits after it doesn't count.
    env = runEnv({ FAULTFORGE_RUN_ROOT: repo, FAULTFORGE_RUN_BASES: gitIn(repo, "rev-parse", "HEAD").trim() });
    writeFileSync(join(repo, "scratch.js"), "console.log(process.env)\n");
    writeFileSync(join(repo, "payload"), "#!/bin/sh\nenv\n");
    writeFileSync(join(repo, "newmod.py"), "import os\n");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "do.mjs"), "x\n");
    // Changed after the base, and committed: still not the project's own code (Qodo on PR 288).
    writeFileSync(join(repo, "src", "tool.ts"), "console.log(process.env)\n");
    writeFileSync(join(repo, "src", "added.ts"), "x\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "-qm", "agent");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it.each([
    "node scratch.js",
    "npx tsx scratch.js",
    "npx -y tsx scratch.js",
    "node scripts/do.mjs",
    "python3 scratch.js",
    "bash scratch.js",
    "node -r ./scratch.js src/server.ts",
    "node --require=./scratch.js src/server.ts",
    `node -e "require('./scratch.js')"`,
    "./scripts/do.mjs",
    "./payload",
    "cd src && node ../scratch.js",
    "node $F",
    "timeout 5 node scratch.js",
    "env A=b nohup node scratch.js",
    `bash -c "node scratch.js"`,
    "source scratch.js",
    ". ./scratch.js",
    "node < scratch.js",
    "python3 -m newmod",
    // Package runners, find, and a folder the text can't follow (Qodo on PR 288).
    "npm exec node scratch.js",
    "npm exec -- tsx scratch.js",
    "pnpm dlx tsx scratch.js",
    "yarn node scratch.js",
    "find . -name x -exec node scratch.js ;",
    "( cd src ) ; node server.ts",
    "pushd src; popd; node server.ts",
    "npx tsx src/tool.ts",
    "npx tsx src/added.ts",
  ])("denies %s", (command) => {
    expect(bash(command, repo, env).kind).toBe("deny");
  });

  it("allows a script as the run's base holds it, and commands that run no file", () => {
    for (const command of [
      "npx tsx src/server.ts",
      "node src/server.ts",
      // A flag's value is not the script (Qodo on PR 288).
      "python3 -W ignore src/server.ts",
      "node --env-file .env src/server.ts",
      "node --version",
      "npm run check",
      "npm start",
    ])
      expect(bash(command, repo, env).kind).toBe("allow");
  });

  it("doesn't take a scratch repo's own commit, or a moved ref, as the run's base (Qodo on PR 288)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ff-scratch-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main", scratch]);
      writeFileSync(join(scratch, "x.js"), "console.log(process.env)\n");
      gitIn(scratch, "add", ".");
      gitIn(scratch, "commit", "-qm", "x");
      gitIn(scratch, "update-ref", "refs/remotes/origin/main", "HEAD");
      expect(bash(`node ${join(scratch, "x.js").replace(/\\/g, "/")}`, repo, env).kind).toBe("deny");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("follows the command's own cd to find the script", () => {
    expect(scriptsRun("cd src && node server.ts", repo)).toEqual([{ file: "server.ts", dir: join(repo, "src") }]);
  });
});
