/**
 * Where templates live and what every template must declare for the match rule. Shared by inject.ts,
 * which plants a case from a template, and match.ts, which applies the rule to a case record, so both
 * read the same template for the same id.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");

/** Private storage: `FAULTFORGE_PRIVATE_DIR`, or `private/` in this repository. */
export function privateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.FAULTFORGE_PRIVATE_DIR ?? join(ROOT, "private"));
}

/**
 * The folder holding `template.json` for `id`: private storage first (unreleased templates live there),
 * then `templates/seed` (adjudicated ones are copied there after their case). Undefined when neither has it.
 */
export function templateDir(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
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
