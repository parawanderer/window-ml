"""make-one-describer.py — builds one-describer.ipynb: the host's Rust describer compiled to wasm, run beside window.ml's TS port.

    .venv/bin/python notebooks/shell/make-one-describer.py && node scripts/nb.mjs run notebooks/shell/one-describer.ipynb
    (or: node scripts/nb.mjs make notebooks/shell/one-describer.ipynb)

The cells are written here; edit this file, not the notebook. Their numbers come from data/one-describer/, pinned from
the harness's raw output in one-describer/out/ (gitignored). To measure again: `WML_HOST=<window-ml-host checkout> sh
notebooks/shell/one-describer/build.sh`, then the scripts named in the first cell, then NB_REFRESH=1.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# One describer: the host's Rust describer as wasm, beside the TS port

Ruling 66's spike; the argument and the five answers are `docs/plan/repl/ONE_DESCRIBER_WASM_SPIKE.md`, which cites
this notebook for its figures. A decision (Shane's) rests on them, so they are kept here.

window.ml describes an `ml.sh` call in TypeScript (`describeCall`, `src/shell/program-manifest.ts`); window-ml-host
describes it again in Rust (`describe_call`, `src/manifest.rs`), and the shared vectors hold the two together. The
question: could the extension run the Rust describer compiled to `wasm32-unknown-unknown` and drop its own port?

**Method.** `one-describer/wrapper/` pulls the host's `src/manifest.rs` and `src/script_grammar.rs` in unmodified by
`#[path]` behind a raw ABI (JSON in, JSON out; no wasm-bindgen; no wasm-opt). `build.sh` builds it at opt `z`, `s`
and `3`. Then, from `notebooks/shell/one-describer/` with `node --import tsx`:

- `vectors.mjs <opt>`: every shared vector row through both describers, and each against the recorded answer.
- `fuzz.mjs 2000 <seed> <opt>`: 2,000 calls per program mutated from the vectors (swap, duplicate and drop
  arguments, flags spliced from the manifest, `--`, `-`, `=`, backslash-newline, CR-LF, astral and combining
  characters, NUL, lone surrogates, long strings), both describers, every disagreement grouped by the fields that
  differ and minimised.
- `sizes.mjs`; `bench.mjs` (compile, instantiate, per-call time); `bench2.mjs` (per program, and with the manifest
  JSON pre-serialised).

Normalisation before comparing: TS effects go through `effectKey`, as the vector test does; effect lists are sorted
(Rust sorts bytewise, JS by UTF-16 unit); object keys are sorted.
""")

code("""
import json
from pathlib import Path
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "shell"
OUT = HERE / "one-describer" / "out"
DATA = HERE / "data" / "one-describer"
VECTOR_FIELDS = {"described", "effects", "pathArgs", "actsOnDir", "runner", "okCodes", "echoes", "recursive", "hardened"}
pd.set_option("display.width", 160); pd.set_option("display.max_colwidth", 120)

def read_out():
    rows = [{"kind": "build", **json.loads((OUT / "build.json").read_text())},
            {"kind": "sizes", **json.loads((OUT / "sizes.json").read_text())},
            {"kind": "bench", **json.loads((OUT / "bench.json").read_text())},
            {"kind": "bench-by-program", **json.loads((OUT / "bench-by-program.json").read_text())}]
    for p in sorted(OUT.glob("vectors-*.json")):
        v = json.loads(p.read_text())
        rows.append({"kind": "vectors", **v})
    for p in sorted(OUT.glob("fuzz-*.json")):
        f = json.loads(p.read_text())
        # Keep each group's count, programs and up to 3 examples: the full examples stay in out/.
        f["groups"] = [{**g, "examples": g.get("examples", [])[:3]} for g in f["groups"]]
        rows.append({"kind": "fuzz", **f})
    return rows

rows = wmlnb.extract(DATA / "results.json", read_out, source={"harness": "notebooks/shell/one-describer/", "out": "notebooks/shell/one-describer/out/*.json"})
of = lambda k: [r for r in rows if r["kind"] == k]
build = of("build")[0]
pd.DataFrame(wmlnb.provenance(DATA / "results.json")).assign(host=build["host"][:12], rustc=build["rustc"])
""")

