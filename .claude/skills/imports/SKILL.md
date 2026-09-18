---
name: imports
description: Ask what a file imports, who imports it, and exactly which names cross between two files — resolved through the compiler, so type-only edges are told apart from value ones. Use before splitting a file, when move-symbols refuses on a cycle, or when deciding whether a change is safe.
---

# Reading the import graph

```bash
node scripts/imports.mjs src/sidebar/vram.tsx                 # out-edges and in-edges, with names
node scripts/imports.mjs src/a.ts src/b.ts                    # the coupling between two files, both ways
node scripts/imports.mjs --cycles                             # every import cycle in the project
```

Output is TAB-separated (`out|in  kind  file  names`), so it pipes into `grep` and `cut -f3`.

## When to reach for it

**Before planning a split.** What blocks a refactor is a file's EDGES, not its size. Ask the two-file question
first and you find out in two seconds what `move-symbols --dry-run` tells you after you have guessed a symbol
list.

**When `move-symbols` refuses with `cycle`.** It names the loop; this says which names form it and which
direction to cut.

**Before changing an exported signature.** The in-edges list every caller with the names each one takes.

## What it knows that grep does not

- **It resolves specifiers.** `./vram` from `sidebar/` and `../sidebar/vram` from elsewhere are the same module.
- **It sees `import("./contract").X`**, the inline type query. That is a string; no grep pattern for an import
  statement matches it, and this repo has roughly a hundred.
- **It tells a TYPE import from a VALUE one.** This is the one that matters. A type-only import compiles to
  nothing, so it cannot form a runtime cycle: `resource-bands.ts` imports `resource-model.ts` and is imported
  back by `resource-chart.tsx`, and that is fine because the first edge is `type`.

The engine is `scripts/refactor/graph.mjs`, the same one `move-symbols` uses to refuse a move, so the two
cannot disagree about what a cycle is.

## Reading the two-file mode

`MUTUAL, both value imports` means the pair is effectively one module in two files, and the rule that follows
is the useful part: a cluster that the other file imports AND that itself imports the other cannot be moved
out. Give the shared names a third module first, then split.

If only one direction is `static`, there is no runtime cycle and a split may still be possible.

## Gotchas

- **It loads the whole TypeScript program**, so it takes ~2s, unlike `scripts/index.mjs` which is ~70ms. Fine
  for a question you ask a few times while planning; do not put it in a loop.
- **In-edges are the slow half** (they need the project graph). The one-file mode pays for it; the two-file
  mode does not.
- **It reads what is on disk**, not the index, so ask it after saving.
- Tests that load a module with `await import()` show as `dynamic`. That edge is real for the test but cannot
  form an evaluation cycle, and `move-symbols` will still ask you to fix such a test by hand.

## Keeping this current

The CLI is `scripts/imports.mjs`; the resolution and edge-kind logic it calls is `scripts/refactor/graph.mjs`
(`edgesOf`, `projectGraph`, `cycles`). Change either and update this file and the AGENTS.md mention in the same
commit.
