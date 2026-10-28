"""make-pdf-thresholds.py — builds pdf-thresholds.ipynb: where should the PDF page classifier's provisional cut-offs
(src/pdf/pdf-classify.ts, pdf-measure.ts) sit, judged against two vision models' labels of real pages?

    .venv/bin/python notebooks/pdf/make-pdf-thresholds.py && node scripts/nb.mjs run notebooks/pdf/pdf-thresholds.ipynb
    (or: node scripts/nb.mjs make notebooks/pdf/pdf-thresholds.ipynb)

The cells are written here; edit this file, not the notebook. The inputs are the committed files in data/, written by
the scripts beside this one (measure-corpus.mjs, select-pages.mjs, label-pages.mjs, cost.mjs); the first cell prints
each one's hash.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# PDF page kinds: where the cut-offs go

The PDF reader (`docs/dev/pdf.md`) measures each page and `classifyPage` names it `text`, `mixed`, `scanned`,
`ocr-scan` or `blank`. The kind decides what a model is given: the text layer alone (`text`), the text and the page's
image (`mixed`), the image instead of a text layer that cannot be trusted (`scanned`), or an OCR layer read as text
over a page that is a picture (`ocr-scan`). Every cut-off was a first value chosen against synthetic fixtures. This
notebook reads them against real documents.

The corpus is 83 public PDFs (`corpus.json`): pdf.js's test files at a pinned commit, arXiv papers, Internet Archive
scans (with and without OCR layers) and Common Crawl's 2021 PDF sample. Every page was measured by the extension's own
reader (`measure-corpus.mjs`). The pages near a cut-off, plus a few controls per document (`select-pages.mjs`), were
rendered by the extension and labelled through `ml.step` (`label-pages.mjs`) by a local vision model
(`qwen3.8-flash-next:vision`, 373 pages), and a 40-page calibration subset by Claude Opus 5.5, chosen from where the
local model and our kind disagreed. Neither model saw our measurements: only the render, the extracted text (cut at
800 characters) and the definitions in `label-pages.mjs`.

**The labels are not ground truth.** Where the two models disagree is reported, and a cut-off moves only where both
point the same way.
""")

code("""
import json, re
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "pdf"
DATA = HERE / "data"
QWEN, OPUS = "qwen3.8-flash-next:vision", "litellm.anthropic/claude-opus-5-5"
FILES = ["docs.jsonl", "pages.jsonl", "selection.jsonl", "selection-opus.jsonl",
         "labels-qwen3.8-flash-next-vision.jsonl", "labels-litellm.anthropic-claude-opus-5-5.jsonl", "cost.json"]
pd.set_option("display.width", 160)
pd.set_option("display.max_columns", 30)

def jsonl(name):
    return [json.loads(l) for l in (DATA / name).read_text().splitlines() if l.strip()]

pd.DataFrame([{"file": f"data/{f}", "sha256": wmlnb.sha256_file(DATA / f)[:16],
               "rows": len(jsonl(f)) if f.endswith(".jsonl") else None} for f in FILES])
""")

md("""
## The cut-offs, read from the source

The constants are read from `pdf-classify.ts` and `pdf-measure.ts`, never copied, and `classify` below is
`classifyPage` in Python. The check after it runs the port over every measured page and requires the kind the
extension wrote, so a rule tried here is the extension's rule with one thing changed.
""")

