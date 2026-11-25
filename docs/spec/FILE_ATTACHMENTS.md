# Spec (WIP): attaching files to a message

**Status: slices 1 and 2 built (2026-10-28/29); slice 3 under way: the held rows, the `@file:` pointer, the `pages`
verb, attaching a PDF to an agent run, and every attachment to a worker-built run (any message) and a long paste as
pointers, `ml.dereference` of `@file:`, `look` at a document and upload progress are built; Python's `files` and the
files panel are next (Shane and the calm-chat-motion session). A session's files as a directory, `/files/`, is
ruled and PARTLY BUILT (2026-11-22): the ranged reader's read side (#2048), its wiring in the offscreen document and its
scrub (#2058), Python's mount in a worker-hosted run (#2026), `ml.fs`'s read members (#2083), and the write side
under `agent/` with its quota, `filesQuotaMB`: Python's writes land ("Writes", #2121). NEXT (ruling 119, Shane,
2026-11-24): `ml.fs`'s write members (session-store), then the folder on the person's disk (ruling 91, files-host).
DEFERRED: `cp("@tool:…")` (ruling 119), the turn-start line naming a file not written and a sweep of files no
session holds (the coordinator, 2026-11-23, "Writes", "Deferred"). Not built: the file browser.** The
current design of `/files` is in "`/files`: the layout, `ml.fs`, Python's mounts and the backup" and "`/files/` read
by range, and `ml.fs`"; the older sections below it name what they lost, and to which ruling. The order is
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
- Progress while the chunks go (built 2026-11-17): a send's `progress` option (`SendOptions`, session-host.ts) hears
  each file's share of chunks the runtime has accepted (`uploadFraction`, file-frame.ts), once after `file.have` and
  once per accepted chunk, so the bar never runs ahead of the runtime's word. A file the runtime holds whole reports
  nothing; one it holds part of starts at that share. The start page draws the bar under the file's own chip, which
  stays in the box while it starts; the session composer, which empties on send, draws the uploading files as their
  own strip (`UploadStrip`) until the send has its answer. A host that sends files inline reports nothing.

**Images go only to a model known to see them: unknown is refused.** (Built.) A worker chat attached images without
asking; it now asks the question an agent run does (`_modelVision`, image-gate.ts: Ollama reports vision or not, or
the person declared the default model in Settings; anything else is UNKNOWN, never "no"). The reader is the OCR model
in Settings when it is set and not known to be blind. When a message would send an image (pasted, or a page that
needs one) and the answer is:

| The model… | The message |
| --- | --- |
| sees, or is claimed to (`vision: true`: the person said yes, or the model's vision is not reported and the person has not said no) | is sent with the images |
| does not see, or is UNKNOWN and the person said no, and a reader model is set | goes with the reader's reading of each image, attributed to the reader |
| does not see, and no reader model is set | goes with each image or page named ("page 3 is a scan this model cannot see; set a reader model in Settings to have it read") |
| is UNKNOWN and the person said no, and no reader model is set | is refused before sending (`unsupported`), with a sentence: "This model may not see images. If it does, turn on 'This model sees images' and send again." Nothing is dropped and nothing is sent. |

An unknown model the person said does not see goes to the reader (decided 2026-10-29). Since 2026-11-15 (Shane's ruling) an
unknown model nobody said no to is sent the images (the override below). "Does not see" can be declared only for the
default model, so refusing there would leave another cloud model only the choice of forcing images on it.

The override is `vision: true` on `chat.start`, `agent.start` and `session.send`, meaning what `ml.agent({ vision:
true })` means: send the images to the run's own model, no probe. Amended 2026-11-15 (Shane's ruling): it is claimed when the
person said yes, or when the model's vision is not reported and the person has not said no (an unreported model is
assumed to see, and the eye toggle remembers the person's choice per model); a LOCAL model reported without image
input is never claimed, and a cloud model's vision counts as not reported whatever its kinds list says
(`visionUnreported`, sees-images.tsx). Before, `vision: true` was only ever the person's word (2026-10-29). `session.send` carries it
for a chat only; an agent run's vision is decided at `agent.start`. The composer offers it as the "This model sees
images" toggle when the model's vision is not reported (sees-images.tsx), on the start page and in a chat's composer;
the refusal is checked again in the runtime. This changes what a worker chat does with a pasted image: a model of
unknown vision used to get it, unread.

**Eight images per turn, the rest named.** `MAX_TURN_IMAGES` stays 8, a hard cap, with no token budget. Images the
person pasted count first, then the pages that need one, in page order. A page past the cap goes to the reader model
when one is set, and otherwise is named in the block with what can get it: "pages 9-48 are scans not sent as images.
This chat cannot show them." Once slice 3's `look` on a page exists, an agent run's note names it as the recovery;
until then the note says there is none, since a recovery named must be callable now. A worker chat's note says "Read
them with read_pages." on a turn that offers the tool (below, "`read_pages`, as built").

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
resolves a name it was given. Specified on the python side in PYTHON_DIALECT.md. REOPENED 2026-11-12 for cells that
can open a file, which get a mounted `/files/` ("A session's files as a directory", below); the restricted dialect
keeps this. AMENDED 2026-11-17: `files` becomes paths under `/files/`, read by range, for every cell, the restricted
dialect included through the loader redirect ("`/files/` read by range, and `ml.fs`", "Slice 3's `files` in Python").
AS BUILT 2026-11-22: the mount is in a worker-hosted run's own worker only (#2026), where a cell outside the dialect
opens `/files/attached/<handle>/<name>`; the `files` argument is not built (`python_exec` has none on main).

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
- **The recovery a held-back note names.** A worker chat has one tool, `read_pages`, and names it on a turn that
  offers it ("Read them with read_pages."), otherwise "This chat cannot show them."; an agent run names the call that
  gets the page.

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

**Where a worker chat keeps its PDFs (ruled 2026-11-17; built, the tool since 2026-11-24).** In the value store, held for the
chat's session through `storeHeld`, as an agent run's attached files are: two rows per PDF, its bytes (`bytes`) and
its read document (`paged`). One store, so the files panel lists from it. A PDF is held once its message is
answered; a failed turn holds nothing, since its message is not kept either. A text file is not held: it is sent
whole or refused, so no page of it is held back.

- The chat's record (`ml_session_<hash>`, `StoredSession.files`) lists each PDF by name, page count, how many pages
  from the first the message sent, and its two row keys. It holds keys and counts only, never bytes or page text, so a
  record does not grow with its attachments. A record written before this has no list and resumes with none held.
- A store that will not keep a PDF (`ValueTooLarge`, or no store) never fails the turn, which has already been
  answered: the PDF is listed with no rows. `read_pages` on a PDF with no rows, or whose rows were released, answers
  in a plain sentence that it is no longer held, never an error that ends the turn.
- Deleting the chat releases its rows. So does its session leaving the live store on its own (moved to the archive,
  or dropped for retention or the budget), and an ephemeral chat leaving the worker's memory, since nothing can read
  its files again.
- A worker eviction ends an ephemeral chat with none of those, and a held row is never evicted for idleness or the
  budget while it names a session. So the value sweep's first pass at every worker start (`releaseOrphanedHeld`)
  releases each held row's session that nothing can end any more: not a chat in memory, a session the store saved, a
  run the worker holds or restored, or an open tab's page (`liveHeldSessions`). It waits for the store and the runs to
  load, asks at each release so a chat started meanwhile keeps its rows, and releases nothing when there is no store.
- Backup and the archive carry the record, so they carry the list, never the rows: a chat brought back from either,
  on this browser or another, lists its PDFs as no longer held. The bytes are the person's own file, which they can
  attach again.
- The tool is offered only when the model's capabilities say it takes tools (`MODEL_CAPS` `tools: true`). Unknown and
  no keep "This chat cannot show them.", because a backend refuses a whole request that lists tools to a model without
  them. Named cost: a model that takes tools but does not say so never gets `read_pages`.

**`read_pages`, as built (2026-11-24, `src/tools/read-pages-tool.ts`, `toolLoop` in sw-chat.ts).**

- Offered on a turn only while the chat holds a PDF with a page no message sent (a PDF listed with no rows does not
  count) and the model's capabilities say `tools`. The PDFs it reads are the chat's held ones, read back from their
  `paged` row for the chat's own session (`readHeld`, the one function the session store's ranged reader replaces),
  and this message's, from the document the message was framed from. Both are as the model read them, scrubbed.
- Arguments `{ file, pages }`: `file` is the name the `<file>` block gives; two PDFs with one name are `name#1` and
  `name#2`, in the order sent, and the bare name is refused listing both. `pages` is the `pages` verb's grammar, at
  most 50 pages a call.
- The answer is a `<file name pages>` block of `<page n>` sections, text only, escaped as a message's are. A page
  with a figure says the figure is not returned; a scan with no text says it has none. Pages past one call's text
  (`pdfTextBudget`, as a message's) are named, to read in another call; a first page alone past it comes cut where the
  budget ends and says so, since named it could never be read. Named cost: no call returns the rest of that page. Every refusal (no such file, no such page, a
  bad page list, no longer held) is a sentence the model reads, never an error that ends the turn.
- At most 4 calls a turn. The 4th result says it was the last; a 5th call in the same reply is answered "Not read",
  and the next model call is made with no tools, so the turn ends in an answer. A cancel ends the loop.
- Each result goes through the scrub an agent run's tool results go through (`forModel` and the line naming what was
  taken) before the model reads it, and the same text is the step's `result`, so the transcript and both exports show
  what the model read.
- Each call is an `agent-step` in the chat's session with `turn` (SESSION_CONTRACT.md, "Session events"), drawn
  between the turn's message and its answer, and written raw under the turn in the Markdown export.
- Only the question and the answer stay in the chat's history; a later turn that needs a page reads it again. Named
  cost: a later turn does not see what an earlier one read.
