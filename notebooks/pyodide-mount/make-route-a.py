"""make-route-a.py — builds route-a.ipynb: is route A's Stop latency and cost good enough for a synchronous host-backed
filesystem in the Pyodide worker (#1780), or is route B (a JSPI rebuild) needed, and what size cap does a whole-file
fetch need?

    .venv/bin/python notebooks/pyodide-mount/make-route-a.py && node scripts/nb.mjs run notebooks/pyodide-mount/route-a.ipynb
    (or: node scripts/nb.mjs make notebooks/pyodide-mount/route-a.ipynb)

The cells are written here; edit this file, not the notebook. Every number is read from the committed files in data/,
written by measure-node.mjs (the sandbox side, in Node) and measure-hops.mjs (the message hops, in Chromium); the first
cell prints each one's hash. Nothing is typed in.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Route A: a synchronous host-backed filesystem in the Pyodide worker

Issue #1780 wants Python in `python_exec` to see the person's real files (`open`, `os.walk`, `import`) through
`wmlhost`. Pyodide's filesystem is synchronous, the host is asynchronous. Route A blocks the Python worker on
`Atomics.wait` in slices of 50 ms, checking the interrupt flag between slices, while the request travels worker, offscreen
document, service worker, `wmlhost` and back. Route B rebuilds Pyodide with JSPI so a filesystem call can suspend instead.

Two questions, answered from measurements:

1. **Is route A's Stop latency and cost good enough, or is route B needed?** Stop latency: how long after Stop is pressed
   does a cell blocked in the filesystem raise `KeyboardInterrupt`, and does the interrupt leave the next cell clean.
   Cost: what one operation, one `os.walk` and one `import` cost, sandbox side and across the real message hops.
2. **What size cap does a whole-file fetch need?** `open().read()` on a mounted file fetches the whole file into the
   worker; where does it stop working, and does reading in chunks avoid it.

The sandbox side was measured in Node (`measure-node.mjs`, real Pyodide, a prototype filesystem type in a
`worker_threads` Worker, the host in the main thread serving requests from the real disk). The hops were measured in a
real Chromium with the built extension and a real `wmlhost` (`measure-hops.mjs`). Neither run contains the other, so
the end-to-end cost of a walk or an import is an **estimate composed from the two** (the last section), not a
measurement. The figures are one machine (see the first table); large files are sparse, so they time memory copies, not disk.
""")

code("""
import json
import numpy as np
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "pyodide-mount"
DATA = HERE / "data"
FILES = sorted(p.name for p in DATA.glob("*.json"))
pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 40)
pd.set_option("display.max_colwidth", 80)

def load(name):
    return json.loads((DATA / name).read_text())

D = {name[:-5]: load(name) for name in FILES}
MS = lambda s, k="median": s[k] if s else None

print(pd.DataFrame([{"file": f"data/{f}", "sha256": wmlnb.sha256_file(DATA / f)[:16]} for f in FILES]).to_string(index=False))
m, h = D["node-stop"]["machine"], D["hops-chain"]["machine"]
print()
print(f"sandbox side: {m['cpu']}, {m['cores']} cores, {m['memGB']} GB, node {m['node']}, {m['pyodide']}, {m['date']}")
print(f"hops: {h['cpu']}, chromium {h['chromium']}, node {h['node']}, quick={h['quick']}, host: wmlhost {D['hops-sw-host']['helloInfo']['version']} ({D['hops-sw-host']['helloInfo']['sandbox']['kind']} sandbox)")
print()
for c in D["node-stop"]["caveats"]:
    print("-", c)
print("hop failures recorded:", D["hops-failures"]["failures"] or "none")
""")

md("""
## 1. Stop latency

A cell blocks inside a filesystem call (the host never answers); the stopper sets the interrupt flag, and in the
`notify` rows also wakes the waiter with `Atomics.notify`. `stopToHandler` is the time from the flag to Python's
`KeyboardInterrupt` handler running. A pure slice waits for the end of the current slice, so the latency is spread over about one
slice (the `max` column shows how far past 50 ms it goes); a notify cuts it to a wake-up. `flag cleared` is the interrupt word after the
handler (0 means the next cell is not re-interrupted), `next cell ok` is the count of repetitions where the following
cell ran normally, and `finally ops` counts filesystem operations a `finally:` block completed after the interrupt.
""")

