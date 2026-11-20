"""make-decode-cache.py — builds decode-cache.ipynb: what the worker's decode of a 64 MB stored CSV costs, and the size of
the decode cache (`TABLE_DECODE_CACHE_BYTES`) set from it.

    .venv/bin/python notebooks/tables/make-decode-cache.py && node scripts/nb.mjs run notebooks/tables/decode-cache.ipynb
    (or: node scripts/nb.mjs make notebooks/tables/decode-cache.ipynb)

The cells are written here; edit this file, not the notebook. Their numbers come from data/decode-cache/bench.json, which
`decode-bench.mjs` produced (NB_REFRESH=1 runs it again: about half a minute and 2 GB of memory).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# The stored-table decode cache: what one decode costs, and how much to keep

Slice A of the lazy table (`docs/spec/ML_TABLE.md`, "Views of a stored table in JS") decodes a stored table once in the
service worker and keeps the decode as Arrow columns (`src/table/table-decode-cache.ts`). Before it, every `col`,
`select`, `records` and long `head` on a stored table re-parsed the whole body. The spec set the cache's size,
`TABLE_DECODE_CACHE_BYTES`, at 256 MiB provisionally, to be measured on the largest table a fetch stores:
`FETCH_TABLE_MAX`, 64 MB of CSV.

`decode-bench.mjs` generates 64 MB of seeded CSV in three shapes and decodes each in its own Node process through the
real `cachedStoredColumns`:

- **mixed**: an id, a price, a quantity, a region from eight, a SKU, a date, a boolean and a mostly empty note;
- **numeric**: eight float columns;
- **text**: four string columns of 6 to 30 characters.

It records the decode's wall time, what the cache charges for the decode (Arrow buffer bytes), what the heap and array
buffers hold after a collection with the decode kept, the peak RSS over the RSS just before the decode, and the time of
a second read from the cache. This is Node's V8, not the extension's service worker: the same engine, a different
embedder and version, so the times are indicative and the byte counts are the code's own.
""")

code("""
import json
import subprocess
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "tables"
EXTRACT = HERE / "data" / "decode-cache" / "bench.json"
CACHE_BYTES = 256 * 1024 * 1024

def run_bench():
    out = subprocess.run(["node", "--import", "tsx", "notebooks/tables/decode-bench.mjs"], cwd=wmlnb.ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)

data = wmlnb.extract(EXTRACT, run_bench, source={"driver": "notebooks/tables/decode-bench.mjs", "cmd": "node --import tsx notebooks/tables/decode-bench.mjs"})
print(data["meta"])
df = pd.DataFrame(data["rows"]).set_index("shape")
pd.DataFrame(wmlnb.provenance(EXTRACT))
""")

md("""
## One decode of a 64 MB CSV

`charged_mb` is what the cache counts against its cap; `kept_mb` is what the process holds for the decode after a
collection (heap plus array buffers). `peak_over_mb` is the parse's working set: the parser's rows and strings, which
exist only while it runs. Today's code pays that peak on every read of a stored table; the cache pays it once per
table and options.
""")

code("""
mb = lambda b: (b / 1e6).round(1)
t = pd.DataFrame({
    "rows": df.rows,
    "decode_ms": df.decode_ms,
    "cached_read_ms": df.cached_read_ms,
    "charged_mb": mb(df.cache_bytes),
    "kept_mb": mb(df.retained_heap_bytes + df.retained_array_buffer_bytes),
    "peak_over_mb": mb(df.peak_rss_over_before_bytes),
    "decodes": df.decodes,
})
t
""")

md("""
## The cache's size

How many decodes of the largest storable table fit in the provisional 256 MiB, by shape.
""")

code("""
fit = pd.DataFrame({"charged_mb": mb(df.cache_bytes), "fit_in_256_mib": (CACHE_BYTES // df.cache_bytes).astype(int)})
fit
""")

md("""
## Decided

`TABLE_DECODE_CACHE_BYTES` stays at **256 MiB**, now measured:

- One 64 MB CSV decodes to 58 to 90 MB of Arrow columns, so the cache holds two to four of the largest tables a fetch
  can store, and many more of the usual smaller ones.
- What the cache keeps is what it counts: the process holds 3 to 4 MB more than the charge once the decode is kept,
  which is Arrow's vector objects. A first version held 80 MB more, because the getters shared their builder's closure
  and kept the parser's cells alive; the getters are now made in functions of their own.
- The cost that matters to the worker is the parse's peak, at least 0.6 to 1.2 GB over the RSS before it: a lower
  bound, because that RSS (285 to 903 MB) still holds the generator's garbage. That is the parser's,
  not the cache's, and it is not new: every stored read paid it before slice A. A larger cache would not lower it, and
  a smaller one would make reads pay it more often.
- A decode larger than the cap is used for its one read and not kept, so the cap bounds what stays resident, never
  what one read may decode.

A cached read of one column takes 36 to 95 ms, against 2.3 to 3.7 s for the decode.
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "decode-cache.ipynb")
print("wrote", HERE / "decode-cache.ipynb")
