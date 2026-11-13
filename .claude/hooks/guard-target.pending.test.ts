/**
 * The guard's decisions that depend on what git holds in a reviewed checkout (guard-content.ts, through the
 * hook). Every test builds its own temporary repository, so these are the slow tests of the hook: they are in
 * their own file to run on their own worker, next to the text-only decisions in guard-target.test.ts (#121).
 */
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardConfig, guardDecision, tempRepo } from "./fixtures.ts";

const HARNESS = "D:\\Projects\\FaultForge";
// Nothing here aims a command at the target, so its checkout is pointed at a folder that doesn't exist: the
// guard skips a reviewed checkout it can't find unless the command is aimed at it, and each decision then
// reads only the fixture under test.
const MISSING_TARGET = join(tmpdir(), "no-such-target-checkout");

/** The deny reason for one tool call, or undefined if allowed; see guardDecision. */
const decide = (tool: string, toolInput: object, cwd: string, config: string) =>
  guardDecision(tool, toolInput, cwd, config);

describe("content about to travel, read from git whatever the command text says", () => {
  /** A fixture repo named as a second reviewed repo, `other-app`; the folder's own name is what the guard looks for. */
  function reviewedRepo(withOrigin = false) {
    const { dir, git } = tempRepo(withOrigin);
    const config = guardConfig(MISSING_TARGET, (c) => {
      c.repos.other = { ...c.repos.target, github: "AJBeumer/other-app", path: dir };
    });
    return { dir, git, config };
  }

  it("refuses a commit anywhere while a reviewed checkout holds a staged telltale, however it got there", () => {
    const { dir, git, config } = reviewedRepo();
    writeFileSync(join(dir, "notes.md"), "The planted bug is here\n"); // as a redirect or a copy would
    git("add", "notes.md");
    expect(decide("Bash", { command: 'git commit -m "Tidy"' }, dir, config)).toMatch(
      /other-app holds content[\s\S]*says planted/,
    );
    // Attribution-independent: the same commit started from this repo's folder is refused too.
    expect(decide("Bash", { command: 'git commit -m "Tidy"' }, HARNESS, config)).toMatch(/other-app holds content/);
  });

  it("refuses a chained add-and-commit while an untracked file holds a telltale, or is named with one", () => {
    const { dir, config } = reviewedRepo();
    writeFileSync(join(dir, "todo.md"), "fix the planted bug\n");
    expect(decide("Bash", { command: 'git add . && git commit -m "Tidy"' }, dir, config)).toMatch(/says planted/);
    rmSync(join(dir, "todo.md"));
    writeFileSync(join(dir, "FF-0002-notes.md"), "nothing much\n");
    expect(decide("Bash", { command: 'git add . && git commit -m "Tidy"' }, dir, config)).toMatch(/contains a case id/);
  });

  it("lets a harmless change be committed, and ignores pending content when nothing is committed or pushed", () => {
    const { dir, git, config } = reviewedRepo();
    writeFileSync(join(dir, "README.md"), "# App\n\nRelease notes.\n");
    git("add", "README.md");
    expect(decide("Bash", { command: 'git commit -m "Add release notes"' }, dir, config)).toBeUndefined();
    writeFileSync(join(dir, "scratch.md"), "planted\n");
    expect(decide("Bash", { command: "npm run check" }, dir, config)).toBeUndefined();
  });

  it("refuses a push while a local branch or tag not on the remote is named with a telltale (#190)", () => {
    const { dir, git, config } = reviewedRepo(true);
    git("switch", "-q", "-c", "planted-bug-7");
    expect(decide("Bash", { command: "git push -u origin HEAD" }, dir, config)).toMatch(
      /a new branch, or a tag \(planted-bug-7\)[\s\S]*says planted/,
    );
    git("switch", "-q", "main");
    git("branch", "-q", "-D", "planted-bug-7");
    git("tag", "ff-0002");
    expect(decide("Bash", { command: "git push --tags" }, dir, config)).toMatch(/case id/);
    // A tag is read even when a branch of the same name is on the remote, and once it is published too:
    // without asking the remote the guard can't tell, and a giveaway tag shouldn't stay (Qodo on PR 208).
    git("push", "-q", "origin", "main:refs/heads/ff-0002");
    git("fetch", "-q", "origin");
    expect(decide("Bash", { command: "git push origin main" }, dir, config)).toMatch(/case id/);
    git("tag", "-d", "ff-0002");
    // A branch is read even when one remote already has it: a push can send it to another (Qodo on PR 208).
    git("branch", "ff-0003");
    git("push", "-q", "origin", "ff-0003");
    git("fetch", "-q", "origin");
    expect(decide("Bash", { command: "git push backup --all" }, dir, config)).toMatch(/case id/);
    git("branch", "-q", "-D", "ff-0003");
    // An ordinary new branch, and one already on the remote, pass.
    git("switch", "-q", "-c", "tidy-lookup");
    expect(decide("Bash", { command: "git push -u origin HEAD" }, dir, config)).toBeUndefined();
  });

  it("refuses a push while an unpushed commit added a telltale, and allows it once the branch is clean", () => {
    const { dir, git, config } = reviewedRepo(true);
    writeFileSync(join(dir, "notes.md"), "The planted bug is here\n");
    git("add", "notes.md");
    git("commit", "-q", "-m", "Tidy"); // made directly, as a bypass of the commit check would be
    expect(decide("Bash", { command: "git push origin HEAD" }, dir, config)).toMatch(
      /other-app holds content[\s\S]*not yet on any remote branch[\s\S]*says planted/,
    );
    git("reset", "-q", "--hard", "origin/main");
    expect(decide("Bash", { command: "git push origin HEAD" }, dir, config)).toBeUndefined();
  });

  it("denies when git can't answer for a reviewed checkout, rather than guessing", () => {
    const { dir, config } = reviewedRepo();
    writeFileSync(join(dir, ".git", "HEAD"), "not a ref\n"); // git can no longer read the repository
    expect(decide("Bash", { command: "git push" }, dir, config)).toMatch(/can't inspect other-app/);
  });

  describe("what Qodo found in round 2 (PR 120)", () => {
    it("reads whole file contents, so a line starting with ++ and a binary file are both checked", () => {
      const { dir, git, config } = reviewedRepo();
      writeFileSync(join(dir, "a.md"), "++ the planted bug\n");
      git("add", "a.md");
      expect(decide("Bash", { command: 'git commit -m "Tidy"' }, dir, config)).toMatch(/says planted/);
      git("reset", "-q", "HEAD", "a.md");
      rmSync(join(dir, "a.md"));
      writeFileSync(
        join(dir, "img.bin"),
        Buffer.concat([Buffer.from([0, 1, 2, 255, 254]), Buffer.from("planted"), Buffer.from([0, 0])]),
      );
      git("add", "img.bin");
      expect(decide("Bash", { command: 'git commit -m "Tidy"' }, dir, config)).toMatch(/says planted/);
    });

    it("scans every local commit not on a remote, whatever branch the push names, commit by commit", () => {
      const { dir, git, config } = reviewedRepo();
      git("checkout", "-q", "-b", "feature");
      writeFileSync(join(dir, "notes.md"), "The planted bug is here\n");
      git("add", "notes.md");
      git("commit", "-q", "-m", "Tidy");
      git("rm", "-q", "notes.md");
      git("commit", "-q", "-m", "Tidy more"); // the net diff is clean, the first commit is not
      git("checkout", "-q", "main"); // HEAD is clean; the push names the other branch
      expect(decide("Bash", { command: "git push origin feature" }, dir, config)).toMatch(/says planted/);
    });

    it("scans the commit messages that would travel too", () => {
      const { dir, git, config } = reviewedRepo();
      writeFileSync(join(dir, "README.md"), "# App\n\nMore.\n");
      git("add", "README.md");
      git("commit", "-q", "-m", "Fix the planted bug");
      expect(decide("Bash", { command: "git push" }, dir, config)).toMatch(/says planted/);
    });

    it("includes ignored files only when the command forces them in", () => {
      const { dir, git, config } = reviewedRepo();
      writeFileSync(join(dir, ".gitignore"), "secret.md\n");
      git("add", ".gitignore");
      git("commit", "-q", "-m", "Ignore secrets");
      writeFileSync(join(dir, "secret.md"), "planted\n");
      expect(decide("Bash", { command: 'git add . && git commit -m "Tidy"' }, dir, config)).toBeUndefined();
      expect(decide("Bash", { command: 'git add -f secret.md && git commit -m "Tidy"' }, dir, config)).toMatch(
        /says planted/,
      );
    });

    it("reads an untracked file whose name git would quote", () => {
      const { dir, config } = reviewedRepo();
      writeFileSync(join(dir, "café notes.md"), "planted\n");
      expect(decide("Bash", { command: 'git add . && git commit -m "Tidy"' }, dir, config)).toMatch(/says planted/);
    });

    it("refuses a chain that writes files or hides git behind a function before committing in the checkout", () => {
      const { dir, config } = reviewedRepo();
      writeFileSync(join(tmpdir(), "guard-src.md"), "planted\n");
      expect(
        decide(
          "Bash",
          { command: `cp ${join(tmpdir(), "guard-src.md")} . && git add . && git commit -m Tidy` },
          dir,
          config,
        ),
      ).toMatch(/on its own/);
      expect(decide("Bash", { command: 'f(){ git "$@"; }; f commit -m Tidy' }, dir, config)).toMatch(/on its own/);
      expect(decide("Bash", { command: 'echo "x" > notes.md; git add . && git commit -m Tidy' }, dir, config)).toMatch(
        /on its own/,
      );
    });

    it("still allows the ordinary chain of git steps, and any chain outside a reviewed checkout", () => {
      const { dir, config } = reviewedRepo();
      writeFileSync(join(dir, "msg.txt"), "Add release notes\n");
      expect(
        decide("Bash", { command: "git add -A && git commit -F msg.txt && git push -u origin HEAD" }, dir, config),
      ).toBeUndefined();
      expect(
        decide("Bash", { command: "npm run check && git add -A && git commit -F msg.txt" }, dir, config),
      ).toBeUndefined();
      expect(
        decide("Bash", { command: "cp a.md b.md && git add . && git commit -m Tidy" }, HARNESS, config),
      ).toBeUndefined();
    });

    it("denies a commit aimed at a reviewed checkout the guard can't find", () => {
      const missing = join(tmpdir(), "no-such-other-app");
      const config = guardConfig(MISSING_TARGET, (c) => {
        c.repos.other = { ...c.repos.target, github: "AJBeumer/other-app", path: missing };
      });
      expect(decide("Bash", { command: `git -C ${missing} commit -m Tidy` }, HARNESS, config)).toMatch(/can't find/);
      // A commit elsewhere is not held up by a reviewed checkout that isn't there.
      expect(decide("Bash", { command: "git commit -m Tidy" }, HARNESS, config)).toBeUndefined();
    });
  });

  describe("what Qodo found in round 3 (PR 120), through the hook", () => {
    it("refuses a chain with a numbered redirect or an expanding heredoc, and allows git -C steps", () => {
      const { dir, config } = reviewedRepo();
      expect(
        decide("Bash", { command: 'echo "$X" 1>notes.md && git add . && git commit -m Tidy' }, dir, config),
      ).toMatch(/on its own/);
      expect(
        decide(
          "Bash",
          { command: "echo <<EOF\n$(echo planted > n.md)\nEOF\ngit add . && git commit -m Tidy" },
          dir,
          config,
        ),
      ).toMatch(/on its own/);
      expect(
        decide("Bash", { command: `git -C ${dir} add -A && git -C ${dir} commit -m Tidy` }, HARNESS, config),
      ).toBeUndefined();
    });

    it("refuses a push whose merge commit introduced a telltale while resolving", () => {
      const { dir, git, config } = reviewedRepo(true);
      git("checkout", "-q", "-b", "feature");
      writeFileSync(join(dir, "feature.md"), "fine\n");
      git("add", "feature.md");
      git("commit", "-q", "-m", "Feature");
      git("checkout", "-q", "main");
      git("merge", "-q", "--no-ff", "--no-commit", "feature");
      writeFileSync(join(dir, "resolved.md"), "The planted bug\n");
      git("add", "resolved.md");
      git("commit", "-q", "-m", "Merge feature");
      expect(decide("Bash", { command: "git push" }, dir, config)).toMatch(/says planted/);
    });

    it("refuses a commit of a file staged and then deleted from the working tree", () => {
      const { dir, git, config } = reviewedRepo();
      writeFileSync(join(dir, "notes.md"), "The planted bug\n");
      git("add", "notes.md");
      rmSync(join(dir, "notes.md"));
      expect(decide("Bash", { command: 'git commit -m "Tidy"' }, dir, config)).toMatch(/says planted/);
    });
  });
});
