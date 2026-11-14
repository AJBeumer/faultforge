import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type PrArgs, parseCliArgs, run } from "./case-pr.ts";
import type { FactoryConfig } from "./factory-config.ts";
import { eventProblems } from "./ledger-append.ts";

const COMMIT = "c".repeat(40);
const FACTORY = { repos: { target: { github: "Owner/target" } } } as unknown as FactoryConfig;

/** Private storage after inject and case:ticket for FF-9400, and qodo:check's saved state. */
const TICKET = { type: "case.ticket-created", issue: { number: 12 } };
const PLANTED = { type: "sabotage.injected" };

function fixture(events: object[] = [PLANTED, TICKET]) {
  const root = mkdtempSync(join(tmpdir(), "case-pr-"));
  mkdirSync(join(root, "templates", "x-secret-v1"), { recursive: true });
  writeFileSync(
    join(root, "templates", "x-secret-v1", "template.json"),
    JSON.stringify({ publish: { branch: "tidy-lookup", commitMessage: "Tidy the booking lookup" } }),
  );
  mkdirSync(join(root, "config", "qodo-v3"), { recursive: true });
  mkdirSync(join(root, "config", "qodo-v10"), { recursive: true });
  mkdirSync(join(root, "raw-artifacts", "qodo-state", "2026-11-14T00-00-00Z"), { recursive: true });
  writeFileSync(
    join(root, "ground-truth.jsonl"),
    `${JSON.stringify({ caseId: "FF-9400", templateId: "x-secret-v1", branch: "tidy-lookup", injectionCommit: COMMIT })}\n`,
  );
  const lines = events.map((e, i) => ({ eventId: `e${i}`, at: "2026-11-14T00:00:00Z", caseId: "FF-9400", ...e }));
  writeFileSync(join(root, "audit-events.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return root;
}

const ARGS: PrArgs = {
  caseId: "FF-9400",
  body: "Moves the lookup into one helper.",
  relationships: "none active, confirmed by the owner",
  dryRun: false,
};

/** A fake gh: the branch and the opened PR's head are `head`, and `pr create` prints PR 31's URL. */
function fakeGh(head = COMMIT) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr") return "https://github.com/Owner/target/pull/31\n";
    return `${head}\n`;
  };
  return { gh, calls };
}

let qodo = (root: string) => ({
  exitCode: 0,
  snapshotVersion: "qodo-v10",
  evidenceDir: join(root, "raw-artifacts", "qodo-state", "2026-11-14T00-00-00Z"),
  message: "matches qodo-v10",
});