code("""
SRC = wmlnb.ROOT / "src" / "pdf"
def constants(path):
    return {k: float(v.replace("_", "")) for k, v in re.findall(r"export const ([A-Z_]+) = ([0-9._]+);", path.read_text())}
C = constants(SRC / "pdf-classify.ts")
FULL_PAGE_COVER = constants(SRC / "pdf-measure.ts")["FULL_PAGE_COVER"]

def classify(m, c=C, ocr_min_chars=None):
    \"\"\"classifyPage (pdf-classify.ts) over one page's measurements. `ocr_min_chars`, when set, is the usable characters
    an OCR layer needs to make a page `ocr-scan`, in place of TEXT_MIN_CHARS.\"\"\"
    junk = m["brokenChars"] >= c["BROKEN_MIN_CHARS"] and m["brokenRatio"] > c["BROKEN_MAX_RATIO"]
    clean = m["brokenRatio"] <= c["BROKEN_MAX_RATIO"]
    enough = m["usableChars"] >= c["TEXT_MIN_CHARS"] and clean
    ocr_enough = enough if ocr_min_chars is None else (m["usableChars"] >= ocr_min_chars and clean)
    if ocr_enough and m["fullPageImage"] and m["invisibleShare"] >= c["OCR_INVISIBLE_SHARE"]: return "ocr-scan"
    figure = m["imageCover"] >= c["MIXED_COVER"] or m["pathCover"] >= c["MIXED_PATH_COVER"]
    if enough: return "mixed" if figure else "text"
    if junk or m["imageCover"] >= c["SCANNED_COVER"]: return "scanned"
    if m["usableChars"] < c["BLANK_CHARS"]: return "blank" if m["drawnCover"] < c["BLANK_COVER"] else "mixed"
    return "mixed" if figure else "text"

pages = pd.DataFrame(jsonl("pages.jsonl"))
pages["src"] = pages.id.str.split("-").str[0]
port = pages.apply(lambda r: classify(r), axis=1)
assert (port == pages.kind).all(), pages[port != pages.kind][["id", "n", "kind"]]
print(f"the port reproduces all {len(pages)} measured kinds")
pd.Series(C | {"FULL_PAGE_COVER": FULL_PAGE_COVER}).to_frame("value")
""")

md("""
## The corpus

Every document was read: none refused, none truncated. The `ia` scans are what most real scans are, which is why
`scanned` and `ocr-scan` dominate the page count; the labelled set caps each document, so a 500-page book does not
drown out a 3-page form.
""")

code("""
docs = pd.DataFrame(jsonl("docs.jsonl"))
docs["src"] = docs.id.str.split("-").str[0]
print(f"{len(docs)} documents, {docs.bytes.sum() / 1e6:.1f} MB, {len(pages)} pages;",
      f"refused: {docs.get('refused', pd.Series(dtype=str)).notna().sum()}, truncated: {docs.get('truncated', pd.Series(dtype=str)).notna().sum()}")
pd.crosstab(pages.src, pages.kind, margins=True)
""")

md("""
## The labels

One row per labelled page, our measurements beside each model's label. `trust` is the decision the kind exists for:
whether the text layer is read as the page's words. Ours trusts it for `text`, `mixed` and `ocr-scan`; a model trusts
it when it called the layer `match`, `partial` or `hidden`. `partial` counts as trusted: the excerpt was cut at 800
characters, so on a long page `partial` says nothing more than `match`.
""")

code("""
def labels(name):
    rows = jsonl(name)
    bad = [r for r in rows if not r.get("label")]
    for r in bad: print(f"{name}: {r['id']} p{r['n']} has no label: {r.get('error') or 'unparsed reply'}")
    return pd.DataFrame([{"id": r["id"], "n": r["n"], "kind_m": r["label"].get("kind"), "layer_m": r["label"].get("textLayer"),
                          "conf_m": r["label"].get("confidence")} for r in rows if r.get("label")])

TRUSTED = ["match", "partial", "hidden"]
q = labels("labels-qwen3.8-flash-next-vision.jsonl").rename(columns={"kind_m": "q_kind", "layer_m": "q_layer", "conf_m": "q_conf"})
o = labels("labels-litellm.anthropic-claude-opus-5-5.jsonl").rename(columns={"kind_m": "o_kind", "layer_m": "o_layer", "conf_m": "o_conf"})
L = pages.merge(q, on=["id", "n"]).merge(o, on=["id", "n"], how="left")
L["ours_trust"] = L.kind.isin(["text", "mixed", "ocr-scan"])
L["q_trust"] = L.q_layer.isin(TRUSTED)
L["o_trust"] = np.where(L.o_layer.notna(), L.o_layer.isin(TRUSTED), np.nan)
print(f"{len(L)} pages labelled by qwen, {L.o_kind.notna().sum()} of them by Opus")
print("qwen's confidence:", L.q_conf.value_counts().to_dict(), " Opus's:", L.o_conf.value_counts().to_dict())
""")

