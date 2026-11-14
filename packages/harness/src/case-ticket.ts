/**
 * Creates the target ticket a case PR will claim to make, from a template's own `ticket` field: an
 * ordinary issue on the target repository, so Qodo reads the same context a developer's PR would carry
 * (#12). Works for both kinds of template: a control gets a ticket the same way a bug does.
 *
 *   npm run case:ticket -- --template <id> --case FF-NNNN
 *   npm run case:ticket -- --template <id> --case FF-NNNN --dry-run
 *
 * Before creating anything, the ticket text (`ticket.title`, `ticket.what` and every criterion) is
 * checked with `templateTelltales`, the same giveaway check `inject` runs on a template: nothing is
 * created from text that would give the case away. The issue's sections come from `factory.json`'s own
 * ticket sections for the target repository, built only from fields a template actually declares: the
 * checklist section holds `ticket.criteria` as checkboxes, the first other section holds `ticket.what`.
 * A template has no field for any other section ("Must not break", today), so that section gets one
 * fixed, honest line that is true of every template, never content inferred from the bug.
 *
 * The ticket text is also refused if it links to any GitHub issue or PR (a URL or a short `repo#N`
 * reference): a template has no reason to need one, and spawning `gh` directly from this script, rather
 * than through a shell command, means the interactive guard hook never sees the posted text, so this
 * check stands in for it.
 *
 * `--dry-run` prints the issue text and the `gh` command it would run, without creating anything or
 * writing to private storage. A case already ticketed (a `case.ticket-created` audit event for it)
 * is refused either way, so a second run can't open a duplicate issue.
 *
 * Exit codes: 0 the issue was created (or, with `--dry-run`, printed); 1 refused — the ticket text
 * gives the case away or links to a GitHub issue or PR, the template's `ticket` field is missing or
 * incomplete, the case id isn't a plain token, the case planted another template (or, outside a dry run,
 * isn't in the answer key yet), or this case already has a ticket; 2 could not run — the template wasn't
 * found or unreadable, the answer key or audit log couldn't be read or has an amendment or history
 * problem (`ledgerProblemsWithHistory`), `gh` failed to create the
 * issue, or its output couldn't be read as an issue URL (the raw output is still saved, so a human can
 * check GitHub before retrying rather than risk a duplicate issue), or an earlier run's attempt left its
 * marker without the event: it may have created the issue, so this refuses until a human has checked.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type FactoryConfig, loadFactory, repoConfig } from "./factory-config.ts";
import { readAuditLog, readLedger } from "./ledger.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { templateTelltales } from "./neutral.ts";
import { templateDir as findTemplateDir, privateDir } from "./templates.ts";

interface Ticket {
  title: string;
  what: string;
  criteria: string[];
}

interface Template {
  id: string;
  kind: "bug" | "control";
  find: string;
  replace: string;
  publish: { branch: string; commitMessage: string };
  ticket?: Ticket;
}

/** True of every template, so it's safe as boilerplate for a section no template field describes. */
const MUST_NOT_BREAK_LINE = "- Nothing else about booking behavior is expected to change.";

/** Problems with a template's `ticket` field, or an empty list when it has everything this command needs. */
export function ticketFieldProblems(ticket: Ticket | undefined): string[] {
  if (!ticket) return ["template has no ticket field"];
  const problems: string[] = [];
  if (typeof ticket.title !== "string" || !ticket.title.trim()) problems.push("ticket.title is missing or blank");
  if (typeof ticket.what !== "string" || !ticket.what.trim()) problems.push("ticket.what is missing or blank");
  if (
    !Array.isArray(ticket.criteria) ||
    !ticket.criteria.length ||
    ticket.criteria.some((c) => typeof c !== "string" || !c.trim())
  ) {
    problems.push("ticket.criteria is missing, empty, or has a blank entry");
  }
  return problems;
}

/** A link GitHub turns into a "mentioned in" event: a full issue/PR URL, or a short `repo#N` reference. */
const ISSUE_OR_PR_LINK = /github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+|\b[\w.-]+#\d+\b/i;

/**
 * The reasons a ticket's text links to a GitHub issue or PR, as `field: reason`, over every field that
 * reaches the target: title, `what`, and every criterion. A template describing ordinary development
 * work never needs one; a link would also show on that issue's or PR's timeline, where Qodo reads it.
 */
