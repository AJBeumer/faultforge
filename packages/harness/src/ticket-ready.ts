/**
 * Is a ticket ready to work? It needs every required section, a checklist to verify against, no open
 * blockers, and no stale premise: every path, npm script and exported function it names as existing
 * (outside its deliverable sections) must exist in the repo's checkout (`ticket-premises.ts`, #147).
 * Used by `/work-ticket` and the factory runner before any work starts:
 *
 *   npm run ticket:ready -- faultforge 47
 *   npm run ticket:ready -- target 4
 *
 * The repo key, its GitHub name, checkout path and ticket sections come from `factory.json`.
 * Exits 0 when ready, 1 with the list of problems when not, 2 when the ticket or the checkout could
 * not be read (a missing checkout is never reported as "not ready").
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FactoryConfig, loadFactory, type RepoConfig, repoConfig } from "./factory-config.ts";
import { premiseProblems, premisesOf, refreshRef, sectionsOf } from "./ticket-premises.ts";

const LAB_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

type Sections = RepoConfig["tickets"];

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

/** Problems that make a ticket not ready, or an empty list. `stalePremises` come from `premiseProblems`. */
export function readinessProblems(
  body: string,
  sections: Sections,
  openBlockers: number[],
  stalePremises: string[] = [],
): string[] {
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
  problems.push(...stalePremises);
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
  checkoutOf: (path: string) => string = (path) => resolve(LAB_ROOT, path),
  refresh: (checkout: string) => void = refreshRef,
): { title: string; problems: string[] } {
  const { github: repo, tickets: sections, path } = repoConfig(factory, repoKey);
  const checkout = checkoutOf(path);
  if (!existsSync(checkout)) throw new Error(`checkout for ${repoKey} not found at ${checkout}`);
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
  // The first required section, the checklist and Out of scope describe what the ticket will or won't deliver, not what it assumes.
  // The other repos' checkouts catch cross-repo mentions, such as a lab ticket naming the target's file.
  const siblings = Object.entries(factory.repos)
    .filter(([key]) => key !== repoKey)
    .map(([, repo]) => checkoutOf(repo.path))
    .filter((dir) => existsSync(dir));
  // Read today's main, not the last fetch: a run builds from what origin holds now. Siblings are
  // refreshed only if a premise turns out to be missing here, so an unreachable sibling can't halt a
  // check that never needed it.
  refresh(checkout);
  const stale = premiseProblems(
    premisesOf(body, [sections.sections[0] ?? "", sections.checklist, "Out of scope"]),
    checkout,
    siblings,
    undefined,
    refresh,
  );
  return { title: issue.title, problems: readinessProblems(body, sections, blockers, stale) };
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
