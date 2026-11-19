import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../fixtures/temp-dir.ts";
import {
  type Confirmation,
  candidates,
  decide,
  type KeyEntry,
  main,
  parseReplays,
  parseReview,
  type RunScore,
  readRuns,
  type SavedRun,
  scoreRuns,
} from "./reviewer-score.ts";

const replays = new Map([[411, 391]]);
const key: KeyEntry[] = [
  { id: "k-late", pr: 391, kind: "late", file: "src/a.ts", lines: [10, 12] },
  { id: "k-r1", pr: 391, kind: "first", file: "src/b.ts", lines: [5, 5] },
];
const finding = (id: string, file: string | null, lines: [number, number] | null) => ({ id, file, lines, title: id });
const run = (arm: string, r: string, findings: SavedRun["findings"]): SavedRun => ({
  arm,
  run: r,
  replayPr: 411,
  findings,
});
const yes = (entry: string, arm: string, r: string, f: string): Confirmation => ({
  entry,
  arm,
  run: r,
  finding: f,
  kind: "yes",
});
const score = (arm: string, r: string, late: number, first: number): RunScore => ({
  arm,
  run: r,
  late,
  first,
  unmatched: 0,
});

describe("candidates", () => {
  it("lists findings on the entry's file with overlapping lines, per run", () => {
    const runs = [run("A", "1", [finding("f1", "src/a.ts", [12, 20]), finding("f2", "./src/b.ts", [5, 6])])];
    const found = candidates(key, runs, replays);
    expect(found.map((c) => [c.entry.id, c.finding.id])).toEqual([
      ["k-late", "f1"],
      ["k-r1", "f2"],
    ]);
  });

  it("never counts a finding on the right file without overlapping lines, or one placed nowhere", () => {
    const runs = [
      run("A", "1", [
        finding("f1", "src/a.ts", [13, 20]),
        finding("f2", "src/a.ts", null),
        finding("f3", null, [10, 10]),
      ]),
    ];
    expect(candidates(key, runs, replays)).toEqual([]);
  });

  it("matches only the key entries of the replay PR's own original", () => {
    const other: KeyEntry[] = [{ id: "k-other", pr: 312, kind: "late", file: "src/a.ts", lines: [10, 12] }];
    expect(candidates(other, [run("A", "1", [finding("f1", "src/a.ts", [10, 10])])], replays)).toEqual([]);
  });
});

describe("scoreRuns", () => {
  const runs = [
    run("A", "1", [finding("f1", "src/a.ts", [10, 10]), finding("f9", "src/z.ts", [1, 1])]),
    run("B", "1", [finding("g1", "src/a.ts", [11, 11]), finding("g2", "src/b.ts", [5, 5])]),
  ];
  const found = candidates(key, runs, replays);

  it("counts late and first-review catches from confirmed candidates, and the findings that caught nothing", () => {
    const confirmations = [
      { ...yes("k-late", "A", "1", "f1"), kind: "no" as const },
      yes("k-late", "B", "1", "g1"),
      yes("k-r1", "B", "1", "g2"),
    ];
    expect(scoreRuns(key, runs, found, confirmations)).toEqual([
      { arm: "A", run: "1", late: 0, first: 0, unmatched: 2 },
      { arm: "B", run: "1", late: 1, first: 1, unmatched: 0 },
    ]);
  });

  it("refuses to score while a candidate has no confirmation", () => {
    expect(() => scoreRuns(key, runs, found, [yes("k-late", "B", "1", "g1")])).toThrow(/have no confirmation/);
  });
});

