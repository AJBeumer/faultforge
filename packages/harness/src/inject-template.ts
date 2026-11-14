/**
 * A template as `inject` reads it: loading it, the checks that refuse it before anything is planted, the
 * proofs its variant must break, and the mutation itself.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templateTelltales } from "./neutral.ts";
import { kindTermsOf, templateProblems } from "./templates.ts";

interface AlsoBreaks {
  invariantId: string;
  proofTest: string;
}

export interface Template {
  id: string;
  kind: "bug" | "control";
  summary: string;
  file: string;
  find: string;
  replace: string;
  publish: { branch: string; commitMessage: string };
  ticket: { title: string; what: string; criteria: string[] };
  invariantId?: string;
  defectClass?: string;
  proofTest?: string;
  match?: { kindTerms?: string[] };
  alsoBreaks?: AlsoBreaks[];
}

export interface Proof {
  invariantId: string;
  proofTest: string;
  /** The folder holding the proof, when it isn't the planted template's own (a corpus proof). */
  dir?: string;
}

export function loadTemplate(templateDir: string): Template {
  return JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8"));
}

/** Why the template must be refused before anything is planted, or undefined when it may be used. */
export function templateRefusal(template: Template, templateId: string, templateDir: string): string | undefined {
  // Checked before anything else: a template that fails the schema is refused without planting anything.
  const schemaProblems = templateProblems(template);
  if (schemaProblems.length) {
    return `template ${templateId} fails the schema:\n${schemaProblems.map((p) => `  ${p}`).join("\n")}`;
  }
  // Everything the template would put in front of the reviewer must read as an ordinary change: the branch
  // name and commit message, the code it looks for and writes, and its target ticket.
  const giveaways = templateTelltales(template);
  if (giveaways.length) return `the template gives the case away (${giveaways.join("; ")})`;

  // The terms the match rule's third criterion looks for, declared here before any case runs the template.
  // Only a bug template carries one: a control has no injected problem to describe.
  if (template.kind === "bug") {
    try {
      kindTermsOf(template, `${templateDir}/template.json`);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

/** Every proof the variant must break: the template's own invariant, plus whatever it breaks as collateral. */
export function proofsOf(template: Template): Proof[] {
  return template.kind === "bug"
    ? [
        { invariantId: template.invariantId as string, proofTest: template.proofTest as string },
        ...(template.alsoBreaks ?? []),
      ]
    : [];
}

/** Replaces the template's `find` text, which must occur exactly once. Returns the new lines. */
export function applyMutation(targetDir: string, template: Template): [number, number] {
  const path = join(targetDir, template.file);
  const source = readFileSync(path, "utf8");
  const at = source.indexOf(template.find);
  if (at === -1 || source.indexOf(template.find, at + 1) !== -1) {
    throw new Error(`find text must occur exactly once in ${template.file}`);
  }
  writeFileSync(path, source.slice(0, at) + template.replace + source.slice(at + template.find.length));
  const start = source.slice(0, at).split("\n").length;
  const lineCount = template.replace.replace(/\n$/, "").split("\n").length;
  return [start, start + lineCount - 1];
}

/**
 * Every proof of every bug template, private storage first then `templates/seed` (one copy per template id),
 * each with its own folder. A control's variant must pass all of them: a "harmless" change that breaks any
 * known invariant is a real bug labelled as a control (AUD-M8).
 */
export function proofCorpus(templateRoots: string[], skipped: (id: string, why: string) => void = () => {}): Proof[] {
  const seen = new Set<string>();
  const corpus: Proof[] = [];
  for (const root of templateRoots) {
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root).sort()) {
      const dir = join(root, id);
      if (seen.has(id) || !existsSync(join(dir, "template.json"))) continue;
      // A template still being written can't stand in the corpus: it is skipped, and said so, rather than
      // stopping every control (Qodo on PR 271). Only a usable copy marks the id as seen, so a broken private
      // copy never hides a good published one.
      let template: Template;
      try {
        template = loadTemplate(dir);
      } catch (e) {
        skipped(id, `template.json can't be read (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      if (template.kind !== "bug") {
        seen.add(id);
        continue;
      }
      const problems = templateProblems(template);
      if (problems.length) {
        skipped(id, `it fails the schema (${problems[0]})`);
        continue;
      }
      const proofs = proofsOf(template);
      const missing = proofs.find((p) => !existsSync(join(dir, p.proofTest)));
      if (missing) {
        skipped(id, `its proof ${missing.proofTest} is missing`);
        continue;
      }
      seen.add(id);
      corpus.push(...proofs.map((proof) => ({ ...proof, dir })));
    }
  }
  return corpus;
}
