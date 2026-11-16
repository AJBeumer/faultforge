/**
 * The one door for every write to the reviewed repository (#340). It builds the request itself, checks the exact
 * text it is about to send, and sends it with `gh` or `git`. The guard hook refuses every other write aimed at that
 * repository, so text this command doesn't send can't reach the reviewer, however it is spelled or built.
 *
 *   npm run target:post -- issue-create  --title-file <f> --body-file <f>
 *   npm run target:post -- issue-edit    --number <n> [--title-file <f>] [--body-file <f>]
 *   npm run target:post -- issue-comment --number <n> --body-file <f>
 *   npm run target:post -- pr-create     --head <branch> [--base main] --title-file <f> --body-file <f>
 *   npm run target:post -- pr-edit       --number <n> [--title-file <f>] [--body-file <f>]
 *   npm run target:post -- pr-comment    --number <n> --body-file <f>
 *   npm run target:post -- pr-close      --number <n> --body-file <f>     (closes with that comment)
 *   npm run target:post -- push          --branch <name> [--checkout <path>]
 *
 * One more kind, `label`, has no command: only the factory's runner moves a ticket's labels, with `sendPost` (#345).
 * A label post adds its labels in one edit, then removes each of the others on its own. Each label name is checked
 * like any text, and must be one plain line of at most 50 characters with no comma, which gh would split in two.
 *
 * Every kind takes `--repo owner/name`, which must be a repo `factory.json` marks `"guard": "reviewed"`; without it,
 * the one reviewed repo, refused when there are several. Text comes only from files, read as UTF-8; a title is
 * one line. A push sends the branch's commit from `--checkout` (by default the repo's checkout in `factory.json`) to
 * its origin, never forced.
 *
 * The checks, on each piece on its own: the giveaway words (`neutral.ts`'s `telltales`), a private template's id,
 * and words addressed to Qodo. A push's pieces are its branch name and, for every commit the remote doesn't have,
 * the commit's author, committer and message, and every added or changed file's path and content
 * (`target-post-push.ts`). The body goes to `gh` on stdin (`--body-file -`), so what is checked is what is sent.
 *
 * During a factory run the door sends only push, pr-create and pr-edit, unless the runner's own key comes with the
 * post (`target-post-run.ts`, #347): the check is in `sendPost`, so it holds however the door is called.
 *
 * Exit codes: 0 sent; 1 usage: an unknown kind or option, a missing or unreadable text file, a title that isn't one
 * line, or a repo that isn't a reviewed one; 2 refused: a check found something, what would be sent couldn't be
 * read to check it, or a factory run is active and the kind isn't one its agent may use, so nothing was sent; 3 the send failed: `gh` or `git` failed after the checks passed (check
 * GitHub before retrying: a write that failed may still have landed). An unexpected error, even while loading, is 2
 * too: `npm run target:post` runs `target-post-cli.ts`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PRIVATE_ID_REASON, privateIdMatcher, privateTemplateIds } from "../../../.claude/hooks/guard-private.ts";
import { type Reviewed, reviewedRepos } from "../../../.claude/hooks/guard-repos.ts";
import { addressesQodo, telltales } from "./neutral.ts";
import { branchNameProblem, type Git, pushArgs, readPush } from "./target-post-push.ts";
import { runGateRefusal } from "./target-post-run.ts";

// The door imports only the guard's own files (guard-self.ts holds them) and Node's: a module it imported that a
// session could rewrite would decide what the door sends (Qodo on PR 344). It reads the reviewed repos the way the
// guard does, from factory.json with the target always among them, and runs with node, not a package's runner.

/** An error's message, or the thrown value as text. */
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const KINDS = [
  "issue-create",
  "issue-edit",
  "issue-comment",
  "pr-create",
  "pr-edit",
  "pr-comment",
  "pr-close",
  "push",
  "label",
] as const;
export type Kind = (typeof KINDS)[number];

/**
 * The kinds the command takes. `label` isn't one: only the factory's runner moves a ticket's labels, through
 * `sendPost` (`ticket-write.ts`), and a command an agent could run would let it move them itself (Qodo on PR 346).
 */
