/**
 * The guard's checks for file edits, MCP tools and links, and the deny they end with.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { copyOutEdit } from "../answer-key/copies.ts";
import { PRIVATE_ID_REASON, privateRoot } from "../answer-key/private-ids.ts";
import { gitFolderEdit } from "../self/git-hooks.ts";
import { selfFileEdit } from "../self/own-files.ts";
import { telltales } from "../shared/harness-bridge.ts";
import {
  checkoutAt,
  esc,
  existingFolder,
  inCheckout,
  LAB_ROOT,
  linkPattern,
  locate,
  type Reviewed,
  within,
} from "../shared/repos.ts";
import { outsidePostedText, postedArguments, STDIN_BODY, stringsIn } from "../shell/posted.ts";
import { joinedWords, wordThen } from "../shell/scan.ts";
import { doorReason, mcpReads } from "./door.ts";
import { builtText, referencedFiles, stdinFiles } from "./posted-files.ts";

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
  // A git folder's hooks and config decide what git runs, so an edit there could switch the git-level guard off.
  const gitFolder = gitFolderEdit(path);
  if (gitFolder) deny(gitFolder);
  // Nor the guard's own files in the checkout it runs from.
  const self = selfFileEdit(path, ctx.env);
  if (self) deny(self);
  const text = [
    args.content,
    args.new_string,
    args.new_source,
    ...(args.edits ?? []).map((e: { new_string?: string }) => e.new_string),
  ]
    .filter(Boolean)
    .join("\n");
  // Nor a copy of the answer key, the audit log or a private template outside private storage.
  const copy = copyOutEdit(path, text, ctx.env);
  if (copy) deny(copy);
  // A private id belongs only in private storage, or in a folder no git checkout holds (a temp or scratch folder):
  // a file in any checkout could be committed and pushed under a clean message.
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
 * names neither the lab's folder nor a reviewed checkout's. A path written inside private storage whose
 * real place is elsewhere is a link out of private storage: never taken. Nor is a path whose file or a folder
 * on the way to it is a link that leads nowhere yet, whose place can't be read.
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
 * An MCP tool (one outside Bash and the file tools) is judged by its input as a whole: no MCP
 * input may name a private template, and one that names a reviewed repo may only read it. Writes to a reviewed
 * repo go through the door; the guard doesn't read what an MCP write would say.
 */
export function checkOtherTool(ctx: Context, tool: string, args: ToolInput) {
  // The input's own text, every string value on its own line: JSON escapes would hide a word after a line
  // break (`\nplanted`) from the word checks.
  const text = stringsIn(args).join("\n");
  if (ctx.names?.(text)) deny(PRIVATE_ID_REASON);
  const repo = ctx.reviewed.find((r) => new RegExp(`${esc(r.github)}|\\b${esc(r.name)}\\b`, "i").test(text));
  if (repo && !mcpReads(tool)) deny(doorReason(repo.name));
}

/**
 * Links only go one way: posts may name reviewed work as plain text ("target 3"), but never link to
 * one of `repos`' issues or PRs. A link would show on that repo's timeline, where its reviewer reads it.
 */
export function checkLinks(ctx: Context, command: string, repos: Reviewed[]) {
  // `--fill` in any form posts commit text the guard can't check: read where the shell reads flags.
  if (wordThen(joinedWords(outsidePostedText(command)), /\bgh\s+pr\s+create\b/, /\s--fill(-first|-verbose)?\b/)) {
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