describe("decide", () => {
  it("keeps the candidate when its worst late score beats the current best and its first-review catches hold", () => {
    expect(decide([score("A", "1", 2, 5), score("A", "2", 3, 6), score("B", "1", 4, 5), score("B", "2", 6, 7)])).toBe(
      "keep",
    );
  });

  it("undoes it when its best late score is below the current worst", () => {
    expect(decide([score("A", "1", 4, 5), score("A", "2", 5, 5), score("B", "1", 2, 5), score("B", "2", 3, 6)])).toBe(
      "undo",
    );
  });

  it("undoes it when late catches rise but first-review catches fall below the current worst", () => {
    expect(decide([score("A", "1", 2, 6), score("A", "2", 3, 7), score("B", "1", 5, 4), score("B", "2", 6, 5)])).toBe(
      "undo",
    );
  });

  it("calls overlapping ranges inconclusive", () => {
    expect(decide([score("A", "1", 2, 5), score("A", "2", 4, 5), score("B", "1", 3, 5), score("B", "2", 6, 5)])).toBe(
      "inconclusive",
    );
  });

  it("keeps when first-review catches match the current worst, and is inconclusive when it dips below it but not below every current run", () => {
    expect(decide([score("A", "1", 2, 5), score("A", "2", 3, 7), score("B", "1", 4, 5), score("B", "2", 5, 6)])).toBe(
      "keep",
    );
    expect(decide([score("A", "1", 2, 6), score("A", "2", 3, 7), score("B", "1", 4, 5), score("B", "2", 5, 6)])).toBe(
      "inconclusive",
    );
  });
});

