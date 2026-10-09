# The debug sidebar's surfaces

Implementation notes for the overlay and DevTools surfaces, `debugMode`, and shared UI components, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**One disclosure, everywhere something opens (`Disclosure`, disclosure.tsx).** The panel had three of these
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

**One small chart over time that you can read (`TimeChart`, time-chart.tsx).** Stacked series against a time axis,
with a readout: pointer, tap or arrow keys snap to the nearest sample, draw a rule there and a dot on each series,
and put the time, every series' value and the total in the panel's one cursor tooltip. Points are `{ t, values }`
and series `{ key, label, cls }`; the caller says how a value and a time are written. The x axis is linear in TIME,
so uneven samples sit where they happened. The rule and the dots are HTML over the stretched SVG, because a circle
inside it would stretch into an ellipse. First user: the Storage section's history. Reach for it before drawing
another SVG over time; the resource panel's chart is deliberately not built on it (an axis with gaps, bands that
belong to models, keyboard depth).

**Two surfaces (in-page overlay + DevTools panel).** The same `sidebar-app` bundle runs
in two places: the in-page **overlay** (a content-script shadow-root shell, `shell.ts`,
hosting `sidebar.html` in an iframe) and an optional **DevTools panel** (`devtools.ts`
registers a "window.ml" panel; `panel.html`/`panel.ts` host the *same* `sidebar.html`
iframe and play the same parent-relay role the shell does). `src/sidebar/app.tsx` is
untouched between them — the panel is byte-for-byte the overlay's app. Debug events reach
the panel by an **event-agnostic ONE-WAY stream**: `injected.js` → shell (forwards
`ML_DEBUG_EVENT`) → `sw-debug.ts` keeps a per-tab ring buffer (`DEBUG_BUFFER_CAP`) + fans
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

