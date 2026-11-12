"""drive.py: run probe-all.mjs over every line of pins.txt, WORKERS interpreters at once, one fresh process per project.

    python3 -I drive.py <window-ml repo root> <pins.txt> <out dir> [workers] [timeout_s]

Writes <out>/raw/<project>.jsonl (the probe's stdout as it came, so a killed run keeps its partial lines) and appends
one summary row per project to <out>/summary.jsonl. Resumable: a project whose summary row exists is skipped.
"""
import json, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

root, pins, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
workers = int(sys.argv[4]) if len(sys.argv) > 4 else 6
timeout = int(sys.argv[5]) if len(sys.argv) > 5 else 900
probe = Path(__file__).resolve().parent / "probe-all.mjs"
(out / "raw").mkdir(parents=True, exist_ok=True)
summary = out / "summary.jsonl"
done = set()
if summary.exists():
    done = {json.loads(l)["spec"] for l in summary.read_text().splitlines() if l.strip()}
specs = [s.strip() for s in pins.read_text().splitlines() if s.strip() and s.strip() not in done]


def one(spec: str) -> dict:
    name = spec.split("==")[0]
    raw = out / "raw" / f"{name}.jsonl"
    t0 = time.time()
    with raw.open("w") as fh:
        try:
            p = subprocess.run(["node", str(probe), spec], cwd=root, stdout=fh, stderr=subprocess.PIPE, text=True, timeout=timeout)
            stage, err = None, (p.stderr or "")[-400:] if p.returncode else None
            head = (p.stderr or "")[:400] if p.returncode else None
        except subprocess.TimeoutExpired:
            stage, err, head = "timeout", None, None
    evs = [json.loads(l) for l in raw.read_text().splitlines() if l.startswith("{")]
    last = next((e for e in reversed(evs) if e.get("ev") == "done"), None)
    started = [e["m"] for e in evs if e.get("ev") == "start"]
    finished = {e["m"] for e in evs if e.get("ev") == "import"}
    row = {"spec": spec, "wall_s": round(time.time() - t0, 1),
           "stage": last["stage"] if last else (stage or "crash"),
           "died_in": next((m for m in reversed(started) if m not in finished), None) if not last else None,
           "stderr_tail": err if not last else None,
           # the head too: a wasm trap's tail is all stack frames and cut off the cause of the pillow crash
           "stderr_head": head if not last else None}
    if last and last.get("stage") == "ok":
        row.update({k: last[k] for k in ("modules", "ok", "failed", "truncated")})
        row["failures"] = [{k: e.get(k) for k in ("m", "error_type", "error", "where")}
                           for e in evs if e.get("ev") == "import" and not e["ok"]]
    return row


with ThreadPoolExecutor(workers) as ex, summary.open("a") as sf:
    for i, row in enumerate(ex.map(one, specs), 1):
        sf.write(json.dumps(row) + "\n")
        sf.flush()
        print(f"{i}/{len(specs)} {row['spec']} {row['stage']} {row.get('failed', '')}", flush=True)