describe("reading saved reviews", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const answer = (findings: unknown[], session: Record<string, unknown> = { run_id: 7, status: "completed" }) =>
    JSON.stringify({ findings, review_session: session });
  const qodo = (id: string, file: string, start: unknown, end: unknown, run = 7) => ({
    id,
    file_path: file,
    start_line: start,
    end_line: end,
    title: id,
    review_run_id: run,
  });
  const writeRuns = (arms: Record<string, string[]>, replayPrs: number[], body = answer([])) => {
    for (const [arm, runs] of Object.entries(arms)) {
      for (const r of runs) {
        mkdirSync(join(dir, "runs", arm, r), { recursive: true });
        for (const pr of replayPrs) writeFileSync(join(dir, "runs", arm, r, `pr${pr}.qodo-api.raw.json`), body);
      }
    }
  };
  const writeKey = (entries: unknown[]) =>
    writeFileSync(join(dir, "key.jsonl"), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const runMain = (extra: string[], replayArg = "411=391") => {
    const out: string[] = [];
    const code = main(
      ["--key", join(dir, "key.jsonl"), "--runs", join(dir, "runs"), "--replays", replayArg, ...extra],
      (l) => out.push(l),
    );
    return { code, out: out.join("\n") };
  };

  it("reads a JSON-RPC answer saved as JSON, and an event stream whose data line has no space", () => {
    const inner = answer([qodo("f1", "src/a.ts", 10, 10)]);
    const rpc = JSON.stringify({ jsonrpc: "2.0", result: { content: [{ type: "text", text: inner }] } });
    expect(parseReview(rpc).findings).toHaveLength(1);
    expect(parseReview(`event: message\ndata:${rpc}\n`).findings).toHaveLength(1);
  });

  it("refuses a review that is not completed", () => {
    dir = tempDir("ff-reviewer-score-");
    writeRuns({ A: ["1", "2"], B: ["1", "2"] }, [411], answer([], { run_id: 7, status: "started" }));
    expect(() => readRuns(join(dir, "runs"), replays)).toThrow(/not completed/);
  });

  it("refuses a review that carries findings from an earlier review of the same pull request", () => {
    dir = tempDir("ff-reviewer-score-");
    writeRuns({ A: ["1", "2"], B: ["1", "2"] }, [411], answer([qodo("f1", "src/a.ts", 10, 10, 6)]));
    expect(() => readRuns(join(dir, "runs"), replays)).toThrow(/from another review/);
  });

  it("refuses a finding whose lines are there but not whole numbers", () => {
    dir = tempDir("ff-reviewer-score-");
    writeRuns({ A: ["1", "2"], B: ["1", "2"] }, [411], answer([qodo("f1", "src/a.ts", "10", 12)]));
    expect(() => readRuns(join(dir, "runs"), replays)).toThrow(/lines/);
  });

  it("refuses arms with different runs, or fewer than two runs each", () => {
    dir = tempDir("ff-reviewer-score-");
    writeKey(key);
    writeRuns({ A: ["1", "2"], B: ["1"] }, [411]);
    expect(runMain([])).toMatchObject({ code: 2, out: expect.stringContaining("the same runs") });
    rmSync(join(dir, "runs"), { recursive: true });
    writeRuns({ A: ["1"], B: ["1"] }, [411]);
    expect(runMain([])).toMatchObject({ code: 2, out: expect.stringContaining("at least two runs") });
  });

  it("counts runs, not the pieces of a run name with a comma in it", () => {
    dir = tempDir("ff-reviewer-score-");
    writeKey(key);
    writeRuns({ A: ["1,2"], B: ["1,2"] }, [411]);
    expect(runMain([])).toMatchObject({ code: 2, out: expect.stringContaining("at least two runs") });
  });

  it("refuses a confirmation that answers no current candidate", () => {
    dir = tempDir("ff-reviewer-score-");
    writeKey(key);
    writeRuns({ A: ["1", "2"], B: ["1", "2"] }, [411]);
    const stale = { entry: "k-late", arm: "A", run: "1", finding: "gone", kind: "yes" };
    writeFileSync(join(dir, "confirm.jsonl"), `${JSON.stringify(stale)}\n`);
    expect(runMain(["--confirm", join(dir, "confirm.jsonl")])).toMatchObject({
      code: 2,
      out: expect.stringContaining("answer no candidate"),
    });
  });

  it("refuses a key line range that is not a range", () => {
    dir = tempDir("ff-reviewer-score-");
    writeKey([{ id: "k", pr: 391, kind: "late", file: "src/a.ts", lines: [12, 10] }]);
    writeRuns({ A: ["1", "2"], B: ["1", "2"] }, [411]);
    expect(runMain([])).toMatchObject({ code: 2, out: expect.stringContaining("entry 1") });
  });

  it("refuses a key whose pull request has no replay", () => {
    dir = tempDir("ff-reviewer-score-");
    writeKey([...key, { id: "k-312", pr: 312, kind: "late", file: "src/a.ts", lines: [1, 1] }]);
    writeRuns({ A: ["1", "2"], B: ["1", "2"] }, [411]);
    expect(runMain([])).toMatchObject({ code: 2, out: expect.stringContaining("312 has no replay") });
  });

  it("refuses replay pairs that are malformed or repeated", () => {
    expect(() => parseReplays("411=391=1")).toThrow(/not <replay>=<pr>/);
    expect(() => parseReplays("411=391,411=392")).toThrow(/twice/);
  });

  it("refuses a confirmation that is not yes or no, or that repeats an earlier one", () => {
    dir = tempDir("ff-reviewer-score-");
    writeKey(key);
    writeRuns({ A: ["1", "2"], B: ["1", "2"] }, [411], answer([qodo("f1", "src/a.ts", 10, 10)]));
    const confirm = (lines: unknown[]) =>
      writeFileSync(join(dir, "confirm.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const base = { entry: "k-late", arm: "A", run: "1", finding: "f1" };
    confirm([{ ...base, kind: "maybe" }]);
    expect(runMain(["--confirm", join(dir, "confirm.jsonl")])).toMatchObject({
      code: 2,
      out: expect.stringContaining("yes or no"),
    });
    confirm([
      { ...base, kind: "yes" },
      { ...base, kind: "no" },
    ]);
    expect(runMain(["--confirm", join(dir, "confirm.jsonl")])).toMatchObject({
      code: 2,
      out: expect.stringContaining("twice"),
    });
  });

  it("keeps a finding id that catches an entry in one replay from hiding an unmatched finding in another", () => {
    const twoReplays = new Map([
      [411, 391],
      [412, 312],
    ]);
    const k: KeyEntry[] = [{ id: "k", pr: 391, kind: "late", file: "src/a.ts", lines: [10, 10] }];
    const runs: SavedRun[] = [
      { arm: "A", run: "1", replayPr: 411, findings: [finding("same", "src/a.ts", [10, 10])] },
      { arm: "A", run: "1", replayPr: 412, findings: [finding("same", "src/z.ts", [1, 1])] },
    ];
    const found = candidates(k, runs, twoReplays);
    expect(scoreRuns(k, runs, found, [yes("k", "A", "1", "same")])).toEqual([
      { arm: "A", run: "1", late: 1, first: 0, unmatched: 1 },
    ]);
  });

  it("prints each arm's lowest and highest late and first-review catches", () => {
    dir = tempDir("ff-reviewer-score-");
    writeKey(key);
    writeRuns({ A: ["1", "2"], B: ["1", "2"] }, [411]);
    const { out } = runMain([]);
    expect(out).toContain("arm A: late 0 to 0 of 1, first review 0 to 0 of 1");
    expect(out).toContain("arm B: late 0 to 0 of 1, first review 0 to 0 of 1");
  });

  it("reads Qodo's JSON and the event stream review:wait saves", () => {
    const inner = answer([qodo("f1", "src/a.ts", 10, 10)]);
    const stream = `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: inner }] } })}\n`;
    expect(parseReview(inner).findings).toHaveLength(1);
    expect(parseReview(stream).findings).toHaveLength(1);
  });

  it("exits 2 and names the run when a replay PR has no saved review, never scoring it as zero", () => {
    dir = tempDir("ff-reviewer-score-");
    mkdirSync(join(dir, "runs", "A", "1"), { recursive: true });
    mkdirSync(join(dir, "runs", "B", "1"), { recursive: true });
    writeFileSync(join(dir, "runs", "A", "1", "pr411.qodo-api.raw.json"), answer([]));
    writeFileSync(join(dir, "key.jsonl"), `${key.map((e) => JSON.stringify(e)).join("\n")}\n`);
    expect(() => readRuns(join(dir, "runs"), replays)).toThrow("no saved review for replay PR 411 in arm B, run 1");
    const lines: string[] = [];
    const code = main(["--key", join(dir, "key.jsonl"), "--runs", join(dir, "runs"), "--replays", "411=391"], (l) =>
      lines.push(l),
    );
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("arm B, run 1");
  });

  it("lists the candidates, then scores and decides from the confirmations", () => {
    dir = tempDir("ff-reviewer-score-");
    for (const [arm, r, f] of [
      ["A", "1", qodo("a1", "src/b.ts", 5, 5)],
      ["A", "2", qodo("a2", "src/b.ts", 5, 5)],
      ["B", "1", qodo("b1", "src/a.ts", 10, 10)],
      ["B", "2", qodo("b2", "src/a.ts", 11, 11)],
    ] as const) {
      mkdirSync(join(dir, "runs", arm, r), { recursive: true });
      const extra = arm === "B" ? [qodo(`${f.id}-r1`, "src/b.ts", 5, 5)] : [];
      writeFileSync(join(dir, "runs", arm, r, "pr411.qodo-api.raw.json"), answer([f, ...extra]));
    }
    writeFileSync(join(dir, "key.jsonl"), `${key.map((e) => JSON.stringify(e)).join("\n")}\n`);
    const args = ["--key", join(dir, "key.jsonl"), "--runs", join(dir, "runs"), "--replays", "411=391"];
    const listed: string[] = [];
    expect(main([...args, "--list"], (l) => listed.push(l))).toBe(0);
    expect(listed.at(-1)).toBe("reviewer:score: 6 candidate(s) to confirm");
    const answers = listed
      .slice(0, -1)
      .map((l) => JSON.parse(l))
      .map((c) => JSON.stringify({ ...c, kind: "yes" }));
    writeFileSync(join(dir, "confirm.jsonl"), `${answers.join("\n")}\n`);
    const out: string[] = [];
    expect(main([...args, "--confirm", join(dir, "confirm.jsonl")], (l) => out.push(l))).toBe(0);
    expect(out).toContain("arm A run 1: late 0/1, first review 1/1, unmatched findings 0");
    expect(out).toContain("arm B run 2: late 1/1, first review 1/1, unmatched findings 0");
    expect(out.at(-1)).toBe("decision: keep");
  });
});
