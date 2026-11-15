/**
 * The factory policy's rule for `package.json` edits (re-grade 7): a run may change a package.json, but not the
 * check script (`scripts.check`) or any script the check runs (`npm run <name>`, `npm test`), followed from the
 * check through each script it names. Changed, `check` could pass trivially (`"check": "true"`) and the run would
 * look verified. The edit is applied to the file as it is now, the way the Edit and Write tools would, and the
 * scripts are compared before and after. A result that isn't JSON is refused: the rule can't read it. Split from
 * factory-policy.ts, which may not pass 400 lines.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export const CHECK_SCRIPT_EDIT =
  "the agent can't change package.json's check script or a script it runs (scripts.check, and each npm run or npm test in it)";

type Scripts = Record<string, unknown>;

/** The scripts of a package.json text, or undefined when it isn't a JSON object. */
function scriptsOf(text: string): Scripts | undefined {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  return scripts && typeof scripts === "object" && !Array.isArray(scripts) ? (scripts as Scripts) : {};
}

/**
 * The names of `check` and every script it runs: `npm run <name>` with or without flags on either side of `run`
 * (`npm -s run lint`, `npm run -s lint`), `npm test` and `npm t`, yarn's, pnpm's and bun's shorthand
 * (`yarn lint`), and `node --run lint`. A script a package manager runs comes with its `pre` and `post` script,
 * which npm runs around it; `node --run` runs neither (Qodo on PR 339). A word that names no script (`npm ci`)
 * adds a name nothing holds, which is harmless.
 */
export function checkScriptNames(scripts: Scripts): Set<string> {
  const names = new Set<string>();
  // Each name with whether its pre and post scripts run with it: true when a package manager runs it.
  const todo: [string, boolean][] = [["check", true]];
  const runs =
    /\b(?:npm|pnpm|yarn|bun)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:run(?:-script)?\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*)?([\w:.-]+)|\bnode\s+--run[=\s]+([\w:.-]+)/g;
  while (todo.length) {
    const [name, called] = todo.pop() as [string, boolean];
    if (called) todo.push([`pre${name}`, false], [`post${name}`, false]);
    if (names.has(name)) continue;
    names.add(name);
    const body = scripts[name];
    if (typeof body !== "string") continue;
    for (const m of body.matchAll(runs)) {
      const next = m[1] ?? m[2] ?? "";
      todo.push([next === "t" || next === "tst" ? "test" : next, m[1] !== undefined]);
    }
  }
  return names;
}

/** The file's text after the tool call, as the Edit, MultiEdit or Write tool would leave it. */
function afterEdit(tool: string, args: Record<string, unknown>, before: string): string {
  if (tool === "Write") return String(args.content ?? "");
  const edits = tool === "MultiEdit" && Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : [args];
  let text = before;
  for (const edit of edits) {
    const from = String(edit.old_string ?? "");
    const to = String(edit.new_string ?? "");
    if (!from) continue;
    text = edit.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to);
  }
  return text;
}

/**
 * Why an edit of `path` may not run because it changes the check script or a script the check runs, or undefined.
 * Only a file named package.json counts; a new one (nothing there yet) has no check to keep.
 */
export function checkScriptViolation(tool: string, args: Record<string, unknown>, path: string): string | undefined {
  if (basename(path).toLowerCase() !== "package.json" || !existsSync(path)) return undefined;
  if (!["Write", "Edit", "MultiEdit"].includes(tool)) return CHECK_SCRIPT_EDIT;
  const before = readFileSync(path, "utf8");
  let old: Scripts | undefined;
  let now: Scripts | undefined;
  try {
    old = scriptsOf(before);
    now = scriptsOf(afterEdit(tool, args, before));
  } catch {
    now = undefined;
  }
  if (!old) return undefined;
  if (!now) return `${CHECK_SCRIPT_EDIT}; the edited package.json must stay a JSON object the policy can read`;
  const [was, is] = [old, now];
  const names = new Set([...checkScriptNames(was), ...checkScriptNames(is)]);
  return [...names].some((name) => JSON.stringify(was[name]) !== JSON.stringify(is[name]))
    ? CHECK_SCRIPT_EDIT
    : undefined;
}