md("""
## 1. The vectors: 0 differences is the bar

Every row of `tests/fixtures/program-calls/` and `program-calls-flavoured/`, through both describers, at every opt
level. `wasmVsTs` counts rows where any output field differs; the two `…VsRecorded` columns compare the nine fields the
vector tests compare.
""")

code("""
pd.DataFrame([{k: v[k] for k in ("opt", "rows", "plain", "flavoured", "wasmVsTsDiffs", "wasmVsRecorded", "tsVsRecorded")} for v in of("vectors")])
""")

md("""
## 2. The differential fuzz: does the second port catch what the vectors do not?

A disagreement is **verdict-level** when it touches a field the vectors compare (described, effects, path arguments,
the hardened argv, …). Anything else is the `why` text or an error from the wasm side.
""")

code("""
def level(cause):
    if cause.startswith("WASM-ERROR"): return "wasm error"
    fields = set(cause.split(" / ")[0].split("+"))  # fuzz.mjs joins the differing fields with "+"
    return "verdict" if fields & VECTOR_FIELDS else "text"

# A split on the wrong separator would class every cause as text and make the verdict count 0 by construction.
assert level("described+effects") == "verdict" and level("why+effects / x") == "verdict"
assert level("why / why:non-ascii-quoting") == "text" and level("WASM-ERROR / lone-surrogate-in-argv") == "wasm error"

runs = []
for f in of("fuzz"):
    by = {"verdict": 0, "text": 0, "wasm error": 0}
    for g in f["groups"]: by[level(g["cause"])] += g["count"]
    runs.append({"opt": f["opt"], "seed": f["seed"], "calls": f["total"], "described by TS": f["tsDescribed"], "disagreements": f["disagreements"], **by})
runs = pd.DataFrame(runs).sort_values(["opt", "seed"])
display(runs)
print(f"{len(runs)} runs, {runs.calls.sum():,} calls, verdict-level disagreements: {runs.verdict.sum()}")
""")

code("""
causes = pd.DataFrame([{"opt": f["opt"], "seed": f["seed"], "cause": g["cause"], "level": level(g["cause"]), "count": g["count"]} for f in of("fuzz") for g in f["groups"]])
causes.pivot_table(index=["level", "cause"], columns=["opt", "seed"], values="count", fill_value=0)
""")

md("""
One example of each cause (seed 1, opt `z`). The astral case is TS splitting a surrogate pair when it quotes one
character of a flag cluster; the quoting case is Rust's `{:?}` (`\\\\0`, `\\\\u{301}`) against JSON (`\\\\u0000`, the raw
mark); a lone surrogate is refused by serde_json, so the wasm side errors where TS describes.
""")

code("""
import re
# A lone surrogate is one of the findings, and Jupyter cannot send one as UTF-8: show each value as JSON with surrogates escaped.
shown = lambda x: re.sub("[\\ud800-\\udfff]", lambda m: f"\\\\u{ord(m.group()):04x}", json.dumps(x, ensure_ascii=False))
f1 = next(f for f in of("fuzz") if f["opt"] == "z" and f["seed"] == 1)
pd.DataFrame([{"cause": g["cause"], **{k: shown(g["examples"][0].get(k)) for k in ("argv", "wasm", "ts")}} for g in f1["groups"] if g["examples"]])
""")

md("""
## 3. Size

The TS describer is `describeCall` and what it imports, bundled and minified by esbuild. The extension already ships
Pyodide's `pyodide.asm.wasm` at about 9.6 MB.
""")

code("""
s = of("sizes")[0]
sizes = pd.DataFrame([{"build": k, **v} for k, v in s.items() if k != "kind"]).set_index("build")
ts = sizes.loc["ts-describeCall"]
sizes.assign(**{f"x TS {c}": (sizes[c] / ts[c]).round(1) for c in ("raw", "gzip", "brotli")})
""")