export const COMMAND_KINDS = KINDS.filter((k): k is Exclude<Kind, "label"> => k !== "label");
type CommandKind = (typeof COMMAND_KINDS)[number];

/** One write to the reviewed repository, with its text already read. */
export interface Post {
  kind: Kind;
  repo: string;
  number?: number;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  branch?: string;
  checkout?: string;
  /** A label post's labels to add, then to remove. */
  add?: string[];
  remove?: string[];
}

/** Runs `gh` with `args`, `input` on its stdin, and returns stdout; throws when gh fails. */
export type Gh = (args: string[], input?: string) => string;

export interface Deps {
  gh?: Gh;
  git?: Git;
  env?: NodeJS.ProcessEnv;
  /** The run marker to read instead of the fixed one: for tests that simulate a run. */
  runMarker?: string;
  /** The run's runner key: the runner's own writes during a run (`ticket-write.ts`), never the agent's. */
  runnerKey?: string;
}

/** Thrown when a check finds something, or what would be sent can't be read: nothing was sent (exit 2). */
export class Refused extends Error {}
/** Thrown when gh or git failed after the checks passed (exit 3). Its `cause` is gh's or git's own error. */
export class SendFailed extends Error {}

/** gh with no host or repo from the environment: the post names github.com and the repo itself. */
const realGh: Gh = (args, input) => {
  const { GH_HOST: _host, GH_REPO: _repo, ...env } = process.env;
  return execFileSync("gh", args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env,
    ...(input === undefined ? {} : { input }),
  });
};
const realGit: Git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });

/** The problems with each piece, as `label: reason`; empty when every piece reads as an ordinary change. */
export function textProblems(pieces: [string, string][], env: NodeJS.ProcessEnv = process.env): string[] {
  const named = privateIdMatcher(privateTemplateIds(env));
  return pieces.flatMap(([label, text]) => [
    ...telltales(text).map((reason) => `${label}: ${reason}`),
    ...(named?.(text) ? [`${label}: names a private template`] : []),
    ...(addressesQodo(text) ? [`${label}: addresses Qodo`] : []),
  ]);
}

/** The texts a post sends, by label: its title, body and branch names. A push reads its own from git. */
function postPieces(post: Post): [string, string][] {
  const pieces: [string, string | undefined][] = [
    ["title", post.title],
    ["body", post.body],
    ["head branch", post.head],
    ["base branch", post.base],
    ...labelsOf(post).map((name, i): [string, string] => [`label ${i + 1}`, name]),
  ];
  return pieces.filter((piece): piece is [string, string] => piece[1] !== undefined);
}

/** A label post's names, added ones first. */
const labelsOf = (post: Post) => [...(post.add ?? []), ...(post.remove ?? [])];

/** What is wrong with a label post's names as names, before their words are checked; the names aren't repeated. */
function labelShapeProblems(post: Post): string[] {
  if (post.kind !== "label") return [];
  const names = labelsOf(post);
  if (!names.length) return ["a label post must add or remove at least one label"];
  const problems = names.flatMap((name, i) => {
    if (!name.trim()) return [`label ${i + 1}: is blank`];
    // gh splits --add-label on commas, so `a,b` would add two labels, one of them unchecked as a name of its own.
    if (/[,\p{Cc}]/u.test(name)) return [`label ${i + 1}: has a comma or a control character`];
    return [...name].length > 50 ? [`label ${i + 1}: is longer than GitHub's 50 characters`] : [];
  });
  const both = (post.add ?? []).filter((name) => post.remove?.includes(name));
  return both.length ? [...problems, "a label can't be both added and removed"] : problems;
}

/** The gh calls for a label post: one edit that adds every label, then one REST delete for each removal. */
export function labelCalls(post: Post): { args: string[] }[] {
  const add = post.add ?? [];
  return [
    ...(add.length
      ? [
          {
            args: [
              "issue",
              "edit",
              String(post.number),
              "--repo",
              `github.com/${post.repo}`,
              ...add.flatMap((name) => ["--add-label", name]),
            ],
          },
        ]
      : []),
    ...(post.remove ?? []).map((name) => ({
      args: [
        "api",
        "--hostname",
        "github.com",
        "-X",
        "DELETE",
        `repos/${post.repo}/issues/${post.number}/labels/${encodeURIComponent(name)}`,
      ],
    })),
  ];
}

