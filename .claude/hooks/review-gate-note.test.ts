import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Deps,
  decide,
  type GateRun,
  type HeadState,
  readHead,
  recordHead,
  sameRepository,
  show,
} from "./review-gate-note.ts";

const NL = String.fromCharCode(10);
const payload = (tool = "Bash", cwd?: string) => JSON.stringify({ tool_name: tool, tool_input: { command: "x" }, cwd });
const notCovered: GateRun = {
  exitCode: 1,
  output: `Not covered: the tree of abc1234 (abc); no review recorded this tree.${NL}`,
};
const covered: GateRun = { exitCode: 0, output: "Covered: ..." };
const mustNotRun = (): GateRun => {
  throw new Error("the gate must not run here");
};

/** Fake world: a HEAD, what the hook saw last, and a gate; records what was saved and what was checked. */
function world(
  opts: { head?: HeadState | null; last?: string | null; run?: GateRun | (() => GateRun); inProject?: boolean } = {},
) {
  const saved: string[] = [];
  const asked: string[] = [];
  const run = opts.run ?? notCovered;
  const deps: Deps = {
    run: (ref) => {
      asked.push(ref);
      return typeof run === "function" ? run() : run;
    },
    inProject: () => opts.inProject ?? true,
    head: () => (opts.head === undefined ? { sha: "new1", lastAction: "commit: a message" } : opts.head),
    readLast: () => (opts.last === undefined ? "old1" : opts.last),
    saveLast: (sha) => {
      saved.push(sha);
    },
  };
  return { deps, saved, asked };
}

describe("decide: a commit is what git says it is, not what the command looks like", () => {
  it("says nothing when the new commit's files were covered", () => {
    expect(decide(payload(), world({ run: covered }).deps, {})).toEqual({ kind: "none" });
  });

  it("notes a new commit that no finished review saw, and how to run one", () => {
    const { deps, asked } = world();
    const note = decide(payload(), deps, {});
    expect(note.kind).toBe("note");
    if (note.kind === "note") {
      expect(note.message).toContain("No finished local review saw the files");
      expect(note.message).toContain("Not covered: the tree of abc1234");
      expect(note.message).toContain("review:local");
    }
    expect(asked).toEqual(["new1"]);
  });

  it("judges an amend, an initial commit and a merge commit made by `git commit`", () => {
    for (const lastAction of ["commit (amend): msg", "commit (initial): msg", "commit (merge): msg"]) {
      const { deps, asked } = world({ head: { sha: "new1", lastAction } });
      expect(decide(payload(), deps, {}).kind).toBe("note");
      expect(asked).toEqual(["new1"]);
    }
  });

  it("says nothing when HEAD did not move: no commit, a failed or dry-run commit, any other command", () => {
    expect(decide(payload(), world({ last: "new1", run: mustNotRun }).deps, {})).toEqual({ kind: "none" });
  });

  it("says nothing when HEAD moved for another reason, such as a checkout, a pull or a rebase step", () => {
    for (const lastAction of ["checkout: moving from a to b", "pull: Fast-forward", "rebase (pick): msg"]) {
      const { deps } = world({ head: { sha: "new1", lastAction }, run: mustNotRun });
      expect(decide(payload(), deps, {})).toEqual({ kind: "none" });
    }
  });

  it("only records HEAD the first time, with nothing to compare with", () => {
    const { deps, saved } = world({ last: null, run: mustNotRun });
    expect(decide(payload(), deps, {})).toEqual({ kind: "none" });
    expect(saved).toEqual(["new1"]);
  });

  it("remembers HEAD every time, so one commit is judged once", () => {
    const { deps, saved } = world({ run: covered });
    decide(payload(), deps, {});
    expect(saved).toEqual(["new1"]);
    const { deps: unchanged, saved: savedAgain } = world({ last: "new1", run: mustNotRun });
    decide(payload(), unchanged, {});
    expect(savedAgain).toEqual(["new1"]);
  });

  it("is not stopped by a failure to save its state", () => {
    const { deps } = world();
    deps.saveLast = () => {
      throw new Error("disk full");
    };
    expect(decide(payload(), deps, {}).kind).toBe("note");
  });

  it("notes that it could not check on exit 2, on a missing exit code and on a throw", () => {
    for (const run of [
      { exitCode: 2, output: "" },
      { exitCode: null, output: "" },
    ]) {
      const note = decide(payload(), world({ run }).deps, {});
      expect(note.kind === "note" && note.message).toContain("could not check");
    }
    const thrown = decide(payload(), world({ run: mustNotRun }).deps, {});
    expect(thrown.kind === "note" && thrown.message).toContain("could not check");
  });

  it("says nothing when git cannot say what HEAD is", () => {
    expect(decide(payload(), world({ head: null, run: mustNotRun }).deps, {})).toEqual({ kind: "none" });
  });

  it("works for PowerShell too, and ignores other tools", () => {
    expect(decide(payload("PowerShell"), world().deps, {}).kind).toBe("note");
    expect(decide(payload("Edit"), world({ run: mustNotRun }).deps, {})).toEqual({ kind: "none" });
  });

  it("stays silent when the tool ran in another repository, and speaks when it ran in this one", () => {
    expect(decide(payload("Bash", "D:/other"), world({ inProject: false, run: mustNotRun }).deps, {})).toEqual({
      kind: "none",
    });
    expect(decide(payload("Bash", "D:/here"), world().deps, {}).kind).toBe("note");
  });

  it("stays silent in an unattended factory run and when switched off", () => {
    expect(decide(payload(), world({ run: mustNotRun }).deps, { FAULTFORGE_FACTORY_RUN: "1" })).toEqual({
      kind: "none",
    });
    expect(decide(payload(), world({ run: mustNotRun }).deps, { FAULTFORGE_GATE: "off" })).toEqual({ kind: "none" });
  });

  it("stays silent for a payload it cannot read, never failing the commit", () => {
    expect(decide("not json", world({ run: mustNotRun }).deps, {})).toEqual({ kind: "none" });
    expect(decide("null", world({ run: mustNotRun }).deps, {})).toEqual({ kind: "none" });
  });

  it("never denies: its only answers are a note or nothing", () => {
    const kinds = [covered, notCovered, { exitCode: 2, output: "" }].map(
      (run) => decide(payload(), world({ run }).deps, {}).kind,
    );
    for (const kind of kinds) expect(["none", "note"]).toContain(kind);
  });
});

