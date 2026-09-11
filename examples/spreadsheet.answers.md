# `spreadsheet.html` — answer key

Kept OUT of the page on purpose. It used to live in HTML comments there, on the reasoning that a comment is
not DOM text so `findByText` could not reach it. Every other read can: `document.documentElement.outerHTML`
in a read-only `exec` is free, `fetch_url` with `format: "html"` returns the markup, and a model on a local
copy reading its own page gets the live DOM. The page is also what the `pointer-ids` bench loads, so the key
in a comment was one read away from every run that was supposed to COMPUTE it.

The example server only serves `.html`, and `ml.fetch` refuses `file://` URLs other than the page you are on,
so this file is not reachable from a run on the page. Do not link it from the page: an agent that reads its
own repository source (`autoApproveSelfSource`) could follow a named path to it.

## The small table (`#sales`)

| question | answer |
| --- | --- |
| Grand total of Q1–Q4 across all reps | 6260 |
| Column totals | Q1=1455, Q2=1590, Q3=1555, Q4=1660 |
| Top rep by annual total | Gia (850), runner-up Kim (810) |
| Region totals | East=2440, North=1760, South=1230, West=830 |
| Highest-grossing region | East (2440) |
| Average annual total per rep | ≈ 521.67 |

## Ridiculous mode (`#bigsales`)

JS-generated with seed 1337, and also `console.log`ged when the table is opened.

| question | answer |
| --- | --- |
| Grand total of all 12 months (dirty cells coerced to NaN, skipped) | 116153 |
| Region totals | West=24069, East=23508, South=23063, North=22994, Central=22519 |
| Top region by total | West (24069) |

The ID column has leading zeros (`00001`…). Casting drops them, so a task that needs the IDs should use
`tableRaw`.
