import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kindTermsOf, privateDir, templateDir, templateProblems } from "./templates.ts";

const root = join(import.meta.dirname, "../../..");
const SEED = "idempotency-guard-bypass-v1";
const SEED_DIR = join(root, "templates", "seed");

describe("templateDir: where inject and match both look", () => {
  it("finds a seed template when private storage has no copy, and nothing for an unknown id", () => {
    const env = { FAULTFORGE_PRIVATE_DIR: join(tmpdir(), "no-such-private") };
    expect(templateDir(SEED, env)).toBe(join(root, "templates", "seed", SEED));
    expect(templateDir("no-such-template", env)).toBeUndefined();
  });

  it.each(["../../examples/FF-0001", "a/b", "a\\b", ".hidden", "", "x/../../y"])(
    "finds nothing for %j, which isn't a plain folder name (Qodo on PR 128, round 2)",
    (id) => {
      expect(templateDir(id, {})).toBeUndefined();
    },
  );

  it("prefers the private copy, read from FAULTFORGE_PRIVATE_DIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "templates-"));
    mkdirSync(join(dir, "templates", SEED), { recursive: true });
    writeFileSync(join(dir, "templates", SEED, "template.json"), "{}");
    const env = { FAULTFORGE_PRIVATE_DIR: dir };
    expect(privateDir(env)).toBe(dir);
    expect(templateDir(SEED, env)).toBe(join(dir, "templates", SEED));
  });
});

describe("kindTermsOf: what a template must declare for the rule's third criterion", () => {
  it("returns the terms of a well-formed template", () => {
    expect(kindTermsOf({ match: { kindTerms: ["replay", "duplicate booking"] } }, "t")).toEqual([
      "replay",
      "duplicate booking",
    ]);
  });

  it.each([
    ["no match block", {}],
    ["an empty list", { match: { kindTerms: [] } }],
    ["a string instead of a list", { match: { kindTerms: "replay" } }],
    ["a number among the terms", { match: { kindTerms: ["replay", 3] } }],
    ["a blank term", { match: { kindTerms: ["replay", " "] } }],
    ["something that isn't an object", null],
  ])("refuses %s, naming the field", (_name, template) => {
    expect(() => kindTermsOf(template, "template.json")).toThrow(/template\.json must declare match\.kindTerms/);
  });
});

const VALID_BUG_TEMPLATE = {
  schemaVersion: 2,
  id: "example-bug-v1",
  kind: "bug",
  summary: "A one-line description of what the change breaks.",
  file: "src/widget.ts",
  find: "return a + b;\n",
  replace: "return a - b;\n",
  invariantId: "INV-EXAMPLE-001",
  defectClass: "logic",
  proofTest: "proof.test.ts",
  match: { kindTerms: ["addition", "sum"] },
  alsoBreaks: [],
  publish: { branch: "tidy-widget-math", commitMessage: "Simplify widget math" },
  ticket: {
    title: "Simplify widget math",
    what: "The widget adds two numbers through an unnecessary helper. Compute it directly.",
    criteria: ["Widget totals are unchanged for every existing fixture."],
  },
};

const VALID_CONTROL_TEMPLATE = {
  schemaVersion: 2,
  id: "example-control-v1",
  kind: "control",
  summary: "An ordinary, harmless change, used as a control case.",
  file: "src/widget.ts",
  find: "// TODO: tidy this up\n",
  replace: "\n",
  publish: { branch: "remove-stale-comment", commitMessage: "Remove a stale TODO" },
  ticket: {
    title: "Remove a stale TODO",
    what: "The comment refers to work that is already done.",
    criteria: ["The file still builds and its tests still pass."],
  },
};

describe("templateProblems: the version-2 schema", () => {
  it("passes a well-formed bug template", () => {
    expect(templateProblems(VALID_BUG_TEMPLATE)).toEqual([]);
  });

  it("passes a well-formed control template", () => {
    expect(templateProblems(VALID_CONTROL_TEMPLATE)).toEqual([]);
  });

  it("refuses a template with no kind, naming the field", () => {
    const { kind, ...rest } = VALID_BUG_TEMPLATE;
    const problems = templateProblems(rest);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/kind/);
  });

  it("refuses a bug template without a proofTest, naming the field", () => {
    const { proofTest, ...rest } = VALID_BUG_TEMPLATE;
    const problems = templateProblems(rest);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/proofTest/);
  });

  it("refuses a template with an unknown property, naming the field", () => {
    const problems = templateProblems({ ...VALID_BUG_TEMPLATE, sabotageNote: "nope" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/sabotageNote/);
  });
});

describe("every seed template matches the version-2 schema", () => {
  const ids = readdirSync(SEED_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it("has at least one seed template to check", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it.each(ids)("%s", (id) => {
    const template = JSON.parse(readFileSync(join(SEED_DIR, id, "template.json"), "utf8"));
    expect(templateProblems(template)).toEqual([]);
  });
});
