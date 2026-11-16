/**
 * The guard's decisions as read from the command text and the payload. The decisions that read a reviewed
 * checkout's pending content from git fixtures are in guard-target-git-content.test.ts.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
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
/** The door rule: every write to a reviewed repo goes through npm run target:post. */
const DOOR = /go only through the door/;

/** The deny reason for one tool call, or undefined if allowed; see guardDecision. */
const decide = (tool: string, toolInput: object, cwd = HARNESS, config = DEFAULT_CONFIG) =>
  guardDecision(tool, toolInput, cwd, config);

const bash = (command: string, cwd?: string) => decide("Bash", { command }, cwd);
/** A push to a reviewed repo from another folder: refused before its flags are read. */
const ELSEWHERE_PUSH = /Force pushes|only from its own checkout/;

describe("guard-target hook", () => {
  describe("blocks", () => {
    it("a force push to the target", () => {
      expect(bash("cd /d/Projects/faultforge-target && git push --force origin main")).toMatch(DOOR);
    });

    it("a force push to the target by URL, from anywhere", () => {
      expect(bash("git push https://github.com/AJBeumer/faultforge-target.git +main")).toMatch(ELSEWHERE_PUSH);
      expect(bash("git push --force https://github.com/AJBeumer/faultforge-target.git main")).toMatch(ELSEWHERE_PUSH);
    });

    it("an edit to a target file that names the lab", () => {
      expect(
        decide("Edit", { file_path: "D:/Projects/faultforge-target/README.md", new_string: "Used by FaultForge" }),
      ).toMatch(/names the lab/);
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

    it("a command in this repo whose file edit happens to contain a target URL", () => {
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

    it("refuses a posted file too large to read within the hook's time", () => {
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
    expect(bash3('gh pr create --repo AJBeumer/other-app --title "x" --body "ok"')).toMatch(/Writes to other-app/);
    expect(bash3("git push --force https://github.com/AJBeumer/other-app.git main")).toMatch(
      /Writes to other-app|other-app only from its own checkout/,
    );
    expect(bash3('gh issue create --repo AJBeumer/faultforge --title "x" --body "see other-app#2"')).toMatch(
      /link to the target/,
    );
    expect(
      decide("Edit", { file_path: "D:/Projects/other-app/README.md", new_string: "planted here" }, HARNESS, config),
    ).toMatch(/other-app/);
  });

  it("still protects the target alongside the third repo", () => {
    const command = 'gh pr comment 1 --repo AJBeumer/faultforge-target --body "ok"';
    expect(decide("Bash", { command }, HARNESS, withThirdRepo())).toMatch(DOOR);
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
    const command = 'gh pr comment 1 --repo AJBeumer/faultforge-target --body "ok"';
    expect(decide("Bash", { command }, HARNESS, config)).toMatch(DOOR);
  });

  it("protects a reviewed checkout whose folder name differs from its GitHub name", () => {
    const config = configWith((c) => {
      c.repos.other = { ...c.repos.target, github: "AJBeumer/other-app", path: "../checkout-two" };
    });
    expect(
      decide("Edit", { file_path: "D:/Projects/checkout-two/README.md", new_string: "planted here" }, HARNESS, config),
    ).toMatch(/other-app/);
    expect(decide("Bash", { command: "git push origin main" }, "D:\\Projects\\checkout-two", config)).toMatch(
      /other-app/,
    );
  });

  it("checks where a post goes, not which folder it's sent from (two repos)", () => {
    const command = 'gh issue create --repo AJBeumer/faultforge --title "x" --body "see faultforge-target#3"';
    expect(decide("Bash", { command }, TARGET)).toMatch(/link to the target/);
  });

  it("still blocks a target force push chained after a command for this repo", () => {
    const command =
      "gh issue list --repo AJBeumer/faultforge; git push --force https://github.com/AJBeumer/faultforge-target.git main";
    expect(bash(command)).toMatch(/Force pushes|separate commands|only from its own checkout/);
  });

  it("still blocks a target force push via cd, chained after a post here", () => {
    const command =
      'gh issue comment 5 --repo AJBeumer/faultforge --body "x"; cd /d/Projects/faultforge-target && git push --force origin main';
    expect(bash(command)).toMatch(/Force pushes|separate commands/);
  });

  it("blocks a chained command that writes across repos, from the target checkout", () => {
    expect(bash("gh issue list --repo AJBeumer/faultforge; git push --force origin main", TARGET)).toMatch(
      /separate commands/,
    );
    expect(bash('gh issue list --repo AJBeumer/faultforge; git commit -m "Fix planted bug"', TARGET)).toMatch(
      /separate commands/,
    );
  });

  it("checks a lab commit whose message fakes a target --repo", () => {
    expect(bash('git commit -m "Note --repo AJBeumer/faultforge-target see faultforge-target#6"')).toMatch(
      /link to the target/,
    );
  });

  it("treats a single & as a second command", () => {
    const command =
      'gh issue create --repo AJBeumer/faultforge --title "x" --body "a" & gh issue create --repo AJBeumer/faultforge-target --title "y" --body "b"';
    expect(bash(command)).toMatch(/separate commands/);
  });

  it("sees commands hidden in a quoted $(...)", () => {
    const command =
      'echo "$(gh issue create --repo AJBeumer/faultforge --title x --body a; gh issue create --repo AJBeumer/faultforge-target --title y --body b)"';
    expect(bash(command)).toMatch(/separate commands/);
  });

  it("allows a chained command that stays inside the target checkout", () => {
    expect(
      bash('cd /d/Projects/faultforge-target && git add -A && git commit -m "Add a cancel route"'),
    ).toBeUndefined();
  });

  it("treats a post to this repo as a post here, even when sent from the target folder", () => {
    const command = 'gh issue create --repo AJBeumer/faultforge --title "FaultForge note" --body "x"';
    expect(decide("Bash", { command }, TARGET)).toBeUndefined();
  });

  it("falls back to protecting the target if factory.json can't be read", () => {
    const command = 'gh pr comment 1 --repo AJBeumer/faultforge-target --body "ok"';
    expect(decide("Bash", { command }, HARNESS, join(tmpdir(), "no-such-factory.json"))).toMatch(DOOR);
  });
});

describe("guard-target hook fails closed", () => {
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

  it("denies a post whose body file does not exist, since it can't check what would be posted", () => {
    const missing = join(tmpdir(), "no-such-body-file.md");
    expect(bash(`git commit -F ${missing}`)).toMatch(/doesn't exist/);
    // The file name ends at the shell separator, so the reason names the file, not "file;".
    expect(bash(`git commit -F ${missing}; echo done`)).toMatch(/no-such-body-file\.md, which doesn't exist/);
    expect(bash(`gh pr create --repo AJBeumer/faultforge --title "Tidy" --body-file ${missing}`)).toMatch(
      /doesn't exist/,
    );
  });

  it("lets a message mention a file flag as words: only a real flag names a file", () => {
    expect(bash('git commit -m "Document --body-file usage"')).toBeUndefined();
    expect(bash('git commit -m "Document the --body-file usage"', TARGET)).toBeUndefined();
    expect(
      bash(
        "gh pr create --repo AJBeumer/faultforge --title T --body-file - <<'EOF'\nPass text with --body-file notes\nEOF",
      ),
    ).toBeUndefined();
  });

  it("allows and denies as usual once the input is well-formed", () => {
    expect(bash("npm run check")).toBeUndefined();
    expect(bash("git push origin main", TARGET)).toMatch(DOOR);
  });
});

describe("guard-target hook sees every way into the reviewed repo", () => {
  const powershell = (command: string, cwd = HARNESS) => decide("PowerShell", { command }, cwd);

  describe("ways of moving into the checkout", () => {
    it.each([
      ["Set-Location", "Set-Location ../faultforge-target; git push origin main"],
      ["Set-Location -Path", "Set-Location -Path ../faultforge-target; git push origin main"],
      ["pushd", "pushd /d/Projects/faultforge-target && git push origin main"],
      ["git --work-tree", "git --work-tree=/d/Projects/faultforge-target push origin main"],
      ["git -C with no space", "git -C/d/Projects/faultforge-target push origin main"],
      ["git -C with a quoted Windows path", 'git -C "D:\\Projects\\faultforge-target" push origin main'],
      ["cd with a quoted Windows path", 'cd "D:\\Projects\\faultforge-target"; git push origin main'],
    ])("refuses a raw push after %s", (_name, command) => {
      expect(powershell(command)).toMatch(DOOR);
    });

    it("still blocks a force push reached through pushd", () => {
      expect(bash("pushd ../faultforge-target && git push --force origin main")).toMatch(DOOR);
    });

    it("sees the checkout when a shell operator follows it with no space", () => {
      expect(bash("cd ../faultforge-target;git push origin main")).toMatch(DOOR);
      expect(bash("cd ../faultforge-target&&git push origin main")).toMatch(DOOR);
    });

    it("reads a move quoted in a lab commit's message as words, not as a move", () => {
      const quoted = "git commit -m 'Set-Location /d/Projects/faultforge-target; see faultforge-target#6'";
      expect(bash(quoted)).toMatch(/link to the target/);
      expect(
        bash('cd ../faultforge-target && gh pr create --title "Tidy" --body "Ticket: faultforge-target#6"'),
      ).toMatch(DOOR);
    });
  });
});

describe("guard-target hook keeps links one-way from a lab merge", () => {
  it("refuses a merge of a lab PR whose body links the target, as it refuses a new PR's", () => {
    expect(bash('gh pr merge 9 --squash --body "see https://github.com/AJBeumer/faultforge-target/pull/3"')).toMatch(
      /link to the target/,
    );
  });
});

describe("guard-target hook reads file edits in the target as written", () => {
  it("blocks a file edit in the target that links the lab", () => {
    const file_path = "D:/Projects/faultforge-target/README.md";
    expect(decide("Write", { file_path, content: "See https://github.com/AJBeumer/faultforge" })).toMatch(
      /names the lab/,
    );
    expect(decide("Edit", { file_path, new_string: "Exercised by AJBeumer/faultforge" })).toMatch(/names the lab/);
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
    const telltale = payload("Bash", { command: "git push origin main" }, TARGET);
    const { status, stdout, stderr } = raw(telltale);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    const decision = JSON.parse(stdout).hookSpecificOutput;
    expect(decision.hookEventName).toBe("PreToolUse");
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toMatch(DOOR);
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

  it("as a process: a stdin it can't read is a blocking error too, not a crash", () => {
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

describe("the guard's time budget", () => {
  it("may shorten the decision's budget, never lengthen it past the default", () => {
    expect(guardBudget({})).toBe(8000);
    expect(guardBudget({ FAULTFORGE_GUARD_BUDGET_MS: "60000" })).toBe(8000);
    expect(guardBudget({ FAULTFORGE_GUARD_BUDGET_MS: "500" })).toBe(500);
    expect(guardBudget({ FAULTFORGE_GUARD_BUDGET_MS: "not a number" })).toBe(8000);
  });
});
