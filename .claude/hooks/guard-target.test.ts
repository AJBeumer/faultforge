/**
 * The guard's decisions as read from the command text and the payload. The decisions that read a reviewed
 * checkout's pending content from git fixtures are in guard-target.pending.test.ts (#121).
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FACTORY, guardConfig, guardDecision, tempRepo } from "./fixtures.ts";
import { guardBudget, decide as guardDecide } from "./guard-target.ts";

const HOOK = join(import.meta.dirname, "guard-target.ts");
const HARNESS = "D:\\Projects\\FaultForge";
const TARGET = "D:\\Projects\\faultforge-target";

// Every test runs the hook against this fixture as the target's checkout, not the owner's real one. It has
// an origin so nothing in it counts as unpushed, which keeps the push scan to one git call per test.
const TARGET_FIXTURE = tempRepo(true).dir;
const DEFAULT_CONFIG = guardConfig(TARGET_FIXTURE);

/** The deny reason for one tool call, or undefined if allowed; see guardDecision. */
const decide = (tool: string, toolInput: object, cwd = HARNESS, config = DEFAULT_CONFIG) =>
  guardDecision(tool, toolInput, cwd, config);

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

    it("refuses a posted file too large to read within the hook's time (Qodo on PR 233)", () => {
      const file = join(mkdtempSync(join(tmpdir(), "big-body-")), "body.md");
      writeFileSync(file, "ordinary text\n".repeat(80_000)); // over 1 MiB
      expect(bash(`gh issue create --repo AJBeumer/faultforge --title "x" --body-file "${file}"`)).toMatch(
        /more than the guard reads/,
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
  /**
   * The fixture config plus a third reviewed repo, added as one entry. Its checkout is a folder under the temp
   * folder that is never created: the guard skips a checkout it can't find, and never looks beside the lab.
   */
  function withThirdRepo(): string {
    const checkout = join(mkdtempSync(join(tmpdir(), "guard-third-")), "other-app");
    return guardConfig(TARGET_FIXTURE, (c) => {
      c.repos.other = { ...c.repos.target, github: "AJBeumer/other-app", path: checkout };
    });
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

  /** The fixture config changed by `edit`, written to its own temp file: never the owner's checkouts. */
  function configWith(edit: (config: typeof FACTORY) => void): string {
    return guardConfig(TARGET_FIXTURE, edit);
  }

  it("keeps protecting the target when the config wrongly marks it as lab", () => {
    const config = configWith((c) => {
      c.repos.target.guard = "lab";
      c.repos.other = { ...c.repos.faultforge, github: "AJBeumer/other-app", guard: "reviewed" };
    });
    const command = 'gh pr comment 1 --repo AJBeumer/faultforge-target --body "FaultForge"';
    expect(decide("Bash", { command }, HARNESS, config)).toMatch(/names the lab/);
  });

  it("protects a reviewed checkout whose folder name differs from its GitHub name", () => {
    const config = configWith((c) => {
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
    const config = configWith((c) => {
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
  /** The decision for raw payload text, with the fixture config. */
  const rawDecision = (stdin: string) => guardDecide(stdin, { ...process.env, FAULTFORGE_CONFIG: DEFAULT_CONFIG });

  it("answers a blocking error, with a one-line reason, when its input is empty", () => {
    const decision = rawDecision("");
    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") return;
    expect(decision.message).toMatch(/^guard-target hook failed: .+/);
    expect(decision.message.split("\n")).toHaveLength(1);
  });

  it("answers a blocking error when its input is not JSON", () => {
    expect(rawDecision("not json")).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/guard-target hook failed/),
    });
  });

  it("blocks a reviewed-repo post whose body file exists but can't be read (a folder)", () => {
    // The folder exists, so the guard tries to read it as the body, and must refuse rather than skip it.
    const command = `gh pr create --repo AJBeumer/faultforge-target --title "Tidy" --body-file "${tmpdir()}"`;
    const decision = rawDecision(JSON.stringify({ tool_name: "Bash", cwd: HARNESS, tool_input: { command } }));
    expect(decision).toMatchObject({ kind: "error", message: expect.stringMatching(/EISDIR/) });
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
    // The comment is now read as a comment (AUD-M4), so the `cat` step after the commit is refused first.
    expect(bash(`# <<FAKE\n${commit}\ncat <<FAKE\nx\nFAKE`, dir)).toMatch(/says planted|must run on its own/);
    expect(bash(`# <<FAKE\n${commit}\necho <<FAKE\nx\nFAKE`, dir)).toMatch(/says planted/);
    // An escaped quote must not open a quoted span that swallows the real -F option.
    // With the escape read right, the `printf` steps are refused before the file is read (AUD-M4).
    expect(bash(`printf \\"; ${commit}; printf "ok"`, dir)).toMatch(/says planted|must run on its own/);
    expect(bash(`echo \\"; ${commit}; echo "ok"`, dir)).toMatch(/says planted/);
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
});

describe("guard-target hook checks every gh command that posts text to the target (#190)", () => {
  const R = "--repo AJBeumer/faultforge-target";
  it.each([
    [`gh pr merge 5 ${R} --squash --body "planted bug closed"`, /says planted/],
    [`gh pr merge 5 ${R} --merge --subject "Merge the planted change"`, /says planted/],
    [`gh label create planted-bug ${R}`, /says planted/],
    [`gh label create tidy ${R} --description "the ledger"`, /ledger/],
    [`gh release create v1 ${R} --notes "planted bug"`, /says planted/],
    // `-R` is the short form of `--repo`, from anywhere (Qodo on PR 208).
    ["gh label create planted-bug -R AJBeumer/faultforge-target", /says planted/],
    ['gh pr create -RAJBeumer/faultforge-target --title Tidy --body "planted bug"', /says planted/],
    ['gh pr merge 5 -R AJBeumer/faultforge-target --body "planted"', /says planted/],
  ])("refuses %s", (command, reason) => {
    expect(bash(command)).toMatch(reason);
  });

  it("doesn't read a lower-case -r in a message as a repo flag (Qodo on PR 208)", () => {
    expect(bash('git commit -m "planted bug: grep -r src/app"', TARGET)).toMatch(/says planted/);
  });

  it("counts a repo named anywhere, so a fake heredoc in a message can't hide the real --repo (Qodo on PR 208)", () => {
    const command = 'gh pr create --body "planted bug <<EOF\nordinary text" --repo AJBeumer/faultforge-target';
    expect(bash(command)).toMatch(/says planted/);
  });

  it("reads no destination from inside posted text, so a post from the target is still judged (Qodo on PR 208)", () => {
    expect(bash('gh pr create --title Tidy --body "planted bug: grep -R src/app"', TARGET)).toMatch(/says planted/);
    expect(bash('gh pr create --title Tidy --body "planted; see --repo other/app"', TARGET)).toMatch(/says planted/);
    expect(bash("gh pr create --title Tidy --body-file - <<EOF\nplanted --repo other/app\nEOF", TARGET)).toMatch(
      /says planted/,
    );
  });

  it("reads release notes from a file, as it reads a body file (Qodo on PR 208)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "guard-notes-")), "notes.md").replace(/\\/g, "/");
    writeFileSync(file, "Fixes the planted bug\n");
    expect(bash(`gh release create v2 ${R} --notes-file ${file}`)).toMatch(/says planted/);
    writeFileSync(file, "Filter bookings by status\n");
    expect(bash(`gh release create v2 ${R} --notes-file ${file}`)).toBeUndefined();
  });

  it("refuses a merge of a lab PR whose body links the target, as it refuses a new PR's", () => {
    expect(bash('gh pr merge 9 --squash --body "see https://github.com/AJBeumer/faultforge-target/pull/3"')).toMatch(
      /link to the target/,
    );
  });

  it("still allows ordinary merges, labels and releases on the target", () => {
    expect(bash(`gh pr merge 5 ${R} --squash`)).toBeUndefined();
    expect(bash(`gh label create bug ${R} --description "Something is broken"`)).toBeUndefined();
    expect(bash(`gh release create v1.1 ${R} --notes "Filter bookings by status"`)).toBeUndefined();
  });
});

describe("guard-target hook reads posted text as written: a repo name next to a slash hides nothing", () => {
  const TO_TARGET = 'gh pr create --repo AJBeumer/faultforge-target --title "Fix rounding"';

  it("blocks a target PR whose body links a lab ticket", () => {
    expect(bash(`${TO_TARGET} --body "Follow-up to https://github.com/AJBeumer/faultforge/issues/12"`)).toMatch(
      /names the lab/,
    );
    expect(bash(`${TO_TARGET} --body "See AJBeumer/faultforge#12"`)).toMatch(/names the lab/);
  });

  it("blocks a comment made from inside the target checkout that links a lab ticket", () => {
    const command = 'gh issue comment 3 --body "tracked in https://github.com/AJBeumer/faultforge/issues/12"';
    expect(bash(command, TARGET)).toMatch(/names the lab/);
  });

  it.each([
    ["upper case", "see HTTPS://GITHUB.COM/AJBEUMER/FAULTFORGE/ISSUES/12"],
    ["www", "see https://www.github.com/AJBeumer/FaultForge"],
    ["an SSH remote", "clone git@github.com:AJBeumer/faultforge.git"],
    ["owner/name with no number", "used by AJBeumer/faultforge"],
    ["a path with no host", "see faultforge/issues/12"],
    ["a markdown link", "[ticket](https://github.com/AJBeumer/faultforge/issues/12)"],
    ["a local path", "the harness lives in ../FaultForge/packages/harness"],
  ])("blocks the lab named in a target PR body as %s", (_name, body) => {
    expect(bash(`${TO_TARGET} --body "${body}"`)).toMatch(/names the lab/);
  });

  it.each([
    ["see faultforge/planted bug", /says planted/],
    ["sabotage/faultforge-target run", /says sabotage/],
    ["the faultforge-target/ledger folder", /ledger/],
    ["see FF-0002/faultforge", /case id/],
  ])("blocks a forbidden word joined to a repo name by a slash: %s", (body, reason) => {
    expect(bash(`${TO_TARGET} --body "${body}"`)).toMatch(reason);
  });

  it("blocks the same link in a title, an API field, a heredoc body, a piped body and a commit message", () => {
    const link = "https://github.com/AJBeumer/faultforge/issues/12";
    expect(bash(`gh issue create --repo AJBeumer/faultforge-target --title "Follow ${link}" --body "x"`)).toMatch(
      /names the lab/,
    );
    expect(bash(`gh api repos/AJBeumer/faultforge-target/issues/1/comments -f body="see ${link}"`)).toMatch(
      /names the lab/,
    );
    expect(bash(`${TO_TARGET} --body-file - <<EOF\nFollow-up to ${link}\nEOF`)).toMatch(/names the lab/);
    expect(bash(`echo "see AJBeumer/faultforge#12" | ${TO_TARGET} --body-file -`)).toMatch(/names the lab/);
    expect(bash(`git commit -m "Follow-up to ${link}"`, TARGET)).toMatch(/names the lab/);
    expect(bash('git -C D:/Projects/faultforge-target commit -m "Refs AJBeumer/faultforge#12"')).toMatch(
      /names the lab/,
    );
  });

  it("blocks a file edit in the target that links the lab", () => {
    const file_path = "D:/Projects/faultforge-target/README.md";
    expect(decide("Write", { file_path, content: "See https://github.com/AJBeumer/faultforge" })).toMatch(
      /names the lab/,
    );
    expect(decide("Edit", { file_path, new_string: "Exercised by AJBeumer/faultforge" })).toMatch(/names the lab/);
  });

  it("doesn't count the folder a piped or substituted body comes from as posted text", () => {
    // A piped file is read now (AUD-M3), so it must exist; its folder still isn't posted text.
    const folder = join(mkdtempSync(join(tmpdir(), "guard-pipe-")), "FaultForge", "private");
    mkdirSync(folder, { recursive: true });
    const piped = join(folder, "body.md").replace(/\\/g, "/");
    writeFileSync(piped, "Small cleanup.\n");
    expect(bash(`cat ${piped} | ${TO_TARGET} --body-file -`)).toBeUndefined();
    expect(bash(`${TO_TARGET} --body "$(cat ../FaultForge/notes/body.md)"`)).toBeUndefined();
    expect(bash(`echo "see AJBeumer/faultforge#12" | ${TO_TARGET} --body-file -`)).toMatch(/names the lab/);
    expect(bash(`${TO_TARGET} --body "$(cat $HOME/FaultForge/notes/body.md)"`)).toBeUndefined();
    expect(bash(`${TO_TARGET} --body "$(cat %USERPROFILE%\\FaultForge\\body.md)"`)).toBeUndefined();
  });

  it("doesn't count a heredoc that another command reads as posted text", () => {
    expect(bash(`${TO_TARGET} --body "Tidy"; cat <<EOF\nAJBeumer/faultforge\nEOF`)).toBeUndefined();
    expect(bash(`${TO_TARGET} --body "Tidy"; cat <<EOF\n--body "../FaultForge"\nEOF`)).toBeUndefined();
  });

  it("still reads a path-shaped message that is piped in", () => {
    expect(bash(`echo "/FaultForge/planted" | ${TO_TARGET} --body-file -`)).toMatch(/names the lab|says planted/);
  });

  it("reads a heredoc body to its real end: a line with the delimiter after spaces is still body", () => {
    const body = "Tidy\n  EOF\n../FaultForge/planted\nEOF";
    expect(bash(`${TO_TARGET} --body-file - <<EOF\n${body}`)).toMatch(/names the lab|says planted/);
    // The delimiter is the whole word: `EOF` alone doesn't end a body opened with `<<EOF-`.
    const dashed = "Tidy\nEOF\n../FaultForge/planted\nEOF-";
    expect(bash(`${TO_TARGET} --body-file - <<EOF-\n${dashed}`)).toMatch(/names the lab|says planted/);
    // A piped body is read even when a heredoc follows it in the same command.
    const piped = `echo 'see ../FaultForge/planted' | ${TO_TARGET} --body-file -; cat <<EOF\nx\nEOF`;
    expect(bash(piped)).toMatch(/names the lab|says planted/);
    // Two heredocs on one line, a fake opener in a quoted argument, and a quote inside a quoted delimiter:
    // whatever the shell reads as the posted body, the text from the first `<<` on is judged too.
    const two = `${TO_TARGET} --body-file - <<A <<B\nTidy\nA\n../FaultForge/planted\nB`;
    expect(bash(two)).toMatch(/names the lab|says planted/);
    const fake = `gh pr create --repo AJBeumer/faultforge-target --title "a <<FAKE b" --body-file - <<EOF\n../FaultForge/x\nEOF`;
    expect(bash(fake)).toMatch(/names the lab/);
    const quoted = `${TO_TARGET} --body-file - <<'E"OF'\nTidy\nEOF\nhttps://github.com/AJBeumer/faultforge/issues/1\nE"OF`;
    expect(bash(quoted)).toMatch(/names the lab/);
    // Quoting inside the delimiter is removed, as the shell does: `EO\F-` means `EOF-`, so a body line
    // spelled `EO\F-` is text, not the end.
    const escaped = "Tidy\nEO\\F-\nfaultforge/planted\nEOF-";
    expect(bash(`${TO_TARGET} --body-file - <<EO\\F-\n${escaped}`)).toMatch(/names the lab|says planted/);
  });

  it("reads the title of a post whose body is piped in, even when it looks like a redirect", () => {
    const command = `echo Tidy | gh pr create --repo AJBeumer/faultforge-target --body-file - --title "See <faultforge-target/planted"`;
    expect(bash(command)).toMatch(/says planted/);
  });

  it("joins the message parts of every commit in a chain, combined short flags included", () => {
    expect(bash('git commit -m "Tidy" && git commit --allow-empty -m "injected" -m "bug"', TARGET)).toMatch(
      /says a bug was injected/,
    );
    expect(bash('git commit -am "injected" -m "bug"', TARGET)).toMatch(/says a bug was injected/);
  });

  it("joins only the commit's own message parts, not text an earlier command posts", () => {
    const chain = 'gh issue comment 3 --body "Tidy the injected" && git commit -m "bug report"';
    expect(bash(chain, TARGET)).toBeUndefined();
  });

  it("judges the message parts git joins into one commit message together", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-commit-parts-"));
    const first = join(dir, "one.txt").replace(/\\/g, "/");
    const second = join(dir, "two.txt").replace(/\\/g, "/");
    writeFileSync(first, "Tidy the injected\n");
    writeFileSync(second, "bug report\n");
    expect(bash(`git commit -F ${first} -F ${second}`, TARGET)).toMatch(/says a bug was injected/);
    expect(bash('git commit -m "Tidy the injected" -m "bug report"', TARGET)).toMatch(/says a bug was injected/);
  });

  it("judges each posted field on its own, so words from two clean fields never join into a forbidden phrase", () => {
    expect(bash(`${TO_TARGET.replace('"Fix rounding"', '"Update proof"')} --body "Tests now pass."`)).toBeUndefined();
    expect(bash(`${TO_TARGET} --body "A planted bug"`)).toMatch(/says planted/);
  });

  it("still allows the lab's and the target's names where the command needs them: paths, --repo and remotes", () => {
    const lab = join(mkdtempSync(join(tmpdir(), "guard-lab-")), "FaultForge", "private");
    mkdirSync(lab, { recursive: true });
    const body = join(lab, "body.md").replace(/\\/g, "/");
    writeFileSync(body, "Small cleanup.\n");
    const ownTicket =
      '--title "Add a cancel route" --body "Ticket: https://github.com/AJBeumer/faultforge-target/issues/3"';
    expect(bash(`gh pr create --repo AJBeumer/faultforge-target --title "Tidy" --body-file ${body}`)).toBeUndefined();
    expect(bash(`gh pr create --repo AJBeumer/faultforge-target ${ownTicket}`, TARGET)).toBeUndefined();
    expect(bash(`gh pr create ${ownTicket.replace("https://github.com/", "")}`, TARGET)).toBeUndefined();
    expect(bash("git push https://github.com/AJBeumer/faultforge-target.git HEAD")).toBeUndefined();
    expect(bash("git push git@github.com:AJBeumer/faultforge-target.git HEAD")).toBeUndefined();
    expect(bash("cd D:/Projects/FaultForge/../faultforge-target && git status")).toBeUndefined();
    expect(
      bash('cd D:/Projects/FaultForge/../faultforge-target && git commit -m "Shorten README intro"'),
    ).toBeUndefined();
    expect(bash('git --git-dir=D:/Projects/FaultForge/../faultforge-target/.git commit -m "Tidy"')).toBeUndefined();
    expect(
      bash(
        'cd D:/Projects/FaultForge/../faultforge-target && gh pr create --title "Tidy" --body-file - <<EOF\nCloses #3\nEOF',
      ),
    ).toBeUndefined();
  });
});

describe("guard-target hook as a process (node <file>), the way Claude Code runs it", () => {
  /** Runs the hook file with raw stdin text and returns how it exited and what it wrote. */
  function raw(stdin: string) {
    const result = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, FAULTFORGE_CONFIG: DEFAULT_CONFIG },
    });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  const payload = (tool: string, toolInput: object, cwd: string) =>
    JSON.stringify({ tool_name: tool, cwd, tool_input: toolInput });

  it("as a process: a deny is a PreToolUse decision on stdout with exit 0", () => {
    const telltale = payload("Bash", { command: 'git commit -m "Fix the planted bug"' }, TARGET);
    const { status, stdout, stderr } = raw(telltale);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    const decision = JSON.parse(stdout).hookSpecificOutput;
    expect(decision.hookEventName).toBe("PreToolUse");
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toMatch(/says planted/);
  });

  it("as a process: an allow prints nothing and exits 0", () => {
    const { status, stdout, stderr } = raw(payload("Bash", { command: "npm run check" }, HARNESS));
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("as a process: a blocking error is exit 2 with one line on stderr and nothing on stdout", () => {
    const { status, stdout, stderr } = raw("not json");
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^guard-target hook failed: .+/);
    expect(stderr.split("\n")).toHaveLength(1);
  });

  it("as a process: a stdin it can't read is a blocking error too, not a crash (Qodo on PR 131)", () => {
    const folder = openSync(tmpdir(), "r"); // reading a folder fails with EISDIR
    const result = spawnSync(process.execPath, [HOOK], {
      stdio: [folder, "pipe", "pipe"],
      encoding: "utf8",
      env: { ...process.env, FAULTFORGE_CONFIG: DEFAULT_CONFIG },
    });
    closeSync(folder);
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr.trim()).toMatch(/^guard-target hook failed: EISDIR/);
  });
});

describe("guardBudget (Qodo on PR 233)", () => {
  it("may shorten the decision's budget, never lengthen it past the default", () => {
    expect(guardBudget({})).toBe(8000);
    expect(guardBudget({ FAULTFORGE_GUARD_BUDGET_MS: "60000" })).toBe(8000);
    expect(guardBudget({ FAULTFORGE_GUARD_BUDGET_MS: "500" })).toBe(500);
    expect(guardBudget({ FAULTFORGE_GUARD_BUDGET_MS: "not a number" })).toBe(8000);
  });
});
