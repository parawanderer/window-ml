"""make-mask-matcher.py — builds mask-matcher.ipynb: what ruling 32's hash-only matcher costs a crossing, before its
widths are fixed (docs/spec/SECRET_HANDLES.md, "A secret the model never uses is stored hash-only").

    node scripts/nb.mjs make notebooks/secrets/mask-matcher.ipynb

The cells are written here; edit this file, not the notebook. The numbers come from data/mask-matcher/matcher.json,
written by measure-matcher.mjs (its header says how to run it; it needs src/secret-registry.ts, from #1948).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Ruling 32's matcher: what a crossing pays, measured

A `mask` secret is stored as, per form of its value, a length `L`, a keyed filter `F` of its first `k` UTF-16 units and
a slow confirm hash `C`; never the value. A crossing slides a window of `k` units over the text with a rolling keyed
hash modulo a prime `p`, looks each position up, and slow-confirms each hit over `L` units. The spec's provisional
widths: `k = 8`, `w = 24` (`p` = 16777213, the largest prime under 2^24), and PBKDF2-SHA256 as the slow hash at about a
millisecond. The questions, at 64 entries on a 1 MiB result:

1. How many forms does a secret really give, and so how many false candidates does a crossing raise?
2. What does the filter pass cost, against today's plaintext scrub over the same text?
3. What does the slow confirm cost at a few iteration counts, and so the whole crossing?
4. Is one filter hit (a text holding a stored 8-unit prefix) larger than the pass's own spread, i.e. a timing oracle?

`measure-matcher.mjs` runs the matcher in Node with the forms from `valueForms` (src/secret-registry.ts), a seeded
generator, and a corpus shaped like tool output (log lines, hex ids, base64 blobs) with three true occurrences planted.
One machine, run alone; the pass is repeated 15 times and the confirm 30.
""")

code("""
import json
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "secrets"
DATA = HERE / "data" / "mask-matcher"
D = json.loads((DATA / "matcher.json").read_text())
pd.set_option("display.width", 200)
print(pd.DataFrame([{"file": "data/mask-matcher/matcher.json", "sha256": wmlnb.sha256_file(DATA / "matcher.json")[:16]}]).to_string(index=False))
print(f"{D['cpu']}, node {D['node']}; N = {D['N']} units, k = {D['K']}, p = {D['P']}, {D['repeats']} repeats of each pass")
""")

md("""
## 1. Forms, and the false candidates they raise

`forms` is what `valueForms` gives after removing duplicates: for a token of letters, digits and `/+_-`, the JSON, the
percent and the shell forms mostly equal the value, so a secret gives about five forms, not the eleven the spec
assumed. `expectedFalse` is `N·E/p`; `falseCandidates` is one run's count, a Poisson draw around it.
""")

code("""
cfg = pd.DataFrame(D["configs"])
print(cfg[["entries", "forms", "refused", "maxL", "candidates", "truePositives", "planted", "falseCandidates", "expectedFalse"]].round(2).to_string(index=False))
assert (cfg["truePositives"] == cfg["planted"]).all(), "the pass missed a planted occurrence"
assert (cfg["refused"] == 0).all()
""")

md("""
## 1b. Thirty fresh keys per kind of text

One run's count is one draw. Here each kind of text gets 30 trials, each with new secrets, a new base for the rolling
hash and a new text. A candidate is a (position, form) pair whose filter matches where the form is not; its model is
`N·E/p`. A hit position is a position with at least one; its model is `N·T/p`, `T` being the number of distinct filters
in the table, which is below `E` because forms of one secret often share their first `k` units (the value and its
JSON or shell form, the two base64 alphabets). `distinct windows` counts the different `k`-unit windows in the text,
for the first three trials.
""")

code("""
tr = pd.DataFrame(D["trials"])
N_pos = tr["positions"].iloc[0]
g = tr.groupby("kind", sort=False)
s = pd.DataFrame({
    "E": g["E"].mean(), "T": g["T"].mean(),
    "pairs mean": g["falsePairs"].mean(), "pairs sd": g["falsePairs"].std(ddof=0),
    "model N·E/p": g["E"].mean() * N_pos / D["P"],
    "positions mean": g["hitPositions"].mean(), "model N·T/p": g["T"].mean() * N_pos / D["P"],
    "pairs max": g["falsePairs"].max(),
    "distinct windows": g["distinctWindows"].mean(),
})
s["sd / sqrt(mean)"] = s["pairs sd"] / s["pairs mean"].pow(0.5)
print(s.round(2).to_string())
""")

md("""
Random characters and base64 sit on the model, with a spread near Poisson's (`sd / sqrt(mean)` near 1). JSON and the
log do not: their texts have far fewer distinct windows than positions (a quarter of them for JSON), so a filter that
collides with a FREQUENT window hits once per occurrence. The count is then overdispersed: most trials low, a few large
(see `pairs max`), and the mean of 30 heavy-tailed draws can sit below the model without the hash being non-uniform.
The single run in section 1, on the log text, was one such draw. Two consequences for the build:

- **Memoise the confirm per distinct window within a crossing.** The same `L` units give the same confirm answer, so a
  clump of one repeated window costs one confirm, not one per occurrence. That bounds a crossing's confirms by the
  number of distinct colliding windows, which is what the model counts.
- **Repetitive text is the slow case, not the fast one.** A crossing's worst cost comes from a frequent window that
  collides, so a time budget is set from the tail, not the mean.
""")

