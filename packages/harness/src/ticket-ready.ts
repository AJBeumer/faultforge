/**
 * Is a ticket ready to work? It needs every required section, a checklist to verify against, and
 * no open blockers. Used by `/work-ticket` before any work starts:
 *
 *   npm run ticket:ready -- faultforge 47
 *   npm run ticket:ready -- target 4
 *
 * Exits 0 when ready, 1 with the list of problems when not.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Sections {
  required: string[];
  /** The section that must hold checklist items, so "done" can be verified. */
  checklist: string;
}

/** Section names per repo. The target's tickets use its own form ("What", "Acceptance criteria"). */
export const SECTIONS = {
  faultforge: { required: ["Result", "Done when", "Must not break"], checklist: "Done when" },
  target: { required: ["What", "Acceptance criteria", "Must not break"], checklist: "Acceptance criteria" },
} satisfies Record<string, Sections>;

type RepoKey = keyof typeof SECTIONS;
const REPOS: Record<RepoKey, string> = { faultforge: "AJBeumer/faultforge", target: "AJBeumer/faultforge-target" };

/** Problems that make a ticket not ready, or an empty list. */
export function readinessProblems(body: string, sections: Sections, openBlockers: number[]): string[] {
  const parts = new Map<string, string>();
  for (const match of body.matchAll(/^###\s+(.+?)\s*$([\s\S]*?)(?=^###\s|(?![\s\S]))/gm)) {
    parts.set((match[1] ?? "").trim().toLowerCase(), (match[2] ?? "").trim());
  }

  const problems: string[] = [];
  for (const name of sections.required) {
    const text = parts.get(name.toLowerCase());
    if (text === undefined) problems.push(`missing section "${name}"`);
    else if (text === "" || text === "_No response_") problems.push(`section "${name}" is empty`);
    else if (name === sections.checklist && !/^- \[[ xX]\] \S/m.test(text)) {
      problems.push(`"${name}" has no checklist items`);
    }
  }
  if (openBlockers.length) problems.push(`blocked by open tickets ${openBlockers.map((n) => `#${n}`).join(", ")}`);
  return problems;
}

function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function main() {
  const [repoKey, number] = process.argv.slice(2);
  if (!repoKey || !(repoKey in SECTIONS) || !number) {
    console.error("usage: npm run ticket:ready -- <faultforge|target> <issue number>");
    process.exit(2);
  }
  const repo = REPOS[repoKey as RepoKey];
  const sections = SECTIONS[repoKey as RepoKey];
  const issue = JSON.parse(gh("api", `repos/${repo}/issues/${number}`));
  const blockers: { number: number; state: string }[] = JSON.parse(
    gh("api", `repos/${repo}/issues/${number}/dependencies/blocked_by`),
  );
  const problems = readinessProblems(
    issue.body ?? "",
    sections,
    blockers.filter((b) => b.state === "open").map((b) => b.number),
  );
  if (problems.length) {
    console.log(`${repoKey} #${number} is not ready:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${repoKey} #${number} is ready: ${issue.title}`);
}

// Run only when called as a script, not when the tests import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
