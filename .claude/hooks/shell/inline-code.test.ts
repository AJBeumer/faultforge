/**
 * What counts as an interpreter's inline code (Qodo on PR 310): the code it is handed (`-e`, `-c`, a heredoc, a
 * pipe into one that reads its code from stdin), never a script's path or its arguments, and never another
 * step's text. A network call stays a network call when its function is aliased first. The private id is made up.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide as policyDecide } from "../factory-policy.ts";
import { guardConfig, tempRepo } from "../fixtures.ts";
import { decide as guardDecide } from "../guard-target.ts";
import { BUILT_CODE_REASON, INLINE_NETWORK_REASON } from "./exec.ts";

const CONFIG = guardConfig(tempRepo(true).dir);
const LAB = mkdtempSync(join(tmpdir(), "inline-code-lab-"));
const PRIVATE = (() => {
  const dir = mkdtempSync(join(tmpdir(), "inline-code-private-"));
  mkdirSync(join(dir, "templates", "x-secret-v1"), { recursive: true });
  return dir;
})();
const PRIVATE_SLASHED = PRIVATE.replace(/\\/g, "/");

function guard(command: string): string | undefined {
  const payload = JSON.stringify({ tool_name: "Bash", cwd: LAB, tool_input: { command } });
  const decision = guardDecide(payload, { ...process.env, FAULTFORGE_CONFIG: CONFIG, FAULTFORGE_PRIVATE_DIR: PRIVATE });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

const RUN_ENV = { FAULTFORGE_FACTORY_RUN: "1", FAULTFORGE_RUN_ROOT: LAB, FAULTFORGE_TICKET_NUMBER: "7" };
function policy(command: string): string | undefined {
  const payload = JSON.stringify({ tool_name: "Bash", cwd: LAB, tool_input: { command } });
  const decision = policyDecide(payload, { ...process.env, ...RUN_ENV });
  if (decision.kind === "error") throw new Error(decision.message);
  return decision.kind === "deny" ? decision.reason : undefined;
}

describe("an aliased network call is still a network call (Qodo on PR 310)", () => {
  it.each([
    `node -e "const f = fetch; f('https://example.com')"`,
    `node -e "const {fetch: f} = globalThis; f('https://example.com')"`,
    `node -e "const g = globalThis.fetch; g('https://example.com')"`,
    `node -e "Reflect.get(globalThis, 'fe' + 'tch')('https://example.com')"`,
    `node -e "Object.values(globalThis)"`,
    `node -e "fe\\u0074ch('https://example.com')"`,
  ])("the guard and the factory policy refuse %s", (command) => {
    expect(guard(command)).toMatch(
      new RegExp(`${INLINE_NETWORK_REASON.slice(0, 30)}|${BUILT_CODE_REASON.slice(0, 30)}`),
    );
    expect(policy(command)).toBeDefined();
  });

  it.each([
    "python3 /dev/stdin <<'EOF'\nimport urllib.request\nEOF",
    "node /dev/stdin <<EOF\nfetch('https://example.com')\nEOF",
    "echo \"fetch('https://example.com')\" | node /dev/fd/0",
    // A later inline flag doesn't drop the code piped in (Qodo on PR 313).
    "echo \"fetch('https://example.com')\" | node /dev/stdin -e 1",
    "NODE_OPTIONS='--import=data:text/javascript,fetch(\"https://example.com\")' node x.mjs",
    'python3 -m timeit "import urllib.request"',
  ])("refuses network code fed as a file from stdin: %s (Qodo on PR 312)", (command) => {
    expect(guard(command)).toBe(INLINE_NETWORK_REASON);
  });

  it("lets a run alias fetch for the app on localhost", () => {
    expect(policy(`node -e "const f = fetch; f('http://localhost:3000/bookings')"`)).toBeUndefined();
  });

  it("leaves git fetch alone", () => {
    expect(guard("git fetch origin")).toBeUndefined();
    expect(policy("git fetch origin")).toBeUndefined();
  });
});

describe("a script's path and arguments, and other steps, are not inline code (Qodo on PR 310)", () => {
  it.each([
    "python -m pytest tests/test_subprocess.py",
    "python3 -m pytest -k ctypes tests",
    "npx tsx packages/harness/src/x.ts | grep 'eval('",
    "node scripts/build.js --mode subprocess",
    // A later step is not the code an option variable hands Python (Qodo on PR 312, fourth review).
    "PYTHONPATH=src python3 -m pytest tests; grep 'subprocess' README.md",
  ])("the guard allows %s, and the factory policy doesn't take it for built code", (command) => {
    expect(guard(command)).toBeUndefined();
    // A run may still not run a script directly (its own rule): only the built-code reason is gone.
    expect(policy(command) ?? "").not.toContain(BUILT_CODE_REASON.slice(0, 40));
  });

  it("the factory policy allows a test run with a word that looked like code", () => {
    expect(policy("python3 -m pytest -k ctypes tests")).toBeUndefined();
  });

  it.each([
    `python -c "import subprocess; subprocess.run(['ls'])"`,
    "echo 'import subprocess' | python",
    "echo 'import subprocess' | python -",
    "python3 - <<'EOF'\nimport subprocess\nEOF",
    `node -e "require('child_process').execSync('ls')"`,
    `node --require ./x.js -e "require('child_process')"`,
    "perl -e 'system(\"ls\")'",
    "ruby -e 'system(\"ls\")'",
    // Code from stdin or a substitution named as the script (Qodo on PR 312).
    "python3 <(echo 'import subprocess')",
    // A module that runs code it is given, and code handed over in an option (Qodo on PR 312).
    'python3 -m timeit "import subprocess"',
    "echo 'import subprocess' | python3 -m code",
    // An interpreter named after a prefix's value runs its own inline code (Qodo on PR 312, fourth review).
    `npx --package tsx tsx -e "require('child_process').execSync('ls')"`,
    `npx -p tsx tsx -e "require('child_process')"`,
    // A flag whose value is a separate word, then inline code (Qodo on PR 312, fifth review).
    `node --disable-warning ExperimentalWarning -e "require('child_process')"`,
    `node --inspect-port 9229 -e "require('child_process')"`,
    `python3 --check-hash-based-pycs never -c "import subprocess"`,
    "node --import 'data:text/javascript,require(\"child_process\")' x.mjs",
    "NODE_OPTIONS='--require ./x.cjs --eval require(\"child_process\")' node x.mjs",
    "echo 'import subprocess' | python3 /dev/stdin",
    "node /dev/stdin <<'EOF'\nrequire('child_process')\nEOF",
  ])("still refuse inline code that starts a program: %s", (command) => {
    expect(guard(command)).toBe(BUILT_CODE_REASON);
    expect(policy(command)).toBeDefined();
  });
});

describe("a private template id as a script's argument (Qodo on PR 310)", () => {
  it.each([
    "npx tsx packages/harness/src/x.ts --template x-secret-v1",
    `node scripts/x.mjs ${PRIVATE_SLASHED}/templates/x-secret-v1/template.json`,
    "python3 tools/check.py x-secret-v1",
  ])("is allowed in a command that posts nothing: %s", (command) => {
    expect(guard(command)).toBeUndefined();
  });

  it.each([
    `node -e "console.log('x-secret-v1')"`,
    "python3 -c \"print('x-secret-v1')\"",
    "node <<'EOF'\nconsole.log('x-secret-v1')\nEOF",
  ])("is still refused in inline code: %s", (command) => {
    expect(guard(command)).toMatch(/still private/);
  });

  it("is still refused in a post", () => {
    expect(guard("gh pr comment 5 -R AJBeumer/faultforge -b x-secret-v1")).toMatch(/still private/);
    expect(guard("npx tsx x.ts --template x-secret-v1 && gh issue comment 5 -b x-secret-v1")).toMatch(/still private/);
  });
});
