/**
 * The guard against the bypasses the audit of 14 November found (AUD-H1, AUD-M3, AUD-M4, AUD-N9): private
 * template ids in any post, a slow or broken hook, and the spellings that slipped past the text checks.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answer, run } from "./fail-closed.ts";
import { guardConfig, tempRepo } from "./fixtures.ts";
import { check } from "./git-guard.ts";
import { decide } from "./guard-target.ts";
import { MAX_COMMAND_CHARS } from "./shell-scan.ts";

const HOOKS = import.meta.dirname;
const LAB = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";
const CONFIG = guardConfig(tempRepo(true).dir);

/**
 * A private folder holding one unreleased template and one that is already in templates/seed/. Its name has a
 * `~`, as a Windows short name does (CI runs in `C:\Users\RUNNER~1`).
 */
function privateFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "guard~private-"));
  mkdirSync(join(dir, "templates", "x-secret-v1"), { recursive: true });
  mkdirSync(join(dir, "templates", "idempotency-guard-bypass-v1"), { recursive: true });
  return dir;
}
const PRIVATE = privateFolder();

/** The deny reason for one tool call, or undefined when allowed; a blocking error fails the test. */
function verdict(tool: string, input: object, cwd = LAB, extra: NodeJS.ProcessEnv = {}): string | undefined {
  const payload = JSON.stringify({ tool_name: tool, cwd, tool_input: input });
  const decision = decide(payload, {
    ...process.env,
    FAULTFORGE_CONFIG: CONFIG,
    FAULTFORGE_PRIVATE_DIR: PRIVATE,
    ...extra,
  });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}
const bash = (command: string, cwd?: string, extra?: NodeJS.ProcessEnv) => verdict("Bash", { command }, cwd, extra);

/** A temp folder named like the target's checkout, holding `body.md` with the given text. */
function targetFolder(body: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "guard~tf-")), "faultforge-target");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "body.md"), body);
  return dir;
}

describe("private template ids in posts (AUD-H1)", () => {
  it.each([
    ["a lab PR body", 'gh pr create --title "Tidy" --body "Demo with x-secret-v1"', LAB],
    ["a lab issue comment", "gh issue comment 5 --body 'see X_SECRET_V1 for details'", LAB],
    ["a lab commit message", 'git commit -m "Add a dry run for x-secret-v1"', LAB],
    ["a lab API field", "gh api repos/AJBeumer/faultforge/issues -f title='x secret v1 notes'", LAB],
    ["a target PR body", 'gh pr create --repo AJBeumer/faultforge-target --title Tidy --body "x-secret-v1"', LAB],
    ["a target commit", 'git commit -m "Tidy x-secret-v1"', TARGET],
    ["a quote-split id", 'gh pr create --title Tidy --body "x-sec""ret-v1"', LAB],
  ])("denies %s naming one, without printing the id", (_name, command, cwd) => {
    const reason = bash(command, cwd);
    expect(reason).toMatch(/still private/);
    expect(reason).not.toMatch(/secret/i);
  });

  it("denies a body file that names one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "guard-body-")), "body.md");
    writeFileSync(file, "Shows the dry run for x-secret-v1.\n");
    expect(bash(`gh pr create --title Tidy --body-file "${file}"`)).toMatch(/still private/);
    writeFileSync(file, "Shows the dry run.\n");
    expect(bash(`gh pr create --title Tidy --body-file "${file}"`)).toBeUndefined();
  });

  it("denies an MCP tool's input that names one", () => {
    expect(verdict("mcp__github__create_issue", { title: "x-secret-v1" })).toMatch(/still private/);
  });

  it("allows a released template's id, a longer word, and commits in private storage", () => {
    expect(bash('gh pr create --title Tidy --body "Publish idempotency-guard-bypass-v1"')).toBeUndefined();
    expect(bash('gh pr create --title Tidy --body "x-secret-v10 is another name"')).toBeUndefined();
    const priv = PRIVATE.replace(/\\/g, "/");
    expect(bash(`git -C "${priv}" commit -m "Add x-secret-v1"`)).toBeUndefined();
    expect(bash(`git -C "${priv}" push origin main && git -C "${priv}" commit -m "x-secret-v1"`)).toBeUndefined();
    expect(bash('git commit -m "Add x-secret-v1"', PRIVATE)).toBeUndefined();
  });

  it("doesn't let a private-storage step cover a public post in the same command", () => {
    const priv = PRIVATE.replace(/\\/g, "/");
    expect(bash(`git -C "${priv}" commit -m "x-secret-v1" && gh pr create --title "x-secret-v1" --body x`)).toMatch(
      /still private/,
    );
  });

  it("skips the check when there is no private folder", () => {
    const none = join(tmpdir(), "guard-no-private-folder-here");
    expect(
      bash('gh pr create --title Tidy --body "x-secret-v1"', LAB, { FAULTFORGE_PRIVATE_DIR: none }),
    ).toBeUndefined();
  });
});

