"""make-ranged.py — builds ranged.ipynb: what one ranged reader over the shelf holds against an eager load, for N
sessions at once, each with a large directory (FILE_ATTACHMENTS.md, "`/files/` read by range, and `ml.fs`").

    .venv/bin/python notebooks/session-store/make-ranged.py && node scripts/nb.mjs run notebooks/session-store/ranged.ipynb
    (or: node scripts/nb.mjs make notebooks/session-store/ranged.ipynb)

The cells are written here; edit this file, not the notebook. Every number is read from data/ranged.json, written by
measure-ranged.mjs; the first cell prints its hash. Nothing is typed in.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# One ranged reader over the shelf, for N sessions at once

Shane's ruling of 2026-11-17: the `/files/` file system must not put all files in memory, so that several concurrent
sessions stay usable. This lab measures the reader the amendment specifies against the eager mount it replaces.

`measure-ranged.mjs` loads a probe extension into the e2e harness's Chromium. An extension page stands in for the
offscreen document (which owns the shelf), and one dedicated worker per session stands in for the Pyodide worker. Each
session's directory is two files of 128 MiB of random bytes, kept as IndexedDB Blobs, as the value store keeps an
attachment. Two ways to read it, for 1, 4 and 8 sessions at once:

- **lazy**: every file read through in 512 KiB `Blob.slice(a, b).arrayBuffer()` chunks, each chunk transferred to the
  session's worker, which keeps at most 32 chunks (16 MiB), the mount's bounded cache;
- **eager**: every file loaded whole as an ArrayBuffer and held, as the ruled MEMFS mount holds the directory.

Each configuration runs in a FRESH browser over one shared profile, so its baseline is not what an earlier one left
behind (a first version ran them all in one browser, and the baseline climbed from 1.0 to 3.0 GiB; its figures are
void). Every configuration runs three times, interleaved. Memory is the harness browser's process tree, sampled from
outside every 100 ms, with the macOS memory pressure level and the kernel's free-memory percentage. Under pressure
Chrome purges and the OS compresses, so RSS reads LOW, in the flattering direction: a run that leaves the normal
level is VOID and left out of every figure. A lazy run reads its directory five times over, so it lasts long enough
for the sampler to see its steady state.

The machine was shared: unit suites from other sessions may run (no other Playwright Chromium did). **Every latency
and throughput figure here is taken under that load**, and no spec sentence rests on one. It is a lab, not the product: the
channel to Python (route A's sliced wait) is not in it, since `notebooks/pyodide-mount/` measured that (0.26 ms a
request end to end).
""")

code("""
import json
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "session-store"
DATA = HERE / "data"
D = json.loads((DATA / "ranged.json").read_text())
pd.set_option("display.width", 200)
print(pd.DataFrame([{"file": "data/ranged.json", "sha256": wmlnb.sha256_file(DATA / "ranged.json")[:16]}]).to_string(index=False))
m = D["machine"]
print(f"browser: Chromium {D['browser']}; {m['cpus']}, {m['ramGiB']} GiB RAM; at {D['at']}; quick={D['quick']}")
print(f"load average before {m['load']}, after {m['loadAfter']}")
print("other Playwright browsers on the machine at start / end:", D.get("otherBrowsersAtStart"), "/", D.get("otherBrowsersAtEnd"))
print(f"each session: {D['files']} files x {D['fileMiB']} MiB; chunk {D['chunkBytes'] // 1024} KiB; cache {D['cacheChunks']} chunks; {D['reps']} runs per configuration; lazy reads {D['lazyPasses']} passes")
print("other test-slot jobs at start:", D.get("otherTestSlotJobsAtStart"), "; timings under load:", D.get("timingsUnderLoad"))
""")

md("""
## 1. Memory, lazy against eager

`grew MiB` is the peak of the browser tree's RSS during a run, less its value just before. Per configuration: the
median of the valid runs, and their range. The last columns are throughput, taken under load.
""")

code("""
runs = pd.DataFrame([{**r, "grew": r["rssPeakMiB"] - r["rssBaseMiB"]} for r in D["runs"]])
print("runs:", len(runs), "; void (memory pressure left the normal level):", int((~runs["valid"]).sum()))
void = runs[~runs["valid"]][["mode", "sessions", "rep", "maxPressureLevel", "minFreePct"]]
if len(void): print(void.to_string(index=False))
ok = runs[runs["valid"]]
agg = ok.groupby(["mode", "sessions"]).agg(valid_runs=("grew", "size"), dir_MiB_each=("dirMiBPerSession", "first"),
    grew_median=("grew", "median"), grew_min=("grew", "min"), grew_max=("grew", "max"),
    free_pct_min=("minFreePct", "min"), MBps_median=("mbPerS", "median"), chunk_ms_median=("chunkMsMedian", "median")).reset_index()
print(agg.to_string(index=False))
""")

md("""
## 2. Small files: what eager saves

200 files of 4 KiB, each read whole once: lazily (one slice each), against loading every file first and reading from
memory. Route A's channel adds about 0.26 ms a request on top of the lazy figure for a Python cell.
""")

code("""
s = D["small"]
lazy_per = s["lazyReadAllMs"] / s["files"]
eager_per = (s["eagerLoadMs"] + s["eagerReadMs"]) / s["files"]
print(pd.DataFrame([{"files": s["files"], "bytes each": s["fileBytes"], "lazy ms (all)": s["lazyReadAllMs"], "eager load ms (all)": s["eagerLoadMs"],
                     "eager read ms (all)": s["eagerReadMs"], "lazy ms per file": round(lazy_per, 3), "eager ms per file": round(eager_per, 3),
                     "lazy + route A channel ms per file": round(lazy_per + 0.26, 3)}]).to_string(index=False))
""")

md("""
## What the amendment takes from this

CONCLUSIONS
""")

nb = nbf.v4.new_notebook()
nb.cells = cells
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
out = HERE / "ranged.ipynb"
if out.exists():
    old = nbf.read(out, as_version=4)
    for new, prev in zip(nb.cells, old.cells):
        if new.cell_type == prev.cell_type and new.source == prev.source:
            new.metadata = prev.metadata
nbf.write(nb, out)
print("wrote", out)
