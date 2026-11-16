/**
 * What a shell command would post, and the checks that no post names a private template or publishes a file from
 * private storage (AUD-H1, re-grade 3). Split from guard-target.ts, which may not pass 400 lines.
 */

import { stripReviewedNames, within } from "../shared/repos.ts";
import { commitMessages, commitSteps, outsidePostedText, postedText } from "../shell/posted.ts";
import { joinedWords } from "../shell/scan.ts";
import { unreadablePost } from "../target/expand.ts";
import { builtText, referencedFiles, stdinFiles } from "../target/posted-files.ts";
import { explicitDestinations, graphqlMutation, urlDestinations } from "../target/reach.ts";
import { type Context, deny } from "../target/tools.ts";
import { assetFiles } from "./assets.ts";
import { onlyPrivateRepo, PRIVATE_ID_REASON, privateRoot } from "./private-ids.ts";

/**
 * Every text a command would post, each judged on its own: the command itself (as written and with its
 * quote marks joined), flag values, heredoc bodies, posted files, and files a substitution reads. A commit
 * joins every `-m` and `-F` into one message, so those are also judged together. With `strict`, text built by
 * any other command is refused (#242): everywhere in a post to a reviewed repo, and in the posted values of a
 * lab post while private templates exist (`everywhere` false; #285).
 */
export function postedPieces(ctx: Context, command: string, strict = false, everywhere = strict): string[] {
  const pieces = [stripReviewedNames(ctx.reviewed, command), stripReviewedNames(ctx.reviewed, joinedWords(command))];
  pieces.push(...postedText(command), ...referencedFiles(ctx.cwd, command), ...stdinFiles(ctx.cwd, command));
  // A gist's files and a release's assets are posted too (re-grade 3).
  pieces.push(...assetFiles(ctx.cwd, command, ctx.backticks).map((asset) => asset.text));
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
export function checkPrivateIds(ctx: Context, command: string, readable: boolean) {
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

/**
 * A gist or a release may not publish a file from private storage (re-grade 3), unless the release goes to the
 * private repo itself. A gist is readable by anyone with its link, so it never counts as private.
 */
export function checkPrivateFiles(ctx: Context, command: string) {
  const root = privateRoot(ctx.env);
  const leaving = assetFiles(ctx.cwd, command, ctx.backticks).filter((asset) => within(asset.path, root));
  if (!leaving.length) return;
  const outside = outsidePostedText(command);
  const destinations = [...explicitDestinations(outside), ...urlDestinations(outside)];
  const gist = leaving.some((asset) => asset.gist);
  if (gist || !destinations.length || !onlyPrivateRepo(command, ctx.cwd, root, destinations)) {
    deny("This would publish a file from private storage. Nothing there may leave it.");
  }
}

/** The denial for a post whose text is a shell variable the command doesn't set. */
const UNREADABLE_VARIABLE =
  "This post's text comes from a shell variable the command doesn't set, so the guard can't read it. Write the text in the command, or in a file passed with --body-file.";