/** The gh call for a post that isn't a push, and the body it reads on stdin. */
export function ghCall(post: Post): { args: string[]; input?: string } {
  const [group, verb] = post.kind.split("-") as [string, string];
  const args = [group, verb];
  if (post.number !== undefined) args.push(String(post.number));
  // The host named too: gh would otherwise take it from GH_HOST or its config.
  args.push("--repo", `github.com/${post.repo}`);
  if (post.kind === "pr-create") args.push("--base", post.base ?? "main", "--head", post.head ?? "");
  if (post.title !== undefined) args.push("--title", post.title);
  if (post.kind === "pr-close") return { args: [...args, "--comment", post.body ?? ""] };
  return post.body === undefined ? { args } : { args: [...args, "--body-file", "-"], input: post.body };
}

/**
 * Checks a post and, when every piece passes, sends it. Returns what gh or git printed (an issue or PR URL for a
 * create). Throws `Refused` before anything is sent, or `SendFailed` when the send itself failed.
 */
export function sendPost(post: Post, deps: Deps = {}): string {
  const env = deps.env ?? process.env;
  const gate = runGateRefusal(post.kind, { marker: deps.runMarker, runnerKey: deps.runnerKey });
  if (gate) throw new Refused(refusal([gate]));
  if (post.kind === "push") {
    const git = deps.git ?? realGit;
    const checkout = post.checkout ?? "";
    const branch = post.branch ?? "";
    const plan = readPush(checkout, branch, post.repo, git);
    const problems = [...plan.problems, ...textProblems(plan.pieces, env)];
    if (problems.length || !plan.url || !plan.commit) throw new Refused(refusal(problems));
    try {
      return git(checkout, pushArgs({ url: plan.url, commit: plan.commit }, branch));
    } catch (error) {
      throw new SendFailed(`git push failed: ${errorText(error)}`, { cause: error });
    }
  }
  const problems = postProblems(post, env);
  if (problems.length) throw new Refused(refusal(problems));
  const calls: { args: string[]; input?: string }[] = post.kind === "label" ? labelCalls(post) : [ghCall(post)];
  const out: string[] = [];
  for (const { args, input } of calls) {
    try {
      out.push((deps.gh ?? realGh)(args, input));
    } catch (error) {
      // A label post that fails part-way says what already went: the labels added stay added.
      const done = out.length ? ` (after ${out.length} of ${calls.length} calls went through)` : "";
      throw new SendFailed(`gh ${args.slice(0, 2).join(" ")} failed${done}: ${errorText(error)}`, { cause: error });
    }
  }
  return out.join("");
}

/** The problems a post's own text has, without sending it: a caller can refuse before it records an attempt. */
export function postProblems(post: Post, env: NodeJS.ProcessEnv = process.env): string[] {
  // A head or base must be a plain branch of the reviewed repo: `owner:branch` would open a PR from a fork,
  // whose commits never went through the door's push checks.
  const branches = [post.head, post.base].flatMap((name) => {
    const problem = name === undefined ? undefined : branchNameProblem(name);
    return problem ? [problem] : [];
  });
  return [...branches, ...labelShapeProblems(post), ...textProblems(postPieces(post), env)];
}

function refusal(problems: string[]): string {
  // A private id is never repeated, not even in the reason (it could be a file name or a branch).
  const shown = problems.map((p) => (/names a private template$/.test(p) ? PRIVATE_ID_REASON : p));
  return `refused, nothing was sent to the reviewed repository:\n${[...new Set(shown)].map((p) => `- ${p}`).join("\n")}`;
}

/** Thrown for a command line or input that can't make a post (exit 1). */
class Usage extends Error {}

/** A text file's content as UTF-8, refusing bytes that aren't: what is checked must be what is sent. */
function readText(path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new Usage(`can't read ${path} as UTF-8 text: ${errorText(error)}`);
  }
}

function readTitle(path: string): string {
  const title = readText(path).replace(/\r?\n$/, "");
  if (!title.trim() || /[\r\n]/.test(title)) throw new Usage(`the title in ${path} must be one non-blank line`);
  return title;
}