md("""
### Kind against kind

Our kind (rows) against each model's (columns). The local model calls most image-only scans of typed pages `text`:
it names what the page shows, with the text layer `none`. Opus calls every one of those it saw `scanned`. So the
local model's `kind` is not read as scan-or-not anywhere below; its `textLayer` is, and on that the two models agree
on 38 of 40 pages.
""")

code("""
display(pd.crosstab(L.kind, L.q_kind).rename_axis(index="ours", columns="qwen"))
display(pd.crosstab(L.q_layer, L.kind).rename_axis(index="qwen's text layer", columns="ours"))
lo = L[L.o_kind.notna()]
display(pd.crosstab(lo.kind, lo.o_kind).rename_axis(index="ours", columns="Opus"))
display(pd.crosstab(lo.q_kind, lo.o_kind).rename_axis(index="qwen", columns="Opus"))
display(pd.crosstab(lo.q_trust, lo.o_trust.astype(bool)).rename_axis(index="qwen trusts", columns="Opus trusts"))
""")

md("""
### Trust against trust

The decision that matters most: a trusted bad layer gives the model wrong words, a distrusted good one costs an image
instead of text. Ours agrees with the local model on the pages below; the disagreements are listed after.
""")

code("""
def agree(a, b): return f"{(L[a] == L[b]).sum()}/{len(L)} ({(L[a] == L[b]).mean():.1%})"
print("ours vs qwen:", agree("ours_trust", "q_trust"))
print("ours vs Opus:", f"{(lo.ours_trust == lo.o_trust.astype(bool)).sum()}/{len(lo)}")
display(pd.crosstab(L.ours_trust, L.q_trust).rename_axis(index="ours trusts", columns="qwen trusts"))
COLS = ["id", "n", "kind", "usableChars", "imageCover", "largestImage", "fullPageImage", "invisibleShare", "brokenRatio", "q_kind", "q_layer", "o_layer"]
L[L.ours_trust != L.q_trust].sort_values(["ours_trust", "id", "n"])[COLS + ["ours_trust"]]
""")

md("""
Two groups make up the disagreements:

- **Short OCR pages.** A scan with an OCR layer (one full-page image, all of its text invisible) whose layer holds fewer
  than `TEXT_MIN_CHARS` usable characters fails `enough` and falls to `scanned`: a title page, a chapter opening, a
  plate with a caption. The models read those layers as the page's words, but `scanned` is not a verdict that the
  layer is wrong: it sends the page's image, which on a short page is most of what it carries. The next section asks
  whether those pages should be `ocr-scan` instead.
- **Broken text layers.** `pdfjs-tamreview` (broken ratio 0.66 to 0.87, read by the local model as `partial`: some
  readable words among the junk) is distrusted by us, and two pages with ratios of 0.16 and 0.23 are trusted by us but
  `garbled` to the model (Opus confirms the 0.16 one). Too few pages either side of 0.3 to move `BROKEN_MAX_RATIO`.
""")

md("""
## The OCR rule: should a short OCR layer make an `ocr-scan`?

An `ocr-scan` page is given to the model as its text alone; the image goes too only when the layer reads as broken
(`docs/spec/FILE_ATTACHMENTS.md`, the table of page kinds). The rule tried: a page is `ocr-scan` when its layer has at
least `BLANK_CHARS` usable characters (the point below which we call a page empty), with the same clean-layer,
full-page-image and invisible-share tests. Everything else stays.
""")

