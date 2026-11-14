/**
 * Opens a case's PR on the reviewed repository and records it, so no `pr.opened` event is typed by hand
 * (AUD-M5).
 *
 *   npm run case:pr -- --case FF-NNNN --body "<one ordinary sentence>" --relationships "<what the owner saw>" \
 *     --qodo-state <folder under raw-artifacts/qodo-state> [--benchmark v1] [--dry-run]
 *
 * Reads the case's answer-key entry (branch, injected commit, template), its `case.ticket-created` event (the
 * target ticket the PR closes) and the highest `private/config/qodo-vN` (the configuration `qodo:check` just
 * matched). The title is the template's commit message; the body is the sentence given, then `Closes #N`.
 * Both are checked for giveaway words and for links to a GitHub issue or PR, as `case:ticket` checks its
 * text: this command calls `gh` itself, where the interactive guard hook can't see it.
 *
 * The branch must already be pushed, with the injected commit as its head (`gh api` reads it). An attempt
 * marker is written first (exclusively), so a run that times out after GitHub created the PR is never
 * repeated blindly. After `gh pr create`, the PR's head is read back; only when it is the injected commit is
 * the `pr.opened` event appended (through `appendEvent`, with its schema), and the raw output saved.
 *
 * Exit codes: 0 the PR was opened and recorded (or, with `--dry-run`, printed); 1 refused before anything
 * left the machine: usage, the case or its ticket is missing, it already has a PR, the text would give the
 * case away or links to an issue or PR, the Qodo state folder doesn't exist, or the pushed branch isn't the
 * injected commit; 2 couldn't run or couldn't finish: the answer key or audit log has a problem, an earlier
 * attempt left its marker, `gh` failed, its output isn't a PR URL, or the opened PR's head isn't the injected
 * commit (check GitHub before retrying).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ISSUE_OR_PR_LINK } from "./case-ticket.ts";
import { errorText as message } from "./error-text.ts";
import { type FactoryConfig, loadFactory, repoConfig } from "./factory-config.ts";
import { type LedgerEntry, readAuditLog, readLedger } from "./ledger.ts";
import { appendEvent } from "./ledger-append.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { telltales } from "./neutral.ts";
import { ROOT } from "./paths.ts";
import { privateDir, templateDir } from "./templates.ts";

const TOOL = `faultforge-harness@${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}`;

export interface PrArgs {
  caseId: string;
  body: string;
  relationships: string;
  qodoState: string;
  benchmark?: string;
  dryRun: boolean;
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
        "qodo-state": { type: "string" },
        benchmark: { type: "string" },
        "dry-run": { type: "boolean" },
      },
    });
    const { case: caseId, body, relationships } = values;
    const qodoState = values["qodo-state"];
    if (!caseId || !/^FF-\d{4}$/.test(caseId) || !body?.trim() || !relationships?.trim() || !qodoState) return null;
    if (!/^[\w.:-]+$/.test(qodoState)) return null;
    return {
      caseId,
      body: body.trim(),
      relationships,
      qodoState,
      benchmark: values.benchmark,
      dryRun: !!values["dry-run"],
    };
  } catch {
    return null;
  }
}

export interface PrOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  factory?: FactoryConfig;
  /** Stands in for `gh`; the tests fake it. */
  gh?: (args: string[]) => string;
  now?: () => string;
  eventId?: () => string;
}

/** The highest `qodo-vN` folder under `config`, or undefined. */
export function currentQodoConfiguration(configDir: string): string | undefined {
  if (!existsSync(configDir)) return undefined;
  const versions = readdirSync(configDir)
    .map((d) => /^qodo-v(\d+)$/.exec(d))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return versions.length ? `qodo-v${Math.max(...versions)}` : undefined;
}

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
  const ticket = (events.find((e) => e.type === "case.ticket-created")?.issue as { number?: unknown } | undefined)
    ?.number;
  if (typeof ticket !== "number") return refuse(`${caseId} has no target ticket: run case:ticket first`);
  const qodoConfiguration = currentQodoConfiguration(join(root, "config"));
  if (!qodoConfiguration) return refuse("no private/config/qodo-vN snapshot names the configuration");
  const qodoState = `raw-artifacts/qodo-state/${args.qodoState}`;
  if (!existsSync(join(root, qodoState))) return refuse(`${qodoState} doesn't exist: run qodo:check first`);
  const dir = typeof entry.templateId === "string" ? templateDir(entry.templateId, env) : undefined;
  let title: string;
  try {
    title = JSON.parse(readFileSync(join(dir ?? "", "template.json"), "utf8")).publish.commitMessage;
  } catch {
    return refuse(`${caseId}'s template ${String(entry.templateId)} or its commit message can't be read`);
  }
  const body = `${args.body} Closes #${ticket}`;
  const giveaways = [title, body].flatMap((text) => [
    ...telltales(text),
    ...(ISSUE_OR_PR_LINK.test(text) ? ["links to a GitHub issue or PR"] : []),
  ]);
  if (giveaways.length) return refuse(`the PR text would give the case away (${giveaways.join("; ")})`);

  const target = repoConfig(options.factory ?? loadFactory(), "target").github;
  let pushed: string;
  try {
    pushed = gh(["api", `repos/${target}/branches/${branch}`, "--jq", ".commit.sha"]).trim();
  } catch (e) {
    return refuse(`the branch ${branch} isn't on ${target} (${message(e)}): push it first`);
  }
  if (pushed !== injectionCommit) return refuse(`${target}'s ${branch} is at ${pushed}, not ${injectionCommit}`);
  const command = [
    "pr",
    "create",
    "--repo",
    target,
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ];
  if (args.dryRun) {
    log(`[case:pr] dry run, would run: gh ${command.map((a) => JSON.stringify(a)).join(" ")}`);
    return 0;
  }

  // Marked before the call: a PR GitHub created during a timed-out call must never get a twin (#216).
  const evidenceDir = join(root, "raw-artifacts", caseId);
  const marker = join(evidenceDir, "gh-pr-create.attempt.txt");
  mkdirSync(evidenceDir, { recursive: true });
  try {
    writeFileSync(marker, `${now()} gh pr create --repo ${target} --head ${branch}\n`, { flag: "wx" });
  } catch (e) {
    error(
      (e as NodeJS.ErrnoException).code === "EEXIST"
        ? `case:pr: an earlier run tried to open this PR (${marker}) and recorded no event. Check ${target}'s PRs first`
        : `case:pr: can't write ${marker}, so gh was not called: ${message(e)}`,
    );
    return 2;
  }
  let url: string;
  try {
    url = gh(command).trim();
  } catch (e) {
    error(`case:pr: gh pr create failed (check GitHub before retrying; marker kept at ${marker}): ${message(e)}`);
    return 2;
  }
  writeFileSync(join(evidenceDir, "gh-pr-create.raw.txt"), `${url}\n`);
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
      'usage: npm run case:pr -- --case FF-NNNN --body "<sentence>" --relationships "<text>" --qodo-state <folder> [--benchmark v1] [--dry-run]',
    );
    process.exit(1);
  }
  run(parsed).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`case:pr: ${message(e)}`);
      process.exit(2);
    },
  );
}
