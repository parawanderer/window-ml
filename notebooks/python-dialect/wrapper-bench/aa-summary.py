"""aa-summary.py <aa.json>: the same-core A/A figures the memory row quotes, from a drive-quiet.mjs (or probe3) run.

Per round: the two labels' min-over-reps held timings; the ratio label2/label1 of the AFTER timings, the
difference-in-differences (after/before)_2 / (after/before)_1, and (after - before) / held_n in ns for each label.
Medians over rounds are what a claim quotes; a single round swings 1.3x either way on this box.
"""
import json, statistics as st, sys

d = json.load(open(sys.argv[1]))
rounds = d["rounds"] if isinstance(d, dict) else d
labels = sorted({r["label"] for r in rounds})
by = {}
for r in rounds:
    by.setdefault(r["round"], {})[r["label"]] = r
ratio, did, ns = [], [], []
for k in sorted(by):
    if len(by[k]) < 2:
        continue
    a, b = (by[k][l] for l in labels[:2])
    ah, bh = min(a["after"]["held"]), min(b["after"]["held"])
    ab, bb = min(a["before"]["held"]), min(b["before"]["held"])
    ratio.append(bh / ah)
    did.append((bh / bb) / (ah / ab))
    for x, xb, n in ((ah, ab, a["held_n"]), (bh, bb, b["held_n"])):
        ns.append((x - xb) / n * 1e9)
meta = d.get("meta", {}) if isinstance(d, dict) else {}
print(f"labels {labels[1]}/{labels[0]}, rounds {len(ratio)}")
print(f"A/A ratio of after.held: median {st.median(ratio):.3f}, min {min(ratio):.3f}, max {max(ratio):.3f}, symmetric max {max(max(ratio), 1/min(ratio)):.2f}")
print(f"DiD (after/before): median {st.median(did):.3f}")
print(f"(after - before) per held allocation: median {st.median(ns):.1f} ns, range {min(ns):.1f}-{max(ns):.1f}, n={len(ns)}")
for k in ("started", "load_before", "load_after", "spinners_before", "spinners_after"):
    if k in meta:
        print(f"{k}: {meta[k] or '(none)'}")
