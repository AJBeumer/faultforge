/**
 * Applies one sabotage template to a clean target checkout and validates it.
 *
 *   npm run inject -- --template idempotency-guard-bypass-v1 --target ../faultforge-target --case FF-0001
 *
 * The mutation is committed on its own branch in the target repository (not pushed). A bug template counts
 * as validated only if the proof test of its `invariantId`, and of every `alsoBreaks` entry, passes on the
 * base commit and fails on the variant with a test that ran and failed (a proof that fails to load proves
 * nothing). A control counts as validated only if every proof in the corpus (every bug template's, private
 * and seed) passes on the base commit and still passes on the variant: a change that breaks a known
 * invariant is a real bug, not a control (AUD-M8). Either way the variant must typecheck, with the target's
 * `tsconfig.test.json` when it has one (what its own check compiles), else `tsconfig.json`, and its public
 * tests must run (and pass, for a control). Ledger entry, audit event and raw artefacts go to private
 * storage, which never enters the target repository.
 *
 *   npm run inject -- --template idempotency-guard-bypass-v1 --target ../faultforge-target --validate-only
 *
 * `--validate-only` checks the template against the schema and runs the same proofs and typecheck, without
 * planting anything: the target checkout ends exactly as it started (same HEAD, same branch, clean tree), and
 * nothing is written to private storage. No `--case` is needed or used.
 *
 * The body is `inject-case.ts`, loaded here with a dynamic import so that an error even while it loads is
 * caught (`cli-entry.ts`).
 *
 * Exit codes: 0 the template is valid and (in `--validate-only`) it validated as above, or (otherwise) the
 * case was planted and recorded; 1 a refusal (usage included) or a failed validation, printed on stderr;
 * 2 it stopped on an unexpected error, at load time or later (a git call failed, a mutation didn't apply),
 * printed on stderr. Whatever was done before the error stays done: check the target's branches.
 */
import { runEntry } from "./cli-entry.ts";

try {
  process.exit(await runEntry("inject", async () => (await import("./inject-case.ts")).main, process.argv.slice(2)));
} catch {
  process.exit(2);
}
