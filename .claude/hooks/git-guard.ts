/**
 * The git-level guard for a reviewed checkout (#191). The Claude Code guard reads commands, so a commit or
 * push started by a script is outside it; git runs its own hooks for every commit and push, whoever starts
 * them. `npm run guard:install` installs three hooks that call this file:
 *
 *   node git-guard.ts pre-commit <checkout>                  the staged files and their names
 *   node git-guard.ts commit-msg <checkout> <message file>   the commit message
 *   node git-guard.ts pre-push   <checkout> <remote> <url>   what this push sends (git's updates on stdin), and
 *                                                           every unpushed commit and local branch and tag name
 *
 * The checks are the Claude Code guard's own (guard-content.ts), read from git at the moment the content
 * would travel.
 *
 * Exit codes: 0 nothing in it names the lab or the bug; 1 refused: something does, or the content could not
 * be read, or the call was malformed. A hook that can't check refuses: git then stops the commit or push.
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_BUDGET_MS,
  type Pending,
  type PushUpdate,
  pendingIndex,
  pendingPush,
  pendingPushUpdates,
  reasonsIn,
  withDeadline,
  withPrivateNames,
} from "./guard-content.ts";
import { privateIdMatcher, privateTemplateIds } from "./guard-private.ts";
import { firstLine, isEntry } from "./hook-io.ts";

/** What one hook call found: the reasons and where, or nothing when the content reads as ordinary. */
export function check(stage: string, checkout: string, arg?: string, stdin = ""): Pending | undefined {
  // One deadline for every scan this hook runs (audit N-4).
  // Private template ids may not travel either (AUD-H1); none are known where there is no private folder.
  const names = privateIdMatcher(privateTemplateIds(process.env));
  return withDeadline(DEFAULT_BUDGET_MS, () => withPrivateNames(names, () => checkNow(stage, checkout, arg, stdin)));
}

function checkNow(stage: string, checkout: string, arg?: string, stdin = ""): Pending | undefined {
  let pending: Pending;
  if (stage === "pre-commit") pending = pendingIndex(checkout);
  else if (stage === "pre-push") {
    // Git names the remote and passes each proposed update on stdin: what this push really sends, to the
    // ref names it really creates, is checked, as well as everything not yet on any remote (Qodo on PR 213).
    if (!arg) throw new Error("pre-push needs the remote name git passes");
    const pushed = pendingPushUpdates(checkout, arg, parseUpdates(stdin));
    pending = pushed.reasons.length ? pushed : pendingPush(checkout);
  } else if (stage === "commit-msg") {
    if (!arg) throw new Error("commit-msg needs the message file git passes");
    // The whole file: with `-m`, git keeps lines that start with `#` (Qodo on PR 213).
    pending = { reasons: reasonsIn(readFileSync(arg, "utf8")), where: "the commit message" };
  } else throw new Error(`unknown stage ${stage}`);
  return pending.reasons.length ? pending : undefined;
}

/** The ref updates git writes to a pre-push hook's stdin: `<local ref> <local sha> <remote ref> <remote sha>`. */
export function parseUpdates(stdin: string): PushUpdate[] {
  return stdin
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([, localSha = "", remoteRef = "", remoteSha = ""]) => ({ localSha, remoteRef, remoteSha }));
}

function main(): number {
  const [stage = "", checkout = "", arg] = process.argv.slice(2);
  try {
    if (!checkout) throw new Error("usage: git-guard.ts <pre-commit|commit-msg|pre-push> <checkout> [message file]");
    const found = check(stage, checkout, arg, stage === "pre-push" ? readFileSync(0, "utf8") : "");
    if (!found) return 0;
    // A branch named after a private template would be printed in `where`: never print it (Qodo on PR 265).
    const where = found.reasons.includes("names a private template") ? "what this would send" : found.where;
    console.error(
      `review guard: refused. ${where} would give the change away (${found.reasons.join(", ")}). Remove it and try again.`,
    );
    return 1;
  } catch (error) {
    console.error(`review guard: refused, because it could not check (${firstLine(error)}).`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exit(main());