describe("recordHead: a commit made between commands is never judged", () => {
  it("records HEAD before a command and says nothing", () => {
    const { deps, saved } = world({ run: mustNotRun });
    recordHead(payload(), deps, {});
    expect(saved).toEqual(["new1"]);
  });

  it("makes a commit from a terminal invisible to the command after it", () => {
    // before: HEAD is already the terminal commit, so it is recorded; after: HEAD did not move.
    const state = { last: "old1" as string | null };
    const head = { sha: "terminal-commit", lastAction: "commit: made in a terminal" };
    const d: Deps = {
      run: mustNotRun,
      inProject: () => true,
      head: () => head,
      readLast: () => state.last,
      saveLast: (sha) => {
        state.last = sha;
      },
    };
    recordHead(payload(), d, {});
    expect(decide(payload(), d, {})).toEqual({ kind: "none" });
  });

  it("still judges a commit made during the command", () => {
    const state = { last: "old1" as string | null };
    let head: HeadState = { sha: "old1", lastAction: "checkout: moving from a to b" };
    const asked: string[] = [];
    const d: Deps = {
      run: (ref) => {
        asked.push(ref);
        return notCovered;
      },
      inProject: () => true,
      head: () => head,
      readLast: () => state.last,
      saveLast: (sha) => {
        state.last = sha;
      },
    };
    recordHead(payload(), d, {});
    head = { sha: "made-now", lastAction: "commit: made during the command" };
    expect(decide(payload(), d, {}).kind).toBe("note");
    expect(asked).toEqual(["made-now"]);
  });

  it("records nothing in a factory run, when switched off, for another tool or another repository", () => {
    for (const [stdin, env, inProject] of [
      [payload(), { FAULTFORGE_FACTORY_RUN: "1" }, true],
      [payload(), { FAULTFORGE_GATE: "off" }, true],
      [payload("Edit"), {}, true],
      [payload("Bash", "D:/other"), {}, false],
    ] as const) {
      const { deps, saved } = world({ inProject });
      recordHead(stdin, deps, env);
      expect(saved).toEqual([]);
    }
  });

  it("never throws, whatever it is given", () => {
    expect(() => recordHead("not json", world().deps, {})).not.toThrow();
    const { deps } = world();
    deps.saveLast = () => {
      throw new Error("disk full");
    };
    expect(() => recordHead(payload(), deps, {})).not.toThrow();
  });
});