code("""
def stop_table(key):
    s = D[key]["stop"]
    rows = []
    for r in s["rows"]:
        rows.append({"blocked operation": r["name"], "notify": r["notify"], "reps": r["reps"],
                     "outcomes": json.dumps(r["outcomes"]),
                     "to handler median ms": MS(r["stopToHandlerMs"]), "p90": MS(r["stopToHandlerMs"], "p90"),
                     "max": MS(r["stopToHandlerMs"], "max"),
                     "flag cleared": json.dumps(r["interruptWordAfterHandler"]),
                     "next cell ok": r["nextCellNormal"], "finally ops": r["finallyOpsCompleted"],
                     "failures": len(r["failures"])})
    df = pd.DataFrame(rows)
    return s["sliceMs"], df

for key, title in [("node-stop", "no lockdown"), ("node-lockdown", "lockdownReadonly")]:
    slice_ms, df = stop_table(key)
    print(f"--- {title}; slice {slice_ms} ms ---")
    print(df.to_string(index=False))
    print()
late = D["node-stop"]["late"]; late_l = D["node-lockdown"]["late"]
print("a Stop that arrives after the call returned (no lockdown):", {k: late[k] for k in ("reps", "ok")}, "bad:", late["bad"])
print("a Stop that arrives after the call returned (lockdown):   ", {k: late_l[k] for k in ("reps", "ok")}, "bad:", late_l["bad"])
""")

md("""
The aggregate below takes the worst row of each group: the `notify=False` rows are the pure slice, the `notify=True` rows
the same stop with a wake-up. Whether the slice's worst case is acceptable as a Stop is a judgement for the spec that cites this.
""")

code("""
s, sl = stop_table("node-stop")[1], stop_table("node-lockdown")[1]
s["lockdown"], sl["lockdown"] = False, True
both = pd.concat([s, sl])
agg = both.groupby(["lockdown", "notify"]).agg(rows=("reps", "size"), reps=("reps", "sum"),
        worst_median_ms=("to handler median ms", "max"), worst_p90_ms=("p90", "max"), worst_max_ms=("max", "max"),
        next_cell_ok=("next cell ok", "sum"), finally_ops=("finally ops", "sum"), failures=("failures", "sum"))
agg
""")

md("""
## 2. Per-operation cost, sandbox side

One operation on the mount against the same operation on the in-memory filesystem (MEMFS), in Node, so the channel is one
`postMessage` plus a `SharedArrayBuffer` and the host answers in the same event-loop turn: this is the **floor** the
sandbox adds, before any hop. `rawSabRoundTrip` is the bare wait-and-wake with no filesystem. `requests` is what each
operation sent to the host. The last block is the same operation with a host that takes 1 ms or 5 ms to answer, which is
what a slow hop would look like to Python.
""")

code("""
def cost_tables(key):
    c = D[key]["cost"]
    rows = [{"operation": k, "n": v["n"], "median ms": v["median"], "p90 ms": v["p90"], "max ms": v["max"]} for k, v in c["perOpMs"].items()]
    df = pd.DataFrame(rows)
    return c, df

for key, title in [("node-cost", "no lockdown"), ("node-lockdown", "lockdownReadonly")]:
    c, df = cost_tables(key)
    print(f"--- {title} ---")
    print(df.to_string(index=False))
    print("raw SAB round trip ms:", {k: c["rawSabRoundTripMs"][k] for k in ("n", "median", "p90", "max")})
    w = c["writeClose4KB"]
    print("write+close 4 KB:", {k: w["ms"][k] for k in ("n", "median", "p90", "max")}, "landed", w["landedBytes"], "bytes")
    print("requests per operation:", json.dumps(c["perOpRequests"]))
    print("with a slow host:", {k: {"median": v["median"], "p90": v["p90"], "max": v["max"]} for k, v in c["withHostDelay"].items()})
    print()
""")

code("""
c = D["node-cost"]["cost"]["perOpMs"]
pairs = {}
for k, v in c.items():
    if ", mount" in k:
        base = k.split(", mount")[0]
        other = next((o for o in c if o.startswith(base + ", MEMFS")), None)
        if other: pairs[base] = (v["median"], c[other]["median"])
pd.DataFrame([{"operation": b, "mount median ms": a, "MEMFS median ms": m_, "mount / MEMFS": round(a / m_, 1)} for b, (a, m_) in pairs.items()])
""")

