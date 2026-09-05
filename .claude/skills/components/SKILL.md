---
name: components
description: Find an existing sidebar component, hook or CSS class BEFORE building one. Run it whenever you are about to add a UI primitive — a chip, a pill, a drag handle, a disclosure, a tooltip, a panel.
---

# Is it already built?

```bash
node scripts/components.mjs | grep -i pill        # by CONCEPT, which is the point
node scripts/components.mjs | grep -i 'drag\|resize'
node scripts/components.mjs --undocumented        # what the index cannot see (exit 1 if any)
```

One grep-able line per thing: `NAME  kind  file:line  — first sentence of its docstring`.

## When to run it

**Before writing any UI primitive.** Not "when you suspect a duplicate" — you will not suspect it. The
failure this exists for is not "I searched and could not find it", it is **"I did not think to look."**

Three real misses from one session, each of which this would have caught in one grep:

| Built | Already existed | The grep that finds it |
| --- | --- | --- |
| A CSS copy of the pointer chip on a diff header | `PointerChip` / `.tok-chip` | `grep -i pill` |
| A fourth drag handle (an SVG, then a gradient) | `.vram-grip`, `.r-outgrip` | `grep -i 'drag\|resize'` |
| A second view-return signal for the bench | (would have been `viewReturn`) | `grep -i 'return\|back'` |

None of them would have been found by grepping the real name. Nobody greps `tok-chip` while about to write
a pill — you grep "pill". That is why the index is keyed on the docstring rather than on the identifier.

## How it works, and what you owe it

The **docstrings ARE the index** — nothing is duplicated into a manifest that would go stale. It scans:

- `src/sidebar/*.ts(x)` — every `export function|const`, capitalised as `component` and the rest as `helper`
  (a hook is a reusable thing too), with the JSDoc or `//` block directly above it.
- `src/sidebar/sidebar.css` — every class rule with a comment block above it. **The CSS half is not
  optional**: two of the three misses above were CSS, not JSX, so an index that only knew about components
  would have missed the clearest cases it exists for.

The cost of using docstrings as the index is that **an undocumented export is invisible**, so the next
person rebuilds it. `--undocumented` makes that loud and exits non-zero.

**Your obligations** (the self-tools rule in AGENTS.md):

1. A new shared component, hook or documented CSS class gets a docstring whose FIRST SENTENCE says what it
   is FOR, in words someone would search — not a war story, and not its own name restated. The first
   sentence is the whole index entry; if it reads badly in the listing, fix the docstring.
2. When you EXTRACT something (two copies became one), say so in the docstring, and say what it replaced.
   That sentence is what stops the third copy.
3. Keep this file and the AGENTS.md mention in sync with the script.

## Writing a docstring the index can use

The **first sentence is the whole entry**. Two failure modes, both of which read fine in the file and badly
in the listing — and the listing is what someone searches before rebuilding your thing:

- **Opening with a caveat instead of the subject.** `ClickableImg` began "No tooltip here on purpose: …",
  which indexes as a note about tooltips on a component about images. Say what it IS, then why it is that way.
- **Restating the name.** "A DISCLOSURE that slides" tells a searcher nothing they did not have from the
  identifier. Say what it is FOR, and — if it replaced copies — say that, because that sentence is what
  stops the third one.

A trailing `//` on a one-line export counts, which is the house style here and needs no churn:

```ts
export const codeWrap = signal(true);   // wrap long code lines vs. horizontal scroll
```

## Gotchas

- It indexes `src/sidebar/` only. Page-world modules (`src/tools.ts`, `src/dom.ts`) are a different
  vocabulary and are not UI primitives.
- A class with no comment is deliberately absent — listing every selector would bury the ones that mean
  something. If a rule deserves to be found, give it a sentence.
- A first sentence past ~150 chars is truncated with an ellipsis. That is a nudge, not a limit: a docstring
  whose first sentence runs that long is telling you it does not open with what the thing is.
- The output is padded for a human's eye. That is fine here and NOT a violation of the no-padding rule,
  which is about strings a MODEL reads.

## It is enforced

Both halves run in the pre-commit hook and in CI's `tools` job, so this is not advice:

```bash
node scripts/components.mjs --undocumented        # every exported sidebar thing needs a docstring
node scripts/components.mjs --new-css [base-ref]  # every CSS class you ADD under a new family needs a comment
```

**CSS is a ratchet, not a rule.** 323 of the stylesheet's 557 classes have no comment. Demanding all of them
would ship a red check, and a red check is one people learn to scroll past — so `--new-css` diffs against the
merge base and asks only about what your change adds. A member of a documented block passes on its ancestor
(`.r-diff-head` inherits `.r-diff`); what it catches is a NEW FAMILY under a name nobody would grep, which is
exactly how the duplicate pointer chip got in.

If the base ref is missing (a shallow clone, a fork), it SKIPS rather than failing — a check that blocks a
commit because it could not find a baseline teaches people to pass `--no-verify`, after which it enforces
nothing at all.
