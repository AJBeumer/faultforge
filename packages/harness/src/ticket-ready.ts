/**
 * Is a ticket ready to work? It needs every required section, a checklist to verify against, and
 * no open blockers. Used by `/work-ticket` before any work starts:
 *
 *   npm run ticket:ready -- faultforge 47
 *   npm run ticket:ready -- target 4
 *
 * The repo key, its GitHub name and its ticket sections come from `factory.json`.
 * Exits 0 when ready, 1 with the list of problems when not.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFactory, type RepoConfig } from "./factory-config.ts";

type Sections = RepoConfig["tickets"];

/** A ticket's `###` sections by lower-case name. Code blocks are left out, so examples can't count. */
function sectionsOf(body: string): Map<string, string> {
  const prose = body.replace(/^(```|~~~)[\s\S]*?^\1\s*$/gm, "");
  const parts = new Map<string, string>();
  for (const match of prose.matchAll(/^###\s+(.+?)\s*$([\s\S]*?)(?=^###\s|(?![\s\S]))/gm)) {
    parts.set((match[1] ?? "").trim().toLowerCase(), (match[2] ?? "").trim());
  }
  return parts;
}

/** Text with nothing in it but list markers, such as the form's untouched "- ". */
function isEmpty(text: string): boolean {
  return text === "_No response_" || text.replace(/^\s*-\s*(\[[ xX]\])?\s*$/gm, "").trim() === "";
}

/** Issue numbers in this repo written in the "Depends on" section, e.g. "#12, #15". */
export function writtenDependencies(body: string): number[] {
  const text = sectionsOf(body).get("depends on") ?? "";
  return [...text.matchAll(/(?<![\w/-])#(\d+)\b/g)].map((m) => Number(m[1]));
}

/** Open issue numbers from every page of GitHub's paginated dependency list. */
export function openNumbers(pages: { number: number; state: string }[][]): number[] {
  return pages
    .flat()
    .filter((issue) => issue.state === "open")
    .map((issue) => issue.number);
}

/** Problems that make a ticket not ready, or an empty list. */
export function readinessProblems(body: string, sections: Sections, openBlockers: number[]): string[] {
  const parts = sectionsOf(body);

  const problems: string[] = [];
  for (const name of sections.sections) {
    const text = parts.get(name.toLowerCase());
    if (text === undefined) problems.push(`missing section "${name}"`);
    else if (isEmpty(text)) problems.push(`section "${name}" is empty`);
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
  const factory = loadFactory();
  const [repoKey, number] = process.argv.slice(2);
  const config = repoKey ? factory.repos[repoKey] : undefined;
  if (!config || !number) {
    console.error(`usage: npm run ticket:ready -- <${Object.keys(factory.repos).join("|")}> <issue number>`);
    process.exit(2);
  }
  const repo = config.github;
  const sections = config.tickets;
  const issue = JSON.parse(gh("api", `repos/${repo}/issues/${number}`));
  const body: string = issue.body ?? "";
  // Native "blocked by" links, every page, plus blockers only written in the Depends on text.
  const linked = openNumbers(
    JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/dependencies/blocked_by`)),
  );
  const written = writtenDependencies(body).filter(
    (n) => !linked.includes(n) && gh("api", `repos/${repo}/issues/${n}`, "--jq", ".state").trim() === "open",
  );
  const problems = readinessProblems(
    body,
    sections,
    [...linked, ...written].sort((a, b) => a - b),
  );
  if (problems.length) {
    console.log(`${repoKey} #${number} is not ready:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${repoKey} #${number} is ready: ${issue.title}`);
}

// Run only when called as a script, not when the tests import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
