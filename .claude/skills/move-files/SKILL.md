---
name: move-files
description: Move whole source files into another directory (a new `src/sw/` folder, say) with every path that names them rewritten — imports, tests' `await import()`, build.mjs entry points, docs. Use for ANY file relocation, instead of `git mv` and chasing the broken imports.
---

# Moving files

```bash
# Plan it. Writes nothing; --diff shows every rewritten file.
node scripts/move-files.mjs --to src/sw src/sw-*.ts --dry-run --diff

# Do it (needs a clean working tree, so a checkout undoes it).
node scripts/move-files.mjs --to src/sw src/sw-*.ts
```

Every file keeps its NAME; only its directory changes. Exit 0 = moved or a clean dry run, 1 = blocked, 2 = bad
arguments.

## When to reach for it

Relocating whole files: grouping a prefix family into a folder, moving a file next to the code it belongs to. To
move DECLARATIONS between files (a split), use `move-symbols` instead; to cut up a body, `extract-function`.

## What it does

A file move changes no code, only paths, so this is path arithmetic over every tracked file, not a refactor:

1. **Every string literal that resolves to a moved file is rewritten** to its new place, in the style it was
   written: `./zz-llm` → `./zz/zz-llm`, `../src/zz-llm.ts` → `../src/zz/zz-llm.ts`, `import("./zz-llm").T` too.
   That covers what TypeScript's own rename never sees: tests loading a module by `await import()`, a script's
   `readFileSync("src/x.ts")`, build.mjs's entry points, `<script src>`.
2. **A moved file's own relative paths are rewritten for its new directory** (`./dom` → `../dom`); one pointing at
   a file moving with it stays as it was.
3. **A doc follows too.** Its exact old path is rewritten (`src/<name>.ts` → `src/<dir>/<name>.ts`), everywhere
   including code fences, since a fenced command names a real file. Its relative Markdown LINKS are retargeted
   (`[x](../../src/<name>.ts#L3)` keeps its anchor), and a doc that itself moves has every relative link rebased.
   A bare name (`<name>.ts`) stays true and is left alone. `scripts/check-doc-links.mjs` is the check that catches
   a link broken any other way.
4. **REPORTS what it cannot rewrite, and what it rewrote on a guess.** A path assembled from pieces (`join(ROOT,
   "src", f)` over a list of basenames) is `pieces`: fix it by hand. A ROOT-relative string equal to a moved path
   (`"src/x.ts"`) is rewritten and listed as `rooted`, because it is usually a path (build.mjs, a `readFileSync`)
   but can be DATA (a sample path in a test): read each one.

   Examples in docs and fixtures that describe moves should use a placeholder (`<name>`) or a name no real file has (`zz-*`), or a real move
   rewrites them too. That is how this skill's own examples got rewritten the first time it ran.
5. **Blocks on a dangling path**: a relative specifier that resolves after the move to nothing, where it resolved
   before. Then `git mv`s the files, writes the rewrites, and runs `tsc --noEmit` before and after, failing on any
   NEW error (`--no-typecheck` skips that). Undo is `git reset --hard HEAD`.

## Gotchas

- **A stale `dist/` after a move looks like a broken main**: rebuild (`npm run build:all`) before running the
  tests, which load the bundle.
- **A pure move rebases well; a move plus edits does not.** git follows a rename, so someone else's edit to the
  file lands at its new path. Keep a move PR free of content changes.
- **It does not know about genres or globs**: `scripts/test.mjs`'s genre table and `check-file-size.mjs`'s skip
  list match test names and paths by pattern. Grep them for the old directory after a big move.
- **`src/contract.ts` must stay where it is**: about a hundred inline `import("./contract").X` queries name it,
  and the doc generators read it by path. Moving the `contract-*` modules is fine; the barrel stays.
