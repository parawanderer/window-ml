"""test_corpus.py: the feature extractor and the source readers, on inline fixtures only."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import corpus  # noqa: E402
from corpus import features  # noqa: E402


# --- parsing ---

def test_top_level_return():
    f = features("x = 1\nreturn x")
    assert f["parse"] == "ok" and f["lines"] == 2


def test_syntax_error():
    f = features("def (:\n  1")
    assert f["parse"] == "syntax_error" and f["lines"] == 2 and f["nodes"] == {} and f["imports"] == []


def test_expr_context_excluded():
    n = features("a = b + 1\ndel a")["nodes"]
    assert not {"Load", "Store", "Del"} & set(n) and n["Add"] == 1 and n["Assign"] == 1


# --- names ---

def test_alias_chains():
    c = features("import pandas as pd\nimport numpy as np\nfrom numpy import where\npd.DataFrame(x)\nnp.linalg.norm(y)\nwhere(z)\ns.str.contains('a')")
    ch = c["chains"]
    assert ch["pandas.DataFrame"] == 1 and ch["numpy.linalg.norm"] == 1 and ch["numpy.where"] == 1
    assert ch["s.str.contains"] == 1 and "s.str" not in ch
    assert c["imports"] == ["numpy", "pandas"]
    assert "pandas.DataFrame" not in c["methods"] and not any("DataFrame" in m for m in c["methods"])


def test_relative_import():
    assert features("from . import x\nfrom ..a import b")["imports"] == ["."]


def test_accessor_and_call_receiver_methods():
    m = features("a = s.str.contains('x')\nb = df.groupby('k').sum()\nc = df.dt.year\nd = x.append(1)")["methods"]
    assert m[".str.contains"] == 1 and m[".sum"] == 1 and m[".append"] == 1 and ".groupby" in m


def test_builtins_exclude_shadowed():
    b = features("def sum(x):\n    return 1\nsum(2)\nlen(a)\nmax = 3\nmax(1)\nfor min in q:\n    min(1)\nprint(1)")["builtins"]
    assert b == {"len": 1, "print": 1}


def test_recursion_and_defs():
    f = features("def fact(n):\n    return 1 if n < 2 else n * fact(n - 1)\ndef g():\n    return 1\nh = lambda: 2")
    assert f["recursion"] == ["fact"] and f["defs"] == 2 and f["lambdas"] == 1


def test_dunders():
    f = features("a = x.__class__\nb = __name__")
    assert f["dunder_attrs"] == ["__class__"] and f["dunder_names"] == ["__name__"]


def test_loops_and_range():
    f = features("for i in range(3):\n    while q:\n        for j in range(n):\n            pass")
    assert f["max_loop_depth"] == 3 and f["range_args"] == {"const": 1, "nonconst": 1}


# --- sources ---

def _run_json(code, model="m1", hash_="h" * 32, as_string=False, sub=False):
    args = {"code": code}
    step = {"tool": "python_exec", "arguments": json.dumps(args) if as_string else args}
    steps = [{"tool": "exec", "arguments": {}, "subSteps": [step]}] if sub else [step]
    return json.dumps({"session": {"model": model, "hash": hash_, "steps": steps}})


def test_json_string_arguments_and_substeps():
    codes, model, h = corpus._cells_json(_run_json("a = 1", as_string=True, sub=True))
    assert codes == ["a = 1"] and model == "m1" and h == "h" * 32
    try:
        corpus._cells_json("{nope")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_md_parsing():
    md = "model: gpt-x\n\n## Step 1 · exec\n\n```python\nno = 1\n```\n\n## Step 2 · python_exec\n\n**In:**\n\n```python\nx = 1\nprint(x)\n```\n\n## Step 3 · python_exec\n\n```python\ny = 2\n```\n"
    codes, model = corpus._cells_md(md)
    assert codes == ["x = 1\nprint(x)", "y = 2"] and model == "gpt-x"


def _fake_clone(root, name, files):
    c = Path(root) / name
    for rel, text in files.items():
        p = c / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return c


def test_dedupe_and_no_leak():
    secret = 'x = "SECRET_LITERAL_123"\nprint(len(x))'
    with tempfile.TemporaryDirectory() as t:
        rj = _run_json(secret, hash_="a" * 32)
        run = "tests/e2e/artifacts/bench/sw/task/model-m/r0/run.json"
        c1 = _fake_clone(t, "window-ml", {run: rj, "tests/e2e/artifacts/foo/run.json": _run_json("y = 1"),
                                          "tests/e2e/artifacts/foo/run.md": "## Step 1 · python_exec\n\n```python\ny = 1\n```\n",
                                          "tests/e2e/artifacts/bad/run.json": "{oops",
                                          "tmp/notes.md": "## Step 1 · python_exec\n\n```python\nz = 3\n```\n"})
        c2 = _fake_clone(t, "window-ml-b", {run: rj})
        rows = corpus.collect(include_store=False, clones=[c1, c2])
        st = corpus.last_stats()
        assert len(rows) == 3
        sec = [r for r in rows if r["nodes"].get("Assign") == 1 and r["builtins"] == {"len": 1, "print": 1}][0]
        assert sec["n"] == 1 and sec["sources"] == {"bench": 1} and sec["sweeps"] == {"sw": 1} and sec["models"] == {"m1": 1}
        assert [r for r in rows if r["sources"] == {"e2e": 1}][0]["n"] == 1  # run.md next to run.json skipped
        assert [r for r in rows if r["sources"] == {"tmp": 1}]
        assert st["malformed_files"] == 1 and st["cells_before_dedupe"]["bench"] == 2 and st["cells_after_dedupe"]["bench"] == 1

        def walk(v):
            if isinstance(v, str):
                yield v
            elif isinstance(v, dict):
                for k, x in v.items():
                    yield from walk(k)
                    yield from walk(x)
            elif isinstance(v, (list, tuple)):
                for x in v:
                    yield from walk(x)

        for s in walk(rows) :
            assert "SECRET_LITERAL_123" not in s


def test_prelude_names_resolve_without_an_import():
    f = features("df = pd.read_csv(io.StringIO(s))\nreturn np.mean(df.a)")
    assert f["chains"].get("pandas.read_csv") == 1 and f["chains"].get("numpy.mean") == 1 and f["chains"].get("io.StringIO") == 1
    assert ".read_csv" not in f["methods"] and f["prelude"] == ["io", "numpy", "pandas"]
    g = features("pd = {}\nreturn pd.get(1)")
    assert g["prelude"] == [] and ".get" in g["methods"]


def test_genexp_position_and_type_arity():
    f = features("a = sum(x for x in xs)\nb = sorted((x for x in xs), key=abs)\nc = ', '.join(str(x) for x in xs)\ng = (x for x in xs)\nreturn list(g)")
    assert f["genexp"] == {"consumer": 2, "consumer_kw": 1, "other": 1}
    assert features("sum = 1\nreturn sum(x for x in xs)")["genexp"]["other"] == 1
    assert features("t = type(1)\nT = type('A', (), {})")["type_calls"] == {"one": 1, "other": 1}


def test_leaf_args_name_strings_and_callable_kinds():
    f = features("df.agg('sum')\ndf.agg(['mean', 'max'])\ndf.a.apply(str)\ndf.a.map(lambda v: v)\n"
                 "df.apply(np.mean)\ndf.a.apply('{0}'.format)\nsorted(xs, key=len)\ndf.agg('not an id')")
    a = f["leaf_args"]
    assert a[".agg"] == {"str:sum": 1, "str:mean": 1, "str:max": 1, "str:<other>": 1}
    assert a[".apply"] == {"builtin:str": 1, "module-fn:numpy.mean": 1, "method": 1}
    assert a[".map"] == {"lambda": 1} and a["key=@sorted"] == {"builtin:len": 1}


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
