"""make-chrome-bounds.py — builds chrome-bounds.ipynb: the two figures docs/spec/SESSION_HISTORY_STORE.md left unknown
(how much an MV3 service worker holds before it dies; what quota `unlimitedStorage` gives), plus the single IndexedDB
put and the runtime message limit, which decide the same batch sizes.

    .venv/bin/python notebooks/session-store/make-chrome-bounds.py && node scripts/nb.mjs run notebooks/session-store/chrome-bounds.ipynb
    (or: node scripts/nb.mjs make notebooks/session-store/chrome-bounds.ipynb)

The cells are written here; edit this file, not the notebook. Every number is read from data/chrome.json, written by
measure-chrome.mjs; the first cell prints its hash. Nothing is typed in.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Session store: the bounds a Chrome extension actually has

Slice 1 of `docs/spec/SESSION_HISTORY_STORE.md`. Its §2 left two figures unknown, and the later slices' batch sizes rest
on them: **how much an MV3 extension service worker can hold before it dies**, and **what quota an extension gets with
and without `unlimitedStorage`**. Two more decide the same sizes and were taken from Chromium's source, not measured:
the largest single IndexedDB put, and the runtime message limit.

`measure-chrome.mjs` loads a probe extension (`probe-ext/`, a worker and a page, nothing else) into the e2e harness's
Chromium (`tests/e2e/harness.mjs`, `channel: "chromium"`, headless, a fresh profile), twice: without and with
`unlimitedStorage`. It is Playwright's Chromium build, not branded Chrome, which no longer loads an unpacked extension
from the command line. One machine, shared with other sessions: each allocation run stops at a cap, so "no death below
the cap" is a lower bound, never the limit.
""")

code("""
import json
import pandas as pd
import wmlnb

HERE = wmlnb.ROOT / "notebooks" / "session-store"
DATA = HERE / "data"
D = json.loads((DATA / "chrome.json").read_text())
GiB, MiB = 2**30, 2**20
pd.set_option("display.width", 200)
print(pd.DataFrame([{"file": "data/chrome.json", "sha256": wmlnb.sha256_file(DATA / "chrome.json")[:16]}]).to_string(index=False))
m = D["machine"]
print(f"browser: Chromium {D['browser']}; {m['cpus']}, {m['ramGiB']} GiB RAM, {m['platform']}/{m['arch']}, node {m['node']}, at {D['at']}")
print(f"load average before {m['load']}, after {m['loadAfter']}; quick={D['quick']}")
""")

md("""
## 1. What a service worker holds before it dies

The worker allocates in steps and holds every step, writing its running total to `chrome.storage.session` (kept by the
browser process, so it outlives the worker), until it dies or reaches the cap. Three kinds of memory, because a
session's data is all three at different times:

- **objects**: plain JS objects, a million small ones per step (`{ i, x, k }`), which live in V8's own heap, as parsed
  events and history messages do. Their size is V8's and not computed here; the step count and the RSS say how much.
- **string**: 64 MiB per step of random printable bytes, decoded by `TextDecoder("ascii")`. These turned out to be
  EXTERNAL strings, held outside V8's heap: the worker held 6 GiB of them, every length and one read from each checked
  at the cap, while the extension process's RSS stayed near half that. A history serialized to JSON is a V8 string
  made by `JSON.stringify`, not one of these, so this row bounds the strings Blink hands over (a decoded file, a
  fetched body), not a serialized session.
- **arraybuffer**: 64 MiB per step of random bytes, outside the JS heap, where a backup's or an export's bytes live.

Every byte held is random: a `"x".repeat(n)` string is a rope that holds almost nothing, and a page of one repeated
byte costs almost nothing under the macOS memory compressor. A first run made both mistakes and "held" 6 GiB in half
a second; it is not kept. `peak RSS` is sampled from outside every 250 ms; under memory pressure from other sessions
on this machine it reads BELOW the bytes held (compressed or swapped pages are not resident), so it shows the memory
was real, never how much.

`performance.memory` does not exist in an extension service worker (`heap limit` is null), so a limit can only be
found by allocating until the worker dies.
""")

code("""
rows = []
for r in D["heap"]:
    objects = r["kind"] == "objects"
    rows.append({"held as": r["kind"], "ended": r["ended"],
                 "held": f"{r['heldBytes'] // 1_000_000}M objects" if objects else f"{r['heldBytes'] / GiB:.1f} GiB",
                 "checked at the cap": r.get("heldBytes") is not None, "cap": "96 steps" if objects else f"{r['capMiB'] // 1024} GiB",
                 "peak extension RSS MiB": r.get("peakExtensionRssMiB"), "browser tree RSS before / peak MiB": f"{r.get('chromiumRssBeforeMiB')} / {r.get('peakChromiumRssMiB')}",
                 "worker closed": r["workerClosed"], "heap limit": r["heapBefore"], "s": round(r["ms"] / 1000, 1)})
print(pd.DataFrame(rows).to_string(index=False))
print()
print("an extension PAGE's performance.memory.jsHeapSizeLimit:", D.get("pageMemory"))
""")

