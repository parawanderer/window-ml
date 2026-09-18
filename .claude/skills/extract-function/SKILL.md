---
name: extract-function
description: Lift a range of statements inside one file into its own named function, with the compiler working out the closure. Use when splitting a long function or a large component, where move-symbols cannot help because nothing is crossing a file boundary.
---

# Extracting a function out of a body

```bash
node scripts/extract-function.mjs --file src/sidebar/vram.tsx --lines 1839-1842 --name latestSampleOf --dry-run --diff
node scripts/extract-function.mjs --file src/sidebar/vram.tsx --lines 1839-1842 --name latestSampleOf
```

`--lines` is 1-based and inclusive, the numbers the editor shows. Exit 0 = extracted or a clean dry run,
1 = refused (nothing written), 2 = bad arguments.

## When to reach for it

`move-symbols` moves whole top-level declarations BETWEEN files. It cannot touch what is inside one, which
leaves the operation a large component file actually needs — cutting a body into pieces — as hand editing.

So: a 300-line component, a function that does four things, a `useEffect` worth naming. Extract first, then
`move-symbols` the result to another file if it belongs there. That order works because the extracted function
is a top-level declaration, which is exactly what move-symbols takes.

## What it does

1. **TypeScript's own `Extract Symbol` refactor** does the closure analysis: which locals the range reads become
   parameters, what it assigns comes back, generics and `this` are carried. Same language service `move-symbols`
   drives, so the two cannot disagree about scope.
2. **Module scope by default.** The refactor offers several targets (`function_scope_0` is the innermost
   enclosing function, the last is module scope). Splitting a big file wants module scope; `--scope inner` keeps
   it nested.
3. **Renames it.** The refactor always emits `newFunction`; this renames it through the compiler, so the
   declaration and every reference move together.
4. **Refuses on a new type error**, printing it and writing nothing.

## What blocks

**"TypeScript will not extract lines N-M"** means the range is not whole statements or one expression. Usual
causes: it starts or ends mid-statement (check the line numbers), or control flow leaves it — a `return`,
`break` or `continue` that jumps out carries meaning the extraction cannot preserve.

Widen or narrow the range to statement boundaries and try again. `--dry-run --diff` costs nothing.

## Gotchas

- **The name is yours to get right.** The tool guarantees the code is equivalent, not that `handleThing` says
  anything. Read the extracted function afterwards and rename it if it does not.
- **`--diff` is a rough region diff**, first mismatch to last, not a minimal one. It shows more context than
  changed; it is for eyeballing a dry run, not for review.
- **It does not move anything between files.** That is `move-symbols`, and it is usually the next step.
- **Extracting from a component is not free of behaviour**: a function lifted out of a render body no longer
  closes over the render's variables, which is the point, but if the range read a signal or a hook value that
  now arrives as a parameter, re-render behaviour can change. Run the genre covering the file.
- `--root <dir>` points it at another project; it exists for the tests.

## Keeping this current

`scripts/extract-function.mjs`, tested by `tests/extract-function.test.mjs` against fixture projects. The
refactor engine underneath is `scripts/refactor/project.mjs`. Change the behaviour, and this file and the
AGENTS.md mention change in the same commit.
