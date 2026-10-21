"""export_cells.py — writes every real python_exec cell (corpus.collect) to a LOCAL JSON file, {cell_id: text}, for
cells.py to time under each core. The file holds personal cell text: write it outside the repo (a scratch directory),
never under notebooks/. What is committed from the timing is the cell_id (corpus.py's text hash), outcome and ns.

    .venv/bin/python notebooks/python-dialect/verify-cost/export_cells.py <out.json>
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE.parent.parent)]
import corpus  # noqa: E402

out = Path(sys.argv[1]).resolve()
if HERE.parents[2] in out.parents:
    sys.exit("refusing to write cell text inside the repo: " + str(out))
rows = corpus.collect()
codes = corpus.last_codes()
cells = {r["cell_id"]: codes[r["cell_id"]] for r in rows if r["parse"] != "syntax_error"}
out.write_text(json.dumps(cells))
print(f"{len(cells)} cells ({len(rows) - len(cells)} syntax errors left out) -> {out}")
