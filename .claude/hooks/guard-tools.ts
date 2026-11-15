/**
 * The guard's checks for file edits, MCP tools and links, and the deny they end with. Split from
 * guard-target.ts, which may not pass 400 lines (CLAUDE.md, module size rule).
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { telltales } from "../../packages/harness/src/neutral.ts";
import { builtText, referencedFiles, stdinFiles } from "./guard-files.ts";
import { gitFolderEdit } from "./guard-hooks.ts";
import { outsidePostedText, postedArguments, STDIN_BODY, stringsIn } from "./guard-posted.ts";
import { PRIVATE_ID_REASON, privateRoot } from "./guard-private.ts";
import {
  checkoutAt,
  esc,
  existingFolder,
  inCheckout,
  LAB_ROOT,
  linkPattern,
  locate,
  type Reviewed,
  stripReviewedNames,
  within,
} from "./guard-repos.ts";
import { joinedWords } from "./shell-scan.ts";

/** What one decision is made against: the folder the tool runs in, the repos under guard, and the environment. */
export interface Context {
  cwd: string;
  reviewed: Reviewed[];
  env: NodeJS.ProcessEnv;
  /** A test for private template ids, read once per decision; undefined where there are none. */
  names: ((text: string) => boolean) | undefined;
  /** True for bash, where a backtick runs a command; PowerShell reads it as an escape. */
  backticks: boolean;
}

/** A tool's input as parsed from the payload: whatever Claude Code sent. */
export type ToolInput = ReturnType<typeof JSON.parse>;

/** Thrown by `deny()` and turned into a deny decision by `decide()`. */
export class Denied extends Error {}

/** Ends the check with a deny; `decide()` turns it into the decision. */
export function deny(reason: string): never {
  throw new Denied(reason);
}

export function checkFileEdit(ctx: Context, args: ToolInput) {
  const path = resolve(ctx.cwd, String(args.file_path ?? args.notebook_path ?? ""));
  // A git folder's hooks and config decide what git runs: no edit there could keep the git-level guard (re-grade 6).
  const gitFolder = gitFolderEdit(path);
  if (gitFolder) deny(gitFolder);
  const text = [
    args.content,
    args.new_string,
    args.new_source,
    ...(args.edits ?? []).map((e: { new_string?: string }) => e.new_string),
  ]
    .filter(Boolean)
    .join("\n");
  // A private id belongs only in private storage, or in a folder no git checkout holds (a temp or scratch folder;
  // #318): a file in any checkout could be committed and pushed under a clean message (Qodo on PR 265).
  if (ctx.names?.(text) && !within(path, privateRoot(ctx.env)) && !outsideEveryCheckout(ctx, path)) {
    deny(PRIVATE_ID_REASON);
  }
  const repo = ctx.reviewed.find((r) => inCheckout(path, r)) ?? locate(existingFolder(path), ctx.reviewed);
  if (!repo) return;
  const found = telltales(text);
  if (found.length) {
    deny(
      `This edit would put a hint into ${repo.name} (${found.join(", ")}). Keep its files free of any mention of the lab.`,
    );
  }
}

/**
 * True when no git checkout holds the file, as written or where its folder really is (through a link), and it
 * names neither the lab's folder nor a reviewed checkout's (#318). A path written inside private storage whose
 * real place is elsewhere is a link out of private storage: never taken (Qodo on PR 265). Nor is a path whose
 * file or a folder on the way to it is a link that leads nowhere yet, whose place can't be read (Qodo on PR 323).
 */
function outsideEveryCheckout(ctx: Context, path: string): boolean {
  const priv = resolve(privateRoot(ctx.env));
  const rel = relative(priv, path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return false;
  if (ctx.reviewed.some((r) => inCheckout(path, r))) return false;
  // By name too, as reviewed checkouts are found: a lab folder that isn't there yet is still the lab.
  const labNames = new Set(["faultforge", basename(LAB_ROOT).toLowerCase()]);
  if (path.split(/[\\/]/).some((part) => labNames.has(part.toLowerCase())) || within(path, LAB_ROOT)) return false;
  for (let part = path; ; part = dirname(part)) {
    let link = false;
    let exists = true;
    try {
      link = lstatSync(part).isSymbolicLink();
    } catch {
      exists = false;
    }
    if (link) return false;
    if (exists || dirname(part) === part) break;
  }
  const folder = existingFolder(path);
  let real = folder;
  try {
    real = realpathSync.native(folder);
  } catch {
    return false;
  }
  return checkoutAt(folder) === undefined && checkoutAt(real) === undefined;
}

/**
 * An MCP tool (one outside Bash and the file tools) is judged by its input as a whole (AUD-N9): no MCP
 * input may name a private template, and when one names a reviewed repo nothing in it may give the lab away.
 */
export function checkOtherTool(ctx: Context, tool: string, args: ToolInput) {
  // The input's own text, every string value on its own line: JSON escapes would hide a word after a line
  // break (`\nplanted`) from the word checks (Qodo on PR 265).
  const text = stringsIn(args).join("\n");
  if (ctx.names?.(text)) deny(PRIVATE_ID_REASON);
  const repo = ctx.reviewed.find((r) => new RegExp(`${esc(r.github)}|\\b${esc(r.name)}\\b`, "i").test(text));
  if (!repo) return;
  const found = telltales(stripReviewedNames(ctx.reviewed, text));
  if (found.length) deny(`${tool} would put a hint into ${repo.name} (${found.join(", ")}).`);
}

/**
 * Links only go one way: posts may name reviewed work as plain text ("target 3"), but never link to
 * one of `repos`' issues or PRs. A link would show on that repo's timeline, where its reviewer reads it.
 */
export function checkLinks(ctx: Context, command: string, repos: Reviewed[]) {
  // `--fill` in any form posts commit text the guard can't check (AUD-N9): read where the shell reads flags.
  if (/\bgh\s+pr\s+create\b[^|;&\n]*\s--fill(-first|-verbose)?\b/.test(joinedWords(outsidePostedText(command)))) {
    deny("gh pr create --fill posts commit text the guard can't check. Pass --title and --body instead.");
  }
  const posted = postedArguments(command);
  // Text read from stdin (a pipe or heredoc) or built from shell variables is in the command
  // itself, not in the extracted arguments, so check the whole command for those.
  const indirect = STDIN_BODY.test(command) || posted.some((p) => /[$`]/.test(p));
  const written = indirect ? command : posted.join("\n");
  const files = [
    ...referencedFiles(ctx.cwd, command),
    ...stdinFiles(ctx.cwd, command),
    ...builtText(ctx.cwd, command, false, ctx.backticks),
  ];
  const text = [written, joinedWords(written), ...files].join("\n");
  const linked = repos.find((r) => linkPattern([r])?.test(text));
  if (linked) {
    deny(
      `This would link to the target (${linked.name}) from here, and it would show that on its timeline. Name the work as plain text instead, like "target 3".`,
    );
  }
}
