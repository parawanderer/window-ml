# Reading a PDF

How a PDF is opened, measured and classified, page by page, in the offscreen document. A PDF attached to a worker chat
is read through it (`sw-chat.ts` asks `PDF_READ` before the turn and `PDF_RENDER` for each page that sends an image,
[`FILE_ATTACHMENTS.md`](../spec/FILE_ATTACHMENTS.md), "Wiring a PDF through the attach path"); agent runs and
`fetch_url` do not use it yet. The folder is `src/pdf/`.

## The pieces

| File | Holds |
| --- | --- |
| `pdf-measure.ts` | Pure. From pdf.js's `textContent` and operator list: usable and broken characters, the union of the image boxes as a share of the page, glyphs shown invisibly (text render mode 3 and 7) and visibly. Takes the operator numbers as a table, imports nothing from pdf.js. |
| `pdf-classify.ts` | Pure. The measurements to `"text" \| "scanned" \| "mixed" \| "ocr-scan" \| "blank"`. Every threshold is a named, exported, PROVISIONAL constant. |
| `pdf-read.ts` | `readPdf(lib, bytes, opts)`: open, then per page text + measure + kind, under the bounds below; every pdf.js error becomes a one-sentence refusal. `renderPage(lib, bytes, n, scale)`: a PNG through `OffscreenCanvas`. pdf.js is a parameter (`PdfLib`), so node tests use the same code with the same library. |
| `pdf-lib.ts` | pdf.js's legacy build set up to run in the current thread: its worker half is imported and handed over as `globalThis.pdfjsWorker`, so there is no nested worker. |
| `pdf-worker.ts` | The dedicated worker (`dist/pdf-worker.js`). Stateless: each request carries its bytes, opens, answers, and frees the document. |
| `pdf-host.ts` | The offscreen document's side: starts the worker on the first request, runs one request at a time, terminates it past the wall-clock cap, stops it when idle. Over a `WorkerLike`, tested with a fake. |
| `pdf-wire.ts` | The message types and base64. |

`offscreen.ts` answers two messages from the service worker only (`sender.id` is ours and `sender.tab` is unset):
`PDF_READ { b64, pageCap?, pageTextCap?, budgetMs? }` and `PDF_RENDER { b64, n, scale }`. The channel is JSON, so the
bytes cross as base64 and go on to the worker as a transferred `ArrayBuffer`; a render's PNG comes back as `pngB64`.
Both answer `{ ok: true, ... }` or `{ ok: false, code, refusal }`, the refusal being the one sentence for the person.

## Why it runs where it runs

The service worker has no DOM or canvas. The offscreen document has both but shares a renderer with the sidebar, so a
long parse there would freeze the panel (the reason Pyodide has a worker too). pdf.js therefore runs in a dedicated
worker the offscreen document starts, in that worker's own thread. A page that never yields cannot be interrupted from
inside, so the host owns a wall-clock cap and `terminate()`s the worker, as `offscreen.ts` does for Python. Killing it
loses only the request in flight: the next one starts a fresh worker.

pdf.js is the LEGACY build everywhere (worker and node tests). The modern build assumes newer built-ins, and one build
under test is worth more than a smaller bundle. `build.mjs` bundles it as a classic script and copies what it fetches
at run time to `dist/pdfjs/` (`copyPdfjs`): `wasm/` (JBIG2, JPX and ICC decoders, without the no-wasm fallbacks, since
the extension CSP allows wasm), `cmaps/` and `standard_fonts/`. The worker passes `new URL("pdfjs/<dir>/", self.location)`
for each. Added to `dist/`: `pdf-worker.js` 3.6 MB and `pdfjs/` 2.5 MB. The dependency is pinned exactly
(`pdfjs-dist` 6.4.299, no caret).

pdf.js is opened with `isEvalSupported: false`, `enableXfa: false`, `useSystemFonts: false` and `maxImageSize` capped;
PDF scripting (quickjs) is not shipped.

## The bounds

A crafted file must end in a sentence, not a hung run. All are exported constants in `pdf-read.ts` unless noted.

| Bound | Value | When it trips |
| --- | --- | --- |
| `BYTES_CAP` | 64 MiB | refused before pdf.js sees the file |
| header | `%PDF-` in the first KB | refused as "not a PDF" before pdf.js sees it |
| `PAGE_CAP` | 500 pages | the first 500 read; `truncated.why = "page-cap"` |
| `PAGE_TEXT_CAP` | 100,000 characters per page | text cut, `textTruncated`; the measurement is of the whole page |
| `READ_BUDGET_MS` | 20 s in all, checked between pages | `truncated.why = "time"` |
| a page pdf.js cannot read | the first refuses the file; a later one ends the read | `truncated.why = "page-error"` |
| `OP_CAP`, `IMAGE_CAP`, `GLYPH_CAP`, `TEXT_SCAN_CAP` (`pdf-measure.ts`) | 200k operators, 2k image rasterisations, 2M glyphs, 2M characters | the walk stops early; `opsCapped` |
| `PDF_TIMEOUT_MS` (`pdf-host.ts`) | 45 s per request | the worker is terminated; refusal with code `timeout` |
| `RENDER_PIXEL_CAP` | 16 megapixels | the scale is lowered to fit, and the answer says what it used |

