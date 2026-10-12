---
name: gallery
description: See what a UI component in this repo looks like and how it renders — list the component gallery, screenshot any component (or a custom entry such as the WebGL gradient canvas) with given props, theme, calm/dev view, width and CSS-token overrides, and read a custom entry's log and timings. Use after the code index tells you a component EXISTS and you need to know what it LOOKS like, after changing a component, and whenever a component renders blank or broken in the gallery (then write it an `@gallery` example and commit it).
---

# gallery

The code index answers "does this exist?" (`node scripts/index.mjs 'chip|pill'`). The gallery answers "what does it
look like, and how does it render?". It lists every exported PascalCase function in a `.tsx` under `src/` (found through
the index, props read from the TypeScript checker) plus every custom entry (`src/**/*.gallery.ts(x)`), and renders each
live. Spec: `docs/spec/COMPONENT_GALLERY.md`.

```bash
node scripts/gallery.mjs list 'chip|pill'                  # id, groups, variants, file:line, summary (TAB-separated)
node scripts/gallery.mjs list --group primitives
node scripts/gallery.mjs list --props Stepper              # each prop's type, enum MEMBERS, and the variants
node scripts/gallery.mjs shot Stepper                      # → test-results/gallery-Stepper.png; Read it
node scripts/gallery.mjs shot Stepper Hash SheetChip       # several, one browser
node scripts/gallery.mjs shot ReplyBubble --variant 'status: err' --theme light --view calm --width phone
node scripts/gallery.mjs shot Stepper --props '{"value":"13 px","label":"Text size","atMost":true}'
node scripts/gallery.mjs shot Card --tokens '{"--bg":"#fdf6e3","--fg":"#073642"}'    # a custom theme
node scripts/gallery.mjs shot gradient-fills --variant 'stress: 256 points' --wait 3000 --log   # timings
node scripts/gallery.mjs serve                             # the page, for a human (http://127.0.0.1:5180/index.html)
node scripts/gallery.mjs check [--only '<regex>']          # render everything; exit 1 on a broken EXAMPLE
```

## Interacting before the shot: write a FLOW FILE

For anything beyond a static render (open a menu, hover for the tooltip, type into a field, step through a dialog),
write the steps to a file and run that, so the script survives between attempts instead of being retyped:

```bash
node scripts/gallery.mjs flow Disclosure --variant closed   # first run writes tmp/gallery-flows/Disclosure.mjs (a template)
# edit tmp/gallery-flows/Disclosure.mjs, then run the same command again
```

```js
// tmp/gallery-flows/Disclosure.mjs
export default async ({ page, tile, shot }) => {
    await shot("closed");                          // → test-results/gallery-Disclosure-01-closed.png
    await tile.locator(".disc-head").click();      // `tile`: the component's frame, a Playwright Locator
    await page.waitForTimeout(300);
    await shot("opened");                          // a numbered frame per step; the final shot comes after the script
};
```

`page` is the whole Playwright page: a tooltip, a menu or a dialog is often drawn outside the tile. `flow` takes every
`shot` flag (`--variant`, `--props`, `--theme`, `--view`, `--width`, `--tokens`). `tmp/` is gitignored: a flow is a
working file, and what should outlive it is the `@gallery` example.

For a one-off, `--do` steps on `shot` (repeatable, run in order, selectors inside the tile; `page <sel>` for the whole
page): `click:<sel>`, `dblclick:`, `hover:`, `focus:`, `type:<sel>=<text>`, `fill:<sel>=<text>`, `press:<key>`,
`wait:<ms>`, `waitfor:<sel>`. `--each` shoots after every step. `--eval '<expr>'` prints a value from the page.

```bash
node scripts/gallery.mjs shot Tip --do 'hover:.help' --do 'wait:300' --page    # the tooltip is outside the tile
```

`shot` prints `<id>: ok|error|empty` and exits 1 unless it rendered. `--page` shoots the whole page instead of the tile.
EVERY toggle on the page is a flag: the page keeps its state in its URL, which `shot` writes and prints.

## When a component renders blank or broken: write it an `@gallery` example, and commit it

A component starts from props INFERRED from its type: a string gets the prop's name, a number 1, an enum its first
member, required fields only. Small primitives render fine that way. Anything that takes a step, a session or a store
usually renders an error, nothing, or placeholder text (`value`, `label`) that shows nothing about the component.