- Not built: a re-read of a scan or figure page as an image (the vision path for a re-read); the answer names it as
  not returned.

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
"Python" paragraph above, and PYTHON_DIALECT.md's ruling of 2026-10-28, for the cells that can open a file.
AMENDED 2026-11-22: three parts of this section were replaced and are kept below as one dated line each: its layout
(by ruling 36, "The layout"), its mount (by "`/files/` read by range, and `ml.fs`", built for Python in #2026) and
its quota multiplier. What is built is in the status line at the top.

**What it is for.** `python_exec`'s interpreter can die mid-run (an import that traps in wasm fails Pyodide fatally),
and the restart the async lane is building tells the model its namespace is gone. Work computed over many cells
(weights, an intermediate table) dies with it. The model already knows how to keep work: write it to a file. So a
session gets a working directory, the way a coding agent gets a scratchpad: ordinary file operations, kept for the
session, outliving a kernel death. One store holds every file a session has, whoever made it, so there is no hidden
second place: everything a model can keep, the person can see and delete (the files panel, below).

**Layout.**

- `/files/agent/` is the model's writable working directory, kept for the session, and the root takes no new entry
  ("The layout", ruling 36, the home of this rule). SUPERSEDED 2026-11-18: this bullet said `/files/` itself was
  writable.
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

**Which cells see it.** The cells of a worker-hosted run's own worker, and no other worker's (AS BUILT, #2026: a
page's, the bench's, `library` and an install's candidate get no mount; the coordinator's call after ruling 86, "the
reader's premise"). A cell outside the dialect opens it as a directory; the
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
- The cell's directory is `/files/agent/`, and each cell starts there: a worker-hosted run keeps its interpreter
  across cells, so an `os.chdir` in one cell would otherwise change how the next resolves a bare name. AMENDED
  2026-11-19 (the coordinator's layout call after ruling 86): this said `/files/`. BUILT (#2026): the mount enters the
  reader's `home` at every cell's remount. With a workspace mounted, the workspace's real path instead ("Initial
  decisions", Shane, 2026-11-13; not built).
- Two attachments with one name resolve to neither: the fallback refuses, and the hint lists both `@file:` handles,
  as `@file:"name"` does ("The name, and two files with one name", above).

**The mount.** BUILT (#2026) as route A's file system type over the one ranged reader, lazy at every size, in a
worker-hosted run's own worker; how it works is `docs/dev/python-sandbox.md`, "`/files` in Python", and the design is
"`/files/` read by range, and `ml.fs`" and "Python's view: one mount type over the reader" below. The six conditions the
Pyodide lane set on 2026-11-12 (measured in Node against `pyodide-core/`), each with what became of it; the
measurements are in session-mail `20261112-1712Z-python-packages-to-chat-page-files-lazy-and-flush.md`:

1. SUPERSEDED 2026-11-17 (ruling 22): an eager MEMFS loaded from the shelf at interpreter start, one times the
   directory held as ArrayBuffers, with a lazy mount set aside for want of a synchronous channel and because
   `Atomics.wait` would block Stop. Route A's sliced wait answered both ("Host directories in the sandbox",
   "Measured").
2. Holds: `/files/attached/` refuses every write with EROFS, and file modes do not hold (a cell's own `os.chmod` undoes
   `0444`, measured), so the refusal is the reader's, whatever path asks. BUILT: the reader answers EROFS there.
3. SUPERSEDED 2026-11-19 (ruling 75): bytes posted to the offscreen document on each close, and a cell-end flush of
   every open file found by a `gc.get_objects()` scan. A file now commits when it is closed, as one transaction, through
   the reader's write verbs; the cell-end flush is not built. The offscreen document stays the boundary: it re-checks
   every request, never taking a path on the worker's word.
4. SUPERSEDED 2026-11-19 (the coordinator, "the reader's premise, corrected by async"): one directory per session
   inside a `full` worker shared across runs. A worker serves one run, so its session is fixed per worker, and no
   shared worker gets a mount.
5. Holds: regular files only. BUILT: a symlink and a hard link answer EPERM in the mount.
6. SUPERSEDED 2026-11-17: a quota of about three times a file's size, which was this MEMFS's cost. The quota counts
   stored size ("Writes").

**A kernel death.** The restart terminates the worker (the existing kill path). What was posted is safe; files still
open are lost, and nothing is salvaged from the dead interpreter's heap, which may be corrupt. The restart reloads
`/files/` from the shelf into the fresh MEMFS (AMENDED 2026-11-17: it remounts and loads nothing, "`/files/` read by
range, and `ml.fs`") and tells the model which module failed, and what survived (as a cell
result, or an inbox item for a detached cell): `variables gone; /files/ kept
(12 files); w.npy was open and is lost.` The restart's message and its delivery are the async lane's (ASYNC_CALLS.md).

**Mutable, frozen when cited.** A file in `/files/` changes freely; there are no versions per write. A file is frozen
into an immutable version, an `@file:` the transcript can name, only when it leaves the directory or enters the
record: `dereference`, `look`, `ml.sh.put`, the transcript and the exports. The log stays truthful the way a coding
agent's does: it records what was read, never the file's current bytes. Two runs of one session writing the same file:
the last commit wins, with a run-log note (the coordinator's reader call under rulings 54 and 75). Two live runs of
one session see each other's files as they are committed: every cell remounts and asks the reader, and a descriptor
already open keeps the version it pinned until it is closed. AMENDED 2026-11-19: this said each post was pushed to
the session's other live workers, a premise of the MEMFS mount (item 1).

**Provenance is a field, and every sentence reads it.** A file pointer carries who made it: the person, run R's cell N,
or a read from disk at a path (below). Every model-facing sentence that today says "attached by the person" (the
`<file>` block, the outline, `look`'s page label, `ml.sh.put`'s card, which today says the attachment's original bytes)
reads the field. A file a run made is never described to the model as the person's: that wording carries authority a
model-made or page-derived file must not borrow. Its text is untrusted input like any other ("Trust", below).

**Lifetime and quota.** A session's files last as long as the session, until the person deletes them, the same as an
attachment today. Nothing is evicted silently. When the session's files made by its runs are over the quota, a write
is refused with ENOSPC by name and the cell's result says so: `w.npy was not kept: the session holds 1.4 GB of files
made by its runs; delete some in the files panel.` The quota's value and where it is checked are "Writes" below (not
built: no `filesQuotaMB` on main). A restore can leave a session over its quota; it is then
marked over it and refuses writes the same way until it is back under (ruling 48, "A restore over the quota", below).

**The host's disk.** `/files/` is the browser sandbox's, never the `ml.sh` workspace's, and the two never alias: an argv
item `/files/x` is a host path, as today. Bytes cross only as `@file:` handles: `ml.sh.put` writes one out (ruling 3),
and a read brings a workspace file in, into `/files/` with provenance "read from disk <path>" (the async
lane's). The model's text says it in one line: `/files/ is the browser sandbox's, not the workspace's.` A proposal
of 2026-11-13 reopens this for directories the person mounts ("Host directories in the sandbox", next). AMENDED
2026-11-20 (ruling 91): this holds without a host, with a host older than H16, and before a session's first mount;
once the session's own folder is mounted, `/files` is that folder ("One folder per session").

### `/files/` read by range, and `ml.fs` (ruled 2026-11-17)

RULED 2026-11-17 (Shane, in the coordinator's session): the `/files/` file system must not put all files in memory, so
that several concurrent sessions stay usable, and it gets JS-side access, `ml.fs`. RULED 2026-11-17 (Shane, ruling 23,
in the coordinator's session): `ml.fs` reuses Node's `fs` syntax, because models already write it unprompted, as
Python gets plain `open`. **The principle: each language gets the file API the model already knows; where we are
narrower, the error names the form that works.** Written by the session-store lane from
`docs/spec/SESSION_HISTORY_STORE.md` §6a, with the coordinator's rulings of the same day. It amends items 1, 4 and 6 of
"The mount", the restart in "A kernel death", slice 3's "Python" paragraph, "The files API" (whose `ml.files` it
replaces) and the quota's open question. BUILT (2026-11-22): the reader's read side (slice 1 below, #2048), its
wiring and scrub (#2058), and the Python mount (#2026). Not built: `ml.fs` (session-store's next PR, ruling 54), the
write side and the quota, and the file browser.

**Why it changes.** The mount above is eager: every file's bytes reach the worker at interpreter start, one times the
directory, up to three times once cells read it (item 6), against a worker that dies at a 2.6 GB JS heap. A
session's directory grows for the whole session and outlives kernel deaths, so its size is unbounded while the
worker's memory is not, and several sessions share one offscreen document and, in `full` mode, one worker. Item 1 set
a lazy mount aside on two grounds: it needs a synchronous channel, and `Atomics.wait` would block the interrupt
buffer, so Stop would fall through to the kill. Route A's measurement since ("Host directories in the sandbox",
2026-11-13, `notebooks/pyodide-mount/`, the prototype file system type in `node-worker.mjs`) answers the second:
a sliced wait stops 300 times out of 300, under `lockdownReadonly` too, a request costs 0.26 ms end to end, and a
chunked read gives 103 MB/s in 512 KiB chunks to 4 GiB. The first ground is that same channel.

#### One reader, three front ends

**ONE ranged reader over the shelf**, in the offscreen document, which already owns the shelf (item 3). It answers
`stat`, `list` (each entry with its stat) and `read(path, offset, length)`, and reads a range of a kept file without
loading it: `Blob.slice(a, b).arrayBuffer()` over the stored Blob. Today every stored-value reader reads a whole Blob
(`readStoredText`, `readStoredBytes`, `withStoredTables`); this is a new method on the store, beside them. Three
front ends call it and nothing else:

1. **The Python mount**: route A's file system type, served by this reader instead of `wmlhost`. `lookup`, `readdir`
   with stats, `getattr`, and the stream ops `open`, `read`, `llseek`, `close` go to the reader; writes are below.
2. **`ml.fs`** for JS, below.
3. **`/history/`** later (SESSION_HISTORY_STORE.md §6b), over the session store instead of the shelf.

**The bounds.** No front end holds a whole file.

| What | Bound |
| --- | --- |
| One read, reader to front end | at most one 512 KiB chunk per request (`READ_CHUNK`, `src/shell/host-protocol.ts:16`); a longer read is several |
| One session's cache in the worker | a fixed number of chunks (32, 16 MiB, `READ_CACHE_SLOTS` in `src/python/files-mount.ts`), oldest dropped |
| What a cell holds | what the cell itself reads into a variable, as today; a whole-file `f.read()` still grows wasm memory by the file |
| The offscreen document, all sessions | the chunks in flight: sessions × one chunk, plus the Blob handles, which hold no bytes |
| `ml.fs` | `readFile` refuses above a cap (below); `handle.read` returns at most one chunk per call |

MEASURED (`notebooks/session-store/`, `ranged.ipynb`; a lab, not the product: an extension page stands in for the
offscreen document, a dedicated worker with a 16 MiB cache for the Pyodide worker, the channel to Python left out
since route A measured it): each session's directory is two 128 MiB files, read lazily through 512 KiB chunks
or loaded whole, for 1, 4 and 8 sessions at once in a fresh browser per configuration. Lazily, with the reader's
garbage collected as it goes, the browser grew by about 51 MiB for one session, 169 MiB for four and 219 MiB for
eight: the cache (16 MiB a session) and a fixed overhead, independent of the directory's size. Loaded whole, it grew
by the directory for every session: about 262 MiB for one, 1.0 GiB for four, 2.0 GiB for eight. A reader that
allocates a fresh buffer per chunk and lets V8 collect it holds garbage up to the bytes it READ (1.1 GiB for one
session reading 1.25 GiB) until a collection runs, and at eight sessions that pushed the machine out of the normal
memory-pressure level: **the reader copies into a fixed buffer** (route A's shared one), never a buffer per chunk.

**Eager under a measured size, or not at all.** RULED 2026-11-19 (the coordinator, an infra call, on the collected
figures above): **lazy only, at every size**; no eager mount under a threshold. What an "eager under T" rule could save is time on small files, and the lab's timings were taken while other
test runs shared the machine, so none of them is used here; whatever it saves, it would cost a second code path and a
mount whose memory depends on what a session holds, which is the cost the ruling removes. The decision rests on the
memory figures above.

**Stop still works**: the mount's blocked operations are route A's, with the `Atomics.notify` beside the Stop's store
that route A requires; the 300-of-300 rows are rerun on this server before it lands.

**A kernel death remounts.** The restart mounts `/files/` again and loads nothing, so a large directory no longer makes
the restart slow; open writable files are lost, as before.

#### `ml.fs`: Node's `fs/promises`, with a session's files as its disk

`ml.fs` IS the `fs/promises` surface, and `ml.fs.promises === ml.fs`, so both `await ml.fs.readFile(p, "utf8")` and the
`fs.promises.readFile` habit work. Every member returns a promise, takes Node's arguments, and answers Node's shapes:
`readFile` with an encoding gives a string and without one a `Uint8Array` (Node's `Buffer` is a subclass of it);
`stat` gives Node's fields (`size`, `mtimeMs`, `birthtimeMs`, `isFile()`, `isDirectory()`); `readdir(p, { withFileTypes:
true })` gives Dirent-shaped entries; errors are `Error`s with Node's `code`, `syscall` and `path`.

**Members, and whether each reads or writes.** `open`'s flag decides for a handle: `r` reads; `r+`, `w`, `wx`, `w+`,
`a`, `ax`, `a+` and any flag not in this list write.

| Member | Kind | Notes |
| --- | --- | --- |
| `readFile(path, options?)` | read | refuses above `ML_FS_READFILE_MAX` (proposed 8 MiB) with `ERR_FS_FILE_TOO_LARGE`, Node's own code for the same refusal past 2 GiB; the message names `open()` with `handle.read()` or `handle.readLines()` |
| `readdir(path, options?)` | read | `withFileTypes` supported; `recursive` supported |
| `opendir(path)` | read | pages its entries, so a directory of a hundred thousand files is never one array (the coordinator, 2026-11-20) |
| `stat(path)`, `lstat(path)` | read | `lstat` answers as `stat`: no symlinks exist |
| `access(path, mode?)` | read | `W_OK` on `attached/` rejects with `EROFS` |
| `open(path, "r")` | read | returns a FileHandle |
| `handle.read({ buffer?, offset?, length?, position? })` | read | at most one chunk (512 KiB) per call; `bytesRead` as Node's |
| `handle.readLines(options?)` | read | an async iterator of lines, read chunk by chunk |
| `handle.stat()`, `handle.close()` | read | |
| `createReadStream(path, { start, end })` | read | streams a range, chunk by chunk (the coordinator, 2026-11-20); `createWriteStream` is not a member; narrower than Node's ReadStream: async-iterable chunks, no EventEmitter and no pipe |
| `writeFile(path, data)` | write | chunked to the shelf (below) |
| `appendFile(path, data)` | write | |
| `open(path, flag)` with a write flag; `handle.write`, `handle.truncate` | write | |
| `mkdir(path, options?)`, `rmdir(path)` | write | `recursive` supported |
| `rm(path, options?)`, `unlink(path)` | write | `ml.files.remove`'s rule, below |
| `rename(from, to)`, `copyFile(from, to)` | write | within the session's files only; `ml.fs` has `rename`, not `mv` (the coordinator, 2026-11-20) |
| `cp(src, dest, options?)` | write | AMENDED 2026-11-20 (rulings 36 and 60, as ML_TABLE.md uses it): `src` is a path in the session's files (a directory needs `recursive: true`, as Node's) or a `@tool:` pointer or fetch result, whose stored whole is written ("Dumping a `@tool:` value into `agent/`"); `dest` must be under `/files/agent/` |

**The gate.** The READ members land with every exec that names `ml.fs` asking, and join the read-only dialect only
after the hide rule exists (ruling 34; POLICIES.md, "Hiding files"); from then a survey may call them on the session's
own files without asking (the coordinator, 2026-11-20 to 22; this said they joined the dialect at once). The WRITE
members follow "The layout": a write under `/files/agent/` runs free, as a cell's would ("Lifetime and quota"); a
write anywhere else, the root and the person's files (`attached/`), is refused with `EROFS`, as the mount refuses it
(item 2); a delete follows `ml.files.remove`'s rule (below), which
keeps a cited file's frozen version. A write member in a survey takes the survey out of the dialect, as any other
effect does. Extending the dialect carries what docs/dev/readonly-exec.md, "The rule for extending the dialect",
requires: adversarial tests that try to reach a write, a path outside the session, a handle used after `close`, and a
method smuggled as a value (`ml.fs.readFile` passed as a callback), each `NotInDialect`, `Denied` or inert; halting
tests (`readLines` over a file growing while it is read, a `readdir` recursion over a deep tree); a `CONVERTS` or
`NO_CONVERSION` decision for each member; and a re-check of the whole contract. `ml.fs` is an object, so it is its own
branch of `mlFacade`, beside `ml.fetch` (policy.ts:520-531 copies functions only).

**Hidden and secret-looking files.** Every front end of the reader (`ml.fs`, the Python mount, the file browser)
applies the hide list (ruling 34: hide and show entries, the most specific wins, a tie hides) BEFORE it answers. The
rule's text is POLICIES.md's, "Hiding files"; the answer's shape (the name is listed, a read is refused) is the one
table in SECRET_HANDLES.md, "What the model can see of a secret", and this spec only references them. Slice 2 does not land `readFile` or any other
read member in the read-only dialect before that rule exists. A read of a HIDDEN file is refused, by every front end, in the dialect or out of it; it does not ask. A file that
only looks like a secret and is not hidden is read like any other under `/files`.

**The extra columns.** `ml.files.list()`'s rows (who made it, last read, whether a transcript cites it) become extra
fields on the stat result, under one key that cannot be mistaken for Node's: `stat.ml = { madeBy, lastReadMs, cited }`.
`madeBy` is `"person"` or `{ run, cell }` or `{ disk: path }`; `cited` is true when the transcript names a frozen
version. Node's own fields keep Node's meaning, and a field we cannot answer is ABSENT, never zero: no `ino`, `dev`,
`uid`, `gid`, `nlink`, `blocks`; `atimeMs` is `lastReadMs` when we have it, else absent.

**Paths.** One root, the session's files.

- `/` is that root; `/files/` is the same directory, so `/files/x` and `/x` name one file, and a path a Python cell
  printed works unchanged.
- A relative path resolves against `/files/agent/`, the working directory (AMENDED 2026-11-19, the coordinator's
  layout call after ruling 86: this said `/files/`; "The layout"). `..` is resolved lexically and stops at the root:
  `/files/../../etc/x` is `/etc/x` under the root, which does not exist.
- Anything that does not name a file in this session's files is `ENOENT`, with the same message whether or not
  something exists elsewhere: another session's file, a host path, an extension file. The error never says why.
- No symlinks: `symlink`, `link` and `readlink` are missing members (below).

**Narrower than Node, listed once.** Each throws, at the call, an `Error` with code `ERR_ML_FS_UNSUPPORTED` and a
message naming the form that works, so a builder tests each:

- every `*Sync` member (`readFileSync`, `writeFileSync`, `existsSync`, …): "use `await ml.fs.readFile`";
- every callback form (a function as the last argument): "use the promise form";
- `createWriteStream`: "use `open()` with `handle.write()`". AMENDED 2026-11-20 (the coordinator's ruling):
  `createReadStream` left this list; it is a member, as "`ml.fs`" under rulings 22 and 23 has it;
- `watch`, `watchFile`, `unwatchFile`;
- `chmod`, `chown`, `lchown`, `utimes`, `lutimes`, `fchmod`;
- `symlink`, `link`, `readlink`, `realpath` (`realpath` of an existing path answers the path; of a missing one,
  `ENOENT`);
- `mkdtemp`, `statfs`. AMENDED 2026-11-20: `cp` left this list; it is a member (the table above), since ruling 36's
  dump and ML_TABLE.md's byte-exact copy are `ml.fs.cp`. `opendir` left it too (the coordinator's ruling): it is a
  member, paging its entries, as "`ml.fs`" under rulings 22 and 23 has it;
- encodings: `utf8`, `utf-8`, `latin1`, `base64`, `hex` and none; any other: "supported: …".

**Parity with Node, tested side by side** (Shane, 2026-11-17). Node's `fs/promises` is the oracle. One corpus of
scripts runs twice, against Node on a temporary directory and against `ml.fs` on a session holding the same files,
and compares return values, `stat` fields, Dirent shapes, thrown `code`s and `bytesRead`, member by member: each
member of the table, every flag of `open`, the path cases (relative, `..` past the root, `/` against `/files/`), and
each error (`ENOENT`, `EISDIR`, `ENOTDIR`, `EEXIST`, `ENOTEMPTY`). Where `ml.fs` is narrower by design, the row
asserts `ERR_ML_FS_UNSUPPORTED` instead, so a member listed above can neither start working unnoticed nor fail some
other way. Fields `ml.fs` leaves absent are compared as absent. The corpus is written with slice 2 and runs in the
unit suite against the node:vm harness, and once against the real extension in e2e.

**Python is not this API.** Python gets the mount and its own `open` and `os`; nobody builds an `ml.fs` binding there.

**Who may call it.** A worker-built run only, in the isolated world: the same routing as `ml.current` and `ml.sh`
(`src/sw/exec-routing.ts`: a new `ExecNames.fs`, an `EXEC_REASONS` entry and its `FORCED` text). With no isolated
world, an exec naming `ml.fs` is refused; it is never bound for a page-started caller, never in an unapproved page's
main world, and a page's `window.ml` has no `fs`. The session is the run's, read from the worker's run record, never
from anything the script says. The current session's files only.

**The scrub.** Every `ml.fs` read, text or binary, returns the reader's masked bytes: a registered value is replaced by
`*` (0x2A) at the same length, inside `RangedReader.read`, the one path every read takes (BUILT, #2058; "Python's view:
one mount type over the reader" holds the rule). So a masked value keeps its length and offsets stay true: for an ASCII
file a text read's length equals `stat`'s size, and the model is not told which secret was hidden (the coordinator,
2026-11-20 to 22). The exec's result then crosses `forModel` as every tool result does. The residual is the mask's
(#2058): a value in another encoding (UTF-16) or inside a compressed or encoded container (a deflated zip member, gzip)
is not matched.

RULED 2026-11-22 (Shane, ruling 101), not built: the `*` becomes a per-secret fake value of the same length, and a
fake or a marker written back to the file that holds the value is restored from that file's own bytes (ruling 100).
`SECRET_HANDLES.md`, "A redacted value written back to its own file is restored".

SUPERSEDED 2026-11-20 to 22 (the coordinator, the same call): a text range scrubbed to `[REDACTED:<NAME>]` over a
window widened by the longest form, with a 4,096-character ceiling and an 8 MiB whole-file fallback, and a binary
range returned unscrubbed (the coordinator's ranged-scrub call under rulings 22 to 25). That window is built as
`scrubRange` (`src/secret-scrub-range.ts`, #2048) and has no caller in the product on main.

**Long results** follow the existing pointer rule: a long `ml.fs` value reaches the model as a `@tool:` pointer with a
preview, like any other exec value.

#### Writes

- **Where they land: the shelf, by chunk.** A write member, and a Python file's close (item 3), sends its bytes to the
  offscreen document in chunks of at most 512 KiB, never a whole file in one message (the runtime message limit is
  64 MiB, measured in `notebooks/session-store/chrome-bounds.ipynb`); the offscreen document writes each at its
  offset into a pending part and commits the file as one new stored Blob at the commit point (below). A write may seek
  back and overwrite, and a file may be truncated (zipfile patches its headers, sqlite writes pages anywhere): the
  pending part is a list of ranges over stored chunks and the version it replaces, composed into a Blob without
  copying bytes. Its writer reads it back through the same handle; until the commit, every other reader sees the
  previous version.
- **The quota** (this spec's open question): with nothing loaded at start, the quota is no longer a start-time budget.
  It bounds what a session's runs keep on disk: the person's attachments do not count, run-made files do, at their
  stored size (not three times). Its value is the DevTools Settings flag `filesQuotaMB` (the coordinator's call,
  2026-11-19; owned by the session-store lane), default 1024 MiB per session (a default awaiting Shane's word; it is
  the one `filesQuotaMB` line of `DEFAULT_CONFIG` in `contract-config.ts`), below the value store's budget; a stored
  value that is not a positive whole number reads as the default, and a larger number widens it. The model may propose
  a change to it (ruling 76, Shane, 2026-11-19) through `change_setting` (MODEL_SETTINGS.md, "The surface"), as for
  `taskTurnChainMax`: the key is guarded, so a change always asks the person. Over the quota, a write rejects with
  `ENOSPC`, and the message names the quota in MiB, removing files under `/files/agent/` (`os.remove` in Python; it
  names `ml.fs.rm` and the files panel once they are built), and asking the person to raise `filesQuotaMB` with
  `change_setting`. It is checked on every chunk written and every truncate, and again at the commit, against what the
  session has stored plus every pending file of the session on any channel. BUILT: the offscreen document cannot read
  the settings, so it asks the service worker at each file opened for writing (`FILES_QUOTA`, answered to the offscreen
  document only); an ask that fails refuses the open with `EIO`.
- **The commit point, for now** (ruling 75, Shane, 2026-11-19, accepting the coordinator's call): a file commits when
  it is CLOSED, in both modes, as Python's and Node's own files do; each file is atomic on its own, and a cell that
  fails keeps the files it already closed. An `ml.fs` write member is a transaction of one (`writeFile` commits at its
  end, a write handle at `close()`). The reader's write side stays a transaction that commits atomically over all of
  its files, so committing every write of a cell together when it succeeds stays one switch away.
- **A worker evicted mid-file.** A commit is atomic: an uncommitted file's pending part is discarded when its writer
  goes (a worker evicted, a kernel killed, a tab closed), the previous version stands, and the next turn's start
  message says which file was not written (NOT BUILT). Nothing is half-written. BUILT: each discard is a run log record
  (`files` `discarded`, its path) and a stored note of the path and the time, the newest 50 per session, which the state
  inspector reads (`session.files`).
- **Where they are kept.** BUILT: in their own IndexedDB database, `ml-agent-files`, not the value store: its budget
  and eviction are not a session's files' lifetime, and its `sha256` would read a whole file into memory. A file's
  version is minted at each commit. A transaction commits as ONE IndexedDB transaction over the files' nodes and bytes.
  A session's files are deleted with the session (the person deletes it, or the store evicts it with nothing archived),
  kept when it is archived, and never at a run's end.
- **Two writers of one path: the last commit wins.** A commit applies its writes and name changes in order against
  what is stored when it commits, not when its files were opened. So two channels writing one path each replace it in
  turn, and the later commit's bytes stand; a pending write whose path another transaction renames or unlinks first
  lands at that path when it commits, recreating it, while the renamed file keeps the bytes it had. A commit whose
  folder another transaction removed first fails whole (`ENOENT`).
- **Deferred** (the coordinator's call, 2026-11-23, to free reviewers for the `ml.fs` dialect entry; not built and not
  scheduled until Shane asks). (1) `ml.fs`'s write members and their parity rows; until they land, `ml.fs` only reads.
  (2) `cp("@tool:…")`, a `@tool:` value written to a file. (3) The turn-start line naming a file not written: the
  discard is recorded (above) but no message tells the model. (4) A sweep of files no session holds. It is not built
  on `liveHeldSessions`, because that counts an archived session as ended, so a sweep built on it would delete the
  files an archived session keeps; it needs a check against the archive first. Until then a session's files go only
  when the session is deleted or evicted with nothing archived (`forgetAgentFiles`).

#### `ml.files` is superseded

RULED 2026-11-19 (Shane, ruling 60, in the coordinator's session). `ml.fs` replaces the proposed `ml.files` ("The files API", below). Its rules are kept: `list()` is `readdir` with
`stat`, a read the dialect may call; `remove(paths)` is `rm`/`unlink`, judged as written: the runs' files go free, the
person's ask unless a policy allows, and a cited file keeps its frozen version. Nothing built or model-facing names
`ml.files` (searched: only this spec), so the rename costs no code.

#### Slice 3's `files` in Python

The Python mount is built (#2026, "Python's view: one mount type over the reader", below); the `files` argument this
recommends is not (`python_exec` has none on main).

RECOMMENDATION: **`files` becomes paths under `/files/`, read by range,** for every cell, the restricted dialect
included. `files: { name: "@file:3fa91c2" }` binds `name` to the path `/files/attached/3fa91c2/<name>`; the loader
redirect (`read_csv`, `Image.open`, `read_html`) and, in cells that have it, `open` read it through the mount. A paged
document keeps its pages object (`doc.pages[n].text`, `.png()`), each page read on access. The reason: an injected
value is a whole copy into the heap at the call's start (`withStoredTables`, offscreen.ts, `blob.arrayBuffer()`),
which is exactly what this ruling removes; a size bound on it would refuse a file the mount reads fine; and one way in
means one bound to test. The restricted dialect still has no `open()` or `os` (PYTHON_DIALECT.md): it reads the path
only through the loader redirect, which is read-only.

#### The file browser shows the mounts, and its menu sends commands

RULED 2026-11-17 (Shane's idea, the details the coordinator's calls, in the coordinator's session). The files panel
("The files panel", above) becomes a browser over every mount a session has.

1. **One tree over mounts:** the `/files/` shelf, each `ml.sh` root, and later `/history/`. It is listed lazily, one
   directory at a time when the person opens it, through the same ranged reader as every other front end; no whole
   tree is held in memory (ruling 22).
2. **A context-menu item is a session-contract COMMAND** (SESSION_CONTRACT.md, "Commands"), never a direct `chrome.*`
   or host call from `src/chat/`. Any host of the renderer (the extension, a later VS Code extension) sends the
   identical command and gets the identical answer. The first item is hiding or unhiding a path as a secret; the
   command and its handler are files-host's hide-list spec's, and this spec only references them.
3. **A hidden file is listed by name, with its hidden state.** The browser never reads its bytes, to preview, size or
   anything else.
4. **The menu is the person's gesture only.** No model tool, no `ml.fs` member and no page-started message reaches
   these commands; they come from the person's own clients, under the session contract's own sender rules.
5. **Over the hub, as the rest of a session** (Shane, ruling 24 as refined, 2026-11-17). The directory listing (the
   mounts, then per directory its entries with name, size, kind and hidden state) and every menu command are
   session-contract events and commands. They reach a renderer only through `SessionFeed`, so the hub path carries them
   as it carries the rest of a session, and no extension-only side channel exists. Listing stays lazy over the hub too:
   a request names one directory and gets one page, and file bytes never ride a listing. A page is bounded so its
   sealed message fits the hub's `max_payload_bytes` (1 MiB less the envelope, `docs/dev/hub-client.md`): at most 500
   entries and 256 KiB of JSON, with a cursor for the next page.
   AMENDED 2026-11-25 (accepted by the coordinator, 2026-11-24): the listing is the `files.list` COMMAND's answer, as
   `session.backfill`'s pages are, not an event, since an event is kept in the session's history and replayed into
   every backfill and export. The one event is `files-changed`, which names the directories to list again and carries
   no entries (SESSION_CONTRACT.md, "Session events").
6. **window-ml-hub needs no change.** The hub relays sealed payloads it cannot read (window-ml-hub's README and
   its `PROTOCOL.md`), so a new command and a new event kind pass through it as opaque bytes. The change is to the
   session contract only (SESSION_CONTRACT.md: the listing command, its event, and the hide-list command by reference),
   with the version rule that contract follows; no `@hub-compat` label.
7. **The phone's RENDERING is deferred, as UI work only.** On the phone a person is monitoring a task already set up,
   not arranging its files, so the phone's browser view and any remote unhide wait. Nothing else is deferred: the
   listing and the commands are host-neutral and already reach the phone through the hub, so its view needs no
   contract change when it comes. Built first for the desktop renderer hosts: the extension, and a later VS Code
   extension.

#### A `python_install` candidate worker

never mounts `/files/` and never gets `ml.fs` (the packages lane's constraint): the worker an install is tried in sees
no session's files.

#### What it owes, and the slices

`ml.fs` is a new `ml.*` member: the red-team pass AGENTS.md requires (a page-started run, a page's main world, an
unapproved page, a forged path, another session's file, a write to `attached/`, a smuggled method), each new store
declared with `defineState`, its JSDoc and `agent_api_docs` entry, and a prompt review. The members and their JSDoc
are what the model reads.

1. The ranged reader on the shelf, and chunked writes with the atomic commit. Must not break: an attachment's
   existing readers, the value store's budget and holders check.
   AS BUILT (slice 1, ruling 54's first PR: the reader, its interface and the ranged scrub). `RangedReader`
   (`src/session/ranged-reader.ts`) implements `FilesChannel` (`src/python/files-reader.ts`, the shape agreed with
   the async lane) on the `files` volume; a volume is a tree resolved one path at a time, so `/history/` is a second
   volume beside it. The shelf reaches it through a `FilesSource`: a session's attachments and a stored Blob by key,
   neither of which loads bytes; a read slices one range of the Blob into the caller's buffer. The hide rule is a
   function the reader asks at every open and every read; it is the resolved hide list since #2088
   (`src/session/files-hide-rule.ts`). Every
   byte read is masked by the length-preserving scrub of "Python's view: one mount type over the reader" (below), so
   slice 2's `ml.fs` reads get it too, text and binary alike (the coordinator, 2026-11-20 to 22, "The scrub"; the
   `[REDACTED:<NAME>]` window, `scrubRange` in `src/secret-scrub-range.ts`, is not used for them). The write verbs
   check the transaction and the path
   and then answer `EROFS` at the root and in `attached/`; under `agent/` they write ("Writes"), and with no store of
   run-made files (a reader built without one) they answer `EROFS` there too. `begin`, `commitTx` and `abortTx` of an
   empty transaction succeed, so a front end that opens one per cell works read-only. The offscreen
   document's wiring has landed: `setFilesReader` over one `RangedReader` whose source (`src/python/files-source.ts`)
   asks the service worker for a session's files with `FILES_ATTACHED`, answered from the offscreen document only,
   and reads the bytes from the offscreen document's own value store, held rows of that session only.
2. `ml.fs` read members in the isolated world, the routing, the red-team pass, and the Node parity corpus for the
   read members, landing with every exec that names `ml.fs` asking; the dialect entry with its tests follows the hide
   rule (ruling 34, "The gate"). Must not break: `ml.current`'s and `ml.sh`'s routing rows. BUILT (#2083), but for
   the dialect entry.
3. `ml.fs` write members, the quota setting, and the parity corpus extended to them. BUILT: the reader's write side,
   the store of run-made files and the quota setting, so Python's writes land. Not built: the `ml.fs` write members
   and their parity rows, then `cp("@tool:…")`, both DEFERRED ("Writes", "Deferred").
4. The Python mount on route A's type over the reader, slice 3's `files` as paths, the restart's remount. Must not
   break: route A's Stop rows, rerun on this server. BUILT (#2026, the async lane): the mount, remounted at every
   cell; its design was fixed by ruling 75's one store, not by the packages measurement. Not built: slice 3's `files`
   as paths.
5. The file browser over the mounts, its listing command and event, and the menu's first command. Test obligation:
   the listing and one command round-trip through the chat page's web build against the fake host, with no `chrome`
   (the `chat-web` skill).
6. Each owner reruns in Chrome what it builds on: the reader's slice reruns `ranged.ipynb` against the real offscreen
   document; the mount's slice reruns route A's Stop and cost rows (`notebooks/pyodide-mount/`) against this reader.

**Owners** (the coordinator, 2026-11-19, ruling 54). The ranged reader and `ml.fs`: the session-store lane. The Python
mount (slice 4): the async lane, on this reader; the packages lane's measurement of the mounts (ruling 36) informs its
design.

### Host directories in the sandbox, and a cell's edits as diffs (proposed 2026-11-13)

PROPOSED 2026-11-13 (Shane, in the calm-chat-motion session). Ruled since: route A ("What follows", the coordinator,
2026-11-13), the initial decisions (Shane, 2026-11-13) and the host's rows (H1 to H18, "What window-ml-host must do"
below). Built: route A's channel, which serves the browser's own `/files` mount (#2026), not a host directory; the
host's mount calls (window-ml-host#40) and the extension's wire and judge for them (`docs/dev/shell.md`, "A session's
folders"), which nothing calls yet. No host directory is mounted into a cell on main. It reopens "the two never
alias" above for a directory the person mounts.

**What it is for.** Models edit files by writing a Python script that calls `open()`, not only through an edit tool.
That should work the same on the browser sandbox's `/files/` and on the host's disk, with one syntax, and the person
should be able to see, skippably, what each cell changed.

**One filesystem, plain paths.** A cell sees `/files/` and the mounted host directories in one tree and uses ordinary
`open()`, `os` and `pathlib` on both. A prefix inside `open()` (`open("@file:/files/x")`) was considered and dropped:
most file access (`pandas.read_csv`, `numpy.load`, `sqlite3`, `zipfile`, `shutil`) reaches the filesystem below
`builtins.open`, so a prefix works only if the filesystem resolves it, which makes it a mount under an odd name; and
an `@file:` is a frozen version ("Mutable, frozen when cited"), which a live path is not. `@file:` stays the handle a
tool takes and the transcript cites; a path is what `open()` takes.

**A host directory keeps its real path.** A directory the person approves (the `ml.sh` workspace, say) is mounted at the
absolute path it has on the host, resolved with the host's realpath so a symlink is not a second name:
`/Users/sb/git/window-ml/README.md` is that path in the cell and in `ml.sh`; the transcript writes it
`~/git/window-ml/README.md`, with the raw path beside it in the run log. Renaming it to a mount point (`/workspace/`)
was considered and dropped: the person knows their own paths, and a renamed one makes a run harder to review.

**Collisions.** The sandbox owns `/files/` and Pyodide's own tree (`/tmp`, `/lib`, `/home/pyodide`, `/dev`, `/proc`).
A mount at or under one of these is refused by name when it is approved, never shadowed:
`/files is this sandbox's directory; the host's /files cannot be mounted at that path.` So is a mount above one (the
host's `/`, or `/home`, which would shadow `/home/pyodide`):
`/home holds this sandbox's /home/pyodide; mount a directory inside it instead.` On macOS `/tmp` resolves to
`/private/tmp`, so a workspace there does not collide.

**A path outside every mount** fails with `PermissionError`, never `FileNotFoundError`, since the file may exist:
`~/other is not mounted in this sandbox; reach it through ml.sh, or ask the person to mount it.`

**`/files/` in an `ml.sh` argv** is H9's mapping below. SUPERSEDED 2026-11-13 (Shane, H9): this refused a `/files/`
argv item unless the host had such a path.

**The channel.** Pyodide has no synchronous remote backend, so a host-backed node needs one. Route A was measured on
2026-11-13 and ruled ("What follows", below); route B is kept as the line that was dropped:

- A: a sliced wait, no rebuild. The node posts a request (worker, offscreen, service worker, host) and waits on
  `Atomics.wait` in slices of about 50 ms, checking the interrupt flag between slices and raising `KeyboardInterrupt`
  when Stop is set. The worker already holds a shared interrupt buffer (`py.setInterruptBuffer`,
  `src/python/python-worker.ts`). Item 1's objection, that `Atomics.wait` blocks the interrupt buffer, is to an
  unsliced wait; that a sliced one keeps Stop working is inferred.
- B: JSPI-suspending file syscalls, a rebuild (`docs/dev/pyodide-build.md`). DROPPED 2026-11-13 ("What follows"):
  A's Stop and latency held.

A host-backed file is read by `fetch`, one chunk of at most 512 KiB a call, and written by `store`, then `write` in
512 KiB chunks, then `commit` (H1, as amended 2026-11-13; this said fetched whole on open and pushed on close), with the
listing cached per cell: a change the host makes during a cell is seen at the next open. A host that is not connected
fails the open with EIO. Every request carries an id, and a reply to a request whose wait was interrupted (Stop, a
timeout) is discarded by that id. A push never leaves a half-written file on the person's disk: the host writes beside
the file and renames it into place, so a Stop or a dropped connection mid-transfer leaves the old file whole.

**Security** (each mount is a new surface the model reaches: e3's pass, Shane's ruling). The approval is per mount,
not per call, so a mounted directory is read and written with no card per `open()`. The host enforces the scope
itself: a `full` cell can forge a worker post (item 3), so the path a request claims is resolved and checked on the
host, never taken from the worker. The host opens a path by walking its components from the mount's own descriptor
(`openat` with `O_NOFOLLOW` on each component, or the platform's equivalent), never by resolving a string and then
opening it, so nothing can swap a component between the check and the open. A page-started run never has a mount.

- What may be mounted. The approval checks the RESOLVED path, so `~/x/..` or a symlink does not pass as a leaf. A
  mount at or above the person's home is refused by name, as is one at, under or above the browser profile
  (`chrome.storage.sync` holds the API key and the model filter), the archive folder or window-ml-host's config:
  `~ is your home directory; mount a directory inside it instead.`
- The directory replaced after approval. The host holds the mount's descriptor from approval and compares its device
  and inode on every request, so a mounted directory replaced by a symlink to `/` is refused, not followed.
- Unmounted or disconnected during a cell. The next read fails; the cached listing and any copy in MEMFS are not
  served, and a close does not push.
- Bounded sizes. An open and the before copy are bounded by a size cap (256 MB (ruled 2026-11-13), "What follows" below):
  a file over it fails the open with `EFBIG` and a sentence naming `ml.sh`, so the worker's memory is never the limit
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

**Measured** (2026-11-13, the async lane; `notebooks/pyodide-mount/`, Apple M5 Pro, Node 26, Chromium 151, the
restricted-mode Pyodide core). Two labs, no product code: a prototype host-backed FS type in real Pyodide in a Node
worker thread, served from the disk by the main thread; and each hop of the product chain timed alone in a real
Chromium against a real `wmlhost` (0.7.0) registered in a throwaway profile. Medians, with p90 and max in the notebook.

- Stop works. The blocked FS op throws `ErrnoError(EINTR)` when its slice check sees the interrupt word at 2; CPython's
  EINTR retry then runs its signal check and raises `KeyboardInterrupt`. 300 of 300 stops, over a blocked lookup, a
  whole-file read, a chunk of a 20 MB read, `os.listdir`, `os.stat` and a `try`/`finally` whose `finally` opens a
  second file; the same 300 of 300 under `lockdownReadonly`. CPython clears the word itself, the cleanup read in the
  `finally` is not interrupted again, the next cell and the mount are normal, and a late reply to the abandoned id is
  discarded by the worker's id check alone.
- Stop latency is the slice: uniform over 0 to 60 ms with a pure 50 ms slice. When the code that stores 2 also calls
  `Atomics.notify` on the channel's reply word, it is 0.05 to 0.09 ms. Route A therefore needs that notify beside the
  store in the offscreen document's Stop (`src/offscreen.ts`, `Atomics.store(flag, 0, 2)`), with the reply word in a
  buffer the offscreen document holds.
- One request: 0.26 ms end to end through the product chain (worker → offscreen → service worker → host → back, with
  a plain Worker standing in for Pyodide's and an extension page for the offscreen document; its hops, each measured
  alone: page ↔ service worker 0.13 ms, service worker ↔ host 0.11 ms, worker ↔ page 0.01 ms, the SAB wake under
  0.1 ms). The 50 ms slice never adds to it: a reply wakes the wait at once. Python and the FS node add 0.01 to
  0.02 ms per op.
- Whole files: 103 MB/s end to end in the host's 512 KiB `read` chunks (the host alone gives 200 MB/s; the relay
  through the service worker and the base64 decode take the rest), so 100 MB opens in about 1 s and 1 GB in about 10 s.
  In the worker, `f.read()` of one object fails at 2 GiB and above (`OverflowError`, or `MemoryError` at 4 GiB); a
  chunked read works to 4 GiB. A cap refuses before anything is allocated: the first reply carries the size.
- `os.walk` over this repository (21,498 files, 1,558 directories) costs requests, not bytes. With a readdir that
  returns names only, every entry is a lookup: 26,238 requests, about 7 s through the product chain. With a readdir
  that returns each entry's stat: 1,639 requests, about 0.55 s, and a second walk in the same cell with the listing
  cached per cell costs 34 requests. Without `node_modules` and `.git`, 189 requests, about 0.06 s. These seconds are
  the request count times the measured round trip plus the Node lab's walk time: an estimate composed from two
  measurements, which assumes the host answers a `stat` or a readdir as fast as the `hello` that was measured.
- `import` costs about 50 to 150 requests for a real package (pip's vendored `rich.table`: 149 read-only, 83 with
  `sys.dont_write_bytecode`), tens of milliseconds over the chain. A read-write mount writes `__pycache__/*.pyc` into
  the person's directory on the first import (51 puts and 51 renames for a 50-module package).
- The lockdown leaves the channel working at the same cost, the node's closures holding `postMessage`, the buffers and
  `Atomics` from before the strip. With the bridge refused, `import js` fails; with it lifted, a cell sees `Atomics`
  and `SharedArrayBuffer` (allowed globals) and can make its own buffer, but the probes found no name for the channel's
  buffers, the interrupt word, the port or the FS object. Not probed: ctypes, `/proc`, `sys.modules` internals.

**What follows** (proposed by the async lane; RULED 2026-11-13, the coordinator: all five as written; the 256 MB cap is
the coordinator's value, Shane may override).

- Route A, not B: Stop is 0.1 ms with the notify, a request 0.26 ms, and it holds under the lockdown. JSPI is not
  needed for either reason the spec gave.
- The host's mount readdir returns each entry's stat with its name, and the worker caches a directory's listing for
  the cell: without both, a walk of a real workspace costs sixteen times the requests. A host-lane requirement
  ("What window-ml-host must do").
- The size cap for an open, proposed 256 MB: about 2.5 s to fetch, an eighth of the 2 GiB where one `f.read()` fails.
  Shane's or the coordinator's value; the measurement only rules out anything at or past 2 GiB. H1's 64 MiB whole-file
  ceiling binds today.
- Bytecode on a read-write mount: set `sys.pycache_prefix` to a MEMFS path so an import never writes into the person's
  directory, and so the per-cell diff does not list `.pyc` files. Not measured; `dont_write_bytecode` was, and costs
  nothing on the first import.
- e3's rows gain one: a cell reaching the channel's buffers or the interrupt word through `Atomics`,
  `SharedArrayBuffer` or anything the bridge lifts.

**Initial decisions** (Shane, 2026-11-13: decided now, changed if they cause trouble).

- The cell's directory. With a workspace mounted, each cell starts in the workspace's real path, so a relative path
  means the same file in a cell as in `ml.sh`; with none, in `/files/agent/`, as ruled above (AMENDED 2026-11-19, the
  coordinator's layout call; this said `/files/`). Every cell still starts there afresh. So a bare
  `open("notes.txt", "w")` writes to the person's disk when a read-write workspace is mounted, as a coding agent's
  would; `/files/` is reached by its absolute path. RESOLVED 2026-11-22 (the coordinator): Shane's decision stands.
  The layout call of 2026-11-19 covers the case with no workspace mounted; with one mounted, a cell starts in the
  workspace's real path. A relative `ml.fs` path resolves against `/files/agent/` in both cases, since `ml.fs`'s disk
  is the session's files only.
- Approving a mount. Only the person mounts, per session, until they remove it. The model can ask through an approval
  card naming the real path, with two choices, "read and write" and "read only", neither preselected; it never mounts
  one itself. A page-started run never has a mount. A read-only mount fails a write with EROFS.
- Seeing what is mounted. The files panel has a group "From this computer", one row per mount with its mode and a remove
  action, and the run's banner a chip per mount. The model is told the mounts and their modes in one line. A cell's
  mount list names each mount by its real path, unscrubbed: a cell cannot expand `~`, and a path the model cannot open
  is worse than the username; everywhere else a path under the home is written as `~`.
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
- The size cap's value: 256 MB (ruled 2026-11-13) from the measurement above ("What follows").

**Owners.** This text, the diff row and the provenance of a file read from a mount: the chat-page lane. The channel and
the mount: the Pyodide lane. The host's scope check, the argv mapping and the `ml.sh` snapshot: the host lane, as
stated in "What window-ml-host must do" below.

### `/files` on the person's disk, when a host is connected (proposed 2026-11-13)

PROPOSED 2026-11-13, from Shane's rulings in the coordinator's session (what `ml.sh` is for, the setup, per-platform
mounts, the size limits, removing the disk, which copy is primary) and the files API (Shane's). Ruled since: one folder
per session and the sibling deny (ruling 91, 2026-11-20) and the folder's name (the coordinator, the same day). Nothing
of it is built: no session mounts a folder, and the host's H16 to H18 are not built. Where it disagrees with "Host
directories in the sandbox" above, this wins: the argv refusal on `/files/` goes away, and the `ml.sh` snapshot question
is answered by git.

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

- With a host mounted, the session's own folder in the workspace, `<workspace>/window-ml-files/<session folder>/`
  (ruling 91, "One folder per session" below), is primary, with the same layout (`attached/<handle>/<name>` read-only,
  `agent/` the run's, ruling 36). A cell's `open()` and `ml.sh` see one set of bytes, so a cell's write is there for
  the next `cp` with no sync between them. `cp`, `sed -i` and `open()` reach the uploads at
  `/files/attached/3fa91c2/data.csv` (on disk at
  `~/git/proj/window-ml-files/2026-11-20-q3-sales-7c41e2/attached/3fa91c2/data.csv`), with no `ml.sh.put` or
  read-back to teach the model; those stay as mechanisms, not as advice. Finder is the truth for the person; the panel
  is a view of the folder.
- The browser store (the shelf, read by range, "`/files/` read by range, and `ml.fs`") is then a capped backup, synced
  when convenient. A file over the quota lives on disk and is not backed up; the panel shows it with its size.
- With no host present, or when the host dies, the browser copy is the working store and the model works there, as
  today. The changes made meanwhile sync forward into the folder when the host returns.
- The sync covers that folder only, never the rest of the workspace. Authority: for `/files`, the folder while a host
  is mounted and the browser copy while none is; for everything else in the workspace, the disk, which holds its only
  copy.
- `/files` is the name the model uses, with a host or without one (Shane, 2026-11-13, replacing "the real path is the
  name the model is given"): without a host it is the only path there is, so a run reads the same either way. While a
  host is mounted, a cell's `/files` is backed by the folder (the same bytes `ml.sh` sees), and an `ml.sh` argv maps it
  (H9 below). The folder's real path also works, since it lies inside the workspace mount; the transcript, the diffs and
  the exports write it as `/files`, so one file has one name in the record. The model is told the real path in one line,
  for a program that prints it, with the home directory written as `~`
  (`~/git/proj/window-ml-files/2026-11-20-q3-sales-7c41e2`; Shane, 2026-11-13:
  model-facing text writes a path under the home as `~`, the run log keeps it raw). The rule for which form
  (coordinator, 2026-11-13): `~` is written only where its consumer expands it. `ml.sh`'s argv and cwd expand a leading
  `~` on a host with `hello.tilde`, so a path the model is to reuse in `ml.sh` (H9's refusal sentence, a mapped-path
  mention) is written as `~`. A path the model is to reuse in a cell (the mount list, a cell's own error or result
  naming a mounted path) stays raw, since nothing expands `~` in `open()`. Prose that names a path without expecting
  reuse writes `~`. Where the host cannot map an argv item (H9), it fails with `/files is on disk while the host is
  connected: ~/git/proj/window-ml-files/2026-11-20-q3-sales-7c41e2/x`.
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
run log keeps the raw paths a run used, so a later read without the host says where they were. A cell running when
the host goes gets "Unmounted or disconnected during a cell" (above): the next read through the mount fails.

**Sessions and mounts** (decided, Shane, 2026-11-13; the first bullet replaced by ruling 91, 2026-11-20):

- Each session mounting a repository has its own folder under `window-ml-files/`, and its browser copy stays its own
  ("One folder per session", next). REPLACED 2026-11-20 (ruling 91): this said that several sessions mounting one
  repository share one folder.
- Archiving or deleting a session never deletes anything on disk.
- With several mounts, one is the session's primary workspace, chosen at the first approval: cells start there and
  the uploads folder lives there.

**One folder per session** (RULED 2026-11-20, Shane's ruling 91 in the coordinator's session: "I think you need to do
the subfolder per session yeah"). Rulings 81 and 86 make each run's `/files` private and `/files/agent/` its home, so
one folder shared by every session mounting the repository cannot hold. The folder's NAME below was ruled by the
coordinator the same day.

- **The layout on disk.** `<workspace>/window-ml-files/` holds one folder per session, and only those. A session's
  folder holds ruling 36's layout: `attached/<handle>/<name>`, read-only to the model, and `agent/`, the run's. So
  `~/git/proj/window-ml-files/2026-11-20-q3-sales-7c41e2/attached/3fa91c2/data.csv` is that session's
  `/files/attached/3fa91c2/data.csv`. A session's folder is made when the session first mounts the workspace with a
  host that has H16 (`attached/` and `agent/` inside it); a session that never mounts one has no folder.
- **The model still sees `/files`.** Everything that names "the folder" in this section and in H9, H14 and H16 means
  the session's own folder: H9 maps `/files/x` to `<session folder>/x`, the sync and the watch cover that folder only,
  and the real path the model is told in one line is that folder's. Nothing that runs in a session ever sees
  `window-ml-files/` as its `/files`.
- **`.git/info/exclude`** holds one line, `/window-ml-files/`, written once for the workspace by the first session that
  makes a folder there and left in place after. So a new session adds no line and no other file is written.
- **The folder's name** (RULED 2026-11-20, the coordinator): `<date>-<slug>-<id6>`, as in
  `2026-11-20-q3-sales-7c41e2`. `<date>` is the session's creation day, local time. `<slug>` is the session's title at the moment the folder is
  made, lowercased, with every run of characters outside `a-z0-9` turned into one `-`, trimmed of `-` and cut to 32
  characters at a `-` where one falls; it is omitted, with its `-`, when the title is empty or the default. `<id6>` is
  the first six hex characters of the session id. Readable in Finder, sorted by date in a listing, and the id part
  tells two sessions of one title apart.
  - Stable under a rename: the name is fixed when the folder is made and recorded in the session's record (the folder
    name, beside the workspace's root). Renaming the session changes the panel's label, never the folder, so a path in
    a transcript, a diff or a script the person kept still names it. The panel shows the session's current title with
    the folder's name beside it.
  - A collision, a directory of that name that the session's record does not name (another session whose id shares six
    characters, or one the person made): the new folder takes the next free suffix, `-2`, `-3`, and records it. An
    existing directory is never adopted, never written into and never merged. The session's record, never the name,
    says which folder is a session's.
  - A folder the person renamed or moved in Finder is lost to its session: the next mount finds no folder by the
    recorded name and makes a new one, and the panel says `This session's folder 2026-11-20-q3-sales-7c41e2 is gone from
    ~/git/proj/window-ml-files; a new one was made.` The browser copy keeps working.
- **Sibling folders are refused by default** (ruling 91, the coordinator's addition confirmed by Shane on 2026-11-20).
  Every other folder under `window-ml-files/` lies inside the mounted workspace, so a cell or an `ml.sh` call could
  reach it by its real path. The host refuses it for every reader, by H17 below: a cell's `open()` through the mount, a
  path argument at `spawn`, a recursive reader's walk, and an interpreted script under the sandbox profile. The
  script's refusal holds only under the sandbox: with the sandbox off for the workspace, a script reaching a sibling
  is not bounded, H17's stated gap. The
  refusal names nothing of the other session: `window-ml-files/ holds other sessions' files, which this session cannot
  read; its own files are /files.` A listing of `window-ml-files/` shows this session's folder only.
- **Sharing between sessions** stays deferred (ruling 81). Shane's direction for later: the person may write a policy
  that lets a session read other sessions' folders, as a `show`-style entry in POLICIES.md's layers ("Hiding files",
  "Other sessions' files, later"). Not built and not scheduled.
- **What holds when.** With a host connected and the session's folder mounted (H16 on both sides), `/files` is backed by
  that folder, and the statement in "A session's files as a directory" and in "`/files`: the layout" that the host's
  disk never aliases `/files` does not hold for that session. Without a host, with a host older than H16, or before
  the session's first mount, it holds: `/files` is the browser sandbox's, and an argv `/files/x` is a host path.

**The folder must stay usable** (IDEA, Shane, 2026-11-21, in the coordinator's session; nothing assigned, nothing
built). Nothing above checks that the host can in fact read and write the session's folder; the one failure handled is
a folder renamed or moved away. Shane: the host should check that the permissions stay usable, repair what it can, and
tell the person what it cannot, for example in the inbox. The shape, for whoever builds it:

- **When it checks.** At each mount, the host creates, writes, reads back and deletes a probe file in the session's
  folder, in `agent/` and in `attached/`. It checks again when a real read or write in the folder fails with a
  permission error mid-run, so a change made while the session is open is caught at the call that meets it.
- **What it repairs.** Only the modes of the directories the host made itself (`window-ml-files/`, the session's
  folder, `attached/`, `agent/`), back to what it created them with. Never a file or folder the person made, never an
  owner, never anything outside `window-ml-files/`.
- **What it reports.** Anything else becomes one item in the person's attention inbox (`src/chat/attention.ts`) naming
  the folder, what failed (read, write or delete) and the step that fixes it. The causes to tell apart: a mode or
  owner the host may not change; macOS privacy permissions (the host binary not allowed into Documents, Desktop or
  iCloud Drive, a permission error no mode change repairs; which error each cause gives is a guess, not measured); a
  read-only volume; a full disk, which is the disk's limit below and gets its own wording.
- **What the model sees meanwhile.** The call that met the failure gets its error as today (`EACCES`, `EROFS`), and
  the session's next turn names the problem in one line. The browser copy keeps working, as for a folder that is gone.

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
  free tier narrows to the roots"), so the defaults and the person's policies are one list. AS BUILT for the browser copy: a hidden file's
  read is refused, not asked, and a `show` entry is the override (SECRET_HANDLES.md, the table at the top).
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

**The files API** (`ml.files.list()` and `ml.files.remove()`, proposed 2026-11-13 for use case 6). SUPERSEDED
2026-11-19 by `ml.fs` (ruling 60); its two rules are kept in "`ml.files` is superseded" above, and the quota refusal
that names `ml.fs.rm` is in "Writes".

**Dropped alternatives.**

- The browser store as primary with the folder a mirror: `ml.sh` would see a cell's write only after a sync, a race
  the model hits on its next `cp`; it needs an "on disk only" state for every file over the quota while mounted; and
  it buys only the local read path, which is #1780's measurement anyway.
- The disk as the only copy once a host connects, with the browser copy cleared: `/files` would stop working when the
  host is unavailable or dies, and the uploads are what the model is there to work on.
- A host-side copy of `/files` mapped into a container at `/files`: a second mirror, and it needs a container.
- No `/files` alias in a cell while a host is connected: dropped on 2026-11-13 (Shane), since `/files` is the only
  path without a host. The two-names objection is met by writing the real path as `/files` in the record.
- The folder in a fixed place in the home directory: it needs a mount of its own, and it is not where the person looks
  at their work.

**Red-team rows** (e3, through the coordinator): the sync reads and writes nothing outside the folder;
`.git/info/exclude` is the only other file the host writes on its own; a symlink or non-regular file in the folder is
never taken into the backup; a file over the quota is not backed up, by size or by growing after it was listed; a change
to `attached/` on disk never replaces the frozen original; a conflict keeps both copies; the git snapshot leaves the
person's index, HEAD and stash list unchanged; a delete git cannot undo asks, by every route (`os.remove`,
`ml.fs.rm`, an `ml.sh` `rm` judged by its manifest); an `ml.sh` program that runs code (`bash -c`, a manifest
saying `runs-code` or `unknown`, no manifest) asks whatever its argv; the first commit in a session asks; a cell's
`open()` of a file that looks like a secret asks, as an `ml.sh` read of it does; a page or a page-started run reaches
neither the folder nor `ml.fs`. AMENDED 2026-11-20 (ruling 91, for e3; H17 and H18): another session's folder under
`window-ml-files/` is refused to a session by its real path, by a `..` from the session's own folder, through a
symlink inside the workspace that points at it, by a recursive reader's walk from the workspace root, and by a script
under `ml.sh` (`python3 tool.py` opening it), each read and write; a listing of `window-ml-files/` shows the session's
own folder only; a script under `ml.sh` cannot write, create, delete or rename in `attached/` on disk; the refusal
names no other session; two sessions whose ids share six characters get two folders, and a directory the record does
not name is never written into.

**Open.**

- The folder's name (`window-ml-files/` is a proposal) and whether the person sets it per workspace. A session's
  folder inside it: ruled by the coordinator 2026-11-20 ("One folder per session").
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

**Owners.** This text, the panel's view of both copies, the sync's rules and provenance: the chat-page lane. `ml.fs`,
which replaced the files API: the session-store lane (the coordinator, under rulings 54 and 75). The mount, the fallback
and the Python binding: the Pyodide lane. The host's folder, the git snapshot and the per-request judging, the folder
watch: the host lane, as stated in "What window-ml-host must do" below (the folder, its `.git/info/exclude` and the
watch are H16, the step after H15).

### What window-ml-host must do for mounts, `/files` and `ml.sh` diffs (ruled 2026-11-13)

RULED 2026-11-13 (Shane: "fine for now", to be changed where building shows one wrong). BUILT in window-ml-host (its
log, 2026-11-22): H1 to H8 (host#40), H9 (host#43, with the extension's side in #1873), H10 (host#45), H11 (host#51),
H12 (host#54) and H13 (host#55); of H15, `hello` sends `mounts` and `filesArgv`, not `snapshot`. Not built: H13b,
H14, H16, H17 and H18, and the extension does not call the mount verbs yet (`docs/dev/shell.md`). The
coordinator's ruling (Shane, 2026-11-13): with this ruled, one host lane opens, in its own window-ml-host clone, and
takes the scope check (H1 to H8) first, then the argv mapping (H9), then the snapshot (H10 to H14) and the `hello` flags
(H15). It states as requirements on the host what the two sections above leave to "the `ml.sh` and window-ml-host
owner", and settles three places where they and `SHELL.md` disagree (named where each is settled, and listed under
"Ruled with it" at the end).

**One judge.** The host enforces the scope and the hard refusals, which no policy can lift, and resolves the facts. The
worker judges free or asks with the built-in default policy and the person's policies over those facts, as it already
does for an `ml.sh` call (`SHELL.md`, "Policies": a policy is a function over the facts the host resolved). A cell's
file request and an `ml.sh` call are judged by one mechanism over one list of facts. The mounts are the host's
configured roots (`configure`), one list, not a second one beside it.

**The scope check** (what a cell's `open()` through a mount reaches; "Host directories in the sandbox", "Security").

- H1. New host calls, each on a mount the host already holds: `mount`, `unmount`, `stat`, `list`, `fetch` (read a
  file), `store` (write a file), `remove` and `rename`. Every path in a request is relative to a mount and resolved on
  the host; a path the worker resolved is never trusted, since a `full` cell can forge a worker post.
  AMENDED 2026-11-13 (host lane): the calls were written as whole-file and mount-wide, which the host cannot bound.
  - A mount is per session and inside a configured root, with an id, a mode and the session string the worker stamps.
    `configure` stays the host-wide ceiling, and `ml.sh` keeps judging against the roots, so an `ml.sh` process is
    bounded by the roots, not by a mount, until H9's written operand.
  - `stat {mount, path}` returns H7's facts and the `basis` with no bytes. `fetch`, `store`, `remove` and `rename` carry
    the basis the worker judged on, so a judged call costs two round trips, accepted.
  - `fetch` is chunked by offset and length, 512 KiB a chunk, each chunk carrying the basis. `store` is staged as open,
    write and commit through the held descriptor, and the commit does the compare and swap (H8) and the rename. The cap
    is per call, from the worker, and the host clamps it to 64 MiB (provisional). RESOLVED 2026-11-22 (the coordinator;
    both figures were the coordinator's; files-host's reading of the host): 64 MiB is the most bytes a whole mounted
    file may have, for `fetch` and for `store` (the host's default and ceiling, `hello.put.max`), provisional; a larger
    file answers EFBIG (H5) before a byte moves. It is not a per-chunk clamp. 256 MB is the ceiling the worker will ask
    for an open and its before copy, not built: no caller passes a cap yet. So 64 MiB binds today, and the host raises
    it only with a measurement.
  - `mount` takes an optional `uploads` path, relative to the mount, which must exist with `attached/` inside it.
  - Path rule, on every platform: a mount-relative path refuses `\`, a leading drive letter (`C:`) and a leading `//`.
    Named cost: a unix file whose name contains a backslash cannot be reached through a mount.
- H2. `mount` refuses, by the resolved path and with the sentences above: a path at, under or above a reserved prefix
  (`/files`, `/tmp`, `/lib`, `/home/pyodide`, `/dev`, `/proc`); the home directory or above; a path at, under or above
  the browser profile, the archive folder or the host's own config; a path at, under or above an existing mount, so a
  read-only mount is never reachable for writing through a read-write one around it. The refusal is the host's, so
  the worker's copy of the list is a convenience, not the check.
  AMENDED 2026-11-13 (host lane): nesting is refused within one session only, since sessions do not share a mount;
  another session may mount the same or a nested path. A mount's mode bounds the session that holds it, not the
  directory: a second session's read-write mount around another's read-only one is that session's own grant, not an
  escape from the first. Stated limit: the archive folder cannot be refused by path,
  because the extension holds a File System Access handle with no path the host can see. The browser profile is refused
  by the known per-browser data directories, and the host's config means its state directory and `~/.config/wmlhost`.
  AMENDED 2026-11-13 (host lane): the refusal's code is `MountRefused`. A `configure` whose roots no longer contain a
  mount drops it, since the roots are the ceiling it was checked against; the connection closing drops every mount.
- H3. The host holds each mount's directory descriptor from `mount` and compares its device and inode on every request;
  a mismatch refuses the request and reports the mount as replaced.
  AMENDED 2026-11-13 (host lane): the id plus the session string is checked on every request. A host port cannot tell
  sessions apart, so the worker that stamps the session is the real check, and this is a stated trust: a forged post
  from a `full` cell is still refused on the facts (H1, H7, H8), and the session stamp is the worker's, never the
  cell's. AMENDED 2026-11-13 (host lane): the codes are `MountReplaced`, and `UnknownMount` for an id that is not the
  session's, worded as for an id that does not exist, so it tells nothing of another session's mounts.
- H4. A path is opened by walking its components from that descriptor with no symlink followed. `fsx::open_beneath`
  does this today (`openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` on Linux, a per-component `O_NOFOLLOW` walk
  elsewhere), but read-only and from a path; it is extended to start from the held descriptor and to open for writing.
  A symlink component anywhere in the path is refused this round, including one that points inside the mount (open,
  below). AMENDED 2026-11-13 (host lane): the walk is per component on both platforms, not `openat2`, since H6 must
  see each directory's device and inode to detect `attached/`.
- H5. `store` writes beside the file and renames into place, so a Stop or a dropped connection leaves the old file
  whole. A write through a descriptor whose `fstat` shows `st_nlink > 1` is refused; a read of one is allowed. A write
  to a read-only mount fails with `EROFS`; a `fetch` over the call's cap fails with `EFBIG` and carries the size.
  AMENDED 2026-11-13 (host lane): the cap is per call (H1) and the size is checked before any byte is read. The
  hard-link refusal's code is `HardLinked`, and `EFBIG` carries the cap beside the size. A replaced file keeps its
  permission bits (`0777` of its mode), and a new one gets `0666` less the umask, as `put` gives it.
- H6. In the uploads folder, a `store` into `attached/`, and a `rename` into or out of it, are refused by the host
  whatever a policy says, `attached/` being matched by its device and inode, never by name (APFS is case-insensitive, so
  `Attached/` is the same directory); a `remove` there is judged (it asks by default, the person's uploads). This is a
  hard refusal because `attached/` is the person's frozen originals and no policy the model can ask for should make it
  writable. AMENDED 2026-11-13 (host lane): the host holds the device and inode of the `uploads` folder and of
  `attached/` from `mount` (H1) and refuses any write whose walk passes through `attached/`.
- H6b. AMENDED 2026-11-13 (host lane): H2 to H8 were silent on protected names. A write through a mount to a protected
  name of its root (`sandbox::protected_rels`, as `put` has it) or to any path with a `.git` component, compared
  case-insensitively, is refused `Protected`, since writing `.git/hooks` is code execution. `remove` and `rename` act on
  regular files only: no directory, no symlink. A `rename` target must be absent (no-replace), and `EXDEV` fails and is
  never turned into a copy and a delete.

**The facts a request carries back** (H7), so the worker can judge it: `inMount`, the mount's `mode`, `secret` (the
host's `SECRET_PATTERNS`, the list an `ml.sh` path argument meets), `exists`, `ignored` (by git, `git check-ignore`
under the git belt), `inUploads`, `inAttached`, `gitUndoable`, and a `basis` for an existing file: `{ dev, ino, size,
mtimeNs, sha256 }` for a file at or under the diff cap, and `{ dev, ino, size, mtimeNs }` over it. Any fact a request
itself carries is ignored; the host computes every answer from the mount's held descriptor. `gitUndoable` is true for a
tracked file with no uncommitted change, false otherwise, and null when `repoConfigRunsCode` is true or null, since the
undo itself (a `git checkout` of the file) would run the repository's smudge filter or hooks. AMENDED 2026-11-13 (host
lane): `stat` also returns `kind` (`file`, `dir`, `symlink`, `other`, or null when absent), `protected` (H6b's rule, so
the worker can say why before it asks) and `hardLinked` (H5's `st_nlink > 1`); `gitUndoable` is false for a file that
does not exist and for a path in no repository. AMENDED 2026-11-13 (host lane): `ignored` is null, as `gitUndoable`
is, when `repoConfigRunsCode` is true or null, so no host query reads such a config, and null when git cannot be asked.

AMENDED 2026-11-13 (host lane): the host's own git queries (`check-ignore`, the undoability check, the snapshot) each
spawn git with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and an explicit `GIT_DIR` and `GIT_WORK_TREE`,
besides the belt of H11. `gitUndoable` is computed by comparing `git hash-object --no-filters` of the file with its
index entry and its `HEAD` entry, with no content-comparing git command; a file marked assume-unchanged or
skip-worktree reads as false.

- H8. Compare and swap. A `store`, `remove` or `rename` that the worker judged on a fact carries the `basis` it was
  judged on, and the host refuses it with `ChangedSinceJudged` when the file's basis differs at the moment of the
  write, including when the file was deleted (never silently recreated) or replaced by a directory. Without it, a file
  judged free as git-undoable could be edited between the judgment and the write and then lost. The `sha256` is there
  because an in-place edit that keeps the size and restores the mtime defeats the other four (e3, 2026-11-13). Decided:
  over the diff cap the basis has no hash, so such an edit goes unseen, and the card for a write or delete of such a
  file says it was judged by size and modification time. AMENDED 2026-11-13 (host lane): a missing basis on an existing
  file is `ChangedSinceJudged`, and the worker keeps the basis it judged on and never takes one from the cell. Residual,
  stated: the compare and the rename are not atomic against a concurrent writer; the window is one `fstat` and hash,
  bounded by the descriptor walk (H4).

**`/files` in an `ml.sh` argv: mapped, not refused** (H9; Shane, 2026-11-13). The commonest calls name it: copying an
upload out of `attached/` into the writable part of `/files`, then from `/files` into the project (`cp
/files/attached/3fa91c2/data.csv /files/data.csv`, `cp /files/data.csv src/`). Settles the first disagreement, where
"Host directories in the sandbox" refuses a `/files/` argv item and "`/files` on the person's disk" both drops the
refusal and gives a sentence for it:

- A pointer token of any prefix stays refused on the extension side, before the call reaches the host (`sh-call`), as
  now.
- While a host is connected, at `spawn` the host maps an argument the program's manifest marks as a PATH, when it
  equals `/files` or starts with `/files/`, to the same path under the folder's real path
  (`~/git/proj/window-ml-files/2026-11-20-q3-sales-7c41e2/data.csv` as the model sees it; the session's own folder,
  ruling 91), and the call's `cwd` likewise. The mapped path then
  carries the facts like any other path argument: the host refuses at `spawn` a call that WRITES a path in
  `attached/` (H6's rule, for a process), and an overwrite git cannot undo still asks.
- Which operand is written comes from a manifest field naming it (the last operand for `cp` and `mv`, every operand
  for `rm`), since today's `paths: "operands"` and a call-wide effect (`write-names`) do not say which position is
  read and which is written. A program whose manifest has a writing effect and no such field has every path operand
  treated as written, which fails closed: such a call naming a path in `attached/` is refused, even as a source.
- An argument the manifest marks as anything else (a pattern, a message, a value) is never mapped, so `rg '/files/' .`
  searches for that text.
- An option with a value (`--out=/files/x`, `-Dkey=/files/x`) is split the way the manifest's flag description says
  (`valueIsPath`, a path argument's `split`). An item the manifest does not place is checked at its start and after its
  FIRST `=` only, as a stated rule: named cost, a `/files` path after a second `=` (`--set=a=/files/x`) is not seen,
  reaches the program as written and names nothing on the disk.
- The folder's real path is an ordinary path argument, allowed like any other in the mount, so `cp` from its
  `attached/` and `mv` out of the folder work by either name (e3's positive row: a host that refused anything naming
  the uploads folder would break use cases 2 to 4).
- A `/files` argument the host cannot place, because the program has no manifest or the manifest does not describe
  that position, is refused with the sentence of "`/files` on the person's disk" naming the real path:
  `/files is on disk while the host is connected: ~/git/proj/window-ml-files/2026-11-20-q3-sales-7c41e2/data.csv`.
  Such a call asks
  anyway (no manifest), so the refusal costs one retry with the real path.
- The call's record keeps both forms, the argv the model wrote and the argv the process got. The model sees a mapped
  path with the home written as `~`; the run log keeps both argvs raw, and the sidebar and both exports show both
  ("the log carries what the model saw").
- The alias exception of the first section is kept for a host that has a `/files` directory of its own, where the
  argument is the host's file and nothing is mapped.
- A cell's `/files` is backed by the folder while a host is connected ("`/files` on the person's disk"), so
  `/files/x` names the same file in a cell's `open()` and in an argv.
- Needs a `cp` manifest (`src/shell/manifests/`): operands as paths, as `mv.json` has, and the written-operand field
  naming the last operand. It is H9's second step, in the host lane after the mapping: the manifest, the field in both
  readers (`describeCall` in `program-manifest.ts` and the host's `manifest.rs`, per `docs/spec/PROGRAM_MANIFEST.md`)
  and the vectors (`VECTOR_PIN` moves on both sides), with fail-first adversarial rows and e3's pass, since it is a new
  agent write path. It landed in #1873 and window-ml-host#43; before them, both `cp` calls above were refused with the real-path sentence.
- AMENDED 2026-11-13 (host lane), as built:
  - `writtenOperands: "last"` is the field (`PROGRAM_MANIFEST.md`), on `cp` only. `mv` carries none: its sources are
    removed, so every operand is written, and `mv` out of `attached/` stays refused as the table says (the sentence
    above naming the last operand for `mv` is the narrower reading, and is not taken). Every path argument now
    carries its `role`, read or write, in both readers and the vectors.
  - The worker refuses what cannot be placed, before `spawn`, since it holds the manifest: a call with no manifest, or
    one its manifest's parse does not describe, naming `/files` at an argument's start or after its first `=`. Placing
    is the parse alone: the program's version and the call's environment are not known at that point and move no
    argument, so `rg TODO /files` is placed before the host reports rg's version (and still asks until it does).
  - The host maps, at `spawn`, the `pathArgs` entries (the whole argument, or the part after `split`) and the cwd
    that are `/files` or start with `/files/`, to the uploads folder of the mount `spawn.files` names (`{mount,
    session}`, checked as every mount request is, H3). The rest after `/files/` must pass the mount-relative path rule
    (H2): `/files/../x` is refused, never resolved. The facts list each mapping as `files: [{index, from, to}]`,
    beside `tilde`, and the card shows both forms. `hello.filesArgv: true` says the host maps; the worker sends
    `files` only then, since an older host would ignore it (H15).
  - The host refuses at `spawn`, with `InAttached`, a call whose path argument with `role: "write"` resolves into a
    held `attached/` (by its realpath and by the device and inode of each existing ancestor), whichever name the call
    used; an absent `role` reads as read.
  - So does a written path the program walks (`rm -r`, `cp -R`, every `mv` operand) that holds a held `attached/`
    beneath it: `rm -r /files` and `cp -R x/attached /files/` would change `attached/` without naming it. Named cost:
    `mv notes.txt /files/` is refused, and `mv notes.txt /files/notes.txt` runs. The refusal teaches that retry, naming
    the path as the call wrote it, and the step's result shows it: `/files/ holds attached/, which a recursive write
    there could change: name the file instead, as in mv notes.txt /files/notes.txt rather than mv notes.txt /files/`.
  - A `/files` token in an argument that is not a `pathArgs` entry, with `spawn.files` set, passes through the host
    literally: never mapped, never refused. A stated trust beside H3's: the host holds no description of the call, so
    it cannot tell a pattern (`rg '/files/' .`, which must reach `rg` as written) from a path the manifest did not
    place, and the worker's refusal before `spawn` is the check. A token that slips past reaches the program as the
    literal `/files/…`, which names nothing on the host's disk unless the host has a `/files` of its own (the alias
    exception above).
  - No session mounts an uploads folder until H16, so no call sends `files` yet and `/files` stays the browser
    sandbox's in an argv.

**The `ml.sh` snapshot** (H10 to H14). Settles the second disagreement: "Diffs from git" takes the snapshot with
`git add -A` into a scratch index, which writes a blob for every changed file into the repository's object store, and
its own red-team row says `.git/info/exclude` is the only other file the host writes. The snapshot below writes
nothing into the repository.

- H10. Before and after each `ml.sh` call in a git workspace, the host builds a tree with a scratch `GIT_INDEX_FILE`
  (a copy of the person's index, for its stat cache) and a private `GIT_OBJECT_DIRECTORY`, both in the host's own
  directory, with the repository's object directory as an alternate (`GIT_ALTERNATE_OBJECT_DIRECTORIES`). The person's
  index, HEAD, stash list and object store are unchanged; the private directory is deleted when the diff is made.
- H11. Changed files are hashed with `git hash-object -w --no-filters --stdin-paths` and entered with `git update-index
  --index-info`, never `git add` or `update-index --add`, which run a clean filter. Every git spawn carries the git belt
  (`core.fsmonitor=false`, `core.pager=cat`, `GIT_OPTIONAL_LOCKS=0`), so no filter, textconv, fsmonitor or hook runs.
  Untracked files are included; ignored files are not, except the uploads folder. The snapshot runs whatever
  `repoConfigRunsCode` says: the belt, `--no-filters`, `--no-ext-diff` and `--no-textconv` leave no path by which the
  repository's config runs a program, and the e3 row with a clean filter, an fsmonitor and a hook configured is the pass
  condition for that case too. AMENDED 2026-11-13 (host lane): the belt alone was not enough, since the person's global
  config (`git lfs install` sets `filter.lfs.clean`) also runs a program; H7's `GIT_CONFIG_GLOBAL` and
  `GIT_CONFIG_NOSYSTEM` close that. AMENDED 2026-11-17 (host lane, found building H10): nor for a spawn that writes the
  scratch index (`write-tree`, `read-tree`, `update-index`). The write runs the repository's `post-index-change` hook,
  and its check of a racily clean entry reads the file through the clean filter, at the entry's path from the process's
  directory, since `write-tree` never enters `GIT_WORK_TREE`. So each scratch spawn also sets `core.hooksPath=/dev/null`
  and runs in, and names as `GIT_WORK_TREE`, an empty directory of the scratch store (window-ml-host `src/snapshot.rs`).
  The changed set is the host's own stat comparison against the scratch index, not a git status. AMENDED 2026-11-19 (the
  coordinator's call): an untracked file whose path looks like a secret (the host's `facts::looks_secret`: a dotenv name
  other than the three templates, `*.pem`, `id_*`, a credentials directory such as `.ssh` or `.aws` among its
  components) is never entered, inside the uploads folder or out, so it is in neither tree and the diff draws no body
  for it. It is not silently absent: the name rule also matches ordinary files (`id_*` matches `id_utils.py`), so its
  path joins H12's not-captured list with the reason "withheld: the name looks like a secret". That list is H12's. A
  tracked one is H13's.
- H12. Bounds: no file over the diff cap (1 MB, "The diff's cap") goes into the tree; it is compared by size and
  sha256 instead. The walk stops at `WALK_CAP` (20 000) entries; past that the call's diff is null with the reason.
- H13. The diff is `git diff-tree --no-ext-diff --no-textconv` of the two trees. Its body goes out as held output (a
  pointer, as stdout does), and `done` carries the summary line (`edited a.py (+3 −1); deleted old.log`). A change is
  reported as "changed during this call", never attributed to the call's process, since another process may have written
  meanwhile. An orphaned call's snapshot reports through `status`/`ended`, as `protectedChanged` does. A workspace that
  is not a git repository gets a null diff (open, as in the section above). AMENDED 2026-11-19 (the coordinator's call):
  the body of a file whose path looks like a secret never reaches the model through the diff, tracked or untracked. A
  tracked one that changed is listed by path as "changed, contents withheld", with no line of its body in the held
  output or the summary. "Changed" includes a deleted tracked file (no line of the old body) and a mode-only change. By
  the coordinator's call, a blob shown under an ordinary name is withheld the same way when its id equals the blob of a
  path that looks like a secret in either tree: `cp .env notes.txt` of a tracked `.env`, or `git mv .env notes.txt`,
  shows `notes.txt` as "changed, contents withheld". The scrub by value (#1948) is the second layer under this rule,
  never the reason to show a body. A name says nothing of a hardlink to a held file under another name, a copy of an
  untracked secret file (its blob is in neither tree to compare), an edited copy, or a secret in an ordinary file: those
  reach the diff, and only the scrub by value stands between them and the model.
  AMENDED 2026-11-19 (the coordinator's calls, on the host lane's questions while building H13). (1) The orphan
  report is split out as H13b, a later change of the host lane's. Until it lands an orphaned call's `ended` carries
  `diff: null` with a `diffReason` saying an orphaned call's diff is not reported; it is never an absent `diff`. (2)
  On `done`, `diff` is `{ ptr, size, sha256, truncated, summary, fromHead }`, or `null` with a `diffReason` ("not a
  git repository"); an absent `diff` means an older host. (3) A withheld path reads `changed <path> (contents
  withheld)` whether it was added, edited, deleted or only changed mode, with no size, hash or line count, in the
  over-the-cap list too. (4) The empty blob is left out of the blob-id match, since an empty tracked `.env` would
  otherwise withhold every empty file; an empty file whose own path looks like a secret is still withheld by name.
  (5) Past 1000 withheld or reconciled paths the patch is left out whole and the change list stays; the body and the
  summary say so, with the count. (6) A file that crosses the diff cap during the call, or stops or starts being
  captured, reads `edited <path> (was/now over the diff cap)` or `(was/now not captured: <reason>)`, with no patch.
  A big file of unchanged size with no hash in either snapshot (past H12's budget) reads `not compared`. An
  untracked file withheld by name in both snapshots is not named as a change; every not-captured path is listed in
  the body after each call. (7) The report is always on: every call whose repository is the working directory's, or
  the one its arguments name, is snapshotted, with no opt-out. A pipe snapshots its first stage's repository only.
  The host lane's measurement (release builds, start to done for `true`): about 170 ms on a clean clone of 2 215
  files, about 315 ms at 19 000 clean files, 1.6 to 1.9 s at 19 000 files with every stat changed.
- H14. The diff's file list is what the call's end flushes to the browser backup ("The sync").

**Telling an old host apart** (H15). `hello` gains `mounts: true` and `snapshot: true` (and `filesArgv: true`, H9;
AMENDED 2026-11-13, host lane). Their absence means an older
host: the worker treats mounts and diffs as unavailable, never probes by calling. The `~` form in H9's sentence
depends on `hello.tilde`: a host without it gets the raw path in that sentence, so the retry it teaches works on both.

- H16. AMENDED 2026-11-13 (host lane): the step after H15, in the host lane. Creating the uploads folder, writing
  `.git/info/exclude` and the folder watch ("`/files` on the person's disk" names them), so the Owners line above and
  this list agree. AMENDED 2026-11-20 (ruling 91): the uploads folder is the session's own folder,
  `window-ml-files/<session folder>/`, which the worker names in `mount`'s `uploads` (H1), and the exclude line is
  `/window-ml-files/`, written once ("One folder per session").
- H17. PROPOSED 2026-11-20 (ruling 91; the mechanisms are the spec writer's guesses for the host lane to correct).
  Other sessions' folders are refused, by default, for every reader. The host takes the parent of `mount`'s `uploads`
  as the sessions folder and holds its device and inode beside the session's own folder's, as H6 holds `attached/`.
  Every refusal is the code `OtherSession` with the one sentence of "One folder per session", which names no other
  session's folder.
  - A cell's request: the walk (H4) refuses a path that passes through the sessions folder into any child but the
    session's own, matched by device and inode, so a `..`, another spelling or another case reaches the same check; a
    symlink is refused by H4 already. A `list` of the sessions folder answers the session's own folder only.
  - At `spawn`: a path argument or the `cwd`, read or written, whose realpath or an existing ancestor's device and
    inode lies in the sessions folder outside the session's own folder. A symlink elsewhere in the workspace that
    resolves into a sibling is caught by the realpath.
  - A recursive reader (`rg pat .`, `find`, `tar`) whose directory argument holds the sessions folder beneath it is not
    refused under the sandbox, which hides the siblings (next), so the walk passes them by. With the sandbox turned off
    for the workspace, the host's bounded walk (the one behind `containsSecret`) gains `containsOtherSession`, and a
    call where it is true is refused with the sentence plus `name a directory that does not hold window-ml-files/`;
    past the walk's cap it is `unknown` and the call asks.
  - The sandbox profile, for a script the argv does not describe (`python3 tool.py`, `node x.mjs`, `bash -c`): on
    macOS, read and write denies on the sessions folder's subtree, then an allow of the session's own folder (SBPL's
    later rule wins), with H18's `attached/` deny after both; on Linux, a tmpfs over the sessions folder with the
    session's own folder bound back over it, since Landlock grants and cannot deny beneath a grant. Applied under
    every envelope, an absent one's floor included; if the floor cannot carry it, the host lane says so and such a
    call asks. With the sandbox off, a script reaching a sibling is not bounded: a stated gap, beside the sandbox-off
    gaps `SHELL.md` already states.
  - Lifted only by a policy, later (POLICIES.md, "Other sessions' files, later"), and then for reading only.
- H18. PROPOSED 2026-11-20 (the coordinator's question under ruling 91, with e3). `attached/` under the sandbox profile.
  H6 refuses a cell's write into `attached/` and H9 a process's write when its argv names a path there, but a program
  that runs code (`python3 tool.py`) can write into `attached/` with no argv naming it: the profile confines writes to
  the roots, `attached/` lies inside a root, and the protected names (`sandbox::protected_rels`) do not include it. The
  `runs-code` ask does not close this, since the person approving `python3 tool.py` is not told it writes `attached/`.
  So the profile denies write, create, unlink and rename under each `attached/` the host holds, by its realpath (on
  macOS a `file-write*` deny on the subpath; on Linux a read-only re-bind, as the protected names get), under every
  envelope, an absent one's floor included. With the sandbox off it is not bounded for a process, a stated gap; the
  backstop is the browser copy, which keeps the frozen original whatever happens on disk ("The sync").

**What runs free, what asks, what is refused.** AMENDED 2026-11-13 (host lane): the `EROFS` row is a cell's store; an
`ml.sh` process is bounded by the roots until H9's written operand lands (H1). The default policy's rows, each with the
fact that backs it. "Refused" is the host's and no policy changes it; "asks" is the default, which a policy may change
either way. Rows compose: every row that applies to a request is taken, and the most restrictive decides, refused over
asks over free (a new file in a read-only mount is refused, a new file in `attached/` is refused, a secret-looking file
in the uploads folder asks). The host applies its refusals before the worker judges. AMENDED 2026-11-13 (host lane,
ruled by the coordinator): the one named exception to composing is the uploads folder outside `attached/`, where the
uploads row replaces the three `gitUndoable` rows instead of composing with them. The folder is git-ignored by design,
so `gitUndoable` is always false there, and composing would make every overwrite in the uploads folder ask, against
the use cases of "`/files` on the person's disk". The secret, read-only, protected, hard-link, `attached/` and `basis`
rows still compose with it.

| Operation | Default | Backing fact |
| --- | --- | --- |
| read in a mount | free | `inMount` |
| read of a file that looks like a secret | asks | `secret` |
| any write to a read-only mount | refused (`EROFS`) | `mode` |
| a write to a secret-looking name | asks | `secret` |
| write or delete of a file git can undo | free | `gitUndoable` true |
| write or delete of a file git cannot undo (untracked, ignored, uncommitted changes) | asks | `gitUndoable` false |
| the same when git cannot be asked | asks | `gitUndoable` null |
| a new file | free | `exists` false |
| anything in the uploads folder outside `attached/` | free | `inUploads` |
| delete in `attached/` (a cell's `remove`; a process's delete there, `rm` through `ml.sh`, is refused at `spawn` with `InAttached`, H9: a process's walk cannot be judged per file) | asks | `inAttached` |
| write into, or rename in or out of, `attached/` | refused | `inAttached` |
| a path outside every mount, through a symlink, or after the mount was replaced | refused | H3, H4 |
| a write through a hard link | refused | `fstat` `st_nlink` |
| a write to a protected name of the root, or under any `.git` (AMENDED 2026-11-13, host lane: H6b) | refused (`Protected`) | `protected` |
| a write whose basis changed since it was judged | refused (`ChangedSinceJudged`) | `basis` |
| a `/files` path argument | mapped to the real path, then judged as it | H9, the manifest |
| any read or write in another session's folder under `window-ml-files/` (AMENDED 2026-11-20, ruling 91: H17) | refused (`OtherSession`) | H17 |
| a write into `attached/` by a process its argv does not describe (AMENDED 2026-11-20: H18) | refused by the sandbox profile | H18 |
| a `/files` argument the manifest does not place | refused | H9 |
| `git status`, `git diff`, `git add` | free | the manifest, `repoConfigRunsCode` false |
| the first commit in a session | asks | extension side |
| later commits on the current branch | free | extension side |

The `Window-ML-Run:` commit trailer and the first-commit-in-session state are the extension's, not the host's.

Settles the third disagreement: `SHELL.md`'s "the sandbox widens the free tier" makes a sandboxed write inside the
roots free, and "`/files` on the person's disk" makes a delete git cannot undo ask. The proposal: both hold, because
they bound different things. The sandbox bounds WHERE a write lands; `gitUndoable` bounds whether it can be taken
back. So under the sandbox a write that creates a file, or touches one git can undo, is free, and an overwrite or
delete of one git cannot undo asks, for a cell and for an `ml.sh` call whose manifest names the path.

**Red-team rows** (e3, through the coordinator, 2026-11-13; each a test that fails first, with its pass condition):

- The scope (H1, H4). A forged request for a path outside the mount, by `..`, a symlink component or an absolute path,
  enumerated per platform: `/etc/passwd`, `C:\x`, `C:/x`, `\\?\C:\x`, `//server/share/x`, a `..\` component on Windows,
  an interior NUL, a path of only `..` components; the absolute forms refused as not relative, `..` as escaping the
  mount. AMENDED 2026-11-13 (host lane): `\`, a leading drive letter and a leading `//` are refused on every platform
  including unix (H1), so a unix file named `a\b` is unreachable; and a write to a protected name or a `.git`
  component, in any case, gets `Protected` (H6b).
- A forged post (H1, H7). A worker post from a `full` cell gets an answer computed from the held descriptor only; any
  fact field it carries (`basis`, `inMount`, `mode`, `gitUndoable`, `secret`, `exists`) is ignored. AMENDED 2026-11-13
  (host lane): `stat` and each `fetch` chunk are included, and a forged `session` string is the worker's trust (H3).
- Mount ids are not a capability (H1, H3). A request naming a mount another session made is refused, unmounting
  another session's mount is refused, and a request on an unmounted mount is refused even with its old id.
  AMENDED 2026-11-13 (host lane): the refusal is on the id plus the session string, every request; a request with the
  right id and another session's string is refused, and the same or a nested path mounted by another session is not.
- What may be mounted (H2). A mount at, under or above each refused path, by its resolved path, and at, under or above
  an existing mount of the same session; a second session's mount of the same path succeeds.
- The mount replaced (H3). The mounted directory replaced by another real directory on the same device, so only the
  inode comparison can refuse it; the replacement report reaches the person.
- The race (H4). A component swapped for a symlink between two requests, and inside one: a rename loop swapping a
  component for a symlink to an outside directory against one long `fetch` or `store` never reads or writes outside
  the mount.
- `list` never traverses a symlinked entry (it is listed as a symlink), refuses `..` or an absolute input, and lists
  only the mount's own entries.
- `rename` with a source or target outside this mount, or in another mount, is refused, never degraded to a copy and
  a delete.
- Writes (H5). A write through a hard link is refused. A write to a read-only mount under a policy allowing everything
  gets `EROFS` from the host, with nothing created beside the target or under a temporary name. A `store` interrupted
  mid-transfer leaves the old file whole. A symlink or hard link planted at the temporary name is not written through
  and the target is untouched; no temporary file remains after a success, a failure or a Stop.
- A `fetch` past the cap answers `EFBIG` with the size, without the host reading the file (H5). AMENDED 2026-11-13
  (host lane): the cap is the call's, clamped to 64 MiB; a chunk carries offset and length at most 512 KiB, and a chunk
  with a missing or stale basis is `ChangedSinceJudged`.
- `attached/` (H6). A `store` into it and a `rename` into or out of it are refused under every policy and under every
  case variant of every component; a write into it is refused by `/files` and by its real path alike.
- The facts are true on a fixture repository (H7). `gitUndoable` true only for a tracked file with no uncommitted
  change, false for a modified, an untracked and an ignored one; `secret` true for `.env` and an `id_rsa`-shaped name
  from the `ml.sh` list; `ignored` true for a `.gitignore`d file and false for a re-included one; `exists` false for a
  new file.
- Compare and swap (H8). A git-undoable file edited by another process between the judgment and the write, including the
  cap's boundary both ways: a file AT the cap has a sha256 in its basis and a same-size, same-mtime edit to it is
  `ChangedSinceJudged`, while a file OVER the cap is judged by size and mtime and its card says so; the file deleted
  (refused with `ChangedSinceJudged`, not recreated); the file replaced by a directory.
- The argv mapping (H9). A `/files` item in each form, bare and after `=`, mapped only in a manifest's path position
  and refused where the manifest does not place it; a pattern argument left alone; an option split as its manifest
  says; a `cp` out of `attached/` allowed and into it refused; a writing manifest with no written-operand field refused
  when any operand is in `attached/`. Positive: the folder's real path as an argv item works for `cp` from `attached/`
  and `mv` out of the folder.
- The snapshot writes nothing into the repository (H10, H11). The person's index, HEAD, stash list and object store
  stay byte-identical, with a clean filter, an fsmonitor and a hook configured that would each leave a mark if run.
  AMENDED 2026-11-13 (host lane): and with a global `filter.lfs.clean` configured in the person's own git config.
  The scratch index and the private object directory live outside the worktree and are gone after the diff; a build
  that drops `GIT_OBJECT_DIRECTORY` turns this row red.
- What the snapshot takes (H11). An ignored `.env` never enters a tree; an ignored file inside the uploads folder does;
  an untracked file the call creates appears in the after-tree. AMENDED 2026-11-19: an untracked `.env.local` that is
  not ignored, and an untracked `id_ed25519` inside the uploads folder, enter neither tree; an untracked ordinary file
  beside them still does. An untracked `id_utils.py` is in neither tree and is in the not-captured list with the name
  reason.
- Bounds (H12). A workspace with a FIFO, a socket and an unreadable file snapshots within budget and lists them as not
  captured, never opening them. A changed file over the cap is reported by size and sha256, never its body; a file
  under the cap whose only change is its mtime is not reported.
- The report (H13). The body goes out as a held pointer and `done` carries only the summary line; a change by another
  process reads "changed during this call", unattributed. AMENDED 2026-11-19: a tracked `.env` the call changed is
  listed as "changed, contents withheld", and no line of its old or new body is in the held output, the summary, the run
  log or either export. A tracked `.env` the call deleted is listed the same way, with no line of its old body. `cp .env
  notes.txt` of a tracked `.env` lists `notes.txt` as "changed, contents withheld", with no line of its body.
- An old host (H15). With a `hello` carrying neither field the worker sends no `mount`, `fetch`, `store`, `list`,
  `remove`, `rename`, `stat` or snapshot call and no probe; `mounts: "yes"`, `1` or `{}` read as absent.
- Pages, four ways. Each new message type is refused at the router from a page, the host seeing nothing; a
  page-started run cannot mount or have a cell's calls made for it; an approved exec in the page's world cannot reach
  them through the dialect; each type is absent from `HANDLE_MAP`, `PAGE_STARTED_TYPES` and `RUN_CONTROL_TYPES`,
  enumerated.

**Open.**

- A symlink inside a mount that points inside it (a repository's `node_modules/.bin`): refused this round by H4; whether
  to follow one whose target resolves inside the same mount is a later question. So is a mount nested in another
  of the same session, refused by H2, with one mode followed through the nesting. AMENDED 2026-11-13 (host lane):
  nesting across sessions is allowed (H2), so only the same-session case stays open.
- The git queries per request (`check-ignore`, the undoability check) cost a spawn each; whether the host batches them
  per cell or caches them by `basis` is the lane's to measure.
- AMENDED 2026-11-13 (host lane), for H10 to H14, owner the host lane, each measured first: H12's before-hash of files
  over the cap (hash only the stat-changed files, or a cache by basis); H13's orphan report keeps the private object
  directory beside the ledger; a copied index breaks on a split index (`sharedindex`), so H10 falls back to building
  the tree from `HEAD`.
- AMENDED 2026-11-19 (host lane, H12, each measured first). The before-hash of a file over the cap comes from a cache
  keyed by the whole stat (device, inode, size, mtime and ctime to the nanosecond), held for a call's two snapshots,
  with a budget of 2 GiB of uncached bytes per snapshot; past the budget a big file is listed with its size and no
  hash. A hash is kept only when the file's mtime and ctime are both more than 2 s before the read began (git's
  racy-clean rule: a same-size rewrite inside one tick of a coarse filesystem keeps the whole stat); otherwise the
  file is read again at every snapshot. "Not captured" means out of the tree, tracked or not, so a file that crosses the cap or turns unreadable
  during a call shows as an add or a delete in the tree diff, and H13's report reconciles that with the lists. Git
  lists no FIFO, socket or device, so the host finds them by type in the directories the listings reached and never
  opens one; an ignored one is left out except in the uploads folder. Known limit: one in a directory holding no file
  git lists is not found, and it is in no tree either. `WALK_CAP` counts tracked and untracked files, not ignored
  ones, and is checked before any file is read. A changed set whose listing passes 1 MiB (about 25 500 files) errors
  where it once hung.

**Ruled with it** (Shane, 2026-11-13): the three settlements, the argv refusal replaced by a mapping in path positions
(H9), the snapshot writing nothing into the repository (H10), and the sandbox and `gitUndoable` both holding (the
paragraph under the table).

**Owners.** This text: the chat-page lane, until the host lane opens. H1 to H16: the host lane, one lane in its own
window-ml-host clone, scope check (H1 to H8) first. The worker's judging of the facts and the table's default policy:
the `ml.sh` extension side (`docs/dev/shell.md`).

**The person deletes or moves a file.** The files panel can delete, rename and move files in the writable part.
During a live run the model is told the file's name through the run's inbox, the same as any other notice; a move is a
delete plus a new name. The change goes through the reader, so the next cell sees it (every cell remounts, #2026), and a
descriptor already open keeps the version it pinned until it is closed. AMENDED 2026-11-19: this said the offscreen
document pushed the unlink or rename into each live worker's MEMFS (item 1). Uploading straight into the writable part
waits: the model copies from `attached/` (session-store's account: a person cannot upload into `agent/`, but can
rename, move and delete there).

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
- one session's `/files/` seen by another session's cell (AMENDED 2026-11-19: a worker serves one run's session, and
  no shared worker gets a mount; the row asserts both);
- a cell reaching the hook closure or `post` (a lifted-bridge or introspection route; not measured);
- a page-started run, or a page, reading `/files/` or any file in it;
- a model-made file described to the model as attached by the person, in every sentence that names a file.

**Not measured** (of the MEMFS mount, items 1 and 3, both superseded; kept as the record). A terminate racing the last
post (the ack is there for it); a lifted-bridge route to the FS object; anything in a real browser worker rather than
Node; WORKERFS over posted Blobs (item 1); the audit hook under the
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

- The quota's value and where it is set: a DevTools Settings flag, by the standing rule for a new setting. AMENDED
  2026-11-17: nothing loads at start any more, so the quota is a disk quota, not a start-time budget ("`/files/` read
  by range, and `ml.fs`", "Writes"); SETTLED 2026-11-19 (the coordinator): `filesQuotaMB`, default 1024 per session.
- A post arriving for a path the person deleted or renamed during the run. The lean: it is kept under the written name
  as a new file, and the inbox notice says so, since the delete removed the old bytes, not the model's work.
- Whether a frozen version's provenance "read from disk <path>" may reach a page through `dereference`, or is scrubbed
  like an error's text (`sw-scrub.ts`).
- Whether the restricted dialect gets a write of its own (a `keep()` call) is open and not proposed.

## `/files`: the layout, `ml.fs`, Python's mounts and the backup (rulings 22, 23, 35, 36; proposed 2026-11-18)

Shane's rulings 22, 23, 35 and 36 (2026-11-17 and 2026-11-18, in the coordinator's session), with the coordinator's
calls under 22 to 25 (docs/plan/repl/README.md). BUILT (2026-11-24): Python's mount (#2026), the reader's read side
(#2048, #2058), `ml.fs`'s read members (#2083) and Python's writes under `agent/` (#2121). Not built: `ml.fs`'s
write members (next, ruling 119), the dump (deferred, ruling 119), and backup and the archive carrying files.
This section SUPERSEDES three things in "A session's files as a directory" above: its layout (`/files/` itself
writable), its mount
(an eager MEMFS that loads the whole directory into the worker) and its quota multiplier (the three times measured for
that MEMFS). The rest of that section stands: the handle folders under `attached/`, provenance as a field, frozen when
cited, the kernel-death message, and the host's disk never aliasing `/files` while no session folder is mounted. AMENDED
2026-11-20 (ruling 91): once a session's own folder is mounted, that folder backs `/files` for the session ("One folder
per session").

**The principle (ruling 22).** No part of `/files` ever holds all of a session's files in memory, and several sessions
at once stay usable. Every read is ranged or streamed, every listing is lazy, one directory at a time, and a write is
streamed to its store. Each language gets the file API the model already knows (ruling 23): Python gets `open`, and
JavaScript gets Node's `fs`, as `ml.fs`.

### The layout (ruling 36)

- **`/files/attached/`** holds what the person attached, at `attached/<handle>/<name>`, as above. It is read-only to
  the agent, which may copy a file out.
- **`/files/agent/`** is the agent's own space: it creates, writes, renames and deletes there freely, within the
  session's quota.
- **`/files/` itself is not writable.** Nothing new may be created at the root. A listing of the root shows
  `attached/` and `agent/`, and later `history/` when the session-history store gives it one, and nothing else. A
  write, a `mkdir` or a rename at the root fails with EROFS in Python and an `EROFS` error from `ml.fs`.
- Provenance follows from the folder: a file under `attached/` is the person's, one under `agent/` was made by a run.
- **The working directory is `/files/agent/`.** A cell starts there, and a relative `ml.fs` path resolves against it
  (the coordinator's layout call after ruling 86, 2026-11-19, amending #1999's "against `/files/`"). `ml.fs.cp`'s
  destination is under `/files/agent/`. With a workspace mounted, a Python cell starts in the workspace's real path
  instead ("Initial decisions", Shane, 2026-11-13; not built).
- **Whose it is** (rulings 81 and 86): `/files/agent/` is the model's own, with subfolders it makes, where rm, rename
  and overwrite are free; everything else under `/files` is the person's and read-only to the model. `/files` is one
  private file system per session: there is no per-model subfolder, and another session's files are not reachable
  (sharing between sessions is deferred, ruling 81; on disk, ruling 91's "One folder per session").
- **The quota is per session** ("Writes", `filesQuotaMB`). **No restorable rm:** a delete is final, except that a cited
  file keeps its frozen version ("Mutable, frozen when cited").
- AS BUILT (#2026, #2048, #2058): the reader lists the root as `agent/` and `attached/`, and `attached/<handle>/<name>`
  from the session's attachments, and `agent/` from the session's run-made files (`ml-agent-files`, "Writes"). The
  Python mount enters `/files/agent/` at every cell.

### `/files/notes/` and `/shared/notes/`: the agent's notes (IDEA, Shane, 2026-11-22; nothing assigned, nothing built)

A folder of plain text files the model keeps for its own use, the way a coding agent keeps `CLAUDE.md` or a memory
folder: what the person told it, what it learned about a site, what to do next time. It is files on the same disk as
everything else, not an API: the person reviews and edits them in the files panel, and the model reads, writes and
runs analysis scripts over them with the file tools it already has.

Two folders, because sharing between sessions is deferred (ruling 81) and the notes must not wait for it:

- **`/files/notes/`, this session's.** Created empty beside `attached/` and `agent/` (an exception to "nothing new at
  the root", made by the system, not by a run), and kept, backed up and deleted with the session like the rest of
  `/files`. It is buildable now. What it is for within one session: what the person said, kept outside the context,
  so it survives a compaction or a fork ([`AGENT_COMPACTION.md`](AGENT_COMPACTION.md)); `agent/` stays the working
  data, `notes/` is the part the model reads as its own instructions.
- **`/shared/notes/`, every session's.** The same format in a root outside `/files`, mounted into every session; it is
  the first piece of the deferred shared file system, `/shared/`, and comes with it. A note there outlives the session
  that wrote it, so this is the memory across sessions (the Google login note below lives here). It is a different
  shape from ruling 91's direction (a policy lets one session read other sessions' folders, POLICIES.md, "Other
  sessions' files, later"): a common folder every session writes, rather than a window into another session's own.
  Both can exist.

Shared by both:

- **Text files only** (`.md`, `.txt`); a write of anything else is refused.
- **One standard format.** One note per file, opening with a frontmatter `description:` line that says what it is for
  (and optionally `site:` naming the host it is about). The index the model reads at the start of a run is GENERATED
  from those lines over both folders, never a hand-kept file, so it cannot drift; a body is read on demand. The index
  is in the prompt budget ([`PROMPT_BUDGET.md`](PROMPT_BUDGET.md)), and the run log and both exports carry the index
  the model saw.
- **It grants nothing.** A note steers what the model tries; whether a call needs the person stays the policies' and
  the gate's decision ([`AGENT_FILES.md`](AGENT_FILES.md), "Trust"). The gate reads only facts the host resolved
  about the call, never the context, so no file the model read can be mistaken for permission, as it can by a
  classifier that judges a call from the conversation: the permission is the policy. The worst case is a wrong or
  planted note steering the model to anything the policies already allow; past that, the person is asked. In
  `/shared/notes/` that worst case reaches every later session that reads the note, not one.
- **Worked example.** On Google's account chooser the person says the agent may always pick `person@example.com` and
  should stop and ask if a 2FA prompt follows. The first half is a policy, proposed and checked on the page
  ([`POLICIES.md`](POLICIES.md), "Measuring an `act` rule on the page it is for"); the note
  `/shared/notes/google-login.md` records why the policy exists and the 2FA instruction, which no policy can say.
  Until `/shared/` exists, the same note in `/files/notes/` holds for that session only.
- **Open.** Who writes `/shared/notes/`: every session freely (the small-fixes session's recommendation, since a note
  grants nothing), or by policy, given that a planted note there steers every later session within what the policies
  allow. The scope of `/shared/` (the runtime, the person across
  runtimes, a workspace); how backup and the archive folder carry it; where it lives on disk once a host backs
  `/files` (ruling 91); whether a note the model wrote is marked apart from one the person wrote, or provenance stays
  the files panel's history.

### `lib/`: modules the model writes and a later cell imports (IDEA, Shane, 2026-11-22; nothing assigned, nothing built)

The same split for code: the model writes a helper in `/files/lib/`, uses it from later cells, and moves it to
`/shared/lib/` (with `/shared/`, deferred above) when it is worth keeping. It may copy and move between the two
freely. JavaScript modules are run by the read-only `exec` dialect, Python modules by `python_exec`. The question is a
cell whose code lives partly in a file it does not contain. The rule: **a decision about a cell is a decision about all
the code the cell runs.**

- **Inside a dialect, the evaluator decides, so an import changes nothing.** The JS dialect's interpreter is the
  whitelist and never compiles a string ([`../dev/readonly-exec.md`](../dev/readonly-exec.md)); Python's membership is
  decided by running the cell under the fork's gate, never by its source ([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md),
  "Membership replaces `mode`"). An imported module is more code through the same evaluator: inside the dialect the
  cell stays free, outside it the cell asks, as if the code were inline. The module's steps count against the cell's
  halting bound. A planted module in `/shared/lib/` runs in every later cell that imports it, within what the dialect
  allows; it cannot do what the dialect does not. The same rule covers code that arrives by assignment and not by
  import (a dialect-checked wrapper installed on a library function): [`PYTHON_DIALECT.md`](PYTHON_DIALECT.md), "Code
  from elsewhere runs under the same gate".
- **A cell that asks is approved with its imports.** The card shows each imported module beside the cell, with its
  path and a content hash: EXPANDED when the person has not approved that hash before, collapsed only when they have,
  so no code is approved unseen. The approval is pinned to those hashes: a module that changed between the card and
  the run is refused and asked again, so a file edited after the approval never runs unseen.
- **Imports are static, with literal paths** (`import { f } from "/shared/lib/x.js"`, `from mylib import f` with
  `/files/lib/` and `/shared/lib/` on `sys.path`), so what a cell loads is known before it runs: the card lists it,
  the hashes cover it, the log names it. A computed path is known only at run time, too late for a card. Inside the
  Python dialect a computed load is refused by the gate: `__import__`, `exec`, `compile` and `open` are not in
  `builtins`' table, and `importlib` has no table, so importing it is refused as `import os` is
  ([`PYTHON_DIALECT.md`](PYTHON_DIALECT.md), the kind tables). A cell OUTSIDE the dialect is approved as arbitrary
  code and can load any file by any means; the pin covers its static imports only, and the card says so. On the JS
  side `import` is new dialect syntax, so it comes with the adversarial tests AGENTS.md requires (path tricks, a cycle,
  a module importing itself, a depth bound, a module rewritten while it loads).
- **The log carries what ran.** Every module a cell loads is recorded by path and hash in the run log, and both
  exports carry each module's text once, by hash (the "log carries what the model saw" rule).
- **Open.** A module in `/shared/lib/` other sessions depend on can be broken by an edit: accepted at first, since
  every load is logged with its hash, with immutable versions on a move to `/shared/` if breakage shows up.

### `ml.fs` (rulings 22 and 23)

The surface (its members with `opendir` and `createReadStream`, its paths, the gate, the scrub and the writes) has ONE
home: "`ml.fs`: Node's `fs/promises`, with a session's files as its disk" above, over the one ranged reader, offered to
worker-built runs only, in the isolated world, never page-started; the `python_install` candidate worker gets neither
it nor the mount. AMENDED 2026-11-22: this section restated it, with reading, listing and writing rules that the home
now carries. The read members are built (#2083); the write members are next (ruling 119). What this section keeps:

- **A hidden file.** "Hidden" is the effective list of [POLICIES.md](POLICIES.md), "Hiding files", which binds every
  reader of `/files`, the mounts and `ml.fs` included: a path is hidden when a default holds it (a dotenv name, a
  credential file, a linked template) or a `hide` entry does, whichever way the entry was made, the person's mark in
  the file browser (ruling 24) or an approved card. A hidden file is listed by name with `hidden: true`, and every read
  of its content fails with an error naming it as hidden. A `show` entry that wins for the path (a session `show` over
  a global `hide`, by that section's layers) releases it for that session's reads, and only those.

### Dumping a `@tool:` value into `agent/` (ruling 36)

DEFERRED 2026-11-24 (Shane, ruling 119): not built and not scheduled. As tools move into the two REPLs, a cell
writes a tool's result to disk itself. The design below is kept for when it is taken up.

The model may write a pointer's value in full: `ml.fs.cp("@tool:a1b2c3f", "/files/agent/sales.csv")`. It is a copy
through `ml.fs`, streamed from the STORED WHOLE behind the pointer (the value store), never from the truncated view
the model was shown, and counted against the session's quota like any write. It is written by the pointer's kind:

| Kind | Written as |
| --- | --- |
| text | the text as is, UTF-8 |
| JSON | the JSON, as stored |
| binary (an image, a file) | its bytes |
| table | CSV with a header row, plus a sidecar `<name>.csv.schema.json` |

**The table's sidecar.** The one table type, `TableLike` (`src/contract/contract-fetch.ts`), DOES carry column types:
`dtypes`, the pandas dtype of each column (`int64`, `float64`, `bool`, `str` or `object`), alongside `columns`,
`headerless` and the source's `delimiter`. A CSV alone would leave them to be guessed again on reload, and a guess can
differ from what the model was shown (a column of zip codes read back as `int64`). So the dump writes the sidecar
`{ "columns": [...], "dtypes": { ... }, "headerless": false, "rows": <the source's row count> }`, and a reload reads it:
`ml.fs` and `dereference` of a `.csv` with a sidecar give the one table type with those dtypes, and Python's `read_csv`
loader patch passes them as `dtype=`. A `.csv` without a sidecar is parsed as any CSV is: renaming or moving the `.csv`
without its sidecar, or deleting the sidecar, loses the types. Parquet is the model's own work in Python (ruling 36).

**The round trip, specified.** The CSV is RFC 4180: a comma between fields; a field quoted with `"` when it holds a
comma, a quote, CR or LF, and a quote inside it doubled; `\n` between rows; UTF-8 without a byte-order mark; a header
row always, holding the positional names when the table is `headerless` (the sidecar says so). A missing value cannot
be an empty field, since pandas reads an empty field and a quoted empty string alike: it is written as a sentinel the
dump chooses so that no cell of the table equals it (`\N`, else `\N1`, and so on), recorded in the sidecar as `"na"`.
An empty string is an empty field. A reload passes `na_values=[<na>]` and `keep_default_na=False`. A column the table
declares `int64` or `bool` that holds a missing value is recorded in the sidecar as pandas' nullable form (`Int64`,
`boolean`) and reloaded as it; `ml.fs` and `dereference` give it back as the one table type's `int64` or `bool` with
`null` cells. The row for the build is enumerated, not sampled: for each of `int64`, `float64`, `bool`, `str` and
`object`, a column without and with a missing value, plus a `str` column holding both an empty string and a missing
value; dump then reload equals the stored table, its values and its declared dtypes, on both reload paths.

### Python's view: one mount type over the reader (ruling 36, as amended under ruling 75)

BUILT, the mount only (#2026, docs/dev/python-sandbox.md, "`/files` in Python"): route A's type over the ranged
reader for both folders, as below, switched on in the offscreen document by `setFilesReader` (#2058). Writes under
`agent/` land; elsewhere they answer EROFS. Ruling 36 named two mounts (WORKERFS for `attached/`, a custom mount over
OPFS for `agent/`); the coordinator's call of 2026-11-19 under ruling 75 replaced them with this one type.

Python sees `/files` through Emscripten mounts, never a mount that loads whole files. ONE store, the shelf, holds
both folders (the coordinator's call, 2026-11-19): no OPFS copy of `agent/`, so the quota, the atomic commit, the
backup and any commit-on-cell-success live in one place.

- **Both `attached/` and `agent/` on route A's file system type over the ranged reader** ("One reader, three front
  ends", above). Python's `open()` is synchronous, and route A's sliced wait makes each read and write synchronous from
  Python's view while the offscreen document serves it from the shelf; `FileReaderSync`, which the lockdown does not
  allow, is not needed. `attached/` is read-only (EROFS). A write to `agent/` streams to the shelf chunk by chunk
  ("Writes", above), so the worker holds one chunk, not a cell's output, and lands at the commit point. A case the
  shelf cannot serve synchronously goes to the coordinator as a case, not as a second store.
- **The scrub runs inside the mount's read**, chunked with an overlap of the longest registered form minus one byte,
  so a registered value in a file never reaches the kernel. It preserves LENGTH: in the mount a match is replaced by
  the same number of filler bytes (`*`, 0x2A), never by `[REDACTED:<NAME>]`, because Python seeks by offset and reads
  `st_size`, and a replacement of another length would shift every later offset and corrupt a binary format (a zip,
  a Parquet file, a pickle). The filler shows the value's length, which the hash-only store gives anyway
  (SECRET_HANDLES.md, ruling 32). A write is not scrubbed: what the kernel writes it already held.
  AS BUILT (#2058): in `RangedReader.read` in the offscreen document, the one path every read of both folders takes.
  Each read asks the service worker for the forms (`FILES_SECRET_FORMS`: the config's `secretsOf` forms and every
  registry form, plaintext). The worker answers through `isOffscreenSender`, the same check `FILES_ATTACHED` makes,
  and anyone else gets `{forms: null}`; the type has no relay entry. Nothing caches the forms, on either side: they
  are asked for at every read and held for that read only, so a secret added between two reads through one
  descriptor is masked in the second. The read takes the range widened on each side by the longest form's UTF-8
  length less one byte (at least the GitHub token pattern's), clamped to the file's start and end, masks every match
  and the GitHub token pattern with 0x2A (`src/secret-mask.ts`), and copies out the range alone: a match that crosses
  either edge is masked in the part inside the range, and a form longer than the range, covering it and straddling
  both edges, masks the whole range. Forms that cannot be read fail the read with `EIO`; nothing unmasked is served. The
  forms are never written to a log (the run log, the housekeeping log, the console) and never appear in an error's
  text, the `EIO` path included: its message is fixed. The values never reach the Pyodide worker. Matching is on BYTES: a form is matched as its UTF-8 bytes, and the registry's
  forms already list its JSON-escaped, percent-encoded, base64 and shell-escaped spellings; ASCII letters fold for a
  form marked case-insensitive. The residual is named: a value written in another encoding (a UTF-16 file) or inside
  a compressed or encoded container (a deflated zip member, a gzip stream) is not seen, as a script that decodes
  bytes itself is not (`ml.fs`, "The scrub"). Ruling 32's hash-only matcher is a stated gap: it is not built, the
  registry stores plaintext values, so the plaintext forms cover every registered value; when it lands, the forms'
  source changes and this read does not.

**Asked by ruling 36 of the packages notebook, still not on main** (the design was fixed and built without them):
whether worker memory stays flat reading ranges of a 1 GiB file; the cost of the scrub inside the read, both the
plaintext registry's and ruling 32's hash-only matcher's; and whether a Parquet writer wheel exists. Whether the
restricted fork gates `open()` on a mount was measured on the branch `measure/py-files-mount` (the route table of
[`ML_TABLE.md`](../plan/repl/ML_TABLE.md)'s item 7).

### Backup and restore carry the files (ruling 35)

A backup (docs/spec/BACKUP_FORMAT.md, docs/dev/backup.md) is the archive's SQLite schema holding every session; it
gains the session's files. Two tables, in the schema `migrate` builds:

- `files (hash, path, kind, size, sha256, mtime, provenance, hidden, omitted)`: one row per file of a session (`hash`,
  the session), its path under `/files`, `hidden` set for a file the person marked secret, and `omitted` saying why a
  row has no chunks (`"size"` in a month file, ruling 47, below), null when its bytes are there.
- `file_chunks (sha256, idx, data)`: a file's bytes in chunks of 1 MiB, keyed by the file's content hash, so a file
  attached to two sessions is held once, as `images` is today.

**Where the hash comes from.** The shelf keeps each file's `sha256` with its size and mtime, computed when the file is
closed by one streamed pass (an attachment's when it is attached). A backup uses the kept hash when the file's size and
mtime still match it, and otherwise makes one streamed pass first. A file in `agent/` that changes while the backup
reads it (its size or mtime differs after the last chunk from before the first) is read again once; if it changes again
it is left out and named in the backup's `meta` as skipped, and the restore screen lists it.

**A set of volumes.** BACKUP_FORMAT.md caps a file's decompressed output at 1 GiB ("Limits a reader MUST keep"), a
limit version 1 must keep forever, and a session's files pass it easily. So a backup with files is a SET of version-1
files (the coordinator's call): the first holds the sessions, the settings and the `files` rows; the `file_chunks`
spread over numbered volumes, each under the limit; every volume is authenticated on its own; and the first volume's
`meta` names each volume with its SHA-256 and decompressed size. No new version byte, and each volume opens in any
SQLite tool. A restore stages every volume and commits only when every one has authenticated and matched its hash; a
missing or failing volume fails the whole restore and names it. Considered and not recommended: a raw-bytes body
outside SQLite, which version 1's "the plaintext is the SQLite file" rules out.

**Streamed, both ways.** Writing a backup reads each file through the ranged reader a chunk at a time into
`file_chunks`, and the backup file is gzipped and encrypted chunk by chunk as it is now, so no step holds a whole file
or all files. Restoring decrypts and gunzips a chunk at a time into a STAGING database, because a reader must not output
partial plaintext (BACKUP_FORMAT.md, "Reading"). Only after the final chunk of every volume authenticates does the
import copy each file from staging to the shelf, a chunk at a time. A failed restore leaves the shelf unchanged.

**The staging space.** Staging lives in the origin-private file system beside the archive, one
`restore-staging-<id>.sqlite` per volume, so a restore needs about twice the files' size while it runs. Before it
decrypts anything past the first volume, it reads the declared sizes from that volume's `meta` and checks the free
quota (`navigator.storage.estimate()`) for staging plus the shelf; when they do not fit, it fails before the shelf is
touched and says how much it needed and how much was free. Staging files left by a crash are removed when the worker
next starts.

**A hidden file's bytes are never in a backup; its name is**, with `hidden` set and no chunks (the coordinator's
recommendation, taken). What decides is the hiding that outlives the session: the bytes are left out when the person's
mark, a default or any global `hide` holds the file, whatever a session's policy says, so a session `show` never puts a
hidden file's bytes into a backup that outlives it. A restore lists it under its path, marked hidden and "not in this
backup"; a read of it fails with that reason. The person keeps the secret by keeping the original.

**The upgrade.** A backup written before this has no `files` or `file_chunks` table. A restore reads it as before, and
its sessions come back with an empty `agent/` and their attachments as the backup held them (an attachment's bytes
were already in the archive). The restore screen says the backup holds no session files. An older version restoring
a backup made after this ignores the two tables and restores the sessions without their files; it cannot be changed
to warn, so the backup's `meta` records `files: <count>` for a later version to state what an older one dropped. Rows:
a fixture of a pre-files backup restores with no files and no error; a backup with files restores them byte-identical;
a hidden file restores as a hidden name with no bytes.

### The archive folder's month files carry them too (ruling 47)

Shane's ruling 47 (2026-11-18): a session's files go into the archive folder's month files, not only into the one-off
backup, in the same two tables and the same volumes. A session moved into the archive keeps its files, so there is still
one place each session lives, and the folder is a copy of it. A setting leaves out files over a size, since the folder
is often on a drive a cloud service syncs.

- **The setting**, the coordinator's call (2026-11-19), open to Shane's override: `archiveFileMaxMB`, a number in MB
  like `sessionStoreBudgetMB` and `valueStoreBudgetMB`, default 100. A file larger than it is left out of the month
  files; 0 removes the limit. It is in DevTools Settings beside the archive folder's form (the rule for a new setting)
  and in the chat page's Extension tab where the folder is set. It changes only the folder: a one-off backup carries
  every file that is not hidden, whatever its size. The default is reasoned from an assumed uplink, not measured
  (below).
- **Why 100 MB.** A sync rewrites each dirty month whole (archive.md, "Dirty months"), 30 seconds after an archive write
  and every 6 hours, so a file in a month is uploaded again each time any session of that month changes, by the cloud
  client that syncs the folder. At an uplink of 20 Mbit/s, an assumption for a home connection and not a measurement,
  100 MB is about 40 seconds of upload per file per rewrite: past it the folder costs more than a copy is worth to most
  people, and a person who wants the large files kept raises the limit or makes a one-off backup. A data file a run made
  (a Parquet or a CSV of a fetched table) is usually well under it; a model checkpoint or a video is not.
- **Changing the limit marks the months it affects dirty**, as switching the form does (backup.md): raising it, every
  month holding a file omitted by size that is now within it; lowering it, every month holding a file now over it. The
  next sync rewrites those months, so the folder matches the setting from that sync on, and no other month is rewritten.
  Row: with months A (an omitted 150 MB file), B (a 60 MB file) and C (small files only), raising the limit to 200 marks
  only A dirty and the sync writes the file into A; lowering it to 50 marks only B and the sync leaves the file out of
  B.
- **What is left out is named.** A file over the limit keeps its `files` row, with no chunks and `omitted: "size"`, and
  the month's `meta` lists it with the limit in force when the month was written. A restore from the folder lists it
  under its path as "not in the archive folder: over <the limit> MB", read from that `meta`, and a read of it fails with
  that reason. Its bytes are still in the browser's archive while the session is: only a wiped profile loses them.
- **A hidden file** is left out of the month files as it is out of a backup, by the same rule (above), and a month file
  is a set of volumes as a backup is. A month's first volume keeps the month's name (`2026-10.wmlbak`); the others are
  `2026-10.v2.wmlbak` and on, in the month's form. An install from before this does not read those names as months
  (`MONTH_FILE`, `src/archive/archive-folder.ts`), so it ignores them.
- **An older install reading a new month.** The first volume is an ordinary month file with two more tables and more
  `meta` keys. An install from before this reads its sessions as it always has and ignores the `files` and `file_chunks`
  tables and the volume list, with no error; it imports the sessions without their files. Row: a fixture of a new first
  volume, read by the merge as it is on main before this, imports its sessions and reports no error.
- **A month an older install rewrote.** Such a month comes back without `files` rows (Known limits, below). The newer
  install's merge never reads an absent `files` row as a deletion: a file leaves the browser's archive only by the
  person deleting it or by a `removed` entry (backup.md, 3b), never because a month file lacks it. When the merge finds
  the archive holding files the month lacks, it marks that month dirty, so the next sync writes them back. Row: a month
  rewritten without `files` rows, merged by the newer install, leaves every file in the browser's archive byte-identical
  and marks the month dirty.
- **Known limits.** An install from before this that rewrites a month (a change on a second machine running the older
  version) writes it without the `files` rows, and the folder's copy of that month's files is lost until a newer install
  merges that month and rewrites it; the volumes it ignores are left orphaned until then. The sessions themselves, and
  the files in each browser's archive, are unaffected. Rows: a month with a file over the limit restores it as omitted
  by size, naming the limit from its `meta`; a month with files restores them byte-identical; and a pre-files month file
  restores with no files and no error.

### A restore over the quota (ruling 48)

Shane's ruling 48 (2026-11-18): a restore restores every file, since they are the person's, even when that takes a
session over its quota. The session is then marked over its quota, and a write under `agent/` is refused by name as the
quota refuses one ("Lifetime and quota", above) until the person deletes enough to be back under. Reads, copies out of
`attached/`, deletes and renames are unaffected. The restore screen says which sessions came back over their quota and
by how much.

This is the session's quota, not the browser's storage. A restore the browser's free space cannot hold still fails
before the shelf is touched ("The staging space", above). Rows: a fixture whose `agent/` total is over the quota
restores every file byte-identical, a write after it is refused naming the total, and a delete that brings the session
under lets the next write through.

**Whether the hub changes.** No: `ml.fs` and the mounts are the runtime's, and backup and restore are local. The
file browser's commands are the session-store amendment's (ruling 24).

### Open questions, each with a recommendation

Settled as the coordinator's calls and written in above: the dump is `ml.fs.cp`; both folders are on route A's type
over the ranged reader, one store, the shelf (2026-11-19), never a loosened lockdown; `readFile`'s
bound is 8 MiB; and no sidecar for JSON or text. The two left for Shane are settled (2026-11-18) and written in
above: the archive folder's month files carry a session's files, with a size limit (ruling 47), and a restore over
the quota restores every file and then refuses writes until the session is back under (ruling 48).

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

**Built (2026-11-24): where a cell opens it.** On a run the worker built, each block also names the file's path under
the mount, after `pointer`: `path="/files/attached/<handle>/<name>"`, the handle being the pointer's id and the name the
stored one, as the mount lists it (sw-attach.ts `openablePath`). It is there only when it opens the file as written: a
name holding `/` (the mount reads it as a folder), a name that is `.` or `..` (the mount refuses the segment) and a name
the turn's scrub changes (the framed task is scrubbed whole, the mount lists the stored name) get none. Only the
attribute is absent: the file is still attached, its block still names its pointer, and its folder
`/files/attached/<handle>/` is listed, so the model lists the folder. A `"` in a name is written `&quot;`, as in `name`;
the attribute's decoded value is the path. A hidden attachment carries its path, since its name is listed; the read is
refused by the hide rule. A message stored before this is replayed as stored. It costs 32 characters and the name per
attached file.

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
