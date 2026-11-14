/**
 * Shows the owner the match between a planted bug and Qodo's saved review, asks for the verdict, and
 * records it.
 *
 *   npm run verdict -- FF-0001
 *   npm run verdict -- FF-0001 --dry-run           # prints the event it would append, writes nothing
 *   npm run verdict -- FF-0001 --review <path>     # read findings from this file instead of discovering one
 *
 * Reads the case's ground-truth entry (`readLedger`, #10) for the injected file, lines and template,
 * and the saved review (one of the `*.review.json` files `review:wait` writes) of the entry's
 * `injectionCommit` on the case's own PR, as its `pr.opened` event names it (a `--review <path>` is
 * refused if its own `headSha` differs). Prints every finding's match against the fixed rule
 * (`applyMatchRule`, #18): file, lines, width, category and summary, then the overall catch. When the
 * saved review's own `state` is not `"complete"` (skipped, timed out, the head moved on, or no state at
 * all), a warning is printed and the only verdict on offer is `review incomplete`: a clean result from an
 * unfinished review proves nothing. A save with no findings list is refused.
 *
 * It then asks the owner, on the terminal: the verdict on the planted bug (`detected`, `missed` or
 * `review incomplete`, with a nonblank reason — retried, then refused, if left blank), and a judgement
 * on every other finding — every one Qodo raised that did not match the planted bug — as `real`,
 * `false alarm` or `open`, each with a nonblank reason. A blank answer instead leaves a finding `open`
 * at once, unjudged, with no reason asked; it is never recorded as a false alarm. Nothing is written
 * until every question is answered. The event — case id, commit reviewed, owner's login, UTC time, an
 * `inputHash` of the ground truth, the template and the review (so its exact inputs can be checked
 * later), the disposition, its reason and the judgements — is appended to `private/audit-events.jsonl`
 * as one `case.adjudicated` line, or printed instead of written with `--dry-run`.
 *
 * An answer the match rule contradicts (`detected` for a computed miss, `missed` for a computed catch) is
 * recorded only after the owner confirms it. It is then the owner's judgement on record, but `case:build`
 * will not publish it while its record's checks require the verdict to agree with the rule.
 *
 * Exit codes: 0 the event was appended (or, with `--dry-run`, printed); 1 stdin is not a terminal, so
 * there is nobody to ask — the match is printed, nothing is written; 2 nothing was written, because: the
 * answer key or audit log has an amendment or history problem (`ledgerProblemsWithHistory`); the case, its
 * PR, its review or its template can't be read or found; the review doesn't match the injected commit or
 * holds no findings list; an answer couldn't be parsed after retrying;
 * an answer the rule contradicts wasn't confirmed; or the event couldn't be appended.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { errorText as message } from "./error-text.ts";
import { gh } from "./github.ts";
import { verdictInputHash } from "./ledger-hashes.ts";
import { applyMatchRule } from "./match-rule.ts";
import { ROOT } from "./paths.ts";
import { TOOL } from "./provenance.ts";
import { isComplete, savedReviewsDir, toMatchFinding } from "./saved-review.ts";
import { privateDir } from "./templates.ts";
import {
  type AskFn,
  askJudgement,
  askNonBlank,
  askOneOf,
  defaultAsk,
  printControlFindings,
  printReport,
} from "./verdict-ask.ts";
import { type AdjudicationEvent, BUG_VERDICTS, CONTROL_VERDICTS, type Judgement } from "./verdict-event.ts";
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
  ask?: AskFn;
  ownerLogin?: () => string;
  now?: () => string;
  append?: (path: string, value: object) => void;
}

function defaultOwnerLogin(): string {
  return gh("api", "user", "--jq", ".login").trim();
}

function defaultAppend(path: string, value: object): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export async function run(caseId: string, options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));

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

  const findings = review.findings.map(toMatchFinding);
  const result = isControl
    ? undefined
    : applyMatchRule({ file: injectedFile, lines: injectedLines }, findings, kindTerms);
  if (result) printReport(log, findings, result);
  else printControlFindings(log, findings);

  // "complete" only when review:wait finished reviewing this exact commit; anything else (skipped, timed out,
  // head moved, or no state at all) means a clean result proves nothing, so only "review incomplete" is offered.
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
  // A control offers `clean` only when Qodo raised nothing, and `false alarm` only when it raised something.
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
  // An answer the rule contradicts is a permanent line in an append-only log: asked again first (#192).
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
  const bugReason = await askNonBlank(ask, "Reason: ");
  if (bugReason === undefined) {
    error(`verdict: no reason given for ${subject}'s verdict`);
    return 2;
  }

  const judgements: Judgement[] = [];
  // On a control every finding is judged: none can be a catch.
  for (const finding of result?.findings ?? findings) {
    if (result?.matchedFindingIds.includes(finding.id)) continue;
    const source = findings.find((f) => f.id === finding.id);
    const judged = await askJudgement(
      ask,
      `Judge ${finding.id}${source?.title ? ` "${source.title}"` : ""} (real/false alarm/open, blank = open): `,
    );
    if (judged === undefined) {
      error(`verdict: no valid answer (real, false alarm or open) for finding ${finding.id}`);
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

  // A control with a finding the owner judges real wasn't clean, so it is neither clean nor a false alarm
  // (owner's decision, 13 November): the template or the case needs a look before any verdict is recorded.
  if (isControl && bugAnswer !== "review incomplete" && judgements.some((j) => j.verdict === "real")) {
    error(
      "verdict: a finding on this control is judged real, so the control was not clean; nothing recorded. Check the template, or record review incomplete with the reason",
    );
    return 2;
  }
  // A false alarm is a judgement on every finding: one left open isn't judged yet (Qodo on PR 214).
  if (isControl && bugAnswer === "false alarm" && judgements.some((j) => j.verdict === "open")) {
    error("verdict: a false alarm needs every finding judged a false alarm; one was left open, so nothing recorded");
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
    // The file hashed, so the hash is checked against it even when `--review` named another (Qodo on PR 264).
    reviewFile: relative(dirname(groundTruthPath), loaded.reviewPath).replace(/\\/g, "/"),
    ...(result ? { ruleVersion: result.ruleVersion } : {}),
    disposition: verdicts[bugAnswer] as string,
    reason: bugReason,
    judgements,
  };

  if (options.dryRun) {
    log(`(dry run) would append to ${auditEventsPath}:`);
    log(JSON.stringify(event, null, 2));
    return 0;
  }
  try {
    (options.append ?? defaultAppend)(auditEventsPath, event);
  } catch (e) {
    error(`verdict: can't append to ${auditEventsPath}: ${message(e)}`);
    return 2;
  }
  log(`recorded: ${caseId} ${event.disposition}, ${judgements.length} other finding(s) judged`);
  return 0;
}

interface CliArgs {
  caseId: string;
  dryRun: boolean;
  reviewPath?: string;
}

/** The command line, or null when it's wrong. */
export function parseCliArgs(argv: string[]): CliArgs | null {
  let values: { "dry-run"?: boolean; review?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseNodeArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, review: { type: "string" } },
      allowPositionals: true,
    }));
  } catch {
    return null;
  }
  const [caseId] = positionals;
  if (!caseId) return null;
  return { caseId, dryRun: values["dry-run"] ?? false, reviewPath: values.review };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: npm run verdict -- <caseId> [--dry-run] [--review <path>]");
    process.exit(2);
  }
  run(parsed.caseId, { dryRun: parsed.dryRun, reviewPath: parsed.reviewPath }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`verdict: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}

// Kept importable from here, where callers found them before the split.
export { type AskFn, printReport } from "./verdict-ask.ts";