md("""
## 3. Each hop's cost, in Chromium

The probe extension stands a page where the offscreen document stands, a dedicated worker where the Python worker
stands, and relays through the real service worker to a real `wmlhost`. Times are milliseconds. A single sample is
quantised to 0.1 ms by the browser's clock, so the medians of a one-sample timing read 0 or 0.1; `small-batched` times 20
back-to-back round trips and divides, which is the figure to trust below 0.1 ms.
""")

code("""
def row(label, s, extra=None):
    d = {"hop": label, "n": s["n"], "median ms": s["median"], "p90": s["p90"], "max": s["max"], "min": s["min"]}
    d.update(extra or {})
    return d

rows = []
rows += [row("worker <-> page, " + r["kind"] + " " + r["label"], r) for r in D["hops-worker-page"]["rows"]]
rows += [row(f"page -> service worker, {r['dir']} {r['label']}", r) for r in D["hops-page-sw"]["rows"]]
rows += [row("batched mean, " + k, v) for k, v in D["hops-small-batched"].items() if isinstance(v, dict) and "median" in v]
sw = D["hops-sw-host"]
rows += [row("service worker <-> wmlhost, hello", sw["hello"]), row("service worker <-> wmlhost, hello batched", sw["helloBatched"])]
wk = D["hops-wake"]
rows += [row("worker <-> worker ping-pong (batched round trip)", wk["pingpong"]["roundTripMs"]),
         row("page notify -> parked worker returns (one way)", wk["parkedWake"]["oneWayMs"])]
print(D["hops-small-batched"]["note"])
print(D["hops-page-sw"]["note"])
print(D["hops-worker-page"]["note"])
print(wk["parkedWake"]["note"])
print(pd.DataFrame(rows).to_string(index=False))
""")

code("""
rows = []
for size, r in sw["reads"].items():
    rows.append({"file": size, "bytes": r["fileBytes"], "chunk": r["chunk"], "sequential MB/s": r["seqMBps"]["median"],
                 "sequential ms": r["seqMs"]["median"], "4-deep pipeline MB/s": r["pipe4MBps"]["median"],
                 "per chunk ms": r["perChunkMs"]["median"], "bytes ok": r["bytesOk"]})
print("service worker <-> wmlhost, reading held output in chunks")
print(pd.DataFrame(rows).to_string(index=False))
print()
rows = [{"output": size, "spawn ms": r["spawnMs"], "start answer ms": r["startAnswerMs"], "wall ms": r["wallMs"], "stdout bytes": r["stdout"]["size"], "error": r["error"]} for size, r in sw["spawn"].items()]
print(pd.DataFrame(rows).to_string(index=False))
print("host:", sw["helloInfo"]["host"], sw["helloInfo"]["version"], "sandbox", sw["helloInfo"]["sandbox"]["kind"], "; configured sandboxed:", sw["configured"]["sandboxed"])
""")

md("""
## 4. The end-to-end chain

The Python worker's part is played by a worker that posts a request and blocks on `Atomics.wait` in 50 ms slices; the page
relays with `sendMessage`, the service worker relays to `wmlhost`, and the reply is written into the SAB. `hello` is the
smallest request (the **small-request round trip** the estimate below uses); files are read in 512 KiB chunks one at a
time and base64-decoded in the worker. `slices` is how many 50 ms slices a hello needed (1 means the reply landed
inside the first slice).
""")

code("""
ch = D["hops-chain"]
print(ch["note"]); print()
print(pd.DataFrame([row("hello", ch["hello"], {"slices median": ch["hello"]["slices"]["median"], "slices max": ch["hello"]["slices"]["max"]}),
                    row("hello, batched mean", ch["helloBatched"])]).to_string(index=False))
print()
rows = []
for size, r in ch["files"].items():
    rows.append({"file": size, "bytes": r["fileBytes"], "n": r["ms"]["n"], "median ms": r["ms"]["median"], "p90 ms": r["ms"]["p90"],
                 "MB/s median": r["MBps"]["median"], "MB/s min": r["MBps"]["min"], "per chunk rpc ms": r["perChunkRpcMs"]["median"],
                 "per chunk decode ms": r["perChunkDecodeMs"]["median"], "bytes ok": r["bytesOk"]})
print(pd.DataFrame(rows).to_string(index=False))
""")

md("""
## 5. `os.walk` by cache mode

A walk of the real workspace of this checkout, with two directories hidden or none, three cache modes (no listing cache; a
listing cache; a listing cache plus a directory cache), against the host's own count of files and directories (`python saw` must equal
`host truth`). `first walk` is the cell's first `os.walk`, `second walk` the same walk again in the same cell. Without a
cache the walk costs one `stat` per entry plus a `readdir` per directory; a listing that carries each entry's type removes
the per-entry `stat`.
""")

