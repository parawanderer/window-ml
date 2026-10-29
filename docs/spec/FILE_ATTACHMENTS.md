# Spec (WIP): attaching files to a message

**Status: slice 1 built (2026-10-28, `feat/attach-text-files`); slices 2 and 3 designed, not started (Shane and the
calm-chat-motion session).** The order is three slices, each landing on its own: text files, then PDFs, then documents
as `@file:` pointers in agent runs. Slice 3's contact
points with the python, shell and policies lanes were ruled on by their coordinator (2026-10-28, "Rulings" below).

## What it is for

The chat page and the session composer take images. A person who uses this instead of a commercial chat UI also drops
in a log, a CSV, some source code or a PDF, and expects the model to read it. Today they cannot.

The usual design pastes the file's text into the prompt, out of sight. This one does not, for two reasons that come
from the rest of window.ml:

- **A large file in the prompt is the wrong default for an agent.** A run already has pointers to values it reads on
  demand (`@tool:`, [`POINTER_VALUES.md`](POINTER_VALUES.md)). An attached file is one more such value: the model gets
  an outline and reads the part it needs.
- **The person sees what the model saw** (the AGENTS.md rule for the log and the exports). A file is never spliced in
  silently: the calm view says how it went, the dev view shows the exact text.

## Slice 1: text files

**What counts as text.** Decoded as UTF-8 with `fatal: true`; a file that does not decode, or holds NUL bytes, is
refused as "not a text file" by name. The extension list is not the test (a `.log` or an extensionless file is text if
it decodes), but the picker's `accept` offers the common ones.

**Sent whole, up to a cap.** Below `FILE_INLINE_MAX` (32,000 characters of decoded text per message across all its
files, one exported constant in `src/attached-files.ts`; a FIRST FIGURE, about 8k tokens, still to be measured against
[`PROMPT_BUDGET.md`](PROMPT_BUDGET.md) and scaled to a small context window) the text goes into the message as one block
the model can tell apart from what the person typed:

```
<file name="server.log" type="text/plain" bytes="18234">
…the text…
</file>
```

The name (and the type) are attribute-escaped (`"`, `<`, `>`, `&`, line breaks). The text is not interpreted, with one
exception: a literal `</file` (any case) inside it is written `<\/file` and the tag says `escaped="N"`, so a file cannot
close its own block and speak as the person. A per-message random closing tag was the alternative; it was not taken
because the same message must always produce the same prompt (an export, a diff of two runs, a test compare the
bytes). `bytes` is the UTF-8 length of the decoded text. Several files are several blocks, in the order attached, after
the typed words (or alone, when there are none).

