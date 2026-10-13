---
name: tool-registry
description: Declare a builtin agent tool in the tool registry (src/tools/tool-registry.ts) and check the registry against the factories with scripts/check-tools.mjs. Use when adding, renaming or moving a builtin tool's factory, when deciding whether a tool is gated, citable or runs in the worker, when the pre-commit hook or CI fails on check-tools, or when code needs to know whether a tool name is one of the extension's own.
---

# The builtin tool registry

```bash
node scripts/check-tools.mjs            # every factory declared, every declaration with its factory (exit 1 if not)
node scripts/check-tools.mjs --list     # each builtin: the files its factories are in, as found and as declared
node scripts/check-tools.mjs --staged   # the same over the index (what the pre-commit hook runs)
```

## Adding a builtin tool

1. Write its factory as usual (`ml.defineTool({ name: "my_tool", description: …, … })`, or a plain object with `name`
   first and a `description`).
2. Add ONE line to `src/tools/tool-registry.ts`:
   `defineBuiltinTool({ name: "my_tool", factories: ["src/<where>.ts"], gated, citable, realm, cardLine })`.
   Write `name` and `factories` as string literals: the check reads them without running anything.
3. Run `node scripts/check-tools.mjs` and `node --import tsx --test tests/builtin-registry.test.mjs`.

Deciding the fields:

- `gated`: true when the worker mints a grant or consent for its calls, or acts for it with privileges. A page's
  START_RUN cannot take a gated tool off the gate (`GATED_TOOL_NAMES`, `pageStartPayload`).
- `citable`: its output can be kept as an `@tool:` pointer (`CITABLE_TOOLS`), so a run with tool tokens offers `token`.
- `realm`: where a run the WORKER built executes it. `worker` only if it never reads the page, or reads it as plain
  data (`WORKER_TOOL_NAMES`); `loop` if the agent loop answers it; else `page`.
- `cardLine`: the start card's sentence (docs/spec/SITE_ACCESS_SLICE3.md 1.1). Reuse an existing sentence when the tool
  reaches the same thing; `null` when it reaches nothing outside the run and the extension.

## What the code reads

`isBuiltinTool(name)`, `builtinTool(name)`, `cardLine(name, { crossOrigin })`, and the derived sets `GATED_BUILTINS`,
`CITABLE_BUILTINS`, `WORKER_BUILTINS`. A name the registry does not declare is the site's own tool; a site tool that
takes a builtin's name is treated as that builtin.

## Changing a derived list

`tests/builtin-registry.test.mjs` pins every derived list to what it was before the registry existed. Changing a tool's
`gated`, `citable` or `realm` is a behaviour change: update that snapshot in the same commit and say why in the PR.
For `gated` going false, run the red-team pass (the `redteam` skill) first.

Why the declarations live in one file and not beside each factory: `docs/dev/agent-tools.md`, "Which tools are the
extension's own".