code("""
rows = []
for r in D["node-walk"]["walk"]["rows"]:
    mode = "listing+dir cache" if r["dirCache"] else "listing cache" if r["listingCache"] else "no cache"
    rows.append({"hidden": r["hidden"], "cache": mode, "files": r["hostTruth"]["files"], "dirs": r["hostTruth"]["dirs"],
                 "python saw == host": r["pythonSaw"] == r["hostTruth"], "reps": r["reps"],
                 "first walk ms": MS(r["firstWalkMs"]), "first p90": MS(r["firstWalkMs"], "p90"),
                 "first requests": MS(r["firstWalkRequests"]), "by op": json.dumps(r["firstWalkRequestsByOp"]),
                 "second walk ms": MS(r["secondWalkSameCellMs"]), "second requests": MS(r["secondWalkRequests"]),
                 "us/entry first": r["usPerEntryFirstWalk"], "error": r["error"]})
walk_df = pd.DataFrame(rows)
print("workspace:", D["node-walk"]["walk"]["workspace"])
print(walk_df.to_string(index=False))
""")

md("""
## 6. `import` by variant

Importing a package from the mount, two cases (a synthetic package of 50 modules and a real pure-Python package, pip's
vendored `rich`), by whether Python may write a `.pyc` beside the source. A `.pyc` written to the mount costs a `put`
and a `rename` per module on the first import; a second process then reads them. `channel requests` is the number of host
round trips one import makes; MEMFS rows make none.
""")

code("""
rows = []
for r in D["node-import"]["import"]["rows"]:
    rows.append({"case": r["case"].split(",")[0][:40], "variant": r["variant"], "files": r["files"], "reps": r["reps"],
                 "import median ms": MS(r["importMs"]), "p90": MS(r["importMs"], "p90"), "modules": r["modulesImported"],
                 "channel requests": MS(r["channelRequests"]), "by op": json.dumps(r["requestsByOp"]), "error": r["error"]})
import_df = pd.DataFrame(rows)
print(import_df.to_string(index=False))
""")

md("""
## 7. A large file opened whole, and where `f.read()` breaks

`open_fetch` is `open()` on the mount (which fetches the whole file into the worker in the prototype); `read_all` is
`f.read()`; `read_1MiB_loop` reads the same file in 1 MiB `read(n)` calls. The files are sparse, so the times are memory
copies. The sizes run past 2 GiB (the largest `bytes` object) to 4 GiB. The `cap` row tests a host-side fetch cap
(`maxFetch`) smaller than the file.
""")

code("""
L = D["node-large"]["large"]
rows, caps = [], []
for r in L["rows"]:
    if "cap" in r:
        caps.append(r); continue
    ra, lp = r["read_all"]["value"], r["read_1MiB_loop"]["value"]
    rows.append({"size MB": r["sizeMB"], "rep": r["rep"], "open+fetch ms": r["open_fetch"]["hostMs"],
                 "f.read()": ra.get("exc") or "ok", "f.read() bytes": ra.get("len"), "f.read() ms": round(ra["ms"], 1),
                 "read(1 MiB) loop": lp.get("exc") or "ok", "loop bytes": lp.get("len"), "loop ms": round(lp["ms"], 1),
                 "requests": json.dumps(r["requests"]), "free GB before": r["freeGBBefore"]})
large_df = pd.DataFrame(rows)
print(large_df.to_string(index=False))
print()
for c in caps:
    print("cap:", c["cap"], "->", c["result"].split(":")[0] + ":" + c["result"].split(":")[1][:40], c["requests"])
print()
print("chunk size sweep, a 100 MB file opened")
print(pd.DataFrame([{"chunk bytes": s["chunkBytes"], "reps": s["reps"], "open median ms": MS(s["fetch100MBms"]), "p90": MS(s["fetch100MBms"], "p90"),
               "requests per open": s["requestsPerOpen"], "MB/s median": s["MBperS_median"], "error": s["error"]} for s in L["chunkSweep"]]).to_string(index=False))
""")

code("""
ok = large_df[large_df["f.read()"] == "ok"]["size MB"]
bad = large_df[large_df["f.read()"] != "ok"]
loop_ok = large_df[large_df["read(1 MiB) loop"] == "ok"]["size MB"]
print(f"f.read() works up to {ok.max()} MB in this run")
print("f.read() fails:", {int(r["size MB"]): r["f.read()"] for _, r in bad.iterrows()})
print(f"the 1 MiB loop works up to {loop_ok.max()} MB (the largest size measured)")
""")