**Keeping the extension out of a shot (`shell-shot.ts`).** Two paths. A page-hosted vision tool HIDES the sidebar with
the window handshake (`__mlSidebarShot: hide → hidden → show`), taken only from the page's own window (`e.source`), and
the hide lifts itself after 5 s if no show comes. A shot the WORKER takes (`workerShot`, `sw/worker-vision.ts`) changes
nothing on the page: it asks the shell over `chrome.tabs.sendMessage` (`SHOT_RECTS`, top frame, pinned to the shot's
`documentId`; answered only for this extension's id with no `sender.tab`, never page-relayable) for the viewport rects of
everything the shell paints (every element in its shadow roots, padded by its shadow, outline and filter; the hover
highlight as four strips round the element, never the element; any extension frame the page embedded), before and
after the capture, and paints the union opaque grey in the worker (`sw/shot-mask.ts`). Why not hide: an inline hide is
page-owned DOM, so a stylesheet overrides it, a MutationObserver times every shot, and a page that blocks its main thread
holds the ack. A shell that does not answer within 1 s is a refusal; a mask over 60% of the shot (the image viewer, a
near-full sidebar or card) is a refusal naming what to put away. Residual: a page that moves or animates the extension's
own elements continuously (or reflects them, `-webkit-box-reflect`) can get extension pixels into its OWN screenshot
for the vision model; it gets no pixels back and no timing signal. The highlight's translucent tint over the outlined
element stays in the shot.

**The services seam (`services.ts`): the session views never call `chrome` or the parent frame themselves.**
The session views (agent runs, chat turns, output cells, code blocks, approvals, the composer) are shared by the
overlay, the DevTools panel and the HUD card, and by the chat page and a phone app next (`docs/spec/CHAT_PAGE.md`),
where there is no `chrome` and no parent frame. So they call `services()`: side calls to the utility model (titles,
block summaries, explain notes), answering an approval, sending to / cancelling / continuing a session, page
highlight, the lightbox, host-permission checks, sheet titles, and saving a display pref. Each ENTRY POINT installs an
implementation before it renders: `app.tsx` installs `services-ext.ts`, the same messaging these calls made inline
(the background over `chrome.runtime`, the frame's parent over `postMessage`). A test that renders a view directly is
its own entry point and installs them too (`tests/code-tools.test.mjs`); without that, every call answers "not
available here" instead of throwing. `tests/portable-session-views.test.mjs` walks the views' imports and fails on a
direct `chrome.*` call or a parent post, so the seam cannot erode. Extension-only surfaces (the HUD card's own
controls, Settings, the resource panel, the bench) still call `chrome` directly: they are not reused off the extension.

The seam also answers two QUESTIONS the views used to answer by reading the extension's own state:
`sideCalls(session)` (can a title, summary or explain call be made about this session here?) and `bench` (is there a
Python bench to hand a script to?). The extension answers the first from its utility-model setting and the second with
yes; the chat page answers from the session's runtime (its `sideCalls` capability and this client's grant) and no.
Gate an affordance on the question, never on `config.value.utilityModel`: the config is this browser's, and a session
from another runtime is glossed by that runtime's utility model or not at all.

**A session's key (`Session.hash`).** The bare 8-hex hash for the sidebar's own sessions; `runtime:hash` when a client
reduces several runtimes' events (`onDebug(ev, runtime)`), because a hash is unique only within its runtime. Every
session-keyed map (steps, asides, decided gates, summaries) uses it, so runtimes stay apart without those maps knowing.
Split a key on its LAST `:` (`bareHash`, `splitStepKey`), never `split(":")`.

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

## Traps

- **The app talks to its host only through `parent-channel.ts`** (`toHost`, `onHostMessage`), never
  `window.parent.postMessage` or a `message` listener of its own. On a web page the overlay's and the card's parent
  window IS the page, and the shell's shadow roots are open, so a page can reach the iframe, read what it posts to its
  parent and post into it (docs/spec/SITE_ACCESS.md, attack 16). There the app and the shell share a `MessagePort`,
  set up by a nonce the app sends through `chrome.tabs.sendMessage`; the DevTools panel, an extension page, keeps plain
  window messages. A run's events reach the shell over `chrome.runtime` (`ML_DEBUG_TO_PAGE`), never the page's window,
  and a page's events are admitted by `pageMayWrite` (`src/event-admission.ts`). A test opens the sidebar by clicking
  its tab and watches a background run with `watchRunEvents` (e2e harness), not by posting into the frame.
- **Sidebar.** One app, two surfaces: a new app→parent message must also be handled in `panel.ts`, and anything
  that acts back on the page needs the reverse channel (panel → background → content shell). The shared session
  views call `services()` (`services.ts`), never `chrome.*` or the parent frame, because the chat page and a phone app
  reuse them; an entry point installs the implementation before rendering. Gate an affordance on the seam's questions
  (`sideCalls(session)`, `bench`), never on this browser's `config`. A session's key is `Session.hash`, which is
  `runtime:hash` in a multi-runtime client: split keys on the LAST `:`.
- **Transcript.** A long session is WINDOWED: only the newest `WINDOW` items are in the DOM (`transcript-window.tsx`;
  a 1000-turn chat drew 34k nodes and 1.9 MB before it). Anything that JUMPS to a step goes through `reveal`, which
  grows the window, pages the session back and reports `gone` — a citation that silently does nothing is the failure
  being prevented. The window is a plain Map bumped through `rev`, NEVER a signal read during render: a component that
  reads a signal is converted to re-render from it and stops re-rendering from the parent's `rev` cascade, which made
  live turns stop appearing while every window assertion still passed.

## Tooltips: the panel's, not the browser's `title`

**Shared pieces that work without the panel**, so a page with none (the bench's) imports them instead of rebuilding
them: `Hash` (copy-hash.tsx), `Disclosure` (disclosure.tsx), `Tip`, a label explained on hover (help-tip.tsx),
`Interval`, an estimate on its interval (interval-bar.tsx), `CodeBlock`, a code block with the line-number setting and
mark tooltip as props (code-block.tsx; ui-kit's `Code` fills them in from the panel), `DiffLines`, a diff's rows with
the old/new line-number gutter on the code block's surface (code-diff.tsx; a retry's diff and the bench's Spec card),
`FilterChips`, show/hide chips
(filter-chips.tsx), `LaneBars` and the lane tooltip's body `EventTipBody` (resource/event-tip.tsx; the panel's
`EventTip` wraps it in its hover), and the chart's keys, `installChartKeys` (resource-chart.tsx; the panel installs it
while open). Each imports nothing from ui-kit or the store; their CSS stays in sidebar.css, and
the bench lifts it with `sidebarRules`.
A STANDALONE page's own furniture is `Card`, a section that folds (fold-card.tsx), with the tiles, badges and buttons
around it in **page-kit.css** (src/sidebar), which such a page loads whole. Not in sidebar.css: its names (`.card`,
`.btn`, `.badge`) are short and generic, and the panel and the chat page style their own.

**RULE — use the PANEL'S tooltip, not the browser's `title`.** `cursorTipOn(text)` (ui-kit.tsx) is the
default for anything explanatory; a native `title` needs an argument for itself. Three reasons, all of them
things a reader hits rather than notices: the native one waits about a second, which on something you are
hovering to decide whether to CLICK is long enough to have given up; it renders as an OS artefact rather than
as part of the panel, and cannot show a pointer as code or wrap a sentence sensibly; and on a wide target —
a code line, a table cell, a whole row — it appears wherever the pointer is while an anchored tip can sit
half a panel away from what summoned it. `cursorTipOn` follows the cursor and is read into the one shared
floating layer (`CursorTipLayer`), which is also what makes its prose unselectable, so copying a code block
never picks up the explanation of it.

  **TWO RENDER MODES, told apart by TYPE.** `cursorTipOn` takes a `string` OR a node. A STRING is markdown
  TEXT — escaped, then rendered inline (`code`, *emphasis*, math) — because a string is where content from
  OUTSIDE arrives: a JSON Schema's `description`, a tool result, a model's prose. Treating one as markup
  would be an injection. Anything else is authored JSX, passed as children rather than an HTML string, so
  there is no way to hand it something unescaped by accident. `TipText` (ui-kit) does the same for the
  ANCHORED `.tt-pop` tooltips whose prose comes from data — the JSON tree's key descriptions are our own
  parameter docs, which are full of backticked identifiers, and printing the backticks reads as a renderer
  that gave up.

  **What inline markdown will NOT do, deliberately**: no images (unbounded pixels in a gutter or a tooltip,
  and a tool result could put them there) and no links out of a model's prose — a one-click egress in chrome
  the reader trusts, whose text and destination markdown lets disagree. A pointer link stays text there too:
  navigating needs the run's `seq`, which this renderer has none of, and a link that goes nowhere is worse
  than plain text. Pointer links live in the ANSWER renderer, which has that context. Both refusals have a
  test, because both are currently true by accident of how the inline pass works.

  **A FINGER CAN READ ONE TOO.** A touch raises `pointerover` and then, a moment later, the synthetic
  `pointerout` that ends it, so every anchored tip used to flash and vanish on a phone and its prose was simply
  unreachable. A TAP now holds one open and the next tap anywhere dismisses it (`tooltip-layer.ts`) — but only on
  a trigger that is NOT itself a control. The split is the same one below: a control's tip is its NAME, which
  `aria-label` already carries, and raising a popup on every icon button a finger lands on turns ordinary use into
  a flicker. The tap is never stolen — whatever it was pressing still happens.

  **The exception is an accessible NAME.** A `title` on an icon-only control is what a screen reader and a
  keyboard user get, and `cursorTip` is pointer-only — so those keep a name (prefer `aria-label`) and gain
  the custom tip for the pointer. The split is: naming a control → `aria-label` (+ a tip); explaining
  anything → the custom tip. When the prose must also be readable with no pointer at all, put a `.tt-pop`
  child in the DOM beside it, the way a marked code line does.

  Not yet swept: `settings.tsx`, `hud-card.tsx`, `card-composer.tsx`, `resource-scrub.tsx` and
  `resource-device-view.tsx` still hold native `title`s. New code follows the rule; those are a follow-up, not a
  licence.

  **A TIP MUST GO WHEN THE POINTER DOES, and three ways of going raise no leave** (`pointer-gone.ts`).
  - **Off the overlay's iframe onto the page.** The frame is told NOTHING (measured: no trusted pointerout,
    pointerleave, mouseout or blur, in one move or ten), so every tip that hides on a leave stayed up. The app says
    when the pointer comes in (`__mlSidebarApp: "pointerIn"`, once per crossing), the shell answers
    `__mlSidebarPointerOut` at the page's next pointer move, and `pointerGone` REPLAYS the missing `pointerout` and
    `pointerleave`s on whatever the pointer was last over. Every tip's own hide path then runs, so a new tip needs
    nothing for this case. The DevTools panel is not covered: the app fills it, and nothing of ours sees the pointer
    arrive in DevTools' own chrome.
  - **A scroll or a window blur** moves the content, or the focus, without moving the pointer. The anchored layer
    always handled both; the cursor-following tips use `useGoneOnScrollOrBlur`. A scroll is a reason to LOOK: the tip
    stays while its subject is still under the pointer (`underPointer`), because the scroll that brings a trigger into
    view can land a frame after the pointer, and hiding on it took down a tip just raised (the tab picker, in CI).
  - **A control that unmounts under the pointer** (the ✕ that evicts a model) never sends its leave. Whatever a
    control's enter switched on must be re-derived from where the pointer is on the next move, as the model row does
    for `rowTipSuppressed`, rather than trusted to be switched off by the matching leave.
  `tests/pointer-gone.test.mjs` covers the replay and the scroll and blur cases; `tooltips.spec.mjs` covers the
  real iframe ("moving straight off the panel…"), and asserts the browser sent nothing, so it cannot pass for the
  wrong reason.
