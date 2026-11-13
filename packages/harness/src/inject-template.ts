/**
 * A template as `inject` reads it: loading it, the checks that refuse it before anything is planted, the
 * proofs its variant must break, and the mutation itself.
 */
import { readFileSync, writeFileSync } from "node:fs";
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