md("""
## 8. What a lockdown run can reach of the channel

Probes run in a cell under `lockdownReadonly` (the readonly default, the bridge to the browser's JavaScript refused) and
with the bridge lifted (a cell the person approved for the browser's JavaScript). A reach that shows a raw object (the
`SharedArrayBuffer` or the interrupt word) would let a cell forge a reply or clear the interrupt.
""")

code("""
P = D["node-lockdown"]["reach"]["probes"]
names = list(P["bridge refused (the readonly default)"])
def short(v):
    s = json.dumps(v) if not isinstance(v, str) else v
    return s if len(s) <= 90 else s[:87] + "..."
print(pd.DataFrame([{"probe": n, "bridge refused": short(P["bridge refused (the readonly default)"][n]), "bridge lifted": short(P["bridge lifted"][n])} for n in names]).to_string(index=False))
""")

md("""
## 9. Derived: the estimated product cost of `os.walk` and `import`

**This is an estimate composed from two measurements, not a measurement.** The sandbox-side time (Node, section 5 and 6) was
measured with a host that answers in the same event-loop turn, so it holds the Python and filesystem work and one cheap
hop per request. The chain's small-request round trip (section 4) was measured in Chromium through every real hop. The
estimate is `requests x chain round trip + Node sandbox-side time`. It counts each request's Node hop twice (about 8 us each, the raw
SAB round trip) and assumes requests are issued one at a time, as the sync filesystem must, and that `wmlhost` answers a
`stat` or `readdir` in the time it answers `hello`, which section 3 measured only for `hello`. Two round-trip figures are used because one sample is quantised to 0.1 ms:
the median of single `hello` round trips, and the median of the 20-round-trip batches.
""")

code("""
RTT_SINGLE = D["hops-chain"]["hello"]["median"]
RTT_BATCH = D["hops-chain"]["helloBatched"]["median"]
print(f"chain small-request round trip: single-sample median {RTT_SINGLE:.3f} ms; batched median {RTT_BATCH:.3f} ms")

def est(req, node_ms):
    return pd.Series({"requests": req, "node ms": node_ms,
                      "est ms (single rtt)": round(req * RTT_SINGLE + node_ms, 1),
                      "est ms (batched rtt)": round(req * RTT_BATCH + node_ms, 1)})

w = []
for r in D["node-walk"]["walk"]["rows"]:
    mode = "listing+dir cache" if r["dirCache"] else "listing cache" if r["listingCache"] else "no cache"
    w.append(pd.concat([pd.Series({"what": f"os.walk, hidden: {r['hidden']}, {mode}"}), est(MS(r["firstWalkRequests"]), MS(r["firstWalkMs"]))]))
i = []
for r in D["node-import"]["import"]["rows"]:
    if r["variant"].startswith("MEMFS"): continue
    i.append(pd.concat([pd.Series({"what": f"import, {'real rich' if r['case'].startswith('real') else r['case']}, {r['variant']}"}), est(MS(r["channelRequests"]), MS(r["importMs"]))]))
est_df = pd.DataFrame(w + i).set_index("what")
est_df["node share"] = (est_df["node ms"] / est_df["est ms (batched rtt)"]).round(2)
print(est_df.to_string())
""")

code("""
base = {}
for r in D["node-import"]["import"]["rows"]:
    if r["variant"].startswith("MEMFS, later"):
        base[r["case"]] = MS(r["importMs"])
imp = est_df[est_df.index.str.startswith("import")].copy()
imp["MEMFS later-import ms"] = [base[next(c for c in base if ("real rich" if c.startswith("real") else c) in n.split(", ", 1)[1])] for n in imp.index]
imp["est / MEMFS (batched)"] = (imp["est ms (batched rtt)"] / imp["MEMFS later-import ms"]).round(1)
print(imp[["requests", "est ms (batched rtt)", "MEMFS later-import ms", "est / MEMFS (batched)"]].to_string())
""")

md("""
## Reading the results

This notebook keeps the figures; the ruling on route A against route B, and the size cap, belongs in the spec that
cites a section of it (README.md names the scripts that wrote the inputs).
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
nbf.write(nb, HERE / "route-a.ipynb")
print("wrote", HERE / "route-a.ipynb")
