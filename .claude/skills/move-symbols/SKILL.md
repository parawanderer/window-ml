---
name: move-symbols
description: Move top-level functions, types or constants from one TypeScript file to another with every import, re-export and test `await import()` updated by the compiler. Use for ANY extraction or split of a module — instead of copying code into a new file by hand and chasing the type errors.
---

# Moving code between files

```bash
# Plan it. Writes nothing; --diff shows exactly what would change.
node scripts/move-symbols.mjs --from src/sidebar/render-panel.tsx \
    --symbols findMatches,rangesFor,scrollerX --to src/sidebar/output-find.ts --dry-run --diff

# Do it. Same command without --dry-run.
node scripts/move-symbols.mjs --from src/sidebar/render-panel.tsx \
    --symbols findMatches,rangesFor,scrollerX --to src/sidebar/output-find.ts
```

`--to` may be a new file (created) or an existing one (the code is appended). Exit 0 = moved or a clean dry
run, 1 = blocked (nothing written), 2 = bad arguments.

## When to reach for it

Every time code moves between modules: splitting a file `check-file-size.mjs` flagged, extracting a helper
into its own module, gathering scattered pieces of one feature. The old way (read the region, write it back
out in a new file, then fix imports by type errors) retypes hundreds of lines, can quietly change one of them,
finds dependencies by eye, and never sees the tests that load a module by `await import("../src/x.ts")`.

## What it does

1. **Resolves each name to its declaration** through the checker. Overloads and merged declarations move
   together. A statement declaring several names (`const a = 1, b = 2`) must have all of them listed.
2. **Pulls along helpers only the moved code uses** (`pull` lines in the plan). Anything else the moved code
   needs **stays** and gets imported from the old file; the plan lists each one and who uses it. `--no-pull`
   turns the pulling off.
3. **Runs TypeScript's own "Move to file" refactor** for the static imports, in the source, the target and
   every importer.
4. **Puts the moved code back byte for byte.** The refactor reprints what it moves (re-spacing trailing
   comments, for one). The only change the tool keeps is an added `export`, and the plan shows
   `verbatim ✓` when the result reads back identical.
5. **Rewrites what the refactor misses**: `const { a } = await import("…")` (split when only some members
   moved), `({ a } = await import("…"))` in a `before` hook, `(await import("…")).a`, `const M = await
   import("…"); M.a`, `.catch(() => null)` imports, destructured `require`, and re-exports
   (`export { a } from`, `export type { … } from`, `export * from`).
6. **Checks, in memory, before writing anything**:
   - `typecheck`: no new diagnostics in the source, the target and every file importing either.
   - `cycles`: no new import cycle, counting only imports that survive compilation (a type-only use of a
     class does not count, since esbuild drops that import).
   - `bundle`: what each `build.mjs` entry gains. This one is reported, never blocking. It matters when
     code moves into a file that pulls a heavy dependency into the page bundle.
   - `text-ref`: a script or test naming the source file as a STRING (`readFileSync("src/…")`,
     `join(ROOT, "src", "contract.ts")`), which no compiler follows.
7. **After writing, runs the repo's own `tsc --noEmit` over the whole project**, before and after, and reports
   only NEW errors (`--no-typecheck` skips this). It prints the exact undo command.

## What blocks, and what to do about it

| Block | Meaning | Usually |
| --- | --- | --- |
| `input` | a name is not a movable top-level declaration here (imported, default export, missing, or shares a statement with an unlisted name) | fix the list; the message says which file actually declares an imported name |
| `conflict` | the target already binds that name | rename first, or pick another target |
| `mutable` | a `let`/`var` would be assigned across the new module boundary (imported bindings are read-only) | move the state together with every function that assigns it |
| `cycle` | the target would import something that stays, from a file that imports the target | add the `stays` names to `--symbols`, or move them to a third module first |
| `typecheck` | the in-memory check found a new error | read it; `--diff` shows the edit that caused it |
| `dynamic-import` | a test loads the module in a shape the tool will not guess at (a namespace used for moved AND staying members, a rest element, `.then(m => m.x)`) | fix that line by hand, then `--allow dynamic-import` |
| `text-ref` | something reads the source file as text | look at it: a generator (gen-api-docs reads `contract.ts`) will silently produce less; a test grepping the file will pass vacuously |
| `dirty` | a file the move touches has uncommitted edits | commit or stash, so the undo is a checkout |

`--allow cycle,text-ref,…` proceeds despite the named checks. `input`, `conflict`, `mutable` and a refactor
failure cannot be overridden.

## Gotchas

- **It is a dry run until you drop `--dry-run`**, and a blocked run writes nothing either way.
- **The new file has no header comment.** Write one saying what the module is for; that is the one part of
  a move that is not mechanical.
- **Comments are attached by adjacency.** JSDoc and comment lines directly above a declaration move with it;
  a comment separated by a blank line (a section banner, a file header) stays. A stale comment that sat above
  the wrong function moves with that function, exactly as it was.
- **The in-memory check runs TypeScript 6** (bundled by `@ts-morph/common`, because 7.x is the Go port and has
  no JS API or move refactor yet) over the files around the move. The whole-project `tsc` after writing is
  the repo's own 7.x, and it has the last word.
- **A moved `const x = compute()` runs earlier than before**: when the target is first imported, not when the
  rest of the source runs. The plan prints a `note` for any moved initializer that calls something.
- **Tests are not moved.** If a test file covers only what moved, split or rename it yourself; the imports
  inside it are already right.
- Symbols are moved as a whole. Moving part of a function, or a method out of a class, is a different refactor.

## Keeping this current

The engine is `scripts/refactor/` (`project.mjs` language service over in-memory edits, `declarations.mjs`
analysis, `graph.mjs` cycles and bundles, `missed-imports.mjs` dynamic imports and re-exports,
`text-refs.mjs`, `move.mjs` the steps), tested by `tests/move-symbols.test.mjs` against fixture projects.
Change the behaviour, and this file and the AGENTS.md mention change in the same commit.
