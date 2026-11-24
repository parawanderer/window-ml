"""fixtures.py — the classifier's fixture corpus (docs/spec/CELL_FACTS.md, Half 2): cells with the exact label set each
must get, a positive and a near-miss negative for every label in each language it applies to.

`origin` is "baseline" for a minimal cell with the shape of one the baseline sweep recorded (rewritten, so no recorded
code is committed), and "synthetic" for a label the baseline never shows (`shell`, `plot`, `dom-act`, Python `write`).
`flags`, when given, is the exact flag set. `against` names the label a cell is the near miss for: it must NOT get it.
"""

PY = [
    # ingest
    dict(code='df = pd.read_csv("/files/attached/a1/x.csv")\nprint(df.shape)', labels={"ingest", "inspect"}, flags=set()),
    dict(code='import pandas as pd\ndf = pd.read_csv(p)\ndf.head()', labels={"ingest", "inspect"}, flags={"import", "returns"}),
    dict(code='with open(p) as f:\n    raw = f.read()', labels={"ingest"}),
    dict(code='x = await ml.fetch(url)', labels={"ingest"}),
    dict(code='print(orders.head())', tables={"orders": "@file:orders.csv"}, labels={"ingest", "inspect"}, flags={"by-argument"}),
    dict(code='x = 1', tables="", labels={"other"}, flags=set()),
    # write, and its near misses
    dict(code='with open(p, "w") as f:\n    f.write("x")', labels={"write"}, origin="synthetic", against="ingest"),
    dict(code='df.to_csv("/files/agent/out.csv", index=False)', labels={"write"}, flags={"returns"}, origin="synthetic"),
    dict(code='s = df.to_csv()', labels={"report"}, against="write"),
    # parse
    dict(code='rows = [l.split(",") for l in raw.splitlines()]', labels={"parse"}, flags={"loop"}),
    dict(code='import io\ndf = pd.read_csv(io.StringIO(txt))', labels={"ingest", "parse"}, flags={"import"}),
    dict(code='import json\ndata = json.loads(txt)', labels={"parse"}),
    dict(code='nums = list(map(int, line.split(",")))', labels={"parse"}),
    dict(code='words = name.split(" ")', labels={"other"}, against="parse"),
    # list
    dict(code='import os\nprint(os.listdir("/files/attached"))', labels={"list"}, flags={"import"}),
    dict(code='import glob, os\nfor p in glob.glob("/files/**", recursive=True):\n    print(p, os.path.getsize(p))', labels={"list"}, flags={"import", "loop"}),
    dict(code='import os\nprint(os.path.join("/files", "a"))', labels={"other"}, against="list"),
    # probe
    dict(code='print(sorted(globals().keys()))', labels={"probe", "transform"}),
    dict(code="'df' in dir()", labels={"probe"}, flags={"returns"}),
    dict(code='import sys\nprint(sys.version)', labels={"probe"}),
    dict(code="print(type(df) if 'df' in dir() else None)", labels={"probe", "inspect"}),
    # inspect, and the same names inside a computation
    dict(code='print(dir(df))', labels={"inspect"}, against="probe"),
    dict(code='print(len(df))', labels={"inspect"}),
    dict(code='print(df.dtypes)\nprint(df.columns.tolist())', labels={"inspect"}),
    dict(code='n = len(df) * 2\nprint(n)', labels={"other"}, against="inspect"),
    # select
    dict(code='top = df[df["value"] > 10]\nprint(top)', labels={"select"}),
    dict(code='print(df.loc[df.region == "north", "sales"].sum())', labels={"select", "aggregate"}),
    dict(code='big = df.nlargest(3, "sales")', labels={"select"}),
    dict(code='evens = [x for x in xs if x % 2 == 0]', labels={"select"}, flags={"loop"}),
    dict(code='squares = [x * x for x in xs]', labels={"other"}, flags={"loop"}, against="select"),
    # transform
    dict(code='df["total"] = df["qty"] * df["price"]', labels={"transform"}),
    dict(code='df = df.sort_values("date")\ndf["c"] = df["v"].cumsum()', labels={"transform"}),
    dict(code='m = df.pivot(index="d", columns="r", values="v")', labels={"transform"}, against="aggregate"),
    # aggregate
    dict(code='t = pd.pivot_table(df, index="r", values="v", aggfunc="sum")', labels={"aggregate"}, against="transform"),
    dict(code='print(df.groupby("r")["v"].mean())', labels={"aggregate"}),
    dict(code='best = df["v"].idxmax()', labels={"aggregate"}),
    dict(code='total = 0\nfor x in xs:\n    total += x', labels={"aggregate"}, flags={"loop"}),
    dict(code='print(max(xs))', labels={"aggregate"}),
    dict(code='total = 0\ntotal += 5', labels={"other"}),
    # report
    dict(code='print(df.to_markdown())', labels={"report"}),
    dict(code='print(f"mean: {m:.2f}")', labels={"report"}),
    dict(code='import json\nprint(json.dumps(res))', labels={"report"}),
    dict(code='print("answer", n)', labels={"other"}, against="report"),
    # shell, plot
    dict(code='import subprocess\nsubprocess.run(["ls"])', labels={"shell"}, flags={"import", "returns"}, origin="synthetic"),
    dict(code='import matplotlib.pyplot as plt\nplt.plot(xs, ys)\nplt.savefig("/files/agent/p.png")', labels={"plot", "write"}, origin="synthetic"),
    dict(code='import math\nprint(math.ceil(math.log(2.0, 1.015)))', labels={"other"}, flags={"import"}),
    dict(code='import shlex\nargs = shlex.split("ls -la")', labels={"other"}, against="shell"),
    dict(code='import matplotlib.pyplot as plt', labels={"other"}, flags={"import"}, against="plot"),
    # define, and an inline lambda
    dict(code='def norm(v):\n    return v.strip().lower()', labels={"define"}),
    dict(code='f = lambda x: x * 2', labels={"define"}),
    dict(code='class Acc:\n    pass', labels={"define"}),
    dict(code='out = df.apply(lambda r: r.a + r.b, axis=1)', labels={"transform"}, against="define"),
    # never empty
    dict(code='return answer', labels={"other"}, flags={"returns"}),
    dict(code='def (:\n  1', labels={"unparsed"}),
]