**Above the cap.** A chat refuses it with the reason and the size ("server.log is too large to send whole: 210 kB; a
message takes up to 32 kB of files"), never cutting it off silently. An agent run takes it as a pointer (slice 3); until
slice 3 lands, the agent run refuses it the same way, and says so ("An agent run will read large files on demand in a
later change"). The composer refuses before sending (a refused file stays in the box as a pill with its reason and is
not sent); the runtime checks again, since a client's check is a convenience and the runtime's is the rule. A PDF is
refused as "report.pdf is not a text file; PDFs come in a later change".

**The command shape.** `chat.start`, `agent.start` and `session.send` gain `files?: AttachedFile[]`:

```ts
interface AttachedFile { name: string; type: string; text: string /* decoded UTF-8 */ }
```

**Deviation from the first design: `text`, not base64 `data` with a `bytes` field.** Slice 1 carries only decoded text,
so base64 would be a third of the cap spent on encoding; the base64 `data` comes with PDFs in slice 2, where the bytes
are the point. Checked like `images` (`session-commands.ts`): a bounded name (255 characters), a bounded count (10), a
total text cap per command (`FILE_INLINE_MAX`), and the same refusal shape (`invalid`, with the reason). A message with
only files and no words is valid. **Not `@hub-compat`**: the hub forwards sealed bytes and never reads the field (a big
command over the hub is now refused or its images shrunk, #1238, which this slice does not depend on). A runtime that
does not list the new `capabilities.attachFiles` would ignore the field and send the message without the files, so a
client sends `files` only to a runtime that lists it, and offers files only there.

**What a transcript carries.** Not the file twice: the message's `text` is exactly what the model got, `<file>` blocks
included, and the `display` that already separates a person's words from an element they attached (`PromptDisplay`)
gains a `file` context, the descriptor (name, type, bytes, lines) and no text. That also fixes the earlier line that a
file "never travels back in an event": in slice 1 the text does travel in the message's own text, as the rule that the
log carries what the model saw requires. The bytes-by-reference design below applies to slice 2.

**Stored (slice 2).** The bytes live in the value store (`ml-values`, `value-store.ts`), claimed by the session, so they
outlive the worker and are released when the session is. Storage stats list attached files as their own row beside
images. Slice 1 stores nothing of its own: the text is in the session's events and chat history.

**Known gap.** A chat session a PAGE hosts (`ml.createChat` in a console, continued from the chat page) frames the files
into the message but its event has no `display`, so the calm view shows the blocks as text. The worker's chats and
every run have the chip.

## Slice 2: PDFs

**Library.** pdf.js (`pdfjs-dist`, pinned exactly at 6.4.299, the legacy build), run in a dedicated worker the offscreen
document starts (the service worker has no DOM or canvas, and a parse on the offscreen document's own thread would
freeze the sidebar), and later in the chat page's web build. The layout-model converters (Docling, Marker, MinerU) give
better results on hard pages but are Python with neural models: a possible later service on a box, not the default.

**Built (slice 2b, the reader core).** `src/pdf/`: the measurements, the classifier, a bounded page-by-page reader and
the worker, with nothing user-facing wired. How it runs, its bounds and where the PROVISIONAL thresholds live:
[`docs/dev/pdf.md`](../dev/pdf.md).

**Per page, not per document.** For each page pdf.js gives two measurements:

1. **Usable text**: the text layer's characters after dropping a broken layer (mostly U+FFFD, or glyphs with no
   Unicode mapping, past a ratio).
2. **Image cover**: the share of the page that image draws cover, from the operator list (each `paintImageXObject`
   and its transform gives a box; the union's area over the page's). Vector drawing (charts and diagrams drawn as
   paths) is measured the same way as **path cover**, from each filled or stroked path's box, and counts as a figure
   at a higher share than images, because form fields and framed boxes are drawn as paths too.

| Page | Usable text | Image cover | Sent |
| --- | --- | --- | --- |
| Text | enough | small | its text |
| Scanned | almost none, or broken | most | the page as an image (vision on), else the reader model's reading of it |
| Mixed | enough | a real share | its text, plus the page image when the model sees images; otherwise its text and the line "page N has a figure you cannot see" |
| Scan with an OCR layer | enough, drawn invisibly (text render mode 3) | one image, the whole page | its text; the page image too only when the layer reads as broken |

The OCR'd scan (what ocrmypdf and most office scanners write) would otherwise read as "mixed" and send every page
twice. It is told apart by the invisible text over a single full-page image, not by the two measurements.

**What is held back is named.** The thresholds pick a cheap default; the model can always look at a page itself
(slice 3's `look` target, `png()` in Python). So a page sent without its image says what the measurements saw when
they saw something: a `text` page with a drawn share under the figure cut gets a short note naming it ("page N: images
or drawing cover 12%; look at it to see them"). Missing a figure costs a look; an image sent for nothing costs its
tokens on every turn. The note's floor and wording are open, and land with slice 3. The rule the note follows, and
the other places window.ml holds something back, are in [HELD_BACK.md](HELD_BACK.md).

**The test PDFs.** Synthetic fixtures, committed, with the answer known by construction: a text page, the same page
rasterised, that scan with a one-line footnote, the scan with an invisible OCR layer, a page with a chart over a share
of it, and a page whose text layer extracts as junk. Real pages, not committed and pinned by hash in the notebook: the
Digital Corpora sets (govdocs1, and the PDFs taken from Common Crawl), arXiv papers for figures, and pdf.js's own test
files for broken and adversarial ones. Each real page is labelled by looking at its render; a few hundred pages set two
thresholds.

The thresholds are measured, not guessed (the first values in `pdf-classify.ts` are provisional, picked against the
synthetic fixtures above until this notebook exists): a notebook over a set of real PDFs (papers, invoices, slides exported to
PDF, a scanned letter with a typed footnote, a form) records each page's two numbers and the right answer, and the
cut-offs are read from it ([`docs/dev/notebooks.md`](../dev/notebooks.md)). The footnote-on-a-scan page is the case to
tune for: some text, still a scan.

This is what the commercial APIs do on a vision model (each page as text and image); the difference is that a page
image is sent only where the measurements say it carries something the text does not.

**Size.** The cap from slice 1 applies to the text the pages produce. A PDF past it goes to a chat refused with the
reason, and to an agent as a pointer.

### Wiring a PDF through the attach path (decided 2026-10-29)

Shane's rulings on four forks, with the hub's constraints from the `[window-ml hub]` session (window-ml-hub 95cb341).

**The runtime reads the PDF, from its bytes.** `AttachedFile` gains `data` (the bytes) in place of `text` for a PDF.
The client checks the file (magic bytes, the size cap below) and sends it; it does not extract or classify. The runtime
reads it through the offscreen reader (`PDF_READ`, `docs/dev/pdf.md`), renders the pages that need an image
(`PDF_RENDER`), and keeps the bytes in the value store, claimed by the session, for slice 3's `look` and `png()`. A
client that extracted the pages would be trusted to say what the file holds, and the web build and the phone would each
carry pdf.js. What the model gets is one `<file>` block, a `<page n="…">` section per page read, with slice 1's escape
extended to `</page`; whatever the reader held back (the page cap, the time budget, a page that would not read) is named
in the block by the rule in [HELD_BACK.md](HELD_BACK.md).

**Over the hub: chunks in an acknowledged window.** A PDF is usually past the hub's payload limit (`(1<<20)-1024`,
announced in `Welcome.limits`; a frame over it closes the sender's connection, so the client's `CommandTooLarge` check
stays). The client sends the file as `file.put { sha256, index, count }` commands, a `KIND_COMMAND` with a `file.put`
scope, the chunk as RAW bytes beside the JSON (base64 would spend a third more of the account's rate budget and a third
more chunks), each sized to the payload limit less the seal's overhead. The send then names the file by
`{ name, type, sha256, bytes }`. No hub change.

- **At most 4 chunks unacknowledged**; the runtime answers each with a `COMMAND_RESULT`. A runtime's outbound queue on
  the hub is 16 MiB, and a frame that does not fit closes the RUNTIME's connection, every session it serves with it, so
  a fast sender to a slow runtime must not burst. The window bounds that at a quarter, and gives progress and resume.
- **Done is the runtime's word, never "all sent".** Frames queued to a runtime whose connection drops are discarded
  silently. After a reconnect the client asks which indices the runtime holds for that `sha256` and sends the rest.
  Chunks are addressed by index; the hub delivers in order today, but promises nothing.
- **An offline runtime stores nothing**: each chunk is refused at once (`UNAVAILABLE`), so the composer says the
  runtime is offline instead of waiting.
- **Cap**: `min(20 MiB, 0.6 x the account's burst allowance)` per attachment and per send, the allowance from
  `Welcome`. The account's rate (8 MiB/s, a 32 MiB burst) is shared with the runtime's own event publishing, so one
  upload past it would slow every session's live replies on that account.
- The same reference by hash spares the extension's own chat page a second copy of a file attached twice.

**Images go only to a model known to see them: unknown is refused.** A worker chat attaches images today without
asking; it now asks the question an agent run does (`_modelSees`: Ollama reports vision, or the person declared the
default model as seeing in Settings). When a message would send an image (pasted, or a page that needs one) and the
answer is:

| The model… | The message |
| --- | --- |
| sees | is sent with the images |
| does not see, and a reader model is set | goes with the reader's reading of each image, attributed to the reader |
| does not see, and no reader model is set | goes with each such page named ("page 3 is a scan this model cannot see; set a reader model in Settings to have it read") |
| is UNKNOWN | is refused before sending, with a sentence: "This model may not see images. If it does, turn on 'This model sees images' and send again." Nothing is dropped and nothing is sent. |

The override is `vision: true` on `chat.start`, `agent.start` and `session.send`, the person's declaration, meaning
what `ml.agent({ vision: true })` means: send the images to the run's own model, no probe. The composer offers it as a
toggle when the model's vision is unknown; the refusal is checked again in the runtime. This changes what a worker
chat does with a pasted image today: a model of unknown vision used to get it, unread.

**Eight images per turn, the rest named.** `MAX_TURN_IMAGES` stays 8, a hard cap, with no token budget. Images the
person pasted count first, then the pages that need one, in page order. A page past the cap goes to the reader model
when one is set, and otherwise is named in the block with what can get it: "pages 9-48 are scans not sent as images.
This chat cannot show them." Once slice 3's `look` on a page exists, an agent run's note names it as the recovery;
until then the note says there is none, since a recovery named must be callable now.

## Slice 3: an attached file as an `@file:` pointer

**The prefix.** `@file:`, its own, beside `@tool:`, `@pt:` and `@box:`: the value came from the person, not from a
tool call, and its ids must never collide with a tool output's. The three reference forms are the pointer rules'
(pointers.md): `@file:"report.pdf"` (the quoted label is the file's name), a minted id with its check character, told
apart by SHAPE and never tried in order. There is no bare form.

**What the model is given up front** is an outline, not the content:

```
@file:3fa91c2 "report.pdf": attached by the person. PDF, 48 pages, 61k tokens of text.
Pages 3, 7, 12 have figures; pages 40-48 are scanned. Read with dereference (pages N-M) or look (doc, pages).
Page 1: …the first page's text, to the preview cap…
```

"Attached by the person" is there so a model does not take the name for a path on disk; `ml.sh` given an `@file:`
pointer as an argument refuses with a sentence saying it is an attachment, not a file in the workspace. That refusal
is the shell call's one rule for every pointer prefix in argv, not a manifest's (SHELL.md).

**Reading text by page.** The pipe dialect gains one verb, `pages N-M` (`PIPE_CMDS`, text-pipe.ts), which selects whole
pages from a paged value before the other verbs run: `dereference("@file:3fa91c2", { pipe: "pages 3-5 | grep -i
revenue" })`. A text file is one page per N lines (open: N), so the same verb pages a long log. Extending the dialect
requires the adversarial tests in readonly-exec.md ("The rule for extending the dialect"); `pages` gets its own bound
(how many pages one pipe may select) with adversarial rows of its own.

**Looking at pages.** `look` takes a document target: `look({ doc: "@file:3fa91c2", pages: "4", question })`. The
pages are rendered from the stored bytes by pdf.js in the offscreen document, then go down the existing vision path
(native when the model sees, delegated to the reader otherwise). Bounded per call like a full-page look (eight
screens): open, a figure of about four pages.

**A paged document, not a PDF type.** The stored value is a list of pages, each with text and an optional render
recipe. A PDF is the first producer; a very tall image or a long screenshot can be cut into pages the way a full-page
look tiles; other formats come later through a converter, never a code path of their own.

**Other producers: a PDF the agent fetches.** The paged document is a value KIND; the prefix says where it came from.
Today `fetch_url` on a PDF answers only "a PDF document, N bytes" (`binaryKind`, body-read.ts), and `navigate` to one
leaves the run in Chrome's viewer, readable only by screenshot. With slice 2 built, `fetch_url` keeps a PDF body in
the value store the way it keeps a large CSV or Parquet body, and answers with an `@tool:` pointer carrying the same
outline, first line "fetched from <host>". `navigate` is already judged as a fetch (#1129); landing on a PDF answers
with the same pointer instead of the viewer. Both are judged by the existing fetch rules and policies: nothing here is
a new way to reach a URL, and nothing writes to disk (saving a file is `ml.sh`'s, with its own approval). The
`navigate` change gets the red-team pass.

**Eviction differs by producer.** A fetched document can be fetched again, so it is evicted like any value (budget,
idle) and a later read says `ValueMissing` and "re-run the step". An attached file cannot be fetched again: it is held
for the session's life, exempt from idle and budget eviction, and counted against the budget at attach time, so a file
the store cannot hold is refused when it is attached, never lost later.

**One copy of the same bytes.** (Built, slice 2a.) The value store is ROWS over BLOBS (value-store.ts): a blob is kept
once under the SHA-256 of its bytes (WebCrypto, in the worker), and each fetch or attach is still its own row with its
own key, since a pointer names one fetch from one source at one time. The key stays the only handle: claims and
tombstones are per row, so `ValueMissing` still says why THIS pointer is gone. A read through any row reads the blob and
marks THAT row read. The budget charges a blob once, however many rows share it, and the hash is taken BEFORE the budget
check, so a second copy of stored bytes is never refused for room it does not take (even when the blob alone is over the
budget) and evicts nothing. Idle eviction is per row; budget eviction is per blob: the rows sharing one are a group,
read as recently as the latest of them, evicted whole, and skipped whole when any of them is protected. A blob is
deleted in the transaction that deletes its last row; a row evicted while its blob stays frees no bytes, and its
`Eviction` says so (`shared`). A document that changed hashes differently and is stored anew. An attached file's
session-long hold is `planEviction`'s existing `protect` list, not a new mechanism; it protects the blob's whole group,
so a fetched copy of the same bytes cannot take it out with it. Rows written before this (database version 1) carry no
hash and own a blob under their own key: they are not rehashed, and read and go as before. Two formats join
`ValueFormat` for what comes next: `paged` (a document as a list of pages, each with text and an optional render recipe)
and `bytes` (raw bytes).

**Python.** An attached file reaches `python_exec` as an INJECTED value, like a stored table, not as a path: there is
no `/attached/` directory and no `open()` of one. The call names it, `files: { name: "@file:3fa91c2" }`, and the
`tables` map accepts an `@file:` pointer as a source like a URL; the sandbox's existing `read_csv`/`open` redirect
resolves a name it was given. Specified on the python side in PYTHON_DIALECT.md.

A paged document is injected as the pages, not only as its bytes (Shane, 2026-10-28): raw PDF bytes are close to
useless in the sandbox, which has no PDF library and would spend its step budget parsing one.

```python
doc = files["report"]
doc.pages[3].text, doc.pages[3].kind, doc.pages[3].measure   # what the reader already computed
doc.pages[3].png(scale=1)   # rendered on demand by the offscreen pdf.js
doc.bytes                   # the file as attached
```

- `text`, `kind` and `measure` are the stored value's own fields, read with the value: no call leaves the sandbox.
- `png()` is the one crossing. It asks the offscreen document to render that page from the stored bytes, the same
  render `look` uses, and returns PNG bytes for code to crop, measure or tile. It is bounded per cell (pages rendered
  and total pixels; open: the `look` bound of eight screens), the scale is clamped, and a render that fails or runs
  over its time answers with a sentence, never a hung cell. It reads only the document the cell was given.
- Pixels in a cell are numbers, not sight: a model that wants to SEE a page uses `look`, which stays the one vision
  path and the one place page images are counted against the context.

`png()` is a new call out of the sandbox, so it gets the red-team pass with the rest of slice 3: a cell cannot render a
document it was not given, cannot pass the bound by looping or by asking for a huge scale, and a crafted page cannot
hang the cell past its budget.

## What the person sees

- **Calm view**: a chip per file, under the message like sent images: the name and a summary ("report.pdf · PDF, 48
  pages"), and an info icon with the panel's tooltip (`cursorTipOn`) saying how it went: "Sent to the model in full.",
  "Too large to send whole: the agent reads it as it needs to.", or "Pages 40-48 went as images." Clicking a chip opens
  the file (the platform's file viewer; the web build downloads it).
- **Dev view**: the message exactly as the model received it, every `<file>` block or outline included, and the raw
  view of every later `dereference` and `look` on it, as for any pointer.
- **Exports**: both carry what the model saw (the AGENTS.md rule); the JSON export also carries each file's descriptor.
- **The composer and the start page**: the "＋" takes files as well as images, a dropped or pasted file attaches the
  same way, and a refused file says why next to its chip before anything is sent.

## Trust

A file's text is untrusted input, the same as a web page's: an instruction written inside a PDF gets no authority a
page's text would not get. The person attached it, which is consent to READ it, not to obey it.

Reading an attachment (`dereference`, `look`, a `python_exec` source) is free by the effects algebra
([`EFFECTS.md`](EFFECTS.md)): a read of a value the run already holds spends nothing and reaches nothing, so no policy
line exists for it and none is added.

Slice 3 adds a pointer kind and a `look` target, so it gets the red-team pass (site-access.md, "Adding a tool, a member
or a message"). What a hostile page must not get, as tests that fail first:

- a page cannot read an attached file through a pointer, a named read or `exec`, since a value is claimed per run and
  tab;
- a pointer from one session does not open another session's file;
- a file's name cannot break out of its `<file>` block or its outline line;
- `navigate` landing on a PDF is a pass of its own: what the answered pointer reveals, and that it is judged as the
  fetch it already is (#1129);
- a PDF crafted to be slow or huge (deep nesting, a page of a million glyphs, a 100k-page count) is bounded by time and
  size limits in the offscreen document and fails with a sentence, not a hung run. Built in slice 2b: a page cap, a
  per-page text cap, an operator cap on the measuring walk, a time budget between pages, a byte cap and a wall-clock kill
  of the worker (`docs/dev/pdf.md`, "The bounds"). pdf.js corrects a lying page count by itself, so the 100k-page case is
  tested with a stand-in whose count is trusted.

## Rulings (2026-10-28, from the python/shell/policies coordinator)

1. Python takes an attachment as an injected value (`files:`, and `@file:` in `tables`), never a path; above.
2. Rows over blobs is fine: the key is the only handle, claims and tombstones per row, the budget charges a blob once,
   the hold is the `protect` list, hash before the budget check.
3. `@file:` is this spec's; nothing on the shell side uses it. The argv refusal is the shell call's rule for every
   prefix.
4. Reading an attachment is free (effects algebra); no policy line.
5. Nothing in flight collides. `navigate` on a PDF is a new red-team pass; `pages` joins `PIPE_CMDS` with its own bound
   and adversarial rows.

## Open

- `FILE_INLINE_MAX` is 32,000 characters as a first figure (slice 1); still open: measuring it against the prompt
  budget, and whether it scales with the model's context window.
- The per-command size cap: for text it is `FILE_INLINE_MAX` itself, well under the hub's frame limit; for a PDF's
  bytes, decided 2026-10-29 (chunks, 20 MiB, "Wiring a PDF through the attach path").
- The PDF thresholds: read against labelled real pages in `notebooks/pdf/pdf-thresholds.ipynb` (2026-10-28);
  `MIXED_COVER` is 0.1 and path cover counts from `MIXED_PATH_COVER` 0.3. Open: the floor of the held-back note.
- `png()`'s bound per cell (pages and pixels), and whether a `scanned` page's short clean OCR layer travels with its
  image.
- Math in a PDF's text layer reads lossily (measured on the Adam paper, 2026-10-28): subscripts flatten onto the
  baseline, a stacked super- and subscript splits across lines, an accent lands on the previous token, a glyph with no
  Unicode mapping (ε, ⊙) is dropped, and fraction bars and radical overlines (drawn rules) are lost. Such a page is
  still `text`, so no image goes with it. Leaning answer (Shane, 2026-10-28): no math-density measure; the prompt tells
  the model that a PDF page with math may need its image, looked at directly. Where that sentence goes (the system
  prompt or the attachment's own note) is open, and it lands with slice 3's `look` target.
- Lines per page for a text file, and the per-call page cap of `look`.
- Whether the page-image fallback for a scanned page without a vision model uses the reader model or OCR.
