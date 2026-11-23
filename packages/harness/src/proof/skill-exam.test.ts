import { describe, expect, it } from "vitest";
import {
  examDecision,
  examOptions,
  insideFolder,
  loadedFirst,
  pairResults,
  readTranscript,
  sessionDeny,
} from "./skill-exam.ts";

const line = (o: unknown) => JSON.stringify(o);
const transcript = [
  line({ type: "system", subtype: "init", skills: ["prove-finding", "other"] }),
  "not json",
  line({ type: "assistant", message: { content: [{ type: "text" }] } }),
  line({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "prove-finding" } }] },
  }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }),
  line({ type: "result", total_cost_usd: 1.25, result: "done\nPROVE-FINDING: supported" }),
].join("\n");

describe("readTranscript", () => {
  it("reads the first tool call, the listed skills, the cost and the last line", () => {
    const facts = readTranscript(transcript, "prove-finding");
    expect(facts).toEqual({
      firstTool: "Skill",
      firstSkill: "prove-finding",
      skillListed: true,
      costUsd: 1.25,
      finalLine: "PROVE-FINDING: supported",
    });
    expect(loadedFirst(facts, "prove-finding")).toBe(true);
  });

  it("does not count a skill loaded after another tool", () => {
    const late = transcript.replace('"name":"Skill","input":{"skill":"prove-finding"}', '"name":"Read","input":{}');
    expect(loadedFirst(readTranscript(late, "prove-finding"), "prove-finding")).toBe(false);
    expect(loadedFirst(readTranscript("", "prove-finding"), "prove-finding")).toBe(false);
  });
});

describe("sessionDeny", () => {
  const reads = (rules: string[]) => rules.filter((r) => r.startsWith("Read("));
  it("denies the lab's parent and private storage, however --repo is set", () => {
    const own = sessionDeny("D:/P/lab", "D:/P/lab/private", "D:/P/lab");
    expect(reads(own.rules)).toContain("Read(//d/P/**)");
    expect(reads(own.rules)).toContain("Read(//d/P/lab/private/**)");
    const elsewhere = sessionDeny("D:/P/lab", "D:/P/lab/private", "E:/work/target");
    expect(reads(elsewhere.rules)).toContain("Read(//d/P/**)"); // the case records stay out of reach
  });
  it("denies another repository itself, not its parent, so a temp export beside it stays open", () => {
    const { rules, folders } = sessionDeny("/home/u/lab", "/home/u/lab/private", "/tmp/target");
    expect(reads(rules)).toContain("Read(//tmp/target/**)");
    expect(reads(rules)).not.toContain("Read(//tmp/**)");
    expect(folders.some((f) => insideFolder("/tmp/proof-abc", f))).toBe(false);
    expect(folders.some((f) => insideFolder("/home/u/scratch/proof-abc", f))).toBe(true);
  });
});

describe("insideFolder", () => {
  it("compares as text, any case and either slash, never by prefix alone", () => {
    expect(insideFolder("C:\\T\\proof-1", "c:/t")).toBe(true);
    expect(insideFolder("C:/T", "C:/T/")).toBe(true);
    expect(insideFolder("C:/Temp/proof-1", "C:/T")).toBe(false);
  });
});

describe("examOptions", () => {
  const flag = (argv: string[], name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  it("reads the key's repository from --repo, and this checkout without it", () => {
    expect(examOptions(["--key", "k.json", "--out", "o", "--repo", "../target"], flag)?.repo).toBe("../target");
    expect(examOptions(["--key", "k.json", "--out", "o"], flag)).toEqual({
      key: "k.json",
      out: "o",
      repo: ".",
      budget: 5,
      rescore: false,
    });
  });
  it("reads --only, --budget and --rescore", () => {
    const options = examOptions(["--key", "k", "--out", "o", "--only", "t1,t2", "--budget", "3", "--rescore"], flag);
    expect(options).toMatchObject({ only: ["t1", "t2"], budget: 3, rescore: true });
  });
  it("refuses a missing key or output folder, or a budget that isn't a positive number", () => {
    expect(examOptions(["--out", "o"], flag)).toBeNull();
    expect(examOptions(["--key", "k"], flag)).toBeNull();
    expect(examOptions(["--key", "k", "--out", "o", "--budget", "lots"], flag)).toBeNull();
  });
});

describe("pairResults", () => {
  const row = (side: "reviewed" | "fixed", certified: boolean, skillLoadedFirst = true) => ({
    pair: "p1",
    side,
    certified,
    skillLoadedFirst,
  });
  it("counts a reviewed-side certificate only when the skill loaded first", () => {
    expect(pairResults(["p1"], [row("reviewed", true, false), row("fixed", false)])[0]?.reviewedCertified).toBe(false);
    expect(pairResults(["p1"], [row("reviewed", true), row("fixed", false)])[0]?.reviewedCertified).toBe(true);
  });
  it("counts a fixed-side certificate against the skill even without the skill loaded", () => {
    expect(pairResults(["p1"], [row("reviewed", false), row("fixed", true, false)])[0]?.fixedCertified).toBe(true);
  });
  it("leaves out a pair with a side not yet run", () => {
    expect(pairResults(["p1"], [row("reviewed", true)])).toEqual([]);
  });
});

describe("examDecision", () => {
  const pair = (reviewedCertified: boolean, fixedCertified: boolean) => ({
    pair: "p",
    reviewedCertified,
    fixedCertified,
  });
  it("works with two of three proven and no false proof", () => {
    expect(examDecision([pair(true, false), pair(true, false), pair(false, false)])).toBe("works");
  });
  it("fails on any certificate on a fixed commit", () => {
    expect(examDecision([pair(true, false), pair(true, false), pair(true, true)])).toBe("fails");
  });
  it("is inconclusive with fewer than two of three proven", () => {
    expect(examDecision([pair(true, false), pair(false, false), pair(false, false)])).toBe("inconclusive");
    expect(examDecision([])).toBe("inconclusive");
  });
});
