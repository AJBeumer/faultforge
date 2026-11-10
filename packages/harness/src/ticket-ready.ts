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
import { type FactoryConfig, loadFactory, type RepoConfig, repoConfig } from "./factory-config.ts";

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

const GH_TIMEOUT_MS = 60_000;

function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS });
}

/** Reads a ticket from GitHub and returns its title and readiness problems (empty when ready). */
export function checkTicket(
  factory: FactoryConfig,
  repoKey: string,
  number: number,
  run: (...args: string[]) => string = gh,
): { title: string; problems: string[] } {
  const { github: repo, tickets: sections } = repoConfig(factory, repoKey);
  const issue = JSON.parse(run("api", `repos/${repo}/issues/${number}`));
  const body: string = issue.body ?? "";
  // Native "blocked by" links, every page, plus blockers only written in the Depends on text.
  const linked = openNumbers(
    JSON.parse(run("api", "--paginate", "--slurp", `repos/${repo}/issues/${number}/dependencies/blocked_by`)),
  );
  const written = writtenDependencies(body).filter(
    (n) => !linked.includes(n) && run("api", `repos/${repo}/issues/${n}`, "--jq", ".state").trim() === "open",
  );
  const blockers = [...linked, ...written].sort((a, b) => a - b);
  return { title: issue.title, problems: readinessProblems(body, sections, blockers) };
}

/**
 * What to print and exit with for a ticket check that either came back (ready or not) or could not
 * be read at all. A failure to read the ticket is never reported with the same code as "not ready":
 * 2 means the check didn't run, 1 means it ran and found the ticket not ready, 0 means it's ready.
 */
export function ticketReadyReport(
  repoKey: string,
  number: number,
  result: { title: string; problems: string[] } | { error: unknown },
): { code: 0 | 1 | 2; stream: "log" | "error"; message: string } {
  if ("error" in result) {
    const detail = result.error instanceof Error ? result.error.message : String(result.error);
    return { code: 2, stream: "error", message: `${repoKey} #${number}: could not read the ticket: ${detail}` };
  }
  if (result.problems.length) {
    return {
      code: 1,
      stream: "log",
      message: `${repoKey} #${number} is not ready:\n${result.problems.map((p) => `- ${p}`).join("\n")}`,
    };
  }
  return { code: 0, stream: "log", message: `${repoKey} #${number} is ready: ${result.title}` };
}

function main() {
  const factory = loadFactory();
  const [repoKey, number] = process.argv.slice(2);
  if (!repoKey || !factory.repos[repoKey] || !number) {
    console.error(`usage: npm run ticket:ready -- <${Object.keys(factory.repos).join("|")}> <issue number>`);
    process.exit(2);
  }
  let result: { title: string; problems: string[] } | { error: unknown };
  try {
    result = checkTicket(factory, repoKey, Number(number));
  } catch (error) {
    result = { error };
  }
  const report = ticketReadyReport(repoKey, Number(number), result);
  console[report.stream](report.message);
  process.exit(report.code);
}

// Run only when called as a script, not when the tests import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
