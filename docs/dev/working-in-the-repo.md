# Working in the repo: the self-tools, the conventions and why

AGENTS.md states each rule in a sentence or two. This file is the reasoning and the measurements behind them,
moved out of AGENTS.md on 2026-10-07 so that file stays small enough to load into every session.

## Testing the upgrade, not just the new behaviour

**RULE — when you change a rule, test the UPGRADE, not just the new behaviour.** A change to a default, an
invariant or a wire rule leaves behind state the OLD code produced — accounts, certificates, signed lists, saved
sessions, stored config — and the new code meets that state on somebody's machine rather than on a fresh one. "The
new behaviour is correct" says nothing about the transition, and the transition is the only part a person who already
used the thing experiences.

The example this was written from: `may_revoke` defaulted to true for every runtime, so every account paired to date
has two or more revocation signers. The hub now admits exactly one. Neither the old steady state (two signers racing)
nor the new one (one signer) is what a real account does on the day it upgrades — what happens is that whichever
browser connects first becomes the record and the others are refused at login, which is a third behaviour, and the
one that needed a test. The hub session wrote it (`crates/hub/tests/auth.rs`: a NEWER second grant is the one refused,
and the record survives a restart); the point is to notice that it is a separate case at all.

The cheap form is a FIXTURE of what the old code wrote, read by the new code, asserting what a person sees. It is
usually a few lines, and it is the only test that can fail for the right reason on an upgrade.

## A validating rule: enumerate the inputs

**RULE — when one rule VALIDATES another's output, enumerate the inputs; do not sample them.** The resource
panel GENERATES layouts (`presetsFor`) and JUDGES them (`stackRefusal`), and the invariant is that a preset
may never propose a layout the rule then rejects. There is a drift guard for exactly that, and it shipped a
broken DEFAULT anyway, because it ran two machine shapes: a two-card box and a unified Mac. One discrete card
plus host RAM — the commonest machine there is — was assumed to be a weaker case of two cards. It is not: the
generator branched on `devices.length` while the rule judges POOLS, and those two quantities agree everywhere
except at one card, where a GPU plus the host is still two pools. The default preset proposed a stack the
panel then refused, on most people's hardware.

The general shape, which is worth recognising before it happens again:

- **A guard over generated output is only as good as the SHAPES of input it runs**, and "fewer of them" is a
  different shape, not a smaller one. Enumerate the kinds; do not pick two and assume monotonicity.
- **Watch for a PROXY quantity in the branch.** `devices.length` standing in for "how many pools" is the bug
  in one line — it was right on every box anyone had tested and wrong on the one they had not. When a
  decision is about X, branch on X, and if X is only available after a filter, read it after the filter.
- **The DEFAULT deserves its own assertion.** It is what a user meets without choosing anything, so it is the
  one worst to get wrong and the easiest to leave untested among a list.

**`tests/fixtures/boxes.mjs` holds the shapes** — one per kind of machine people actually have (two-card
CUDA, two-card ROCm, a four-card prosumer rig, a one-card laptop that has to spill, an eight-card lab node at
nine pools, and a unified Mac) — and it is SHARED with `resource-demo.mjs`, because a guard and a demo
disagreeing about what a box looks like is the same drift in another costume. Anything that routes on box
shape gets run against all of them.

## The code index

**RULE — before you build ANYTHING reusable, search for it by concept: `node scripts/index.mjs '<regex>'`.**
A module, an exported helper, a component, a hook, a CSS class. One TAB-separated line each — `KIND NAME
file:line [signature] first sentence of its docstring` — and the regex runs over the SENTENCE as well as the
name, which is the only way this works: nobody greps `tok-chip` while about to write a pill, or
`sw-values.ts` while about to write a value store. The failure it addresses is not "I searched and could not
find it", it is "I did not think to look": one session produced a CSS copy of the pointer chip, a FOURTH drag
handle, and a second view-return signal, and each was one search away. Two of those three were CSS, not JSX,
which is why it covers the stylesheet; the same thing happens to whole MODULES, which is why a file is a row.
Output is never column-padded, so it pipes into `grep`, `cut -f3` and `awk -F'\t'`. It replaced
`scripts/components.mjs` (sidebar components + CSS only). Filters: `--kind file,component,hook,function,
class,type,const,css,style`, `--exported`/`--local`, `--sig`, and `--mobile` to include the phone app (`mobile/`), which a
query leaves out by default. The checks below cover `mobile/` always: a React Native component needs its docstring and a
`StyleSheet` key its comment, exactly as a web export and a CSS class do.

