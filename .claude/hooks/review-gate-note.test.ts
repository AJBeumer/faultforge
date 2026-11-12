import { describe, expect, it } from "vitest";
import {
  type Deps,
  decide,
  type GateRun,
  isOwnCommit,
  madeCommit,
  sameRepository,
  show,
  withoutText,
} from "./review-gate-note.ts";

const NL = String.fromCharCode(10);
const made = { stdout: `[main abc1234] a message${NL} 1 file changed` };
const payload = (command: string, tool = "Bash", response: unknown = made, cwd?: string) =>
  JSON.stringify({ tool_name: tool, tool_input: { command }, tool_response: response, cwd });
const notCovered: GateRun = {
  exitCode: 1,
  output: `Not covered: the tree of abc1234 (abc); no review recorded this tree.${NL}`,
};
const covered: GateRun = { exitCode: 0, output: "Covered: ..." };

/** Dependencies with a gate that gives `run`, and records what it was asked to check. */
function deps(run: GateRun | (() => GateRun), overrides: Partial<Deps> = {}) {
  const asked: string[] = [];
  const d: Deps = {
    run: (ref) => {
      asked.push(ref);
      return typeof run === "function" ? run() : run;
    },
    headAge: () => null,
    inProject: () => true,
    ...overrides,
  };
  return { d, asked };
}
const mustNotRun = (): GateRun => {
  throw new Error("the gate must not run here");
};

describe("isOwnCommit", () => {
  it("is true for a plain commit, a commit after an add, and settings before the verb", () => {
    expect(isOwnCommit('git commit -m "x"')).toBe(true);
    expect(isOwnCommit("git add a.txt && git commit -F msg.txt")).toBe(true);
    expect(isOwnCommit("git -c core.autocrlf=false commit -am x")).toBe(true);
  });

  it("is true with git's other global options before the verb", () => {
    expect(isOwnCommit("git --no-pager commit -m x")).toBe(true);
    expect(isOwnCommit("git -p commit -m x")).toBe(true);
    expect(isOwnCommit("git --no-pager -c core.editor=true commit -m x")).toBe(true);
  });

  it("is false for other git commands and for words that merely contain commit", () => {
    expect(isOwnCommit("git status")).toBe(false);
    expect(isOwnCommit("git log --oneline")).toBe(false);
    expect(isOwnCommit("echo committed")).toBe(false);
  });

  it("is false for a commit in another repository", () => {
    expect(isOwnCommit('git -C private commit -m "x"')).toBe(false);
    expect(isOwnCommit('cd ../faultforge-target && git commit -m "x"')).toBe(false);
    expect(isOwnCommit('git --work-tree=../x commit -m "x"')).toBe(false);
    expect(isOwnCommit('git --git-dir=../x/.git commit -m "x"')).toBe(false);
  });

  it("is true when the command only moves to the current folder", () => {
    expect(isOwnCommit('git -C . commit -m "x"')).toBe(true);
    expect(isOwnCommit('cd . && git commit -m "x"')).toBe(true);
  });

  it("is false for a dry run", () => {
    expect(isOwnCommit("git commit --dry-run")).toBe(false);
  });
});