md("""
**One death, not reproduced.** In an earlier run (not kept: the script hung), the objects case ran FIRST, and the
extension process died during it. That was a DEATH, not a rejection: the extension process was replaced (its
successor was three seconds old when looked at), which a rejected `evaluate` never does, and the script, whose probe page died with the
process, hung and recorded nothing (the script now replaces a crashed page and runs objects last). In the run kept
here the same case reached its cap. What killed the first is not determined: V8's heap limit, or the machine's memory
pressure at that moment. An extension PAGE reports a V8 heap limit of 4.09 GiB (above); if the worker's is the same,
96 million small objects sit close to it, which fits a death in that case on one run and not on another. Either way a death in the worker takes the whole extension process, its pages with it.
""")

md("""
## 2. Quota, with and without `unlimitedStorage`

`navigator.storage.estimate()` from the worker and from an extension page, beside the disk's free space at the time.
""")

code("""
rows = []
for tag in ("default", "unlimited"):
    q = D[f"quota-{tag}"]
    rows.append({"manifest": tag, "worker quota GiB": round(q["inWorker"]["quota"] / GiB, 2), "page quota GiB": round(q["inPage"]["quota"] / GiB, 2),
                 "disk free GiB": round(q["disk"]["freeBytes"] / GiB, 2), "disk total GiB": round(q["disk"]["totalBytes"] / GiB, 2),
                 "quota / free": round(q["inWorker"]["quota"] / q["disk"]["freeBytes"], 4)})
print(pd.DataFrame(rows).to_string(index=False))
""")

md("""
## 3. The largest single IndexedDB put

One value put, read back and compared, as one string (a row's history serialized) and as an object of 1 MiB strings (a
history array). Chromium's source has a 128 MiB IPC limit for IndexedDB (`kIDBMaxMessageSize`) and wraps a value above
64 KiB as a Blob; the rows either side of 128 MiB test whether the IPC limit binds a single put.
""")

code("""
print(pd.DataFrame([{"MiB": r["mib"], "as": r["kind"], "ok": r["ok"], "put ms": r.get("putMs"), "read back equal": r.get("readBackOk"),
                     "rejected": bool(r.get("rejected")), "died": bool(r.get("died")), "error": r.get("error", "")} for r in D["idb"]]).to_string(index=False))
""")

md("""
`rejected` is the probe's `evaluate` failing, a `RangeError` while building the value included; `died` is the worker
going away. They are separate: the 512 MiB string row is a rejection, the string could not be made, and the worker
lived.""")

code("""
print("other Playwright browsers on the machine at start / end:", D.get("otherBrowsersAtStart"), "/", D.get("otherBrowsersAtEnd"))
""")

md("""
## 4. The runtime message limit

A string of the size given, sent from an extension page to the worker by `chrome.runtime.sendMessage` and over a
`Port`, and its length echoed back.
""")

code("""
print(pd.DataFrame([{"MiB": r["mib"], "via": r["via"], "ok": r["ok"], "ms": r.get("ms"), "error": (r.get("error") or "")[-60:]} for r in D["messages"]]).to_string(index=False))
""")

md("""
## What the spec takes from this

Written after the run; the figures are the tables above.

- **Messages: 64 MiB, refused at the sender.** A 64 MiB string goes through, 65 MiB fails before it is sent, with
  `Message exceeded maximum allowed size of 64MiB.`, on `sendMessage` and on a `Port` alike, and the send of
  64 MiB took 129 ms by `sendMessage` and 123 ms by a `Port`. A batch for the archive move and the backup (§5) is therefore bounded well under it; the
  spec's slices 4 and 6 use a byte budget per message, not a count of events.
- **IndexedDB: a single put is not the bound.** Values up to 256 MiB (and 512 MiB as an object of strings) were put
  and read back; the 128 MiB IPC limit does not bind a put, because a large value is wrapped as a Blob. A 512 MiB
  string cannot be made at all (`RangeError: Invalid string length`, V8's 2^29 − 24 limit), which is the bound a
  `JSON.stringify` of a session meets (§2's export row).
- **Quota.** Without `unlimitedStorage`, 10 GiB; with it, the disk's free space. window.ml declares it
  (`manifest.json:6`), so the store's budget, not the browser, is what limits saved sessions, and a full disk is the
  failure a person would meet. The `onError` handler (§3) is what tells them.
- **The worker's memory is not the first bound a session meets.** It held 96 million small JS objects (gigabytes of
  V8 heap, near the 4.09 GiB limit an extension page reports), 6 GiB of external strings and 6 GiB of ArrayBuffers without dying, each in its own run; one death in the
  objects case was not reproduced and its cause is not determined. The bounds that bind first are the 64 MiB message
  and the 512 Mi string: a whole-session copy fails on those long before the heap runs out. When the worker does die,
  it takes the extension process and its pages with it, so the spec keeps sizing every batch by bytes, not by what the
  heap would survive.
""")

nb = nbf.v4.new_notebook()
nb.cells = cells
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
out = HERE / "chrome-bounds.ipynb"
if out.exists():
    old = nbf.read(out, as_version=4)
    for new, prev in zip(nb.cells, old.cells):
        if new.cell_type == prev.cell_type and new.source == prev.source:
            new.metadata = prev.metadata
nbf.write(nb, out)
print("wrote", out)
