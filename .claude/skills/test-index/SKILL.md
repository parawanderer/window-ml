---
name: test-index
description: Find a test by what it is ABOUT, across every test file in the repo — "is this behaviour covered already?" and "where does a new test go?" — without reading a 9,000-line file. Use before adding a test, before claiming something is untested, and when a test fails in a file you have not opened.
---

# The test index

```bash
node scripts/test-index.mjs 'approval|consent'     # a REGEX over name + section + the file's header sentence
node scripts/test-index.mjs approve --word         # anchored, so it does not also match "approved"
node scripts/test-index.mjs '' --file sidebar      # one file's tests
node scripts/test-index.mjs --sections             # the groups, with how many tests each holds
node scripts/test-index.mjs --stats                # how many tests, by file, biggest first
```

One TAB-separated line per test: `PATH:LINE`, `SECTION`, `NAME`. Nothing is column-padded, so it pipes:
`| cut -f3`, `| awk -F'\t' '{print $2}' | sort -u`.

## When to reach for it

**Before writing a test.** The question is never "does a test named X exist" — grep answers that. It is "is this
behaviour covered", which grep cannot answer because you do not know what the existing test is called. Search the
CONCEPT; the section name in the output tells you where the new one belongs.

**Before saying something is untested.** 3,400 tests across 170 files. Saying "there is no test for this" after
grepping two files is a claim the index can check in one command.

**When a test fails in a file you have not opened.** `--file <name>` plus the section tells you what neighbourhood
you are in before you read a line.

## The rule it enforces

A test belongs under a SECTION — a comment line, `// --- what this group is about ---`. Everything after it belongs
to it until the next one.

```bash
node scripts/test-index.mjs --new main --staged   # THE RATCHET: pre-commit hook + CI's `tools` job
node scripts/test-index.mjs --unsectioned         # survey: every test under no section (ships red)
node scripts/test-index.mjs --headerless          # survey: test files with no header comment (ships red)
```

The ratchet only asks about tests a change ADDS, and only in a file that already has sections. A file nobody has
sorted out yet is left alone: demanding a section there would block an unrelated fix, which is how a check stops
being run. The two surveys ship red on purpose — 1,826 tests and 41 files predate this — and are for a deliberate
tidy-up, not for a gate.

## Gotchas

- **It parses, it does not grep.** A template-literal name is found; a name built from a variable is SKIPPED rather
  than guessed at, because printing the expression would be worse than printing nothing.
- **A rule of dashes with no words is a divider, not a section.** `// ------------` files nothing.
- **The ratchet cannot tell you a test is under the RIGHT section**, only that it is under one. A section runs until
  the next, so a test appended to the end of a file inherits the last one whatever it is about. Appending is the
  common case, so this is the common miss: put a new test with its group, not at the bottom. A mis-filed one shows
  up in this tool's output, where the section prints beside the name.
- **`describe`/`suite` count as declarations too**, so a file that groups with them indexes as well as one that uses
  comments.
- **The parser is `@ts-morph/common`'s TypeScript 6**, not the repo's `typescript` — 7.x is the Go port and exposes
  no JS API at all (`scripts/refactor/` has the same constraint).
- **Importing the module does not run the CLI.** `testsIn(file)` is exported for its own test; the command only runs
  when the file IS the command.

## Keeping this current

The tool is `scripts/test-index.mjs`, tested by `tests/test-index.test.mjs` against throwaway files in a temp dir.
Change its behaviour and this file, the AGENTS.md rule, the hook and the CI step change in the same commit.
