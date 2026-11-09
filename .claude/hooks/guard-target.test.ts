import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOOK = join(import.meta.dirname, "guard-target.ts");
const HARNESS = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";

/** Runs the hook with a payload and returns the deny reason, or undefined if allowed. */
function decide(tool: string, toolInput: object, cwd = HARNESS, config?: string): string | undefined {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: toolInput }),
    encoding: "utf8",
    env: config ? { ...process.env, FAULTFORGE_CONFIG: config } : process.env,
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

  it("still allows and denies as before once the input is well-formed", () => {
    expect(bash("npm run check")).toBeUndefined();
    expect(bash('git commit -m "Fix the planted bug"', TARGET)).toMatch(/says planted/);
  });
});