code("""
OCR_MIN = C["BLANK_CHARS"]
L["kind_ocr"] = L.apply(lambda r: classify(r, ocr_min_chars=OCR_MIN), axis=1)
L["trust_ocr"] = L.kind_ocr.isin(["text", "mixed", "ocr-scan"])
print("labelled pages that change kind:", (L.kind_ocr != L.kind).sum())
print("ours vs qwen, before:", agree("ours_trust", "q_trust"), " after:", agree("trust_ocr", "q_trust"))
lo = L[L.o_kind.notna()]
print("ours vs Opus, before:", f"{(lo.ours_trust == lo.o_trust.astype(bool)).sum()}/{len(lo)}",
      " after:", f"{(lo.trust_ocr == lo.o_trust.astype(bool)).sum()}/{len(lo)}")
moved = L[L.kind_ocr != L.kind]
display(moved[["id", "n", "usableChars", "kind", "kind_ocr", "q_kind", "q_layer", "o_kind", "o_layer"]])
print("of the pages that move, qwen sees a picture (mixed or figure) on", moved.q_kind.isin(["mixed", "figure"]).sum())
allk = pages.apply(lambda r: classify(r, ocr_min_chars=OCR_MIN), axis=1)
print(f"over the whole corpus, {(allk != pages.kind).sum()} of {len(pages)} pages move:")
pd.crosstab(pages.kind, allk).rename_axis(index="now", columns="with the rule")
""")

md("""
The pages that move are short OCR pages only, all from `scanned` to `ocr-scan`, and the rule buys the local model's
agreement on trust while Opus's does not move: it gains one page and loses another, a 7-character layer that both
models call `garbled`. Trust is the wrong yardstick here, because the move also takes the image away, and on a fifth
of these pages the local model sees a picture (an illustrated title page, a plate); others are a handful of OCR'd
characters over a page whose content is its image. **The OCR rule stays.** What a short clean layer could still do is
travel WITH the image of a `scanned` page, a hundred characters beside three thousand image tokens; that is the
reader's choice of what to send, not the classifier's.
""")

md("""
## `MIXED_COVER`: when a text page also needs its picture

For pages with enough text, the local model's `mixed` or `figure` reads as "the picture matters". The table sweeps the
cut: at each value, how many pages ours would call `mixed` that the model calls `text` (an image sent for nothing), and
how many the model sees a picture on that ours would call `text` (a picture lost).
""")

code("""
e = L[(L.usableChars >= C["TEXT_MIN_CHARS"]) & (L.brokenRatio <= C["BROKEN_MAX_RATIO"]) & ~L.kind.isin(["ocr-scan"])].copy()
e["q_pic"] = e.q_kind.isin(["mixed", "figure", "scanned"])
e["o_pic"] = np.where(e.o_kind.notna(), e.o_kind.isin(["mixed", "figure", "scanned"]), np.nan)
rows = []
for cut in [0.01, 0.02, 0.03, 0.05, 0.07, 0.09, 0.1, 0.12, 0.15, 0.2, 0.25]:
    pic = e.imageCover >= cut
    rows.append({"cut": cut, "image for nothing": int((pic & ~e.q_pic).sum()), "picture lost": int((~pic & e.q_pic).sum()),
                 "lost, no image at all": int((~pic & e.q_pic & (e.imageCover == 0)).sum()), "agree": f"{(pic == e.q_pic).mean():.1%}"})
display(pd.DataFrame(rows).set_index("cut"))
print("highest image cover on a page qwen calls text:", round(e[~e.q_pic].imageCover.max(), 3))
print("Opus on the same pages (n =", e.o_kind.notna().sum(), "):")
display(pd.crosstab(e[e.o_kind.notna()].q_pic, e[e.o_kind.notna()].o_pic.astype(bool)).rename_axis(index="qwen: picture", columns="Opus: picture"))

fig, ax = plt.subplots(figsize=(8, 2.2))
for y, (lab, s) in enumerate([("qwen: text", e[~e.q_pic]), ("qwen: picture", e[e.q_pic])]):
    ax.scatter(s.imageCover, np.full(len(s), y) + np.random.default_rng(0).uniform(-0.15, 0.15, len(s)), s=10, alpha=0.6)
ax.axvline(C["MIXED_COVER"], color="grey", ls="--", lw=1); ax.text(C["MIXED_COVER"], 1.35, " MIXED_COVER", fontsize=8)
ax.set_yticks([0, 1], ["qwen: text", "qwen: picture"]); ax.set_xlabel("image cover (pages with enough text)"); ax.set_xlim(-0.01, 0.7)
plt.tight_layout(); plt.show()
""")

