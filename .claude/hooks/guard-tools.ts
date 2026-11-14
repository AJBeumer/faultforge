/**
 * The guard's checks for file edits, MCP tools and links, and the deny they end with. Split from
 * guard-target.ts, which may not pass 400 lines (CLAUDE.md, module size rule).
 */
import { resolve } from "node:path";
import { telltales } from "../../packages/harness/src/neutral.ts";
import { builtText, referencedFiles, stdinFiles } from "./guard-files.ts";
import { outsidePostedText, postedArguments, STDIN_BODY, stringsIn } from "./guard-posted.ts";
import { PRIVATE_ID_REASON, privateRoot } from "./guard-private.ts";
import {
  esc,
  existingFolder,
  inCheckout,
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
  const text = [
    args.content,
    args.new_string,
    args.new_source,
    ...(args.edits ?? []).map((e: { new_string?: string }) => e.new_string),
  ]
    .filter(Boolean)
    .join("\n");
  // A private id belongs only in private storage: a file anywhere else could be committed and pushed under a
  // clean message (Qodo on PR 265).
  if (ctx.names?.(text) && !within(path, privateRoot(ctx.env))) deny(PRIVATE_ID_REASON);
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
