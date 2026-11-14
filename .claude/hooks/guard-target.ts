/**
 * Claude Code PreToolUse hook. Keeps the reviewed repositories free of hints for the reviewer.
 *
 * The reviewed repos are the ones with `"guard": "reviewed"` in `factory.json`. For each, it blocks:
 *  - force pushes, and pushes that delete or mirror
 *  - commits, pushes, PRs, comments and API writes whose text, or whose posted files, name the lab or the bug
 *  - file edits by the Edit and Write tools whose new content does the same
 *  - any `git commit` or `git push`, wherever it runs, while a reviewed checkout holds pending content
 *    (staged, unstaged or untracked for a commit; unpushed commits for a push) that names the lab or the bug.
 *    Shell text can't show what a redirect, a copy or a script wrote, so the content is read from git at
 *    the moment it would travel. That is the guarantee; the text checks are the early warning.
 * A command is "in" a reviewed repo when it names the repo as a destination, moves into its checkout
 * (cd, pushd, Set-Location, git -C, git --work-tree, GIT_DIR=), or runs from inside it. A checkout is
 * recognised by its folder name or by a remote that points at the repo (guard-repos.ts).
 * Everywhere else it blocks issues, PRs and commit messages that link to a reviewed repo, and every post,
 * to any repo but private storage, that names a template still held in private storage (guard-private.ts).
 *
 * `decide()` takes the hook payload as text and returns the decision without printing or exiting, so the
 * tests call it in-process. Run as `node <this file>`, `main()` reads the payload from stdin and answers:
 * a deny decision as JSON, nothing to allow, or exit 2 with one line on stderr when it couldn't check.
 * Claude Code runs it through fail-closed.ts, which also turns a crash, a broken import or a timeout into
 * exit 2.
 *
 * Exit codes: 0 answered (a deny decision on stdout, or nothing to allow); 2 couldn't check, so refused.
 */
import { telltales } from "../../packages/harness/src/neutral.ts";
import { chainProblem, DEFAULT_BUDGET_MS, withDeadline, withPrivateNames, writerStep } from "./guard-content.ts";
import {
  aliasProblem,
  shellReading,
  UnknownRepository,
  unreadableDestination,
  unreadablePost,
} from "./guard-expand.ts";
import { BuiltText, builtText, referencedFiles, stdinFiles, Unreadable } from "./guard-files.ts";
import { pendingProblem } from "./guard-pending.ts";
import { commitMessages, commitSteps, outsidePostedText, postedText } from "./guard-posted.ts";
import {
  onlyPrivateRepo,
  PRIVATE_ID_REASON,
  privateIdMatcher,
  privateRoot,
  privateTemplateIds,
} from "./guard-private.ts";
import {
  explicitDestinations,
  graphqlMutation,
  isWrite,
  rawApiWrite,
  rewritesHistory,
  skipsGitGuard,
  urlDestinations,
} from "./guard-reach.ts";
import {
  entersCheckout,
  locate,
  MAX_MOVES,
  moveCount,
  navigatesInto,
  navigationTargets,
  type Reviewed,
  reviewedRepos,
  stripReviewedNames,
} from "./guard-repos.ts";
import {
  type Context,
  checkFileEdit,
  checkLinks,
  checkOtherTool,
  Denied,
  deny,
  type ToolInput,
} from "./guard-tools.ts";
import { ALLOW, type Decision, firstLine, hookAnswer, isEntry, readStdin, respond } from "./hook-io.ts";
import { blankQuoted, joinedWords, MAX_COMMAND_CHARS } from "./shell-scan.ts";

/**
 * The decision's time budget. `FAULTFORGE_GUARD_BUDGET_MS` may shorten it, for tests, never lengthen it past the
 * default, which keeps clear of the hook's 15 s (Qodo on PR 233).
 */
export function guardBudget(env: NodeJS.ProcessEnv): number {
  const asked = Number(env.FAULTFORGE_GUARD_BUDGET_MS);
  return Number.isFinite(asked) && asked !== 0 ? Math.min(asked, DEFAULT_BUDGET_MS) : DEFAULT_BUDGET_MS;
}

/**
 * The decision for one hook payload. Fails closed: an exception (unreadable input, a body file that is a
 * folder) is a blocking error, never an allow, because Claude Code treats a hook that crashes as a
 * non-blocking error and runs the tool anyway. `env` supplies `FAULTFORGE_CONFIG` and `FAULTFORGE_PRIVATE_DIR`.
 */
