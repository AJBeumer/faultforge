/**
 * Refuses public text that names a case before its verdict, or names a held-out case at all (#224, audit
 * M-24). The decision log's rules 1 and 2, checked instead of remembered: on 12 November a configuration
 * entry named an upcoming case while it was under review.
 *
 *   npm run docs:check
 *
 * Reads `README.md` and every text file under `docs/`, and from private storage the answer key, the audit
 * log, the unreleased templates and `templates/HELD-OUT.md`. A case id (`FF-NNNN`) the answer key holds, or an
 * unreleased template id, is allowed only once its case has a `case.adjudicated` event, and never when it is
 * held out. An id the answer key doesn't hold is an example (a test fixture's `FF-0099`), not a case.
 * Without private storage (CI) there is nothing to check against, so it says so and passes.
 *
 * Exit codes: 0 nothing found, or no private storage to check against; 1 a public file names a case or
 * template it may not, listed on stdout; 2 a file could not be read.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditLog, readLedger } from "./ledger.ts";
import { ROOT } from "./paths.ts";
import { privateDir } from "./templates.ts";

export interface DocsFacts {
  /** Case ids with a `case.adjudicated` event. */
  adjudicated: Set<string>;
  /** Each case's template id. */
  caseTemplates: Map<string, string>;
  /** Template ids in private storage, unreleased. */
  privateTemplates: string[];
  /** Template ids held out of everything public until the final report. */
  heldOut: Set<string>;
}

const TEXT = /\.(md|txt|json|jsonl|ts|yml|yaml|csv|html)$/i;

/** `file: reason` for every case or template a public file may not name yet, or an empty list. */
export function docsProblems(files: { path: string; text: string }[], facts: DocsFacts): string[] {
  const heldOutCases = new Set([...facts.caseTemplates].filter(([, t]) => facts.heldOut.has(t)).map(([c]) => c));
  const adjudicatedTemplates = new Set(
    [...facts.caseTemplates].filter(([c]) => facts.adjudicated.has(c)).map(([, t]) => t),
  );
  const problems: string[] = [];
  for (const { path, text } of files) {
    for (const id of new Set(text.match(/\bFF-\d{4}\b/g) ?? [])) {
      // An id the answer key doesn't hold is an example or a fixture, not a case.
      if (!facts.caseTemplates.has(id)) continue;
      if (heldOutCases.has(id)) problems.push(`${path}: names ${id}, a held-out case`);
      else if (!facts.adjudicated.has(id)) problems.push(`${path}: names ${id}, which has no verdict yet`);
    }
    for (const template of facts.privateTemplates) {
      if (!text.includes(template)) continue;
      if (facts.heldOut.has(template)) problems.push(`${path}: names ${template}, a held-out template`);
      else if (!adjudicatedTemplates.has(template))
        problems.push(`${path}: names ${template}, whose case has no verdict yet`);
    }
  }
  return problems;
}

/** README.md and every text file under docs/, relative to `root`. */
export function publicFiles(root: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (TEXT.test(name))
        out.push({ path: relative(root, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
    }
  };
  out.push({ path: "README.md", text: readFileSync(join(root, "README.md"), "utf8") });
  walk(join(root, "docs"));
  return out;
}

/** What private storage says, or undefined when there is no private storage to read. */
export function docsFacts(priv: string): DocsFacts | undefined {
  const groundTruth = join(priv, "ground-truth.jsonl");
  if (!existsSync(groundTruth)) return undefined;
  const entries = readLedger(groundTruth) as { caseId?: string; templateId?: string }[];
  const caseTemplates = new Map(
    entries.filter((e) => e.caseId && e.templateId).map((e) => [e.caseId as string, e.templateId as string]),
  );
  const audit = join(priv, "audit-events.jsonl");
  const events = existsSync(audit) ? (readAuditLog(audit) as { type?: string; caseId?: string }[]) : [];
  const adjudicated = new Set(
    events.filter((e) => e.type === "case.adjudicated" && e.caseId).map((e) => e.caseId as string),
  );
  const templatesDir = join(priv, "templates");
  const privateTemplates = existsSync(templatesDir)
    ? readdirSync(templatesDir).filter((d) => existsSync(join(templatesDir, d, "template.json")))
    : [];
  const heldOutFile = join(templatesDir, "HELD-OUT.md");
  const heldOut = new Set(
    existsSync(heldOutFile)
      ? [...readFileSync(heldOutFile, "utf8").matchAll(/^[0-9a-f]{64}\s+([^/\s]+)\//gm)].map((m) => m[1] as string)
      : [],
  );
  return { adjudicated, caseTemplates, privateTemplates, heldOut };
}

function main(): number {
  let facts: DocsFacts | undefined;
  let files: { path: string; text: string }[];
  try {
    facts = docsFacts(privateDir());
    files = publicFiles(ROOT);
  } catch (e) {
    console.error(`docs:check: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (!facts) {
    console.log("docs:check: no private storage here, so nothing to check public text against (skipped)");
    return 0;
  }
  const problems = docsProblems(files, facts);
  if (problems.length) {
    console.log(`docs:check: public text names what it may not yet:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    return 1;
  }
  console.log(`docs:check: ${files.length} public files name no case or template before its time`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main());
