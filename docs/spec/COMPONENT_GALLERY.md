# Spec: the component gallery

**Status: agreed direction, being built** (Shane, 2026-10-12). Branch `feat/component-gallery`. Its first custom entry
is the gradient canvas ([`GRADIENT_FILLS.md`](GRADIENT_FILLS.md)).

## What it is

A page that lists the UI components this repo has built and renders each one live, with its props as editable JSON in
a right-hand sidebar: the "component library" page frontend tooling has, made from what the repo already knows about
itself instead of from a hand-kept catalogue.

It has two readers:

- **A human** browsing what exists, by group, and poking at a component's props.
- **A model working from the CLI**, which lists entries and gets a SCREENSHOT of one component with given props, to
  see what it changed without opening a browser.

## Derived by default

**The listing is generated, never hand-kept.** A hand-kept catalogue goes stale the week it is written, which is the
failure the code index exists to prevent. So:

- **Discovery** is the code index (`scripts/index.mjs`): every exported, PascalCase function in a `.tsx` file under
  `src/` is a component. Its summary is the first sentence of its JSDoc, as in the index.
- **Props** come from the TypeScript compiler, through the project the refactor tools already build
  (`scripts/refactor/project.mjs`): the type of the component's first parameter, resolved through aliases and imports.
- **Custom entries** are found by convention, not registered: any `*.gallery.ts` or `*.gallery.tsx` file under `src/`
  that exports `gallery`, an array of entries. They exist for what is not a Preact component (a WebGL canvas) or what
  needs a harness around it.

Nothing about the listing is written into `src/`: the generator hands the build a virtual module, and the output goes
to `dist-gallery/` (gitignored).

## Filling in the props

Three layers, each used only where the one before it is not enough.

1. **Inferred from the type.** A string gets the prop's own name; a number 1; a boolean `false`; an enum-like type its
   first member (below); an array one generated element; an object its own fields, recursively to a few levels;
   `children` a text node; a function a no-op that records its calls (shown in the sidebar). Optional props are left
   out, so the first render is the minimal one.
2. **`@gallery` examples in the JSDoc**, written where inferred props render nothing meaningful:

   ```ts
   /** A status DOT — pending / ok / err — with the tooltip that says which.
    *  @group status
    *  @gallery {"status": "ok"}
    *  @gallery warn {"status": "ok", "warn": "Stopped at its step cap."} */
   ```

   An example is JSON, optionally named. Several make several variants.
3. **A shared context.** Components that read `services()` or a store render inside the chat page's demo world (the
   `FakeHost` scripted host that `dist-web/` and the chat specs run on), so they get believable data without the
   gallery inventing any.

Every component renders inside its own error boundary: one that throws shows its error in place, and its row in the
list is marked. The list is therefore also the to-do list of components without a working example.

### Enum-like props

The type checker resolves a prop's type to its members, however it is written: a union of string literals (the repo's
usual idiom), a TypeScript `enum`, `keyof typeof X`, a boolean. The members go into the prop's schema, and from there:

- the JSON sidebar offers them as completions and flags a value that is not one of them;
- a component whose main prop is a small union gets one variant per member, side by side, with nobody writing them;
- `gallery.mjs list --props <id>` prints them, so a CLI model sees the allowed values before writing an example.

A prop typed as a plain `string` that is an enum in practice (a CSS class, a model id) has no members to find; that
gap is what `@gallery` examples are for.

## Groups

`@group a, b` in a component's JSDoc puts it in those groups on the page. Without a tag, the group is the component's
folder relative to `src/` (`chat`, `sidebar/resource`, `sidebar/transcript`, …), so the page is sorted sensibly with no
tags at all and a tag only overrides where the folder is the wrong answer. The page shows each group's count, so a
label used once (`chat` against `chat-page`) stands out.

## The page

- **Left**: search (over name, summary and group) and the groups, each with its count; a mark on entries that do not
  render.
- **Centre**: the component, one tile per variant; a light/dark switch; a width preset (phone, panel, desktop).
- **Right**: the props as JSON, applied live when it parses; the enum members for the key under the cursor; the calls
  made to function props.
- **The URL holds the state**: `#/<id>?variant=<name>&props=<base64url JSON>&theme=dark`, so a link or a screenshot is
  reproducible.

A custom entry's interface (`src/gallery/`):

```ts
interface GalleryEntry {
  id: string; title: string; summary: string; groups?: string[];
  props: unknown;                     // the default JSON shown in the sidebar
  variants?: Record<string, unknown>;
  notes?: string;                     // markdown, shown folded under the stage
  mount(el: HTMLElement, props: unknown, api: EntryApi): { update(props: unknown): void; destroy(): void };
}
interface EntryApi {
  setProps(next: unknown): void;      // write back: dragging a point on the canvas updates the JSON
  log(text: string): void;            // a line in the entry's log, time-stamped
  metric(name: string, ms: number): void;   // one timing sample, by phase
}
```

**Notes** are for what a reader should know before relying on the thing: for the gradient entry, the ML-side caveats
([`GRADIENT_FILLS.md`](GRADIENT_FILLS.md)). They fold away with the panel's `Disclosure`.

**The log and the metrics** are drawn with what the panel already has: the log cell with a time gutter (`TimedOutput`,
as the housekeeping log uses it) and a stacked chart over time (`TimeChart`), one series per phase. The gradient entry
reports CPU solve, upload and GPU draw per frame. GPU time comes from `EXT_disjoint_timer_query_webgl2` where the browser
exposes it; elsewhere from a forced sync (`readPixels` after the draw), labelled as an upper bound. A continuous-redraw
toggle turns the entry into a small benchmark.

## The CLI: `gallery.mjs` (in `scripts/`)

```bash
node scripts/gallery.mjs build                      # dist-gallery/
node scripts/gallery.mjs serve [--port 5180]        # build, then serve it
node scripts/gallery.mjs list ['<regex>'] [--group g] [--props <id>]
node scripts/gallery.mjs shot <id> [--variant v] [--props '<json>'|@file.json] [--dark] [--size WxH] [--out f.png]
node scripts/gallery.mjs check                      # render every entry, report what fails (below)
```

`shot` builds when the bundle is stale, renders the one entry and screenshots ITS tile, not the page, then prints the
path and any error the component threw; it exits 1 when the component did not render. A model Reads the PNG.

The skill is `gallery` (in `.claude/skills/`); AGENTS.md mentions it in one line.

## The check: what blocks and what warns

`gallery.mjs check` renders every entry in Chromium and sorts failures by who wrote the props:

| Failure | Result |
| --- | --- |
| the gallery bundle does not build | **blocks** (it is broken code) |
| a custom entry, or an `@gallery` example, throws or renders nothing | **blocks**: someone wrote that example on purpose, so its breaking is a broken claim, like JSDoc that contradicts the code |
| a component rendered from INFERRED props throws | **warns**, with the count and the list |

A component a change touches usually has an example, so a model that breaks it is stopped; one without an example is
not forced to grow one before an unrelated change can land. It runs in CI's tools job.

## Not in the first build

- Rendering at more than one theme in `check`.
- A visual diff of shots between two refs.
- Components from `mobile/` (React Native, not renderable in a page).