/**
 * The post a command line asks for, its text read from its files, to the one of `reviewed` that `--repo`
 * names, or the only one. Throws `Usage` when it can't make one.
 */
export function parsePost(argv: string[], reviewed: Reviewed[]): Post {
  const [kind, ...rest] = argv;
  if (!COMMAND_KINDS.includes(kind as CommandKind))
    throw new Usage(`the first word must be one of: ${COMMAND_KINDS.join(", ")}`);
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args: rest,
      strict: true,
      options: Object.fromEntries(
        ["repo", "number", "title-file", "body-file", "head", "base", "branch", "checkout"].map((o) => [
          o,
          { type: "string" as const },
        ]),
      ),
    }).values as Record<string, string | undefined>;
  } catch (error) {
    throw new Usage(errorText(error));
  }
  // With more than one reviewed repo, a post names its own: a default could send it to the wrong one (Qodo on PR 344).
  const target = values.repo
    ? reviewed.find((r) => r.github.toLowerCase() === values.repo?.toLowerCase())
    : reviewed.length === 1
      ? reviewed[0]
      : undefined;
  if (!target) throw new Usage(`--repo must name a reviewed repo: ${reviewed.map((r) => r.github).join(", ")}`);
  const post: Post & { kind: CommandKind } = { kind: kind as CommandKind, repo: target.github };
  const allowed: Record<CommandKind, string[]> = {
    "issue-create": ["title-file", "body-file"],
    "issue-edit": ["number", "title-file", "body-file"],
    "issue-comment": ["number", "body-file"],
    "pr-create": ["head", "base", "title-file", "body-file"],
    "pr-edit": ["number", "title-file", "body-file"],
    "pr-comment": ["number", "body-file"],
    "pr-close": ["number", "body-file"],
    push: ["branch", "checkout"],
  };
  const extra = Object.keys(values).filter((o) => o !== "repo" && !allowed[post.kind].includes(o));
  if (extra.length) throw new Usage(`${post.kind} takes no --${extra.join(", --")}`);
  const needs = (option: string) => {
    if (!values[option]) throw new Usage(`${post.kind} needs --${option}`);
  };
  if (allowed[post.kind].includes("number")) {
    needs("number");
    post.number = Number(values.number);
    if (!Number.isInteger(post.number) || post.number < 1) throw new Usage("--number must be a whole number above 0");
  }
  if (["issue-create", "pr-create"].includes(post.kind)) needs("title-file");
  if (!/-edit$|^push$/.test(post.kind)) needs("body-file");
  if (/-edit$/.test(post.kind) && !values["title-file"] && !values["body-file"]) {
    throw new Usage(`${post.kind} needs --title-file or --body-file`);
  }
  if (values["title-file"]) post.title = readTitle(values["title-file"]);
  if (values["body-file"]) post.body = readText(values["body-file"]);
  if (post.kind === "pr-create") {
    needs("head");
    post.head = values.head;
    post.base = values.base ?? "main";
  }
  if (post.kind === "push") {
    needs("branch");
    post.branch = values.branch;
    post.checkout = resolve(values.checkout ?? target.checkout);
  }
  return post;
}

/** The command: `target-post-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(
  argv: string[],
  deps: Deps & { reviewed?: Reviewed[]; log?: (line: string) => void; error?: (line: string) => void } = {},
): number {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  let post: Post;
  try {
    post = parsePost(argv, deps.reviewed ?? reviewedRepos(process.env.FAULTFORGE_CONFIG));
  } catch (e) {
    if (!(e instanceof Usage)) throw e;
    error(`target:post: ${e.message}`);
    error("usage: npm run target:post -- <kind> [options]   (kinds and options: target-post.ts's header)");
    return 1;
  }
  try {
    const out = sendPost(post, deps).trim();
    log(out ? out : `target:post: ${post.kind} sent to ${post.repo}`);
    return 0;
  } catch (e) {
    if (e instanceof Refused) {
      error(`target:post: ${post.kind} ${e.message}`);
      return 2;
    }
    if (e instanceof SendFailed) {
      error(`target:post: ${e.message}. Check GitHub before retrying: it may have landed.`);
      return 3;
    }
    throw e;
  }
}