**It indexes bindings, never their innards** — module-scope declarations only, since JavaScript nests
forever and that depth would bury the rows that mean something. One exception, one level deep and never
recursive: an object literal lists its own top-level keys (`API_FORMATS … keys: openai, ollama`), and a class
lists its method names, because that is the API surface in several files here.

The **docstrings are the index** (nothing is duplicated into a manifest that would go stale), so the cost is
that an undocumented thing is INVISIBLE and gets rebuilt. Three checks run in the pre-commit hook and CI's
`tools` job: **`--new <base> [--staged]`** is the RATCHET — every exported symbol and every new CSS family a
change ADDS needs a sentence; **`--headerless`** is a hard gate, because every source file already opens with
a header saying what the module is for and it must stay that way; **`--check-speed`** holds the tool to its
own time budget (a cold build is ~70 ms; it warns at 750 ms and fails at 3 s, with what to do about it in the
message), because an index that stops being cheap stops being run. The first is a ratchet rather than a rule
because 178 exports and 323 of the stylesheet's 557 classes have none, and a check that ships red is one
people learn to scroll past — so it reads the diff against the merge base and asks only about what you are
adding. A CSS member of a documented block passes on its ancestor (`.r-diff-head` inherits `.r-diff`), because
the failure being prevented is a NEW family under a name nobody would grep, not a paragraph per modifier.
What you owe it: a new shared thing gets a first sentence saying what it is FOR in words someone would
search, an EXTRACTION says what it replaced, and a new FILE opens with `// <name>.ts — <what it is for>.`
A TRAILING `//` counts as the docstring for a one-line export, which is the house style here — teaching the
scanner to read those fixed thirty of them with no churn, rather than having me move thirty comments above
their declarations to satisfy an indexer. Playbook: `.claude/skills/code-index/SKILL.md`.

## The test index

