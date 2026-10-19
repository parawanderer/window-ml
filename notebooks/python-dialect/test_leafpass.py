"""test_leafpass.py: the manifests' second pass (leafpass.py) against the generated data/manifest-*.json name lists.

Enumerates every listed name; samples nothing.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import leafpass  # noqa: E402

DATA = Path(__file__).resolve().parent / "data"
FIELDS = ("effects", "returns", "cost", "why")


# --- the table's shape ---

def test_every_row_has_effects_returns_cost_and_why():
    for key, row in leafpass.LEAVES.items():
        for f in FIELDS:
            assert isinstance(row.get(f), str) and row[f], f"{key}: missing {f}"


def test_returns_vocabulary():
    """A marking is one of the four, or a conditioned form naming both branches."""
    ok = ("fresh", "alias(0)", "alias(1)", "internal", "None")
    for key, row in leafpass.LEAVES.items():
        r = row["returns"]
        assert r in ok or " when " in r or " otherwise" in r, f"{key}: unknown returns {r!r}"


def test_inplace_methods_carry_mutates_and_none_when_inplace():
    for key, row in leafpass.LEAVES.items():
        if "when inplace" in row["effects"]:
            assert "mutates(0)" in row["effects"], f"{key}: inplace without mutates(0)"
            assert "None when inplace" in row["returns"], f"{key}: inplace without a None branch"


# --- every listed name has a row (enumerated, not sampled) ---

def _listed(man, mod):
    if mod in ("pandas", "numpy"):
        fns = {f"{man['module']}.{s}" for s in man.get("functions", [])}
    elif mod == "PIL":
        fns = {s if s.startswith("PIL.") else f"PIL.{s}" for s in man.get("functions", [])}
    else:
        fns = {f"{name}.{s}" for name, names in man.get("modules", {}).items() if name != "PIL" for s in names}
    kinds = {f"{kind}.{s}" for kind, ms in man.get("kinds", {}).items() for s in ms}
    return fns | kinds


def test_every_listed_name_has_a_leaf():
    for mod, fname in (("pandas", "manifest-pandas.json"), ("numpy", "manifest-numpy.json"),
                       ("stdlib", "manifest-stdlib.json"), ("PIL", "manifest-pil.json")):
        man = json.loads((DATA / fname).read_text())
        listed = _listed(man, mod)
        miss = sorted(listed - set(man.get("leaves", {})))
        assert not miss, f"{fname}: listed names with no leaves row: {miss}"


def test_every_leaf_is_the_same_row_leafpass_wrote():
    """The JSON is generated from leafpass.py; a hand-edit of either side is drift."""
    for fname in ("manifest-pandas.json", "manifest-numpy.json", "manifest-stdlib.json", "manifest-pil.json"):
        man = json.loads((DATA / fname).read_text())
        for key, row in man.get("leaves", {}).items():
            assert leafpass.LEAVES.get(key) == row, f"{fname}: {key} differs from leafpass.LEAVES"


def test_bucket_matches_the_file_a_leaf_lands_in():
    for fname, mod in (("manifest-pandas.json", "pandas"), ("manifest-numpy.json", "numpy"),
                       ("manifest-stdlib.json", "stdlib"), ("manifest-pil.json", "PIL")):
        man = json.loads((DATA / fname).read_text())
        for key in man.get("leaves", {}):
            assert leafpass.bucket(key) == mod, f"{key} in {fname} but bucket() says {leafpass.bucket(key)}"
