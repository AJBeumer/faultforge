import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOOK = join(import.meta.dirname, "guard-target.ts");
const HARNESS = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";
const FACTORY = JSON.parse(readFileSync(join(import.meta.dirname, "../../factory.json"), "utf8"));

/**
 * A temporary git repository with one commit, standing in for a reviewed checkout so the guard reads pending
 * content from it and never from the owner's real checkout. With `withOrigin`, a bare `origin` tracks its
 * `main`; without one, every local commit counts as unpushed, which the tests that don't push don't mind.
 */
function tempRepo(withOrigin = false) {
  const dir = mkdtempSync(join(tmpdir(), "guard-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# App\n");
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  if (withOrigin) {
    const remote = mkdtempSync(join(tmpdir(), "guard-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git("remote", "add", "origin", remote);
    git("push", "-q", "-u", "origin", "main");
  }
  return { dir, git };
}

/** factory.json with the target's checkout pointed at a fixture repo, written to its own temp file. */
function configWithTarget(checkout: string, extra?: (config: typeof FACTORY) => void): string {
  const config = structuredClone(FACTORY);
  config.repos.target.path = checkout;
  extra?.(config);
  const file = join(mkdtempSync(join(tmpdir(), "guard-config-")), "factory.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

// Every test runs the hook against this fixture as the target's checkout, not the owner's real one. It has
// an origin so nothing in it counts as unpushed, which keeps the push scan to one git call per test.
const TARGET_FIXTURE = tempRepo(true).dir;
const DEFAULT_CONFIG = configWithTarget(TARGET_FIXTURE);

/** Runs the hook with a payload and returns the deny reason, or undefined if allowed. */
function decide(tool: string, toolInput: object, cwd = HARNESS, config = DEFAULT_CONFIG): string | undefined {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: toolInput }),
    encoding: "utf8",
    env: { ...process.env, FAULTFORGE_CONFIG: config },
  });
  expect(result.status).toBe(0);
  if (!result.stdout.trim()) return undefined;
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
}

const bash = (command: string, cwd?: string) => decide("Bash", { command }, cwd);

describe("guard-target hook", () => {
  describe("blocks", () => {
    it("a PR body that names the lab", () => {
      expect(bash('gh pr create --repo AJBeumer/faultforge-target --title "Tidy" --body "FaultForge case"')).toMatch(
        /names the lab/,
      );
    });

    it("a target commit that says planted", () => {
      expect(bash('git -C /d/Projects/faultforge-target commit -m "Fix planted bug"')).toMatch(/says planted/);
    });

    it("a force push to the target", () => {
      expect(bash("cd /d/Projects/faultforge-target && git push --force origin main")).toMatch(/Force pushes/);
    });

    it("a force push to the target by URL, from anywhere", () => {
      expect(bash("git push https://github.com/AJBeumer/faultforge-target.git +main")).toMatch(/Force pushes/);
      expect(bash("git push --force https://github.com/AJBeumer/faultforge-target.git main")).toMatch(/Force pushes/);
    });

    it("a comment with a case id posted through gh api", () => {
      expect(bash('gh api repos/AJBeumer/faultforge-target/issues/1/comments -f body="FF-0002 closed"')).toMatch(
        /case id/,
      );
    });

    it("an edit to a target file that names the lab", () => {
      expect(
        decide("Edit", { file_path: "D:/Projects/faultforge-target/README.md", new_string: "Used by FaultForge" }),
      ).toMatch(/names the lab/);
    });

    it("a commit made from inside the target that mentions the ledger", () => {
      expect(bash('git commit -m "Update ledger"', TARGET)).toMatch(/ledger/);
    });

    it("a notebook edit in the target whose new source names the bug", () => {
      expect(
        decide("NotebookEdit", {
          notebook_path: `${TARGET}\\notes\\demo.ipynb`,
          new_source: "# the planted bug is here",
        }),
      ).toMatch(/says planted/);
    });
  });

  describe("allows", () => {
    it("a neutral PR on the target", () => {
      expect(
        bash('gh pr create --repo AJBeumer/faultforge-target --title "Simplify replay lookup" --body "Small cleanup."'),
      ).toBeUndefined();
    });

    it("read-only gh api calls on the target", () => {
      expect(bash("gh api repos/AJBeumer/faultforge-target/issues/1/comments")).toBeUndefined();
    });

    it("a neutral target commit", () => {
      expect(bash('cd /d/Projects/faultforge-target && git commit -m "Shorten README intro"')).toBeUndefined();
    });

    it("commits in this repository that mention the lab", () => {
      expect(bash('git commit -m "Add FaultForge proof test and ledger"')).toBeUndefined();
    });

    it("Fastify's app.inject in target tests", () => {
      expect(
        decide("Edit", {
          file_path: "D:/Projects/faultforge-target/test/x.test.ts",
          new_string: "await app.inject(req) // deps are injected",
        }),
      ).toBeUndefined();
    });

    it("a normal push to the target", () => {
      expect(bash("git -C D:/Projects/faultforge-target push -u origin tidy-x")).toBeUndefined();
    });

    it("a command in this repo whose file edit happens to contain a target URL (Day 3 false positive)", () => {
      expect(
        bash(
          "cd /d/Projects/FaultForge && node -e 'readme(\"https://github.com/AJBeumer/faultforge-target/pull/1\")' && " +
            'git switch -c publish-record && git commit -m "Publish the FF-0001 case record"',
        ),
      ).toBeUndefined();
    });

    it("an issue here that names target work as plain text", () => {
      expect(
        bash('gh issue create --repo AJBeumer/faultforge --title "Epic" --body "target 10: run the checks"'),
      ).toBeUndefined();
    });
  });

  describe("keeps links one-way: nothing here links to the target", () => {
    it("blocks an issue here that links a target issue", () => {
      expect(
        bash(
          'gh issue create --repo AJBeumer/faultforge --title "x" --body "see https://github.com/AJBeumer/faultforge-target/issues/3"',
        ),
      ).toMatch(/link to the target/);
    });

    it("blocks a PR comment here with a short target reference", () => {
      expect(
        bash('gh pr comment 45 --repo AJBeumer/faultforge --body "fixed in AJBeumer/faultforge-target#6"'),
      ).toMatch(/link to the target/);
    });

    it("blocks an issue here created without --repo, from this folder", () => {
      expect(bash('gh issue create --title "x" --body "faultforge-target#3"')).toMatch(/link to the target/);
    });

    it("blocks a commit message here that references a target PR", () => {
      expect(bash('git commit -m "Follow-up to faultforge-target#6"')).toMatch(/link to the target/);
    });

    it("blocks an API write here that links a target PR", () => {
      expect(
        bash(
          'gh api -X PATCH repos/AJBeumer/faultforge/issues/5 -f body="https://github.com/AJBeumer/faultforge-target/pull/6"',
        ),
      ).toMatch(/link to the target/);
    });

    it("allows a file edit here that links the target (files don't create links)", () => {
      expect(
        decide("Edit", {
          file_path: "D:/Projects/FaultForge/docs/decision-log.md",
          new_string: "[PR #6](https://github.com/AJBeumer/faultforge-target/pull/6)",
        }),
      ).toBeUndefined();
    });

    it("allows a commit message that only mentions gh pr create --fill", () => {
      expect(bash('git commit -q -m "Guard: refuse gh pr create --fill here"')).toBeUndefined();
    });

    it("blocks a link piped in as the commit message (-F -)", () => {
      expect(bash('printf "Follow-up to faultforge-target#6" | git commit -F -')).toMatch(/link to the target/);
    });

    it("blocks a link in a heredoc PR body (--body-file -)", () => {
      expect(
        bash('gh pr create --repo AJBeumer/faultforge --title "x" --body-file - <<EOF\nsee faultforge-target#6\nEOF'),
      ).toMatch(/link to the target/);
    });

    it("blocks a link in a body file whose path has spaces", () => {
      const file = join(tmpdir(), "issue body with spaces.md");
      writeFileSync(file, "see https://github.com/AJBeumer/faultforge-target/issues/3");
      expect(bash(`gh issue create --repo AJBeumer/faultforge --title "x" --body-file "${file}"`)).toMatch(
        /link to the target/,
      );
    });

    it("blocks a PR here filled from commit messages it can't check", () => {
      expect(bash("gh pr create --repo AJBeumer/faultforge --fill")).toMatch(/--fill/);
    });

    it("blocks a link passed through a shell variable", () => {
      expect(
        bash("body='see faultforge-target#6'; gh issue create --repo AJBeumer/faultforge --body \"$body\""),
      ).toMatch(/link to the target/);
    });

    it("allows reading a target PR from here", () => {
      expect(bash("gh pr view https://github.com/AJBeumer/faultforge-target/pull/6")).toBeUndefined();
    });
  });
});

describe("guard-target hook reads the reviewed repos from factory.json", () => {
  const factory = JSON.parse(readFileSync(join(import.meta.dirname, "../../factory.json"), "utf8"));

  /** factory.json plus a third reviewed repo, added as one entry. */
  function withThirdRepo(): string {
    const config = structuredClone(factory);
    config.repos.other = { ...config.repos.target, github: "AJBeumer/other-app", path: "../other-app" };
    const file = join(tmpdir(), "factory-with-third-repo.json");
    writeFileSync(file, JSON.stringify(config));
    return file;
  }

  it("protects a third repo once it has an entry", () => {
    const config = withThirdRepo();
    const bash3 = (command: string) => decide("Bash", { command }, HARNESS, config);
    expect(bash3('gh pr create --repo AJBeumer/other-app --title "x" --body "FaultForge case"')).toMatch(
      /hint into other-app/,
    );
    expect(bash3("git push --force https://github.com/AJBeumer/other-app.git main")).toMatch(
      /Force pushes to other-app/,
    );
    expect(bash3('gh issue create --repo AJBeumer/faultforge --title "x" --body "see other-app#2"')).toMatch(
      /link to the target/,
    );
    expect(
      decide("Edit", { file_path: "D:/Projects/other-app/README.md", new_string: "planted here" }, HARNESS, config),
    ).toMatch(/other-app/);
  });

  it("still protects the target alongside the third repo", () => {
    const command = 'gh pr comment 1 --repo AJBeumer/faultforge-target --body "FaultForge"';
    expect(decide("Bash", { command }, HARNESS, withThirdRepo())).toMatch(/names the lab/);
  });

  it("doesn't touch a repo that isn't in the config", () => {
    expect(bash('gh pr create --repo AJBeumer/other-app --title "x" --body "FaultForge case"')).toBeUndefined();
  });

  /** factory.json changed by `edit`, written to a temp file. */
  function configWith(name: string, edit: (config: typeof factory) => void): string {
    const config = structuredClone(factory);
    edit(config);
    const file = join(tmpdir(), `factory-${name}.json`);
    writeFileSync(file, JSON.stringify(config));
    return file;
  }

  it("keeps protecting the target when the config wrongly marks it as lab", () => {
    const config = configWith("target-as-lab", (c) => {
      c.repos.target.guard = "lab";
      c.repos.other = { ...c.repos.faultforge, github: "AJBeumer/other-app", guard: "reviewed" };
    });
    const command = 'gh pr comment 1 --repo AJBeumer/faultforge-target --body "FaultForge"';
    expect(decide("Bash", { command }, HARNESS, config)).toMatch(/names the lab/);
  });

  it("protects a reviewed checkout whose folder name differs from its GitHub name", () => {
    const config = configWith("other-folder", (c) => {
      c.repos.other = { ...c.repos.target, github: "AJBeumer/other-app", path: "../checkout-two" };
    });
    expect(
      decide("Edit", { file_path: "D:/Projects/checkout-two/README.md", new_string: "planted here" }, HARNESS, config),
    ).toMatch(/other-app/);
    expect(
      decide("Bash", { command: 'git commit -m "Fix planted bug"' }, "D:\\Projects\\checkout-two", config),
    ).toMatch(/planted/);
  });

  it("blocks one reviewed repo from linking to another", () => {
    const command = 'gh issue create --repo AJBeumer/faultforge-target --title "x" --body "see other-app#2"';
    expect(decide("Bash", { command }, HARNESS, withThirdRepo())).toMatch(/link/);
  });

  it("checks where a post goes, not which folder it's sent from (two repos)", () => {
    const command = 'gh issue create --repo AJBeumer/faultforge --title "x" --body "see faultforge-target#3"';
    expect(decide("Bash", { command }, TARGET)).toMatch(/link to the target/);
  });

  it("checks where a post goes, not which folder it's sent from (Qodo's third-repo case)", () => {
    const command = 'gh issue create --repo AJBeumer/other-app --title "x" --body "see faultforge-target#3"';
    expect(decide("Bash", { command }, TARGET, withThirdRepo())).toMatch(/link to the target/);
  });

  it("still blocks a target force push chained after a command for this repo (Qodo, 2e15454)", () => {
    const command =
      "gh issue list --repo AJBeumer/faultforge; git push --force https://github.com/AJBeumer/faultforge-target.git main";
    expect(bash(command)).toMatch(/Force pushes|separate commands/);
  });

  it("still blocks a target force push via cd, chained after a post here", () => {
    const command =
      'gh issue comment 5 --repo AJBeumer/faultforge --body "x"; cd /d/Projects/faultforge-target && git push --force origin main';
    expect(bash(command)).toMatch(/Force pushes|separate commands/);
  });

  it("isn't fooled by --repo written inside a quoted body (Qodo, 2e15454)", () => {
    const command = 'gh pr create --body "--repo evil/repo FaultForge" --repo AJBeumer/faultforge-target --title "x"';
    expect(bash(command)).toMatch(/names the lab/);
  });

  it("blocks a chained command that writes across repos, from the target checkout (Qodo, 77c1f44)", () => {
    expect(bash("gh issue list --repo AJBeumer/faultforge; git push --force origin main", TARGET)).toMatch(
      /separate commands/,
    );
    expect(bash('gh issue list --repo AJBeumer/faultforge; git commit -m "Fix planted bug"', TARGET)).toMatch(
      /separate commands/,
    );
  });

  it("checks a lab commit whose message fakes a target --repo (Qodo, 77c1f44)", () => {
    expect(bash('git commit -m "Note --repo AJBeumer/faultforge-target see faultforge-target#6"')).toMatch(
      /link to the target/,
    );
  });

  it("treats a single & as a second command (Qodo, ae9c1de)", () => {
    const command =
      'gh issue create --repo AJBeumer/faultforge --title "x" --body "a" & gh issue create --repo AJBeumer/faultforge-target --title "y" --body "b"';
    expect(bash(command)).toMatch(/separate commands/);
  });

  it("sees commands hidden in a quoted $(...) (Qodo, ae9c1de)", () => {
    const command =
      'echo "$(gh issue create --repo AJBeumer/faultforge --title x --body a; gh issue create --repo AJBeumer/faultforge-target --title y --body b)"';
    expect(bash(command)).toMatch(/separate commands/);
  });

  it("lets a target PR link its own ticket when run from the target checkout, as /work-ticket now does", () => {
    const command =
      'cd /d/Projects/faultforge-target && gh pr create --repo AJBeumer/faultforge-target --title "Add a cancel route" --body "Ticket: https://github.com/AJBeumer/faultforge-target/issues/3"';
    expect(bash(command)).toBeUndefined();
  });

  it("allows a chained command that stays inside the target checkout", () => {
    expect(
      bash(
        'cd /d/Projects/faultforge-target && git add -A && git commit -m "Add a cancel route" && git push -q -u origin cancel',
      ),
    ).toBeUndefined();
  });

  it("allows a target PR whose heredoc body has several lines", () => {
    expect(
      bash(
        'gh pr create --repo AJBeumer/faultforge-target --title "Add a cancel route" --body-file - <<EOF\nCloses #3\n\nAdds cancel.\nEOF',
      ),
    ).toBeUndefined();
  });

  it("treats a post to this repo as a post here, even when sent from the target folder", () => {
    const command = 'gh issue create --repo AJBeumer/faultforge --title "FaultForge note" --body "x"';
    expect(decide("Bash", { command }, TARGET)).toBeUndefined();
  });

  it("doesn't let a reviewed repo's name hide a forbidden word", () => {
    const config = configWith("named-ledger", (c) => {
      c.repos.other = { ...c.repos.target, github: "AJBeumer/ledger", path: "../ledger" };
    });
    const command = 'gh pr create --repo AJBeumer/faultforge-target --title "Update ledger" --body "x"';
    expect(decide("Bash", { command }, HARNESS, config)).toMatch(/ledger/);
  });

  it("falls back to protecting the target if factory.json can't be read", () => {
    const command = 'gh pr comment 1 --repo AJBeumer/faultforge-target --body "FaultForge"';
    expect(decide("Bash", { command }, HARNESS, join(tmpdir(), "no-such-factory.json"))).toMatch(/names the lab/);
  });
});

describe("guard-target hook fails closed (#104)", () => {
  /** Runs the hook with raw stdin text and returns how it exited and what it wrote. */
  function raw(stdin: string) {
    const result = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", env: process.env });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }

  it("blocks with exit 2 and a one-line reason when its input is empty", () => {
    const { status, stdout, stderr } = raw("");
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^guard-target hook failed: .+/);
    expect(stderr.split("\n")).toHaveLength(1);
  });

  it("blocks with exit 2 when its input is not JSON", () => {
    const { status, stderr } = raw("not json");
    expect(status).toBe(2);
    expect(stderr).toMatch(/guard-target hook failed/);
  });

  it("blocks a reviewed-repo post whose body file exists but can't be read (a folder)", () => {
    // The folder exists, so the guard tries to read it as the body, and must refuse rather than skip it.
    const command = `gh pr create --repo AJBeumer/faultforge-target --title "Tidy" --body-file "${tmpdir()}"`;
    const { status, stderr } = raw(JSON.stringify({ tool_name: "Bash", cwd: HARNESS, tool_input: { command } }));
    expect(status).toBe(2);
    expect(stderr).toMatch(/EISDIR/);
  });

  it("denies a post whose body file does not exist, since it can't check what would be posted", () => {
    const missing = join(tmpdir(), "no-such-body-file.md");
    expect(bash(`gh pr create --repo AJBeumer/faultforge-target --title "Tidy" --body-file "${missing}"`)).toMatch(
      /doesn't exist/,
    );
    expect(bash(`git commit -F ${missing}`, TARGET)).toMatch(/doesn't exist/);
    // The file name ends at the shell separator, so the reason names the file, not "file;".
    expect(bash(`git commit -F ${missing}; echo done`, TARGET)).toMatch(/no-such-body-file\.md, which doesn't exist/);
    expect(bash(`gh pr create --repo AJBeumer/faultforge --title "Tidy" --body-file ${missing}`)).toMatch(
      /doesn't exist/,
    );
  });

  it("reads a gh api field's @file, and treats a plain field value as text, not a file", () => {
    const route = "gh api repos/AJBeumer/faultforge-target/issues/1/comments";
    expect(bash(`${route} -F body=@${join(tmpdir(), "no-such-body-file.md")}`)).toMatch(/doesn't exist/);
    expect(bash(`${route} -F body=Thanks`)).toBeUndefined();
    expect(bash(`${route} -F body="The planted bug"`)).toMatch(/says planted/);
  });

  it("reads a file whose name looks like a field, such as message=hidden.txt (Qodo on PR 115)", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    writeFileSync(join(dir, "message=hidden.txt"), "The planted bug is here\n");
    expect(bash("git -C /d/Projects/faultforge-target commit -F message=hidden.txt", dir)).toMatch(/says planted/);
    expect(bash("gh api repos/AJBeumer/faultforge-target/issues/1/comments -F message=hidden.txt", dir)).toMatch(
      /says planted/,
    );
  });

  it("lets a message mention a file flag as words: only a real flag names a file (Qodo on PR 115)", () => {
    expect(bash('git commit -m "Document --body-file usage"')).toBeUndefined();
    expect(bash('git commit -m "Document the --body-file usage"', TARGET)).toBeUndefined();
    expect(
      bash(
        "gh pr create --repo AJBeumer/faultforge --title T --body-file - <<'EOF'\nPass text with --body-file notes\nEOF",
      ),
    ).toBeUndefined();
  });

  it("reads a real file even when fake quoting surrounds the flag (Qodo on PR 115, round 3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    writeFileSync(join(dir, "secret.txt"), "The planted bug is here\n");
    const commit = "git -C /d/Projects/faultforge-target commit -F secret.txt";
    // A heredoc-looking marker in a comment, with a real heredoc later, must not hide the commit between them.
    expect(bash(`# <<FAKE\n${commit}\ncat <<FAKE\nx\nFAKE`, dir)).toMatch(/says planted/);
    // An escaped quote must not open a quoted span that swallows the real -F option.
    expect(bash(`printf \\"; ${commit}; printf "ok"`, dir)).toMatch(/says planted/);
  });

  it("still allows and denies as before once the input is well-formed", () => {
    expect(bash("npm run check")).toBeUndefined();
    expect(bash('git commit -m "Fix the planted bug"', TARGET)).toMatch(/says planted/);
  });
});

describe("guard-target hook sees every way into the reviewed repo (#105)", () => {
  const powershell = (command: string, cwd = HARNESS) => decide("PowerShell", { command }, cwd);

  describe("ways of moving into the checkout", () => {
    it.each([
      ["Set-Location", 'Set-Location ../faultforge-target; git commit -m "Fix the planted bug"'],
      ["Set-Location -Path", "Set-Location -Path ../faultforge-target; git commit -m 'Fix the planted bug'"],
      ["pushd", 'pushd /d/Projects/faultforge-target && git commit -m "Fix the planted bug"'],
      ["git --work-tree", 'git --work-tree=/d/Projects/faultforge-target commit -m "Fix the planted bug"'],
      ["git -C with no space", "git -C/d/Projects/faultforge-target commit -m 'Fix the planted bug'"],
      ["git -C with a quoted Windows path", 'git -C "D:\\Projects\\faultforge-target" commit -m "Fix the planted bug"'],
      ["cd with a quoted Windows path", 'cd "D:\\Projects\\faultforge-target"; git commit -m "Fix the planted bug"'],
    ])("blocks a telltale commit after %s", (_name, command) => {
      expect(powershell(command)).toMatch(/says planted/);
    });

    it("still blocks a force push reached through pushd", () => {
      expect(bash("pushd ../faultforge-target && git push --force origin main")).toMatch(/Force pushes/);
    });

    it("sees the checkout when a shell operator follows it with no space (a gap the Set-Location case found)", () => {
      expect(bash('cd ../faultforge-target;git commit -m "Fix the planted bug"')).toMatch(/says planted/);
      expect(bash('cd ../faultforge-target&&git commit -m "Fix the planted bug"')).toMatch(/says planted/);
    });

    it("gives the own-ticket link exemption only to a real move, not to one quoted in a message (Qodo on PR 120)", () => {
      const quoted = "git commit -m 'Set-Location /d/Projects/faultforge-target; see faultforge-target#6'";
      expect(bash(quoted)).toMatch(/link to the target/);
      expect(
        bash('cd ../faultforge-target && gh pr create --title "Tidy" --body "Ticket: faultforge-target#6"'),
      ).toBeUndefined();
    });
  });

  describe("content about to travel, read from git whatever the command text says", () => {
    /** A fixture repo named as a second reviewed repo, `other-app`; the folder's own name is what the guard looks for. */
    function reviewedRepo(withOrigin = false) {
      const { dir, git } = tempRepo(withOrigin);
      const config = configWithTarget(TARGET_FIXTURE, (c) => {
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
      expect(decide("Bash", { command: 'git add . && git commit -m "Tidy"' }, dir, config)).toMatch(
        /contains a case id/,
      );
    });

    it("lets a harmless change be committed, and ignores pending content when nothing is committed or pushed", () => {
      const { dir, git, config } = reviewedRepo();
      writeFileSync(join(dir, "README.md"), "# App\n\nRelease notes.\n");
      git("add", "README.md");
      expect(decide("Bash", { command: 'git commit -m "Add release notes"' }, dir, config)).toBeUndefined();
      writeFileSync(join(dir, "scratch.md"), "planted\n");
      expect(decide("Bash", { command: "npm run check" }, dir, config)).toBeUndefined();
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
        expect(
          decide("Bash", { command: 'echo "x" > notes.md; git add . && git commit -m Tidy' }, dir, config),
        ).toMatch(/on its own/);
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
        const config = configWithTarget(TARGET_FIXTURE, (c) => {
          c.repos.other = { ...c.repos.target, github: "AJBeumer/other-app", path: missing };
        });
        expect(decide("Bash", { command: `git -C ${missing} commit -m Tidy` }, HARNESS, config)).toMatch(/can't find/);
        // A commit elsewhere is not held up by a reviewed checkout that isn't there.
        expect(decide("Bash", { command: "git commit -m Tidy" }, HARNESS, config)).toBeUndefined();
      });
    });
  });
});
