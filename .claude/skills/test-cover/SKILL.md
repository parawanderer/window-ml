---
name: test-cover
description: Given a source file you changed, name the test files that can notice it and the exact command to run them. Use BEFORE choosing which suite to run — the failure it exists for is verifying a change against the tests you happened to think of, while the acceptance tests for it sat in a file you never opened.
---

# Which tests cover this code

```bash
node scripts/test-cover.mjs src/sidebar/services.ts     # the tests that reach this module, and how to run them
node scripts/test-cover.mjs --changed                   # …for everything this branch changed
node scripts/test-cover.mjs --changed --cmd             # just the commands, to paste
node scripts/test-cover.mjs src/chat/grants.ts --why    # …with the import chain that reaches it
node scripts/test-cover.mjs src/x.ts --all              # …naming the suites that boot a whole build
```

Output is TAB-separated: `TEST FILE`, `COMMAND`. The summary line on stderr lists the distinct commands, so
`--cmd` gives you something to paste.

## When to reach for it

**Before running a suite**, not after. `npm run test:chat` runs three specs; it does not run
`tests/e2e/cross-page.spec.mjs`, where the acceptance tests for continuing a capped run live. Changing
`canContinue` and running the chat genre looks like verification and is not. One command says which suites the
change can reach.

**Before saying a change is covered.** "The tests pass" means the tests you ran passed.

**After a refactor**, to find the suites that load the file you moved — including the ones that reach it through
`tests/helpers.js` and a bundle, which no grep will show you.

## What it claims, and what it does not

It answers **"which suites could possibly notice this change"** — the question you need in order to choose. It does
NOT answer "is this line covered": that is `npm run coverage` and `scripts/coverage-lines.mjs`. It over-reports
deliberately, because running one suite too many costs a minute and running one too few is the failure it is named
after.

## Gotchas

- **Two kinds of reach, reported separately.** A test that IMPORTS your module is listed by name. A test that boots
  a whole BUILD — every Playwright spec, which hands `dist/` or `dist-web/` to a browser — can notice any source
  change at all, so those are counted rather than listed (`--all` names them). Do not read the count as "42 suites
  are about your change".
- **A specifier built from a variable is skipped**, not guessed at: a wrong edge sends you to the wrong suite with
  confidence, which is worse than a missing one.
- **It resolves by hand, not through the compiler.** The tests are `.mjs`/`.js` loading source with
  `await import("../src/x.ts")` — a string the language service does not follow from a JS file — and
  `tsconfig.tests.json` has two root files. `scripts/imports.mjs` is the compiler-backed tool, and it is the right
  one for source-to-source questions.
- **`--changed` compares against `origin/main`'s merge base** and looks only at `src/` and `mobile/`. A branch that
  touched only scripts or tests says so and exits 0.

## Keeping this current

`scripts/test-cover.mjs`, tested by `tests/test-cover.test.mjs` against throwaway files in a temp dir — the
specifier reader is the whole of its correctness, so that is what the tests pin. Its sibling is
`scripts/test-index.mjs` (`.claude/skills/test-index/`), which answers "what tests exist about X"; this one answers
"what tests reach this file". Change either and its skill, the AGENTS.md mention and these files change with it.
