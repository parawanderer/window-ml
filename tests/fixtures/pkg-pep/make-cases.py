"""make-cases.py — writes cases.json beside it: what Python's `packaging` says about PEP 440 versions and specifiers and
PEP 508 requirements, for tests/pkg-pep.test.mjs to hold src/python/pkg-pep440.ts and pkg-pep508.ts to.

    .venv/bin/python -I tests/fixtures/pkg-pep/make-cases.py

The cases are the hand-written edges below plus every version and specifier in the pinned index snapshot
(notebooks/python-packages/data/pypi-compat/index-snapshot.json). Rerun it when `packaging` moves in notebooks/uv.lock:
the fixture records the version it was made with, and the test names it.
"""

import json
import sys
from pathlib import Path

import packaging
from packaging.markers import InvalidMarker, UndefinedComparison, UndefinedEnvironmentName
from packaging.requirements import InvalidRequirement, Requirement
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

ROOT = Path(__file__).resolve().parents[3]
SNAP = ROOT / "notebooks/python-packages/data/pypi-compat/index-snapshot.json"
ENV = json.loads((ROOT / "notebooks/python-packages/data/pypi-compat/env.json").read_text())["rows"][0]["env"]

# Versions the specifiers are tried on: every segment, every spelling, every ordering edge.
VERSIONS = """
0 1 1.0 1.0.0 01.0 1.00 v1.0 V1.0 " 1.0 " 1.0.0.0.0 1.1 1.2.3 1.10 2 2.0 10 1!0 1!1.0 0!1.0
1.0a1 1.0a 1.0alpha1 1.0.a1 1.0-a1 1.0_a1 1.0A1 1.0b1 1.0beta2 1.0c1 1.0rc1 1.0pre1 1.0preview1 1.0RC1 1.0rc
1.0.post1 1.0post1 1.0-1 1.0.post 1.0r1 1.0rev2 1.0-post1 1.0.post1.dev1 1.0.post0
1.0.dev0 1.0.dev1 1.0dev 1.0-dev1 1.0a1.dev1 1.0rc1.post1 1.0rc1.post1.dev2 1.0a1.post1
1.0+local 1.0+1 1.0+abc.1 1.0+1.abc 1.0+ABC 1.0+a-b_c 1.0+01 1.0.post1+x 1.0a1+x
1.4.9 1.4.5 1.4.4 1.4 1.5 1.5a1 2.0a1 3.9 3.10 3.13 3.14 3.14.0 3.14.2 3.14.2+local 3.14rc1 3.15 4 4.0a1
1.0.0a0 0.9 0.9.9 00 1.0.0.0.1 9999999999999999999999 1.99999999999999999999
1.0a1.post1.dev1 1.0a2 1.0.post0.dev1 1.0.post1.dev1 1.0.post1+x 1.0.post2 1.0.post2.dev1 1.0.1.dev1 1.0.1 1.0.dev0+x 1.0a1+y
x 1.0.* 1..0 1.0. .1 1.0+ 1.0+_x 1.0++x 1-0 a1 1.0a1b2 1.0.post1.post2 ! 1!
""".split()
VERSIONS = [v.strip('"') if v.startswith('"') else v for v in VERSIONS] + [" 1.0 ", "1.0\t", "\n1.0"]

SPECS = """
>=1.0 >1.0 <1.0 <=1.0 ==1.0 !=1.0 ~=1.0 ~=1.4.5 ~=1.4 ~=1!1.4 ===1.0 ===1.0.0 ===foo ===FOO
==1.* ==1.0.* !=1.* !=1.0.* ==1!1.* ==1.0+local !=1.0+local ==1.0.post1 ==1.0a1 ==1.0.dev1
>1.0.post1 >1.0a1 <1.0rc1 <1.0.post1 >=1.0a1 <=1.0a1 >1.0.dev0 <1.0.dev1 >=1!0 <2 >=1,<2 >=1,!=1.5,<2
>=3.9 >=3.14 <3.14 >=3.14.3 >=3.14.2 ==3.14.* ~=3.14 ~=3.14.0 >=3.10,<4 !=3.14.* >3.14 >3.14.1
== 1.0 >=\t1.0 >=1.0,  ,>=1.0 >=1.0,,<2 " >=1.0 , <2 " >= v1.0 ==V1.0
>1.0a1.post1 >1.0rc1.dev1 >1.0.post1.dev1 <1.0a2 <1.0a1.post1 <1.0.post1.dev1 <1.0.1 >1.0.dev0+x
>=1.0.* ~=1.0.* ~=1 <=1.0+local >1.0+local ~=1.0+local ==1.0+local.* ==1.0a1.* >=x ==1..0 => >= 1.0 1.0 =1.0 ~1.0
""".split()

