import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_KEY, installHooks } from "../src/guard-install.ts";

const root = resolve(import.meta.dirname, "../../..");
const SCRIPT = join(root, ".claude", "hooks", "git-guard.ts");
// Assembled, so this file's own text stays plain.
const WORD = ["plan", "ted"].join("");

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

/** A clone with a bare origin and the git-level guard installed, as `guard:install` leaves a checkout. */
function guarded() {
  const remote = mkdtempSync(join(tmpdir(), "git-guard-remote-"));
  const dir = mkdtempSync(join(tmpdir(), "git-guard-repo-"));
  scratch.push(remote, dir);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  /** Runs git and returns its exit status instead of throwing. */
  const status = (...args: string[]) => {
    try {
      git(...args);
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# App\n");
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  git("remote", "add", "origin", remote);
  git("push", "-q", "-u", "origin", "main");
  installHooks(dir, SCRIPT);
  return { dir, git, status };
}

describe("the git-level guard, run by git itself (#191)", () => {
  it("refuses a commit whose message or staged file gives the change away, and allows a clean one", () => {
    const { dir, git, status } = guarded();
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "a.md"), "Tidy\n");
    git("add", "a.md");
    expect(status("commit", "-q", "-m", `The ${WORD} change`)).not.toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(head);

    writeFileSync(join(dir, "a.md"), `The ${WORD} change\n`);
    git("add", "a.md");
    expect(status("commit", "-q", "-m", "Tidy")).not.toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(head);

    writeFileSync(join(dir, "a.md"), "Tidy the lookup\n");
    git("add", "a.md");
    expect(status("commit", "-q", "-m", "Tidy the lookup")).toBe(0);
  }, 60_000);

  it("refuses a push that carries a commit made around the commit hooks, and allows a clean push", () => {
    const { dir, git, status } = guarded();
    writeFileSync(join(dir, "b.md"), `${WORD} here\n`);
    git("add", "b.md");
    git("commit", "-q", "--no-verify", "-m", "Tidy");
    expect(status("push", "-q", "origin", "main")).not.toBe(0);
    git("reset", "-q", "--hard", "origin/main");
    writeFileSync(join(dir, "b.md"), "Clean\n");
    git("add", "b.md");
    git("commit", "-q", "-m", "Clean");
    expect(status("push", "-q", "origin", "main")).toBe(0);
  }, 60_000);

  it("refuses a push that would create a branch named with a giveaway word", () => {
    const { git, status } = guarded();
    git("switch", "-q", "-c", `${WORD}-fix`);
    expect(status("push", "-q", "-u", "origin", "HEAD")).not.toBe(0);
  }, 60_000);

  it("refuses everything when the script setting is gone: a hook that can't check lets nothing through", () => {
    const { dir, git, status } = guarded();
    git("config", "--local", "--unset", CONFIG_KEY);
    writeFileSync(join(dir, "c.md"), "Clean\n");
    git("add", "c.md");
    expect(status("commit", "-q", "-m", "Clean")).not.toBe(0);
  }, 60_000);
});

describe("the git-level guard reads what a push really sends (Qodo on PR 213)", () => {
  it("refuses a push to a destination ref named with a giveaway word, from a clean local branch", () => {
    const { git, status } = guarded();
    expect(status("push", "-q", "origin", `HEAD:refs/heads/${WORD}-fix`)).not.toBe(0);
    expect(status("push", "-q", "origin", "HEAD:refs/heads/tidy-fix")).toBe(0);
    // A deletion is refused (re-grade 3); the test cleans up around the hook.
    git("push", "-q", "--no-verify", "origin", "--delete", "tidy-fix");
  }, 60_000);

  it("refuses a message line that starts with # when -m keeps it", () => {
    const { dir, git, status } = guarded();
    writeFileSync(join(dir, "d.md"), "Clean\n");
    git("add", "d.md");
    expect(status("commit", "-q", "-m", "Tidy", "-m", `# the ${WORD} part`)).not.toBe(0);
  }, 60_000);

  it("refuses a commit one remote already has when it goes to another", () => {
    const { dir, git, status } = guarded();
    const backup = mkdtempSync(join(tmpdir(), "git-guard-backup-"));
    scratch.push(backup);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", backup]);
    git("remote", "add", "backup", backup);
    writeFileSync(join(dir, "e.md"), `${WORD} here\n`);
    git("add", "e.md");
    git("commit", "-q", "--no-verify", "-m", "Tidy");
    git("push", "-q", "--no-verify", "origin", "main");
    expect(status("push", "-q", "backup", "main")).not.toBe(0);
  }, 60_000);
});

describe("the git-level guard keeps the reviewed repo's history, however the push starts (re-grade 3)", () => {
  /** A guarded clone whose last pushed commit has been rewritten locally. */
  function rewritten() {
    const repo = guarded();
    writeFileSync(join(repo.dir, "f.md"), "One\n");
    repo.git("add", "f.md");
    repo.git("commit", "-q", "-m", "Add f");
    repo.git("push", "-q", "origin", "main");
    repo.git("commit", "-q", "--amend", "-m", "Add f, reworded");
    return repo;
  }

  it.each([
    ["git push --force", ["push", "-q", "--force", "origin", "main"]],
    ["a + refspec", ["push", "-q", "origin", "+main"]],
    ["--force-with-lease", ["push", "-q", "--force-with-lease", "origin", "main"]],
    ["--mirror", ["push", "-q", "--mirror", "origin"]],
  ])(
    "refuses %s, and the remote keeps its commit",
    (_name, args) => {
      const { git, status } = rewritten();
      const before = git("rev-parse", "origin/main");
      expect(status(...args)).not.toBe(0);
      expect(git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(before);
    },
    60_000,
  );

  it.each([
    ["--delete", ["push", "-q", "origin", "--delete", "tidy"]],
    ["a :ref refspec", ["push", "-q", "origin", ":tidy"]],
  ])(
    "refuses a deletion by %s",
    (_name, args) => {
      // Not main: a bare remote refuses to delete its own HEAD branch whatever the hook says.
      const { git, status } = guarded();
      git("push", "-q", "origin", "HEAD:refs/heads/tidy");
      expect(status(...args)).not.toBe(0);
      expect(git("ls-remote", "origin", "refs/heads/tidy")).not.toBe("");
    },
    60_000,
  );

  it("refuses a force push started from a subprocess the Claude Code guard can't read", () => {
    const { dir, git } = rewritten();
    const before = git("rev-parse", "origin/main");
    const code = `require("child_process").execFileSync("git", ["-C", process.argv[1], "push", "-q", "--force", "origin", "main"], { stdio: "ignore" })`;
    let failed = false;
    try {
      execFileSync(process.execPath, ["-e", code, dir], { stdio: "ignore" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(before);
  }, 60_000);

  it("allows an ordinary fast-forward push", () => {
    const { dir, git, status } = guarded();
    writeFileSync(join(dir, "g.md"), "Clean\n");
    git("add", "g.md");
    git("commit", "-q", "-m", "Add g");
    expect(status("push", "-q", "origin", "main")).toBe(0);
  }, 60_000);
});
