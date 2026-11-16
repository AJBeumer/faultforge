/**
 * Claude Code PreToolUse hook. Keeps the reviewed repositories free of hints for the reviewer.
 *
 * The reviewed repos are the ones with `"guard": "reviewed"` in `factory.json`. Every write to one goes through
 * one door, `npm run target:post` (`packages/harness/src/door/target-post.ts`), which checks the exact text it sends.
 * So for each reviewed repo this hook:
 *  - lets a command that is exactly `npm run target:post -- …` through, without reading it (target/door.ts);
 *  - refuses every other command that sends to it: a push, a gh call that isn't a known read, a gh or raw API
 *    write, or a write whose destination it can't read. It doesn't read what such a write would say;
 *  - refuses script files that could write to it, which it can't read either;
 *  - keeps git's own guard hooks on in its checkout and its recorded case branches in place, and refuses a commit or
 *    push anywhere while its checkout holds pending content that names the lab or the bug (target/pending.ts);
 *  - refuses a local commit message there that names the lab or the bug, as git's commit-msg hook does, and Edit
 *    and Write content in its checkout that does; and MCP tools that write to it.
 * A command is "in" a reviewed repo when it names the repo as a destination, moves into its checkout
 * (cd, pushd, Set-Location, git -C, git --work-tree, GIT_DIR=), or runs from inside it. A checkout is
 * recognised by its folder name or by a remote that points at the repo (shared/repos.ts).
 * Everywhere else it blocks issues, PRs and commit messages that link to a reviewed repo, and every post,
 * to any repo but private storage, that names a template still held in private storage (answer-key/private-ids.ts).
 * Everywhere, it blocks code it can't read before it runs (shell/exec.ts): text built at run time run as a
 * shell (`… | base64 -d | bash`, `bash -c "$(…)"`, `eval`), and inline interpreter code that makes a network
 * call (`node -e "fetch(…)"`). It keeps the guard's own files as they are in the checkout it runs from
 * (self/own-files.ts), and the answer key, the audit log and private templates in private storage and out of every
 * commit (answer-key/copies.ts).
 *
 * `decide()` takes the hook payload as text and returns the decision without printing or exiting, so the
 * tests call it in-process. Run as `node <this file>`, `main()` reads the payload from stdin and answers:
 * a deny decision as JSON, nothing to allow, or exit 2 with one line on stderr when it couldn't check.
 * Claude Code runs it through fail-closed.ts, which also turns a crash, a broken import or a timeout into
 * exit 2.
 *
 * Exit codes: 0 answered (a deny decision on stdout, or nothing to allow); 2 couldn't check, so refused.
 */

import { copyOutProblem, labCommitProblem, lazyCopyTest } from "./answer-key/copies.ts";
import { checkPrivateFiles, checkPrivateIds, postedPieces } from "./answer-key/posts.ts";
import { PRIVATE_ID_REASON, privateIdMatcher, privateTemplateIds } from "./answer-key/private-ids.ts";
import { guardSwitchOff } from "./self/git-hooks.ts";
import { selfShellProblem } from "./self/own-files.ts";
import { telltales } from "./shared/harness-bridge.ts";
import { ALLOW, type Decision, firstLine, hookAnswer, isEntry, readStdin, respond } from "./shared/hook-io.ts";
import {
  entersCheckout,
  locate,
  MAX_MOVES,
  moveCount,
  navigationTargets,
  type Reviewed,
  reviewedRepos,
  unreadableMove,
} from "./shared/repos.ts";
import { builtCodeProblem, inlineNetworkProblem, interpreterPipelines } from "./shell/exec.ts";
import { outsidePostedText } from "./shell/posted.ts";
import { blankQuoted, joinContinuations, joinedWords, MAX_COMMAND_CHARS } from "./shell/scan.ts";
import { caseActionProblem } from "./target/cases.ts";
import { DEFAULT_BUDGET_MS, withDeadline, withPrivateCopies, withPrivateNames } from "./target/content.ts";
import { doorCommand, doorReason, sendsRaw, UNKNOWN_DESTINATION, webToUnknown } from "./target/door.ts";
import { aliasProblem, shellReading, UnknownRepository, unreadableDestination } from "./target/expand.ts";
import { calls, historyProblem } from "./target/history.ts";
import { pendingProblem } from "./target/pending.ts";
import { BuiltText, scriptProblem, Unreadable } from "./target/posted-files.ts";
import { explicitDestinations, graphqlMutation, isWrite, skipsGitGuard, urlDestinations } from "./target/reach.ts";
import {
  type Context,
  checkFileEdit,
  checkLinks,
  checkOtherTool,
  Denied,
  deny,
  type ToolInput,
} from "./target/tools.ts";