That is the gap the tag closes. In the component's JSDoc:

```ts
/** A ±/value/± control for a setting with a small ladder of values.
 *  @group primitives, controls
 *  @gallery {"value": "13 px", "label": "Text size"}
 *  @gallery at the bottom {"value": "10 px", "label": "Text size", "atLeast": true}
 */
```

- `@gallery [name] {json}`: one variant per tag. The JSON may run over several lines.
- What JSON cannot say, the page fills in: every FUNCTION prop gets a recorder (its calls show in the sidebar), a
  `Set`/`Map` prop is built from an array/object, a signal prop is wrapped in one, `"$store"` / `"$host"` are the chat
  demo world's store and host, and `{"$h": ["header", {"class": "x"}, "text", {"$h": [...]}]}` is ELEMENTS for a node
  prop that needs more than text.
- A component whose module is a build ENTRY (it renders a page at import, like `src/sidebar/app.tsx`) is listed but
  never loaded, since importing it would replace the gallery: move the component into a module of its own.
- Components that only run inside the extension see an inert `chrome` (messages are never answered, storage is
  empty), so they draw their waiting or empty state rather than throwing.
- `@group a, b`: where it is listed. Without one, the folder is the group. Reuse an existing group (`list` shows
  them, and the page counts each) rather than coining a near-duplicate.

The loop: `shot <id>`, Read the PNG, write the `@gallery` line, `shot <id>` again until it shows the component as it
is meant to look. Then **commit the example with your change**: the next agent who asks what this component looks like
gets a real answer instead of rediscovering the props.

### When it draws NOTHING on its own: a flow, or `none`

Some components render nothing until something happens to them: a menu waiting for a right-click, a tooltip layer
waiting for a hover, a dialog waiting to be opened. Props cannot fix that, so there are two other tags. Pick by asking
**would triggering it show something a reader needs to see, or test something that could break?**

- **Yes → `@gallery-flow <name> <file> [{json}]`.** Commit a Playwright script under `tests/gallery-flows/` that
  triggers the component, then CHECKS what a person would (the items are there, a click does its thing, Escape closes
  it), and ends with the component in the state the final shot should show. `check` runs it and a throw FAILS CI;
  `shot <id>` runs it automatically. A flow reaches the signal or store that drives a component through
  `__gallery.module(id)`, the same module instance the component renders with. Worked examples:
  `tests/gallery-flows/ContextMenu.mjs` and `tests/gallery-flows/CursorTipLayer.mjs` (tags in `src/sidebar/ui-kit.tsx`).
- **No → `@gallery none <reason>`.** For a piece that only means something inside its parent (a crosshair line over a
  chart track, a `<g>` that needs an `<svg>`), say why and where to see it in place. `check` counts it as handled, the
  page shows the reason. Worked example: `Crosshair` in `src/sidebar/resource/resource-overlays.tsx`.

Prefer a flow when in doubt: `none` is a statement that nothing here can break visibly, and a flow is a test.

**An example is a promise.** `gallery.mjs check` (CI's `gallery` job) FAILS on an `@gallery` example or custom entry
that does not render; an inferred render that fails is only a warning. The pre-commit hook reminds you (never fails)
about a component the commit touches that has no `@group` or `@gallery`: add one only if the inferred render is blank
or broken, and then the kind that fits (`@gallery`, `@gallery-flow` or `@gallery none`). A broken `@gallery-flow`
fails the check like a broken example; CI annotates a failing component inline in the PR diff.

## Custom entries

For what is not a Preact component, or needs a harness: a `*.gallery.ts(x)` file exporting `gallery:
GalleryEntry[]` (`src/gallery/gallery-entry.ts`), with `mount(el, props, api)` returning `{ update, destroy }`. `api.log`
writes the entry's log, `api.metric(phase, ms)` a timing sample (the page charts them per frame), `api.setProps` writes
props back (dragging a point on a canvas). `notes` is markdown, folded under the stage. The module must not touch the
DOM at import: `list` imports it in Node. The gradient canvas (`src/gallery/gradient.gallery.ts`) is the worked example.

## Shaders

The gradient renderer's GLSL is written as `/* glsl */` template literals and type-checked without a browser by
`node --import tsx scripts/check-glsl.mjs` (glslangValidator, GLSL ES 3.00; `brew install glslang`). The pre-commit
hook runs it when `src/gradient/` changes; CI always does.