export function ticketLinkGiveaways(ticket: Ticket): string[] {
  const fields: [string, string][] = [
    ["ticket.title", ticket.title],
    ["ticket.what", ticket.what],
    ...ticket.criteria.map((c, i): [string, string] => [`ticket.criteria[${i}]`, c]),
  ];
  return fields
    .filter(([, text]) => ISSUE_OR_PR_LINK.test(text))
    .map(([field]) => `${field}: links to a GitHub issue or PR`);
}

/** A safe single path segment: no `/`, no `..`, nothing that could escape private storage when joined into a path. */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
}

/**
 * The issue body in the repo's own ticket sections (`factory.json`'s `tickets.sections`), built only
 * from `ticket`: the checklist section is `ticket.criteria` as checkboxes, the first other section is
 * `ticket.what`, and any remaining section gets the fixed "must not break" line, since no template
 * field describes it.
 */
export function buildBody(sections: FactoryConfig["repos"][string]["tickets"], ticket: Ticket): string {
  // The first section that isn't the checklist, whatever position either one is in: `ticket.what` goes
  // there, so a config where the checklist happens to come first still leaves it somewhere to land.
  const descriptive = sections.sections.find((name) => name !== sections.checklist) ?? sections.sections[0];
  return sections.sections
    .map((name) => {
      if (name === sections.checklist) {
        return `### ${name}\n${ticket.criteria.map((c) => `- [ ] ${c}`).join("\n")}`;
      }
      if (name === descriptive) return `### ${name}\n${ticket.what}`;
      return `### ${name}\n${MUST_NOT_BREAK_LINE}`;
    })
    .join("\n\n");
}

/** True when this case already has a `case.ticket-created` event in the audit log. */
export function alreadyTicketed(events: Record<string, unknown>[], caseId: string): boolean {
  return events.some((e) => e.type === "case.ticket-created" && e.caseId === caseId);
}

/** The issue number from the URL `gh issue create` prints on success, or undefined if it doesn't look like one. */
export function issueNumberFromUrl(url: string): number | undefined {
  const match = url.trim().match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  dryRun?: boolean;
  auditEventsPath?: string;
  groundTruthPath?: string;
  evidenceDir?: string;
  factory?: FactoryConfig;
  /** Stands in for the real `gh` call; a test fakes this instead of spawning the binary. */
  gh?: (args: string[]) => string;
  now?: () => string;
  eventId?: () => string;
}

