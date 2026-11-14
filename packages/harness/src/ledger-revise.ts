/**
 * Records that a case's template was changed after the case was planted, as its own audit event
 * (`template.revised`), so a rewrite after a verdict is on the record, dated and explained, instead of known
 * only from a code comment (AUD-M11).
 *
 *   npm run ledger:revision -- --case FF-NNNN --template <id> --commit <sha> --reason "<why>" [--dry-run]
 *
 * The commit is one in this repository (or, with `--repo <path>`, another, such as private storage) that
 * changed the template's `template.json`: `templates/seed/<id>/template.json`, or `templates/<id>/template.json`
 * in private storage's layout. The event carries the case, the template id, the SHA-256 of `template.json` in
 * the commit's parent (`oldHash`) and in the commit (`newHash`), the full commit id, the reason, the tool and
 * the environment. It is checked against `schemas/audit-event.v1.json` and appended through `appendEvent`.
 *
 * Refused, with nothing written: a case the answer key doesn't hold, or whose template is another; a commit
 * that didn't change that `template.json` (or didn't hold it, before or after); the same revision already
 * recorded for the case. `--dry-run` prints the event and writes nothing.
 *
 * Exit codes: 0 the event was appended, or printed with `--dry-run`; 1 refused (the reason is printed); 2 it
 * couldn't run: a bad command line, a commit git can't resolve, or a file that can't be read or written.
 * `npm run ledger:revision` runs `ledger-revise-cli.ts`, so an unexpected error, even while loading, is 2.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readAuditLog, readLedger } from "./ledger.ts";
import { appendEvent } from "./ledger-append.ts";
import { ROOT } from "./paths.ts";
import { sha256, TOOL } from "./provenance.ts";
import { privateDir } from "./templates.ts";

export interface RevisionInput {
  caseId: string;
  templateId: string;
  commit: string;
  reason: string;
}

/** Where a template's `template.json` sits in a repository: the lab's published layout, then private storage's. */
export function templatePaths(templateId: string): string[] {
  return [`templates/seed/${templateId}/template.json`, `templates/${templateId}/template.json`];
}

function git(repo: string, ...args: string[]) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "buffer" });
}

/** The template's `template.json` hash before and after `commit`, or why there is none. Throws when git can't run. */
export function revisionHashes(
  repo: string,
  templateId: string,
  commit: string,
): { commit: string; oldHash: string; newHash: string } | { refused: string } {
  const resolved = git(repo, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`);
  if (resolved.status !== 0) throw new Error(`git can't resolve ${commit} to a commit in ${repo}`);
  const full = resolved.stdout.toString("utf8").trim();
  for (const path of templatePaths(templateId)) {
    const after = git(repo, "show", `${full}:${path}`);
    if (after.status !== 0) continue;
    const before = git(repo, "show", `${full}^:${path}`);
    if (before.status !== 0)
      return { refused: `${path} didn't exist before ${full.slice(0, 12)}: that is its creation, not a revision` };
    const oldHash = sha256(before.stdout);
    const newHash = sha256(after.stdout);
    if (oldHash === newHash) return { refused: `${full.slice(0, 12)} didn't change ${path}` };
    return { commit: full, oldHash, newHash };
  }
  return { refused: `${full.slice(0, 12)} holds no template.json for ${templateId}` };
}

/**
 * The `template.revised` event for `input`, or why it is refused. Reads the answer key and audit log in
 * `privateRoot` and the commit in `repo`; writes nothing.
 */
export function buildRevision(
  input: RevisionInput,
  options: { repo: string; privateRoot: string; now?: Date },
): Record<string, unknown> | { refused: string } {
  const { caseId, templateId, reason } = input;
  if (!/^FF-\d{4}$/.test(caseId)) return { refused: `${caseId} is not a case id (FF-NNNN)` };
  if (!reason.trim()) return { refused: "a revision needs a reason" };
  const entry = readLedger(join(options.privateRoot, "ground-truth.jsonl")).find((e) => e.caseId === caseId);
  if (!entry) return { refused: `the answer key holds no ${caseId}` };
  if (entry.templateId !== templateId) {
    return { refused: `${caseId} was planted from another template, not ${templateId}` };
  }
  const hashes = revisionHashes(options.repo, templateId, input.commit);
  if ("refused" in hashes) return hashes;
  const events = readAuditLog(join(options.privateRoot, "audit-events.jsonl"));
  const held = events.some((e) => e.type === "template.revised" && e.caseId === caseId && e.commit === hashes.commit);
  if (held) return { refused: `${caseId}'s revision in ${hashes.commit.slice(0, 12)} is already recorded` };
  return {
    eventId: randomUUID(),
    type: "template.revised",
    at: (options.now ?? new Date()).toISOString(),
    caseId,
    templateId,
    oldHash: hashes.oldHash,
    newHash: hashes.newHash,
    commit: hashes.commit,
    reason: reason.trim(),
    tool: TOOL,
    environment: `${platform()}-${arch()}-node${process.versions.node}`,
  };
}

/** The command: `ledger-revise-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[], privateRoot: string = privateDir()): number {
  const usage =
    'usage: npm run ledger:revision -- --case FF-NNNN --template <id> --commit <sha> --reason "<why>" [--repo <path>] [--dry-run]';
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        case: { type: "string" },
        template: { type: "string" },
        commit: { type: "string" },
        reason: { type: "string" },
        repo: { type: "string" },
        "dry-run": { type: "boolean" },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`ledger:revision: ${(error as Error).message}\n${usage}`);
    return 2;
  }
  const { case: caseId, template, commit, reason } = values;
  if (
    typeof caseId !== "string" ||
    typeof template !== "string" ||
    typeof commit !== "string" ||
    typeof reason !== "string"
  ) {
    console.error(usage);
    return 2;
  }
  let event: Record<string, unknown>;
  try {
    const built = buildRevision(
      { caseId, templateId: template, commit, reason },
      { repo: typeof values.repo === "string" ? values.repo : ROOT, privateRoot },
    );
    if ("refused" in built) {
      console.error(`[ledger:revision] refused, nothing written: ${built.refused}`);
      return 1;
    }
    event = built;
    if (values["dry-run"]) {
      console.log(JSON.stringify(event));
      console.error("[ledger:revision] dry run: nothing written");
      return 0;
    }
    appendEvent(join(privateRoot, "audit-events.jsonl"), event);
  } catch (error) {
    console.error(`[ledger:revision] couldn't run: ${(error as Error).message}`);
    return 2;
  }
  console.log(JSON.stringify(event));
  console.error(`[ledger:revision] appended ${String(event.eventId)}; commit and push private storage`);
  return 0;
}