pdf.js trusts less than it seems to: it walks the page tree and corrects a lying `/Count`, and it drops text that runs
off the page. `tests/fixtures/pdf/pages-100k.pdf` claims 100,000 pages and pdf.js reports 3, so the page cap is tested
against a stand-in pdf.js whose count is a lie (`tests/pdf-read.test.mjs`).

## What is measured

Per page, in the pdf.js user space of the page's `view` box:

- Usable characters: the text layer's non-whitespace characters that are not U+FFFD, private use (BMP and both
  supplementary planes) or C0/C1 controls. The broken ratio is broken over broken plus usable.
- Image cover: every `paintImageXObject`, `paintInlineImageXObject`, `paintImageMaskXObject` and the repeat and group
  variants is the unit square through the current matrix. `save`/`restore`, `transform` and a form XObject's matrix
  (`paintFormXObjectBegin`/`End`) are tracked. The boxes are rasterised into a 128 x 128 sample of the page and
  united, so overlap is not counted twice and a rotated image is counted by its own area. Resolution is under 1% per
  edge. Not tracked: clip paths, a form's `/BBox`, `paintSolidColorImageMask`.
- Path cover: pdf.js 6 emits each painted path as one `constructPath`, `[paintOp, [buffer], minMax]`, with the box in
  the current user space. Every fill or stroke variant's box goes through the same matrix into a second grid;
  `endPath` (a clip) paints nothing and is skipped. The BOX counts, not the ink: a stroked frame covers what it
  encloses, a straight rule (no area) covers nothing, and a fraction bar adds nothing either. One path covering
  `FULL_PAGE_COVER` alone is the page's background and is left out. Fill colour is not read, so a white box counts.
  A `shadingFill` (`sh`, a gradient) paints the current clip, so the box of the path after the last `clip`/`eoClip`
  is tracked through `save`/`restore` and forms, and the shading counts as one path of that box (with no clip, the
  page: a background). Pictures made of clipped gradients (`pdfjs-personwithdog`) are drawn this way.
  At most `PATH_CAP` (2,000) paths are rasterised. `drawnCover` is the union of both grids, and is what `blank` reads.
- Invisible text: glyphs under render mode 3 or 7, tracked across `save`/`restore` and form XObjects, against visible.
- Whether one image alone covers `FULL_PAGE_COVER` (0.9) of the page.

## The thresholds

`pdf-classify.ts` holds them, each with a one-line reason. `notebooks/pdf/pdf-thresholds.ipynb` reads them against
vision models' labels of real pages and ports the classifier to Python, asserting the port reproduces every measured
kind: change a constant and re-run `notebooks/pdf/measure-corpus.mjs` in the same PR. `MIXED_COVER` (0.1) and
`MIXED_PATH_COVER` (0.3) are measured there; the rest keep their first values, chosen against the synthetic fixtures
(`tests/fixtures/pdf/`, written by `scripts/make-pdf-fixtures.mjs`, checked byte for byte by
`tests/pdf-fixtures.test.mjs`), and the notebook found no reason to move them. The tests are written against the
exported names, so a changed value moves the boundary tests with it. The decisions that are not numbers: a junk text
layer is `scanned` (the page is sent as its image); a scan whose OCR layer is itself junk is `scanned` too; `ocr-scan`
needs invisible text over ONE full-page image; a vector drawing with no text is `mixed`, never `scanned`.

## Testing

Node (`tests/pdf-*.test.mjs`) covers the measurements, the matrix math, the classifier's boundaries, every fixture and
the bounds, over pdf.js's legacy build. Not coverable in node: rendering (`OffscreenCanvas`), the worker and its wasm
and font files, the offscreen relay. `tests/e2e/pdf-offscreen.spec.mjs` loads the built extension and asks the
offscreen document to read and render the fixtures.

## Traps

- pdf.js's `numPages` is its own corrected count, not the file's claim; a trusted count is what the cap is for.
- pdf.js trims text that falls outside the page, so a test for a huge text run needs it on the page (many small lines).
- `chrome.runtime.sendMessage` is JSON: send base64, never a typed array.
- The document handle has no `destroy()`; the loading task's `destroy()` frees it.
- The worker has no `document`, and pdf.js outside node assumes one for its canvas AND filter factories: `source()`
  passes `OffscreenCanvasFactory` and `NoDomFilterFactory`. Without the second, a page with a transfer function, a
  luminosity soft mask or a knockout group refused as `unreadable` ("reading 'URL'"); given "none", pdf.js draws each
  of them pixel by pixel (`filters.pdf`).
