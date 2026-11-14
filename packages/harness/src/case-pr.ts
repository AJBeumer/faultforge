/**
 * Opens a case's PR on the reviewed repository and records it, so no `pr.opened` event is typed by hand
 * (AUD-M5).
 *
 *   npm run case:pr -- --case FF-NNNN --body "<one ordinary sentence>" --relationships "<what the owner saw>" \
 *     [--benchmark v1] [--dry-run] [--existing <pr number>]
 *
 * `--existing` records a PR already open for the case (opened by hand from the compare link, or by a run
 * that stopped after GitHub created it) with every check below, and opens nothing.
 *
 * Reads the case's answer-key entry (branch, injected commit, template) and its `case.ticket-created` event (the
 * target ticket the PR closes), and checks that the template and proofs are still the ones the case was
 * planted from (the injection event's hash). The title is the template's commit message; the body is the
 * sentence given, then `Closes #N`. Both are checked for giveaway words and for links to a GitHub issue or
 * PR, as `case:ticket` checks its text: this command calls `gh` itself, where the interactive guard hook
 * can't see it.
 *
 * The branch must already be pushed, with the injected commit as its head (`gh api` reads it). Then the
 * Qodo configuration check runs here (`qodo:check`'s `checkLiveQodoConfig`), so the version recorded is one
 * Qodo was just seen to match, and the folder recorded is the one that check saved; a difference, or a check
 * that can't run, refuses the PR. An attempt marker is written next (exclusively), so a run that times out
 * after GitHub created the PR is never repeated blindly. After `gh pr create`, the PR's head is read back;
 * only when it is the injected commit is the `pr.opened` event appended (through `appendEvent`, with its
 * schema), and the raw output saved.
 *
 * Exit codes: 0 the PR was opened and recorded (or, with `--dry-run`, printed, after the Qodo check); 1
 * refused before anything left the machine: usage, the case, its injection event or its ticket is missing, it
 * already has a PR, the text would give the case away or links to an issue or PR, the template changed since
 * injection, the pushed branch isn't the injected commit, or Qodo doesn't match its snapshot (or couldn't be
 * checked); 2 couldn't run or couldn't finish: the answer key or audit log has a problem, an earlier attempt
 * left its marker, `gh` failed, its output isn't a PR URL, or the opened PR's head isn't the injected commit
 * (check GitHub before retrying).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ISSUE_OR_PR_LINK } from "./case-ticket.ts";
import { errorText as message } from "./error-text.ts";
import { type FactoryConfig, loadFactory, repoConfig } from "./factory-config.ts";
import { type LedgerEntry, readAuditLog, readLedger } from "./ledger.ts";
import { appendEvent } from "./ledger-append.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { injectionHashProblem, isToolWritten } from "./ledger-hashes.ts";
import { telltales } from "./neutral.ts";
import { TOOL } from "./provenance.ts";
import { checkLiveQodoConfig } from "./qodo-check.ts";
import { privateDir, templateDir } from "./templates.ts";

export interface PrArgs {
  caseId: string;
  body: string;
  relationships: string;
  benchmark?: string;
  dryRun: boolean;
  /** A PR already opened for the case (by hand, or by a run that stopped): record it, open nothing. */
  existing?: number;
}

/** The command line, or null when it's wrong. */
export function parseCliArgs(argv: string[]): PrArgs | null {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        case: { type: "string" },
        body: { type: "string" },
        relationships: { type: "string" },
        benchmark: { type: "string" },
        "dry-run": { type: "boolean" },
        existing: { type: "string" },
      },
    });
    const { case: caseId, body, relationships } = values;
    if (!caseId || !/^FF-\d{4}$/.test(caseId) || !body?.trim() || !relationships?.trim()) return null;
    const existing = values.existing === undefined ? undefined : Number(values.existing);
    if (existing !== undefined && !(Number.isInteger(existing) && existing > 0)) return null;
    return {
      caseId,
      body: body.trim(),
      relationships,
      benchmark: values.benchmark,
      dryRun: !!values["dry-run"],
      ...(existing ? { existing } : {}),
    };
  } catch {
    return null;
  }
}

/** What the Qodo check said: its exit code (0 a match), the snapshot version, and where it saved Qodo's answers. */
export interface QodoCheckOutcome {
  exitCode: number;
  snapshotVersion?: string;
  evidenceDir: string | null;
  message: string;
}