md("""
## 4. Time (Node, this machine)

Compile and instantiate: median of 20 fresh compiles. Per call: every vector row, 25 timed passes after 5 warm-up
passes. None of this is Chrome's service worker, which is unmeasured.
""")

code("""
b = of("bench")[0]
print(b["node"], b["platform"], "load average", [round(x, 2) for x in b["loadavg"]])
display(pd.DataFrame(b["instantiate"]).T.round(2))
pd.DataFrame(b["latency"]).T.round(1)
""")

md("""
Where a wasm call's time goes (opt `s`): it grows with the manifest, because the whole manifest crosses as JSON and
serde parses it on every call. Pre-serialising it in JS saves only the stringify. A handle ABI (parse once, describe
by handle) was not built, so the describer's own cost is not separated.
""")

code("""
bp = of("bench-by-program")[0]
per = pd.DataFrame([{"program": p, "manifest bytes": v["manifestJsonBytes"], "ts µs": v["ts"]["medianUs"],
                     "wasm µs": v["stringifyEachCall"]["medianUs"], "wasm pre-serialised µs": v["preSerialised"]["medianUs"]}
                    for p, v in bp["byProgram"].items()]).sort_values("manifest bytes")
display(per.set_index("program"))
print("all rows, median / p95 µs:", bp["all"])
""")

md("""
## 5. What the cross-check caught in review

The number ruling 66's answer turns on: of the describer's PRs in both repos, how often did the SECOND port catch a
defect one copy would not have. Read from GitHub only (reviews, review comments, issue comments, commits); each
finding classed A (caught by comparing the ports), B (one copy would have caught it: a vector, the red team, a review
of one side), C (a cost of having two: one port lagging, an order mismatch, a pin bump, no defect), or unclear.
""")

code("""
def read_history():
    return json.loads((OUT / "history.json").read_text())

hist = wmlnb.extract(DATA / "history.json", read_history, source={"method": "gh only: PRs touching the describer's files in parawanderer/window-ml and parawanderer/window-ml-host; see the spike doc"})
h = pd.DataFrame(hist)
display(h["class"].value_counts().rename("findings").to_frame())
h[h["class"] == "A"]
""")

md("""
## 6. A cold wake in Chrome's service worker (ruling 90)

Ruling 90 asked for this before anything is built: in the real built extension, in a real Chromium, after the worker
is stopped, how long from the wake to a first described call. Ruling 90's bar is a median of at most 10 ms and a p95
of at most 50 ms for the chosen shape.

`one-describer/sw-cold.mjs` builds the extension once and makes five copies with a probe prepended to `background.js`:
`control` (the probe, no wasm), shape (a) at `z` and `s` (`describe.wasm` in the folder, `compileStreaming` started at
the top of the script, the message handler awaits it), and shape (b) at `z` and `s` (the bytes as a base64 literal,
`new WebAssembly.Module` and `Instance` run synchronously at the top). Each copy runs in two fresh profiles. Each
profile has 35 wakes: CDP `ServiceWorker.stopAllWorkers` (DevTools' Stop), wait until the target is gone, then
`chrome.runtime.sendMessage` from the extension's popup page. Each wake makes one call, alternating `rmdir` (the smallest
manifest) and `gh` (the largest). The install-time start is kept apart: it is the profile's first compile.

Three figures per wake, in ms:
- **init**: script start to the module being ready (shape (b): instantiated; shape (a): the promise resolved).
- **in worker**: script start to the first call's answer. This leaves out parsing the script before its first line,
  which is what shape (b)'s 330 kB literal adds.
- **round trip**: the page's send to the answer, the whole cold wake.

Each wasm variant's figure minus the control's median is what the describer adds.
""")