describe("a crafted command can't outrun the hook (AUD-M4)", () => {
  const post = 'gh pr create --repo AJBeumer/faultforge-target --title Tidy --body "planted bug" ';
  it.each([
    ["heredoc openers in a comment", `${post}# ${"<<A ".repeat(450)}${"\n".repeat(4500)}`],
    ["heredoc openers in the open", `${post}${"<<A ".repeat(800)}\n${"x\n".repeat(1500)}`],
    ["unclosed quotes", `${post}${"\"'".repeat(1500)}${"\n".repeat(3000)}`],
    ["repeated git words", `${post}; ${"git ".repeat(1500)}`],
    ["repeated cd words", `${post}; ${"cd ".repeat(2000)}`],
    ["repeated flags", `${post}${"-m -t -b -F ".repeat(500)}`],
  ])("decides 6 KB of %s in under a second", (_name, command) => {
    expect(command.length).toBeGreaterThan(6000);
    const started = performance.now();
    expect(bash(command)).toBeDefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses a command longer than it reads", () => {
    expect(bash(`echo ${"x".repeat(MAX_COMMAND_CHARS)}`)).toMatch(/more than the \d+ the guard reads/);
  });
});

describe("the hook fails closed outside decide() (AUD-M4)", () => {
  const WRAPPER = join(HOOKS, "fail-closed.ts");
  const scratch = mkdtempSync(join(tmpdir(), "guard-broken-"));
  const module = (name: string, text: string) => {
    const file = join(scratch, name);
    writeFileSync(file, text);
    return file;
  };
  const viaWrapper = (hook: string, stdin = "{}", env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [WRAPPER, hook], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, FAULTFORGE_CONFIG: CONFIG, ...env },
    });

  it.each([
    ["throws on import", module("throws.mjs", 'throw new Error("boom on import");\n')],
    ["imports a module that is missing", module("missing.mjs", 'import "./not-there.mjs";\n')],
    ["has a syntax error", module("syntax.mjs", "export const = ;\n")],
    ["exits 1", module("one.mjs", "process.exit(1);\n")],
    ["prints something that isn't a decision", module("noise.mjs", 'console.log("allowed, probably");\n')],
  ])("exits 2 for a hook that %s", (_name, hook) => {
    const result = viaWrapper(hook);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/refused/);
  });

  it("exits 2 for a hook that runs past its budget", () => {
    const hang = module("hang.mjs", "setTimeout(() => {}, 60_000);\n");
    const result = run([hang], () => Buffer.from("{}"), 300);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no answer within/);
  });

  it("passes the real guard's answers on: a deny, an allow, and its own refusal", () => {
    const payload = (command: string, cwd: string) =>
      JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } });
    const denied = viaWrapper("guard-target.ts", payload('git commit -m "Fix the planted bug"', TARGET));
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const allowed = viaWrapper("guard-target.ts", payload("npm run check", LAB));
    expect([allowed.status, allowed.stdout]).toEqual([0, ""]);
    expect(viaWrapper("guard-target.ts", "not json").status).toBe(2);
    expect(viaWrapper("factory-policy.ts", "not json", { FAULTFORGE_FACTORY_RUN: "test" }).status).toBe(2);
  });
});