describe("decide", () => {
  it("says nothing when the commit's files were covered", () => {
    expect(decide(payload("git commit -m x"), deps(covered).d, {})).toEqual({ kind: "none" });
  });

  it("notes a commit that no finished review saw, and how to run one", () => {
    const note = decide(payload("git commit -m x"), deps(notCovered).d, {});
    expect(note.kind).toBe("note");
    if (note.kind === "note") {
      expect(note.message).toContain("No finished local review saw the files");
      expect(note.message).toContain("Not covered: the tree of abc1234");
      expect(note.message).toContain("review:local");
    }
  });

  it("judges the commit git named in its summary, not whatever HEAD is by then", () => {
    const { d, asked } = deps(notCovered);
    decide(payload("git commit -m x && git checkout other"), d, {});
    expect(asked).toEqual(["abc1234"]);
  });

  it("notes that it could not check on exit 2, on a missing exit code and on a throw", () => {
    for (const run of [
      { exitCode: 2, output: "" },
      { exitCode: null, output: "" },
    ]) {
      const note = decide(payload("git commit -m x"), deps(run).d, {});
      expect(note.kind === "note" && note.message).toContain("could not check");
    }
    const thrown = decide(payload("git commit -m x"), deps(mustNotRun).d, {});
    expect(thrown.kind === "note" && thrown.message).toContain("could not check");
  });

  it("does not run the gate for a command that is not a commit, or for another tool", () => {
    expect(decide(payload("git status"), deps(mustNotRun).d, {})).toEqual({ kind: "none" });
    expect(decide(payload("git commit -m x", "Edit"), deps(mustNotRun).d, {})).toEqual({ kind: "none" });
  });

  it("works for PowerShell commands too", () => {
    expect(decide(payload("git commit -m x", "PowerShell"), deps(notCovered).d, {}).kind).toBe("note");
  });

  it("stays silent when the tool ran in another repository, and speaks when it ran in this one", () => {
    const elsewhere = deps(mustNotRun, { inProject: () => false }).d;
    expect(decide(payload("git commit -m x", "Bash", made, "D:/other"), elsewhere, {})).toEqual({ kind: "none" });
    expect(decide(payload("git commit -m x", "Bash", made, "D:/here"), deps(notCovered).d, {}).kind).toBe("note");
  });

  it("stays silent in an unattended factory run and when switched off", () => {
    expect(decide(payload("git commit -m x"), deps(mustNotRun).d, { FAULTFORGE_FACTORY_RUN: "1" })).toEqual({
      kind: "none",
    });
    expect(decide(payload("git commit -m x"), deps(mustNotRun).d, { FAULTFORGE_GATE: "off" })).toEqual({
      kind: "none",
    });
  });

  it("stays silent for a payload it cannot read, never failing the commit", () => {
    expect(decide("not json", deps(mustNotRun).d, {})).toEqual({ kind: "none" });
    expect(decide("null", deps(mustNotRun).d, {})).toEqual({ kind: "none" });
    expect(decide(JSON.stringify({ tool_name: "Bash" }), deps(mustNotRun).d, {})).toEqual({ kind: "none" });
  });

  it("never denies: its only answers are a note or nothing", () => {
    const kinds = [covered, notCovered, { exitCode: 2, output: "" }].map(
      (r) => decide(payload("git commit -m x"), deps(r).d, {}).kind,
    );
    for (const kind of kinds) expect(["none", "note"]).toContain(kind);
  });
});

describe("madeCommit: a commit that was not made is not judged", () => {
  it("gives the hash from git's summary line, in either output shape", () => {
    expect(madeCommit({ stdout: "[main abc1234] msg" }, () => null)).toBe("abc1234");
    expect(madeCommit("[detached HEAD 1234567] msg", () => null)).toBe("1234567");
    expect(madeCommit({ output: "[feature 7654321] msg" }, () => null)).toBe("7654321");
  });

  it("is null when git says there was nothing to commit or the commit failed", () => {
    for (const stdout of [
      "nothing to commit, working tree clean",
      `On branch main${NL}nothing added to commit`,
      `error: gpg failed to sign the data${NL}fatal: failed to write commit object`,
    ]) {
      expect(madeCommit({ stdout }, () => 5)).toBeNull();
    }
  });

  it("falls back to a young HEAD for a quiet commit that printed other output", () => {
    expect(madeCommit({ stdout: "hook ran fine" }, () => 5)).toBe("HEAD");
    expect(madeCommit({ stdout: "" }, () => 5)).toBe("HEAD");
    expect(madeCommit(undefined, () => 5)).toBe("HEAD");
  });

  it("does not judge an old HEAD, or one whose age is unknown", () => {
    expect(madeCommit({ stdout: "hook ran fine" }, () => 3600)).toBeNull();
    expect(madeCommit(undefined, () => null)).toBeNull();
  });
});

describe("text that only looks like a command", () => {
  it("is removed before the command is read", () => {
    expect(withoutText('git commit -m "fix cd x"')).not.toContain("cd");
    expect(withoutText(`git commit -F - <<'EOF'${NL}cd somewhere${NL}EOF`)).not.toContain("cd");
  });

  it("does not let a message that mentions cd or -C silence the hook", () => {
    expect(isOwnCommit('git commit -m "undo the cd step"')).toBe(true);
    expect(isOwnCommit(`git commit -F - <<'EOF'${NL}move with git -C elsewhere${NL}EOF`)).toBe(true);
  });

  it("does not take a quoted mention of git commit for a commit", () => {
    expect(isOwnCommit('echo "run git commit later"')).toBe(false);
  });
});

describe("sameRepository", () => {
  it("is true for the project folder itself and for a folder inside it", () => {
    const here = process.cwd();
    expect(sameRepository(here, here)).toBe(true);
    expect(sameRepository(here, `${here}/packages`)).toBe(true);
  });

  it("is false for a folder that is not a git repository", () => {
    expect(sameRepository(process.cwd(), process.platform === "win32" ? "C:/Windows" : "/")).toBe(false);
  });
});

describe("show", () => {
  it("prints a note as a message to the person and context to the agent, and nothing for none", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      show({ kind: "none" });
      show({ kind: "note", message: "hello" });
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0] ?? "{}");
    expect(out.systemMessage).toBe("hello");
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "PostToolUse", additionalContext: "hello" });
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });
});
