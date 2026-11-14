import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type HookAnswer,
  type HookRunner,
  HooksCheckError,
  type HooksReport,
  hookProblems,
  hookSelfTest,
  hookTimeoutSeconds,
  readHookProblems,
  realHookRunner,
  withCleanupFailure,
} from "./factory-hooks.ts";

describe("hookProblems", () => {
  const settings = (hooks: object[]) => JSON.stringify({ hooks: { PreToolUse: hooks } });
  const both = [
    { command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/fail-closed.ts" guard-target.ts' },
    { command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/fail-closed.ts" factory-policy.ts' },
  ];

  it("accepts this repo's own settings", () => {
    const text = readFileSync(join(import.meta.dirname, "../../../.claude/settings.json"), "utf8");
    expect(hookProblems(text)).toEqual([]);
    expect(readHookProblems(text)).toEqual([]);
  });

  it("refuses settings where the policy hook doesn't judge the read tools (#284)", () => {
    const noReads = settings([{ matcher: "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*", hooks: both }]);
    expect(readHookProblems(noReads)).toEqual([
      "factory-policy.ts doesn't run before Read",
      "factory-policy.ts doesn't run before Grep",
      "factory-policy.ts doesn't run before Glob",
      "factory-policy.ts doesn't run before NotebookRead",
    ]);
    expect(readHookProblems(settings([{ matcher: "*", hooks: both }]))).toEqual([]);
  });

  it("refuses settings without the policy hook, as on a main from before it existed", () => {
    expect(
      hookProblems(
        settings([{ matcher: "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*", hooks: [both[0]] }]),
      ),
    ).toEqual([
      "factory-policy.ts doesn't run before Bash",
      "factory-policy.ts doesn't run before PowerShell",
      "factory-policy.ts doesn't run before Write",
      "factory-policy.ts doesn't run before Edit",
      "factory-policy.ts doesn't run before MultiEdit",
      "factory-policy.ts doesn't run before NotebookEdit",
      "factory-policy.ts doesn't run before mcp__any__tool",
    ]);
  });

  it("refuses a matcher that leaves out MCP tools (Qodo on PR 265)", () => {
    const noMcp = settings([{ matcher: "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit", hooks: both }]);
    expect(hookProblems(noMcp)).toEqual([
      "guard-target.ts doesn't run before mcp__any__tool",
      "factory-policy.ts doesn't run before mcp__any__tool",
    ]);
  });

  it("refuses a matcher that leaves out file edits, and unreadable settings", () => {
    expect(hookProblems(settings([{ matcher: "Bash", hooks: both }]))).toHaveLength(12);
    expect(hookProblems("")).toEqual(["its settings.json is missing or unreadable"]);
  });

  it("treats an empty or * matcher as every tool", () => {
    expect(hookProblems(settings([{ matcher: "*", hooks: both }]))).toEqual([]);
    expect(hookProblems(settings([{ hooks: both }]))).toEqual([]);
  });
});

describe("hook self-test (#104)", () => {
  const LAB = join(import.meta.dirname, "../../..");
  /** A decision as a hook prints it; `null` leaves out the hookEventName Claude Code requires. */
  const decision = (permissionDecision: string, hookEventName: string | null = "PreToolUse") =>
    JSON.stringify({
      hookSpecificOutput: {
        ...(hookEventName && { hookEventName }),
        permissionDecision,
        permissionDecisionReason: "no",
      },
    });
  const deny = decision("deny");
  const allow = "";
  /** A fake hook: answers from a table keyed by hook and whether the stdin was JSON and what it asked. */
  const fake =
    (answer: (hook: string, stdin: string) => HookAnswer): HookRunner =>
    (hook, stdin) =>
      answer(hook, stdin);
  const correct = (hook: string, stdin: string): HookAnswer => {
    let json: { tool_input?: { command?: string } } | undefined;
    try {
      json = JSON.parse(stdin);
    } catch {
      return { stdout: deny, status: 0, ms: 5 };
    }
    const command = json?.tool_input?.command ?? "";
    const bad = hook === "guard-target.ts" ? /planted/.test(command) : /gh pr merge/.test(command);
    return { stdout: bad ? deny : allow, status: 0, ms: 5 };
  };

  it("passes hooks that deny what they must, allow the harmless command, and deny bad input quickly", () => {
    expect(hookSelfTest(LAB, join(LAB, "../faultforge-target"), 15, fake(correct))).toEqual([]);
  });

  it("fails a hook that lets the forbidden command through", () => {
    const lax = fake((hook, stdin) =>
      hook === "guard-target.ts" ? { stdout: allow, status: 0, ms: 5 } : correct(hook, stdin),
    );
    const problems = hookSelfTest(LAB, "/x/faultforge-target", 15, lax);
    expect(problems).toEqual([
      expect.stringMatching(/guard-target\.ts let through a telltale commit/),
      expect.stringMatching(/guard-target\.ts let through input that is not JSON/),
    ]);
  });

  it("fails a hook that crashes on bad input instead of denying", () => {
    const crashing = fake((hook, stdin) =>
      stdin.startsWith("{") ? correct(hook, stdin) : { stdout: "", status: 1, ms: 5 },
    );
    expect(hookSelfTest(LAB, "/x/faultforge-target", 15, crashing)).toEqual([
      expect.stringMatching(/guard-target\.ts let through input that is not JSON \(decision invalid, exit 1/),
      expect.stringMatching(/factory-policy\.ts let through input that is not JSON \(decision invalid, exit 1/),
    ]);
  });

  it("counts a blocking exit (2, no output) on bad input as a deny, as Claude Code does", () => {
    const blocking = fake((hook, stdin) =>
      stdin.startsWith("{") ? correct(hook, stdin) : { stdout: "", status: 2, ms: 5 },
    );
    expect(hookSelfTest(LAB, "/x/faultforge-target", 15, blocking)).toEqual([]);
  });

  it("fails a hook whose deny is not a decision Claude Code accepts (no hookEventName) (Qodo on PR 115)", () => {
    const malformed = fake((hook, stdin) => {
      const answer = correct(hook, stdin);
      return answer.stdout ? { ...answer, stdout: decision("deny", null) } : answer;
    });
    const problems = hookSelfTest(LAB, "/x/faultforge-target", 15, malformed);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/guard-target\.ts let through a telltale commit .*invalid/);
  });

  it("fails a hook that asks for approval on the harmless command: nobody is there to answer (Qodo on PR 115)", () => {
    const asking = fake((hook, stdin) => {
      const answer = correct(hook, stdin);
      return stdin.includes("npm run check") ? { ...answer, stdout: decision("ask") } : answer;
    });
    const problems = hookSelfTest(LAB, "/x/faultforge-target", 15, asking);
    expect(problems).toEqual([
      expect.stringMatching(/guard-target\.ts refused a harmless command .*ask/),
      expect.stringMatching(/factory-policy\.ts refused a harmless command inside a run .*ask/),
    ]);
  });

  it("fails a hook that refuses the harmless command, or exits non-zero on it", () => {
    const strict = fake((hook, stdin) =>
      hook === "factory-policy.ts" ? { stdout: deny, status: 0, ms: 5 } : correct(hook, stdin),
    );
    expect(hookSelfTest(LAB, "/x/faultforge-target", 15, strict)).toEqual([
      expect.stringMatching(/factory-policy\.ts refused a harmless command inside a run/),
    ]);
    const flaky = fake((hook, stdin) => ({ ...correct(hook, stdin), status: stdin.includes("npm run check") ? 1 : 0 }));
    expect(hookSelfTest(LAB, "/x/faultforge-target", 15, flaky)).toHaveLength(2);
  });

  it("fails a hook that answers slower than half its time limit", () => {
    const slow = fake((hook, stdin) => ({ ...correct(hook, stdin), ms: hook === "guard-target.ts" ? 9000 : 5 }));
    const problems = hookSelfTest(LAB, "/x/faultforge-target", 15, slow);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/guard-target\.ts took 9000 ms .* within half its 15 s limit/);
  });

  it("reads the hooks' time limit from the settings, defaulting to Claude Code's 60 s", () => {
    const text = readFileSync(join(LAB, ".claude/settings.json"), "utf8");
    expect(hookTimeoutSeconds(text)).toBe(15);
    expect(hookTimeoutSeconds("")).toBe(60);
    expect(
      hookTimeoutSeconds(
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { hooks: [{ command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/fail-closed.ts" guard-target.ts' }] },
            ],
          },
        }),
      ),
    ).toBe(60);
  });

  // Six real `node` processes, spawned one after another: fast alone, but a concurrent Vitest
  // run on the same machine (#110) can starve the CPU long enough to pass vitest's 5 s default.
  it("passes this repo's real hooks, run with node as settings.json runs them", () => {
    const limit = hookTimeoutSeconds(readFileSync(join(LAB, ".claude/settings.json"), "utf8"));
    // A scratch checkout, not the real one next door: this test only needs a cwd that looks
    // like the reviewed repo's folder, and a real neighbour checkout may be mid-build under a
    // concurrent run, which this test has no business depending on either way.
    const scratchParent = mkdtempSync(join(tmpdir(), "ff-reviewed-"));
    const reviewedFolder = join(scratchParent, "faultforge-target");
    mkdirSync(reviewedFolder);
    expect(hookSelfTest(LAB, reviewedFolder, limit, realHookRunner(LAB, limit))).toEqual([]);
  }, 60_000);
});

describe("withCleanupFailure: a failed start's cleanup problems keep the hook report (#126)", () => {
  const report: HooksReport = { problems: ["guard-target.ts let through a telltale commit"], hooks: [] };

  it("keeps a HooksCheckError's report when cleanup also failed, so the run log can still show it", () => {
    const original = new HooksCheckError("the workspace's hooks failed their self-test: x", report);
    const combined = withCleanupFailure(original, ["private worktree: busy"]);
    expect(combined).toBeInstanceOf(HooksCheckError);
    expect((combined as HooksCheckError).report).toEqual(report);
    expect(combined.message).toBe(
      "the workspace's hooks failed their self-test: x; cleanup also failed: private worktree: busy",
    );
  });

  it("makes an ordinary error with the same wording, and keeps no report", () => {
    const combined = withCleanupFailure(new Error("npm ci failed"), ["a", "b"]);
    expect(combined).not.toBeInstanceOf(HooksCheckError);
    expect(combined.message).toBe("npm ci failed; cleanup also failed: a; b");
  });

  it("returns the original error untouched when cleanup left nothing behind", () => {
    const original = new HooksCheckError("x", report);
    expect(withCleanupFailure(original, [])).toBe(original);
  });
});
