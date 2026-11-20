# Parked plan: keeping personal details out of screenshots

**State: PARKED, not scheduled (Shane, 2026-11-20, in the coordinator's session).** An edge case worth writing down,
not a priority. Nothing here is assigned. The one part that IS scheduled is named under "What is already ruled".

## The problem

Ruling 93 puts personal details (a full name, an address, a phone number) in the secret registry as a second kind of
value. Text the model reads is scrubbed by registered value already. A screenshot is not text: `look`, `locate` and a
picture-based `verify` show a vision model the page's pixels. Today `docs/spec/SECRET_HANDLES.md` masks the value of a
held form field in those pictures and nothing else.

## What is already ruled (scheduled, not part of this parked plan)

- **Ruling 93.** Personal details are in scope for the secrets topic. The exact layer: before a capture, find each
  registered value in the page's rendered text, take its rectangles, paint over them. Spec owner: files-host, a
  doc-only change to `docs/spec/SECRET_HANDLES.md` after its current PR; the secrets red team writes the probes.
- **Ruling 94.** The inbox item that suggests setting up the store names three uses: a secret the model may use but
  never read, a secret it must never read though it may meet it where it works, and anything to blank before the
  model sees it.

The exact layer cannot see text inside an image, a canvas or a PDF render. Everything below is about that residual.

## The three modes (Shane's proposal, coordinator's recommendation: this is the right shape)

| Mode | What the person gets | Guarantee | Cost |
| --- | --- | --- | --- |
| 1. Review | every screenshot waits for the person, who may draw boxes over it or approve it | complete | a prompt per picture |
| 2. Best effort | registered values are blanked wherever they can be found | none; a miss is silent | compute per capture |
| 3. Off | no masking beyond the held-field mask | none | none |

- **Mode 3 is the default** while no personal detail is registered.
- **Mode 1** is set per session, not globally (the case is "I am on my bank's site now"). It gates `look` and
  `locate` with the existing approval card plus a rectangle tool, which is not built. A picture-based `verify` fires
  after most actions, so a gate there makes a run unusable: in this mode it is turned off, not gated.
- **Mode 2** is two layers. The exact layer above, always on once a personal detail is registered. Then a pixel
  layer for text in images and canvas, which is the open part.

## The pixel layer: what exists and what does not

| Piece | State | Gives |
| --- | --- | --- |
| "OCR" in this project (the reader model set in Settings) | built | the text of an image, with no positions |
| `locate` (a grounding model) | built | a box for one described target, not for every word |
| Approval cards | built | a yes or no on a tool call |
| Drawing on a screenshot | not built | |
| Word-level boxes from pixels | not built | what blanking needs |

The reader model is not a building block here. It returns no positions, and it reads the unmasked picture itself: if
it is hosted elsewhere, the detail has left the machine before any blanking.

**Candidate: Apple's Vision text recognition** (Shane's suggestion). It runs on the device and returns each
recognised line with its box, a confidence, and the box of any substring, so a registered value found in the text
maps to the rectangle to paint. The extension cannot call it; the process host (window-ml-host) can. The capture
would go to the host on the same machine, come back as text and boxes, and be painted in the worker before any model
reads it.

Limits to state if it is built:

- Mac only. Windows has its own built-in recogniser; Linux has none and would need a bundled engine or the
  fallback below.
- It needs the host installed. Without it the pixel layer is unavailable, and the mode says so; it never passes a
  picture as if it had been checked.
- It misreads characters (see the open question).
- Its cost per capture is unmeasured; the coordinator's guess is a few hundred milliseconds for a full page.

**Fallback with no recogniser:** when the page holds images or canvas, blank those regions whole. Deterministic,
and it overshoots a great deal. A possible sub-choice of mode 2.

Chrome may expose the platform recogniser through an experimental text-detection API. Its state is unchecked; do not
plan on it.

## Open question for Shane: the matching rule

A recogniser misreads characters, so an exact match misses. Matching within an edit distance recovers recall and
costs false blanks. A miss is silent and a false blank is visible, so the bias is toward blanking. The recogniser's
confidence is a second lever: blank a low-confidence line that sits near a partial match. The bound is a number, and
it is Shane's to set from the measurement below.

## First step when this is unparked: one measurement, no product code

On Shane's Mac, as a notebook under notebooks/ with a throwaway script, and no change to the host:

1. Take a few dozen captures of real pages. Plant registered values in images and canvas on them, at several sizes,
   fonts and contrasts.
2. Run Vision on each capture.
3. Record: recall for exact matching and for edit distance 1 and 2; the false-blank rate at each; latency per
   capture; how recall moves with a confidence threshold.
4. Separately, on unplanted real pages: how often a registered value appears ONLY in pixels. If that is rare, the
   whole-region fallback may be enough and the recogniser is never needed.

The result decides the matching bound and whether the pixel layer is built at all.

## Order if it is ever built

1. The exact layer (ruling 93; scheduled).
2. Mode 1's gate and rectangle tool (small; a spec section first).
3. The measurement.
4. The pixel layer, only on the measurement's numbers. A host change is a host PR, merged by hand, tagged on Shane's
   word in the host session.
