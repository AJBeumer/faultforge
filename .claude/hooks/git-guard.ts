/**
 * The git-level guard for a reviewed checkout (#191). The Claude Code guard reads commands, so a commit or
 * push started by a script is outside it; git runs its own hooks for every commit and push, whoever starts
 * them. `npm run guard:install` installs three hooks that call this file:
 *
 *   node git-guard.ts pre-commit <checkout>                  the staged files and their names
 *   node git-guard.ts commit-msg <checkout> <message file>   the commit message
 *   node git-guard.ts pre-push   <checkout>                  every unpushed commit, and new branch and tag names
 *
 * The checks are the Claude Code guard's own (guard-content.ts), read from git at the moment the content
 * would travel.
 *
 * Exit codes: 0 nothing in it names the lab or the bug; 1 refused: something does, or the content could not
 * be read, or the call was malformed. A hook that can't check refuses: git then stops the commit or push.
 */
import { readFileSync } from "node:fs";
import { telltales } from "../../packages/harness/src/neutral.ts";
import { type Pending, pendingIndex, pendingPush } from "./guard-content.ts";
import { firstLine, isEntry } from "./hook-io.ts";

/** What one hook call found: the reasons and where, or nothing when the content reads as ordinary. */
export function check(stage: string, checkout: string, messageFile?: string): Pending | undefined {
  let pending: Pending;
  if (stage === "pre-commit") pending = pendingIndex(checkout);
  else if (stage === "pre-push") pending = pendingPush(checkout);
  else if (stage === "commit-msg") {
    if (!messageFile) throw new Error("commit-msg needs the message file git passes");
    // Comment lines are dropped by git before the commit is made, so they are not part of the message.
    const message = readFileSync(messageFile, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    pending = { reasons: telltales(message), where: "the commit message" };
  } else throw new Error(`unknown stage ${stage}`);
  return pending.reasons.length ? pending : undefined;
}

function main(): number {
  const [stage = "", checkout = "", messageFile] = process.argv.slice(2);
  try {
    if (!checkout) throw new Error("usage: git-guard.ts <pre-commit|commit-msg|pre-push> <checkout> [message file]");
    const found = check(stage, checkout, messageFile);
    if (!found) return 0;
    console.error(
      `review guard: refused. ${found.where} would give the change away (${found.reasons.join(", ")}). Remove it and try again.`,
    );
    return 1;
  } catch (error) {
    console.error(`review guard: refused, because it could not check (${firstLine(error)}).`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exit(main());
