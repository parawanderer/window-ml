# CDP click-through — clicking opaque surfaces via `chrome.debugger`

## Decision

Use **`chrome.debugger` (CDP) `Input.dispatchMouseEvent`** to click surfaces our
normal selector / synthetic-`dispatchEvent` path can't reach: **cross-origin
iframes** and **declarative / native closed shadow roots**. Chosen over
`chrome.scripting.executeScript`-into-the-frame because CDP is:

1. **Universal** — the *browser* hit-tests the coordinate, so one mechanism reaches
   everything (cross-origin iframe, declarative closed shadow — the one surface
   executeScript **cannot** touch since `.shadowRoot` is null even to a frame-injected
   script — native shadow, canvas, top frame). No frameId mapping, no coordinate
   composition, no duplicate-src edge cases.
2. **Trusted** — the click is `isTrusted: true` **with user activation**. executeScript's
   `dispatchEvent` is untrusted and can silently fail / be flagged on exactly the
   embedded payment / OAuth / bot-gated frames that are the point of iframe clicking.

**Cost accepted:** the unsuppressible "being debugged" banner. Fine — not a public
product, and it's *appropriate* transparency for an input-level action reaching into
the user's authenticated third-party frames. It's the honest "the browser is being
driven" signal.

**Scope: CLICK only.** Reading opaque / cross-origin content is a *separate,
deliberately-not-built* capability — that's SOP-bypassing data access with no gate in
front of it (read tools aren't approval-gated). The click/read asymmetry is the whole
point (see [[idea-iframe-support-security]]).

## Mechanism

Background: `chrome.debugger.attach({ tabId }, "1.3")` → `Input.dispatchMouseEvent`
(`mousePressed` then `mouseReleased`, `button:"left"`, `clickCount:1`) at viewport
`(x, y)` → detach. The browser routes the real input to whatever's at `(x, y)`.

## Attach lifecycle — DECIDED: per-**reserved-click** only

CDP (and its banner) fires **only** when the click target is a **reserved element** — one
that *cannot* be reached any cheaper way — so the flash becomes a meaningful risk signal:
each one means "the agent is now reaching into something sealed / cross-origin." Steady
per-run would be ambient noise; every-click would be noise; per-reserved-click *correlates
the banner with the risk*.

A target is **reserved** (→ CDP + banner) iff it resolves to:
- a **cross-origin iframe** inner point, or
- a **declarative / native closed shadow** inner point.

NOT reserved (→ cheap path, no CDP, no banner):
- anything selector-reachable (top frame, open shadow, **pierced** closed shadow),
- a **`<canvas>`** (synthetic `@pt` `clickAt` works — the listener is on the canvas
  element itself),
- (later) a same-origin iframe if we ever reach it via `contentDocument`.

So `click` picks the path by target: reachable → selector dispatch; canvas → `@pt`
synthetic; **reserved → CDP** (attach → dispatch → detach around that one click).

## Permission

`debugger` is declared at **INSTALL time** (in `permissions`, not optional). We WANTED runtime-optional
(to avoid the scary always-on perm), but **Chrome forbids `debugger` as an optional permission** —
`chrome.permissions.request(['debugger'])` rejects it: *"Only permissions specified in the manifest may be
requested."* So there's no per-use grant; the extension declares `debugger` at install (Chrome re-prompts on
update). The off-by-default **`cdpClick` flag** is the real on/off — the API stays unused until it's on AND
the model hits a reserved surface.

## Integration

- **`click` tool**: a target that resolves to an opaque surface (an `@pt`, or a selector
  hitting an iframe / un-pierceable closed-shadow host) routes to the CDP path instead of
  `clickAt`'s synthetic dispatch. **Same approval gate** (target-agnostic). The approval
  **highlight label names the target frame's origin** when it isn't the top origin (the
  one genuinely-new bit of surfacing — the live highlight already shows *what/where*; the
  label adds *whose origin*, since iframes render seamlessly).
- **locate simplifies**: no opaque-surface `@pt` gymnastics — locate just returns a
  coordinate and CDP clicks it uniformly. (Canvas `@pt` can migrate to CDP too, or keep
  its synthetic path since a canvas's listener is on the canvas element itself.)
- **Annotation strip** (Phase 2): Chrome's "…is debugging this browser" banner lives in the
  browser chrome — untouchable, and its text omits the *why*. So while CDP is attached we
  draw OUR own strip in the page's top overlay layer (the shell's shadow-root layer, same as
  the highlight), flush under the banner, anchored to its reliable **left edge** with an **↖**:
  *"window.ml is clicking through into a reserved element (cross-origin / sealed) — you
  approved this."* Shown only while attached, so it tracks the banner exactly. Can't be inline
  with the banner (that's chrome, one row up) — it's a row below with an up-left arrow.
- **Choke point**: the CDP click runs in the **background** only *after* an origin-authed
  `SET_APPROVAL`. A hostile page cannot self-trigger it — same invariant as `FETCH_SHEET`
  / full-`python_exec`. The background validates the approval before it attaches.

## Security posture

- Gated three ways: per-click approval (unforgeable, extension-origin surface) + runtime
  `debugger` permission + off-by-default flag.
- **No read** — click only; opaque/cross-origin *reading* stays unbuilt (SOP-bound).
- Transparency — the banner is present while attached: the honest "input-level control"
  signal, which matches the elevated stakes of clicking into authenticated third-party frames.
- Narrow CDP use — `Input.dispatchMouseEvent` only, not the broader CDP surface; attach /
  detach tightly around the click(s).

## Phases

1. **Background CDP-click primitive** — message contract (`CDP_CLICK { x, y }` keyed to the
   sender tab), attach → dispatch → detach, request-the-permission-if-missing, gate
   validation. Tested against a mocked `chrome.debugger`.
2. **Wire into `click`** — opaque-target / `@pt` → CDP route; selector click stays for
   reachable targets. Highlight origin label.
3. **Permission UI** — popup + Settings → Advanced: grant / revoke `debugger`, the flag.
4. **Cleanup** — optionally migrate canvas `@pt` to CDP; update `docs/LOCATE-VISION.md`
   and the example page (the declarative `sealed-note` becomes *clickable via CDP* — the
   honest "reachable only with the debugger attached" case).

## Open questions

- **Coordinate precision**: CDP clicks a viewport pixel; visual-locate accuracy bounds it
  (same as canvas today).
- **Reads on CDP?** No. Keep the click/read asymmetry; reads stay SOP-bound and unbuilt.
- **Reserved detection**: how the click path decides "cross-origin iframe" vs same-origin
  at `(x,y)` — `elementFromPoint` gives the `<iframe>`; compare its resolved origin (via
  `src`, or a background frame lookup) to the top origin. Declarative/native closed shadow
  = the un-pierceable-host heuristic (hyphenated, no light children, `.shadowRoot` null,
  `capturedClosedRoot` null). Firm this up in Phase 2.
