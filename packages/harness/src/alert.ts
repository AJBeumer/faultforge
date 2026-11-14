/**
 * Raises the lab's alert (#308): when CI on main fails, or a factory run ends with exit 2 or 3, one open issue
 * labelled `alert` per kind says so. A later alert of the same kind comments on that issue instead of opening
 * another, so a run of failures is one issue, not a flood. Run by `.github/workflows/alert.yml` with the lab's
 * own GITHUB_TOKEN (issues: write, that job only), by plain node, from a checkout with nothing installed:
 *
 *   node packages/harness/src/alert.ts <kind> <outcome>
 *
 * `kind` is `ci-main` or `factory`; `outcome` is one of that kind's fixed outcomes (a factory run's exit code).
 * The text is fixed words, the workflow's name and the run's URL, each checked against a strict shape. It never
 * holds a log line, a path or a ticket's text. It reads GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID,
 * GITHUB_RUN_ATTEMPT and GITHUB_WORKFLOW, which GitHub sets, and gh reads GH_TOKEN.
 *
 * Exit codes: 0 posted (a new alert issue, or a comment on the open one); 1 refused: an unknown kind or outcome,
 * or a workflow name or run that doesn't have the expected shape; 2 could not run: gh failed, or an unexpected
 * error.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The label every alert issue carries. */
export const LABEL = "alert";

interface Kind {
  title: string;
  outcomes: Record<string, string>;
}

/** Each kind's issue title and the outcomes it may report, in fixed words. */
export const KINDS: Record<string, Kind> = {
  "ci-main": { title: "Alert: CI on main failed", outcomes: { failure: "a job failed" } },
  factory: {
    title: "Alert: a factory run failed",
    outcomes: {
      "2": "exit 2: the tick could not set up",
      "3": "exit 3: the tick stopped with an error",
    },
  },
};

/** An alert that can't be raised as asked: a kind, outcome or run that isn't one of the fixed shapes. */
export class Refused extends Error {}

export interface Alert {
  title: string;
  body: string;
}

/** The alert's title and body, from fixed words and checked values only. */
export function alertText(kind: string, outcome: string, env: NodeJS.ProcessEnv): Alert {
  const known = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
  if (!known) throw new Refused(`unknown kind; expected one of ${Object.keys(KINDS).join(", ")}`);
  const said = Object.hasOwn(known.outcomes, outcome) ? known.outcomes[outcome] : undefined;
  if (!said)
    throw new Refused(`unknown outcome for ${kind}; expected one of ${Object.keys(known.outcomes).join(", ")}`);
  const shaped = (name: string, value: string | undefined, shape: RegExp) => {
    if (!value || !shape.test(value)) throw new Refused(`${name} is missing or not of the expected shape`);
    return value;
  };
  const workflow = shaped("GITHUB_WORKFLOW", env.GITHUB_WORKFLOW, /^[A-Za-z][\w .-]{0,59}$/);
  const server = shaped("GITHUB_SERVER_URL", env.GITHUB_SERVER_URL ?? "https://github.com", /^https:\/\/[\w.-]+$/);
  const repo = shaped("GITHUB_REPOSITORY", env.GITHUB_REPOSITORY, /^[\w.-]+\/[\w.-]+$/);
  const run = shaped("GITHUB_RUN_ID", env.GITHUB_RUN_ID, /^\d{1,20}$/);
  const attempt = shaped("GITHUB_RUN_ATTEMPT", env.GITHUB_RUN_ATTEMPT ?? "1", /^\d{1,4}$/);
  const url = `${server}/${repo}/actions/runs/${run}/attempts/${attempt}`;
  return { title: known.title, body: [`Workflow: ${workflow}`, `Run: ${url}`, `Outcome: ${said}`].join("\n") };
}

/** The issue calls an alert needs. */
export interface Issues {
  /** Open issues labelled `alert`: number and title. */
  openAlerts(): { number: number; title: string }[];
  comment(issue: number, body: string): void;
  create(title: string, body: string): void;
}

/**
 * Comments on the oldest open alert issue with the same title, or opens one when there is none. Returns what it
 * did.
 */
export function raise(alert: Alert, issues: Issues): { action: "commented" | "opened"; issue?: number } {
  const open = issues
    .openAlerts()
    .filter((issue) => issue.title === alert.title)
    .sort((a, b) => a.number - b.number)[0];
  if (open) {
    issues.comment(open.number, alert.body);
    return { action: "commented", issue: open.number };
  }
  issues.create(alert.title, alert.body);
  return { action: "opened" };
}

/** `Issues` through the gh CLI, for one repo. */
export function ghIssues(
  repo: string,
  gh: (args: string[]) => string = (args) => execFileSync("gh", args, { encoding: "utf8" }),
): Issues {
  return {
    openAlerts: () =>
      (
        JSON.parse(gh(["api", `repos/${repo}/issues?labels=${LABEL}&state=open&per_page=100`])) as {
          number: number;
          title: string;
          pull_request?: unknown;
        }[]
      )
        .filter((issue) => !issue.pull_request)
        .map(({ number, title }) => ({ number, title })),
    comment: (issue, body) => {
      gh(["issue", "comment", String(issue), "--repo", repo, "--body", body]);
    },
    create: (title, body) => {
      gh([
        "label",
        "create",
        LABEL,
        "--repo",
        repo,
        "--color",
        "B60205",
        "--description",
        "Raised by a failed run",
        "--force",
      ]);
      gh(["issue", "create", "--repo", repo, "--title", title, "--label", LABEL, "--body", body]);
    },
  };
}

/** Runs one alert; returns the exit code. */
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, issues?: Issues): number {
  const [kind = "", outcome = ""] = argv;
  let alert: Alert;
  try {
    alert = alertText(kind, outcome, env);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    console.error(`alert: refused: ${error.message}`);
    return 1;
  }
  try {
    const done = raise(alert, issues ?? ghIssues(env.GITHUB_REPOSITORY ?? ""));
    console.log(done.action === "commented" ? `alert: commented on #${done.issue}` : "alert: opened an alert issue");
    return 0;
  } catch (error) {
    console.error(`alert: could not post: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`alert: could not run: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