describe("on a real git repository", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const sh = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  function repo() {
    dir = mkdtempSync(join(tmpdir(), "gate-note-"));
    sh("init", "-q", "-b", "main");
    sh("config", "user.email", "t@example.com");
    sh("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "1");
    sh("add", ".");
  }

  it("reads HEAD and calls a commit a commit, an amend an amend, and a checkout a checkout", () => {
    repo();
    sh("commit", "-qm", "first");
    expect(readHead(dir)).toEqual({ sha: sh("rev-parse", "HEAD"), lastAction: "commit (initial): first" });
    writeFileSync(join(dir, "a.txt"), "2");
    sh("commit", "-qam", "second");
    expect(readHead(dir)?.lastAction).toBe("commit: second");
    sh("commit", "-q", "--amend", "-m", "second again");
    expect(readHead(dir)?.lastAction).toMatch(/^commit \(amend\)/);
    sh("checkout", "-q", "-b", "other");
    expect(readHead(dir)?.lastAction).toMatch(/^checkout/);
  });

  it("does not move HEAD for a failed or dry-run commit", () => {
    repo();
    sh("commit", "-qm", "first");
    const before = sh("rev-parse", "HEAD");
    expect(() => sh("commit", "-qm", "nothing changed")).toThrow();
    writeFileSync(join(dir, "a.txt"), "changed");
    sh("commit", "--dry-run", "-am", "x");
    expect(sh("rev-parse", "HEAD")).toBe(before);
  });

  it("is null outside a repository", () => {
    dir = mkdtempSync(join(tmpdir(), "gate-note-"));
    expect(readHead(dir)).toBeNull();
  });

  it("sees the repository itself as the same repository, and an unrelated folder as another", () => {
    repo();
    expect(sameRepository(dir, dir)).toBe(true);
    const other = mkdtempSync(join(tmpdir(), "gate-note-other-"));
    try {
      expect(sameRepository(dir, other)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("sees a linked worktree as the same repository, and reads that worktree's own HEAD", () => {
    repo();
    sh("commit", "-qm", "first");
    const wt = `${dir}-linked`;
    try {
      sh("worktree", "add", "-q", "-b", "linked", wt);
      writeFileSync(join(wt, "b.txt"), "2");
      execFileSync("git", ["-C", wt, "add", "."]);
      execFileSync("git", ["-C", wt, "commit", "-qm", "in the worktree"], { stdio: "ignore" });
      expect(sameRepository(dir, wt)).toBe(true);
      expect(readHead(wt)?.lastAction).toBe("commit: in the worktree");
      expect(readHead(wt)?.sha).not.toBe(readHead(dir)?.sha);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("keeps a nested repository apart from the one that contains it", () => {
    repo();
    const nested = join(dir, "inner");
    execFileSync("git", ["init", "-q", nested]);
    expect(sameRepository(dir, nested)).toBe(false);
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

describe("registration and docs", () => {
  const root = resolve(import.meta.dirname, "..", "..");

  it("settings.json registers the hook after Bash and PowerShell commands, within the time limit", () => {
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    const entries = settings.hooks?.PostToolUse ?? [];
    const entry = entries.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes("review-gate-note.ts")),
    );
    expect(entry?.matcher).toBe("Bash|PowerShell");
    const hook = entry.hooks.find((h: { command: string }) => h.command.includes("review-gate-note.ts"));
    expect(hook.type).toBe("command");
    expect(hook.timeout).toBeLessThanOrEqual(15);
  });

  it("settings.json registers the before-command recording on Bash and PowerShell", () => {
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    const entry = (settings.hooks?.PreToolUse ?? []).find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes("review-gate-note.ts")),
    );
    expect(entry?.matcher).toBe("Bash|PowerShell");
    expect(entry.hooks[0].command).toMatch(/review-gate-note.ts" before$/);
  });

  it("the existing PreToolUse guards are still registered", () => {
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    const commands = JSON.stringify(settings.hooks.PreToolUse);
    expect(commands).toContain("guard-target.ts");
    expect(commands).toContain("factory-policy.ts");
  });

  it("docs/review-gate.md describes the warning and its off switch", () => {
    const docs = readFileSync(join(root, "docs", "review-gate.md"), "utf8");
    expect(docs).toContain("review-gate-note.ts");
    expect(docs).toContain("FAULTFORGE_GATE=off");
  });

  it("the hook file is the one the settings name", () => {
    expect(readFileSync(join(root, ".claude", "hooks", "review-gate-note.ts"), "utf8")).toContain("PostToolUse");
  });
});
