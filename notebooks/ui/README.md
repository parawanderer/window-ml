# UI notebooks

Measurements behind the panel's drawing decisions. Each notebook has a generator beside it (`make-<name>.py`, the file
to edit) and its pinned inputs under `data/<name>/`.

- [live-call-reveal.ipynb](live-call-reveal.ipynb): what one update of a live call's code cell costs by size and
  language (highlight.js in Node, the DOM swap and layout in Chromium, plain and numbered), the size thresholds that
  follow for `src/sidebar/transcript/reveal.ts` (typed every frame up to, not typed above), and a simulation of its
  pacing holding the reveal's own renders to `budgetShare` of the main thread with every character shown within one
  gap of arriving. The rows are measured by `highlight-cost.mjs`. Generator: `make-live-call-reveal.py`.