**RULE — a test goes under a SECTION, and `node scripts/test-index.mjs '<regex>'` is how you find one.** The code
index above made the source searchable and left the tests opaque, which is the worse half: the tests are where the
knowledge about behaviour lives, and they are what you must read before adding a twelfth test for a thing that has
eleven. `tests/sidebar.test.js` was 407 tests in 9,300 lines behind ten section comments (it is now twelve
`sidebar-*.test.js` files, and the index is what made that partition plannable) — grep finds a test whose
name you can already guess and answers neither question you actually have ("is this covered?", "where does a new one
go?"), and reading the file to find out costs about 150,000 tokens. The index answers both for about 5,000: one
TAB-separated line per test, `PATH:LINE  SECTION  NAME`, with the regex running over the section and the file's
header sentence as well as the name. `--stats` is the survey, `--sections` lists the groups, `--file <name>` narrows
to one. It PARSES rather than greps (TypeScript's parser through `@ts-morph/common`, since the repo's own
`typescript` is 7.x and exposes no JS API), because a regex over `test("` misses a template-literal name, a
`test.skip`, and a call spread over two lines, and finds the word inside a string.

A SECTION is a comment line — `// --- what this group is about ---` — and everything after it belongs to it until
the next one. **`--new <base> [--staged]` is the RATCHET** (pre-commit hook + CI's `tools` job): a test a change ADDS,
in a file that already has sections, must sit under one. It is deliberately narrower than "every test": 1,826 tests
predate it and a check that ships red is one people learn to scroll past — `--unsectioned` and `--headerless` are the
surveys for those, and both do ship red. What you owe it: a section name that says what the group is ABOUT in words
someone would search, and a header comment on a new test file saying what the file covers. Playbook:
`.claude/skills/test-index/SKILL.md`.

## Which suite can notice a change

**And before you choose WHICH suite to run: `node scripts/test-cover.mjs <file>` (or `--changed`).** The index above
says what tests exist; this says which of them can notice the file you just changed, and prints the command for each.
It exists for a failure with a name: a change to `canContinue` in the services seam was verified with
`npm run test:chat`, which runs three specs and not `tests/e2e/cross-page.spec.mjs`, where the two acceptance tests
for continuing a capped run actually live. Nothing connected the file to the suite, so the verification was against
the tests that came to mind. It passed. Two kinds of reach are reported separately: a test that IMPORTS the module is
named, and a test that boots a whole BUILD (every Playwright spec hands `dist/` or `dist-web/` to a browser, so it
can notice anything) is counted, because as a list of forty-two it buries the handful that are actually about the
change. It over-reports on purpose — a suite too many costs a minute. It is not coverage: "is this LINE covered" is
`npm run coverage`. Playbook: `.claude/skills/test-cover/SKILL.md`.

## Docs that point at files

**`node scripts/check-doc-links.mjs`** checks that what a Markdown doc points at exists. A LINK (`[x](../src/y.ts)`) is
resolved against the doc's own directory and fails anywhere in the repo, since there were 79 with one broken when the
check was written (a spec still linking `../../background.ts` from before sources moved into `src/`). A BACKTICKED path
is how these docs mostly name a file, about 400 of them, and some are deliberately historical ("it replaced
`components.mjs`") or name a file in the window-ml-hub repo: those are a ratchet, failing only on lines a change adds,
and a plain run lists the old ones. A doc under `mobile/` resolves `src/` from `mobile/` as well. Fenced code and inline
code are not links. It runs on EVERY commit rather than only one that stages a doc, because renaming a source file is
what breaks a link and that commit stages no Markdown. `move-files` rewrites both kinds of reference when it moves a
file, so a move made with it never trips this.

## JSDoc that contradicts the code

**RULE — JSDoc that CONTRADICTS the code is a defect; JSDoc that is INCOMPLETE is not.** In a `.ts` file the
compiler treats JSDoc as prose — `@param` names and types are never checked — and this repo lifts the
contract's JSDoc verbatim into what the MODEL reads, so drift there ships a wrong API reference. `node
scripts/check-jsdoc.mjs` reports three things: a doc block immediately followed by another doc block (it
documents nothing), a `@param` naming something the declaration does not have, and a `@param {string}` on an
`x: number` — the last only when both are concrete primitives that disagree, because `{Object}` for a `Record`
is JSDoc's own vaguer spelling rather than drift. A MISSING `@param` is never reported, and neither is a block
above `range: mlRange,` — a member documented where it joins the API but declared in another file, so nothing
here can contradict it. Ratcheted against the diff in the pre-commit hook and CI's `tools` job. It found ten
real cases the day it was written, the clearest being a doc block that had drifted one member up, so one
function had no documentation and the next advertised an option it does not take. The repo is at zero
findings: every one of the ten was a block that had drifted off its declaration, and each was FOLDED BACK
rather than deleted, because a stranded block is usually the only copy of what it says.

## File size, and what a refactor is worth

**A HUGE TEST FILE COSTS MORE THAN ITS TESTS.** Splitting `sidebar.test.js` (407 jsdom tests) into twelve files
cut the SAME tests from 105s to 54s of CPU — in separate processes, with nothing shared and nothing rewritten. One
process accumulating hundreds of jsdom worlds goes superlinear (it was carrying ~1.7 GB and burning ~270% CPU on
GC), and under `--jobs` it then contends with every other file: the full suite measured 133s and 359s on two runs
before, and 36s and 46s after. So a slow test file is not only serial, it is also EXPENSIVE, and `--timings` hides
both — it runs one process per file, so its total is a SUM and its per-file number is that file at its best, alone
on the machine. `background.test.js` (22s) and `cdp-stream.test.mjs` (20s) are the same shape and untested.

**A file that has grown past ~800 lines gets a REMINDER** (`node scripts/check-file-size.mjs`) — in the
pre-commit hook and in CI's `tools` job suggesting it be split into logical modules, with per-module tests where that follows. It never
fails a build — size is a judgement, and a long LIST is not a long module. It is RATCHETED:
fifteen files are already over the line, so it speaks only when a change makes an oversized file bigger,
which is the moment the advice is actionable. `--all` lists every one of them when you do want the survey.

**To decide WHERE to spend a refactor, use `--cost`, not `--all`.** `--all` sorts by length, which answers "what
is big" — the wrong question, because a long file nobody opens costs nothing while a shorter one edited weekly
costs a lot. `--cost` ranks by lines x commits-that-touched-it, each commit DECAYED by a 30-day half-life
(`--half-life`), so a subsystem that was finished two months ago stops outranking one being built this week. On this repo that reordering is not cosmetic: the three resource-panel files are
half the total while being 15% of the lines, and `dom.ts`, fourth by length, is under 2%. It ignores the 800-line
limit deliberately, because cost has no threshold and the size gate cannot see a 430-line file edited 42 times.
Read the script's header before treating it as a verdict: commits are WRITES, so a heavily imported type module
is read far more than it is edited (`contract.ts`: 327 lines, 85 importers), which is why fan-in is printed
beside the score rather than folded into it. Playbook: `.claude/skills/file-size/SKILL.md`. Watch the `recent` vs `all` columns — while they stay close, the
decay is inert and the ranking is plain churn; a file whose ratio falls below about half is one whose work has
stopped. **Decay can never hide bloat**: every file over 800 lines that does not make the ranking is listed
underneath it anyway, with its commit count, because big-and-quiet is exactly what a decayed score buries.

## Vitals

**The codebase is itself an experiment, and `node scripts/vitals.mjs` is its record.** Whether agents can keep a
codebase nobody reads working as it grows is one of the questions this repo exists to answer, so it keeps monthly
figures in `docs/vitals/history.json`: lines by kind, big files, commits by conventional kind, CI failures on main and
on PRs, for this repo, the hub and the forks. Run it about once a month and commit the result; CI history ages out
of GitHub, so a month nobody recorded is lost. Commit subjects are what it classifies, so keep using the
`feat:`/`fix:` prefixes. Skill: `.claude/skills/vitals/SKILL.md`.
Tests are exempt: a long test file is a long LIST, which is not the same failure as a long module.

## Imports, extract-function, move-symbols

**To see what actually connects two files, ask `node scripts/imports.mjs`** — `<file>` for its in- and
out-edges with the names on each, `<a> <b>` for exactly which names cross in each direction, `--cycles` for every
import cycle in the project. It resolves through the compiler (the same `scripts/refactor/graph.mjs` move-symbols
uses), so it tells a TYPE-only edge from a value one, which is what decides whether a cycle is real; it also sees
the inline `import("./contract").X` query that no grep for an import statement will match. Reach for it BEFORE
planning a split, because what blocks a split is a file's edges, not its size: three attempts on `vram.tsx` died
on cycles that this answers in one command. Skill: `.claude/skills/imports/SKILL.md`.

**To cut up a body rather than move a declaration, use `node scripts/extract-function.mjs`** — `--file <f>
--lines <a-b> --name <fn>`, 1-based inclusive, `--dry-run --diff` first. move-symbols moves whole top-level
declarations BETWEEN files and cannot touch what is inside one, which leaves the operation a long component
actually needs as hand editing. TypeScript's own `Extract Symbol` does the closure analysis (which locals become
parameters, what has to come back), this picks module scope, gives the result your name instead of
`newFunction`, and refuses on a new type error. Extract first, then move-symbols the result if it belongs in
another file — the extracted function is a top-level declaration, which is exactly what that takes. Skill:
`.claude/skills/extract-function/SKILL.md`.

**To relocate whole files, use `node scripts/move-files.mjs --to <dir> <files>`** (`--dry-run --diff` first).
move-symbols moves declarations between files and leaves a file's location alone; a folder move is the other
operation, and doing it with `git mv` leaves every import, every test's `await import("../src/…")` and build.mjs's
entry points to be found by error. A move changes no code, only paths, so it is path arithmetic over every tracked
file rather than a compiler refactor: that is what reaches the strings TypeScript's own rename never sees. It reports
the one form it cannot rewrite (a path assembled from pieces), blocks on a path that would dangle, and fails on a new
type error. Skill: `.claude/skills/move-files/SKILL.md`.

**RULE — move code between files with `node scripts/move-symbols.mjs`, never by copy and paste.**
`--from <file> --symbols a,b --to <file> --dry-run --diff` plans the move; drop `--dry-run` to write it. The
compiler resolves what the code depends on, pulls along helpers only it uses, rewrites every import, re-export
and test `await import("../src/x.ts")`, puts the moved code back byte for byte, and refuses (writing nothing) on
a new type error, a new import cycle, state assigned across the new boundary, or a script that reads the source
file as text. A hand move retypes the code and finds the dependencies by eye, and the tests that load a module
by dynamic import are invisible to a type error: a destructured member just comes back `undefined`. Blocks and
their fixes: `.claude/skills/move-symbols/SKILL.md`.

## What goes in AGENTS.md, and the self-tool rule

**RULE — AGENTS.md holds working rules and traps; implementation notes go to `docs/dev/`.** Everything here is
loaded into every session, so it is for what you must know to work in the repo at all: the rules, the map, the
invariants, and one-line traps that break things silently. How a subsystem works and why it is built that way —
the explanation of a design, the bug that shaped it, the measurement behind a threshold — goes in that subsystem's
`docs/dev/<area>.md`, indexed under "Where the implementation notes live". A new subsystem gets a new file and a
row in that table, not a section here. Before adding a paragraph, ask whether someone NOT touching that code needs
it; if not, it belongs in the doc. (AGENTS.md was 2,763 lines before the first split — 257 KB in every session's context — and 94.8k characters before the second, on 2026-10-07.)

**RULE — self-tools get a skill + an AGENTS.md mention, and you keep both current — WITHOUT asking.** Any time you
(or any model working on this repo) build a TOOL FOR YOURSELF — a harness, wrapper, driver, or script you'll re-use
to develop/debug/benchmark the extension (e.g. `tests/e2e/observe.mjs`) — you MUST (1) write a **Claude skill**
(`.claude/skills/<name>/SKILL.md`) documenting exactly how it's used (invocation, env knobs, when to reach for it,
gotchas), and (2) add a **brief mention** of it in AGENTS.md so the next agent discovers it (its detail goes in
`docs/dev/e2e-harness.md`). Keeping AGENTS.md, your skill files, and the scripts they describe **in sync and up to
date is YOUR responsibility** — every time you change a self-tool's behaviour, update its skill + the AGENTS.md
mention in the same change. Do this proactively, never ask the user whether to. (Skills live in `.claude/skills/`;
the `observe` skill is the reference example.)

## No padding in model-facing text

**RULE — never pad model-facing text for alignment.** Column-aligning a list with `padEnd` is a HUMAN
scanning affordance. A model parses the fields either way and pays for every space, so padding is pure
context cost on a path whose whole purpose is usually to SAVE context. Measured on the `dereference`
candidate list: 55 of 557 characters — 10% — were padding, and it grows with the field widths. Use a single
space or a delimiter, and let the fields be ragged. This covers every string a model reads: tool results and
errors, tool/parameter descriptions, prompt clauses, fault messages. **Human-facing surfaces are the
opposite** — the sidebar, the HUD and the exports should align freely, and the sidebar gets it for free in
CSS, so nothing is lost by keeping the model-facing string dense. Testable: assert no run of two or more
spaces in the generated string (see `tests/token-pipe.test.mjs`, memoryFault).

## Builds, bundles and tests

- **Plain JS in docs/examples** — `document.querySelector`, never jQuery-style
  `$`/`$$` (those are devtools-only and read as dated).
- **Document functions with JSDoc** (`/** … */`, `@param`/`@returns` where useful),
  not a plain `//` block — so callers get the explanation on IDE hover at the call
  site. Inline `//` comments are for logic *inside* a body.
- **A FAILED build leaves `dist/` alone** — `build.mjs` bundles into `dist.stage/` and swaps only on
  success, because the old order (delete, then build) left a loaded extension with no manifest whenever
  anything threw. The consequence to remember: a build you silenced (`npm run build >/dev/null 2>&1`) that
  FAILED now looks exactly like one that worked, and everything you run next tests the previous bundle —
  which will mislead a bisect. It exits non-zero and says so on stderr; do not discard that stream.
- **A STALE bundle is now CHECKED rather than remembered** (`scripts/check-dist-fresh.mjs`, wired in as the
  Playwright suite's `globalSetup`). Every spec hands a built directory to a real browser, so a source edit
  without a rebuild used to run the previous build and report a result that looked exactly like a real one. The
  check refuses the run and names the directory and the command; it never rebuilds, because that would clobber a
  `dist/` someone has loaded in a window, from inside a test runner where nobody is watching. `E2E_DIST=<dir>`
  skips it (that bundle was built elsewhere on purpose) and `E2E_STALE_OK=1` overrides it. The same hole was in
  the npm scripts, not just in hand-run commands: `test:chat` built only `dist-web/` while running two specs that
  load `dist/` and `dist-native/`, and `pretest:e2e` built only `dist/` while the suite reads `dist-web/` too —
  both now run **`npm run build:all`**, which is the one command that builds every bundle.
- **Iterating? Run a GENRE, not the suite: `npm run test:core`** (~8s, 1,394 tests) — `node scripts/test.mjs`
  with `core` / `panel` / `ext` / `chat` / `python` / `live`, `--list` to see what each holds, `--timings` for
  per-file durations slowest-first (`npm run test:chat` is the chat page's suite by name: that genre plus its two
  Playwright specs). The full suite is ~40s in parallel, and its floor is now its slowest FILE
  (`background` 22s, `cdp-stream` 20s), which is the right cost in CI and the wrong one in a
  loop where you changed one pure module. **`--timings` is a SERIAL measure** — one process per file, so its
  total is a sum (206s), not a wall clock; read it for per-file cost, never for what the suite takes. `core` is DERIVED — everything the named genres do not claim — so
  a new test file runs by DEFAULT rather than falling out of every bucket and being silently skipped; the
  cost of that direction is that a new SLOW file quietly lands in `core`, which is what `--timings` is for.
  The OTHER cost is a whole subsystem landing there one file at a time — thirteen `hub-*` tests and nine
  `session-*` ones did, until "run the hub tests" meant running a hundred and twenty-three — so
  **`node scripts/test.mjs --check-genres`** (pre-commit hook + CI's `tools` job) fails when four files sharing a
  name prefix all sit in `core`: four files on one subject are a subject, and a subject gets a genre.
  **`--files a.test.mjs b.test.mjs`** runs exactly those, which is what `scripts/test-cover.mjs` prints.
  Still run the full `npm test` before you commit; CI runs everything regardless.
- **Tests: `npm test`** (Node ≥ 20, `node:test`). `tests/helpers.js` loads the
  real extension files into `node:vm` sandboxes with mocked `chrome`/`fetch`/
  `window`, so tests exercise the shipped code with no build step. Add a
  background-contract test to `tests/background.test.js` and a page-relay test to
  `tests/relay.test.js` for any new primitive. DOM-manipulating helpers
  (the agent tools) are tested against a real DOM via `loadDomWorld(html)`, which
  boots `injected.js` over a `jsdom` document. Live tests (`tests/live.test.js`)
  are opt-in via `.env` (see `.env.example`). **Real-CPython tests**
  (`tests/python.test.mjs`) load Pyodide-in-Node against the shared
  `python-runtime.ts` (built to `dist/python-runtime.js`) — the actual PRELUDE +
  `wrapUserCode` the offscreen sandbox runs, so the tables→df/auto-cast/`tables`
  dict/read_html/return-capture/RESET-isolation behaviour is checked against real
  pandas, not a copy. They need the bundled wheels (`dist/pyodide/`, from
  `npm run fetch-pyodide`) and **self-skip** when absent, so a bundle-less
  `npm test` stays green. CI fetches the wheels (cached by pyodide version) for
  both the test job (so these run) and the build job (so the uploaded extension
  artifact can actually run `python_exec`).
- **Running several sessions at once? Give each one its own CLONE**, as a sibling directory
  (`../window-ml-bench`, `../window-ml-md-negotiation`), and never work in whichever checkout the other
  sessions are using. Sharing one working tree costs real time, all of it observed rather than
  hypothetical: changes swept into another session's commit; their uncommitted files sitting in your
  `git status`, so `git add -A` is never safe; and the pre-commit hook regenerating
  `docs/spec/export.schema.json` from THEIR in-flight `export-schema.ts`, blocking an unrelated commit and
  telling you to stage their generated output.

  ```bash
  cd .. && git clone git@github.com:parawanderer/window-ml.git window-ml-<what-you-are-doing>
  cd window-ml-<what-you-are-doing>
  ln -s ../window-ml/.env .env                       # the backend + key, for USE_ENV=1
  ln -s ../window-ml/pyodide-wheels pyodide-wheels   # 28MB of static wheels, don't re-download
  git config core.hooksPath .githooks                # LOCAL config: it does not clone
  npm ci && npm run build
  ```

  The `core.hooksPath` line is easy to skip and its absence is silent in the worst direction: commits keep
  working, so nothing looks wrong, and the pre-commit checks (formatting, and regenerating
  `docs/spec/export.schema.json` to catch a stale one) simply never run. You find out in review.

  **Tell the user to open both directories in one VS Code window** (File > Add Folder to Workspace, or
  `code ~/git/window-ml ~/git/window-ml-bench`). Each session then edits its own tree while the human
  reads both side by side, and a file the user opens is unambiguous about which checkout it came from.

  A `git worktree` is the lighter alternative and shares the object store, but prefer a clone: a worktree
  has to symlink `node_modules` back into the shared checkout, and that coupling is what produced a
  self-referential symlink that replaced the real `node_modules` and left every dependency UNMET. Its own
  `npm ci` has no such edge. A worktree also refuses to check out a branch another worktree holds, which
  is occasionally what you want and occasionally just in the way.
- **Three gitignored things do NOT come with a fresh checkout, and no absence is loud.** `node_modules` is
  obvious (nothing runs); `pyodide-wheels/` is not — the build prints one `⚠ pyodide-wheels/ missing`
  line and carries on, `npm test` stays green because the CPython tests self-skip, and the failure only
  surfaces at RUNTIME as `ModuleNotFoundError: No module named 'numpy'` inside a `python_exec` step,
  which reads like a sandbox bug. **`.env` is the third**: `USE_ENV=1` (observe, the bench) then dies on
  `ENOENT ... /.env` before anything runs. Symlink `.env` and `pyodide-wheels` as above; run `npm ci` for
  `node_modules` rather than symlinking it. All three are ignored as plain names, so the symlinks cannot
  be committed — they previously had trailing slashes, which match a DIRECTORY only, and a `node_modules`
  symlink duly got committed and then replaced the real directory on the next pull.
- **A FOURTH absence is the quietest of all: the `wmlhub` binary.** Thirty tests across six files talk to a real hub
  rather than a mock, and without one they SKIP — so the suite is green and says nothing about the hub client. **`npm
  run fetch-hub`** downloads the pinned tag's published binaries (`wmlhub` and `wmlbox`), verifies the checksum
  published beside them, runs one to prove it starts here, and puts both where `tests/fixtures/hub-harness.mjs`
  looks. `WMLHUB_BIN` still wins, for a build of your own while changing the hub itself. CI runs them in the `hub`
  job, on PRs that touch what they cover; before the hub published binaries it could not, which is why a skipped test
  and a passing one looking identical on a green page is worth remembering.
- **Coverage: `npm run coverage`** — Node's built-in coverage (no dependency), writing
  `coverage/lcov.info` (the **Coverage Gutters** VSCode extension reads it with no configuration) plus a
  table on stdout. `node scripts/coverage-lines.mjs <file>` prints the gaps AS SOURCE, separating **NEVER
  RUN** from **BRANCH NOT TAKEN** — the second is the one a percentage hides, and the one that answers "was
  the `else` of this guard ever taken". Reach for it before claiming a path is tested: auditing the Markdown
  ladder this way found five untaken branches where the claim had been "fully covered", though only one was
  worth a test. `--enable-source-maps` is NOT optional in that script — tests run through tsx, so without it
  every line number describes the transform. See the `coverage` skill.
- **End-to-end tests: `npm run test:e2e`** (Playwright, `tests/e2e/*.spec.mjs`) —
  the ONE heavy layer that loads the **built** extension in a real Chromium. Use
  it **only** for behaviour jsdom/`node:vm` genuinely can't represent: full-page
  navigation, content-script re-injection, the MV3 service-worker lifecycle,
  `webNavigation`. Real browsers are slow, so keep this suite **small and rare** —
  anything expressible in `node:test`/jsdom belongs there instead, and pure logic
  should be factored OUT into a testable module (e.g. `nav-barrier.ts`) with a
  fast `*.test.mjs`. It's a **separate** suite: `npm test` never runs it (the fast
  suite globs `tests/*.test.*`; E2E is `tests/e2e/*.spec.mjs`). See the fuller
  writeup below.

## Branches, PRs and CI

Work goes on a **branch and through a PR**, not straight onto main: several sessions work this repo at
once (this one on the UI, another on the benchmark/pointers), and the PR is what runs CI — which is what
catches what one session broke for another. A green local `npm test` is not that check: it does not run
the e2e suite, three Node versions, or the real-CPython tests.

`.github/workflows/tests.yml` runs on `pull_request` (and on pushes to main), and **cancels superseded
runs per branch** so a fix supersedes the run it replaces instead of queueing behind it. Main is exempt, because
every commit there keeps its result — and that exemption needs the SHA in the concurrency group, not just
`cancel-in-progress: false`, which is the trap: that flag does not mean "never cancel". It means a new run QUEUES,
and GitHub keeps at most ONE queued run per group, so a third arrival cancels the one waiting. Merging four PRs
back to back left two main commits with a run cancelled before a single job started — CI going silent rather than
red, which is the failure the conflict guard below exists for, in another costume.

**A PR THAT CONFLICTS WITH ITS BASE HAS NO CHECKS AT ALL**, which is worse than red ones: a `pull_request` run is
built against the MERGE COMMIT, so while there is none there is no run, and every push to that branch looks untested
rather than failing. It happens to branches nobody touched — something lands on main and a PR becomes conflicting on
its own. The `conflicts` workflow (`scripts/pr-conflicts.mjs`) asks from both ends, failing a push to a branch whose
PR conflicts and commenting on each PR that a push to main just broke; `tests.yml` cannot hold it, because a workflow
cannot detect its own absence. If `gh run list` shows nothing for a commit you pushed, suspect this first.

**The `ci` skill (`.claude/skills/ci/SKILL.md`) is the playbook**: open the PR, watch it in the
BACKGROUND (`gh pr checks --watch`, ~6 minutes for a full run, the slowest of the three e2e shards being the long pole), read only the failing steps
(`gh run view <id> --log-failed`), fix forward on the branch, and — importantly — the list of
KNOWN-BAD failures that arrived from other branches, so a red check that is not yours is named in the PR
body rather than chased or silently re-run.

**A CANCELLED check prints as `fail`, so a red page is not evidence of a broken test.** `gh pr checks` has no
third word, and a run whose every job was cancelled still concludes `failure` — so resolve the JOB conclusions
(`gh api repos/<repo>/actions/runs/<id>/jobs`) before reading a log or blaming a change. Durations give it away
for free: a 3-minute `test` leg sitting at 22, or a row of jobs all ending at ~27, was starved of a runner
rather than slowed down. Poll a run by ID too — `gh run list` has returned a stale page and sent a watch loop
off onto runs from a fortnight earlier. Four red mains on 2026-10-05 were all of this and none were real.

**And the `background-work` skill (`.claude/skills/background-work/SKILL.md`) is how to run ANY slow
thing** — CI, an e2e suite (minutes, even parallel), a bench sweep — without stalling the session: start it with
`run_in_background: true` and go and do other work, because the harness re-invokes you when it exits.
The mistake it exists for is subtler than forgetting to background something: it is backgrounding it
and then blocking on its output file anyway (`until [ -s "$OUT" ]; do sleep 20; done`), which is a
foreground wait wearing a disguise and happened four times in one session. It also holds the
`dist/`-rebuild hazard — never build while an e2e suite is running, since the suite loads the bundle
you are replacing.
