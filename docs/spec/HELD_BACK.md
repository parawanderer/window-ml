# What is held back is named

Whenever the machinery cuts, caps, drops or loses something before the model sees it, the text the model reads says
three things:

1. **That** something was held back. A cut result that reads as complete is the failure this exists for.
2. **How much**: a count (chars, rows, images, screens), or "unknown" when the machinery cannot tell. Never silence.
3. **How to get it back**: the call that reaches the rest (a pointer and a pipe, a larger `limit`, a page image, a
   scroll), or plainly that there is none.

The reason is the model's ability to unblock itself. A heuristic in the engine covers only the cases it was measured
on; a model told what it is missing, and how to reach it, recovers from losses nobody predicted. This is the same
reason a person with no interest in code gets work done in Claude Code: when something is in the way, the tool says
so and says what to try.

## Rules

- **The note is in text the model reads**, not only in a field (`truncated: true`), a log, the execution log or the
  sidebar. Fields are for code; the model reads prose.
- **One line, at the point of the cut.** The note goes with the result it qualifies, not in the system prompt alone.
  The system prompt may teach the general shape; the note names this instance.
- **The recovery is something the model can call now.** A note that names a tool the model does not have, or a
  parameter the schema does not offer, is a defect. If there is no way back, the note says so, so the model can stop
  trying or ask the person.
- **Amounts are the real total**, not the size of what was kept. When the total is unknown, say "unknown".
- **Lost is not "never existed".** A value the machinery dropped (eviction, a cap) answers differently from an id
  that was never minted, so the model re-runs the first and doubts its memory on the second.
- **A delegated reader's text is attributed.** When another model wrote what the driver reads (a `look`
  description, an `ask` answer), the driver is told so, and told when that reader's output was itself cut.

The exemplars: `abridgeRow` (`print.ts`), which says what it abridged and how to see the rest, and `agent_api_docs`,
which names what it leaves out and how to ask for it.

## Inventory (2026-10-28, origin/main 29f5924b)

Each row is a cut the model is not told about, or is told about without a way back. File:line references are at that
commit. A row leaves this list when its fix merges.

| # | Where | What is held back | Told today | Way back today |
| --- | --- | --- | --- | --- |
| 1 | Context overflow (`agent-loop.ts`, `ml-agent-run.ts:570`) | The oldest context, dropped by the backend past `num_ctx` | Nothing; `chat_metadata` reports fill only if asked | None |
| 2 | Generation cap (`sw-llm.ts:284,977,1155`; `READER_MAX_TOKENS` `contract-render.ts:34`) | The rest of a reply cut at `max_tokens`; `finish_reason: "length"` and `done_reason` are never read | Nothing; a cut `look` description reads as complete | None |
| 3 | Pointer loss (`sw-runs.ts:573-602`, `token-pipe.ts:192-211,344-366`) | Every value, on worker eviction; the oldest past `TokenStore.CAP` 200 or `MAX_TOKEN_SESSIONS` 24 | "Nothing has been captured", or "does not exist … you may be inventing the id" | Re-run the tool (said only for the empty store) |
| 4 | `fetch_url` preview (`ml-tool-factories.ts:202,404`; `agent-loop.ts:1146-1168`) | Past 4000 chars | The amount | The full body is under a pointer the result never names |
| 5 | `toolTokens` off (`agent-loop.ts:1109`; `ml-agent-run.ts:108`) | Past 500 (exec) or 2000 (python_exec) chars, kept nowhere | The amount | Re-run narrower, or a larger `maxChars` with approval; neither is named |
| 6 | Pointer cap `UI_OUT_CAP` 12000 (`contract-chat.ts:148`; `agent-loop.ts:1168-1170`) | Past 12000 chars, kept nowhere | The cut line says the pointer "holds N chars", which reads as the whole output | Re-run narrower; not said |
| 7 | Python page tables (`dom.ts:1127,1166-1194`; `ml-python.ts:250-269`) | Rows past 5000, columns past 200 | Nothing | None |
| 8 | `findByText`, `interactives` (`tools.ts:164,250-263`) | Matches past `limit` (10, 40), uncounted | Nothing | A larger `limit`, `contains` or `scope`; not said |
| 9 | Stitched screenshot (`page-geometry.ts:234`; `ml-vision.ts:519`) | The page below 8 viewports | "Screenshot of the full page captured" | Scroll and look; not said |
| 10 | Delegated `look` (`builtin-tools.ts:309-314`) | Who wrote the description | Nothing | n/a (attribution) |
| 11 | `fetch_url` read cap (`sw-fetch.ts:53,117-121`; `ml-tool-factories.ts:254,399-403`) | Past 8 MB (64 MB for tables), not stored | "body truncated", no size | None: no range or offset |
| 12 | `fetch_url` `ask` reader (`ml-tool-factories.ts:208,314,336`) | Past 24000 chars of the page | "may be incomplete", no amount | Narrow with `pipe`, or drop `ask`; not said |
| 13 | `ml.sh` host cut (`sh-call.ts:533,597-610`) | Past the host's capture bound; `size` is what was kept | Only the `truncated` field | None for the cut part |
| 14 | Chat images (`sw-chat.ts:33,172`) | Images past 8 in a turn | Nothing, to the model or the person | None |
| 15 | Delegated page answers (`page-answer-caps.ts:145-172`; `worker-media.ts:56`) | Columns past 2000, cells past 100k chars, media past 4 MB | Only text and image drops get a note | None |

PDF attachments are not wired yet. When they are, a page sent as text without its image says what the measurements
saw (a figure, drawn paths, broken glyphs) and how to look at the page: `FILE_ATTACHMENTS.md`.
