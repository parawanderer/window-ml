"""make-embed-cost.py — builds embed-cost.ipynb: how much may one read-only survey send to `ml.embed` without asking?

    .venv/bin/python notebooks/readonly/make-embed-cost.py && node scripts/nb.mjs run notebooks/readonly/embed-cost.ipynb
    (or: node scripts/nb.mjs make notebooks/readonly/embed-cost.ipynb)

The cells are written here; edit this file, not the notebook. Their numbers come from data/embed-cost/bench.json, which
`embed-bench.mjs` produced against the box's embedding models (NB_REFRESH=1 runs it again, about two minutes, and needs
OPENWEBUI_URL and OPENWEBUI_KEY in .env).
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# How much may one survey embed without asking?

`ml.embed` is the one member of the read-only dialect that makes a live model call (`docs/dev/readonly-exec.md`, the
`EMBED_SURVEY_*` row). The step budget measures the interpreter's own time, about a second; an embed's time is the
embedding server's, so it is bounded by three caps instead (`src/readonly-exec/limits.ts`): characters per survey
(`EMBED_SURVEY_CHARS`), calls per survey (`EMBED_SURVEY_CALLS`) and strings per call (`EMBED_CALL_INPUTS`).

This reads the wall time of `/ollama/api/embed` through the OpenWebUI passthrough, with the placement the default config
sends (`num_gpu: 0`, CPU), over page-sized chunks (2,000 characters) of this repo's specs, for batches of 1 to 64, three
times each. The question: what do the caps cost in wall time on the models a person would configure?
""")

code("""
import json
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "readonly"
EXTRACT = HERE / "data" / "embed-cost" / "bench.json"
SURVEY_CHARS, SURVEY_CALLS, CALL_INPUTS = 500_000, 32, 512

def run_bench():
    import subprocess
    out = subprocess.run(["node", "notebooks/readonly/embed-bench.mjs"], cwd=wmlnb.ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)

data = wmlnb.extract(EXTRACT, run_bench, source={"driver": "notebooks/readonly/embed-bench.mjs", "cmd": "node notebooks/readonly/embed-bench.mjs"})
print(data["meta"])
df = pd.DataFrame([r for r in data["rows"] if "ms" in r])
df["chars_per_s"] = df.chars / (df.ms / 1000)
df["tokens_per_char"] = df.tokens / df.chars
pd.DataFrame(wmlnb.provenance(EXTRACT))
""")

md("""
## Throughput by model and batch

Median of three. A batch of one pays the round trip; from eight on, the server is the limit.
""")

code("""
t = df.groupby(["model", "batch"]).agg(ms=("ms", "median"), chars_per_s=("chars_per_s", "median"),
                                       slowest_chars_per_s=("chars_per_s", "min"), tokens_per_char=("tokens_per_char", "median"))
t.round(3)
""")

md("""
## What the caps cost

The character cap at each model's slowest batched throughput (batch 8 and up), plus the call cap at the median
one-input round trip: the longest a survey can keep the embedding server busy without anyone being asked.
""")

code("""
batched = df[df.batch >= 8].groupby("model").chars_per_s.min()
single = df[df.batch == 1].groupby("model").ms.median()
cost = pd.DataFrame({
    "chars_cap_s": (SURVEY_CHARS / batched).round(1),
    "calls_cap_s": (SURVEY_CALLS * single / 1000).round(1),
    "pages_of_2000_chars": SURVEY_CHARS // 2000,
})
cost
""")

md("""
## Reading

- `embeddinggemma:300m`, the model the Settings hint names, embeds about 23,000 characters a second on CPU. At
  500,000 characters, a survey keeps it busy for about 22 to 27 seconds: 250 pages of 2,000 characters, enough to
  map a long PDF.
- `qwen3-embedding:0.6b` is about four times slower: about 87 seconds at the cap. A larger embedding model is slower
  still. The cap is in characters, not seconds, so the wall time scales with the model a person picked. The run's
  Stop halts a survey at its next await (`docs/dev/readonly-exec.md`, "Stopped by the run").
- One call alone is 120 to 450 ms, mostly the round trip. 32 calls are at most about 4 to 13 seconds of overhead, and a
  survey that needs more batches them (`ml.embed([a, b, c])`).
- 512 strings a call is past the batch size at which throughput stops rising (8). It only bounds how much one request
  carries.
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "embed-cost.ipynb")
print("wrote", HERE / "embed-cost.ipynb")