JS = [
    # ingest
    dict(code='const t = await ml.table("table"); return t.rows.length;', labels={"ingest", "inspect"}, flags={"returns"}),
    dict(code='const txt = await ml.fs.readFile("/files/attached/a1/x.csv", "utf8"); return txt.split("\\n").length;', labels={"ingest", "parse", "inspect"}),
    dict(code='return @tool:abc123;', labels={"ingest"}, flags={"returns"}),
    dict(code='const x = await fetch("https://example.org/a.csv"); return await x.text();', labels={"ingest"}),
    dict(code='const p = "/files/attached/a1/x.csv"; return p;', labels={"other"}, against="ingest"),
    # parse
    dict(code='const rows = txt.trim().split("\\n").map(l => l.split(","));', labels={"parse"}, against="transform"),
    dict(code='const data = JSON.parse(txt);', labels={"parse"}),
    dict(code='const lines = txt.split(/\\r?\\n/);', labels={"parse"}),
    dict(code='const parts = name.split(" ");', labels={"other"}, against="parse"),
    dict(code='try { x = JSON.parse(t); } catch (e) { x = null; }', labels={"parse"}, flags={"try"}),
    # list
    dict(code='const files = await ml.fs.readdir("/files/attached"); return files;', labels={"list"}, flags={"returns"}, against="write"),
    dict(code='return ml.current.files.map(f => f.name);', labels={"list", "transform"}, against="probe"),
    dict(code='const a = ml.current?.attachments ?? null; return a;', labels={"list"}, against="probe"),
    dict(code='return ml.current.state;', labels={"probe"}, against="list"),
    dict(code='return ml.current.messages.length;', labels={"probe", "inspect"}, against="list"),
    # probe
    dict(code='return typeof ml;', labels={"probe"}, flags={"returns"}),
    dict(code='return Object.keys(globalThis);', labels={"probe"}),
    dict(code='return navigator.userAgent;', labels={"probe"}),
    dict(code='return Object.keys(rows[0]);', labels={"inspect"}, against="probe"),
    # inspect
    dict(code='console.log(rows.length);', labels={"inspect"}, flags=set()),
    dict(code='const n = rows.length * 2; return n;', labels={"other"}, flags={"returns"}, against="inspect"),
    # select
    dict(code='const big = rows.filter(r => r.v > 10);', labels={"select"}),
    dict(code='const cells = document.querySelectorAll("table.data td");', labels={"dom-read", "select"}),
    dict(code='const t = document.querySelectorAll("table");', labels={"dom-read"}, against="select"),
    # transform
    dict(code='const v = rows.map(r => r.qty * r.price);', labels={"transform"}),
    dict(code='rows.sort((a, b) => a.v - b.v);', labels={"transform"}, flags={"returns"}),
    dict(code='row.total = row.qty * row.price;', labels={"transform"}),
    # aggregate
    dict(code='const total = rows.reduce((s, r) => s + r.v, 0);', labels={"aggregate"}),
    dict(code='let s = 0; for (const r of rows) { s += r.v; }', labels={"aggregate"}, flags={"loop"}),
    dict(code='const m = Math.max(...vals);', labels={"aggregate"}),
    dict(code='const m = Math.max(a, b);', labels={"other"}, against="aggregate"),
    dict(code='const counts = new Map(); for (const r of rows) counts.set(r.k, (counts.get(r.k) || 0) + 1);', labels={"aggregate"}, flags={"loop"}),
    dict(code='for (let i = 0; i < 3; i++) { console.log(i); }', labels={"other"}, flags={"loop"}),
    # report
    dict(code='return JSON.stringify(result);', labels={"report"}, flags={"returns"}),
    dict(code='return `total: ${total}`;', labels={"report"}),
    dict(code='return "total";', labels={"other"}, against="report"),
    # dom-read, dom-act
    dict(code='return document.title;', labels={"dom-read"}),
    dict(code='const txt = el.textContent;', labels={"dom-read"}),
    dict(code='const v = row.value;', labels={"other"}, against="dom-read"),
    dict(code='document.querySelector("#q").value = "x";', labels={"dom-read", "dom-act"}, origin="synthetic"),
    dict(code='document.querySelector("button.go").click();', labels={"dom-read", "dom-act", "select"}, origin="synthetic"),
    dict(code='const v = document.querySelector("#q").value;', labels={"dom-read"}, against="dom-act"),
    # write, shell, plot
    dict(code='await ml.fs.writeFile("/files/agent/out.csv", csv);', labels={"write"}, flags={"returns"}),
    dict(code='const r = await ml.sh.run(["ls"]);', labels={"shell"}, origin="synthetic"),
    dict(code='const cmd = ["ls", "-la"]; return cmd.join(" ");', labels={"transform"}, against="shell"),
    dict(code='const ctx = canvas.getContext("2d"); ctx.fillRect(0, 0, 10, 10);', labels={"plot"}, origin="synthetic"),
    dict(code='const ctx = { fill: 1 }; return ctx.fill;', labels={"other"}, against="plot"),
    # define, and an inline arrow
    dict(code='const norm = s => s.trim().toLowerCase();', labels={"define", "transform"}),
    dict(code='function f(x) { return x * 2; }', labels={"define"}),
    dict(code='rows.map(r => r.v)', labels={"transform"}, flags={"returns"}, against="define"),
    # never empty
    dict(code='return 1 + 1;', labels={"other"}, flags={"returns"}),
    dict(code='const a = ;', labels={"unparsed"}),
]

CELLS = [{"lang": "python", "origin": "baseline", **c} for c in PY] + [{"lang": "js", "origin": "baseline", **c} for c in JS]
