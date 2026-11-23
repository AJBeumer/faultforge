---
name: prove-finding
description: Turn one code review finding into a proof bundle - a failing test plus a fix confined to the cited lines - or an honest "disproven" or "inconclusive". Use when asked to prove, check, reproduce or challenge a review finding (Qodo's or anyone's) on a TypeScript checkout with Vitest, before acting on the finding. An independent verifier (`npm run proof:verify` in FaultForge) decides whether the bundle earns a certificate; your own verdict is not evidence.
---

# Prove a finding

A review finding is a claim: "lines X to Y of this file do something wrong". This skill turns the claim into something a machine can check. You write a test that fails because of the claimed problem, and the smallest fix to the cited lines that makes it pass. A separate verifier then re-runs both in a clean copy of the commit. You never get to say "proven" yourself.

Being wrong in the safe direction is fine. A bundle that says `disproven` or `inconclusive` when the finding is real costs a little. A bundle that "proves" a finding that isn't real is the worst outcome: never bend the test or the fix to make a proof appear.

## Inputs

You need all four. If one is missing, stop and ask for it (see "Stop and ask").

1. **The finding text**: its title and description, as the reviewer wrote it.
2. **The cited file**, as a path from the repository root.
3. **The cited lines**: a start and an end line, 1-based, in the checkout you are given.
4. **The bundle folder**: where to write the result. Default `proof-bundle/` in the working folder.

The working folder is a checkout of exactly the commit that was reviewed, with dependencies installed. Read the code only from this folder.

## Steps

Do them in order. Write down what you did at each step; it goes into `notes.md`.

1. **Check the inputs.** Open the cited file and read the cited lines. If the file is missing or shorter than the end line, stop and ask. Copy the cited lines, exactly as they are, into `notes.md`.

2. **State the claim as a test case.** In one or two sentences in `notes.md`: which function or entry point, which input, what the code does now according to the finding, and what it should do instead. If the finding is not about behaviour a test can observe (a comment, naming, style, documentation, a CI workflow, performance without a stated limit), skip to step 7 with `inconclusive` and say why.

3. **Find how the code is tested.** Look for the existing test file next to the cited file (`<name>.test.ts` in the same folder). Read it for imports, helpers and fixtures. Reuse its style. Do not edit it.

4. **Write the proof test** at `<folder of the cited file>/<name>.proof.test.ts` (a new file; never an existing one). Rules:
   - Call the real code through its exports. Don't copy the code under test into the test.
   - Assert the behaviour the finding says is correct, with `expect`. The test must fail with an `AssertionError` when the problem is there. A crash, a thrown `TypeError`, an import error or a timeout is not a proof. If the claimed problem is a thrown error, assert it with `expect(() => ...).not.toThrow()` or `await expect(...).resolves`.
   - Use only relative paths inside the repository. No absolute paths, no `../../` above the repository, no network.
   - Keep it to one `it` (two at most), named after the claim.

5. **Run it on the code as it is:** `npx vitest run <path of the proof test>`.
   - **Red with an `AssertionError`:** the claim reproduces. Go to step 6.
   - **Green:** the code already behaves as the finding says it should, for this input. Try at most two other inputs that the finding itself describes or clearly implies. Still green: the verdict is `disproven`. Keep the test (it is the evidence) and go to step 7.
   - **Error (doesn't load, crashes, times out):** fix the test, not the code, and run it again. After three tries it still errors: `inconclusive`, step 7.

6. **Write the fix, confined to the cited lines.** Change only lines start to end of the cited file. You may replace them with more or fewer lines. Edit the file in place, then run the proof test again.
   - **Green:** record the replacement (step 7) and the verdict is `supported`.
   - **Still red, or the fix needs a line outside the cited range:** the cited lines are not shown to be the cause. The verdict is `inconclusive`; say in `notes.md` which other lines the fix would need. Do not widen the range.
   - Never change the test to make it pass with your fix. If the test was wrong, go back to step 4 and run step 5 again on the unfixed code.

7. **Write the bundle** to the bundle folder:
   - `proof.json`:
     ```json
     {
       "verdict": "supported | disproven | inconclusive",
       "testPath": "<path of the proof test from the repository root>",
       "cause": "<one sentence: what in the cited lines causes the failure, or why it is disproven or inconclusive>",
       "fix": { "start": <first replaced line>, "end": <last replaced line>, "lines": ["<new line 1>", "..."] }
     }
     ```
     `fix` only for `supported`. `start` and `end` are line numbers in the file *before* your edit, and must lie inside the cited lines. `lines` are the exact new lines, with their indentation.
   - `proof.test.ts`: a copy of the proof test, for `supported` and `disproven`.
   - `notes.md`: the cited lines, the claim as a test case, each command you ran and how it ended (red, green or error, with the first line of the failure).

8. **Report** in your last message: the bundle folder, the verdict, and one line per run (command and result). End with exactly one line: `PROVE-FINDING: <verdict>`.

## Expected results

- A real, testable finding: `supported`, with a test that is red on the code as it is and green with the fix to the cited lines.
- A finding about code that is already correct: `disproven`, with a green test that exercises exactly the claimed case.
- Everything else: `inconclusive`, with the reason. That is a valid result.

The verifier then checks four things you cannot argue with: the test is red as an assertion failure on a clean copy of the commit; it is green once only your `fix` is applied; the fix stays inside the cited lines; the test is a new file and changes no existing file. Only then is there a certificate.

## Stop and ask

Stop, say what is missing, and don't write a bundle when:

- the finding text, the cited file, the cited lines or the bundle folder is not given;
- the cited file doesn't exist, or has fewer lines than the cited end line;
- `npx vitest` is not available in the working folder (no `node_modules`);
- the working folder is not a checkout of the code the finding is about (the cited lines don't contain anything the finding mentions).

## Never

- Edit an existing test file, or change any file other than the cited one.
- Read anything outside the working folder, or look for the reviewer's or anyone's later fix.
- Weaken an assertion, or pick an input the finding doesn't describe, so that a test goes red.
- Report `supported` without a red run and a green run that you saw yourself.