async function open(root: string, args: Partial<PrArgs> = {}, gh = fakeGh()) {
  const err: string[] = [];
  const code = await run(
    { ...ARGS, ...args },
    {
      env: { FAULTFORGE_PRIVATE_DIR: root },
      log: () => {},
      error: (l) => err.push(l),
      factory: FACTORY,
      gh: gh.gh,
      now: () => "2026-11-14T01:00:00.000Z",
      eventId: () => "pr-event",
      qodoCheck: async (root) => qodo(root),
    },
  );
  const events = readFileSync(join(root, "audit-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { code, err: err.join("\n"), events, calls: gh.calls };
}

describe("case:pr (#251, AUD-M5)", () => {
  it("opens the PR with the commit message and Closes #N, and writes a valid pr.opened event", async () => {
    const { code, err, events, calls } = await open(fixture());
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(calls[1]).toEqual([
      "pr",
      "create",
      "--repo",
      "Owner/target",
      "--base",
      "main",
      "--head",
      "tidy-lookup",
      "--title",
      "Tidy the booking lookup",
      "--body",
      "Moves the lookup into one helper. Closes #12",
    ]);
    const opened = events.at(-1);
    expect(opened).toMatchObject({
      eventId: "pr-event",
      type: "pr.opened",
      caseId: "FF-9400",
      pr: 31,
      headCommit: COMMIT,
      headMatchesInjection: true,
      qodoConfiguration: "qodo-v10",
      qodoState: "raw-artifacts/qodo-state/2026-11-14T00-00-00Z",
      ticket: 12,
    });
    expect(eventProblems(opened)).toEqual([]);
  });

  it("refuses, before calling gh pr create, a body that gives the case away or links an issue", async () => {
    for (const body of ["Plants a sabotage case.", "See Owner/target#3."]) {
      const { code, calls, events } = await open(fixture(), { body });
      expect(code).toBe(1);
      expect(calls.some((c) => c[0] === "pr")).toBe(false);
      expect(events.some((e) => e.type === "pr.opened")).toBe(false);
    }
  });

  it("refuses a branch whose pushed head isn't the injected commit, a case with no ticket, and a second PR", async () => {
    expect((await open(fixture(), {}, fakeGh("d".repeat(40)))).code).toBe(1);
    expect((await open(fixture([PLANTED]))).code).toBe(1);
    expect((await open(fixture([TICKET]))).code).toBe(1);
    const twice = await open(fixture([PLANTED, TICKET, { type: "pr.opened" }]));
    expect(twice.code).toBe(1);
    expect(twice.err).toContain("already has a pr.opened event");
  });

  it("never opens a second PR after an attempt that left its marker", async () => {
    const root = fixture();
    mkdirSync(join(root, "raw-artifacts", "FF-9400"), { recursive: true });
    writeFileSync(join(root, "raw-artifacts", "FF-9400", "gh-pr-create.attempt.txt"), "earlier\n");
    const { code, calls } = await open(root);
    expect(code).toBe(2);
    expect(calls.some((c) => c[0] === "pr")).toBe(false);
  });

  it("writes no event, exit 2, when the opened PR's head isn't the injected commit", async () => {
    let n = 0;
    const gh = {
      calls: [] as string[][],
      gh: (args: string[]) =>
        args[0] === "pr" ? "https://github.com/Owner/target/pull/31" : n++ ? "e".repeat(40) : COMMIT,
    };
    const { code, events } = await open(fixture(), {}, gh);
    expect(code).toBe(2);
    expect(events.some((e) => e.type === "pr.opened")).toBe(false);
  });

  it("prints with --dry-run and opens nothing", async () => {
    const { code, calls } = await open(fixture(), { dryRun: true });
    expect(code).toBe(0);
    expect(calls.some((c) => c[0] === "pr")).toBe(false);
  });

  it("reads its command line", () => {
    const argv = ["--case", "FF-9400", "--body", "x", "--relationships", "none"];
    expect(parseCliArgs(argv)).toMatchObject({ caseId: "FF-9400", dryRun: false });
    expect(parseCliArgs(argv.slice(0, 4))).toBeNull();
    expect(parseCliArgs([...argv, "--qodo-state", "x"])).toBeNull();
  });
});

describe("case:pr: what Qodo found on PR 269", () => {
  it("refuses, before gh pr create, when Qodo doesn't match its snapshot or can't be checked", async () => {
    const original = qodo;
    for (const exitCode of [1, 2]) {
      qodo = (root) => ({ ...original(root), exitCode, message: "a rule changed" });
      const { code, err, calls } = await open(fixture());
      expect(code).toBe(1);
      expect(err).toContain("check didn't pass");
      expect(calls.some((c) => c[0] === "pr")).toBe(false);
    }
    qodo = original;
  });

  it("records the version and the folder the check itself gave", async () => {
    const original = qodo;
    qodo = (root) => ({ ...original(root), snapshotVersion: "qodo-v11" });
    const { events } = await open(fixture());
    expect(events.at(-1)).toMatchObject({ qodoConfiguration: "qodo-v11" });
    qodo = original;
  });

  it("refuses a template changed since the case was planted", async () => {
    const changed = { type: "sabotage.injected", tool: "faultforge-harness@1.0.0", inputHash: "0".repeat(64) };
    const { code, err, calls } = await open(fixture([changed, TICKET]));
    expect(code).toBe(1);
    expect(err).toContain("isn't the one it was planted from");
    expect(calls).toEqual([]);
  });
});