REQUIREMENTS = [
    "a", "A_b.C", "a>=1", "a >= 1", "a(>=1)", "a (>=1,<2)", "a[x]", "a[x,y]>=1", "a [ x , y ] (>=1)", "a[]", "a;python_version>='3'",
    'a; python_version >= "3.9"', 'a; python_version < "3.9"', 'a ; os_name=="posix" and sys_platform=="emscripten"',
    'a; os_name == "nt" or sys_platform == "emscripten"', 'a; (os_name == "nt" or os_name == "posix") and python_version > "3"',
    'a; os_name == "nt" or os_name == "posix" and python_version < "3"', 'a; extra == "x"', 'a; extra == "X_Y"', 'a; "x" == extra',
    'a; platform_machine in "wasm32 x86_64"', 'a; platform_machine not in "x86_64"', 'a; "wasm" in platform_machine', 'a; "emscripten" not in sys_platform',
    'a; os.name == "posix"', 'a; sys.platform == "emscripten"', 'a; python_implementation == "CPython"', 'a; platform.python_implementation == "CPython"',
    'a; platform_system < "Z"', 'a; platform_system <= "Emscripten"', 'a; platform_system > "A"', 'a; platform_system >= "Emscripten"',
    'a; python_full_version >= "3.14.2"', 'a; python_full_version < "3.14.2rc1"', 'a; implementation_version == "3.14.*"',
    'a; platform_release >= "5"', 'a; platform_release ~= "5.0"', 'a; python_version === "3.14"', 'a; os_name ~= "posix"', 'a; os_name === "posix"',
    'a; python_version >= "x"', 'a; platform_version == "#1"', 'a; os_name == sys_platform', 'a; "posix" == os_name', 'a; "a" == "a"',
    'a; extras == "x"', 'a; dependency_groups == "x"', 'a; "x" in extras', 'a; implementation_name == "cpython"',
    "a; python_version >= '3' and", "a; python_version", "a; (python_version >= '3'", "a;", "a ;", "a >=1;", "a>=1.0.*", "a==1.0+local",
    "a==1.0+local.*", "a===1.0+x", "a @ https://example.com/a.whl", "a@https://e.com/a.whl ; os_name == 'nt'", "a @ file:///x.whl",
    "a[x y]", "a b", "1a", "-a", "a-", "a.", "_a", "a_", "a--b", "a b>=1", "a>=1 <2", "a (>=1", "a >=1)", "", " ", "a\t>=1",
    "a; os_name == 'po\\\\six'", "a; os_name == 'posix' ", "a; os_name == 'posix' ;", "a; os_name not  in 'x'", "a; os_name notin 'x'",
    'a; os_name == "posix"or os_name == "nt"', 'a; os_name == "posix"and os_name == "nt"', "a; os_nameinx", "a; (((os_name == 'posix')))",
]


def version_row(v):
    try:
        return str(Version(v))
    except InvalidVersion:
        return None


def contains(spec, v):
    try:
        return SpecifierSet(spec).contains(v)
    except InvalidSpecifier:
        return None


def req_row(s):
    try:
        r = Requirement(s)
    except InvalidRequirement:
        return None
    try:
        holds = r.marker.evaluate({**ENV, "extra": ""}) if r.marker else None
    except (UndefinedComparison, UndefinedEnvironmentName, InvalidMarker):
        holds = "undefined"
    return {"name": canonicalize_name(r.name), "extras": sorted(canonicalize_name(e) for e in r.extras), "url": r.url or None,
            "specifier": str(r.specifier), "marker": holds}


def main():
    snap = json.loads(SNAP.read_text())["rows"]
    real_versions, real_specs = set(), set()
    for r in snap:
        for v, rel in r["releases"].items():
            real_versions.add(v)
            if rel.get("requires_python"):
                real_specs.add(rel["requires_python"])
            for f in rel["files"]:
                p = f.split("\t")
                if len(p) > 3 and p[3]:
                    real_specs.add(p[3])
            for q in rel.get("requires_dist") or []:
                sp = str(Requirement(q).specifier)
                if sp:
                    real_specs.add(sp)
    specs = SPECS + sorted(real_specs - set(SPECS))
    order = sorted({str(Version(v)) for v in (VERSIONS + sorted(real_versions)) if version_row(v)}, key=Version)
    rank, prev = {}, None
    for v in order:
        rank[v] = rank[prev] + (Version(v) != Version(prev)) if prev else 0
        prev = v
    all_versions = VERSIONS + sorted(real_versions - set(VERSIONS))
    out = {
        "packaging": packaging.__version__,
        "env": ENV,
        # Each version: its rank in PEP 440 order (equal versions share one), or null when it is not a version.
        "versions": [[v, rank[version_row(v)] if version_row(v) else None] for v in all_versions],
        # Each specifier set: null when it does not parse, else one character per entry of `probes`: 1 admits, 0 not.
        "probes": VERSIONS,
        "specs": [[s, None if contains(s, "1") is None else "".join("1" if contains(s, v) else "0" for v in VERSIONS)] for s in specs],
        "requirements": [[s, req_row(s)] for s in REQUIREMENTS],
    }
    (Path(__file__).parent / "cases.json").write_text(json.dumps(out, indent=0, sort_keys=True) + "\n")
    print(len(out["versions"]), len(out["specs"]), len(out["requirements"]), file=sys.stderr)


if __name__ == "__main__":
    main()