code("""
def read_sw_cold():
    d = json.loads((OUT / "sw-cold.json").read_text())
    keep = ("variant", "launch", "wake", "initial", "cold", "program", "loadavg1", "goneMs", "error", "describedField", "i", "ii", "iii")
    rows = [{"kind": "meta", **d["meta"]}]
    for r in d["records"]:
        rows.append({"kind": "wake", **{k: r.get(k) for k in keep}, "T": r.get("T"),
                     "heapUsed": (r.get("heap") or {}).get("usedSize"), "embedderHeapUsed": (r.get("heap") or {}).get("embedderHeapUsedSize"),
                     "wasmMemoryBytes": (r.get("mem") or {}).get("wasmBytes")})
    return rows

sw = wmlnb.extract(DATA / "sw-cold.json", read_sw_cold, source={"harness": "notebooks/shell/one-describer/sw-cold.mjs", "out": "notebooks/shell/one-describer/out/sw-cold.json"})
swmeta = next(r for r in sw if r["kind"] == "meta")
w = pd.DataFrame([r for r in sw if r["kind"] == "wake"])
print(swmeta["chrome"], swmeta["platform"], "| load average at start", [round(x, 1) for x in swmeta["loadavgStart"]], "at end", [round(x, 1) for x in swmeta["loadavgEnd"]])
print("wasm sha256:", {o: v["sha256"][:12] for o, v in swmeta["wasm"].items()}, "| background.js growth, bytes:", {k: v["backgroundGrowth"] for k, v in swmeta["variants"].items()})
cold = w[~w.initial]
assert (cold.cold.all() and cold.error.isna().all() and (cold[cold.variant != "control"].describedField == True).all()), "a wake that did not cold-start, errored or did not describe"
print(f"{len(cold)} stopped wakes, every one a new worker, no errors, every call described")
""")

code("""
VARIANTS = ["control", "a-z", "a-s", "b-z", "b-s"]
p95 = lambda s: s.quantile(0.95)
ctl = cold[cold.variant == "control"][["ii", "iii"]].median()
summ = []
for v in VARIANTS:
    c = cold[cold.variant == v]
    row = {"variant": v, "n": len(c)}
    for col, name in (("i", "init"), ("ii", "in worker"), ("iii", "round trip")):
        if c[col].notna().any(): row |= {f"{name} med": c[col].median(), f"{name} p95": p95(c[col]), f"{name} max": c[col].max()}
    if v != "control":
        for col, name in (("ii", "in worker"), ("iii", "round trip")):
            d = c[col] - ctl[col]
            row |= {f"{name} added med": d.median(), f"{name} added p95": p95(d)}
    summ.append(row)
summ = pd.DataFrame(summ).set_index("variant").round(1)
display(summ)
""")

md("""
The same by program, by launch and by wake 0 (the first stopped wake in each profile). If one of these split the
figures, the medians above would hide it.
""")

code("""
display(cold.pivot_table(index="variant", columns="program", values="ii", aggfunc="median").reindex(VARIANTS).round(1).add_prefix("in worker med, "))
display(cold.pivot_table(index="variant", columns="launch", values="iii", aggfunc="median").reindex(VARIANTS).round(1).add_prefix("round trip med, launch "))
display(cold[cold.wake == 0].groupby("variant")[["i", "ii", "iii"]].median().reindex(VARIANTS).round(1).add_prefix("wake 0 med, "))
""")

md("""
The install-time start (not stopped, the profile's first compile, before any code cache) for init only: its message
arrives about a second after the start, so its other figures mean nothing. Then the worker's heap after the answer
(`Runtime.getHeapUsage` on the worker target; `performance.memory` is undefined in a service worker).
""")

code("""
init = w[w.initial & (w.variant != "control")]
display(init.groupby("variant")["i"].agg(["count", "min", "median", "max"]).round(1).rename(columns=lambda c: f"install-time init {c}"))
heap = cold.groupby("variant")[["heapUsed", "embedderHeapUsed", "wasmMemoryBytes"]].median().reindex(VARIANTS)
heap["heap added, kB"] = ((heap.heapUsed - heap.loc["control", "heapUsed"]) / 1e3).round(0)
heap["embedder heap added, kB"] = ((heap.embedderHeapUsed - heap.loc["control", "embedderHeapUsed"]) / 1e3).round(0)
heap.round(0)
""")

nb = nbf.v4.new_notebook()
nb.cells = cells
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
nbf.write(nb, HERE / "one-describer.ipynb")
