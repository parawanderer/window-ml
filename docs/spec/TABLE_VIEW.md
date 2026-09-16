# The table view: two modes, and column statistics

**Status: draft, not started.** Written 2026-09-16, after `fetch_url` began returning parsed tables
(`docs/dev/wire-and-fetch.md`). Nothing here is built. It formalises a set of related ideas so they can be
argued with as one design rather than added one affordance at a time.

## The problem

There is now exactly one table grid in the sidebar (`PyDfTable`), and it draws every table the same way: a
scrolling list of rows, capped at 200, whatever the table is. That is the right rendering for a 12-row DOM
table and the wrong one for a 50,000-row CSV, where the 200 rows on screen are an arbitrary prefix and the
reader has no way to see what the other 49,800 look like.

The model is better served than the human here, which is the tell. It gets `shape`, `dtypes` and a `df.head()`
— a description of the whole table. The person looking at the same step gets rows and a "… 49,800 more rows"
footer, and cannot answer "is this column numeric", "how many are null", "what values does `region` take"
without exporting the run and opening it somewhere else.

## Two modes

The view has two, and the argument of this document is that **which one is the default is a property of the
table, not a preference**.

**ROWS** — what exists today. The right default when the table is small enough that the rows ARE the overview:
you can see all of them, so any summary is a worse version of what is already on screen.

**SUMMARY** — one row per COLUMN instead of one per record: its name, dtype, how many values are null, how many
are distinct, and a shape-appropriate summary of the values (below). The right default above a threshold,
because at that size the rows on screen are a sample nobody chose and the columns are the only honest
description of the whole.

The toggle flips either way — a small table can still be summarised, a large one still scrolled. It is a
DEFAULT, not a restriction.

### The threshold

Keys off `rowCount` — the SOURCE's row count, which `TableLike` carries precisely so a prefix can say what it
is a prefix of. Not `rows.length`: every fetched CSV ships at most `RENDER_TABLE_ROWS` (200) rows to the panel,
so a threshold read off the drawn rows would never be crossed by the tables this is for.

A first guess is **200** — i.e. "the panel is not showing you all of it" — which has the virtue of being the
same fact the footer already reports, rather than a second, differently-motivated number. Worth revisiting once
it is in front of real runs.

### Honesty about the sample

A summary computed over a 200-row prefix of a 50,000-row table is a summary of the prefix, and must say so
rather than presenting prefix statistics as the table's. Two ways out, in preference order:

1. **Compute over the FULL table where one is reachable.** A fetched table's rows are in the page's fetch
   cache; the panel holds only the preview. This is the same "a pointer addresses a preview, not a value"
   problem as `docs/spec/POINTER_VALUES.md`, and it should be solved once, there, rather than twice.
2. **Say the sample size**, plainly, in the summary header: "over the first 200 of 50,000 rows". Never silently.

The failure being designed out is the one this codebase keeps meeting: a plausible number computed over a
sample the reader believed was the whole, which reads exactly like a real answer.

## Per-column statistics ("Data Wrangler lite")

Per column, and deliberately a short list — this is a reading aid in a log, not a profiling tool:

| Column kind | Shown |
| --- | --- |
| all | name, dtype, null count, distinct count |
| `int64` / `float64` | min, max, mean, and a coarse histogram |
| `object` | the top few values with their counts, and how much of the column they cover |
| `bool` | the true/false split |

Two notes on presentation. The histogram/top-values bar is a SPARKLINE in the row, not a chart — a chart per
column in a step body is a page of chrome for a glance's worth of information. And the numbers are
right-aligned with `font-variant-numeric: tabular-nums`, like the existing numeric cells.

## The header tooltip

Independent of the mode, and the cheapest half of the whole idea: hovering a column header should say what the
column IS before offering to sort it. Today the tip is only `"Click to sort by this column."`, which is the
least interesting thing about a column.

The shape follows the resource panel's tooltips — the reading first, the affordance after a divider:

```
revenue · float64
50,000 values · 0 null · 1,248 distinct
min 9.99 · max 178,494.50 · mean 1,112.40
———
Click to sort by this column.
```