export function decide(stdin: string, env: NodeJS.ProcessEnv = process.env): Decision {
  let names: ((text: string) => boolean) | undefined;
  try {
    // A word list that finds nothing in its own example has been emptied or broken: nothing can be checked.
    if (!telltales("a planted bug").length) throw new Error("the giveaway word list finds nothing; it is broken");
    const input = JSON.parse(stdin);
    const tool = String(input.tool_name ?? "");
    const args: ToolInput = input.tool_input ?? {};
    const cwd = String(input.cwd ?? process.cwd());
    names = privateIdMatcher(privateTemplateIds(env));
    const reviewed = reviewedRepos(env.FAULTFORGE_CONFIG);
    const ctx: Context = { cwd, reviewed, env, names, backticks: tool !== "PowerShell" };
    // One deadline for the whole decision, every scan in it included (audit N-4).
    // Pending content may not carry a private id either (Qodo on PR 265).
    withDeadline(guardBudget(env), () =>
      withPrivateNames(names, () => {
        if (tool === "Bash" || tool === "PowerShell") {
          checkShell(ctx, String(args.command ?? ""));
        } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
          checkFileEdit(ctx, args);
        } else if (tool.startsWith("mcp__")) {
          checkOtherTool(ctx, tool, args);
        }
      }),
    );
    return ALLOW;
  } catch (error) {
    if (
      error instanceof Denied ||
      error instanceof Unreadable ||
      error instanceof BuiltText ||
      error instanceof UnknownRepository
    ) {
      // A reason that quotes a file or branch name could repeat a private id: it never does (Qodo on PR 265).
      return { kind: "deny", reason: names?.(error.message) ? PRIVATE_ID_REASON : error.message };
    }
    return failed(error);
  }
}

/** The hook's own failure as a blocking error: the tool call is refused, never let through. */
function failed(error: unknown): Decision {
  return {
    kind: "error",
    message: `guard-target hook failed: ${firstLine(error)}. The action is refused: a hook that can't check lets nothing through. Fix the hook or the input; don't work around it.`,
  };
}

/**
 * True when the command runs more than one command: `;`, `&&`, `||`, `|`, a background `&`, a new
 * line, or a command substitution. Quoted text and heredoc bodies may hold those characters as plain
 * text, so they are ignored, except double-quoted text that runs `$(...)` or backticks.
 */
