# Tool output and code blocks

Implementation notes for streamed tool output, the shared output cell, per-line timestamps, line maps, tracebacks, code-block affordances and retry diffs, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**Live tool-output streaming (`ctx.stream`) + the shared output cell.** Any tool's `run(args, ctx)` may call
**`ctx.stream(text)`** to stream partial output AS IT WORKS (Jupyter-style) — a GENERIC capability, gated by the
same **`stream`** agent flag as the streamed thinking (`ctx.stream` is simply ABSENT when off, so a tool checks
`if (ctx.stream)` and otherwise returns its full result at the end, unchanged). The loop builds a throttled +
capped fan per tool call (90ms, `UI_OUT_CAP`) and threads it through `runTool` → `executeTool`; each push emits
an `agent-step` DELTA carrying only `{ step, seq, streamOutput }` (no `tool`), which the reducer patches
**additively** onto the pending row — the DONE (with the real result) supersedes it. Shipped consumers: `exec`
(its console patch also calls `ctx.stream` per line) and `python_exec` (the offscreen WORKER's stdout tees to a
JS callback — `_ml_stdout_cb`, set only when streaming — and rides worker → offscreen → SW → page → the tool's
ctx.stream). Works on BOTH paths: the page loop, and the BACKGROUND-hosted (design A) path via a reverse channel
(`RUN_TOOL_IN_PAGE {stream}` → the page posts `PAGE_TOOL_STREAM {runId, chunk}` → SW → the in-flight call's sink,
keyed by runId since the loop delegates tools sequentially). **CDP exec on strict-CSP pages streams too**, by a
different mechanism: `Runtime.evaluate` returns ONCE, and `Runtime.consoleAPICalled` can't help because our wrapper
REPLACES `console.*` with a collector that never calls through, so no console event is ever raised. So `cdpEval`
installs a **`Runtime.addBinding`** (the purpose-built page → debugger-client channel) and the patched console tees
each line through it, raising `Runtime.bindingCalled` on our client mid-eval — no RemoteObject serialization (the
page already stringifies) and no console pollution. The PAGE stamps `ts`; it is the executor. It degrades safely: a
binding that won't install compiles no tee into the wrapper and the full output still lands at DONE. A successful
CDP exec also REBUILDS its Out descriptor from the run's own console/value — forwarding the page's CSP-blocked
render would show that error beside a successful result and wipe the output you just watched stream in.

*Streaming vs truncation.* The model's result is clipped to its context budget, but the UI keeps far more
(`UI_OUT_CAP`) — otherwise output you watched stream in would visibly SHRINK when the step landed. So the render
descriptors carry **`seen`**: how many characters the model actually received. Everything past it renders MARKED
("captured, but NOT sent to the model" — dimmed, dashed rail), so the fuller human view is never mistaken for
what the model read (the raw view still shows the model-facing text verbatim).

