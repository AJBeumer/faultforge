import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const schema = JSON.parse(readFileSync(join(root, "schemas/case-record.v1.json"), "utf8"));
const examples = readdirSync(join(root, "examples"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, text: readFileSync(join(root, "examples", name), "utf8") }));

// Formats are documentation here; the checks that matter are structure and the fixed fields.
const validate = new Ajv2020({ allErrors: true, validateFormats: false }).compile(schema);

/** Every template's planted change, so no record can leak a template's exact text. */
function templateSnippets(): string[] {
  const seed = join(root, "templates/seed");
  return readdirSync(seed).flatMap((id) => {
    const template = JSON.parse(readFileSync(join(seed, id, "template.json"), "utf8"));
    return [template.find, template.replace].map((s: string) => s.trim());
  });
}

describe("public case records", () => {
  it("has at least one record", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)("$name matches schema v1", ({ text }) => {
    const valid = validate(JSON.parse(text));
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it.each(examples)("$name leaves out private fields and template text", ({ text }) => {
    expect(text).not.toMatch(/private[/\\]|raw-artifacts|ground-truth|proofTest|proof\.test/i);
    for (const snippet of templateSnippets()) {
      expect(text).not.toContain(snippet);
    }
  });

  it.each(examples)("$name is named after its case id", ({ name, text }) => {
    expect(name).toBe(`${JSON.parse(text).caseId}.json`);
  });

  it("rejects a record with an unknown field", () => {
    const record = { ...JSON.parse(examples[0]?.text ?? "{}"), proofTest: "x" };
    expect(validate(record)).toBe(false);
  });

  it("rejects a record without a verdict from the owner", () => {
    const { human: _human, ...record } = JSON.parse(examples[0]?.text ?? "{}");
    expect(validate(record)).toBe(false);
  });
});