function isChained(command: string): boolean {
  return /;|&&|\|\||\||(?<![&>])&(?![&>])|\n|\$\(|`/.test(blankQuoted(command).trim());
}

/**
 * Every text a command would post, each judged on its own: the command itself (as written and with its
 * quote marks joined), flag values, heredoc bodies, posted files, and files a substitution reads. A commit
 * joins every `-m` and `-F` into one message, so those are also judged together. With `strict`, text built by
 * any other command is refused (#242): everywhere in a post to a reviewed repo, and in the posted values of a
 * lab post while private templates exist (`everywhere` false; #285).
 */
function postedPieces(ctx: Context, command: string, strict = false, everywhere = strict): string[] {
  const pieces = [stripReviewedNames(ctx.reviewed, command), stripReviewedNames(ctx.reviewed, joinedWords(command))];
  pieces.push(...postedText(command), ...referencedFiles(ctx.cwd, command), ...stdinFiles(ctx.cwd, command));
  pieces.push(...builtText(ctx.cwd, command, strict, ctx.backticks, everywhere));
  for (const commit of commitSteps(command)) {
    pieces.push([...commitMessages(commit), ...referencedFiles(ctx.cwd, commit)].join("\n"));
  }
  // A GraphQL mutation names itself with the keyword `mutation`, which is not a hint; the text it posts is.
  // Only the operation keyword, where a query starts: a body's own "mutation" still counts (Qodo on PR 266).
  const keyword = /((?:\bquery["']?\s*[=:]\s*["']?|^["']?)\s*)mutation(?=\s*[\w({])/;
  return graphqlMutation(command) ? pieces.map((piece) => piece.replace(keyword, "$1 ")) : pieces;
}

/**
 * No post anywhere but private storage may name a template that is still private (AUD-H1): not to a
 * reviewed repo, and not to the lab, whose PRs the reviewer can read too. The id is never printed.
 */
function checkPrivateIds(ctx: Context, command: string, readable: boolean) {
  const names = ctx.names;
  // Where the post goes, read as the shell reads it, so a fake --repo in a body can't claim private storage.
  const outside = outsidePostedText(command);
  const real = [...explicitDestinations(outside), ...urlDestinations(outside)];
  // A destination must really be named (outside posted text), and none, in either reading, may be public.
  const destinations = real.length ? [...explicitDestinations(command), ...real] : [];
  if (!names || onlyPrivateRepo(command, ctx.cwd, privateRoot(ctx.env), destinations)) return;
  // Read as strictly as a post to a reviewed repo (#285): text a program builds (printf, base64) or a variable
  // the command doesn't set can't be checked for an id, so it isn't posted.
  if (readable && unreadablePost(command)) deny(UNREADABLE_VARIABLE);
  if ([command, joinedWords(command), ...postedPieces(ctx, command, true, false)].some(names)) deny(PRIVATE_ID_REASON);
}

/** The denial for a post whose text is a shell variable the command doesn't set. */
const UNREADABLE_VARIABLE =
  "This post's text comes from a shell variable the command doesn't set, so the guard can't read it. Write the text in the command, or in a file passed with --body-file.";

/**
 * A shell command, judged as written and as the shell would read it (#285): ANSI-C strings decoded, the
 * command's own variables expanded, repository ids named. Both must pass. Only the shell's reading is
 * `readable`: a variable left in it is one the command doesn't set.
 */
function checkShell(ctx: Context, command: string) {
  const alias = aliasProblem(command);
  if (alias) deny(alias);
  if (command.length > MAX_COMMAND_CHARS) return checkCommand(ctx, command, true);
  const read = shellReading(command);
  const readAlias = aliasProblem(read);
  if (readAlias) deny(readAlias);
  // A default repo set here sends later posts to a reviewed repo without naming it (#285).
  if (/\bgh\s+repo\s+set-default\b/.test(joinedWords(read))) {
    const here = locate(ctx.cwd, ctx.reviewed);
    const named = ctx.reviewed.find(
      (r) => explicitDestinations(read).includes(r.github.toLowerCase()) && here?.github !== r.github,
    );
    if (named) deny(`A default repo of ${named.name} here would send later posts there without naming it.`);
  }
  checkCommand(ctx, command, read === command);
  if (read !== command) checkCommand(ctx, read, true);
}

/** Every reviewed repo the command reaches, and how it reaches them. */
function reach(ctx: Context, command: string, writes: boolean) {
  const { cwd, reviewed } = ctx;
  // A destination named anywhere in the text, a GitHub URL outside its posted text, or a move into a
  // checkout, found by folder name or by remote. The folder the command runs in counts unless the command
  // really names another destination (say, a post from there to another repo, judged by where it goes).
  // "Really" means outside its posted text: `-R` or `--repo` inside a message names nothing. Both readings
  // are used, the strict one for what is touched, so text that confuses one can't hide a repo from both
  // (Qodo on PR 208). A GraphQL mutation can reach any repo.
  const outside = outsidePostedText(command);
  const urls = urlDestinations(outside);
  const destinations = [...explicitDestinations(command), ...urls];
  const realDestinations = [...explicitDestinations(outside), ...urls];
  const here = locate(cwd, reviewed);
  const entered = navigationTargets(command, cwd).flatMap((path) => locate(path, reviewed) ?? []);
  const enters = (r: Reviewed) => entersCheckout(command, r) || entered.some((e) => e.github === r.github);
  const isHere = (r: Reviewed) => here?.github === r.github;
  const mutation = writes && graphqlMutation(command);
  const touched = reviewed
    .filter(
      (r) =>
        mutation ||
        destinations.includes(r.github.toLowerCase()) ||
        enters(r) ||
        (!realDestinations.length && isHere(r)),
    )
    .map((r) => entered.find((e) => e.github === r.github) ?? (isHere(r) && here ? here : r));
  return { destinations, touched, mutation, isHere, runsIn: (r: Reviewed) => isHere(r) || enters(r) };
}

function checkCommand(ctx: Context, command: string, readable: boolean) {
  if (command.length > MAX_COMMAND_CHARS) {
    deny(
      `This command is ${command.length} characters, more than the ${MAX_COMMAND_CHARS} the guard reads. Write long text to a file and pass the file.`,
    );
  }
  // Each folder move costs a walk up the file system, so a command can't make the guard take thousands.
  if (moveCount(command) > MAX_MOVES) {
    deny(`This command moves between folders more than ${MAX_MOVES} times, more than the guard follows. Split it.`);
  }
  const writes = isWrite(command);
  if (writes && readable && unreadableDestination(command))
    deny("This write names its repo with a shell variable the command doesn't set. Name the repo as owner/name.");
  if (writes) checkPrivateIds(ctx, command, readable);
  const { destinations, touched, mutation, isHere, runsIn } = reach(ctx, command, writes);

  // Reading a shell command with patterns can't be complete, so a command that writes and involves
  // more than one repo must be split: each part then gets judged on its own. A chain that stays in
  // one repo (cd target && git add && git commit && git push) is fine.
  if (writes && isChained(command)) {
    const involved = new Set(destinations);
    for (const r of ctx.reviewed) if (runsIn(r)) involved.add(r.github.toLowerCase());
    if (involved.size > 1) {
      deny(
        "This command writes and involves more than one repo. Run the parts for different repos as separate commands.",
      );
    }
  }

  const repo = touched[0];
  if (!repo) {
    if (writes) checkLinks(ctx, command, ctx.reviewed);
    // Even from elsewhere, a commit or push is checked against every reviewed checkout's pending content.
    const pending = pendingProblem(ctx.reviewed, command, touched);
    if (pending) deny(pending);
    return;
  }

  if (skipsGitGuard(command)) {
    deny(`In ${repo.name}, git's own guard hooks must run: no --no-verify, no commit -n, and no other core.hooksPath.`);
  }
  // A flag from a variable the command doesn't set (`git push $FLAG`) could be --force (#285).
  if (rewritesHistory(command, readable)) {
    deny(
      `Force pushes to ${repo.name} are not allowed, nor pushes that delete or mirror: its history is evidence for recorded cases.`,
    );
  }
  if (rawApiWrite(command)) {
    deny(`Post to ${repo.name} with gh, where the guard can read the text, not with a raw API call.`);
  }

  // Inside a reviewed checkout, a chain that mentions git may hold only steps that can't change the
  // checkout's content behind the guard's back (it looks before the command runs): no copies, redirects,
  // scripts or shell functions in the same command as a commit or push. Those run first, on their own.
  // A post counts too: an earlier step could rewrite the file it reads after the guard looked (Qodo on PR 266).
  const git = /\bgit\b/.test(joinedWords(command));
  if (isChained(command) && (writes || git)) {
    // In a chained post, npm and gh steps could write the file it reads too (`npm exec`, `gh run download`).
    const step = chainProblem(command, !git) ?? (git ? undefined : writerStep(command));
    if (step !== undefined) {
      deny(
        `In ${repo.name}, a command that writes files or hides a command ("${step.slice(0, 60)}") must run on its own, and the commit or push in a separate command: the guard checks the checkout's content before a command runs, and can't see what an earlier part of the same command would write.`,
      );
    }
  }
  if (!writes) return;
  // A body from a variable the command doesn't set (`-b "$MSG"`) can't be read before it is posted (#285).
  if (readable && unreadablePost(command)) deny(UNREADABLE_VARIABLE);

  // A reviewed repo may link to its own tickets only when the command really runs in its checkout (the
  // hook's folder, or a `cd`/`git -C` that is a command of its own) and goes nowhere else. Words in a
  // message (a quoted --repo or a quoted Set-Location, say) can't grant that.
  const onlyItself =
    touched.length === 1 &&
    !mutation &&
    (isHere(repo) || navigatesInto(command, repo)) &&
    destinations.every((d) => d === repo.github.toLowerCase());
  checkLinks(ctx, command, onlyItself ? ctx.reviewed.filter((r) => r.github !== repo.github) : ctx.reviewed);

  // Each piece is judged on its own: a title ending in one word and a body starting with the next must
  // not join into a phrase that neither field holds.
  const found = [...new Set(postedPieces(ctx, command, true).flatMap((piece) => telltales(piece)))];
  if (found.length) {
    deny(
      `This would put a hint into ${repo.name} (${found.join(", ")}). Rewrite it so it reads like an ordinary change.`,
    );
  }

  // The command's own text is clean; now what would travel: the content pending in every reviewed
  // checkout, read from git, whatever the text says about where it runs.
  const pending = pendingProblem(ctx.reviewed, command, touched);
  if (pending) deny(pending);
}

function main() {
  respond(hookAnswer(readStdin, decide, failed));
}

if (isEntry(import.meta.url)) main();
