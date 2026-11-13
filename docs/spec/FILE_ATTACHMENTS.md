# Spec (WIP): attaching files to a message

**Status: slices 1 and 2 built (2026-10-28/29); slice 3 under way: the held rows, the `@file:` pointer, the `pages`
verb, attaching a PDF to an agent run, and every attachment to a worker-built run (any message) and a long paste as
pointers, `ml.dereference` of `@file:` and `look` at a document are built; Python's `files`, the files panel and
upload progress are next (Shane and the calm-chat-motion session); a session's files as a directory `/files/` is ruled,
not built (2026-11-12).** The order is
three slices, each landing on its own: text files, then PDFs, then documents as `@file:` pointers in agent runs. Slice
3's contact points with the python, shell and policies lanes were ruled on by their coordinator (2026-10-28,
"Rulings" below).

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

**Size.** A cap applies to the text the pages produce. A chat sends the pages that fit, in order, and names the rest
("One reader per format, two framings" below); an agent takes a PDF past it as a pointer.

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
`{ name, type, sha256, bytes }`. No hub change: the hub relays sealed bytes and reads none of these fields.

A text file that will not go whole (`sentWhole`, the runtime's own rule) goes ahead the same way (2026-11-07, piece
(b)): its UTF-8 bytes in chunks, the reference carrying its own type. The runtime puts a reference back as a PDF only
for `application/pdf`, and for any other type as text (a `fatal` UTF-8 decode, no NUL); bytes that are not text are
refused naming the file, never taken for a PDF or kept as bytes. `chat.start`, `agent.start` and `session.send` all
send files ahead. An older runtime that takes no chunks gets the files inline, and a text file past what one sealed
message carries is refused on the client, naming the limit, rather than sent to fail at the seal.

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

Built (2026-10-29, `file-frame.ts`, `file-chunks.ts`, `HubConnection.putFile`; how it works: `docs/dev/hub-client.md`):

- The chunk follows the JSON after a zero byte. `file.have` comes first, so an older runtime (`unsupported`) gets the
  PDF inline, and a runtime that holds part of the file is sent the rest. Both need `drive`, the scope of the send.
- The cap is checked before a chunk is sent: with the default 32 MiB burst, `0.6 x` is 19.2 MiB, under the 20.
- A hub `UNAVAILABLE` now reaches the chunk's waiter through the envelope's `ref`, and a runtime going offline settles
  everything waiting on it, since the hub discards what it had queued to it. The composer hears either at once.
- The runtime keeps a finished file by hash for 15 minutes after its last use, so the same file attached again is
  named, not sent. In worker memory: an eviction costs a re-send, never a wrong file.
- A finished file is the ACCOUNT's, not its sender's (accepted 2026-10-29): any device with `drive` that names its
  hash may attach it, and `file.have` tells such a device whether the runtime holds a file it can name, so one that
  guesses a document learns another device sent it within the TTL. Every device holding `drive` is the same person's,
  under one root. An upload in progress stays its sender's, so another device cannot spoil it. A device with `view`
  alone is refused both commands, and one declaring `drive` it does not hold fails to open and goes unanswered.
- Not built: progress in the composer while the chunks go.

**Images go only to a model known to see them: unknown is refused.** (Built.) A worker chat attached images without
asking; it now asks the question an agent run does (`_modelVision`, image-gate.ts: Ollama reports vision or not, or
the person declared the default model in Settings; anything else is UNKNOWN, never "no"). The reader is the OCR model
in Settings when it is set and not known to be blind. When a message would send an image (pasted, or a page that
needs one) and the answer is:

| The model… | The message |
| --- | --- |
| sees, or the person said it does (`vision: true`) | is sent with the images |
| does not see or is UNKNOWN, and a reader model is set | goes with the reader's reading of each image, attributed to the reader |
| does not see, and no reader model is set | goes with each image or page named ("page 3 is a scan this model cannot see; set a reader model in Settings to have it read") |
| is UNKNOWN, and no reader model is set | is refused before sending (`unsupported`), with a sentence: "This model may not see images. If it does, turn on 'This model sees images' and send again." Nothing is dropped and nothing is sent. |

An unknown model with a reader goes to the reader (decided 2026-10-29): no pixels reach a model nobody confirmed, and
"does not see" can be declared only for the default model, so refusing there would leave another cloud model only
the choice of forcing images on it.

The override is `vision: true` on `chat.start`, `agent.start` and `session.send`, the person's declaration, meaning
what `ml.agent({ vision: true })` means: send the images to the run's own model, no probe. `session.send` carries it
for a chat only; an agent run's vision is decided at `agent.start`. The composer offers it as the "This model sees
images" toggle when the model's vision is not reported (sees-images.tsx), on the start page and in a chat's composer;
the refusal is checked again in the runtime. This changes what a worker chat does with a pasted image: a model of
unknown vision used to get it, unread.

**Eight images per turn, the rest named.** `MAX_TURN_IMAGES` stays 8, a hard cap, with no token budget. Images the
person pasted count first, then the pages that need one, in page order. A page past the cap goes to the reader model
when one is set, and otherwise is named in the block with what can get it: "pages 9-48 are scans not sent as images.
This chat cannot show them." Once slice 3's `look` on a page exists, an agent run's note names it as the recovery;
until then the note says there is none, since a recovery named must be callable now.