For an `object` column the third line is the top values instead. `cursorTipOn` already takes a node, so this is
authored JSX, not a string — and it must stay a node, because column names and cell values come from OUTSIDE
(a fetched CSV's header is attacker-controlled in exactly the way a tool result is), and the string overload
renders markdown.

Keep it to the lines above: a tooltip that has to be read carefully is one the reader dismisses.

## Provenance, for a fetched table

A fetched CSV's rendered view should carry the two facts the model is told and the reader is not:

- **How it was parsed** — the discovered delimiter, named rather than shown (`semicolon-separated`, not `;`),
  because the whole point is that we GUESSED it and a wrong guess is visible as mangled columns. For Parquet,
  that it is Parquet, which makes the dtypes trustworthy rather than inferred.
- **The real shape** — `50,000 rows × 4 columns`, not only the "… 49,800 more rows" footer, which reports a
  remainder and makes the reader do the arithmetic to recover the total.

This sits in the grid's bar, beside `hide table` / `copy CSV`, and only when the descriptor carries the facts —
a DOM table has no delimiter and should not grow an empty field.

## Tables with no header row

`tableFromDelimited` currently treats row 0 as the header, always. For a headerless export that silently eats a
data row AND invents column names out of its values — the kind of wrong that looks right, since the table
renders perfectly and is simply missing a record with nonsense labels.

pandas has the answer and it is the one to copy: `header=None` gives positional column names (`0`, `1`, `2`).
Detection is a sniff, so it follows the house rule for sniffs (say what it decided, let it be overridden):

- **The heuristic**: compare row 0 against the rest, per column. A header row is all strings where the body has
  numbers or booleans; a first data row looks like the rows beneath it. If row 0 is type-indistinguishable from
  the body, there is no header. (This is `csv.Sniffer.has_header`'s argument, and it is only a heuristic —
  a table of all-string columns cannot be decided this way and should default to HAVING a header, since that is
  overwhelmingly what is served.)
- **It must be overridable**, because it will be wrong sometimes: `header: true | false | "auto"` on the parse,
  surfaced as an option on `fetch_url` and as a control in the view.
- **It must be visible**: the provenance line above says `no header row — columns are positional`, so a reader
  who sees `0 1 2` knows it was decided rather than lost.

## What "copy CSV" copies

Today it serialises the rows the component was handed, which for a fetched table is the 200-row preview and
for a returned DataFrame is whatever the sandbox capped it to. So the button quietly produces a file that
claims to be the table and is a prefix of it — a artifact that looks exactly like the real thing, which is the
worst version of this failure because it leaves the panel and is used somewhere else.

The rule: **copy exactly what it has, and say what that is whenever it is not everything.** Concretely, when
`rowCount` exceeds the rows in hand the control reads `copy 200 rows` rather than `copy CSV`, and its tip says
"the first 200 of 50,000 — the panel only holds a preview" plus where the whole table is (`python_exec`, by
URL or pointer). A complete table keeps the plain label, because there nothing is being withheld.

Offering to copy the WHOLE table is the better answer and needs the backing store resolved
(`docs/spec/POINTER_VALUES.md`) — once a view can reach the full value, this becomes `copy all 50,000 rows`
and the caveat disappears. Until then, an honest label beats a silent prefix.

## Find, and height

Two smaller things that belong to the same component:

- **Find (Ctrl+F)** — the overlay already exists (`.r-find`, render-panel.tsx, built for text output cells).
  Click the table to focus it, Ctrl+F, matching cells highlight, Esc or ✕ closes. The work is matching CELLS
  rather than text offsets, and scrolling a match below the 320px fold into view. In SUMMARY mode it should
  search column names and top values, not rows.
- **Drag to expand** — `.r-df-scroll` is capped at 320px with no way past it; `.r-outcell` already has the grip
  pattern ("capped height → scrolls, with a drag grip") to copy.

## Open questions

- Does SUMMARY belong in the EXPORTS as well? `run.json` carries the capped rows today. A summary of the full
  table is smaller than the rows and more useful to a differ — but it is derived data in a file that has so far
  held inputs, and computing it at export time over a table that is no longer reachable may be impossible.
- Should the model ever see the summary? It gets `dtypes` already. Null/distinct counts would help it decide
  whether a column is usable — but it costs context on every fetch, and it can compute them in `python_exec`
  for nothing. Probably not by default; possibly as a `summary: true` on `fetch_url`.
- Where does this stop being a log view and start being a data tool? The answer that keeps it honest: it is a
  view of something a step produced, so anything that would CHANGE the data (filter, derive a column, drop
  nulls) belongs in `python_exec`, not here. Sorting is already at that boundary and is fine because it does
  not survive the view.