md("""
No page the model calls `text` has more than about 9% of its area under images, and between that and the first value,
15%, every page is one the model sees a picture on. So the cut is 0.1, just above the highest text page. What the
image cover cannot reach is the column "no image at all": vector figures (charts, plots and diagrams drawn as paths)
cover nothing by this measure. Both models call them `mixed` or `figure`; the next section measures them.
""")

md("""
## `MIXED_PATH_COVER`: vector drawing

`pathCover` is the union of every filled or stroked path's box (`pdf-measure.ts`), with a page-sized background left
out. On the pages with enough text whose image cover is under `MIXED_COVER`, the same sweep over path cover. Boxes are
drawn as paths too (form fields, a framed header, shaded cells), so a low cut sends forms as pictures.
""")

code("""
f = e[e.imageCover < C["MIXED_COVER"]]
rows = []
for cut in [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]:
    pic = f.pathCover >= cut
    rows.append({"cut": cut, "image for nothing": int((pic & ~f.q_pic).sum()), "picture found": int((pic & f.q_pic).sum()),
                 "picture still lost": int((~pic & f.q_pic).sum())})
display(pd.DataFrame(rows).set_index("cut"))
print(f"MIXED_PATH_COVER = {C['MIXED_PATH_COVER']}; the qwen-text pages over it, and the qwen-picture pages under it with some drawing:")
display(f[(f.pathCover >= C["MIXED_PATH_COVER"]) & ~f.q_pic][["id", "n", "pathCover", "paths", "usableChars", "q_kind", "o_kind"]])
display(f[(f.pathCover < C["MIXED_PATH_COVER"]) & (f.pathCover >= 0.1) & f.q_pic][["id", "n", "pathCover", "paths", "usableChars", "q_kind", "o_kind"]])
""")

md("""
The cut sits where an image sent for nothing becomes rare. Lower cuts find more figures but mostly by sending forms
and boxed pages; a figure under the cut is not lost for good, because a page sent without its image names what the
measurements saw and the model can look at it (`docs/spec/FILE_ATTACHMENTS.md`, "What is held back is named").
""")

md("""
## `SCANNED_COVER`: a page with little text that is a picture

For pages without enough text, the cover bands against what the models saw. "scan" is the local model's `scanned`, or
its `text` with no text layer (a picture of typed words).
""")

code("""
f = L[L.usableChars < C["TEXT_MIN_CHARS"]].copy()
f["q_scan"] = (f.q_kind == "scanned") | ((f.q_kind == "text") & f.q_layer.isin(["none", "hidden"]))
bands = pd.cut(f.imageCover, [-0.001, 0.005, 0.02, 0.06, 0.3, 0.5, 0.7, 0.9, 1.0])
display(pd.crosstab(bands, f.q_kind).assign(scan=pd.crosstab(bands, f.q_scan).get(True, 0)))
""")

md("""
Below 0.5 the model sees figures (scans of a figure are rare, plots on a mostly blank page common); from 0.5 up it
sees scans. The present cut sits where the data turns, and stays.
""")

md("""
## `FULL_PAGE_COVER`: the Google scans

Some Google-digitised books on the Internet Archive put each page in an image that covers 60% to 90% of the page,
below `FULL_PAGE_COVER` (0.9). Whether that matters depends on whether any such page carries an OCR layer, since
`fullPageImage` is read only by the OCR test.
""")

code("""
inv = pages[(pages.invisibleShare >= C["OCR_INVISIBLE_SHARE"]) & (pages.usableChars >= C["BLANK_CHARS"])]
print(f"{len(inv)} pages carry an invisible text layer; their largest image covers:")
display(inv.largestImage.describe().to_frame().T)
g = pages[(pages.largestImage >= 0.6) & (pages.largestImage < FULL_PAGE_COVER)]
print(f"{len(g)} pages in {g.id.nunique()} documents have a largest image between 0.6 and FULL_PAGE_COVER;",
      f"with any invisible text: {(g.invisibleGlyphs > 0).sum()}; usable characters, max: {g.usableChars.max()}")
g.groupby("id").agg(pages=("n", "size"), largest=("largestImage", "median"), usable_max=("usableChars", "max"), kinds=("kind", lambda k: dict(k.value_counts())))
""")

