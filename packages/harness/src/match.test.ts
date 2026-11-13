import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CaseRecord, disagreements, run } from "./match.ts";
import { applyMatchRule, type MatchFinding } from "./match-rule.ts";

const root = join(import.meta.dirname, "../../..");
const ff0001 = () => JSON.parse(readFileSync(join(root, "examples/FF-0001.json"), "utf8"));
const NO_PRIVATE = join(tmpdir(), "no-such-private");

/** Runs the command on `record`, written to a temp file, with `privateDir` as private storage. */
function runOn(record: unknown, privateDir = NO_PRIVATE) {
  const file = join(mkdtempSync(join(tmpdir(), "match-")), "record.json");
  writeFileSync(file, typeof record === "string" ? record : JSON.stringify(record));
  const out: string[] = [];
  const err: string[] = [];
  const code = run(file, {
    env: { FAULTFORGE_PRIVATE_DIR: privateDir },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A private storage folder holding one template, given as an object or as raw file text. */
function privateTemplate(id: string, template: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "match-private-"));
  mkdirSync(join(dir, "templates", id), { recursive: true });
  writeFileSync(
    join(dir, "templates", id, "template.json"),
    typeof template === "string" ? template : JSON.stringify(template),
  );
  return dir;
}

describe("npm run match on FF-0001", () => {
  it("prints each criterion, the line range and width, and agrees with the record (exit 0)", () => {
    const { code, out } = runOn(ff0001());
    expect(code).toBe(0);
    expect(out).toContain("file: PASS");
    expect(out).toContain("lines: PASS");
    expect(out).toContain("kind: PASS");
    expect(out).toContain("lines 33-33, 1 line");
    expect(out).toContain("comment lines 24-61 (information only)");
    expect(out).toContain("caught: true");
    expect(out).toContain("agrees with the record's own detection");
  });

  it("exits 1 and says where when the record's detection disagrees", () => {
    const record = ff0001();
    record.detection.match.kind.pass = false;
    const { code, out } = runOn(record);
    expect(code).toBe(1);
    expect(out).toMatch(/disagrees: match\.kind\.pass: record says false, computed says true/);
  });
});

describe("npm run match: what it refuses with exit 2", () => {
  it("a file that isn't JSON, and a record without a findings list", () => {
    expect(runOn("not json").code).toBe(2);
    const { findings: _findings, ...noFindings } = ff0001();
    const refused = runOn(noFindings);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("has no findings list");
  });

  it("a finding whose fields aren't what a finding holds (Qodo on PR 128, round 2)", () => {
    for (const bad of [{ file: 7 }, { lines: "33" }, { lines: [33] }, { title: 5 }, { category: {} }]) {
      const record = ff0001();
      Object.assign(record.findings[0], bad);
      const refused = runOn(record);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain("isn't what a finding holds");
    }
  });

  it("a detection without its match, or with criteria that aren't booleans (audit N-1)", () => {
    const withoutMatch = ff0001();
    delete withoutMatch.detection.match;
    const half = ff0001();
    half.detection.match.kind = {};
    for (const record of [withoutMatch, half, { ...ff0001(), detection: null }]) {
      const refused = runOn(record);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain("has a detection without");
    }
  });

  it("a template id that would leave the templates folder (Qodo on PR 128, round 2)", () => {
    const record = ff0001();
    record.injection.templateId = "../../examples/FF-0001";
    const refused = runOn(record);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("not found");
  });

  it("a record whose template can't be found", () => {
    const record = ff0001();
    record.injection.templateId = "no-such-template";
    expect(runOn(record).code).toBe(2);
  });

  it("a template that can't be parsed, or declares no usable terms (Qodo on PR 128)", () => {
    const record = ff0001();
    record.injection.templateId = "broken-template";
    expect(runOn(record, privateTemplate("broken-template", "{ not json")).code).toBe(2);
    expect(runOn(record, privateTemplate("broken-template", { match: { kindTerms: "replay" } })).code).toBe(2);
    const numeric = runOn(record, privateTemplate("broken-template", { match: { kindTerms: ["replay", 3] } }));
    expect(numeric.code).toBe(2);
    expect(numeric.err).toContain("match.kindTerms");
  });
});

describe("npm run match: the template is the one inject used", () => {
  it("prefers the private copy to the seed copy, as inject does, read from FAULTFORGE_PRIVATE_DIR", () => {
    const record = ff0001();
    // The private copy declares terms the finding doesn't contain, so the kind criterion must fail here.
    const privateDir = privateTemplate(record.injection.templateId, { match: { kindTerms: ["off by one"] } });
    const { code, out } = runOn(record, privateDir);
    expect(out).toContain("kind: FAIL");
    expect(code).toBe(1);
  });
});

describe("disagreements: the record's one set of criteria against the computed result", () => {
  const injection = { file: "src/a.ts", lines: [10, 10] as [number, number] };
  const unplaced = (id: string): MatchFinding => ({
    id,
    file: null,
    lines: null,
    title: "x",
    summary: "y",
    category: "z",
  });
  type Match = NonNullable<CaseRecord["detection"]>["match"];
  const miss = (findings: MatchFinding[], match: Match): CaseRecord => ({
    findings,
    detection: { caught: false, matchedFindingIds: [], match },
  });

  it("compares only caught and the matched ids for a miss with several findings (Qodo on PR 128)", () => {
    const findings = [unplaced("a"), unplaced("b")];
    const result = applyMatchRule(injection, findings, ["term"]);
    const record = miss(findings, { file: { pass: true }, lines: { pass: false }, kind: { pass: true } });
    expect(disagreements(record, result)).toEqual([]);
  });

  it("compares the criteria against the only finding of a miss", () => {
    const findings = [unplaced("a")];
    const result = applyMatchRule(injection, findings, ["term"]);
    const record = miss(findings, { file: { pass: true }, lines: { pass: false }, kind: { pass: false } });
    expect(disagreements(record, result)).toEqual([
      expect.stringMatching(/match\.file\.pass: record says true, computed says false for a/),
    ]);
  });
});