*The output cell.* `python_exec` and `exec` render their Out through ONE shared **`OutputCell`**
(src/sidebar/render-panel.tsx) — a future code-ish tool (a `bash_exec`, say) wraps its own sections in it and
inherits everything: a height cap (Settings → Appearance, per-cell drag-to-resize), scrolling, **tail-follow**
(new output scrolls into view only while you're parked at the bottom; scroll up and it holds), and an in-cell
**Ctrl+F find** (substring only — no regex — with a case toggle, match count, ↑/↓ navigation, painted via the
CSS Custom Highlight API so the syntax highlighting underneath is untouched). `exec`'s Out is a rendered cell
too (console / value / error sections), matching python's instead of a raw blob.

*Per-line timestamps (the EXECUTOR stamps them).* Streamed output carries a **produced-at gutter** — when each
line actually happened, not when the UI saw it. `ctx.stream(text, ts?)` lets the producer stamp the instant:
python stamps in the Pyodide **worker** (the chunk then crosses worker → offscreen → SW → page, so anything
downstream would be skewed), and a remote tool (a `bash_exec` on a server) would stamp on its own host. A
producer in the local realm omits `ts` and the loop's fan stamps it. The loop records `[offsetInTheAccumulated
text, epochMs]` on `streamMarks`; the UI only decides whether to SHOW them (Settings → Appearance, default on)
and NEVER invents one — an offset no mark covers renders blank, and `alignedMarks` drops the whole set if it
doesn't index into the text being rendered. The gutter is `user-select: none`, so copying the output copies
only the output; a repeated stamp is blanked so a burst reads as one moment; hovering any row gives the exact
instant to the **millisecond** plus the gap since the previous line. The **hour is elided** (mm:ss) only while
every mark is in the hour we're in *right now* — and since that is answered at render time, a `hourNow` signal
bumped by ONE self-terminating timeout (armed at the next boundary, `unref`'d, re-armed only from a render)
widens every gutter to hh:mm:ss together when the clock rolls over. Time-only, no date: a run spanning
midnight gets a **day divider** at the change (`dayBreaks` — a dashed rule + the ISO date, in the gutter and both
exports), since a time-only gutter would otherwise put `00:00:01` directly under `23:59:58` and read as one second
later. The mapping is pure and shared — **`src/sidebar/timestamps.ts`**
(`timeForOffset`/`alignedMarks`/`elideHour`/`timedText`), imported by the sidebar gutter AND by both export
sinks, so they can't drift; `render-panel.tsx` re-exports it. The **exports** carry the times as a collapsed
`Out · timed` block BESIDE the verbatim Out rather than prefixed onto it (a `<pre>` inside `<details open>`, so
the PDF prints it expanded and monospaced, alignment intact). There EVERY line carries its own stamp — the
sidebar blanks a repeat to keep a burst reading as one moment, but a text file has the opposite ergonomics: a
blank means "look upwards" and can't be hovered, so each line is self-contained and greppable. Only an offset no
mark covers stays blank — the sidebar's gutter is
unselectable and markdown has no equivalent, so baking times into the output would make an exported log
un-pasteable (and the raw-view rule already demands the model-facing text stay verbatim).


**A python traceback names the line the USER wrote.** The sandbox indents the code into `def _user():` after
a three-line prefix, so every traceback pointed three lines past the statement that actually failed — on a
four-line script, at line 7, and the frame above it (`<exec>`, the prelude's own call site) reported line 166,
which is about nothing the user can see. Corrected in the AST (`increment_lineno` on the user's statements)
rather than by rewriting the traceback text, so CPython emits true numbers natively — which means **the MODEL
gets them too**: handing it a traceback that names the wrong line costs it a turn, and a UI that quietly
disagreed with the text the model was given would break the raw-view rule. A **SyntaxError needed its own
fix**: it is raised BY the parse, so the correction never runs for it, and the one error whose entire content
is "which line" was naming the wrong one — its `lineno`/`end_lineno` are shifted and it is re-raised, with a
real `filename` so the frame is identifiable as the user's. The user's frame is the one in `<python_exec>`;
anything in `<exec>` is the prelude. Five tests in `tests/python.test.mjs` against real CPython, because an
off-by-N that is right for one shape of script is not right for the next.

**Python is PRETTY-PRINTED for the human and never for the model (`src/py-format.ts`).** A model writes
dense one-liners on purpose — the right trade for the thing paying per token, the wrong one for the person
reading the step — so the RENDERED view reflows and the raw view, the export and the model's context all keep
the original. Two invariants make that safe rather than a second source of truth: **tokens are never
changed** (only whitespace and newlines between tokens that were already there, so the displayed code always
runs the same as the code that ran — the test compares the whole token stream), and **it reports what it
did** via a line MAP, because reflowing moves line numbers and a traceback's entire content is a line number.
When it cannot account for the source it returns it untouched: a formatter that is WRONG is worse than one
that declines, since the reader would be looking at code that is not what ran with no way to tell. It
declines on an unterminated string, an unbalanced bracket (which otherwise JOINED the following line onto
it) and a triple-quoted string (whose statement it truncated) — all three found by writing the tests.

**Line numbers survive any reformat (`src/line-map.ts`).** Every pretty-printer we show code through moves
them, and a stack trace's whole content is a line number — so the rendered view and the error silently stop
agreeing. `py-format` builds its own map as it goes; **js-beautify hands back none**, so for `exec`'s JS the
map is DERIVED from the two texts: strip the whitespace from both and they are the same string, so a position
in that stripped stream identifies the same code in each. That works for any formatter that only moves
whitespace, which is why there is one mechanism rather than one per language. It REFUSES when the two do not
agree once whitespace is removed — a map derived from a mismatch points confidently at the wrong line, which
is worse than an un-mapped number the reader could at least distrust. **The one thing it cannot see** is
whitespace inside a string literal (`'a  b'` and `'a b'` strip identically); telling those apart needs a
tokenizer per language, which is the thing it exists to avoid, and both formatters using it copy strings
byte-for-byte. `tests/e2e/line-map.spec.mjs` is the only thing that runs the whole chain — real CPython
raising, the real worker returning, the real renderer mapping — because the demo asserts nothing and so
cannot fail.

**A traceback is rendered, not rewritten — but the NUMBER SHOWN is the row on screen.** Each
`File "<python_exec>", line N` becomes a link that maps through that line map and scrolls to the line,
pulsing it the same green a cited step gets; the DEEPEST user
frame is marked in the CODE (a traceback gives you a number, and the number is only useful once you have
found the line it names), with the "shown reflowed" caveat added ONLY when the formatter actually moved that
line — an unconditional caveat is noise that undermines the times it is true. A `<exec>` frame is the
prelude's own call site: dimmed, never dropped, because the raw view has to stay recoverable. Pointing at a
line turns the gutter on for that block regardless of the preference — you cannot mark a line in a block with
no lines. **The displayed number is REMAPPED, and only in the render**: the code beside a traceback is
reflowed, so printing the number CPython produced sends the reader to a line that is not the one that
failed — the exact failure the line map exists to prevent, reintroduced by the view. So the frame shows the
row it now sits on and its tooltip names both (only when it actually moved), while the raw view keeps the
traceback verbatim and the model keeps the number it was given. The map is derived ONCE — `inLineMap` in
render-panel.tsx, handed from the In block ACROSS to the Out by the step, since the two are separate
descriptors that cannot see each other and three copies of that arithmetic would be three chances to
disagree about which line a failure was on.

**JS reports its line too (`src/exec-trace.ts`).** `exec` returned `e.message` and dropped the stack, so a JS
failure said WHAT and never WHERE — half the answer, for the reader and for the model about to retry it.
There is no traceback worth rendering (an evaluated script's stack is almost entirely the wrapper), so it
reports ONE line, which then travels the identical route a python frame does: through the derived map, into
the beautified code, marked red and clickable (`jumpToLine` is shared by both, rather than a second near-copy
of the same gesture). The awkward part is that the stack's line is NOT the model's line, and the two paths
`exec` can take shift it differently — an indirect `eval` inside a `Function` (offset 0) or an
`AsyncFunction` BODY when the source uses top-level await/return (offset 2, in V8 today). Both offsets are
**MEASURED at runtime** by throwing from a known line inside the real construct, with the same PARAMETER LIST
the real call uses, because a written-down constant is a guess about a wrapper we do not own and would drift
silently rather than fail. The line rides the `exec-out` descriptor as `errorLine` and is appended to the
model-facing message as ` (line N)` — it is retrying this code, and a line number is the difference between a
targeted fix and a rewrite. **Anything it cannot be sure of is null**: no stack, no evaluated frame, or a
frame that maps outside the source (a failure inside something the code called) is refused rather than
clamped, because a confident wrong line sends the reader to innocent code and they conclude the tooling is
broken instead of the number.

**A cell we cannot render says so.** `PyDfTable` coerced every cell with `String()`, so a pandas column
holding a dict — `dict(per_q)` in a cell is an ordinary thing to write — rendered as `[object Object]`: a
wrong fact printed exactly where the reader is looking for the right one, and it shipped because nothing
asserted on a non-scalar cell's TEXT. `dfCell` serialises an object as JSON (which is what the value already
IS by the time it arrives — the sandbox returns through `json.dumps`) and returns **null** for one that
cannot be serialised at all. Null is not the string "null": the cell then draws the same dashed red marker an
unresolvable pointer uses, naming the type, with a tooltip saying the failure is in the PREVIEW and not in
the run. The CSV copy goes through the same function, so what you paste cannot disagree with what you saw.
**The same bug in another costume was still live one layer up**: pandas serialises an arbitrary object — a
class instance, a function, a nested frame — to an **empty object**, and `{}` is a *plausible* value, so it
read as the truth and `dfCell` had no way to tell it from a genuinely empty dict. Named at the PRODUCER
(`python-runtime.ts`, before `to_json`), because the sandbox is the last place the real type is still known:
a lost cell becomes `{"__ml_unrenderable__": "<type name>"}` and the panel draws the same marker with the
**Python** type on it. Only what would be LOST is touched — a dict stays a dict, a set still becomes the list
pandas makes of it, numpy scalars and timestamps still convert — since a rule that swallowed working values
would be worse than the bug it fixes. Real-CPython tests both ways in `tests/python.test.mjs`, end to end in
`tests/e2e/line-map.spec.mjs`.

**Affordances on a rendered code block (`CodeTools`, render-panel.tsx).** A block of someone else's code is
something you read, copy, and want explained, and it offered none of those. Quiet by design — half opacity
until the block is hovered, since a toolbar competing with the code for attention is the opposite of what a
code block is for. Python gets **explain** + **▶ bench**; JS gets **explain** + **copy**.
- **explain** annotates the interesting LINES with the utility model (`annotate.ts` is the pure half —
  prompt, schema, and the coercion of the reply; `summaries.tsx` holds the store, beside the approval-card
  gloss it is a sibling of). Opt-in per block, NEVER automatic: it spends tokens and, unlike the approval
  gloss, nobody is waiting on it to decide anything. Constrained by a **JSON schema**, because a line number
  recovered by regex from prose is exactly the confidently-wrong number this whole subsystem exists to stop
  producing.
- **The notes go in the MARGIN and never into the source.** Inserting a comment would shift every line below
  it, which invalidates `py-format`'s line map and stops a traceback resolving — so a note is a SIBLING of
  its line (`.lnote`, drawn under it rather than to its right: the panel is often 400px wide and a true
  right margin sits off the end of a horizontally scrolled block). Notes turn the gutter on for the same
  reason a `markLine` does — you cannot key a note to a line the reader would have to count to.
- **The model is numbered against what the READER sees.** The block draws reflowed source, so numbering the
  original would have the annotator pointing at lines that moved and the note landing on the wrong row,
  silently. `displaySource` is exported from ui-kit for exactly this: `Code` beautifies JS internally, so a
  caller cannot get the drawn text from what it passed in.
- **Nothing from the model is trusted.** A line outside the block is DROPPED rather than clamped (clamping
  invents a claim about a line it never looked at, and lands it on the first or last line, where a reader
  would believe it); repeats and blanks go; the set is capped in count and length. An unusable reply is an
  ERROR STATE offering a retry, not an empty success — a button that visibly does nothing reads as broken.
  The gloss is rendered through the markdown renderer (`mdInline`, one `<p>` peeled off) and its tooltip
  says it is model-generated and approximate.
- **▶ bench** hands the script to the Python bench (`lsSet(BENCH_CODE_KEY, …)` then navigate). The bench
  reads that key on MOUNT and is only rendered while it is the open view, so writing-then-navigating IS the
  handover. It sends the REFLOWED source deliberately: `py-format` never changes a token, so that is the
  code that ran and it is the code you pressed the button next to. `lsGet`/`lsSet` live in `store.ts`, not
  `vram.tsx`, because render-panel cannot import vram (vram imports RenderPanel — a cycle).

**The RAW view of either slot is an `OutputCell`.** Capped, scrollable, and findable with Ctrl+F — because
raw is the view you go to in order to SEARCH for a token (the one selector that differs between two calls,
a key buried in a wide args object) and the one with no structure of its own to cap it: a call carrying a
base64 image or a wide table otherwise stretches the step to any height. The RENDERED views are not wrapped
here — an Out's renderer puts its own sections in cells, and a rendered In is already a code block. The
composition question that raises is whether the JSON tree inside can hide text from the find, and it cannot:
`RawArgs` passes `allOpen`, which makes `JsonNode` non-collapsible at EVERY depth, so nothing can be folded
away from a search. That is load-bearing rather than incidental — a find reporting "No results" over data
that is visibly right there reads as the find being broken — so it has its own test.

**A retry's DIFF against the call it revises (`src/diff.ts`, `CodeDiff`).** The commonest loop in a run is:
a code tool fails, the model retries with a tweak, and the reader diffs two twenty-line blocks BY EYE to
find the one line that moved. `exec` and `python_exec` take **`revises`** (an `@tool:` pointer to the
earlier call, in any of its three forms) and **`changed`** (a one-line account of what it altered).
- **WE compute the diff; the model never supplies it.** Asked what it changed, a model answers from what it
  MEANT to change — and the two disagree exactly when the diff is worth reading. Its `changed` line rides
  BESIDE the rows on its own ground, tagged as a claim (the same rule a `token:` label follows).
- **Both sides are REFLOWED before comparing** (the block's own `pyFormat`/`displaySource`), or pure spacing
  differences drown the real change: a model writes dense on purpose and two calls a minute apart are not
  spaced alike.
- **Resolved in the LOOP** (`revisionOf`, beside `derefLocally`) for the same reason: it is a pure read of
  run state the loop owns, so it behaves identically on the page-hosted and background-hosted paths with no
  round-trip and no approval. The loop carries the OLD SOURCE on the descriptor and the PANEL does the diff —
  it already owns both formatters, and shipping one into the loop would be for nothing. An unresolvable
  pointer yields no diff rather than a fabricated comparison.
- **The header says what it is diffing against and takes you there** — the pill is the resolved pointer
  (canonicalised to the minted id even when the model named an alias) and clicking it runs the same
  `scrollToStepSeq` a citation does. It draws through the shared **`PointerChip`** (ui-kit), which is also
  the copy chip under a step: a pointer must not read as a different KIND of thing depending on which
  surface names it, and this was a CSS copy of that chip for a while, which is how that starts. The chip is
  the SHELL only — one copies, one navigates. Its label is the model's own name for the output when it gave
  one (prefixed by the tool, so `the q1+q2 totals` is not mistaken for a step title) and the raw pointer
  when it did not, because an id you can copy beats a name we invented.
- **`scrollToStepSeq` re-queries the slot anchor after opening a collapsed step.** The lookup ran while the
  open was still re-rendering, so nothing was visible yet and it fell back to the row — meaning a slot
  citation worked on an already-open step and never on a closed one, which is the case you are usually in.
  Its test needs a step TALLER than the viewport or landing on the row and landing on the code are the same
  place, and it passes with the fix reverted (that is how the first version was caught). `TokenValue` gained `seq` for exactly that: `step` is the loop's counter
  and several records share it, while `seq` addresses one row.
- **It opens only when the step FAILED.** "What did I change" is the question you ask about a failure; on a
  retry that WORKED the output is the question, and a diff pinned open above it pushes that output out of
  the viewport to answer something nobody asked. Collapsed it is ONE line that still names what it revises
  and by how much — so the claim row lives inside the fold too, or "collapsed" would be two lines. Focus
  mode folds it either way, since it is a debugger's question even on a failure.
- **The gutter draws BOTH line numbers, and only when they line up with something.** The new-side column is
  the same numbering the code block below draws, so a diff row, a margin note and the failure mark all name
  the same line and you can read straight down between them — that is what makes the width worth spending.
  With the block's own gutter off they line up with nothing, so they are drawn when the line-number pref is
  on OR the step failed (which turns that gutter on by itself, so the two can never disagree). A row that
  exists on one side has one number; the other column is blank, which is the claim being made.
- Hunks ELIDE (`collapse`): two thirty-line scripts differing in one place must SHOW that place, not bury it
  in twenty-nine rows already read. A gap standing for ONE line is un-elided, since saying "1 line skipped"
  costs more than the line and makes the reader wonder what was hidden.


**A code block's `explain` (`src/sidebar/annotate.ts`).** A utility model is shown the code AND what it
produced, and answers under a JSON **schema** with a note per interesting line. Never automatic — it spends
tokens, and unlike the approval gloss nobody is waiting on it to decide anything — and asked at CLICK time
only, once: a second click while in flight is a no-op, and once notes land the button becomes show/hide
rather than re-asking.
- **The notes go in the MARGIN and never into the source.** Inserting a comment shifts every line below it,
  which invalidates the line map and stops a traceback resolving. A note is a SIBLING of its line.
- **The model is numbered against what the READER sees** — the reflowed text, via the exported
  `displaySource`. Numbering the original would key notes to lines that moved, landing each one a statement
  adrift, silently. (The demo made exactly that mistake first.)
- **Nothing it returns is trusted**: a line outside the block is DROPPED rather than clamped (clamping
  invents a claim about a line it never looked at, and puts it where a reader would believe it); repeats,
  blanks and non-numbers go; the set is capped. An unusable reply becomes a RETRY state, not an empty
  success — a button that visibly does nothing reads as broken.
- Prose renders through `mdInline` with **math on**: a note about arithmetic says `$q_1 + q_2$` in one glyph
  instead of a clause.
- **Not on the HUD card.** The card is a reading surface with no navigation of its own; `explain` belongs
  there (understanding the code is what the card is for) and `bench` does not.
