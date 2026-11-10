/**
 * Where templates live and what every template must declare for the match rule. Shared by inject.ts,
 * which plants a case from a template, and match.ts, which applies the rule to a case record, so both
 * read the same template for the same id.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

const ROOT = join(import.meta.dirname, "../../..");
const templateSchema = JSON.parse(readFileSync(join(ROOT, "schemas/template.v2.json"), "utf8"));
const templateSchemaCheck = new Ajv2020({ allErrors: true }).compile(templateSchema);

/** Private storage: `FAULTFORGE_PRIVATE_DIR`, or `private/` in this repository. */
export function privateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.FAULTFORGE_PRIVATE_DIR ?? join(ROOT, "private"));
}

/** A template id is one folder name: letters, digits, dots, dashes and underscores, nothing that moves up or across. */
export function isTemplateId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
}

/**
 * The folder holding `template.json` for `id`: private storage first (unreleased templates live there),
 * then `templates/seed` (adjudicated ones are copied there after their case). Undefined when neither has it,
 * and for an id that isn't a plain folder name, so a record can't point the lookup outside the templates.
 */
export function templateDir(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isTemplateId(id)) return undefined;
  return [join(privateDir(env), "templates", id), join(ROOT, "templates", "seed", id)].find((dir) =>
    existsSync(join(dir, "template.json")),
  );
}

/**
 * The template's `match.kindTerms`: the phrases, declared before any case runs the template, one of which
 * a finding must contain to describe the right kind of problem. Throws, naming the field, when the terms
 * are missing, empty, or anything but non-blank strings, so inject refuses the template and match refuses
 * the record before a bad term can reach the rule. `where` names the file in the message.
 */
export function kindTermsOf(template: unknown, where: string): string[] {
  const terms = (template as { match?: { kindTerms?: unknown } } | null)?.match?.kindTerms;
  if (!Array.isArray(terms) || !terms.length || terms.some((t) => typeof t !== "string" || !t.trim())) {
    throw new Error(`${where} must declare match.kindTerms as a non-empty list of non-blank strings`);
  }
  return terms;
}

/**
 * Problems with a template against the version-2 schema, in plain words, or an empty list when it's
 * valid. The first word of each problem names the field: the root for a missing property, the property
 * itself for a bad value or an unknown one. Checked before anything else: `inject` refuses a template
 * that fails here without planting anything, and `--validate-only` never gets past it either.
 */
export function templateProblems(template: unknown): string[] {
  if (templateSchemaCheck(template)) return [];
  return (templateSchemaCheck.errors ?? []).map((e) => {
    if (e.keyword === "additionalProperties") {
      const unknown = (e.params as { additionalProperty: string }).additionalProperty;
      return `${e.instancePath || "/"}: unknown property "${unknown}"`;
    }
    return `${e.instancePath || "/"} ${e.message}`;
  });
}