export async function run(templateId: string, caseId: string, options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  if (!isSafeId(caseId)) {
    error(`case:ticket: refused, case id must be a plain token (letters, digits, dot, dash, underscore): ${caseId}`);
    return 1;
  }

  const root = privateDir(env);
  const auditEventsPath = options.auditEventsPath ?? join(root, "audit-events.jsonl");
  const groundTruthPath = options.groundTruthPath ?? join(root, "ground-truth.jsonl");
  const evidenceDir = options.evidenceDir ?? join(root, "raw-artifacts", caseId);
  const gh = options.gh ?? ((args: string[]) => execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 }));
  const now = options.now ?? (() => new Date().toISOString());
  const eventId = options.eventId ?? randomUUID;

  const dir = findTemplateDir(templateId, env);
  if (!dir) {
    error(`case:ticket: template ${templateId} not found in private/templates or templates/seed`);
    return 2;
  }
  let template: Template;
  try {
    template = JSON.parse(readFileSync(join(dir, "template.json"), "utf8"));
  } catch (e) {
    error(`case:ticket: can't read ${dir}/template.json: ${message(e)}`);
    return 2;
  }

  const fieldProblems = ticketFieldProblems(template.ticket);
  if (fieldProblems.length) {
    error(`case:ticket: refused:\n${fieldProblems.map((p) => `- ${p}`).join("\n")}`);
    return 1;
  }
  const ticket = template.ticket as Ticket;

  const giveaways = [...templateTelltales(template), ...ticketLinkGiveaways(ticket)];
  if (giveaways.length) {
    error(`case:ticket: refused, the ticket would give the case away (${giveaways.join("; ")})`);
    return 1;
  }

  // Nothing is posted next to a broken answer key or audit log, as with every other case command (AUD-M24).
  const ledgerIssues = ledgerProblemsWithHistory([groundTruthPath, auditEventsPath]);
  if (ledgerIssues.length) {
    error(`case:ticket: the answer key or audit log has problems:\n${ledgerIssues.map((p) => `- ${p}`).join("\n")}`);
    return 2;
  }
  let events: Record<string, unknown>[] = [];
  let entry: Record<string, unknown> | undefined;
  try {
    if (existsSync(auditEventsPath)) events = readAuditLog(auditEventsPath);
    if (existsSync(groundTruthPath)) entry = readLedger(groundTruthPath).find((e) => e.caseId === caseId);
  } catch (e) {
    error(`case:ticket: can't read ${auditEventsPath} or ${groundTruthPath}: ${message(e)}`);
    return 2;
  }
  // The ticket must be for the template the case actually planted: a wrong id would post a wrong public
  // ticket. A real run comes after inject, so the case must be in the answer key by then (AUD-M24).
  if (entry ? entry.templateId !== templateId : !options.dryRun) {
    error(
      entry
        ? `case:ticket: refused, ${caseId} planted template ${String(entry.templateId)}, not ${templateId}`
        : `case:ticket: refused, ${caseId} is not in the answer key yet: run inject first`,
    );
    return 1;
  }
  if (alreadyTicketed(events, caseId)) {
    error(`case:ticket: refused, ${caseId} already has a ticket`);
    return 1;
  }

  const factory = options.factory ?? loadFactory();
  const target = repoConfig(factory, "target");
  const body = buildBody(target.tickets, ticket);

  if (options.dryRun) {
    log(`[case:ticket] dry run, would create an issue on ${target.github}:`);
    log(`Title: ${ticket.title}`);
    log(body);
    log(`Command: gh issue create --repo ${target.github} --title ${JSON.stringify(ticket.title)} --body <above>`);
    return 0;
  }

  // An attempt is marked before the call: if `gh` times out after GitHub created the issue, nothing else
  // would show it exists, and a rerun would post a second one on the repo the reviewer reads (#216).
  // Created exclusively ("wx"), so of two runs started together only one gets past this point.
  const attempt = join(evidenceDir, "gh-issue-create.attempt.txt");
  mkdirSync(evidenceDir, { recursive: true });
  try {
    writeFileSync(
      attempt,
      `${now()} gh issue create --repo ${target.github} --title ${JSON.stringify(ticket.title)}\n`,
      {
        flag: "wx",
      },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      error(`case:ticket: can't write the attempt marker ${attempt}, so gh was not called: ${message(e)}`);
      return 2;
    }
    error(
      `case:ticket: refused, an earlier run tried to create this ticket (${attempt}) and recorded no case.ticket-created event. Check ${target.github}'s issues; record the event by hand if it exists, or delete the marker if it doesn't`,
    );
    return 2;
  }

  let url: string;
  try {
    url = gh(["issue", "create", "--repo", target.github, "--title", ticket.title, "--body", body]).trim();
  } catch (e) {
    error(
      `case:ticket: gh issue create failed (check GitHub before retrying; marker kept at ${attempt}): ${message(e)}`,
    );
    return 2;
  }
  // Saved before anything else is parsed or written: if gh already created the issue, this is the
  // one record a human has to check GitHub before retrying, even if parsing or a later write fails.
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "gh-issue-create.raw.txt"), `${url}\n`);

  const number = issueNumberFromUrl(url);
  if (number === undefined) {
    error(
      `case:ticket: gh issue create did not return an issue URL (raw output saved to ${evidenceDir}, check GitHub before retrying): ${url}`,
    );
    return 2;
  }

  const issue = { repo: target.github, number, url, title: ticket.title, body };
  writeFileSync(join(evidenceDir, "ticket.json"), `${JSON.stringify(issue, null, 2)}\n`);
  appendFileSync(
    auditEventsPath,
    `${JSON.stringify({ eventId: eventId(), type: "case.ticket-created", at: now(), caseId, issue })}\n`,
  );

  log(`[case:ticket] created ${target.github}#${number}: ${url}`);
  log(`Closes #${number}`);
  return 0;
}

function usage(): never {
  console.error("usage: npm run case:ticket -- --template <id> --case <FF-NNNN> [--dry-run]");
  process.exit(2);
}

// Run only when called as a script, not when the tests import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      template: { type: "string" },
      case: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  if (!values.template || !values.case) usage();
  run(values.template, values.case, { dryRun: values["dry-run"] ?? false }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`case:ticket: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