md("""
## 2. The filter pass, against the plaintext scrub

`pass` looks every position up in a `Map`; `bits` checks a 2 MiB bitset of all `p` filter values first and goes to the
`Map` only on a set bit. `plaintext` is #1948's `scrubRegistry` over the same text with the same secrets as values.
""")

code("""
base = pd.DataFrame(D["baseline"])
t = cfg[["entries", "passMedianMs", "bitsMedianMs", "bitsP10Ms", "bitsP90Ms"]].merge(base[["entries", "plaintextMedianMs"]], on="entries")
t["bits / plaintext"] = t["bitsMedianMs"] / t["plaintextMedianMs"]
print(t.round(2).to_string(index=False))
""")

md("""
## 3. The slow confirm, and the whole crossing at 64 entries

A crossing pays the bitset pass plus one confirm per candidate. The `expected` column uses `N·E/p` false candidates
plus the three true ones; `observed` uses this run's count.
""")

code("""
conf = pd.DataFrame(D["confirm"])
print(conf.round(3).to_string(index=False))
c64 = cfg[cfg["entries"] == 64].iloc[0]
rows = []
for _, c in conf.iterrows():
    exp_c = c64["expectedFalse"] + c64["planted"]
    rows.append({"iterations": c["iterations"], "confirmMs": c["medianMs"],
                 "crossing ms (expected)": c64["bitsMedianMs"] + exp_c * c["medianMs"],
                 "crossing ms (observed)": c64["bitsMedianMs"] + c64["candidates"] * c["medianMs"],
                 "plaintext ms": base[base["entries"] == 64]["plaintextMedianMs"].iloc[0]})
print(pd.DataFrame(rows).round(2).to_string(index=False))
""")

md("""
## 4. One filter hit against the pass's spread

A text that holds a stored 8-unit prefix pays one more confirm than a text that does not. One crossing's noise does not
hide that: an observer who repeats a crossing `n` times shrinks the noise of the mean by `sqrt(n)`, so a fixed shift is
seen once `n` reaches about `(2·sd / hit)²`. `sd` is estimated from the bitset pass's 15 repeats as `(p90 - p10) / 2.56`
(a normal approximation), so it reflects how busy this machine was during the run. This measures only the worker's side: whether the
difference survives to a PAGE through `forPage` (a runtime message, the page's own timer resolution, other work in the
worker) is not measured here and needs an end-to-end run in the extension.
""")

code("""
spread = c64["bitsP90Ms"] - c64["bitsP10Ms"]
o = conf[["iterations", "medianMs"]].rename(columns={"medianMs": "one hit, ms"})
o["pass spread p90-p10, ms"] = spread
o["hit / spread"] = o["one hit, ms"] / spread
o["crossings to see it at 2 sd"] = ((2 * spread / 2.56) / o["one hit, ms"]).pow(2).round(0)
print(o.round(3).to_string(index=False))
""")

md("""
## What this says, and what it does not

- **The forms count was too high in the spec.** About five forms a secret, `E` ≈ 313 at 64 entries (`T` ≈ 278
  distinct filters), so about 20 false candidates a MiB at `w` ≈ 24, not 44: the model `N·E/p` holds in the mean on
  random text and base64, and on repetitive text (JSON, logs) the count is overdispersed, which the per-window memo
  bounds (section 1b).
- **The filter pass is the cost, not the confirm.** The bitset pass costs a small multiple of the plaintext scrub over
  the same MiB (section 2); the confirms add little at 20,000 iterations (section 3). A crossing at 64 entries stays under a tenth of a second a MiB on this machine.
- **The timing oracle is real on the worker's side, whatever one crossing's noise.** In a single crossing one confirm
  can sit inside the pass's spread (section 4, on this run), but a mean over repeated crossings separates it after the
  number of repeats in the last column: about twenty at 20,000 iterations, a few thousand at 1,000, on this run. A slower confirm is the louder one. Whether a page can
  repeat crossings and time them through `forPage` precisely enough is the open measurement; until it is made, the
  spec's remedy (a fixed confirm schedule, or a floor on a page's crossing) should be assumed needed.
- **Not measured here:** the confirm's resistance to guessing (that is the iteration count's job, and the spec's cost
  paragraph says what a stolen store gives), a hostile text built to collide filters (the prime modulus and the secret
  base are what stand against it), and another machine.
""")

nb = nbf.v4.new_notebook()
nb["cells"] = cells
nb["metadata"]["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
nbf.write(nb, HERE / "mask-matcher.ipynb")
print("wrote", HERE / "mask-matcher.ipynb")
