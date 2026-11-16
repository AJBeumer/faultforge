/**
 * How a gate trial confines its builder agent, and what it checks afterwards. Pure: no process is started
 * here.
 *
 * The confinement is by the agent's own tool rules: files and the repository's checks only, no network tool,
 * no MCP server, no project variable in the environment, and the lab's folders denied to its file tools. It
 * is not a sandbox of the operating system. A test the builder writes runs as the person running the trial
 * and could read any file that person can. So after the loop the builder's changes are read for anything
 * that points outside the repository (`changeProblems`), and a trial with such a change is not counted. That
 * check catches what is written plainly, not a path built at run time: a trial is only as sound as the
 * machine it runs on, and its saved transcript and diffs are the record to audit.
 */
import { telltales } from "../shared/neutral.ts";

/** The tools the builder may use: files in its folder, and the repository's own checks. No network, no git writes. */
export const BUILDER_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(npm test:*)",
  "Bash(npm run check:*)",
  "Bash(npm run format:*)",
  "Bash(npm run test:*)",
  "Bash(npx vitest:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
];

/** The builder's command line: only `BUILDER_TOOLS`, no MCP server, a capped budget. */
export function builderArgs(settingsFile: string, mcpConfigFile: string, budgetUsd: number): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    BUILDER_TOOLS.join(","),
    "--max-budget-usd",
    String(budgetUsd),
    "--settings",
    settingsFile,
    "--mcp-config",
    mcpConfigFile,
    "--strict-mcp-config",
  ];
}

/** A folder as the deny rules spell it: forward slashes, and both cases of a drive letter. */
function spellings(folder: string): string[] {
  // By the text of the path, not this machine's own rules, so it reads the same on every system.
  const path = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^([a-zA-Z]):\/(.*)$/.exec(path);
  return drive
    ? [`//${(drive[1] as string).toLowerCase()}/${drive[2]}`, `//${(drive[1] as string).toUpperCase()}/${drive[2]}`]
    : [`/${path}`];
}

/**
 * Deny rules for the builder's file tools: the folder that holds the lab's checkouts, and private storage
 * wherever it is configured to be.
 */
export function builderDeny(labRoot: string, privateStorage: string): string[] {
  const root = labRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const folders = [root.slice(0, root.lastIndexOf("/")), privateStorage];
  const rules = folders
    .flatMap(spellings)
    .flatMap((p) => ["Read", "Edit", "Write", "Grep", "Glob"].map((tool) => `${tool}(${p}/**)`));
  return [...new Set(rules)];
}

/** An environment with no variable of this project, of Qodo or of GitHub: for the builder, and for installs. */
export function plainEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(FAULTFORGE_|QODO_|GH_|GITHUB_)/i.test(name)));
}

/**
 * The lines the diff `after` adds that the diff `before` did not already add, as a diff of added lines: what
 * the builder wrote, without the change the trial began with.
 */
export function addedSince(before: string, after: string): string {
  const isAdded = (line: string) => line.startsWith("+") && !line.startsWith("+++");
  const had = new Set(before.split("\n").filter(isAdded));
  return after
    .split("\n")
    .filter((line) => isAdded(line) && !had.has(line))
    .join("\n");
}

/**
 * What in the builder's changes points outside the repository, from the lines a diff adds: an absolute
 * path, a climb of two or more folders, or a word that names the lab. Empty when there is nothing.
 */
export function changeProblems(diff: string): string[] {
  const added = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  const problems: string[] = [];
  if (/(^|[\s"'`(=])([a-zA-Z]:[\\/]|\/(home|Users|mnt|tmp|etc|var)\/|~\/|\\\\)/m.test(added)) {
    problems.push("an added line holds an absolute path");
  }
  if (/\.\.[\\/]\.\.[\\/]/.test(added)) problems.push("an added line climbs two or more folders up");
  if (/process\.env|homedir\(|os\.tmpdir|child_process/.test(added)) {
    problems.push("an added line reaches for the environment, the home folder or another process");
  }
  const words = telltales(added);
  if (words.length) problems.push(`an added line holds a word that names the lab (${words.length})`);
  return problems;
}