export interface PrOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  factory?: FactoryConfig;
  /** Stands in for `gh`; the tests fake it. */
  gh?: (args: string[]) => string;
  /** Stands in for the live Qodo check; the tests fake it. */
  qodoCheck?: (privateRoot: string) => Promise<QodoCheckOutcome>;
  now?: () => string;
  eventId?: () => string;
}

const liveQodoCheck = (root: string): Promise<QodoCheckOutcome> =>
  checkLiveQodoConfig(loadFactory(), { snapshotDir: join(root, "config"), evidenceRoot: join(root, "raw-artifacts") });

export async function run(args: PrArgs, options: PrOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const gh = options.gh ?? ((a: string[]) => execFileSync("gh", a, { encoding: "utf8", timeout: 60_000 }));
  const now = options.now ?? (() => new Date().toISOString());
  const { caseId } = args;
  const root = privateDir(env);
  const groundTruthPath = join(root, "ground-truth.jsonl");
  const auditEventsPath = join(root, "audit-events.jsonl");

  const problems = ledgerProblemsWithHistory([groundTruthPath, auditEventsPath]);
  if (problems.length) {
    error(`case:pr: the answer key or audit log has problems:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    return 2;
  }
  let entry: LedgerEntry | undefined;
  let events: LedgerEntry[];
  try {
    entry = readLedger(groundTruthPath).find((e) => e.caseId === caseId);
    events = existsSync(auditEventsPath) ? readAuditLog(auditEventsPath).filter((e) => e.caseId === caseId) : [];
  } catch (e) {
    error(`case:pr: can't read the answer key or audit log: ${message(e)}`);
    return 2;
  }
  const refuse = (why: string) => {
    error(`case:pr: refused, ${why}; nothing left the machine`);
    return 1;
  };
  if (!entry || typeof entry.branch !== "string" || typeof entry.injectionCommit !== "string") {
    return refuse(`${caseId} has no answer-key entry with a branch and an injected commit`);
  }
  const { branch, injectionCommit } = entry as unknown as { branch: string; injectionCommit: string };
  if (events.some((e) => e.type === "pr.opened")) return refuse(`${caseId} already has a pr.opened event`);
  const target = repoConfig(options.factory ?? loadFactory(), "target").github;
  const issue = events.find((e) => e.type === "case.ticket-created")?.issue as
    | { number?: unknown; repo?: unknown }
    | undefined;
  const ticket = issue?.number;
  if (!Number.isInteger(ticket) || (ticket as number) < 1) {
    return refuse(`${caseId} has no target ticket with a whole issue number: run case:ticket first`);
  }
  // `Closes #N` names an issue in the PR's own repository, so the ticket must be there (Qodo on PR 269).
  if (issue?.repo !== undefined && issue.repo !== target) {
    return refuse(`${caseId}'s ticket is on ${String(issue.repo)}, not ${target}`);
  }
  // The template and proofs must be the ones the case was planted from (Qodo on PR 269).
  const injected = events.find((e) => e.type === "sabotage.injected" || e.type === "control.injected");
  if (!injected) return refuse(`${caseId} has no injection event`);
  if (isToolWritten(injected) && typeof injected.inputHash === "string") {
    const changed = injectionHashProblem(injected, [entry], env);
    if (changed) return refuse(`${caseId}'s template isn't the one it was planted from (${changed})`);
  }
  const dir = typeof entry.templateId === "string" ? templateDir(entry.templateId, env) : undefined;
  let title: string;
  let names: string[];
  try {
    const template = JSON.parse(readFileSync(join(dir ?? "", "template.json"), "utf8"));
    title = template.publish.commitMessage;
    names = [template.id, template.invariantId].filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return refuse(`${caseId}'s template ${String(entry.templateId)} or its commit message can't be read`);
  }
  const body = `${args.body} Closes #${ticket}`;
  const giveaways = [title, body].flatMap((text) => [
    ...telltales(text),
    ...(ISSUE_OR_PR_LINK.test(text) ? ["links to a GitHub issue or PR"] : []),
    // The template's own names, which templateTelltales refuses in every field the reviewer sees (Qodo on PR 269).
    ...names.filter((n) => text.toLowerCase().includes(n.toLowerCase())).map(() => "names the template"),
  ]);
  if (giveaways.length) return refuse(`the PR text would give the case away (${giveaways.join("; ")})`);

  let pushed: string;
  try {
    // One path segment, even for a branch name with a slash (Qodo on PR 269).
    pushed = gh(["api", `repos/${target}/branches/${encodeURIComponent(branch)}`, "--jq", ".commit.sha"]).trim();
  } catch (e) {
    return refuse(`the branch ${branch} isn't on ${target} (${message(e)}): push it first`);
  }
  if (pushed !== injectionCommit) return refuse(`${target}'s ${branch} is at ${pushed}, not ${injectionCommit}`);
  // Qodo is checked here, just before the PR, and only a match counts (Qodo on PR 269).
  const checked = await (options.qodoCheck ?? liveQodoCheck)(root);
  if (checked.exitCode !== 0 || !checked.snapshotVersion || !checked.evidenceDir) {
    return refuse(`Qodo's configuration check didn't pass (exit ${checked.exitCode}): ${checked.message}`);
  }
  const qodoConfiguration = checked.snapshotVersion;
  const qodoState = relative(root, checked.evidenceDir).replace(/\\/g, "/");
  const command = ["pr", "create", "--repo", target, "--base", "main", "--head", branch];
  command.push("--title", title, "--body", body);
  if (args.dryRun) {
    log(
      `[case:pr] dry run, Qodo matches ${qodoConfiguration}; would run: gh ${command.map((a) => JSON.stringify(a)).join(" ")}`,
    );
    return 0;
  }

  const evidenceDir = join(root, "raw-artifacts", caseId);
  mkdirSync(evidenceDir, { recursive: true });
  let url: string;
  if (args.existing) {
    // A PR opened by hand (no permission for gh) or by a run that stopped: recorded, never opened again.
    url = `https://github.com/${target}/pull/${args.existing}`;
  } else {
    // Marked before the call: a PR GitHub created during a timed-out call must never get a twin (#216).
    const marker = join(evidenceDir, "gh-pr-create.attempt.txt");
    try {
      writeFileSync(marker, `${now()} gh pr create --repo ${target} --head ${branch}\n`, { flag: "wx" });
    } catch (e) {
      error(
        (e as NodeJS.ErrnoException).code === "EEXIST"
          ? `case:pr: an earlier run tried to open this PR (${marker}). Check ${target}'s PRs; if it is open, record it with --existing <number>`
          : `case:pr: can't write ${marker}, so gh was not called: ${message(e)}`,
      );
      return 2;
    }
    try {
      url = gh(command).trim();
    } catch (e) {
      error(`case:pr: gh pr create failed (check GitHub; if it opened, record it with --existing): ${message(e)}`);
      return 2;
    }
    writeFileSync(join(evidenceDir, "gh-pr-create.raw.txt"), `${url}\n`);
  }
  const pr = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
  if (!Number.isInteger(pr) || pr < 1) {
    error(`case:pr: gh pr create did not print a PR URL (saved in ${evidenceDir}): ${url}`);
    return 2;
  }
  let head: string;
  try {
    head = gh(["api", `repos/${target}/pulls/${pr}`, "--jq", ".head.sha"]).trim();
  } catch (e) {
    error(`case:pr: PR ${pr} was opened, but its head can't be read: ${message(e)}`);
    return 2;
  }
  if (head !== injectionCommit) {
    error(`case:pr: PR ${pr} was opened with head ${head}, not ${injectionCommit}; no event written. Check GitHub`);
    return 2;
  }
  const at = now();
  try {
    appendEvent(auditEventsPath, {
      eventId: (options.eventId ?? randomUUID)(),
      type: "pr.opened",
      at,
      caseId,
      tool: TOOL,
      environment: `${platform()}-${arch()}-node${process.versions.node}`,
      repo: target,
      pr,
      url,
      headCommit: head,
      injectionCommit,
      headMatchesInjection: true,
      openedAt: at,
      qodoConfiguration,
      qodoState,
      relationships: args.relationships,
      ticket,
      ...(args.benchmark ? { benchmark: args.benchmark } : {}),
    });
  } catch (e) {
    error(`case:pr: PR ${pr} was opened, but its event can't be appended: ${message(e)}`);
    return 2;
  }
  log(`[case:pr] opened ${url} for ${caseId} (${qodoConfiguration}); recorded pr.opened`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(
      'usage: npm run case:pr -- --case FF-NNNN --body "<sentence>" --relationships "<text>" [--benchmark v1] [--dry-run] [--existing <pr>]',
    );
    process.exit(1);
  }
  run(parsed)
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`case:pr: ${message(e)}`);
      process.exit(2);
    });
}