/**
 * The decision's time budget. `FAULTFORGE_GUARD_BUDGET_MS` may shorten it, for tests, never lengthen it past the
 * default, which keeps clear of the hook's 15 s.
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
    // One deadline for the whole decision, so many small scans can't add up past the hook's timeout.
    // Pending content may carry neither a private id nor a copy of private storage.
    withDeadline(guardBudget(env), () =>
      withPrivateNames(names, () =>
        withPrivateCopies(lazyCopyTest(env), () => {
          if (tool === "Bash" || tool === "PowerShell") {
            checkShell(ctx, String(args.command ?? ""));
          } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
            checkFileEdit(ctx, args);
          } else if (tool.startsWith("mcp__")) {
            checkOtherTool(ctx, tool, args);
          }
        }),
      ),
    );
    return ALLOW;
  } catch (error) {
    if (
      error instanceof Denied ||
      error instanceof Unreadable ||
      error instanceof BuiltText ||
      error instanceof UnknownRepository
    ) {
      // A reason that quotes a file or branch name could repeat a private id, so such a reason is replaced.
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
 * A shell command, judged as written and as the shell would read it: ANSI-C strings decoded, the
 * command's own variables expanded, repository ids named. Both must pass. Only the shell's reading is
 * `readable`: a variable left in it is one the command doesn't set.
 */
