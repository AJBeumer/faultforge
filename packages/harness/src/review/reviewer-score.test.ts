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
  const answer = (findings: unknown[]) => JSON.stringify({ findings });
  const qodo = (id: string, file: string, start: number, end: number) => ({
    id,
    file_path: file,
    start_line: start,
    end_line: end,
    title: id,
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
