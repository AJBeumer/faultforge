/**
 * Shows the owner the match between a planted bug and Qodo's saved review, asks for the verdict, and
 * records it.
 *
 *   npm run verdict -- FF-0001
 *   npm run verdict -- FF-0001 --dry-run           # prints the event it would append, writes nothing
 *   npm run verdict -- FF-0001 --review <path>     # read findings from this file instead of discovering one
 *   npm run verdict -- FF-0001 --supersede <id>    # replace the case's latest verdict, event <id>
 *
 * It reads the saved review of the case's injected commit on its own PR, and prints each finding's match
 * against the fixed rule. A review that isn't complete offers only `review incomplete`: a clean result from
 * an unfinished review proves nothing.
 *
 * The owner gives the verdict with a reason of this case's own, says whether they wrote that reason, and
 * judges every finding. A finding the rule matched must be judged real or a false alarm, because the verdict
 * rests on it. A blank answer leaves any other finding open, never a false alarm. Nothing is written until
 * every question is answered; the event then carries an input hash so its exact inputs can be checked later.
 *
 * A case that already has a verdict is refused unless `--supersede` names it; `verdict:amend` adds a better
 * reason without replacing one. An answer the match rule contradicts is recorded only after the owner
 * confirms it, and `case:build` won't publish it while the record must agree with the rule.
 *
 * Exit codes: 0 the event was appended (or, with `--dry-run`, printed); 1 stdin is not a terminal, so
 * there is nobody to ask — the match is printed, nothing is written; 2 nothing was written, because: the
 * case id isn't FF- and four digits; the answer key or audit log has an amendment or history problem
 * (`ledgerProblemsWithHistory`); the case, its
 * PR, its review or its template can't be read or found; the review doesn't match the injected commit or
 * holds no findings list; the case already has a verdict and `--supersede` doesn't name it (or names one
 * that doesn't exist); an answer couldn't be parsed or was another case's reason after retrying; a matched
 * finding was left unjudged; an answer the rule contradicts wasn't confirmed; or the event couldn't be
 * appended.
 *
 * An unexpected error, even while loading, is 2 too: `npm run verdict` runs `verdict-cli.ts`.
 */
import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { readAuditLog } from "../ledger/ledger.ts";
import { appendEvent } from "../ledger/ledger-append.ts";
import { verdictInputHash } from "../ledger/ledger-hashes.ts";
import { applyMatchRule } from "../match/match-rule.ts";
import { isComplete, savedReviewsDir, toMatchFinding } from "../review/saved-review.ts";
import { errorText as message } from "../shared/error-text.ts";
import { gh } from "../shared/github.ts";
import { caseIdOk } from "../shared/paths.ts";
import { TOOL } from "../shared/provenance.ts";
import { privateDir } from "../shared/templates.ts";
import {
  type AskFn,
  askDraftedBy,
  askJudgement,
  askMatchedJudgement,
  askNonBlank,
  askOneOf,
  askOwnReason,
  defaultAsk,
  printControlFindings,
  printReport,
} from "./verdict-ask.ts";
import {
  type AdjudicationEvent,
  BUG_VERDICTS,
  CONTROL_VERDICTS,
  type Judgement,
  latestVerdict,
  normalReason,
  reasonsOfOtherCases,
} from "./verdict-event.ts";
import { loadVerdictInputs } from "./verdict-inputs.ts";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Whether there is a terminal to ask on; defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
  dryRun?: boolean;
  /** Read findings from this file instead of discovering one by the injected commit. */
  reviewPath?: string;
  groundTruthPath?: string;
  auditEventsPath?: string;
  reviewsDir?: string;
  /** The event id of the case's latest verdict, which this one replaces; required when there is one. */
  supersede?: string;
  ask?: AskFn;
  ownerLogin?: () => string;
  now?: () => string;
  append?: (path: string, value: object) => void;
}

function defaultOwnerLogin(): string {
  return gh("api", "user", "--jq", ".login").trim();
}

function defaultAppend(path: string, value: object): void {
  appendEvent(path, value as Record<string, unknown>);
}

