import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kindTermsOf, privateDir, templateDir } from "./templates.ts";

const root = join(import.meta.dirname, "../../..");
const SEED = "idempotency-guard-bypass-v1";

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
