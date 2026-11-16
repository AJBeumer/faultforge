/**
 * Private template ids stay out of every public post (AUD-H1): in any spelling, in any message source, in a
 * reviewed checkout's files and in git's own hooks; and private storage is told by its checkout and its origin,
 * never by a name a command could fake. The ids and folders are made up.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askGuard, guardConfig, labWithPrivate, privateStore, REPOS, scratchFolder, tempRepo } from "../fixtures.ts";
import { check } from "../git-guard.ts";
import { decide } from "../guard-target.ts";

const LAB = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";
const CONFIG = guardConfig(tempRepo(true).dir);

/**
 * A private folder holding one unreleased template and one that is already in templates/seed/. Its name has a
 * `~`, as a Windows short name does (CI runs in `C:\Users\RUNNER~1`).
 */
const privateFolder = () => privateStore("guard~private-", ["idempotency-guard-bypass-v1"]);
const PRIVATE = privateFolder();

/** The deny reason for one tool call, or undefined when allowed; a blocking error fails the test. */
const verdict = (tool: string, input: object, cwd = LAB, extra: NodeJS.ProcessEnv = {}) =>
  askGuard(tool, input, cwd, { config: CONFIG, privateDir: PRIVATE }, extra);
const bash = (command: string, cwd?: string, extra?: NodeJS.ProcessEnv) => verdict("Bash", { command }, cwd, extra);

/** Private storage that is its own git checkout, with the private repo as its remote. */
function privateCheckout(): string {
  const priv = privateFolder();
  execFileSync("git", ["init", "-q", priv]);
  execFileSync("git", ["-C", priv, "remote", "add", "origin", "https://github.com/AJBeumer/faultforge-private.git"]);
  return priv;
}
const at = (dir: string) => dir.replace(/\\/g, "/");

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

describe("a private id stays out of reviewed checkouts, lab files and git's own hooks", () => {
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

  it("keeps a private id out of lab files, but not out of private storage", () => {
    const lab = join(LAB, "docs", "notes.md");
    expect(verdict("Write", { file_path: lab, content: "x-secret-v1" })).toMatch(/still private/);
    expect(verdict("Write", { file_path: join(PRIVATE, "notes.md"), content: "x-secret-v1" })).toBeUndefined();
  });

  it("never prints a private id in a refusal, such as a missing body file's name", () => {
    const reason = bash("gh pr create --title Tidy --body-file x-secret-v1.md");
    expect(reason).toMatch(/still private/);
    expect(reason).not.toMatch(/secret/);
  });

  it("refuses when the private templates folder exists but can't be read", () => {
    const priv = mkdtempSync(join(tmpdir(), "guard-unreadable-"));
    writeFileSync(join(priv, "templates"), "a file where a folder should be\n");
    const payload = JSON.stringify({ tool_name: "Bash", cwd: LAB, tool_input: { command: "gh pr create -t x -b y" } });
    const decision = decide(payload, { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: priv });
    expect(decision.kind).toBe("error");
  });
});

describe("private storage is told by its checkout and its origin, never by a name a command could fake", () => {
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

  it("doesn't take a push from private storage to a public URL, or a GIT_DIR elsewhere, as private", () => {
    const priv = privateCheckout();
    const extra = { FAULTFORGE_PRIVATE_DIR: priv };
    const url = `git -C "${at(priv)}" push https://github.com/AJBeumer/faultforge.git x-secret-v1`;
    expect(bash(url, LAB, extra)).toMatch(/still private|stays private/);
    expect(bash(`cd "${at(priv)}" && GIT_DIR=../.git git commit -m "x-secret-v1"`, LAB, extra)).toMatch(
      /still private/,
    );
    expect(bash(`git -C "${at(priv)}" commit -m "Document x-secret-v1 for gh"`, LAB, extra)).toBeUndefined();
  });

  it("doesn't let a plain private folder borrow the lab's remote", () => {
    const lab = tempRepo();
    lab.git("remote", "add", "origin", "https://github.com/AJBeumer/faultforge.git");
    const priv = join(lab.dir, "private");
    mkdirSync(join(priv, "templates", "x-secret-v1"), { recursive: true });
    const post = 'gh pr create --repo AJBeumer/faultforge --title Tidy --body "x-secret-v1"';
    expect(bash(post, lab.dir, { FAULTFORGE_PRIVATE_DIR: priv })).toMatch(/still private/);
  });

  it("doesn't take a cd inside a quoted message as a move into private storage", () => {
    const priv = PRIVATE.replace(/\\/g, "/");
    expect(bash(`echo "x; cd ${priv}" && git commit -m "x-secret-v1"`)).toMatch(/still private/);
  });

  it("doesn't take a destination built by the shell as private storage", () => {
    const priv = privateFolder();
    execFileSync("git", ["init", "-q", priv]);
    execFileSync("git", ["-C", priv, "remote", "add", "origin", "https://github.com/AJBeumer/faultforge-private.git"]);
    const command =
      'GH_REPO=AJBeumer/faultforge-private gh issue create --repo "$PUBLIC" --title x --body "x-secret-v1"';
    // Refused either way: the repo is a variable the command doesn't set (#285), or the id is private.
    expect(bash(command, LAB, { FAULTFORGE_PRIVATE_DIR: priv })).toMatch(/still private|shell variable/);
  });

  it("follows a link inside private storage to where it really leads", () => {
    const outside = mkdtempSync(join(tmpdir(), "guard-outside-"));
    const priv = privateFolder();
    symlinkSync(outside, join(priv, "link"), "junction");
    const write = { file_path: join(priv, "link", "notes.md"), content: "x-secret-v1" };
    expect(verdict("Write", write, LAB, { FAULTFORGE_PRIVATE_DIR: priv })).toMatch(/still private/);
  });
});

describe("percent-escaped private ids", () => {
  const config = guardConfig(tempRepo(true).dir);
  const privateDir = privateStore("guard~regrade-");

  it.each(["uses x%2Dsecret%2Dv1", "uses x%2dsecret%2dv1", "uses %78-secret-v1", "uses x%252Dsecret%252Dv1"])(
    "denies an API field %s",
    (body) => {
      const command = `gh api repos/AJBeumer/faultforge/issues/5/comments -f body="${body}"`;
      expect(askGuard("Bash", { command }, LAB, { config, privateDir })).toMatch(/still private/);
    },
  );
});

describe("a private id written backwards is still the id", () => {
  const config = guardConfig(tempRepo(true).dir);
  const { privateDir } = labWithPrivate();
  const elsewhere = scratchFolder("guard-elsewhere6-");
  const ask = (command: string) => askGuard("Bash", { command }, elsewhere, { config, privateDir, outsideRun: true });

  it("refuses it in a lab post", () => {
    expect(ask(`gh pr create -R ${REPOS.lab} -t x -b "uses 1v-terces-x"`)).toMatch(/still private/);
    expect(ask(`gh pr create -R ${REPOS.lab} -t x -b "uses 1V_TERCES_X"`)).toMatch(/still private/);
  });
});