export async function run(caseId: string, options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  // The id names the case's files and goes into the event, so check it first: `../x` must name nothing.
  if (!caseIdOk(caseId, "verdict", error)) return 2;

  const root = privateDir(env);
  const auditEventsPath = options.auditEventsPath ?? join(root, "audit-events.jsonl");
  const groundTruthPath = options.groundTruthPath ?? join(root, "ground-truth.jsonl");
  const loaded = loadVerdictInputs(
    caseId,
    {
      groundTruthPath,
      auditEventsPath,
      reviewsDir: options.reviewsDir ?? savedReviewsDir(env),
      reviewPath: options.reviewPath,
    },
    env,
  );
  if ("problem" in loaded) {
    error(`verdict: ${loaded.problem}`);
    return 2;
  }
  const { entry, review, reviewText, templateText, kindTerms, isControl, injectedFile, injectedLines } = loaded;

  // A second verdict silently winning would change the record, so it must name the one it supersedes.
  const earlier = latestVerdict(loaded.caseEvents);
  if (earlier && typeof earlier.eventId !== "string") {
    error(`verdict: ${caseId}'s verdict has no event id, so nothing can name it to supersede; ask the owner`);
    return 2;
  }
  if (earlier && options.supersede !== earlier.eventId) {
    error(
      options.supersede
        ? `verdict: --supersede ${options.supersede} isn't ${caseId}'s latest verdict, ${String(earlier.eventId)}; nothing recorded`
        : `verdict: ${caseId} already has a verdict (${String(earlier.eventId)}). To replace it, run again with --supersede ${String(earlier.eventId)}; to add a reason, use verdict:amend`,
    );
    return 2;
  }
  if (!earlier && options.supersede) {
    error(`verdict: --supersede ${options.supersede}, but ${caseId} has no verdict to supersede; nothing recorded`);
    return 2;
  }

  const findings = review.findings.map(toMatchFinding);
  const result = isControl
    ? undefined
    : applyMatchRule({ file: injectedFile, lines: injectedLines }, findings, kindTerms);
  if (result) printReport(log, findings, result);
  else printControlFindings(log, findings);

  // Anything short of a finished review of this exact commit means a clean result proves nothing.
  const reviewIncomplete = !isComplete(review);
  if (reviewIncomplete) {
    log(
      `WARNING: the saved review's state is ${JSON.stringify(review.state ?? null)}, not "complete". A missing finding may mean the review never finished, not that nothing was found; only "review incomplete" can be recorded.`,
    );
  }

  const isTTY = options.isTTY ?? process.stdin.isTTY === true;
  if (!isTTY) {
    log("(no terminal to ask on: nothing written)");
    return 1;
  }

  let by: string;
  try {
    by = (options.ownerLogin ?? defaultOwnerLogin)();
  } catch (e) {
    error(`verdict: can't determine the owner's login: ${message(e)}`);
    return 2;
  }

  const ask = options.ask ?? defaultAsk;
  const verdicts = isControl ? CONTROL_VERDICTS : BUG_VERDICTS;
  const offered = isControl
    ? [findings.length ? "false alarm" : "clean", "review incomplete"]
    : ["detected", "missed", "review incomplete"];
  const allowedBugWords = reviewIncomplete ? ["review incomplete"] : offered;
  const subject = isControl ? "the control" : "the planted bug";
  const bugAnswer = await askOneOf(ask, `Verdict on ${subject} (${offered.join("/")}): `, allowedBugWords);
  if (!bugAnswer) {
    error(
      `verdict: no valid answer (${offered.slice(0, -1).join(", ")} or ${offered.at(-1)}) for ${subject}'s verdict`,
    );
    return 2;
  }
  // An answer the rule contradicts becomes a permanent line in an append-only log, so ask again first.
  if (result && bugAnswer !== "review incomplete" && (bugAnswer === "detected") !== result.caught) {
    const sure = await askOneOf(
      ask,
      `The rule says caught = ${result.caught}, but the answer is "${bugAnswer}". Record it anyway? (yes/no): `,
      ["yes", "no"],
    );
    if (sure !== "yes") {
      error(`verdict: "${bugAnswer}" contradicts the rule (caught = ${result.caught}) and was not confirmed`);
      return 2;
    }
  }
  // A reason belongs to its case: one pasted from another case's verdict is refused.
  const bugReason = await askOwnReason(ask, "Reason: ", reasonsOfOtherCases(loaded.allEvents, caseId));
  if (typeof bugReason !== "string") {
    error(
      bugReason.taken
        ? `verdict: the reason is the same as another case's verdict; write this case's own reason. Nothing recorded`
        : `verdict: no reason given for ${subject}'s verdict`,
    );
    return 2;
  }
  // Asked every time: an agent's draft the owner accepted reads the same as the owner's own words.
  const reasonDraftedBy = await askDraftedBy(ask);
  if (!reasonDraftedBy) {
    error("verdict: no answer (y or n) to who wrote the reason; nothing recorded");
    return 2;
  }

  const judgements: Judgement[] = [];
  // A finding the rule matched can't be left open: the verdict rests on it.
  for (const finding of result?.findings ?? findings) {
    const matched = result?.matchedFindingIds.includes(finding.id) ?? false;
    const source = findings.find((f) => f.id === finding.id);
    const title = `${finding.id}${source?.title ? ` "${source.title}"` : ""}`;
    const judged = matched
      ? await askMatchedJudgement(ask, `Judge ${title}, which the rule matched (real/false alarm): `)
      : await askJudgement(ask, `Judge ${title} (real/false alarm/open, blank = open): `);
    if (judged === undefined) {
      error(
        matched
          ? `verdict: finding ${finding.id} matched the rule and was not judged real or a false alarm; nothing recorded`
          : `verdict: no valid answer (real, false alarm or open) for finding ${finding.id}`,
      );
      return 2;
    }
    let reason = "";
    if (judged.explicit) {
      const given = await askNonBlank(ask, "Reason: ");
      if (given === undefined) {
        error(`verdict: no reason given for finding ${finding.id}'s judgement`);
        return 2;
      }
      reason = given;
    }
    judgements.push({ id: finding.id, verdict: judged.verdict, reason });
  }

  // A control with a real finding is neither clean nor a false alarm: the template or the case needs a look
  // before any verdict is recorded.
  if (isControl && bugAnswer !== "review incomplete" && judgements.some((j) => j.verdict === "real")) {
    error(
      "verdict: a finding on this control is judged real, so the control was not clean; nothing recorded. Check the template, or record review incomplete with the reason",
    );
    return 2;
  }
  // A false alarm is a judgement on every finding, and one left open isn't judged yet.
  if (isControl && bugAnswer === "false alarm" && judgements.some((j) => j.verdict === "open")) {
    error("verdict: a false alarm needs every finding judged a false alarm; one was left open, so nothing recorded");
    return 2;
  }
  // The verdict must agree with the judgements it rests on. Detected needs a real finding (a matched one when
  // the rule matched any); missed can't have a matched one judged real.
  const matched = result?.matchedFindingIds ?? [];
  const realAmong = (ids: string[] | undefined) =>
    judgements.some((j) => j.verdict === "real" && (ids === undefined || ids.includes(j.id)));
  const detectedHolds = realAmong(matched.length ? matched : undefined);
  if ((bugAnswer === "detected" && !detectedHolds) || (bugAnswer === "missed" && realAmong(matched))) {
    error(
      bugAnswer === "detected"
        ? "verdict: detected, but no finding that could be the catch is judged real; nothing recorded"
        : "verdict: missed, but a finding the rule matched is judged real; nothing recorded",
    );
    return 2;
  }

  const event: AdjudicationEvent = {
    eventId: randomUUID(),
    type: "case.adjudicated",
    at: (options.now ?? (() => new Date().toISOString()))(),
    caseId,
    commit: review.headSha,
    by,
    tool: TOOL,
    environment: `${platform()}-${arch()}-node${process.versions.node}`,
    inputHash: verdictInputHash(entry, templateText, reviewText),
    // The file hashed, so the hash can be checked against it even when `--review` named another.
    reviewFile: relative(dirname(groundTruthPath), loaded.reviewPath).replace(/\\/g, "/"),
    ...(result ? { ruleVersion: result.ruleVersion } : {}),
    disposition: verdicts[bugAnswer] as string,
    reason: bugReason,
    reasonDraftedBy,
    judgements,
    ...(earlier ? { supersedes: earlier.eventId as string } : {}),
  };

  if (options.dryRun) {
    log(`(dry run) would append to ${auditEventsPath}:`);
    log(JSON.stringify(event, null, 2));
    return 0;
  }
  try {
    // Read again just before writing: another run may have recorded a verdict while the owner answered.
    const fresh = readAuditLog(auditEventsPath);
    const now = latestVerdict(fresh.filter((e) => e.caseId === caseId));
    if (now?.eventId !== earlier?.eventId) {
      error(`verdict: another verdict for ${caseId} (${String(now?.eventId)}) was recorded meanwhile; nothing written`);
      return 2;
    }
    if (reasonsOfOtherCases(fresh, caseId).has(normalReason(bugReason))) {
      error("verdict: another case's verdict was given the same reason meanwhile; nothing written");
      return 2;
    }
    (options.append ?? defaultAppend)(auditEventsPath, event);
  } catch (e) {
    error(`verdict: can't append to ${auditEventsPath}: ${message(e)}`);
    return 2;
  }
  log(`recorded: ${caseId} ${event.disposition}, ${judgements.length} finding(s) judged`);
  return 0;
}

interface CliArgs {
  caseId: string;
  dryRun: boolean;
  reviewPath?: string;
  supersede?: string;
}

/** The command line, or null when it's wrong. */
export function parseCliArgs(argv: string[]): CliArgs | null {
  let values: { "dry-run"?: boolean; review?: string; supersede?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseNodeArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, review: { type: "string" }, supersede: { type: "string" } },
      allowPositionals: true,
    }));
  } catch {
    return null;
  }
  const [caseId] = positionals;
  if (!caseId) return null;
  return { caseId, dryRun: values["dry-run"] ?? false, reviewPath: values.review, supersede: values.supersede };
}

/** The command: `verdict-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[]): Promise<number> | number {
  const parsed = parseCliArgs(argv);
  if (!parsed) {
    console.error("usage: npm run verdict -- <caseId> [--dry-run] [--review <path>] [--supersede <eventId>]");
    return 2;
  }
  return run(parsed.caseId, { dryRun: parsed.dryRun, reviewPath: parsed.reviewPath, supersede: parsed.supersede });
}

// Callers import these from here as well as from verdict-ask.ts.
export { type AskFn, printReport } from "./verdict-ask.ts";
