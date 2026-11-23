import { describe, expect, it } from "vitest";
import { examDecision, loadedFirst, readTranscript } from "./skill-exam.ts";

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
