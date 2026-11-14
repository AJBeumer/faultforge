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
 * held out. An id the answer key doesn't hold is an example (a test fixture's `FF-0099`), not a case, as
 * long as it isn't above the highest case there: such an id names a case before it exists, and only the
 * fixture ids (`FF-0099`, `FF-9000` to `FF-9999`) may do that.
 * Without private storage (CI) there is nothing to check against, so it says so and passes.
 *
 * Exit codes: 0 nothing found, or no private storage to check against; 1 a public file names a case or
 * template it may not, listed on stdout; 2 a file could not be read, or an unexpected error stopped it
 * (`entry.ts`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEntry } from "./entry.ts";
import { readAuditLog, readLedger } from "./ledger.ts";
import { ROOT } from "./paths.ts";
import { privateDir } from "./templates.ts";

export interface DocsFacts {
  /** Case ids with a `case.adjudicated` event. */
  adjudicated: Set<string>;
  /** Each case's template ids: every answer-key entry for it, so a duplicate can't hide one (Qodo on PR 232). */
  caseTemplates: Map<string, string[]>;
  /** Template ids in private storage, unreleased. */
  privateTemplates: string[];
  /** Template ids held out of everything public until the final report. */
  heldOut: Set<string>;
}

const TEXT = /\.(md|txt|json|jsonl|ts|yml|yaml|csv|html)$/i;

/**
 * Case ids public text may use as examples although no case has them: `FF-0099` (an older fixture) and the
 * whole `FF-9000` to `FF-9999` block, kept for fixtures so no real case reaches it for years.
 */
export const FIXTURE_IDS: ReadonlySet<string> = new Set(["FF-0099"]);

export function isFixtureId(id: string): boolean {
  return FIXTURE_IDS.has(id) || /^FF-9\d{3}$/.test(id);
}

function caseNumber(id: string): number {
  return Number(id.replace(/^FF-/, ""));
}

/** `file: reason` for every case or template a public file may not name yet, or an empty list. */
export function docsProblems(files: { path: string; text: string }[], facts: DocsFacts): string[] {
  const heldOutCases = new Set(
    [...facts.caseTemplates].filter(([, ts]) => ts.some((t) => facts.heldOut.has(t))).map(([c]) => c),
  );
  const adjudicatedTemplates = new Set(
    [...facts.caseTemplates].filter(([c]) => facts.adjudicated.has(c)).flatMap(([, ts]) => ts),
  );
  // Only ids in the answer key's own form count: one malformed id must not make every comparison false.
  const highest = Math.max(0, ...[...facts.caseTemplates.keys()].filter((id) => /^FF-\d+$/.test(id)).map(caseNumber));
  const problems: string[] = [];
  for (const { path, text } of files) {
    // Any spelling the shared word list calls a case id (ff-0024, FF0024, FF 0024), as the answer key writes it.
    const matches = [...text.matchAll(/\bff([\s_-]?)(\d{3,})\b/gi)];
    const ids = matches.map((m) => `FF-${(m[2] as string).padStart(4, "0")}`);
    // Any spelling but a colour or a hex number: `#ff5733` and `0xff5733` are not cases (Qodo on PR 264).
    const separated = new Set(
      matches
        .filter((m) => !/[#x]$/i.test(text.slice(Math.max(0, (m.index ?? 0) - 1), m.index ?? 0)))
        .map((m) => `FF-${(m[2] as string).padStart(4, "0")}`),
    );
    for (const id of new Set(ids)) {
      // An id the answer key doesn't hold is an example or a fixture, unless it is above every case there:
      // then it names a case that hasn't been planted yet, ahead of time (#244), unless it is a fixture id.
      if (!facts.caseTemplates.has(id)) {
        if (separated.has(id) && caseNumber(id) > highest && !isFixtureId(id)) {
          problems.push(`${path}: names ${id}, above the highest case in the answer key`);
        }
        continue;
      }
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

/**
 * README.md and every text file under docs/, relative to `root`: each file's working copy, and its staged copy
 * when that differs, since a commit records the index, not the working tree (Qodo on PR 232).
 */
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
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z", "--", "README.md", "docs"], { encoding: "utf8" });
  if (listed.status === 0) {
    for (const path of listed.stdout.split("\0").filter((p) => TEXT.test(p))) {
      const index = spawnSync("git", ["-C", root, "show", `:${path}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (index.status !== 0) throw new Error(`can't read the staged ${path}: ${(index.stderr ?? "").trim()}`);
      if (index.stdout !== out.find((f) => f.path === path)?.text) {
        out.push({ path: `${path} (staged)`, text: index.stdout });
      }
    }
  }
  return out;
}

/** What private storage says, or undefined when there is no private storage to read. */
export function docsFacts(priv: string): DocsFacts | undefined {
  const groundTruth = join(priv, "ground-truth.jsonl");
  if (!existsSync(groundTruth)) return undefined;
  const entries = readLedger(groundTruth) as { caseId?: string; templateId?: string }[];
  const caseTemplates = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.caseId || !e.templateId) continue;
    caseTemplates.set(e.caseId, [...(caseTemplates.get(e.caseId) ?? []), e.templateId]);
  }
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  await runEntry(import.meta.url, main);