**Built for worker chats (2026-10-29).** A runtime listing `capabilities.attachPdf` takes `{ name, type, data }` in
`files` on `chat.start` and on `session.send` to a chat, `data` the bytes as base64 (the extension's channel is JSON),
at most `PDF_ATTACH_MAX` (20 MB). What the build decided where the rulings were silent:

- The PDF is read BEFORE the turn (`prepare`, sw-chat.ts), so a PDF that will not open, text files past the text
  cap, and an image refusal all answer the command (`invalid`, `unsupported`) and nothing is sent. Pages are drawn
  and read INSIDE the turn; the person's message appears in the transcript once they are.
- Only a pasted image or a scanned page can refuse a message. A page with a figure keeps its text, so to a model of
  unknown vision with no reader it goes with "(page N has a figure you cannot see)" rather than refusing the PDF.
- `<page n="3" image="2">` says which of the message's images is that page (pasted images are numbered first);
  `<page n="5" read-by="…">` holds the reader's reading in place of a scan's text. A blank page has no section.
- A new bound: the reader reads at most `READER_PAGE_MAX` (32) pages of a message, each a model call the person waits
  for; past it a scan is named like one past the image cap. A page is drawn at scale 2 (144 dpi).
- Not built yet: the bytes in the value store (slice 3 needs them; nothing reads them before it), PDFs to an agent run
  (refused by name). The hub's `file.put` chunks came after (above).

## Slice 3: an attached file as an `@file:` pointer

**The prefix.** `@file:`, its own, beside `@tool:`, `@pt:` and `@box:`: the value came from the person, not from a
tool call, and its ids must never collide with a tool output's. The three reference forms are the pointer rules'
(pointers.md): `@file:"report.pdf"` (the quoted label is the file's name), a minted id with its check character, told
apart by SHAPE and never tried in order. There is no bare form.

**The name, and two files with one name (Shane, 2026-10-30).** The file's own name is the label, because it is what the
person and the model both call it; every form a file travels in already carries `name` (contract-run.ts). A duplicate
name is not handled like a `@tool:` label, where an exact label resolves to the LATEST output silently: two different
`report.pdf` files are usually a draft and its revision, and reading the newer one unasked can answer from the wrong
document.

- The same bytes attached twice are one file: the value store keeps a blob once per SHA-256, so no duplicate exists.
- A different file under a name already in use keeps its real name (never `report (2).pdf`, which would leave the person
  and the model calling one file two things), and its outline says so: `@file:9c2e41a "report.pdf": a second file by
  this name; the first is @file:3fa91c2, attached in turn 2.`
- `@file:"report.pdf"` while two such files exist is REFUSED, never resolved to the latest: the refusal lists each one
  with its id, page count and the turn it came in, as an ambiguous near-match label is refused today (pointers.md). The
  model then reads by id, or asks the person which one they meant.
- The name is untrusted text (a downloaded file can be called `ignore previous instructions.pdf`): it travels only
  inside the quoted label, with quotes escaped, line breaks and control characters stripped and its length capped, and
  the outline's "attached by the person" stays beside it. The real-model run (below) includes a task with two files of
  one name.

**What the model is given up front** is an outline, not the content:

```
@file:3fa91c2 "report.pdf": attached by the person. PDF, 48 pages, 61k tokens of text.
Pages 3, 7, 12 have figures; pages 40-48 are scanned. Read with dereference (pages N-M) or look (doc, pages).
Page 1: …the first page's text, to the preview cap…
```

"Attached by the person" is there so a model does not take the name for a path on disk; `ml.sh` given an `@file:`
pointer as an argument refuses with a sentence saying an attachment is not on the host's disk, so no program can open it
by that name; #1595 (merged 2026-11-12, ab9b4a8a) added a clause naming `ml.sh.put` with the item's own handle as the way to write it there, and #1634 (the prompt review) makes the clause's example path `<folder>/<name>` into a folder that exists, since the host never creates a folder.
That refusal is the shell call's one rule for every pointer prefix in argv, not a manifest's (SHELL.md), and it stays.
The one way to put an attachment on disk is `ml.sh.put(handle, path)`: it writes the attachment's original bytes, not a
PDF's text. A new file in a nested path is judged as an in-root write, a new top-level name asks, and an existing file
always asks. A remote run, and a host without the put capability, are refused. How it is built: `docs/dev/shell.md`,
"Writing an attachment to disk".

**Reading text by page.** The pipe dialect gains one verb, `pages N-M` (`PIPE_CMDS`, text-pipe.ts), which selects whole
pages from a paged value before the other verbs run: `dereference("@file:3fa91c2", { pipe: "pages 3-5 | grep -i
revenue" })`. Both reads take `@file:`: the `dereference` tool, which the run loop answers with text (agent-loop.ts
`derefLocally`, which today resolves only `@tool:`), and `ml.dereference` in code, which returns the typed value. A text
file is one page per N lines (open: N), so the same verb pages a long log. Extending the dialect
requires the adversarial tests in readonly-exec.md ("The rule for extending the dialect"); `pages` gets its own bound
(how many pages one pipe may select) with adversarial rows of its own.

**Built (2026-10-30, the reading side).** file-pointer.ts: the pointer, `cleanFileName`, the outline, the sections and
the `FileShelf` a run's `TokenStore` holds files on; the `pages` verb (`PIPE_PAGES_MAX`, 50 a stage); `derefLocally`'s
`@file:` branch and the inventory's files. The outline says `Read with dereference(@file:…, pipe "pages 1-3")` only:
`look` with a document target was not built then (since 2026-11-12, below). Nothing notes a file on the shelf yet: attaching a PDF to an agent run,
which mints the pointer and stores its rows, is the next change. `ml.dereference` refused `@file:` with a sentence then
(read since 2026-11-12, below).

**Built (2026-11-07, the attaching side).** A PDF attached to an agent run's first message (`agent.start`, the HUD,
the panel) is read once in the offscreen document, its bytes (`bytes`) and read document (`paged`) stored as held rows
of the run's session, and noted on the run's shelf (sw-attach.ts). The task carries the outline in place of the
pages: `<file name="report.pdf" type="application/pdf" bytes="…" pages="48" pointer="@file:3fa91c2">` with the
outline as its body. A PDF that will not read, or that the store cannot keep beside what it holds, refuses the start
with the reason, and what was stored by then is released. The pointers ride `StartRunPayload.files` (stripped from a
page's own payload, honoured only on a worker-built run), so the shelf comes back after a worker eviction. A message
to a run under way was refused a PDF then; "Every attachment to an agent run as a pointer" below lifted that.

**Built (2026-11-12, `ml.dereference`).** Code reads an attached file as the tool does: `await
ml.dereference("@file:3fa91c2", { pipe: "pages 3-5" })` answers the PDF's `<page>` sections (a text file's text), and
the value's `file` says what it is (`name`, `type`, `bytes`, `turn`, and `pages` or `lines`); `tool` is `"attached"`.
It is read in the worker from the run's held rows, by a read-only survey, an approved exec's isolated world, or a
Python cell over the wire; the store key never leaves the worker. An exec in the page's main world is refused it, as a
stored text is not read whole there. The pointer macro stays `@tool:`'s alone. Held back: a `pages` array on the value
(page numbers already travel in the sections, and `pages N` selects one).

**Looking at pages.** `look` takes a document target: `look({ doc: "@file:3fa91c2", pages: "4", question })`. The
pages are rendered from the stored bytes by pdf.js in the offscreen document, then go down the existing vision path
(native when the model sees, delegated to the reader otherwise). Bounded per call like a full-page look (eight
screens): open, a figure of about four pages.

**Built (2026-11-12, `look` at a document).** The run loop resolves `doc` on the run's shelf, reads `pages` with the
`pages` verb's parser (`pageSpans`), and draws them from the stored bytes in the offscreen document at the worker chat's
page scale, one PNG a page, at most `LOOK_DOC_PAGES_MAX` (8) a call; a page that will not draw is named beside those that
did. The native `look` shows them as one image a page, the delegated one asks the reader with all of them. Refused, each
with a sentence: an unknown file, a text file, a page past the file's count, more than eight, `doc` with `selector` or
`scope`, a run with no renderer (a page-built run, whose shelf is empty anyway). The outline names it: `see a page with
look(doc @file:…, pages "N")`, N the first figure or scanned page, else 1. Held back: the math sentence (open, below),
and saying in the outline whether the run has a `look` at all.

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
resolves a name it was given. Specified on the python side in PYTHON_DIALECT.md. REOPENED 2026-11-12 for approved and
`full` cells, which get a mounted `/files/` ("A session's files as a directory", below); the restricted dialect
keeps this.

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

**What composes from these (Shane, 2026-10-29).** Nothing above is built for a particular question, and two choices
keep the general ones answerable: a document's pages keep their NUMBERS through every read (`pages N-M`, `doc.pages[n]`,
the outline's count), and a page's image is reachable from code (`png()`) as well as through `look`. With those, "where
does this PDF talk about X, and show me that page" is a survey the model can write from the API docs: read the pages
one by one, `ml.embed` the query with each page (or each chunk, keeping its page number), rank by cosine, then
`look({ doc, pages })` at the best. It is free only once `ml.embed` is a read-only member of the dialect (planned, with
its own cost: a charge per call and per input character, and a per-survey cap measured from embedding throughput).

## One reader per format, two framings (Shane, 2026-10-29)

A file the person attaches and a body a fetch returns are the same thing underneath: bytes and a type. Each format
gets ONE reader, used by both paths, and the rules above the reader are shared; only the framing differs.

**Shared, per format:**

| Format | The reader | Attach today | `fetch_url` / `ml.fetch` today |
| --- | --- | --- | --- |
| text | a decode of the bytes, the declared charset first, UTF-8 otherwise | UTF-8 only (`decodeTextFile`) | the response's charset |
| tables: csv, tsv, parquet, arrow | `table-data.ts` (the delimiter discovered, parquet and arrow in the worker) | csv and tsv as text; parquet and arrow refused as "not a text file" | parsed into `FetchResult.table` |
| PDF | `pdf-read.ts` in the offscreen worker, `pdf-frame.ts` for the pages a model gets | read page by page (worker chats) | "a PDF document, N bytes" |

Each column is missing what the other has, which is the argument for one layer: an attached parquet should work the
day a fetched one does, and a fetched PDF should read the way an attached one does.

**Shared, above the reader:** the text cap and what happens past it (inline below it; above it a pointer read by page
or range, with an outline and the size stated); the held-back notes ([HELD_BACK.md](HELD_BACK.md)); the vision gate for
page images (image-gate.ts). Today an attached text file past the cap is refused while a fetched one of the same size
becomes a `@tool:` pointer: the person, the more trusted source, gets the worse answer. Slice 3's `@file:` pointer is
that rule for attachments and should reuse the `@tool:` value path, not a parallel store.

**Different, by design:**

- **Provenance and trust.** The model must tell "the person attached this" from "a site served this": `<file>` and
  "attached by the person" against a fetch result's "fetched from <host>". Both are untrusted text; the label is what
  lets a model weigh an instruction found inside it.
- **Lifetime.** A fetch can be repeated, so its value is evicted like any other; an attachment cannot, so it is held for
  the session ("Eviction differs by producer", slice 3).
- **The recovery a held-back note names.** A worker chat has no tools ("This chat cannot show them."); an agent run
  names the call that gets the page.

Where there are no tools (a worker chat), "past the cap" cannot become a pointer. Decided (Shane, 2026-10-29): a PDF
past the cap is no longer refused whole. Its pages go in order while they fit and the rest are named ("pages 12-30
were not sent: past the text a message takes. This chat cannot show them."), and the cap is sized from the model's
context length where the backend reports it, a fixed figure otherwise.

**Reading the pages held back (Shane, 2026-10-30).** An agent run gets no tool for this: it already reads pages from
code, by `dereference` with `pages N-M` or `doc.pages[n]` in `python_exec`, and the held-back note names that call. A
second tool doing the same would be two ways to one thing. A worker chat has no tools, so with slice 3 it gets exactly
one, `read_pages`: read-only, over its own attachments, the same reader underneath, and its held-back note names it.
Giving worker chats the read-only dialect instead would be a far larger surface to red-team for this one job; naming
an agent run instead ("start a run to read them") leaves the model stuck, which is the thing the note is there to
prevent. `read_pages` is a new agent-facing call, so it gets the red-team pass.

Built (2026-10-29, `pdfTextBudget` and `fitPages`):

- The budget is half the context the model is LOADED with (Ollama's `/api/ps`; a worker chat sends no `num_ctx`, so
  that is the context it runs with) at 3.5 characters a token, at least 4,000 characters. A model that is not loaded,
  or a backend that does not say, gets `FILE_INLINE_MAX`.
- Text files count first and are still sent whole or refused, as in slice 1. The PDFs get what is left.
- Pages go in page order across the message's PDFs while their text fits. The first page that does not, and every
  page after it, is `cut`: named after the sections, never drawn, never sent to the reader, and not asked about for
  vision, so a scan past the cut cannot refuse the message. The file keeps its `pages` count.
- Not counted: the history already in the chat, the section tags, and what a reader writes for a page (at most
  `READER_PAGE_MAX` pages). The half share is the margin for them.

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
- **Upload progress**: a file going to a runtime through the hub goes in 4 MiB chunks (`file.put`), and its chip in the
  composer carries a bar from the count of chunks the runtime has accepted. A chunk sent again does not move it back;
  an upload that fails partway says so on the chip, with the reason, and never freezes at a fraction. The bar is gone
  once the file is held. A file small enough for one command shows no bar.

### The files panel (Shane, 2026-10-30)

The files a session holds, in one place, in the CALM view.

- **Where.** A panel on the right of the chat, its own, not the dev view's dock (dock-layout.ts), which is for
  rearranging debugging panels. It has tabs, and Files is the first: a canvas, artifacts or a whiteboard later become
  tabs of this panel, not panels of their own.
- **Getting rid of it.** Closed until opened, from a header button carrying the session's file count. It never opens
  itself: attaching a file moves the count, not the panel. Whether it is open is remembered per device (UI state,
  marked as such in the state registry), and a close button sits in its header.
- **Narrow screens.** On a phone it opens as a full-height sheet, the app's existing sheet look; on a narrow desktop
  window it slides over the chat rather than squeezing it. A calm-view change is a change to `mobile/` too (the one
  design language rule), so the phone gets it in the same work.
- **A row per file**: the name, size and page count; what the model was sent ("pages 1-11 sent, 12-30 held back"); and
  the chip's own actions (open the file). An upload in progress is a row with its bar.
- **What "held" means.** The hub keeps a file's chunks only in transit (15 minutes, an LRU over 60 MiB); a file is
  listed once the session's runtime holds it, and an attached file is then held for the session's life ("Eviction
  differs by producer"). A file the runtime could not keep is never listed as if it were there.
- **Nothing lives only here.** The panel can be closed, so what it shows is also where it happened: the progress on
  the composer's chip, and what was sent or held back on the message's chip. The panel gathers them; it is never the
  only place a fact is shown.
- **Files a run made** are listed, in their own group, since 2026-11-12 ("A session's files as a directory").
- **Not in it, for now**: documents the agent fetched. They are evicted like any value and can be fetched again; the
  panel is the person's own files.

### Tests for the panel and the progress bar

- The progress figure is a pure function of chunks accepted and chunks expected: a unit test runs it through a chunk
  accepted, a chunk sent again, and an upload refused partway, and gives the finished and the one-command cases their
  own assertions.
- One e2e test through a real `wmlhub` (the CI `hub` job's binary; `chat-pairing.spec.mjs` and
  `remote-stream.spec.mjs` already pair the chat page with a runtime through one): the chat page attaches a PDF larger
  than one chunk and sends it. On a local hub the upload ends in a blink, so the test does not wait to SEE the bar: the
  bar records every value it was given, and the test asserts that series rose through each chunk to the whole, that
  the file reached the runtime, and that the bar is gone.
- The panel: closed by default, never opened by an attach, remembered across a reload, a sheet at phone width, and a
  file listed only once held. A gallery entry for it with rows in each state.

### A scripted model that uses the tools (Shane, 2026-10-30)

Unit tests check each part; this checks that a model can get from an attached file to an answer through the tools as
they are actually wired. One e2e spec against `fake-llm.mjs`, its scripted turns calling the tools the way a model
would. The fixture is a PDF built for it: known text on known pages, one figure page, one scanned page. After every
turn the test reads the NEXT request the model received (`fake.calls()`) and asserts what it was given, not only that
the call ran.

1. Attach the PDF to an agent session. The first request carries the outline (`@file:`, the page count, which pages are
   figures or scans), not the text.
2. The `dereference` TOOL on the `@file:` pointer with `pages 3-5 | grep`, answered by the run loop: the next request
   carries the header line and those pages' lines with their page numbers, and a piped read mints its own pointer.
   Then the same read as `ml.dereference` inside `exec`, a read-only survey: it runs with no approval card and hands
   code the typed value. No e2e test has a scripted model call `dereference` today (`test-index.mjs --driven --gaps`).
3. `python_exec` in `readonly` mode with `files: { doc: "@file:…" }`: reads `doc.pages[n].text` and `.kind`, calls
   `png()` on one page and returns its size. The next request carries both. A cell asking `png()` for more pages than
   its bound gets the sentence, and the cell still ends.
4. `look({ doc, pages })`: the pages go down the vision path, counted against the context like any page image.
5. With `ml.embed` in the dialect (#1336): a survey that embeds each page, ranks them against a query and returns the
   best page numbers. `fake-llm.mjs` gains the embedding endpoints with fixed vectors, so the ranking is known.
6. The run in the sidebar and both exports carry what the model saw at each step (the AGENTS.md rule).

Three more runs in the same spec: a worker chat whose PDF is past the cap, where the held-back note names `read_pages`
and a scripted `read_pages` call returns the pages; a run whose scripted calls name an `@file:` its session does not
hold, in `dereference`, `python_exec` and `look`, each refused; and a run with two different files named `report.pdf`,
where the second's outline names the first, `@file:"report.pdf"` is refused listing both, and a read by id answers.

After slice 3 lands, the same tasks go to real models through the bench (Shane, 2026-10-30):
`qwen3.8-flash-next:vision`, `gemma4:31b`, and `qwen3.8-flash-next:latest` (the same weights without a vision encoder,
so a figure or scan task measures the hand-off to the reader against seeing the page). The tasks: a fact on one page of
a long PDF, numbers from a table through `python_exec`, a figure or scanned page through `look`, the `ml.embed` ranking
survey, a worker chat past the cap reading held-back pages with `read_pages`, and two different files named
`report.pdf`. Results in a notebook: correctness, the tools chosen, steps and tokens, and recovery after a refusal.

## A session's files as a directory (ruled 2026-11-12)

RULED 2026-11-12 (Shane, in the coordinator's session; designed with the async lane, conditions from the Pyodide lane's
answer, session-mail `20261112-1630Z-python-packages-to-chat-page-files-mount.md`). This reopens ruling 1 and the
"Python" paragraph above, and PYTHON_DIALECT.md's ruling of 2026-10-28, for the cells that can open a file. Nothing
below is built.

**What it is for.** `python_exec`'s interpreter can die mid-run (an import that traps in wasm fails Pyodide fatally),
and the restart the async lane is building tells the model its namespace is gone. Work computed over many cells
(weights, an intermediate table) dies with it. The model already knows how to keep work: write it to a file. So a
session gets a working directory, the way a coding agent gets a scratchpad: ordinary file operations, kept for the
session, outliving a kernel death. One store holds every file a session has, whoever made it, so there is no hidden
second place: everything a model can keep, the person can see and delete (the files panel, below).

**Layout.**

- `/files/` is writable: the model's working directory, kept for the session.
- `/files/attached/` is read-only and holds what the person attached, each file in a directory named for its handle. A
  file attached mid-run appears there and the model is told its name. The person's files never change; a model that
  wants to edit one copies it out.
- Every attachment lives at `attached/<handle>/<name>` (`attached/3fa91c2/report.pdf`), always, not only once a
  second file shares its name: a path a cell has seen never moves, so a second `report.pdf` arriving between two
  cells breaks neither the first cell's path nor one written into a script (a test row). There is one layout to
  learn, and `attached/report.pdf` never exists, so a bare path never picks between two files, as
  `@file:"report.pdf"` never does. The short name is what the loader fallback and the failure hint take. The loader
  creates each `<handle>/` from JS before the write operations are sealed, so a cell cannot make one.
- Provenance follows from the folder: a file under `attached/` is the person's; any other was made by a run.

**Which cells see it.** Cells that can open a file, an approved cell and `full` mode, see it as a directory; the
restricted dialect reads it only through the loader redirect. The read-only (restricted) dialect has no `open()` or `os`
(PYTHON_DIALECT.md), and its writes roll back when a cell fails, so it keeps what it has today: an attachment as an
injected value (`files:`, `@file:` in `tables`) and the loader redirect (`docs/dev/python-sandbox.md`, "Loader
interception"), which also resolves a name in `/files/`, read-only. The redirect is re-ruled with the mount (the Pyodide
lane's read of this spec):

- Builtin `open` is never patched, today or with the mount; only the three loader patches (`Image.open`,
  `pd.read_csv`, `pd.read_html`) gain an `attached/` fallback. `os.open`, `io.FileIO` and `pathlib` would go around a
  patched `open`, so it would be partial magic. A plain `open("x.csv")` that misses fails as real Python does, and
  the existing failure hint names `/files/attached/<handle>/x.csv` when that file exists.
- A path that exists is that file: the loader patches redirect a name (`'current'`, a selector, the URL a table was
  loaded from, an attachment's name) only when no such file exists. So a cell that writes `/files/current` changes
  what `read_csv('current')` returns; that is accepted, not refused, and has its own test row.
- The cell's directory is `/files/`, and each cell starts there: a worker-hosted run keeps its interpreter across
  cells, so an `os.chdir` in one cell would otherwise change how the next resolves a bare name.
- Two attachments with one name resolve to neither: the fallback refuses, and the hint lists both `@file:` handles,
  as `@file:"name"` does ("The name, and two files with one name", above).

**The mount** (the Pyodide lane's conditions, measured in Node against `pyodide-core/`, not in a browser worker):

1. MEMFS, loaded from the shelf when the interpreter starts as an eager listing whose nodes are zero-copy views of the
   transferred buffers (`node.contents = new Uint8Array(buffer)`): start-up costs one times the directory's size, held
   as ArrayBuffers, with no wasm growth (measured: a 50 MB file added nothing beyond its buffer). Loading a file's bytes
   on its first open was measured too and works on every read path, but saves nothing, since the bytes are already in
   the worker by then; if it is ever built, `O_TRUNC` truncates before the open hook runs, so `open('w')` needs a
   `setattr` wrapper or it restores the old bytes. A truly lazy mount, nothing held until a file is opened, needs a
   synchronous channel (`FS.createLazyFile` uses synchronous XHR; WORKERFS over posted Blobs is unmeasured, needs
   `FileReaderSync`, which the lockdown does not allow, and fails a write with EIO, not EROFS); it is not proposed. A
   cell still raises the cost: reading a whole file grows wasm memory by its size, `mmap` copies into the heap, and a
   copy out of `attached/` is a new node, so item 6's three times bounds the worst case. Emscripten's JS-side
   `FS.trackingDelegate` (`onCloseFile`, `onWriteToFile`) sees every close, raw `os.open`/`os.write`/`os.close`
   included. No Atomics-backed FS: Pyodide ships no synchronous remote backend, `Atomics.wait` would block the interrupt
   buffer so Stop would fall through to the kill, and it would save almost nothing on a terminate. The hooks live on the
   Module/FS object, which the lockdown seals from cells (`PYODIDE_JS_SEAL`); they stay synchronous.
2. `/files/attached/` is its own mount whose write operations fail with EROFS (open for writing, chmod, unlink,
   create, mkdir, utime; rename across it is EXDEV, rmdir of it EBUSY). File modes do not hold: a cell's own
   `os.chmod` undoes `0444` (measured). The shelf refuses a write to a person's file too, whatever path asks.
3. On each close of a writable file the bytes are posted, transferred, through the worker's closure-held `post` to the
   offscreen document, which owns the shelf write and acknowledges each post. At cell end the harness, never the
   epilogue a cell can rebind, flushes what is still open as a safety net: it scans `gc.get_objects()` by EXACT type
   (`BufferedWriter`, `BufferedRandom`, a `TextIOWrapper` over a real `FileIO`, and `mmap.mmap`; never `isinstance`,
   which would run a cell's own subclass's `flush()` inside the runner), skips the standard streams, flushes each, and
   posts it, resolving an `os.fdopen` file's path from its fd. Measured, it found a file held in a global, a closure,
   a list, an attribute, an unreferenced cycle and a suspended generator, at 7 to 99 ms by what is imported (349 ms
   with a million objects held); an audit hook on `open` limits the scan to cells that opened a file. A flush over the
   quota raises ENOSPC and the bytes stay buffered: each flush is wrapped, and the cell's result names the file and
   the error. The flush cannot rescue gzip, zip or sqlite (each writes its last structure on close or commit), so the
   model is still told: close your files.
   The offscreen re-checks every post itself: the path canonical and under `/files/`, never under `attached/`, a regular
   file, and the quota. A `full` cell keeps `js.postMessage` and can forge a post, so nothing the post claims is taken
   on its word.
4. One `/files/` per session. The `full` worker is shared across runs, so the directory is the session's, never the
   worker's: one directory per session in it, not a reload per cell, which would cost about three times the
   directory's size on every cell (item 6).
5. Regular files only, canonicalised (`FS.getPath`): a symlink a cell makes is never persisted, so a link pointing out
   is never saved.
6. The quota counts about three times a file's size: a 50 MB file cost 154 MB of ArrayBuffers and grew wasm memory to
   75 MB, which never shrinks (measured), and the worker dies at a 2.6 GB JS heap (`docs/dev/python-sandbox.md`).

**A kernel death.** The restart terminates the worker (the existing kill path). What was posted is safe; files still
open are lost, and nothing is salvaged from the dead interpreter's heap, which may be corrupt. The restart reloads
`/files/` from the shelf into the fresh MEMFS and tells the model which module failed, and what survived (as a cell
result, or an inbox item for a detached cell): `variables gone; /files/ kept
(12 files); w.npy was open and is lost.` The restart's message and its delivery are the async lane's (ASYNC_CALLS.md).

**Mutable, frozen when cited.** A file in `/files/` changes freely; there are no versions per write. A file is frozen
into an immutable version, an `@file:` the transcript can name, only when it leaves the directory or enters the
record: `dereference`, `look`, `ml.sh.put`, the transcript and the exports. The log stays truthful the way a coding
agent's does: it records what was read, never the file's current bytes. Two runs of one session writing the same file:
the last close wins. Two live runs of one session in different workers (an approved run's and the shared `full`
worker) see each other's files as they are kept: each acknowledged post is pushed to the session's other live
workers, so a read is never of a copy older than the shelf's.

**Provenance is a field, and every sentence reads it.** A file pointer carries who made it: the person, run R's cell N,
or a read from disk at a path (below). Every model-facing sentence that today says "attached by the person" (the
`<file>` block, the outline, `look`'s page label, `ml.sh.put`'s card, which today says the attachment's original bytes)
reads the field. A file a run made is never described to the model as the person's: that wording carries authority a
model-made or page-derived file must not borrow. Its text is untrusted input like any other ("Trust", below).

**Lifetime and quota.** A session's files last as long as the session, until the person deletes them, the same as an
attachment today. Nothing is evicted silently. When the session's files made by its runs are over the quota, a post is
refused by name and the cell's result says so: `w.npy was not kept: the session holds 1.4 GB of files made by its runs;
delete some in the files panel.` A flush over the quota raises ENOSPC for that file
when it is made, and the cell's result names it (item 3).

**The host's disk.** `/files/` is the browser sandbox's, never the `ml.sh` workspace's, and the two never alias: an argv
item `/files/x` is a host path, as today. Bytes cross only as `@file:` handles: `ml.sh.put` writes one out (ruling 3),
and a read brings a workspace file in, into `/files/` with provenance "read from disk <path>" (the async
lane's). The model's text says it in one line: `/files/ is the browser sandbox's, not the workspace's.` A proposal
of 2026-11-13 reopens this for directories the person mounts ("Host directories in the sandbox", next).

### Host directories in the sandbox, and a cell's edits as diffs (proposed 2026-11-13)

PROPOSED 2026-11-13 (Shane, in the calm-chat-motion session); not ruled, waiting on the measurement below and e3's
pass. Nothing is built. It reopens "the two never alias" above for a directory the person mounts, and item 1's "No
Atomics-backed FS" for those mounts only.

**What it is for.** Models edit files by writing a Python script that calls `open()`, not only through an edit tool.
That should work the same on the browser sandbox's `/files/` and on the host's disk, with one syntax, and the person
should be able to see, skippably, what each cell changed.

**One filesystem, plain paths.** A cell sees `/files/` and the mounted host directories in one tree and uses ordinary
`open()`, `os` and `pathlib` on both. A prefix inside `open()` (`open("@file:/files/x")`) was considered and dropped:
most file access (`pandas.read_csv`, `numpy.load`, `sqlite3`, `zipfile`, `shutil`) reaches the filesystem below
`builtins.open`, so a prefix works only if the filesystem resolves it, which makes it a mount under an odd name; and
an `@file:` is a frozen version ("Mutable, frozen when cited"), which a live path is not. `@file:` stays the handle a
tool takes and the transcript cites; a path is what `open()` takes.

**A host directory keeps its real path.** A directory the person approves (the `ml.sh` workspace, say) is mounted at
the absolute path it has on the host, resolved with the host's realpath so a symlink is not a second name:
`/Users/sb/git/window-ml/README.md` is that path in the cell, in `ml.sh` and in the transcript. Renaming it to a
mount point (`/workspace/`) was considered and dropped: the person knows their own paths, and a renamed one makes a
run harder to review.

**Collisions.** The sandbox owns `/files/` and Pyodide's own tree (`/tmp`, `/lib`, `/home/pyodide`, `/dev`, `/proc`).
A mount at or under one of these is refused by name when it is approved, never shadowed:
`/files is this sandbox's directory; the host's /files cannot be mounted at that path.` So is a mount above one (the
host's `/`, or `/home`, which would shadow `/home/pyodide`):
`/home holds this sandbox's /home/pyodide; mount a directory inside it instead.` On macOS `/tmp` resolves to
`/private/tmp`, so a workspace there does not collide.

**A path outside every mount** fails with `PermissionError`, never `FileNotFoundError`, since the file may exist:
`/Users/sb/other is not mounted in this sandbox; reach it through ml.sh, or ask the person to mount it.`

**`/files/` in an `ml.sh` argv** (chosen by Shane, 2026-11-13). An argv item under `/files/` is refused, unless that
path exists on the host: `/files/ is this sandbox's; pass the file with ml.sh.put.` On a host that has a `/files`
directory the person accepts the alias: there `/files/x` is the host's file in `ml.sh` and the sandbox's in a cell.

**The channel.** Pyodide has no synchronous remote backend, so a host-backed node needs one. Two routes, neither
measured:

- A: a sliced wait, no rebuild. The node posts a request (worker, offscreen, service worker, host) and waits on
  `Atomics.wait` in slices of about 50 ms, checking the interrupt flag between slices and raising `KeyboardInterrupt`
  when Stop is set. The worker already holds a shared interrupt buffer (`py.setInterruptBuffer`,
  `src/python/python-worker.ts`). Item 1's objection, that `Atomics.wait` blocks the interrupt buffer, is to an
  unsliced wait; that a sliced one keeps Stop working is inferred.
- B: JSPI-suspending file syscalls, a rebuild (`docs/dev/pyodide-build.md`): Emscripten's file syscall imports become
  suspending, so a read awaits a promise and the worker's event loop stays free. Only if A's Stop or latency is bad.

Either way a file is fetched whole on open and pushed on close, the close hooks item 1 already has, with the listing
cached per cell: a change the host makes during a cell is seen at the next open. A host that is not connected fails
the open with EIO. Every request carries an id, and a reply to a request whose wait was interrupted (Stop, a timeout)
is discarded by that id. A push never leaves a half-written file on the person's disk: the host writes beside the file
and renames it into place, so a Stop or a dropped connection mid-transfer leaves the old file whole.

**Security** (each mount is a new surface the model reaches: e3's pass, Shane's ruling). The approval is per mount,
not per call, so a mounted directory is read and written with no card per `open()`. The host enforces the scope
itself: a `full` cell can forge a worker post (item 3), so the path a request claims is resolved and checked on the
host, never taken from the worker. The host opens a path by walking its components from the mount's own descriptor
(`openat` with `O_NOFOLLOW` on each component, or the platform's equivalent), never by resolving a string and then
opening it, so nothing can swap a component between the check and the open. A page-started run never has a mount.

- What may be mounted. The approval checks the RESOLVED path, so `~/x/..` or a symlink does not pass as a leaf. A
  mount at or above the person's home is refused by name, as is one at, under or above the browser profile
  (`chrome.storage.sync` holds the API key and the model filter), the archive folder or window-ml-host's config:
  `/Users/sb is your home directory; mount a directory inside it instead.`
- The directory replaced after approval. The host holds the mount's descriptor from approval and compares its device
  and inode on every request, so a mounted directory replaced by a symlink to `/` is refused, not followed.
- Unmounted or disconnected during a cell. The next read fails; the cached listing and any copy in MEMFS are not
  served, and a close does not push.
- Bounded sizes. An open and the before copy are bounded by a size cap (its value waits for the measurement below): a
  file over it fails the open with `EFBIG` and a sentence naming `ml.sh`, so the worker's memory is never the limit
  that is hit.
- Stop between an open and its close. The host gets the file whole or not at all (the rename above), and the cell's
  diff line says the write did not land: `a.py was not written: the cell was stopped.`
- Hard links. A write through a descriptor whose `fstat` shows `st_nlink > 1` is refused, since it would change a file
  outside the mount too. Reading one stays allowed, by choice: such a file is the mount's file by every check the
  host can make (path, device and inode are all inside), so the person who mounts a directory mounts what is linked
  into it. Multi-linked files could be refused outright; they are kept readable instead, since `cp -al` and backup
  tools make them.

Rows for e3, beside the list below, each with a pass condition above: a request for a path outside every mount, by
`..` or a symlink inside the mount pointing out; a forged post; a component swapped for a symlink between the check
and the open; a mount at, under or above a reserved prefix, at or above the home, or at, under or above the profile,
the archive folder or the host's config, by its resolved path; the mounted directory replaced after approval; a read
or a close after an unmount or a disconnect; a file over the size cap; a Stop between an open and its close; a write
through a hard link; a page or a page-started run reaching a mount.

**A cell's edits as diffs.** Per cell, not per write: a script may write a file several times, so the diff is the file
at cell start against the file at cell end.

- `/files/`: the shelf keeps a file's bytes from before the cell until the cell ends, instead of replacing them on the
  first close. That copy is not a version and cannot be cited; it is dropped once the diff is made. This amends "there
  are no versions per write" for the length of a cell only.
- A host mount: the before bytes are what the open fetched, so the diff costs nothing extra. Writes made by an `ml.sh`
  process are not seen this way; a snapshot of the workspace before the call is the host's question (an overlay
  filesystem's upper layer in a container, a copy-on-write clone on macOS, `git diff` for tracked files; guesses).
- The model gets one line in the cell's result, never the diff:
  `edited a.py (+3 −1); wrote out.csv (new, 2.1 KB); deleted old.log`.
- The person gets a collapsed `edited 2 files` row on the step that opens to the diff, in the sidebar and both
  exports. A binary file, or one over a size cap, shows its size and hash before and after, no diff.

**To measure first** (the Pyodide lane, through the coordinator): route A's Stop latency during a blocked read, the
cost of one round trip, an `os.walk` and an `import` over a mounted real workspace, opening a file of several GB
(a workspace holds them, and a whole-file fetch needs a size cap set from this), and whether the sliced wait holds
under the lockdown.

**Initial decisions** (Shane, 2026-11-13: decided now, changed if they cause trouble).

- The cell's directory. With a workspace mounted, each cell starts in the workspace's real path, so a relative path
  means the same file in a cell as in `ml.sh`; with none, in `/files/`, as ruled above. Every cell still starts there
  afresh. So a bare `open("notes.txt", "w")` writes to the person's disk when a read-write workspace is mounted, as a
  coding agent's would; `/files/` is reached by its absolute path.
- Approving a mount. Only the person mounts, per session, until they remove it. The model can ask through an approval
  card naming the real path, with two choices, "read and write" and "read only", neither preselected; it never mounts
  one itself. A page-started run never has a mount. A read-only mount fails a write with EROFS.
- Seeing what is mounted. The files panel has a group "From this computer", one row per mount with its mode and a
  remove action, and the run's banner a chip per mount. The model is told the mounts and their modes in one line.
- The diff's cap. A text file of up to 1 MB on both sides gets a diff, shown to 400 changed lines with "show all"
  beyond; a larger or binary file gets its size and hash before and after. The shelf keeps a before copy only of
  files under the cap, which also bounds what it holds during a cell. The row is collapsed and has no setting to turn
  it off.
- Paths in an export. A real host path carries the person's username (`/Users/sb/...`), and the exports are shared.
  Both exports write the home directory as `~` (`~/git/window-ml/README.md`) by default, and say so in their header
  (`the home directory is written as ~`), since an export carries what the model saw (`docs/dev/export.md`) and a
  silent change would break that. The export can be made with the real paths instead; the run log, which is not
  shared, keeps them. The rule is checked where `VOLATILE_FIELDS` is.

**Open.**

- Whether a mounted file's real path is kept from what the model reads (an e3 row the coordinator did not adopt). By
  design it is not: the model is given the real path because that is what `open()` takes. For Shane.
- The size cap's value, set from the measurement above.

**Owners.** This text, the diff row and the provenance of a file read from a mount: the chat-page lane. The channel and
the mount: the Pyodide lane. The host's scope check, the argv refusal and the `ml.sh` snapshot: the host lane, as
stated in "What window-ml-host must do" below.

### `/files` on the person's disk, when a host is connected (proposed 2026-11-13)

PROPOSED 2026-11-13, from Shane's rulings in the coordinator's session (what `ml.sh` is for, the setup, per-platform
mounts, the size limits, removing the disk, which copy is primary) and the files API (Shane's). Not ruled;
nothing is built. Where it disagrees with "Host directories in the sandbox" above, this wins: the argv refusal on
`/files/` goes away, and the `ml.sh` snapshot question is answered by git.

**Use cases** (Shane's, collected as they come; the design follows them, not the other way round):

1. The typical setup. The person makes a git repository and puts the model in it. What they upload in the UI lands in
   a folder inside that repository: scratch, "your UI-uploaded trash", not a curated shelf.
2. Editing an attached file. The model copies the person's read-only file to a working copy and edits it, with `cp`
   and `sed -i` through `ml.sh` or with `open()` in a cell, whichever it reaches for.
3. Working anywhere on the disk, the way a coding agent does, with restrictions on what can happen (below). `ml.sh` is
   for giving the model the person's disk, not a separate file-moving system beside it.
4. Moving a file out of the uploads folder into the project: an ordinary `mv`, or a panel action.
5. No host connected: the model works in the virtual `/files/` of "A session's files as a directory", as ruled.
6. Clearing space without the person: the model lists its files, finds the oldest, and deletes them in code.

**The proposal: primary follows the host.** One `/files`, two copies, and which one is primary depends on whether a
host is mounted (Shane):

- With a host mounted, a folder in the workspace, `<workspace>/window-ml-files/`, is primary, with the same layout
  (`attached/<handle>/<name>` read-only, the rest writable). A cell's `open()` and `ml.sh` see one set of bytes, so a
  cell's write is there for the next `cp` with no sync between them. `cp`, `sed -i` and `open()` reach the uploads at
  a real path (`/Users/sb/git/proj/window-ml-files/attached/3fa91c2/data.csv`), with no `ml.sh.put` or read-back to
  teach the model; those stay as mechanisms, not as advice. Finder is the truth for the person; the panel is a view of
  the folder.
- The browser store (MEMFS over the shelf, as ruled above) is then a capped backup, synced when convenient. A file over
  the quota lives on disk and is not backed up; the panel shows it with its size.
- With no host present, or when the host dies, the browser copy is the working store and the model works there, as
  today. The changes made meanwhile sync forward into the folder when the host returns.
- The sync covers that folder only, never the rest of the workspace. Authority: for `/files`, the folder while a host
  is mounted and the browser copy while none is; for everything else in the workspace, the disk, which holds its only
  copy.
- While a host is mounted the folder's real path is the name the model is given, and a cell has no `/files` alias, so
  no one cell sees a file under two paths. Across time it does: a cell run offline names `/files/x` and a mounted one
  names `/Users/sb/git/proj/window-ml-files/x`, and the transcript keeps each as the cell used it. A bare `/files/x`
  in a cell or an argv then fails with
  `/files is on disk while the host is connected: /Users/sb/git/proj/window-ml-files/x`.
- The folder is ignored by git by default, through `.git/info/exclude` (the clone's own list, never a committed
  `.gitignore`), so uploads never show in `git status` or a commit unless the person moves them out. The person can
  name another folder, inside a mount.
- How the folder is mounted is per platform, whatever works there (Shane): on macOS and Linux it is an ordinary folder
  under the workspace; Windows is open (the path rule, above).

**The sync.**

- Disk to browser, while mounted: the host watches the folder (FSEvents on macOS, inotify on Linux) and the backup
  takes each changed regular file under the quota, in the background, and every `ml.sh` call's end flushes what it
  changed. A symlink or a non-regular file is never taken. The backup may be out of date between syncs; that is
  accepted (Shane).
- Browser to disk, when the host returns: what changed in the browser copy while it was the working store is written
  into the folder, beside each file and renamed into place.
- A conflict, the same file changed on both sides between syncs, keeps both: the disk's under its name, the browser's as
  a renamed copy (`report (browser copy).md`), and the panel says so; a live run is told through its inbox. A delete on
  one side against an edit on the other keeps the edit.
- A change to `attached/` on disk (a process can `chmod` and write, and the person can edit in Finder) never replaces
  the frozen original: the browser copy keeps the person's original at `attached/<handle>/<name>`, the frozen version a
  transcript cites ("Mutable, frozen when cited", above), and nothing on disk is reverted, since the disk is primary.
  The panel says `data.csv was changed on disk; the original is kept in the browser copy`.
- A cited file stays frozen in the browser copy whatever happens on disk (Shane, 2026-11-13): an edit, a move or a
  delete there changes what the next read sees, never what a transcript cites.
- A file over the quota is never in the backup, so without the host the model's `/files` lists it as unavailable and
  opening it fails with `data.parquet is on disk only (3.2 GB, over this session's quota): connect the host to read it.`

**Provenance.** The browser keeps the record (path, hash, made by the person, run R's cell N, or an `ml.sh` call),
since a disk listing cannot say who made a file; a file the record does not know reads as "made on disk".

**The host unavailable or dead.** The files on the disk stay there, and the browser copy becomes the working store:
the model's `/files` keeps working on what was backed up. The panel shows the folder as disconnected, with its real
path, never as empty or gone. Uploads and writes made meanwhile sync forward when the host returns (above). The
transcript keeps the real paths a run used, so a later read without the host says where they were. A cell running when
the host goes gets "Unmounted or disconnected during a cell" (above): the next read through the mount fails.

**Sessions and mounts** (decided, Shane, 2026-11-13):

- Several sessions mounting one repository share one folder; each session's browser copy stays its own.
- Archiving or deleting a session never deletes anything on disk.
- With several mounts, one is the session's primary workspace, chosen at the first approval: cells start there and
  the uploads folder lives there.

**Three limits, kept apart:**

| Limit | Applies to | Set by |
| --- | --- | --- |
| The quota | the browser copy only: the working store with no host, the backup with one; a file over it lives on disk, not backed up | a DevTools Settings flag ("Lifetime and quota", above) |
| The disk's free space | the folder while a host is mounted, and the rest of every mount: no cap of ours | the disk |
| The fetch cap | one `open()` pulling one file into Pyodide, on either backing (`EFBIG`, "Bounded sizes" above) | the worker's memory, from the measurement |

**What runs free and what asks.** The scope is the mount list; a read-only mount refuses every write.

- Free: reads anywhere in the mounts, except a file that looks like a secret (below); writes and deletes in a read-write
  mount that git can undo (a tracked file with no uncommitted change); anything in the uploads folder the runs made;
  `git status`, `git diff`, `git add`; and a commit on the current branch after the session's first. The first commit
  in a session asks, since it writes into history under the person's identity; every commit the model makes carries
  a trailer naming the run (`Window-ML-Run: <run id>`), as the repository's own commits carry an agent trailer.
- Asks, unless a policy allows it (`docs/spec/POLICIES.md`): a delete or overwrite git cannot undo (an untracked or
  ignored file, or a tracked one with uncommitted changes); deleting the person's own uploads (`attached/`); anything
  that leaves the mounts; network access; git operations that rewrite history or reach a remote.
- Secrets: a cell's `open()` through a mount goes through the same check as an `ml.sh` path argument (`SHELL.md`, "The
  free tier narrows to the roots"), so the defaults and the person's policies are one list: a file that looks like a
  secret asks by default wherever it is, and a workspace policy overrides that either way.
- How it is enforced: a cell's writes and deletes go through the host's per-request check (above), so each is judged
  as it is made. An `ml.sh` process is judged before it starts, by its manifest's `effects` (`docs/spec/SHELL.md`),
  since the host cannot stop a running process mid-write; its writes are then shown in its diff. That bounds only a
  program whose effects on the mounts follow from its argv (`mv`, `rm`, a `cp` or `sed -i` on named paths once they
  have manifests). A program that runs code from an argument or a file (`bash -c`, `python script.py`, `node`, `make`),
  or whose manifest says `runs-code` or `unknown`, or that has no manifest, is in the asks category whatever its argv.

**Diffs from git.** The workspace is a git repository by default, so a cell's diff and an `ml.sh` call's diff come from
git, answering "the `ml.sh` snapshot" above. Before the call the host records the working tree as a tree object through
a scratch index (`GIT_INDEX_FILE=<scratch> git add -A && git write-tree`, forcing in the uploads folder), which touches
neither the person's index, HEAD nor stash list; after it, the same again, and the diff is the two trees'. Untracked
files are included. Ignored files outside the uploads folder are not: force-adding them would copy an `.env` or a key
into the repository's object store and hash every build output. A delete or overwrite of an ignored file asks (above),
and that card, kept in the transcript, is the only record of it. A workspace that is not a git repository falls back
to #1780's before copies for cells, and gets no diff for an `ml.sh` call (open).

**The files API.** The model lists, ages and clears its own files in code (use case 6), with the same names in JS and
Python:

- `ml.files.list()` returns one row per file: path, size, who made it, created, modified, last read, and whether a
  transcript cites it. It is a read, so the read-only dialect may call it. On a disk backing Python's `os.scandir`
  already answers everything but who made it.
- `ml.files.remove(paths)` deletes, judged as above: the runs' files go free, the person's ask unless a policy allows
  it. Deleting a file the transcript cites keeps its frozen version, so the record never loses what the model read.
- The quota refusal ("Lifetime and quota") names the way out: `... delete some with ml.files.remove, or in the files
  panel.` The Python binding's form is the Pyodide lane's to choose.

**Dropped alternatives.**

- The browser store as primary with the folder a mirror: `ml.sh` would see a cell's write only after a sync, a race
  the model hits on its next `cp`; it needs an "on disk only" state for every file over the quota while mounted; and
  it buys only the local read path, which is #1780's measurement anyway.
- The disk as the only copy once a host connects, with the browser copy cleared: `/files` would stop working when the
  host is unavailable or dies, and the uploads are what the model is there to work on.
- A host-side copy of `/files` mapped into a container at `/files`: a second mirror, and it needs a container.
- A `/files` alias inside the cell while a host is connected: one file under two paths in the transcript and the diffs.
- The folder in a fixed place in the home directory: it needs a mount of its own, and it is not where the person looks
  at their work.

**Red-team rows** (e3, through the coordinator): the sync reads and writes nothing outside the folder;
`.git/info/exclude` is the only other file the host writes on its own; a symlink or non-regular file in the folder is
never taken into the backup; a file over the quota is not backed up, by size or by growing after it was listed; a change
to `attached/` on disk never replaces the frozen original; a conflict keeps both copies; the git snapshot leaves the
person's index, HEAD and stash list unchanged; a delete git cannot undo asks, by every route (`os.remove`,
`ml.files.remove`, an `ml.sh` `rm` judged by its manifest); an `ml.sh` program that runs code (`bash -c`, a manifest
saying `runs-code` or `unknown`, no manifest) asks whatever its argv; the first commit in a session asks; a cell's
`open()` of a file that looks like a secret asks, as an `ml.sh` read of it does; a page or a page-started run reaches
neither the folder nor `ml.files`.

**Open.**

- The folder's name (`window-ml-files/` is a proposal) and whether the person sets it per workspace.
- Windows: how a `C:\Users\...` path appears in the sandbox's POSIX tree.
- A workspace that is not a git repository: whether `ml.sh` calls get a diff by another snapshot.
- The background sync's cadence (a value to pick).
- Deferred (Shane): the model reading `.env` to pass a secret on to an API call. Until it is taken up, the person writes
  scripts that read `.env` and policies that let the model run them, and the values are assumed not to leak into the
  model's text. The frame for later is three layers: the read gate (`SHELL.md`, exists) decides whether a secret-looking
  file may be opened; a handle keeps the value out of the model's context when it is
  ([`SECRET_HANDLES.md`](SECRET_HANDLES.md), the host putting the value into the child's environment or a bound request
  header, with `SHELL.md`'s "a text pipe over a held value" beside it); and the scrub (`sw-scrub.ts`, exists for the
  server URL and the API key) catches reflections as a backstop that lowers the rate and does not close the hole.

**Owners.** This text, the panel's view of both copies, the sync's rules, provenance and the files API's JS side: the
chat-page lane. The mount, the fallback and the Python binding: the Pyodide lane. The host's folder, the git snapshot
and the per-request judging, the folder watch: the host lane, as stated in "What window-ml-host must do" below.

### What window-ml-host must do for mounts, `/files` and `ml.sh` diffs (ruled 2026-11-13)

RULED 2026-11-13 (Shane: "fine for now", to be changed where building shows one wrong). Nothing is built. The
coordinator's ruling (Shane, 2026-11-13): with this ruled, one host lane opens, in its own window-ml-host clone, and
takes the scope check (H1 to H8) first, then the argv refusal (H9), then the snapshot (H10 to H15). It states
as requirements on the host what the two sections above leave to "the `ml.sh` and window-ml-host owner", and settles
three places where they and `SHELL.md` disagree (named where each is settled, and listed under "Ruled with it" at
the end).

**One judge.** The host enforces the scope and the hard refusals, which no policy can lift, and resolves the facts. The
worker judges free or asks with the built-in default policy and the person's policies over those facts, as it already
does for an `ml.sh` call (`SHELL.md`, "Policies": a policy is a function over the facts the host resolved). A cell's
file request and an `ml.sh` call are judged by one mechanism over one list of facts. The mounts are the host's
configured roots (`configure`), one list, not a second one beside it.

**The scope check** (what a cell's `open()` through a mount reaches; "Host directories in the sandbox", "Security").

- H1. New host calls, each on a mount the host already holds: `mount`, `unmount`, `list`, `fetch` (read a file whole),
  `store` (write a file whole), `remove` and `rename`. Every path in a request is relative to a mount and resolved on
  the host; a path the worker resolved is never trusted, since a `full` cell can forge a worker post.
- H2. `mount` refuses, by the resolved path and with the sentences above: a path at, under or above a reserved prefix
  (`/files`, `/tmp`, `/lib`, `/home/pyodide`, `/dev`, `/proc`); the home directory or above; a path at, under or above
  the browser profile, the archive folder or the host's own config. The refusal is the host's, so the worker's copy of
  the list is a convenience, not the check.
- H3. The host holds each mount's directory descriptor from `mount` and compares its device and inode on every request;
  a mismatch refuses the request and reports the mount as replaced.
- H4. A path is opened by walking its components from that descriptor with no symlink followed. `fsx::open_beneath`
  does this today (`openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` on Linux, a per-component `O_NOFOLLOW` walk
  elsewhere), but read-only and from a path; it is extended to start from the held descriptor and to open for writing.
  A symlink component anywhere in the path is refused this round, including one that points inside the mount (open,
  below).
- H5. `store` writes beside the file and renames into place, so a Stop or a dropped connection leaves the old file
  whole. A write through a descriptor whose `fstat` shows `st_nlink > 1` is refused; a read of one is allowed. A write
  to a read-only mount fails with `EROFS`; a `fetch` over the fetch cap fails with `EFBIG` and carries the size.
- H6. In the uploads folder, a `store` into `attached/`, and a `rename` into or out of it, are refused by the host
  whatever a policy says; a `remove` there is judged (it asks by default, the person's uploads). This is a hard
  refusal because `attached/` is the person's frozen originals and no policy the model can ask for should make it
  writable.

**The facts a request carries back** (H7), so the worker can judge it: `inMount`, the mount's `mode`, `secret` (the
host's `SECRET_PATTERNS`, the list an `ml.sh` path argument meets), `exists`, `ignored` (by git, `git check-ignore`
under the git belt), `inUploads`, `inAttached`, `gitUndoable`, and a `basis` of `{ dev, ino, size, mtimeNs }` for an
existing file. `gitUndoable` is true for a tracked file with no uncommitted change, false otherwise, and null when
`repoConfigRunsCode` is true or null, since asking git would run the repository's config.

- H8. Compare and swap. A `store`, `remove` or `rename` that the worker judged on a fact carries the `basis` it was
  judged on, and the host refuses it with `ChangedSinceJudged` when the file's basis differs at the moment of the
  write. Without it, a file judged free as git-undoable could be edited between the judgment and the write and
  then lost.

**The `/files` argv refusal** (H9). Settles the first disagreement: "Host directories in the sandbox" refuses a
`/files/` argv item unless the host has that path, and "`/files` on the person's disk" says the refusal "goes away"
yet gives a sentence for it. Both are kept, as one rule:

- A pointer token of any prefix stays refused on the extension side, before the call reaches the host (`sh-call`), as
  now.
- At `spawn` the host refuses any argv item that equals `/files`, starts with `/files/`, or carries such a path after
  its first `=` (`--out=/files/x`), with the sentence of "`/files` on the person's disk", naming the folder's real
  path: `/files is on disk while the host is connected: /Users/sb/git/proj/window-ml-files/x`.
- The alias exception of the first section is kept for a host that has a `/files` directory of its own, where the
  argv item is the host's file. That is the only case the sentence does not apply.
- Named cost: a search for the text `/files/` (`rg '/files/' .`) is refused too, since the host cannot tell a pattern
  from a path; the model writes the pattern another way (`rg '[/]files/'`).

**The `ml.sh` snapshot** (H10 to H14). Settles the second disagreement: "Diffs from git" takes the snapshot with
`git add -A` into a scratch index, which writes a blob for every changed file into the repository's object store, and
its own red-team row says `.git/info/exclude` is the only other file the host writes. The snapshot below writes
nothing into the repository.

- H10. Before and after each `ml.sh` call in a git workspace, the host builds a tree with a scratch `GIT_INDEX_FILE`
  (a copy of the person's index, for its stat cache) and a private `GIT_OBJECT_DIRECTORY`, both in the host's own
  directory, with the repository's object directory as an alternate (`GIT_ALTERNATE_OBJECT_DIRECTORIES`). The person's
  index, HEAD, stash list and object store are unchanged; the private directory is deleted when the diff is made.
- H11. Changed files are hashed with `git hash-object -w --no-filters --stdin-paths` and entered with
  `git update-index --index-info`, never `git add` or `update-index --add`, which run a clean filter. Every git spawn
  carries the git belt (`core.fsmonitor=false`, `core.pager=cat`, `GIT_OPTIONAL_LOCKS=0`), so no filter, textconv,
  fsmonitor or hook runs. Untracked files are included; ignored files are not, except the uploads folder.
- H12. Bounds: no file over the diff cap (1 MB, "The diff's cap") goes into the tree; it is compared by size and
  sha256 instead. The walk stops at `WALK_CAP` (20 000) entries; past that the call's diff is null with the reason.
- H13. The diff is `git diff-tree --no-ext-diff --no-textconv` of the two trees. Its body goes out as held output (a
  pointer, as stdout does), and `done` carries the summary line (`edited a.py (+3 −1); deleted old.log`). A change is
  reported as "changed during this call", never attributed to the call's process, since another process may have
  written meanwhile. An orphaned call's snapshot reports through `status`/`ended`, as `protectedChanged` does. A
  workspace that is not a git repository gets a null diff (open, as in the section above).
- H14. The diff's file list is what the call's end flushes to the browser backup ("The sync").

**Telling an old host apart** (H15). `hello` gains `mounts: true` and `snapshot: true`. Their absence means an older
host: the worker treats mounts and diffs as unavailable, never probes by calling.

**What runs free, what asks, what is refused.** The default policy's rows, each with the fact that backs it. "Refused"
is the host's and no policy changes it; "asks" is the default, which a policy may change either way.

| Operation | Default | Backing fact |
| --- | --- | --- |
| read in a mount | free | `inMount` |
| read of a file that looks like a secret | asks | `secret` |
| any write to a read-only mount | refused (`EROFS`) | `mode` |
| write or delete of a file git can undo | free | `gitUndoable` true |
| write or delete of a file git cannot undo (untracked, ignored, uncommitted changes) | asks | `gitUndoable` false |
| the same when git cannot be asked | asks | `gitUndoable` null |
| a new file | free | `exists` false |
| anything in the uploads folder outside `attached/` | free | `inUploads` |
| delete in `attached/` | asks | `inAttached` |
| write into, or rename in or out of, `attached/` | refused | `inAttached` |
| a path outside every mount, through a symlink, or after the mount was replaced | refused | H3, H4 |
| a write through a hard link | refused | `fstat` `st_nlink` |
| a write whose basis changed since it was judged | refused (`ChangedSinceJudged`) | `basis` |
| a `/files` argv item | refused | H9 |
| `git status`, `git diff`, `git add` | free | the manifest, `repoConfigRunsCode` false |
| the first commit in a session | asks | extension side |
| later commits on the current branch | free | extension side |

The `Window-ML-Run:` commit trailer and the first-commit-in-session state are the extension's, not the host's.

Settles the third disagreement: `SHELL.md`'s "the sandbox widens the free tier" makes a sandboxed write inside the
roots free, and "`/files` on the person's disk" makes a delete git cannot undo ask. The proposal: both hold, because
they bound different things. The sandbox bounds WHERE a write lands; `gitUndoable` bounds whether it can be taken
back. So under the sandbox a write that creates a file, or touches one git can undo, is free, and an overwrite or
delete of one git cannot undo asks, for a cell and for an `ml.sh` call whose manifest names the path.

**Red-team rows** (e3, through the coordinator; each with its pass condition above): a forged request for a path
outside the mount, by `..`, an absolute path or a symlink component (H1, H4); a mount at, under or above each refused
path, by its resolved path (H2); the mounted directory replaced by a symlink after `mount` (H3); a component swapped
for a symlink between two requests (H4); a write through a hard link (H5); a `store` interrupted mid-transfer leaving
the old file whole (H5); a `store` into `attached/`, a `rename` into or out of it, under every policy (H6); a
git-undoable file edited by another process between the judgment and the write (H8); a `/files` argv item in each
form, `=` and bare (H9); the snapshot leaving the person's index, HEAD, stash list and object store byte-identical,
with a clean filter, an fsmonitor and a hook configured in the repository that would each leave a mark if run (H10,
H11); an ignored `.env` never entering a snapshot tree (H11); a page or a page-started run reaching any of the new
calls.

**Open.**

- A symlink inside a mount that points inside it (a repository's `node_modules/.bin`): refused this round by H4; whether
  to follow one whose target resolves inside the same mount is a later question.
- The git queries per request (`check-ignore`, the undoability check) cost a spawn each; whether the host batches them
  per cell or caches them by `basis` is the lane's to measure.

**Ruled with it** (Shane, 2026-11-13): the three settlements, the argv refusal kept as one rule (H9), the snapshot
writing nothing into the repository (H10), and the sandbox and `gitUndoable` both holding (the paragraph under the
table).

**Owners.** This text: the chat-page lane, until the host lane opens. H1 to H15: the host lane, one lane in its own
window-ml-host clone, scope check (H1 to H8) first. The worker's judging of the facts and the table's default policy:
the `ml.sh` extension side (`docs/dev/shell.md`).

**The person deletes or moves a file.** The files panel can delete, rename and move files in the writable part. During
a live run the model is told the file's name through the run's inbox, the same as any other notice; a move is a delete
plus a new name. The delete or move is also applied to every live worker holding that session's `/files/` (the
offscreen sends the unlink or rename): a mounted cell's MEMFS would otherwise keep the stale copy, `open()` would
succeed on it, and its next close would bring the deleted file back to the shelf. Uploading straight into the
writable part waits: the model copies from `attached/`.

**The files panel and a storage page.** The files panel (above) becomes the browser for this directory: a row per file
with its name, size, who made it (the person, run R cell N, read from disk), when it was created and last modified, its
frozen versions, and which runs read it. Two groups, the person's files and the run's. Actions: open, download, delete,
rename and move (writable part only), and put to disk. A storage page across sessions shows the total, the use per
session and the quota, sorts by size and age, and deletes in bulk. Deleting a file deletes its versions.

**Owners.** This spec, the shelf, the provenance field and its sentences, the panel and the storage page: the chat-page
lane (calm-chat-motion). The mount, the hooks and the redirect: the Pyodide lane. The restart message, the inbox notice
and the read-back from disk: the async lane.

**Red-team pass** (written by e3 through the coordinator, never by a building lane), what a cell or a page must not get:

- a write to `attached/` by any route: chmod, rename in or out, a symlink, raw `os.open`, a hard link;
- a forged post from a `full` cell persisting a path outside `/files/`, into `attached/`, past the quota, or into
  another session's directory;
- a symlink or a non-regular file persisted;
- one session's `/files/` seen by another session's cell in the shared `full` worker;
- a cell reaching the hook closure or `post` (a lifted-bridge or introspection route; not measured);
- a page-started run, or a page, reading `/files/` or any file in it;
- a model-made file described to the model as attached by the person, in every sentence that names a file.

**Not measured.** A terminate racing the last post (the ack is there for it); a lifted-bridge route to the FS object;
anything in a real browser worker rather than Node; WORKERFS over posted Blobs (item 1); the audit hook under the
lockdown (item 3). Measured since the spec merged (session-mail
`20261112-1712Z-python-packages-to-chat-page-files-lazy-and-flush.md`): the zero-copy listing (item 1) and the flush at
cell end (item 3).

**Backups.** A backup never carries the value store today (`ml-values` is marked `never`, "fetched tables a run
holds; refetchable", `src/backup/backup-inventory.ts`). That holds for fetched tables, not for a person's attachment
or a session's files, neither of which can be fetched again. RULED 2026-11-12 (Shane, in the calm-chat-motion
session): a backup carries the person's attachments, so a restored session has its files. It carries the files a
session's runs made too, and the backup screen shows how much space each kind takes; the run-made files can be left
out with one tick, the person's attachments cannot. The session archive carries both with the session it archives.
Fetched values stay out.

**Open.**

- The quota's value and where it is set: a DevTools Settings flag, by the standing rule for a new setting. The whole
  directory loads at start (item 1), so the quota is also a start-time budget: the value sits under the worker's
  2.6 GB heap with room for item 6's worst case.
- A post arriving for a path the person deleted or renamed during the run. The lean: it is kept under the written name
  as a new file, and the inbox notice says so, since the delete removed the old bytes, not the model's work.
- Whether a frozen version's provenance "read from disk <path>" may reach a page through `dereference`, or is scrubbed
  like an error's text (`sw-scrub.ts`).
- Whether the restricted dialect gets a write of its own (a `keep()` call) is open and not proposed.

## Trust

A file's text is untrusted input, the same as a web page's: an instruction written inside a PDF gets no authority a
page's text would not get. The person attached it, which is consent to READ it, not to obey it.

Reading an attachment (`dereference`, `look`, a `python_exec` source) is free by the effects algebra
([`EFFECTS.md`](EFFECTS.md)): a read of a value the run already holds spends nothing and reaches nothing, so no policy
line exists for it and none is added.

SLICE 3 OPEN 2026-11-12: #1623 at 948e9426 (the Chat Page lane; ml.dereference reads an attached @file: in the worker; two commits, nine files, `@api` `@agent` `@security`; verified). Code reviewer janitor-3 by the overflow rule. The lane wrote no red-team rows; e3 writes them against the branch as a test-only PR that lands after #1623 merges (new surface, rule 10 as amended), reviewer janitor-3, from the lane's five surfaces: the file's text or doc key through any page-started type, forged run id, named read or MAIN-world pre-read, in every reference form; one run reading another run's or session's file, including after a worker eviction; a hostile file name breaking the page sections, forging a page or leaking into the description line; the budget on unpiped and piped reads so a loop over a large PDF stops; the wire's TooLarge naming the pointer and never the key. CLEARED 2026-11-12: janitor-3 named 948e9426 (comment 6816920230; 52/52 dereference, 59/59 with the neighbouring pointer suites, dist, doc and jsdoc checks clean; verified); the lane armed. #1623 MERGED 2026-11-12 as 26dd7e44 (run 43168756243 green; verified); e3's rows go on main. E3 STARTED 2026-11-12: branch redteam/deref-file off main, tests/redteam-deref-file.test.mjs, a test-only PR with janitor-3 as reviewer. OPEN 2026-11-12 as #1648 at eb19aef5 (test-only, `@security` `@agent`, two files, no src/; verified): five rows with a positive control each in tests/redteam-deref-file.test.mjs and a `files` option on tests/ml-wire-harness.mjs so a run is built with an attachment. A: an approved exec in the page's main world gets the refusal for an `@file:` read, never its text, value, meta or the held key, while the same run's dereference tool reads it. B: another run, or one whose shelf never held the id, reads nothing. C: a page's own text cannot close its `<page>` section or open a forged one, and an attached name is one line with no control character. D: an unpiped read is charged the stored blob, a piped one what each stage reads. E: past WIRE_VALUE_CAP the answer is the `@file:` token with the file's name, never the bytes or the key. Each guard mutated alone reds only its own row (the preReadsFor refusal, the holders check in readStoredText, escapeSectionText, the unpiped charge, the wire's token prefix); clean tree 5 of 5. Recorded fact, not a defect: a non-holder's refusal is the store's "the stored value v<16 hex> is not in the store", which names the held row's key; every read re-checks holders, so the key alone reads nothing. No genre line: the redteam genre is a glob since #1636. e3 found no other shape in #1623 it could not pin as a row. Reviewer janitor-3 after host#39 (assigned); e3 arms on a comment naming eb19aef5. RED 2026-11-12: test (node 26) on run 43198219126 failed in suites the diff does not touch (python-lockdown with the stock-Pyodide live-bridge signature, attach-pdf, three exec-shared-world rows, isolated, sh-delete-manifests, sidebar-live-call), main's own job green at the same time; e3 judged the job bad, not the diff, and reran it (pending; verified). Green keeps eb19aef5 as the head; a second red of the same shape means a rebase onto main and a new head before janitor-3 reads it. The red set is in flaky-ci's backlog as a runner-side candidate. RERUN GREEN 2026-11-12: run 43198219126 completed success on every non-skipped job, test (node 26) included, on the same head eb19aef5 with no push in between, verified. The red was the runner's environment, not the suite; flaky-ci holds the row with janitor-3's reading of the sidebar-live-call row (typedOut gives up after 200 ms, an empty string counts as no change, so a starved first reveal tick fails it; 11/11 locally on five runs). Janitor-3's anchor eb19aef5 is unchanged and it posts on the measured diff (five rows, five mutations each red at its named assertion, harness consumers 43/43); e3 arms only on its naming comment. MERGED 2026-11-12 as 0a0eb5ce from eb19aef5 (verified): janitor-3's comment 6823558535 names eb19aef5 with nothing outstanding, re-measures the five mutations itself (each red at the named assertion, the main-world row printing both the @file: value and the meta pointer, the wire row printing the forced @tool: token), reports 5/5 and 43/43 after a build, check-dist-fresh clean, the file placed in the redteam genre, and the sidebar-live-call red as the starved typedOut (11/11 on five plain runs, three under eight busy loops, eight concurrent copies). The mutation table is measured twice, by e3 and by janitor-3, with the same five reds. The red-team pass for the attachment pointer surface is on main; e3's next file is tests/redteam-python-lease.test.mjs after #1642 merges. Two shapes janitor-3 found without a row on the branch, for e3's pass: preReadsFor's MAIN-world refusal of a @file: read (sw-run-host.ts, around line 163) and a page that never held the rows; the branch's charge and another-run rows pass against main's module too, so e3's rows pin what those do not.

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

1. Python takes an attachment as an injected value (`files:`, and `@file:` in `tables`), never a path; above. REOPENED
   2026-11-12 (Shane, in the coordinator's session) for the cells that can open a file: "A session's files as a directory".
2. Rows over blobs is fine: the key is the only handle, claims and tombstones per row, the budget charges a blob once,
   the hold is the `protect` list, hash before the budget check.
3. `@file:` is this spec's. The argv refusal is the shell call's rule for every prefix, and it stays: a handle in argv is
   a held value, not a path. AMENDED 2026-11-08 (Shane confirmed): one explicit shell member uses a handle, `ml.sh.put(handle, path)`,
   which writes the attachment's ORIGINAL bytes (the value store's blob, found by the run's own row; another session's handle is
   `ValueMissing`) to the host's disk and returns the path written relative to its root. It is judged as an in-root write today, no
   new tier; an existing file ALWAYS asks (never a policy allow); the parent must exist and resolve inside a root through the tilde
   realpath path; a symlink target or a parent that leaves the roots through a link is refused; protected names and secret-looking
   targets are refused outright with no tier that can allow them; the whole-file cap is the host's, advertised in hello; it never
   detaches; a run whose `origin.remote` is set is refused with one sentence (the file would land on a machine the person is not at),
   and the host refuses the hub transport too. Page-started runs never reach `ml.sh`, so nothing here is reachable from a page; one row
   asserts it. The host half is the fourth slice of SHELL.md's resolve path (`put`/`write`/`commit`). BUILT in #1553; the paragraph above
   and the UPGRADE row (`tests/ml-sh-redteam.test.mjs`, "UPGRADE: a PDF attached before ml.sh.put") came after.
4. Reading an attachment is free (effects algebra); no policy line.
5. Nothing in flight collides. `navigate` on a PDF is a new red-team pass; `pages` joins `PIPE_CMDS` with its own bound
   and adversarial rows.

## Every attachment to an agent run as a pointer, and a long paste (ruled 2026-11-07)

The chat-page lane's piece (b), Shane's direction of 2026-11-07 ("allow mid-run files in general in all UI
surfaces"; "all the files a user uploads should be @file: pointers"; a pasted wall of text reachable without re-emitting
it"), relayed by the lane and CONFIRMED by Shane in the coordinator's session the same day.
Its design note is session-mail `20261107-1116Z-calm-chat-motion-to-repl-specs-every-attachment-a-pointer.md`; the
rulings, in `20261107-1140Z-repl-specs-to-calm-chat-motion-every-attachment-a-pointer-rulings.md`, are these.

- **What changes.** Every file attached to an AGENT run, on its first message or any later one, is noted on the run's
  shelf as `@file:` with its rows held for the session: text (inline while it fits `FILE_INLINE_MAX`, the outline and
  pointer past that in place of today's refusal) and PDF (its outline, as #1413). The `<file>` block carries
  `pointer="@file:…"`. The "agent-turn" refusal (#1413's "an agent run takes a PDF only when it starts") goes: a later
  file is attached with the message's turn and its pointers appended to the run's `files` so rehydration keeps them.
  Plain `ml.chat` is unchanged, no pointers.
- **Boundary (ruled yes).** Pointers are created only by worker code at two entry points, `startUserRun` and
  `userRunAction` (both applying the `files` check); `USER_START_RUN` and `USER_RUN_ACTION` are sent only by the shell
  and are not in `HANDLE_MAP`; `START_RUN`'s `files` is stripped (#1413's row), `RESUME_RUN` reads no files field,
  `INJECT_MESSAGE` is text only. A run a PAGE built keeps today's behaviour (text inline through the page; a PDF, an
  over-cap text or a long paste gets no pointer; a PDF refused with its reason), and the shell never forwards a PDF's
  bytes to a page: the worker-first fallback to the page carries text files only. CONDITION, from the
  enumerate-not-sample rule: the lane's inferred claim that every DevTools and side-panel send converges on
  `userRunAction` becomes a test before the PR opens, enumerating `HANDLE_MAP`'s page-started types and asserting none
  reaches either entry point with a `files` field, and that the DevTools and side-panel paths land on `userRunAction`.
  A builder's regression row, not a red-team row.
- **A long paste (ruled: 4,000 characters).** A person's typed message of 4,000 characters or more still goes to the
  model whole; it ALSO gets `@file:"pasted text"` (numbered per session: "pasted text 2"), named in one line after the
  message with its line count and how to read it. The figure is the SAME exported constant as `fetch_url`'s preview
  cut (POINTER_VALUES slice 9), imported, never a second copy, so the model has one rule for "too long to re-type";
  the label follows the `@tool:"label"` ambiguity rule already ruled for `@file:`.
- **Order (ruled).** Text and PDF pointers now, mid-run, in one PR; IMAGES WAIT for whichever lands first of Python's
  `files` param or a `look` with a document target, a pointer nobody can read past its header being noise on the
  shelf. OPEN with that trigger.
- **The red team (ruled).** e3's pass runs against #1413 as merged, now, in its own file: the `START_RUN` strip and
  the PDF outline as model-facing text. (b) gets a SECOND pass after it merges: `userRunAction` as an entry point, the
  paste's naming line, and the no-PDF-bytes-to-a-page rule. A surface on main is not held for one not yet built.
- **The PR.** One, from #1413's branch after #1413 merges, rebased so the diff is (b) alone; `@agent @chat-page @ui
  @security @docs`; the first janitor reviews; armed with `--await-review`; this spec's built paragraph and
  `SESSION_CONTRACT.md`'s `session.send` row rewritten in it (a mid-run PDF accepted on a worker-built run, refused on a
  page-built one). The lane acked all four rulings the same hour and is on (a) meanwhile.

**Built (2026-11-07, piece (b)).** Every file sent to an agent run the WORKER built, with its first message or any
later one, is held for the run's session and noted on its shelf (sw-attach.ts `attachFiles`): a PDF as before, a text
file as a `text` row. `FileTarget` is `chat`, `agent` (such a run) or `page-run` (a run a page built). On `agent`,
text files go whole in attach order while they fit `FILE_INLINE_MAX` (`sentWhole`, the one rule the check and the
framing read), with `pointer="@file:…"` on the block; the rest go as their outline (`textOutline`: the pointer, the
name, "Text, N lines, about T tokens", `Read with dereference(@file:…, pipe "head -n 100"); grep -n finds a line.`,
and the opening, escaped) under a block with `lines` and `pointer`. Held text and PDF bytes share the
`PDF_ATTACH_MAX` budget per message (`tooLargeHeld`). A later message's files carry its turn: `StartRunPayload.sends`
counts the person's messages (absent on an older payload, read as 1), and `userRunAction` appends the new pointers to
the live turn's payload and the stored one, so the next turn and a worker restart put them back. A steer carries the
framed text too. A typed message of `FETCH_PREVIEW_CHARS` (4,000, imported from ml-tool-factories.ts) or more still
goes whole and is also held as `@file:"pasted text"` ("pasted text 2", …, the first name the shelf does not hold),
named in one line after the message; the display keeps what was typed, and a paste the store cannot keep is sent
without its pointer. A run a PAGE built is unchanged: text whole through the page, and a PDF or over-cap text refused
with the reason before the page hears of it (`pdfToPageRun`); no route hands a page a PDF's bytes (the worker
refuses a PDF for a run it does not hold, the session commands' page fallback and DevTools' `ML_SESSION_REMOTE`
forward text files only). The message, its text files included, goes to a page only on the tab and site that built
the session (`pageRouteFor`, src/sw/page-route.ts, from a builder record the browser's stamp writes at the start): on
another approved site the relay would reach a page that did not build the run, so the worker takes the run over and
holds the files as this message's pointers (e3's second pass, 2026-11-08; #1520's by-name refusal was the first step).
A message sent from another tab than the run's is refused (`PAGE_GONE`), files and text alike (flaky-ci's review). A
session with no recorded builder never reaches a page: the worker takes it over when it holds the run on that tab, and
otherwise it is refused (`PAGE_GONE`). Only a top frame can build a run (`grantableOrigin`), so the recorded origin
is the top frame's and the comparison is exact; the composers (sidebar, DevTools) take files for an agent session. The
`dereference` tool reads a text pointer as its text through the pipe ("Text, N lines" in the header); the inventory,
the shelf's refusals and the `run.files` state row say lines for text and pages for a PDF. Images wait, as ruled.

## Open

- `FILE_INLINE_MAX` is 32,000 characters as a first figure (slice 1); still open: measuring it against the prompt
  budget. A PDF's page budget scales with the loaded context (built 2026-10-29); text files do not yet.
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
- Whether embeddings of an attached document are kept with it, keyed by the blob's SHA-256, so a second question does
  not embed every page again.
- Where a worker chat keeps its attachments so `read_pages` can reach them after the message is sent: the value store,
  as an agent run's `@file:` rows are, or the session store. The files panel lists from the same place.
