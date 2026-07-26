# python_exec — `cast` signature + the two-slot debug renderer

Status: **shipped.** Builds on the `python_exec` tool (offscreen Pyodide sandbox,
`offscreen.ts` + the relay + `buildPythonTool`). All five build steps landed:
stdout fidelity, `cast`, the two-slot render architecture, the `python-in`/`python-out`
descriptors + RenderPanel cases + export, and the generic `rendered/raw` tooltips.
Tested in `tests/sidebar.test.js` (python render + the migrated two-slot assertions) and
`tests/agent.test.js` (the `renderIn`/`renderOut` emit shape).

**Next (agreed, not yet designed):** bundle **pandas** into the sandbox and add a
**table-selector mode** — pass a `<table>` selector and auto-convert it to a `df`
(pandas.DataFrame) injected like `img`, with a table/df debug render. This is an
*input-injection* feature (a sibling of the `image` arg), not an output `cast`; it needs
its own slice (the pandas wheel is heavy → an offline-bundle-size call to make first).

## Goals
1. **Fix stdout capture** — newlines are being dropped.
2. **Make it a GENERAL utility** — don't auto-interpret a returned `[x,y]` as a point; add
   an explicit `cast` so the coordinate meaning is opt-in.
3. **A rich custom debug render** — the *first custom In renderer* — a notebook cell:
   Mode + input image + code (In), stdout + output (Out).
4. **Generalise the render system to two slots** (In + Out per step) and clarify the
   `rendered/raw` semantics everywhere.

## 1. stdout fidelity
Root cause is mine: the offscreen host captures stdout via Pyodide `setStdout({ batched })`,
whose callback hands back each line *without* its trailing newline, and `out.join("")`
concatenates them → one run-on line. Fix: capture faithfully **in Python** — run the user
code under `contextlib.redirect_stdout(io.StringIO())` and return `getvalue()` (the exact
bytes, newlines intact). Drop the JS `setStdout`. This matters for "raw = what the model
saw" — raw stdout must be byte-exact.

## 2. `cast` — explicit result interpretation
Auto-minting `[x,y]` → `@pt` is presumptuous: a general script returning two numbers gets
silently mangled into a click point. New optional param:

| call | behaviour |
| --- | --- |
| `{ code }` | **default** — return the value as text (`JSON.stringify`). General scripting. |
| `{ code, cast:"pt" }` | validate the return is a point (`[x,y]` / `{x,y}`) → mint `@pt`; else **error** ("cast:pt but the return isn't a point: …"). |
| `{ code, cast:"box" }` | validate `[x1,y1,x2,y2]` / `{left,top,right,bottom}` → mint `@box`; else error. |

**Image returns stay auto** (no cast): a `data:image/…` string is *unambiguous* (no false
positives), unlike `[x,y]`, and you always want to *see* a returned image (raw toggle still
shows the string). Rule: **auto only when unambiguous (image); require `cast` when ambiguous
(pt/box).** `cast` also drives the "Mode" line in the renderer.

Tool description updated accordingly ("returns the value as text; `cast:'pt'`/`'box'` mints a
validated clickable `@pt`/`@box`").

## 3. Two-slot render model (the architecture)
Today a step carries ONE render descriptor and `descriptorFor` *picks* one (a `target` field
decides In vs Out). But we already have **two hooks** — the tool's `render(input, args)`
method *and* its `run()`-returned `ToolResult.render`. The change: **stop picking; map them
to two independent slots.**

- `descriptorFor` returns `{ in?: RenderDescriptor, out?: RenderDescriptor }`:
  - `in`  = `result.renderIn` (run-returned, **new**) ?? `tool.render(input, args)` (the method) ?? undefined
  - `out` = `result.render` (run-returned) ?? auto-derive (image/elements) ?? undefined
- `ToolResult` gains **`renderIn?: RenderDescriptor`**.
- The `target` field on descriptors is **deprecated** — the slot is now the hook. Only `exec`
  used it (`target:"in"` on its `render()` method) → In slot; behaviour unchanged.
- The agent-step debug event carries **`renderIn?` + `renderOut?`** (serialisable, computed
  page-side) instead of a single `render`. Migration: read a legacy `render` as `renderOut`.
- Sidebar: the **In** block shows `renderIn` (rendered) or the raw args (raw); the **Out**
  block shows `renderOut` (rendered) or the raw result (raw). Each block keeps its own
  `rendered ⇄ raw` toggle.

Existing tools: `exec` → In = code (method), Out = default. `locate` → Out = locate
descriptor (unchanged). `python` → both slots (below).

## 4. The python descriptors
`python`'s `run()` returns both (it has all the data):

```ts
// In slot — the "notebook cell" header
{
  type: "python-in",
  mode: "script" | "pt" | "box",   // from args.cast; "script" = no cast
  code: string,                     // Python source (highlighted; NO js-beautify)
  image?: string,                   // the resolved INPUT screenshot data-URL (what the script saw)
}

// Out slot
{
  type: "python-out",
  stdout?: string,                  // captured print() output (byte-exact)
  image?: string,                   // returned image data-URL (a to_base64 result)
  token?: string,                   // minted @pt/@box (when cast)
  value?: string,                   // the raw/JSON result (general case)
  error?: string,                   // Python traceback (when !ok)
}
```

RenderPanel cases:
- **`python-in`**: `Mode:` line (hover: what `script` / `cast:pt` / `cast:box` mean) · input
  image (if present) · highlighted Python.
- **`python-out`**: `stdout:` block · output section (image | `@pt`/`@box` token | raw value |
  error).

Data flow: `ml.pythonExec` (injected) already resolves the `image` arg via `ml.screenshot` —
it now also **returns that data-URL** so the tool can put it on `python-in`. `pythonExec`
return becomes `{ ok, value, stdout, error, inputImage? }`.

## 5. `rendered/raw` semantics (generalise everywhere)
The toggle is ambiguous today ("rendered" reads as vague prettification). Make it explicit
with tooltips on **every** toggle (exec, locate, python):
- **rendered** → *"A debug visualisation for you — not shown to the model."*
- **raw** → *"Exactly what the model sent/received. All it knows."*

(In-block raw = the exact tool-call args; Out-block raw = the exact result string.)

## Build sequence (each step builds green)
1. **stdout fidelity** (offscreen `redirect_stdout`) — tiny, unblocks correct logs.
2. **`cast`** (param + validate-or-error + description; image stays auto) — the correctness fix.
3. **Two-slot renders** (`descriptorFor` → `{in,out}`; `ToolResult.renderIn`; event
   `renderIn`/`renderOut`; sidebar two blocks) — verify `exec`/`locate` unchanged.
4. **python-in / python-out** descriptors + RenderPanel cases + `pythonExec` returns `inputImage`.
5. **Generic `rendered/raw` tooltips.**

## Resolved
- `python-in` with **no** image → the Input image row is hidden (a script-only cell). Done.
- `target` was **dropped in one go** — the slot is decided by the hook (method/`renderIn` →
  In; run-`render`/auto-derive → Out). `exec`'s `render()` method now feeds In without a
  flag; the In block renders even with empty args when a `renderIn` is present.

## Still deferred
- The generic **"DOM-node rendered-on-hover"** for a selector Input — codebase-wide, not
  python-specific.
