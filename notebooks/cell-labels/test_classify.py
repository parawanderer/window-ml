"""test_classify.py — the cell classifier against its fixture corpus (fixtures.py) and its export reader, stdlib only:

    python3 -m unittest discover -s notebooks/cell-labels -p 'test_*.py'

tests/cell-labels.test.mjs runs this in the unit suite.
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify  # noqa: E402
from fixtures import CELLS  # noqa: E402

# Every label the rules define, per language: each object-valued key of labels.json's language section but `aliases`.
# Read from the rules, so a label added there fails the coverage test until it has fixtures.
LABELS = {lang: {k for k, v in classify.RULES[lang].items() if isinstance(v, dict) and k != "aliases"} for lang in ("python", "js")}


class Fixtures(unittest.TestCase):
    rows = classify.classify_cells(CELLS)

    # --- every fixture gets exactly its labels ---

    def test_each_cell(self):
        for c, r in zip(CELLS, self.rows):
            with self.subTest(lang=c["lang"], code=c["code"]):
                self.assertEqual(set(r["labels"]), c["labels"])
                if "flags" in c:
                    self.assertEqual(set(r["flags"]), c["flags"])
                if "against" in c:
                    self.assertNotIn(c["against"], r["labels"])

    # --- the corpus is the size the spec asks, and covers every label both ways ---

    def test_corpus_size(self):
        for lang in LABELS:
            self.assertGreaterEqual(sum(c["lang"] == lang for c in CELLS), 30, lang)

    def test_every_label_positive_and_negative(self):
        for lang, labels in LABELS.items():
            cells = [c for c in CELLS if c["lang"] == lang]
            for lab in sorted(labels):
                with self.subTest(lang=lang, label=lab):
                    self.assertTrue(any(lab in c["labels"] for c in cells), "no positive")
                    self.assertTrue(any(c.get("against") == lab for c in cells), "no near-miss negative")

    def test_no_dom_label_for_python(self):
        for c, r in zip(CELLS, self.rows):
            if c["lang"] == "python":
                self.assertFalse({"dom-read", "dom-act"} & set(r["labels"]))

    # --- never empty, and versioned ---

    def test_never_empty_and_versioned(self):
        for r in self.rows:
            self.assertTrue(r["labels"])
            self.assertEqual(r["taxonomy"], classify.TAXONOMY)
        self.assertIsInstance(classify.TAXONOMY, int)

    def test_parsers_named(self):
        by = {(c["lang"], c["code"]): r["parser"] for c, r in zip(CELLS, self.rows)}
        self.assertEqual(by[("js", "return typeof ml;")], "dialect")
        self.assertEqual(by[("js", "for (let i = 0; i < 3; i++) { console.log(i); }")], "acorn")
        self.assertIsNone(by[("js", "const a = ;")])
        self.assertEqual(by[("python", "return answer")], "ast")


class Export(unittest.TestCase):
    """The reader over a JSON export: one row per exec/python_exec step, no code in the table."""

    RUN = {"session": {"hash": "abc", "steps": [
        {"tool": "python_exec", "step": 1, "seq": 2, "arguments": {"code": "SECRET_MARKER = pd.read_csv(p)", "tables": None}},
        {"tool": "fetch_url", "step": 2, "seq": 3, "arguments": {"url": "https://example.org"}},
        {"tool": "exec", "step": 3, "seq": 4, "arguments": {"js": "const SECRET_MARKER = rows.filter(r => r.v);"}},
        {"tool": "python_exec", "step": 4, "seq": 5, "arguments": {"code": "print(t.head())", "tables": {"t": "@file:t.csv"}}},
    ]}}

    def test_rows(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "run.json"
            p.write_text(json.dumps(self.RUN))
            t = classify.classify_export(p)
            self.assertEqual(t["run"], "abc")
            self.assertEqual([(r["step"], r["lang"], r["labels"]) for r in t["cells"]],
                             [(1, "python", ["ingest"]), (3, "js", ["select"]), (4, "python", ["ingest", "inspect"])])
            self.assertEqual(t["cells"][2]["flags"], ["by-argument"])
            self.assertNotIn("SECRET_MARKER", json.dumps(t))
            with contextlib.redirect_stdout(io.StringIO()):
                classify.main(["--write", str(p)])
            written = json.loads((Path(d) / "run.cell-labels.json").read_text())
            self.assertEqual(written, t)

    def test_old_export_without_steps(self):
        self.assertEqual(classify.export_cells({"session": {"hash": "x"}}), [])


if __name__ == "__main__":
    unittest.main()