function checkShell(ctx: Context, command: string) {
  // The door checks what it sends itself: exactly `npm run target:post -- …`, from the lab, passes unread.
  if (doorCommand(command, ctx.cwd)) return;
  const alias = aliasProblem(command);
  if (alias) deny(alias);
  // Code no rule can read before it runs, wherever the command runs: built text run as a shell, and
  // inline interpreter code that reaches the network, which can post without gh.
  // Both as written and with its line continuations joined, as the shell runs it.
  const joined = joinContinuations(command);
  const codes = joined === command ? [command] : [command, joined];
  for (const code of codes) {
    const unread = builtCodeProblem(code, ctx.backticks) ?? inlineNetworkProblem(code, ctx.backticks);
    if (unread) deny(unread);
  }
  // A private id in inline code is checked too: the code could post it any way it likes. Only the code
  // an interpreter is handed: a script's path and arguments are the owner's local work (`npx tsx x.ts --template
  // <id>`), and a post that names the id is refused where it is posted.
  const names = ctx.names;
  const inline = codes.flatMap((code) => interpreterPipelines(code, ctx.backticks));
  if (names && inline.some((code) => names(code) || names(joinedWords(code)))) deny(PRIVATE_ID_REASON);
  // A script file can write without gh too: refused where it could reach a reviewed repo.
  const script = scriptProblem(ctx.cwd, joined, ctx.reviewed, Boolean(ctx.env.FAULTFORGE_FACTORY_RUN), ctx.backticks);
  if (script) deny(script);
  if (command.length > MAX_COMMAND_CHARS) return checkCommand(ctx, command, true);
  const read = shellReading(command);
  const readAlias = aliasProblem(read);
  if (readAlias) deny(readAlias);
  // A default repo set here sends later posts to a reviewed repo without naming it.
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
  // The folder the command runs in counts unless the command really names another destination, outside its
  // posted text: `-R` or `--repo` inside a message names nothing. Both readings are used, the strict one for what
  // is touched, so text that confuses one can't hide a repo from both. A GraphQL mutation can reach any repo.
  const outside = outsidePostedText(command);
  const urls = urlDestinations(outside);
  const destinations = [...explicitDestinations(command), ...urls];
  const realDestinations = [...explicitDestinations(outside), ...urls];
  const here = locate(cwd, reviewed);
  const entered = navigationTargets(command, cwd).flatMap((path) => locate(path, reviewed) ?? []);
  const enters = (r: Reviewed) => entersCheckout(command, r) || entered.some((e) => e.github === r.github);
  const isHere = (r: Reviewed) => here?.github === r.github;
  const mutation = writes && graphqlMutation(command);
  // A write after a move the guard can't read (`cd "$DIR"`, `git -C $(…)`) may land in any of them.
  const anywhere = writes && unreadableMove(command, cwd);
  const touched = reviewed
    .filter(
      (r) =>
        mutation ||
        anywhere ||
        destinations.includes(r.github.toLowerCase()) ||
        enters(r) ||
        (!realDestinations.length && isHere(r)),
    )
    .map((r) => entered.find((e) => e.github === r.github) ?? (isHere(r) && here ? here : r));
  return { destinations, touched, runsIn: (r: Reviewed) => anywhere || isHere(r) || enters(r) };
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
  const sends = sendsRaw(command, ctx.cwd, ctx.backticks);
  const writes = sends || isWrite(command);
  // A write whose repo the guard can't read may be aimed at a reviewed repo: refused, as it can't tell.
  if (writes && readable && (unreadableDestination(command) || webToUnknown(command, ctx.cwd, ctx.backticks))) {
    deny(UNKNOWN_DESTINATION);
  }
  // Whether or not the command reads as a write: a gist or a release found as the shell reads its words is one,
  // however it is spelled (`g\h gist create`).
  checkPrivateFiles(ctx, command);
  // Wherever it runs: the git-level guard stays on, the private repo private, and lab history out.
  const moved = guardSwitchOff(command, ctx.backticks, ctx.cwd) ?? historyProblem(ctx, command);
  if (moved) deny(moved);
  // The guard's own files stay as they are, and private storage stays in it.
  const own =
    selfShellProblem(command, ctx.cwd, ctx.env, ctx.backticks) ??
    copyOutProblem(command, ctx.cwd, ctx.env, ctx.backticks) ??
    labCommitProblem(ctx, command);
  if (own) deny(own);
  if (writes) checkPrivateIds(ctx, command, readable);
  const { destinations, touched, runsIn } = reach(ctx, command, writes);

  // Reading a shell command with patterns can't be complete, so a command that writes and involves
  // more than one repo must be split: each part then gets judged on its own.
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

  // The door rule: nothing is sent to a reviewed repo but through `npm run target:post`.
  if (sends) deny(doorReason(repo.name));
  // What stays local to its checkout: git's own guard hooks run, and recorded case branches stay in place.
  if (skipsGitGuard(command)) {
    deny(`In ${repo.name}, git's own guard hooks must run: no --no-verify, no commit -n, and no other core.hooksPath.`);
  }
  for (const r of touched) {
    const action = caseActionProblem(ctx, command, r);
    if (action) deny(action);
  }
  // Links still go one way: a commit's message may link only to the repo whose checkout its git calls all run in,
  // wherever the command starts (`git -C <other checkout>`). One that only names a reviewed repo in its text (a
  // fake `--repo`) is a lab commit, judged as one.
  if (writes) {
    const homes = new Set(
      calls(command, ctx.cwd, ctx.backticks)
        .filter((call) => call.program === "git")
        .map((call) => (call.dir === undefined ? undefined : locate(call.dir, ctx.reviewed)?.github)),
    );
    const home = homes.size === 1 ? [...homes][0] : undefined;
    checkLinks(ctx, command, home ? ctx.reviewed.filter((r) => r.github !== home) : ctx.reviewed);
    // A local commit's, tag's or note's own message is read as git's commit-msg hook reads it: an early refusal,
    // and the denial the factory's hook self-test probes for (factory-hooks.ts). Each piece on its own.
    const found = [...new Set(postedPieces(ctx, command, true).flatMap((piece) => telltales(piece)))];
    if (found.length) {
      deny(
        `This would put a hint into ${repo.name} (${found.join(", ")}). Rewrite it so it reads like an ordinary change.`,
      );
    }
  }
  // A commit there is checked against what it would carry, read from git (target/pending.ts).
  const pending = pendingProblem(ctx.reviewed, command, touched);
  if (pending) deny(pending);
}

function main() {
  respond(hookAnswer(readStdin, decide, failed));
}

if (isEntry(import.meta.url)) main();