md("""
Every page with an OCR layer here has one image over the whole of it, and the pages whose largest image falls short
of the cut carry no invisible text, so they are `scanned` whatever `FULL_PAGE_COVER` is. The corpus has no page that would tell 0.9 from 0.6; it
stays until one turns up.
""")

md("""
## `BLANK_*`: what counts as empty

Pages with fewer than 10 usable characters, against both models.
""")

code("""
b = L[L.usableChars < 10][["id", "n", "kind", "usableChars", "imageCover", "q_kind", "q_layer", "o_kind"]]
display(b[b.imageCover < C["SCANNED_COVER"]].sort_values("usableChars"))
""")

md("""
The models call a page with only a page number (5 to 9 characters) `blank`; ours calls it `text`, which sends those
characters and nothing else. The two cost the same, and the models split on them (Opus calls 2 `blank` and 2 `text`),
so `BLANK_CHARS` stays. The blank test reads drawn cover (images and paths together), and a page with no text but
anything drawn is `mixed`, since the drawing is all it has. Both vector figures that read as `blank` before are `mixed`
now: the floor plan (`pdfjs-22060-a1-01-plans`) by its paths, `pdfjs-personwithdog` by its gradients (`shadingFill`
inside clip paths, counted by the clip's box).
""")

md("""
## What the labels cost

Opus is priced by the bench's pricer at the price snapshot each call ran under; the local model's draw is read from
the box's event log over the run, as the bench does (`tests/e2e/bench/electricity.mjs`), and "above rest" is what the
run added to what the box draws idle.
""")

code("""
cost = json.loads((DATA / "cost.json").read_text())
rows = []
for model, m in cost.items():
    en = m.get("energy") or {}
    rows.append({"model": model, "pages": m["calls"], "tokens in": m["promptTokens"], "tokens out": m["completionTokens"],
                 "s per page": round(m["wallMs"] / m["calls"] / 1000, 2),
                 "USD": round(m["usd"]["computed"], 3) if not m["local"] else None,
                 "Wh": round(en.get("Wh", np.nan), 1), "Wh above rest": round(en.get("aboveWh", np.nan), 1),
                 "electricity": f"{en['costAbove']:.4f} {en['currency']} above rest" if en else None,
                 "per page": f"${m['usd']['computed'] / m['calls']:.4f}" if not m["local"] else f"{en['aboveWh'] / m['calls']:.2f} Wh"})
pd.DataFrame(rows).set_index("model")
""")

md("""
The local model labelled 373 pages for 2.6 euro cents of electricity above rest (0.27 Wh a page); Opus cost $0.016 a
page, over 200 times as much, and was needed only to say which of the local model's calls to believe. Whether anything
else ran on the box during the run was not checked, so the energy is the box's draw, not the model's alone.
""")

md("""
## Decision (2026-10-28)

- **`MIXED_COVER` goes from 0.15 to 0.1**, just above the highest cover of any page the local model calls `text`.
- **Kept**: the OCR rule, `SCANNED_COVER`, `BLANK_*`, `BROKEN_MAX_RATIO`, `FULL_PAGE_COVER`, `TEXT_MIN_CHARS`, each
  for the reason in its section.
- **For the reader, not the classifier**: a `scanned` page whose OCR layer is short and clean could send that text
  beside its image.
- **Vector figures**: `pdf-measure.ts` measures path cover; a page with text is `mixed` from `MIXED_PATH_COVER` (0.3)
  of it, a page with no text but anything drawn is `mixed`, and `blank` reads images and paths together. The corpus
  was re-measured with all three and this notebook re-run. Of the labelled pages, 21 changed kind, all to `mixed`: 19
  where the local model sees a picture (`mixed` or `figure`), 2 where it says `text` (the boxed pages in the path
  section). The kind agreement above falls by two all the same, because it compares names and the models' `figure` is
  our `mixed`.
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "pdf-thresholds.ipynb")
print("wrote", HERE / "pdf-thresholds.ipynb")
