---
name: code-index
description: Find what already exists BEFORE building it — a module, an exported symbol, a sidebar component, a hook, a CSS class. Run it whenever you are about to add a file, a helper, or a UI primitive (a chip, a pill, a drag handle, a disclosure, a tooltip, a panel).
---

# Is it already built?

```bash
node scripts/index.mjs 'pill|chip|badge'          # a REGEX over name, summary and path (case-insensitive)
node scripts/index.mjs table --kind file          # which MODULES are about tables
node scripts/index.mjs 'drag|resize|grip'         # the search that would have stopped the fourth drag grip
node scripts/index.mjs fetch --sig                # …with signatures
node scripts/index.mjs --exported --kind function # the module surface, not the private helpers
```

One TAB-separated line per thing: `KIND · NAME · path:line · [signature] · first sentence of its docstring`.

## When to run it

**Before writing any new module, shared helper or UI primitive.** Not "when you suspect a duplicate" — you
will not suspect it. The failure this exists for is not "I searched and could not find it", it is **"I did
not think to look."** One session produced a CSS copy of the pointer chip, a FOURTH drag handle and a second
view-return signal, each one grep away. The same thing happens to whole modules, where the cost is a
rebuilt subsystem rather than a rebuilt pill.

Search by **concept**, never by name: nobody greps `tok-chip` while about to write a pill, or `sw-values.ts`
while about to write a value store. That is why every row carries a sentence, and why the regex runs over
the sentence as well as the name.

## It chains

The output is tab-separated and never column-padded, so it pipes:

```bash
node scripts/index.mjs '' --kind file | cut -f3          # every module path
node scripts/index.mjs stream | awk -F'\t' '$1=="function"'
node scripts/index.mjs '' --kind css | wc -l
node scripts/index.mjs '' --local | cut -f2 | sort | uniq -d   # helper names used in several files
```

## Filters

| Flag | Effect |
| --- | --- |
| `--kind a,b` | `file`, `component`, `hook`, `function`, `class`, `type`, `enum`, `const`, `css` |
| `--word` | anchor the whole pattern, so `table` stops matching "persi**stable**" |
| `--exported` / `--local` | module surface vs. a file's private declarations |
| `--sig` | include the signature column (and search it) |
| `--stats` | how big the index is, by kind, and how many files were rescanned |
| `--rebuild` | ignore the cache |

## What it indexes, and what it deliberately does not

**Module-scope declarations only — bindings, never their innards.** JavaScript lets you nest objects
forever and indexing that depth would bury the rows that mean something. A function shows its parameters
and return type; a class shows its method names; an interface shows its head, not its members.

Exactly one exception, one level deep and never recursive: a module-scope **object literal lists its own
top-level keys** (`API_FORMATS … keys: openai, ollama`), because that pattern IS the API surface in several
files here. `const x = { a: { b: { … } } }` stops at `a`.

A declaration indented inside something else is not seen. That is the scope of the tool, not a gap in it.

## The checks (pre-commit + CI's `tools` job)

```bash
node scripts/index.mjs --new [ref] [--staged]   # THE RATCHET: what this change ADDS with nothing to search on
node scripts/index.mjs --headerless             # source files with no header comment
node scripts/index.mjs --undocumented           # every undocumented export repo-wide (a survey — ships red)
```

**`--new` without `--staged` cannot see staged work**, because it diffs COMMITS — so it warns on stderr
naming how many uncommitted files under `src/` fall outside the range it checked. A falsely clean answer is
the worst thing a check can produce, and this one is reachable by forgetting a flag (it happened twice in ten
minutes while the tool was being written).

**`--new` is a ratchet, not a rule**, and that is deliberate: 178 exports and 300+ CSS classes have no
docstring today, and a check that ships red is one people learn to scroll past. It reads the diff against
the merge base and asks only about what you are ADDING. `--staged` compares the base to the INDEX, which is
the only thing a pre-commit hook may ask about — `base...HEAD` diffs COMMITS, so a hook using it passes
cleanly with an undocumented symbol staged, checking the state before the change it was called to check.

A CSS class passes on a **documented ancestor** (`.r-diff-head` inherits `.r-diff`): the failure being
caught is a new FAMILY under a name nobody would grep, not a paragraph per modifier.

**`--headerless` is a hard gate**, because every source file already has a header — so it ships green and
can stay a rule. Keep it that way: a new file opens with a comment saying what the module is for.

## What you owe it

- A new shared thing gets a **first sentence saying what it is FOR**, in words someone would search. That
  sentence is what stops the third copy.
- An **extraction says what it replaced**, for the same reason.
- A new **file** opens with `// <name>.ts — <what this module is for>.`
- A **trailing `//` counts** as the docstring for a one-line export — the house style here. A block above
  still wins when both exist.

## Gotchas

- **The cache is `.index-cache.tsv` at the repo root, gitignored.** `mtime`+`size` is the cheap pre-filter
  and the content HASH is what decides, because a branch switch rewrites mtimes wholesale and a cache that
  trusted them would rebuild everything — or, worse, treat a restored older file as fresh. Delete the file
  or pass `--rebuild` if you ever doubt it; a cold build is ~100ms, warm ~30ms.
- **A regex matches substrings**, so `table` also hits "persistable". `--word` anchors the whole pattern
  (alternation still works: `--word 'table|frame'`).
- **`--undocumented` takes the query and `--kind` too.** Repo-wide it is 178 rows, which is a survey nobody
  acts on; `node scripts/index.mjs sw-values --undocumented` is a job you can finish. CI runs it unfiltered.
- **A file HEADER is never a declaration's docstring**, even with no blank line between them. Letting the
  first symbol inherit it made it look documented while saying nothing about itself.
- **CSS is one row per class**, from its documented declaration — not one per `:hover`/media override.
- It **replaced `scripts/components.mjs`**, which covered only the sidebar's components and CSS. Anything
  still calling that name is stale.

## Keeping this current

The tool is `scripts/index.mjs`, tested by `tests/code-index.test.mjs` against fixture sources. Change its
behaviour and this file plus the AGENTS.md mention change in the same commit.
