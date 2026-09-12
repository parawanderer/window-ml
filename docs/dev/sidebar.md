# The debug sidebar's surfaces

Implementation notes for the overlay and DevTools surfaces, `debugMode`, and shared UI components, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**One disclosure, everywhere something opens (`Disclosure`, ui-kit.tsx).** The panel had three of these
written three different ways — the model list's fold, the agent's system prompt and tool definitions, the
server-tool list — and all three were a pill button that injected a box into the layout on click. That reads
as content appearing rather than a section opening, gives no hint the thing can be closed, and shoves
whatever is below it. One component so the next one is free and a chevron means the same thing panel-wide.
The slide is `grid-template-rows: 0fr → 1fr`, which is the only way to animate a height nobody knows in
advance (`height: auto` does not transition); the inner child needs `min-height: 0` or a grid item refuses to
shrink below its content. Its body stays MOUNTED while closed — there has to be something to slide, and
content that only exists once open can only appear — so a landed fetch stays landed and reopening is instant.
`onOpen` fires on the opening edge only, for a section whose content has to be FETCHED (the server-tool list
still fetches on expand, never on mount). A consequence for tests: a collapsed body's rows are IN THE DOM, and
Playwright counts a clipped element as visible, so assert on the body's measured height rather than on
`toBeHidden`.

**Two surfaces (in-page overlay + DevTools panel).** The same `sidebar-app` bundle runs
in two places: the in-page **overlay** (a content-script shadow-root shell, `shell.ts`,
hosting `sidebar.html` in an iframe) and an optional **DevTools panel** (`devtools.ts`
registers a "window.ml" panel; `panel.html`/`panel.ts` host the *same* `sidebar.html`
iframe and play the same parent-relay role the shell does). `src/sidebar/app.tsx` is
untouched between them — the panel is byte-for-byte the overlay's app. Debug events reach
the panel by an **event-agnostic ONE-WAY stream**: `injected.js` → shell (forwards
`ML_DEBUG_EVENT`) → `background.ts` keeps a per-tab ring buffer (`DEBUG_BUFFER_CAP`) + fans
out to any connected `ml-devtools` port → `panel.ts` relays into the iframe (queuing until
the app handshakes `ready`). The buffer **replays on connect** (a panel opened mid-run
catches up); a fresh shell mount sends `ML_DEBUG_RESET` so stale events don't replay after
navigation. Spec: `docs/spec/DEVTOOLS_PANEL_PLAN.md`.

**Debug surface (`debugMode`).** One config, three values — `"off"` / `"overlay"` /
`"devtools"` (was the `sidebar` boolean) — set in the toolbar popup or Settings → Appearance.
`shell.ts` `applyMode` drives it: `overlay` mounts the in-page shell; `devtools` **attaches
the forwarder only** (relays `__mlDebug` to the background for the panel, draws NO overlay) and
posts `__mlSidebar:"ready"` **itself** (no iframe app to hand the handshake back) so injected.js
goes live; `off` attaches nothing (zero cost). The shell still acks `__mlSidebarShot` in
devtools mode so `look` screenshots work with no overlay to hide. The surfaces are
**exclusive** — the shell forwards to the background ONLY in `devtools` mode (overlay events
stay on the page). A DevTools panel can't be un-registered, so it's always a tab; `panel.ts`
reads `debugMode` and, when it isn't the active surface (`off`/`overlay`), swaps the app for a
self-explaining note instead of a misleading empty log. **Handshake race:** injected.js
announces `__mlSidebar:"hello"` when it loads and the shell re-sends `present`/`ready` on it —
without this, the shell's immediate `ready` (devtools mode has no iframe app to wait for) could
land before injected's async `<script>` was listening, stranding the panel un-live on Ctrl+R
until a settings toggle. `bus.ts` replays its ring only ONCE per session so the re-handshake
can't double-emit.

**Extending the sidebar — will it work in both surfaces?** *View/read features come free:*
a new debug **event kind** (the transport forwards any `__mlDebug` payload), a new
`RenderPanel` descriptor, session UI, export, or anything using `chrome.runtime`/
`chrome.storage` renders identically in both — it's the same app. *Two things don't:*
(1) a **new message the app posts to its parent** (the app→parent protocol is
`__mlSidebarApp:"ready"`, `__mlLightbox` and the chart's `"chartKeys"`, all handled in `panel.ts` — the last
deliberately as a no-op, since DevTools cannot relay page keys) must be handled in
`panel.ts` too; (2) anything that **acts back on the page** or **sends input into the
agent** (the session composer) needs a **reverse channel** — the debug transport itself
is one-way (page→panel). The overlay can reach the page (its parent is a content script);
the panel routes `panel → background → content-script shell`, keyed by the inspected
`tabId`. **Hover-highlight uses exactly this**: the app posts `__mlHighlight`; `panel.ts`
forwards it to the background as `ML_HL_REMOTE {tabId, ref}`, which `chrome.tabs.sendMessage`s
to the tab's `shell.ts`, which draws the box (in devtools mode it lazily mounts a
highlight-only shadow host, since no overlay is present). `SET_APPROVAL` is the same shape.
A future page-input channel would follow the pattern.