describe("the bypass spellings the audit found (AUD-M3)", () => {
  it.each([
    ["gh api -fbody=", 'gh api repos/AJBeumer/faultforge-target/issues/3/comments -fbody="the planted bug"'],
    [
      "gh api --method POST -ftitle=",
      'gh api --method POST repos/AJBeumer/faultforge-target/issues -ftitle="planted bug"',
    ],
    [
      "gh api on the repo itself",
      'gh api repos/AJBeumer/faultforge-target -X PATCH -f description="planted-bug target"',
    ],
    ["GH_REPO=", 'GH_REPO=AJBeumer/faultforge-target gh issue create --title "planted bug" --body x'],
    ["$env:GH_REPO", '$env:GH_REPO="AJBeumer/faultforge-target"; gh issue create --title "planted bug" --body x'],
    [
      "an issue URL after the flags",
      'gh issue comment --body "planted bug" https://github.com/AJBeumer/faultforge-target/issues/3',
    ],
    ["quote-split words", 'gh pr comment 3 -R AJBeumer/faultforge-target -b "pla""nted bug, case F""F-0012"'],
    ["PowerShell string joins", "gh pr comment 3 -R AJBeumer/faultforge-target -b ('pla'+'nted bug')"],
    [
      "--fill-verbose after a quoted title",
      'gh pr create -R AJBeumer/faultforge-target --head b -t "x" --fill-verbose',
    ],
  ])("denies %s", (_name, command) => {
    expect(bash(command)).toBeDefined();
  });

  it("denies a raw API write with curl, even with clean text", () => {
    const curl =
      "curl -X POST -H 'Authorization: Bearer t' https://api.github.com/repos/AJBeumer/faultforge-target/issues/3/comments -d '{\"body\":\"Thanks\"}'";
    expect(bash(curl)).toMatch(/with gh/);
  });

  it("reads a body that comes through stdin: --body-file - and -F- with a redirect or a pipe", () => {
    const dir = targetFolder("Fixes the planted bug\n");
    expect(bash("gh pr create --title Tidy --body-file - < body.md", dir)).toMatch(/says planted/);
    expect(bash("gh pr create --title Tidy -F- < body.md", dir)).toMatch(/says planted/);
    expect(bash("cat body.md | gh pr create --title Tidy --body-file -", dir)).toMatch(/says planted/);
    expect(bash("gh pr create --title Tidy --body-file - < missing.md", dir)).toMatch(/can't read that file/);
    writeFileSync(join(dir, "body.md"), "Small cleanup.\n");
    expect(bash("gh pr create --title Tidy --body-file - < body.md", dir)).toBeUndefined();
  });

  it("reads a body file from the folder the command moves into, not only the hook's folder", () => {
    const clean = mkdtempSync(join(tmpdir(), "guard-clean-"));
    writeFileSync(join(clean, "body.md"), "Small cleanup.\n");
    const target = targetFolder("Fixes the planted bug\n").replace(/\\/g, "/");
    expect(bash(`cd ${target} && gh pr create --title Tidy --body-file body.md`, clean)).toMatch(/says planted/);
  });

  it("reads a gh --template file and a commit's -t template", () => {
    const dir = targetFolder("Fixes the planted bug\n");
    expect(bash("gh pr create --title Tidy --template body.md", dir)).toMatch(/says planted/);
    expect(bash("git commit -t body.md", dir)).toMatch(/says planted/);
  });

  it.each([
    "git push -fu origin main",
    "git push -uf origin main",
    'git push "--force" origin main',
    "git push origin '+main'",
    "git push --mirror",
    "git push origin --delete main",
    "git push -d origin main",
    "git push origin :main",
    "gi''t pu''sh --fo''rce origin main",
    "git send-pack --force origin main",
  ])("denies the history rewrite %s", (command) => {
    expect(bash(command, TARGET)).toMatch(/Force pushes/);
  });

  it("denies a force push through GIT_DIR", () => {
    expect(
      bash("GIT_DIR=../faultforge-target/.git GIT_WORK_TREE=../faultforge-target git push --force origin main"),
    ).toMatch(/Force pushes/);
  });

  it("denies an MCP tool's input that names the target and gives the lab away", () => {
    const input = { owner: "AJBeumer", repo: "faultforge-target", title: "Fix the planted bug" };
    expect(verdict("mcp__github__create_issue", input)).toMatch(/says planted/);
    expect(verdict("mcp__github__create_issue", { ...input, title: "Tidy" })).toBeUndefined();
  });

  it("still posts a clean body from a file", () => {
    const dir = targetFolder("Filter bookings by status.\n");
    expect(bash("gh pr create --title Tidy --body-file body.md", dir)).toBeUndefined();
  });
});

describe("a second clone of a reviewed repo is recognised by its remote (AUD-M3)", () => {
  const clone = tempRepo();
  clone.git("remote", "add", "origin", "https://github.com/AJBeumer/faultforge-target.git");
  const dir = clone.dir;

  it("guards commits, pushes and edits there although its folder has another name", () => {
    expect(bash('git commit --allow-empty -m "Fix the planted bug FF-0012"', dir)).toMatch(/says planted/);
    expect(bash("git push --force origin main", dir)).toMatch(/Force pushes/);
    expect(bash(`cd "${dir.replace(/\\/g, "/")}" && git push --force origin main`)).toMatch(/Force pushes/);
    expect(verdict("Write", { file_path: join(dir, "src", "x.ts"), content: "// planted here" })).toMatch(
      /says planted/,
    );
  });

  it("reads that clone's own pending content before a commit", () => {
    writeFileSync(join(dir, "notes.md"), "The answer key lives elsewhere.\n");
    expect(bash('git commit -am "Tidy"', dir)).toMatch(/answer key/);
    execFileSync("git", ["-C", dir, "clean", "-fdq"]);
    expect(bash('git commit -am "Tidy"', dir)).toBeUndefined();
  });

  it("finds it through a worktree's .git file too", () => {
    const worktree = join(mkdtempSync(join(tmpdir(), "guard-wt-")), "elsewhere");
    clone.git("worktree", "add", "-q", worktree);
    expect(bash('git commit --allow-empty -m "Fix the planted bug"', worktree)).toMatch(/says planted/);
  });
});

describe("holes Qodo found in the first version (PR 265)", () => {
  it("refuses a hook answer Claude Code would ignore: another event, or a decision it doesn't know", () => {
    const event = (hookEventName: string, permissionDecision: string) =>
      JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision } });
    expect(answer("h", { status: 0, stdout: event("PostToolUse", "deny"), stderr: "" }).code).toBe(2);
    expect(answer("h", { status: 0, stdout: event("PreToolUse", "maybe"), stderr: "" }).code).toBe(2);
    expect(answer("h", { status: 0, stdout: event("PreToolUse", "deny"), stderr: "" }).code).toBe(0);
  });

  it("counts a raw write to GitHub's GraphQL endpoint as reaching every reviewed repo", () => {
    expect(bash("curl -X POST https://api.github.com/graphql -d @payload.json")).toMatch(/with gh/);
  });

  it("keeps a private id out of a reviewed checkout's files and pending content", () => {
    const checkout = tempRepo(true);
    const extra = { FAULTFORGE_CONFIG: guardConfig(checkout.dir) };
    const write = { file_path: join(checkout.dir, "notes.md"), content: "see x-secret-v1" };
    expect(verdict("Write", write, LAB, extra)).toMatch(/still private/);
    writeFileSync(join(checkout.dir, "notes.md"), "see x-secret-v1\n");
    const reason = bash('git commit -am "Tidy"', TARGET, extra);
    expect(reason).toMatch(/names a private template/);
    expect(reason).not.toMatch(/secret/);
    writeFileSync(join(checkout.dir, "notes.md"), "see the notes\n");
    expect(bash('git commit -am "Tidy"', TARGET, extra)).toBeUndefined();
  });

  it("keeps a private id out of git's own commit-msg hook too", () => {
    const message = join(mkdtempSync(join(tmpdir(), "guard-msg-")), "COMMIT_EDITMSG");
    writeFileSync(message, "Add x-secret-v1\n");
    const saved = process.env.FAULTFORGE_PRIVATE_DIR;
    process.env.FAULTFORGE_PRIVATE_DIR = PRIVATE;
    try {
      expect(check("commit-msg", tempRepo().dir, message)?.reasons).toEqual(["names a private template"]);
    } finally {
      if (saved === undefined) delete process.env.FAULTFORGE_PRIVATE_DIR;
      else process.env.FAULTFORGE_PRIVATE_DIR = saved;
    }
  });

  it("doesn't take a fake --repo in a body, or a repo that only shares the private repo's name, as private storage", () => {
    const priv = privateFolder();
    execFileSync("git", ["init", "-q", priv]);
    execFileSync("git", ["-C", priv, "remote", "add", "origin", "https://github.com/AJBeumer/faultforge-private.git"]);
    const extra = { FAULTFORGE_PRIVATE_DIR: priv };
    const post = (repo: string) => `gh issue create -R ${repo} --title x --body "x-secret-v1"`;
    expect(
      bash('gh pr create --title Tidy --body "x-secret-v1 --repo AJBeumer/faultforge-private"', LAB, extra),
    ).toMatch(/still private/);
    expect(bash(post("someone/faultforge-private"), LAB, extra)).toMatch(/still private/);
    expect(bash(post("AJBeumer/faultforge-private"), LAB, extra)).toBeUndefined();
  });

  it("lets a second clone commit when the configured checkout is missing", () => {
    const repo = tempRepo();
    repo.git("remote", "add", "origin", "https://github.com/AJBeumer/faultforge-target.git");
    const clone = repo.dir;
    const extra = { FAULTFORGE_CONFIG: guardConfig(join(tmpdir(), "no-such-checkout-here")) };
    expect(bash('git commit --allow-empty -m "Tidy"', clone, extra)).toBeUndefined();
    expect(bash('git commit --allow-empty -m "Fix the planted bug"', clone, extra)).toMatch(/says planted/);
  });
});
