# Agent tools and the loop

Implementation notes for the agent's tools, the read-only exec dialect, locate/vision, cross-page runs, approvals over IPC, how runs render in the sidebar, and run recovery, moved out of AGENTS.md on 2026-09-12 so they are read when that code is being
changed rather than loaded into every session. AGENTS.md keeps the repository's working rules and the traps that
bite; this file keeps how the subsystem works and why it is built that way. Paths name files by their bare name,
as in AGENTS.md — they are all under `src/`.

**The read-only dialect now has its own file, [`readonly-exec.md`](readonly-exec.md)**: the three stages, the
contract, halting, and how to extend it. The paragraphs below are the older summary.

**Read-only `exec` auto-approve (experimental).** `exec` is `requiresApproval`,
but the config flag `autoApproveReadonly` (ON by default) lets a **read-only DOM
survey** (`querySelectorAll → filter → map`, no mutation) run with **no prompt**
via a mediated mini-interpreter — `readonly-exec.ts` (`evalReadonly`), a
dependency-free tokenizer + Pratt parser + tree-walker bundled into
`injected.js`. It (1) *is* the whitelist — only the modeled dialect runs; (2)
never compiles a string, so it clears **Trusted Types** (Gmail); (3) is safe by
**mediation** — reads are denylisted (`constructor`/`ownerDocument`/`window`/…)
and calls are allowlisted to read/query/pure methods only, so no effectful method
(`fetch`/`click`/`setAttribute`/…) can be invoked even off a leaked `window`, and
`Function`/`eval` are unreachable. The agent loop's approval branch *tries*
`evalReadonly` and, on **any** `NotInDialect`/`Denied` throw, falls through to the
normal approval + `eval` path — safe because the interpreter is side-effect-free,
so a failed attempt does nothing observable. Deliberately incomplete: gaps
degrade to "asks the human," never to "runs unsafely."
The dialect also gets a **read-only `ml`** so self-introspection ("which model am I?" →
`await ml.getModel()`) is free rather than costing an approval. Not `window.ml`: `mlFacade`
builds a null-prototype object holding only `ML_READONLY_METHODS` (`getModel`/`config`/
`models`/`capabilities`/`ps`/`serverTools`), so the mutating (`setModel`/`unload`), token-
spending (`chat`/`agent`/`read`) and privileged (`pythonExec`/`screenshot`) halves aren't
*present* to reach; those names never join `ALLOWED_METHODS` (keyed by name across every
object) — the facade is checked by identity in `evalCall`. It grants no new capability (the
page can call `ml.config()` from its own console, and it's already the non-secret subset) —
it lifts a **prompt**, not a boundary. Since every ml method is async, `Evaluator.eval` is a
**generator**: `yield` to have the driver await. Two drivers — `runAsync` (top level) and
`runSync` for arrows a host method invokes (`.map` calls its callback synchronously), so an
`await` inside a callback throws `NotInDialect` → approval, never a silently Promise-valued
answer. A facade call is auto-awaited, so a forgotten `await` still reads the value — and the
shapes models actually write are supported: `Promise.all([…])` (`Promise` is a **namespace only**
— `all`/`allSettled` allowlisted, never callable/constructable) and `ml.getModel().then(m => …)`
(auto-await already left a value, so `then` applies an **inline** callback to it). The model
learns this from a RUNTIME section of `agent_api_docs` (`selfIntrospectionSection`) — beside the
HUD shortcut, and for the same reason: it's true only while the flag is on, and the system prompt
shouldn't pay for it on every run. Spec:
`docs/spec/READONLY_EXEC_SPEC.md`; the interpreter is unit-tested standalone against the two
canonical surveys, the `ml` gate, and a battery of escape attempts in
`tests/readonly-exec.test.mjs`.


**Visual element location (`locate` / vision).** For controls text/ARIA can't reach — unlabelled
icon buttons, or canvas-only UIs (a bare `<div>`/`<canvas>` with a synthetic click handler) —
`ml.locateTool` finds an element by **describing its appearance** ("a red umbrella icon", never a
name). Like `look`, it's a **delegated** vision sub-call: the model sees an annotated screenshot and
returns a badge number / coordinate; only a stateless `clickSelector` (or a `@pt:`/`@box:` token for a
canvas) re-enters the driver's thread, so a text-only driver can use it and the sub-call's image never
enters the driver's context. Auto-wired into `ml.agent` beside `look` whenever a vision reader resolves.

**Read `docs/LOCATE-VISION.md` before touching locate** — it's the whole pipeline, illustrated with
mermaid diagrams. It covers: the hit-testing primitive (`document.elementFromPoint`, NOT selector
matching) + the `representativeFor` walk-up; the delegation boundary; the four `strategy` dialects
(`marks` Set-of-Marks · `grounding` a coordinate VLM · `grid` numbered-cell classification ·
`grid-grounding`, plus `auto`); the letterbox → 1000×1000 / `groundingRange` coordinate mapping and its
inverse; the scoping tiers (`region` → `grid` → `cells` recursion; `selector`/`index`; the `@pt:`
snap-around-point — a fractal zoom); the canvas/`@pt` coordinate path (mint → `clickAt` → look-verify,
with the re-locate-loop dedup); the density guard, overlay-colour heuristic, debug-render substeps, and
the delegated-sub-call `num_ctx` resident-caching gotcha. All four original slices shipped (incl. the
canvas half: grid, grid-grounding, `@pt`). Pure geometry (`locate.ts`) is unit-tested standalone
(`tests/locate.test.mjs`, importing the source directly via tsx); scoping guards in `tests/agent.test.js`.

**Snap-inject (skip the verify `look`).** When grounding actually SNAPS on something at the end,
`feedBack` (in `buildLocateTool`) feeds the marked crop straight into the driver's context so it can
confirm in-turn and go `locate → click` instead of `locate → look → click`. Only fires on the
grounding-box success returns — NOT the grid cell-CENTRE fallback ("may graze"), which stays manual by
design (grounding gives no confidence score; the binary snapped-vs-fell-back IS the signal). An `@pt`
ALWAYS injects (the model always verifies a coordinate); a DOM selector / `@box` only when the caller
passes **`verify:true`** (structurally a `look()` on the result folded into the same call). A vision
driver gets the crop as an inline **image**; a text-only driver gets a delegated **description** of it (a
reader sub-call) with a clarification that it can't see the image. **"Does the driver see natively"
(`driverSees`) + the resolved reader (`visionModel`) are resolved ONCE in the auto-wire and carried on
the `ToolContext`** (`tool-exec.ts` `toolContext`; page loop + the background-delegated path in
`run-delegation.ts` both build it from the same values) — so `locate`'s feedback reads the SAME answer
that chose native-vs-delegated `look` instead of re-deriving it. That double-resolution was a real bug: a
second `_modelSees(agentModel)` probe disagreed with `_resolveVisionModel` when `agentModel` resolved null,
forcing a vision-capable Ollama agent onto the delegated "you can't see images" path. `driverSees` is now
`visionModel === runModel` (the reader IS the agent's own model), and `runModel` is resolved once (was
computed twice). Near-area **dedup**: a per-run `VisionMemory` (`{ seen }`,
shared by the auto-wired `look` + `locate`; `markSeen`/`seenNearby` in util.ts, radius `PT_LOOK_RADIUS`)
records the spots the driver was shown, so a re-snap onto an already-seen point doesn't re-inject the
near-identical crop (the re-snap-loop case). What got injected + WHY rides a `ToolFeedback` on the
result → the `agent-step` event → a **"Sent to the model"** section in the sidebar (`FeedbackBlock`) and
the export (both surfaces, per the render-in-both rule). Dedup logic unit-tested in `tests/util.test.mjs`.

**`verify` on `click`/`type` (fold the post-action `look`).** The other constant chain is
*do-the-task → look*, so `click`/`type` take an optional **`verify:true`** (never automatic — the param
description says "set it if you'd `look()` right after"). After the action, `verifyAfterAction`
(builtin-tools.ts) captures a **general-area** crop (a `@pt` minted at the element's centre, screenshotted
with `VERIFY_MARGIN` — bigger than a tight element crop, so a menu/nav/validation that appeared is visible)
and feeds it back through the SAME native/delegated split as the locate snap-inject (`ctx.driverSees` →
inline image; text-only → a delegated describe + `CLICK_MARK_NOTE`), as a `ToolResult` with the same
`ToolFeedback` render. It targets the SAME element acted on — **but if that element vanished after the
action** (re-resolve misses → the page mutated: a button that removed itself, a form that navigated), it
falls back to the element's **pre-action centre** and annotates the crop "the element you acted on is
GONE — the page changed" (`elementCenter` captures the centre BEFORE the action for exactly this). The
shared helper is `captureVerify(host, ctx, center, verb, mutated?)` — **`center: null` → a whole-VIEWPORT
shot** (no click-mark, no `CLICK_MARK_NOTE`) instead of a crop. `wait` (a PURE domTool in tools.ts, no
`ml`) also takes `verify` and is **area-first** (you verify the settled page, not the element you waited
on): it can't reach `captureVerify` directly, so `makeDomTools(defineTool, verifyArea?)` receives an
ml-backed `VerifyArea` closure (built in injected.ts) — keeping the domTools ml-free. Tested in
`tests/agent.test.js` (click/type native / delegated / mutated / no-vision; wait viewport native /
delegated-no-mark).

**The vision host.** `look` (native and delegated), `locate` and the verify helpers reach the page, the tab and
the model only through a `VisionHost` (`src/tools/vision-host.ts`): `geo` answers layout questions (where a
selector or token is, the Set-of-Marks sweep, a grounding box or grid cell snapped to the DOM, a minted token, the
legend under a box, the stitch's scroll steps) in plain JSON-able data, `capture` shoots the viewport, `shoot` is
`ml.screenshot`'s crop of a target (`shootVia` in ml-vision.ts builds it from `geo` + `capture` + `raster`), and
`chat` is the one-shot model call (`oneShotRequest`, ml-chat.ts, is its FETCH_LLM payload). Today every body runs
on `pageVisionHost` (`src/dom/page-geometry.ts`), which answers from the DOM, CAPTURE_TAB and `ml.chat` exactly as
before; the seam is what lets a worker host ask the same geometry of the page over a message instead
(`tests/vision-host.test.mjs` drives the bodies over a fake host with no DOM in the process).

**The worker's vision host** (`workerVisionHost`, `src/sw/worker-vision-host.ts`; `look` and the verify after an action run on it). The
same bodies, with the capture (`workerShot`), the drawing (`workerRaster`) and the model call (`workerVisionChat`) in
the worker, and only GEOMETRY asked of the page: `RUN_TOOL_IN_PAGE { runId, geometry: { seq, op, ...args } }` through
`delegateSend`, pinned to one documentId for the whole call, answered by `answerGeometry` (page-geometry.ts) in
`envelope.geometry` with `seq` (and a stitch's id) echoed. `checkGeometry` (`src/sw/geometry-check.ts`) rebuilds every
reply field by field (finite numbers clamped to ±1e5, enums, text cut and control characters folded, selectors and
`@pt`/`@box` tokens refused rather than cut, list caps, mark ids renumbered by the worker) and refuses the whole reply on
any malformed part. Page text is held to its field: control and format characters (C0, C1, bidi, zero-width) fold to a
space in names and refuse a selector, as does a backtick; a role is a role token or `generic`; a legend crosses as data
(bare names the legend quotes itself, folding « » and ` inside; `LegendBoundary`, phrased by `boundaryLine`) at the
page host's own caps. A refusal, a 10 s stall, or ANY navigation of the tab's top frame while the call is open (a
commit, a back-forward restore, pushState, a fragment) is the WHOLE call's (`refusal()`, `onWorkerHost` hands it back
instead of a half result a body made of it). The run's vision memory is per document, and a call's marks reach it
only when the call completes. A crop that misses the capture (`cropDataUrl`, `OFF_CAPTURE`) or an element with a
sliver in view is refused on every host. Stitch ids are the worker's, the page keeps each open stitch by id, and a
refused stitch is still ended while the document is the call's. The pixel ratio is the capture's width over the page's viewport width; more than 2% from
what the page reported, the capture's wins and the run log notes `routing`/`dpr-mismatch`. The worker bounds a stitch
itself (nine tiles, a canvas of at most 65536 device px). Tests: `tests/geometry-check.test.mjs`,
`tests/worker-vision-host.test.mjs`.

**The `look` of a worker-built run is the worker's** (`src/sw/worker-look.ts`). For a run the worker built or was
handed, the run host never sends the page a `look` call: it builds the page's own tool (`buildNativeLookTool` when the
driver sees, `buildLookTool` with the run's reader otherwise, from the run's carried vision facts) over a worker host
pinned to the tab's top document once any navigation settles, and runs it through `executeTool`/`envelopeFrom` as the
page would. So the model gets the same text, image(s) or reader's words; the capture, the crops, the `views`, the stitch's
compose, the reader's prompt and reply, and the legend's wording (from structured `legend` geometry, with the run's
per-document `boundariesSeen`) stay in the worker, and the reader's call is the call's `subUsage`. An `@tool:` image
pointer (`_image`) asks the page nothing at all. A preview (an approval card, a pending step) still asks the page to draw
the In label, sent the target only (`lookPreviewArgs`: `selector`, `index`), never the question. A refused call is
`Error: ` and the host's fixed sentence, never half a result. A full-page look is bounded by the host (eight screens,
nine tiles, a 65536 px canvas, each tile correlated to its stitch and question). Tests: `tests/worker-vision-host.test.mjs`
(the look section), `tests/vision-characterize.test.mjs`.

**The verify of a worker-built run is the worker's** (`src/sw/worker-verify.ts`). For a run the worker built or was
handed, the run host sends the call itself with `verifyInWorker: true`; the page marks the call's context
(`verifyInWorker`, builtin-tools.ts) and its click, type or wait captures nothing and calls no model: it answers with a
`verifyRequest`, plain data saying what the page's own verify would have pictured: `{ kind: "area", center, mutated? }`
(click, and a type whose field vanished), `{ kind: "element", selector, index?, line?, center? }` (type: the field, its
`elLine`, and the pre-action centre to fall back to) or `{ kind: "viewport" }` (wait). `checkVerifyRequest` rebuilds it
or refuses it whole: only a click, type or wait the MODEL asked to verify may have one, only of the kinds that tool
makes; coordinates finite and clamped to ±1e5; an element is the call's own `selector` and `index` (a page cannot point
the picture at another element), held to geometry-check's selector rules; the line folded and cut to 200. A refused
request appends a fixed note; one the model did not ask for is dropped silently. The worker then runs the same bodies
(`captureVerify`, `captureVerifyElement`) on a worker host, so the model gets the text and picture it got before, and
the reader's call is metered into the run (`ensureRunState`, worker-tools.ts). The CDP ring-backs (a debugger click, a
sealed-shadow click, a trusted type, a navigate's destination) take the verify in the worker directly, with the target
chosen from the call's own arguments (`@focus` → the focused element, a canvas → the call's selector), and whether to
verify is the model's `verify`, never the page's flag. Page-hosted runs keep the page's verify and its ring-backs.
Pinning: a click/type/wait verify is pinned to the document the call was SENT to (else, when a navigation was in
flight, the tab's top document once the answer is in), because the request's coordinates and selector describe that
document. An action that navigated the tab therefore gets the refusal sentence ("the page changed … look again"), never
a picture of the destination taken with the old page's geometry. A `navigate` verify is the one meant for the
destination: it is pinned to the tab's top document after the new page re-adopted the run. The verify is unmistakably
the worker's: before anything is appended, the page's result text has the verify's marks folded (`foldVerifyMarks`):
every 👁 (the mark a reader's description opens with) becomes "(eye)", and the sentence that presents a reader's
description ("You can't see images, so this is …'s description:", apostrophes and spacing varied) is quoted as the
page's own text. The worker's block then needs no separator of its own: its 👁 is the only one in the result, a page
cannot write that code point, and a driver that sees gets the worker's image, which no page envelope can carry. An
honest run's text is unchanged. The fold is narrow on purpose (any other text is the page's word, as before), so a
paraphrase or a homoglyph of the lead sentence is still readable as page text, just never with the worker's mark. A
verify the model asked for that does not happen says so in a fixed note: the page sent no request (`VERIFY_WITHHELD`),
a malformed one (`VERIFY_REFUSED`), a refused geometry call, or a capture that failed (the worker's own sentence, such
as the tab not showing). Who strips is decided on the page's ANSWER, so a call in flight when the person takes a run
over comes back stripped. Tests: `tests/worker-verify.test.mjs`, `tests/review-verify.test.mjs`, and the verify cases
of `tests/vision-characterize.test.mjs`.

**Agent self-knowledge (`agent_api_docs`).** The agent had none: asked "how do I call you
from the console?" it answered from pre-training ("try typing `window`…"), because nothing in
its context named `window.ml` or the extension. Two pieces fix it. `SELF_CLAUSE` (prompts.ts,
appended like the other clauses when the tool is present) is the *identity* — one line saying
this run is an `ml.agent(task)` call inside a Chrome extension whose API the user drives from
the devtools console, plus "that's the user's handle on you, not one of your tools; don't call
it from `exec`". The `agent_api_docs` tool (no args, terse description) is the *reference*, and
it's **generated from `contract.ts`, never curated** — `scripts/gen-api-docs.mjs` lifts `MlApi`'s
public members with their JSDoc, drops the `_` plumbing, then chases the option/result types
they reference (transitively, minus a `SKIP_TYPES` denylist of render/debug internals — a bare
`chat(prompt, options?)` teaches the model nothing about `schema`/`think`/`onToken`) into
`api-docs.gen.ts` (**gitignored**, written by `build.mjs` before bundling and by
`npm run typecheck`; `tools.ts` imports it). ~4k tokens, so it stays behind a tool call rather
than in every system prompt. The tool's `run` **appends a RUNTIME section** the generated doc
can't hold: the HUD keyboard shortcut is **user-rebindable**, so it's read live via
`GET_INVOCATION` (a new background message → `chrome.commands.getAll()`) — reporting what's bound
*now*, whether that still matches the manifest (`isDefault`) or the user changed it, and `""` when
they cleared it (a hardcoded "Alt+Space" would eventually send someone to a dead key). The
rebinding URL is browser-correct: `browserInfo()` (util.ts, pure/unit-tested — prefers
`userAgentData.brands`, since Brave/Edge impersonate Chrome in the UA) maps the fork to its scheme
(`edge://`/`brave://`/…), and also adds a `Browser:` line to `pageContext()`. The lookup is bounded
by `INVOCATION_TIMEOUT_MS` and falls back to generic advice — a docs call must never stall a step.
The **context-menu** line is gated on the manifest declaring `contextMenus`, so it turns itself on
when that feature ships rather than advertising an affordance that doesn't exist yet. A
**HUD-started** run additionally gets `HUD_HINT` via `ml.agent`'s
`systemAppend` (which APPENDS; `system` would replace the preamble) in the worker's run recipe (`userRunOptions`) —
SELF_CLAUSE's "the user can drive you from the console" is true but isn't how *that* user
actually invoked it. It's a **line scanner, not a real parser**: `typescript@7` is the
Go port and exports only `version` — no JS compiler API — so TypeDoc/ts-morph would each mean a
second TypeScript in the tree. It leans on contract.ts's house style (top-level `export interface
X {`, one member per line, JSDoc above) and **throws** rather than silently truncating if that
stops holding; `tests/api-docs.test.mjs` regenerates and diffs the checked-in output, so a
contract.ts edit can't leave the shipped doc stale.

**Cross-page persistence (`navigate` + re-adoption).** A BACKGROUND-hosted run (design A) survives a
same-origin full-page navigation: the SW is the durable spine, the page an ephemeral limb, delegation keyed by
the stable `tabId`. The seam is `nav-barrier.ts` — a per-tab barrier every `RUN_TOOL_IN_PAGE` goes through
(`delegateSend` awaits `navBarrier.whenReady(tabId)`; instant on an idle tab, so single-page runs are
unaffected). Flow: the `navigate(url)` tool (`ml.navigateTool()`; same-origin only via `navTarget` in dom.ts,
pure/tested; **defers `location.href` a tick** so its result posts back before unload) fires → the background
**engages the barrier the instant that result returns** (`delegateTool`, gated on a non-error result) — NOT
only via `webNavigation.onCommitted`, because the loop's next fast local model call + tool delegation RACES
ahead of that async event and would fire the next tool into the dying document (the hard-won bug;
`onCommitted` is now just the backup for IMPLICIT link-click navs). The new document RE-ADOPTS: injected posts
`PAGE_ADOPT_HELLO` on load → content.ts `CONTENT_READY` → the background replies with the run's
`RebuildConfig` (tool names + carried vision facts) from a **live `runRebuilds` map** (set at START — `bgRuns`
only snapshots at run END, too late for a mid-run nav) → content posts `ADOPT_RUN` → injected `_adoptRun`
rebuilds the **BUILTIN** toolset (`_rebuildToolset`; custom function tools can't serialize, so cross-page is
the default/HUD kit only) + `registerRun` → `RUN_READOPTED` → `navBarrier.noteReadopted` releases the held
tool. The agent option **`navigate`** (default true) gates the tool + persistence: `false` → no tool, no
`trackRun` (`StartRunPayload.crossPage`), a `NAV_OFF_CLAUSE` telling the model it can't navigate, and a
`config.navigate` line in the "agent options" debug log. A page-hosted run (no debug surface + no approval
tool) still dies at a nav — persistence needs the background spine (the HUD/off-with-approval/devtools cases).
The `ml.agent()` PROMISE also dies with the caller's navigated-away context; the run continues in the
background and its result surfaces in the HUD/debug stream, not as that call's return value.
**Runs the user starts are assembled in the WORKER (`sw-run-start.ts`).** The HUD Commander's Send, the chat page's
`agent.start`, and a follow-up or Continue on such a run never pass through the page's own `ml.agent`: a page that
assembled the run could rewrite the task, the toolset and the system prompt before it started (docs/spec/SITE_ACCESS.md,
slice 0). The worker calls the SAME `assembleRun` (run-assembly.ts) a console run does, with `workerMl` (worker-ml.ts)
in place of `window.ml`: its config and capability probes call the worker's functions, and its tool factories are the
page's own factories, which build a tool without touching the DOM, so the descriptors the model sees come from one
definition (`tests/run-start.test.mjs` compares them with the page bundle's, field by field). It then PUSHES the
builtin toolset into the tab, `ADOPT_RUN_NOW` → `ADOPT_RUN` with a `reply` id → `_adoptRun` → `RUN_ADOPTED_NOW`
carrying `pageContext()`. That is the re-adoption above, sent instead of asked for, answered on its own message type
so it never releases a navigation barrier or leaves a page context for a `navigate` to read. The run is then hosted
like any other (`hostRun`), flagged `builtBy: "worker"`: it fans its own lifecycle events on every surface, since no
page-side caller exists to emit them, and its REMOTE tools run in the worker (`sw-local-tools.ts`, the page's own
`run` closure through `executeTool` and `envelopeFrom`), because building them needs the backend's tool list and their
arguments leave the machine. When a turn ends the worker asks the page for the turn's curated answer (a
`RUN_TOOL_IN_PAGE` with `finish`: `endRun` + `runAnswer`, what a page-built run's own caller does) and puts it on the
`agent-result`; a follow-up re-adopts first, so each turn starts with a fresh answer set. A DURABLE RESUME (after an eviction) is driven
by the worker too, and hands the run to the worker (`makeWorkerRun`): it always meets a fresh document, so nothing
page-side is left to own it. A worker-built run's remote tools are rebuilt on demand (`ensureLocalTools`) when this
worker does not hold them, from the server's bundles, kept to exactly the names the run already offers.

**HUD replay-across-nav:** the fresh page's card rebuilds MID-run with its history — the background buffers a
cross-page run's whole debug-event stream per tab (`runReplayBuffer`, populated in `emitStep`/`emitLifecycle`
so the `agent` start is included even when the page-side caller is what fans it live) and, on the
`CONTENT_READY` re-adopt hook, replays it to the destination page; `resetDebug` is suppressed while a run is
live on the tab so the shell's nav-remount doesn't wipe the history (this also keeps a DevTools panel's
sessions across the nav). Verified e2e (`tests/e2e/cross-page.spec.mjs`, incl. a replay test + observing via
the stable fake-LLM).
**Variant B (cross-DOMAIN).** Two gates protect leaving the origin: (1) the run must OPT IN with
**`crossOrigin: true`** (default false — `navTarget` refuses a cross-site URL otherwise), and (2) even then a
NEW cross-origin nav must pass an **interactive consent gate** — a page can't silently send the agent to
another site (prompt-injection exfil). Mechanism: `navigate` is `requiresApproval`, but **same-origin
auto-approves** (`autoApprove` → `"same-origin"` provenance, no prompt) on BOTH loop paths — page-side via
`sameOriginNav(location)`, background-side via `navNeedsConsent` — while a cross-origin nav to an origin NOT
in the run's `consentedOrigins` (seeded with the start origin via `StartRunPayload.pageOrigin`; grown as the
user approves) falls through to the gate. Approving an origin consents to it for the rest of the run (repeat
navs skip). Once approved, it just works mechanically: the content script re-injects on the new site
(`<all_urls>`), so re-adoption + delegation continue there; `crossOrigin` rides on `RebuildConfig` so the
rebuilt tool keeps crossing after a nav, and it's logged in the "agent options" block with a data-carry
caution in the tool description. (v2: an "allow / allow-for-this-run / deny" 3-way + "on-click"
host-permission handling.)
**Durable storage-backed resume:** a background run mirrors its resumable snapshot (`{p, messages, tabId,
sub}`) to `chrome.storage.local` at START and after each step (the host `checkpoint` dep), so an MV3-evicted
run isn't lost. On SW respawn a top-level `hydratePersistedRuns()` reloads in-flight runs into
`bgRuns`/`activeRuns` and marks them in `hydratedRuns` (= INTERRUPTED); `CONTENT_READY` awaits that hydrate,
then a fresh page re-adopting an interrupted run gets `resume:true` on its adopt entry and AUTO-continues it
from the last checkpoint (the `agentRegistry` by-hash resume handle → RESUME_RUN with an empty follow-up).
Storage holds only RUNNING runs (deleted in the run's finally); a run that merely COMPLETED isn't in
`hydratedRuns`, so it re-adopts (for a composer follow-up) but never re-drives. Tested via `__mlEvictForTest`
(an SW-realm-only hook that drops in-memory state + rehydrates, simulating a respawn). Known gap: a run
evicted while idle at an approval gate with NO subsequent page load has no re-adopt trigger, so it resumes
only once the page next loads. Plan + STATUS/HANDOFF: `tmp/cross-page-agent.md`.

**Approval-over-IPC (`__mlApprovals` + `approvalRouting`).** A background-hosted run's privileged gate can
be resolved from OUTSIDE the browser, so an automated driver approves/denies exactly like a human click — the
Playwright harness today, a desktop orchestrator (over `onMessageExternal` / native messaging) later; this is
the control channel for the "one wrapper driving a desktop with delegated subagents over IPC" goal.
`pendingApprovals` (sw-consent.ts) stores `{ resolve, descriptor }` — the descriptor is the serializable
"what's being approved" (`runId`/`seq`/`step`/`tool`/`arguments`/`routing`). Both the origin-authed
`SET_APPROVAL` message and the external channel funnel through ONE `resolveApproval(key, decision)`, so a
decision from either resolves the gate on every surface. The channel is
`globalThis.__mlApprovals = { list(), resolve(key, decision) }`, defined on the **service worker** — reachable
ONLY from the SW realm (`serviceWorker.evaluate` in Playwright; the page main world has no `chrome.runtime`
and can't reach this realm), so it grants a hostile page NOTHING: it's the same unforgeable gate, opened by
code instead of a click. **Opt-in via the `approvalRouting` agent option**: `"ui"` (default — human only; the
channel neither lists nor resolves it), `"both"` (UI shows AND the channel can resolve), `"external"` (channel
only — the UI approve/deny buttons are SUPPRESSED via `awaitingApproval:false`, the gate still blocks). A
module-level `externallyResolvable` guards list/resolve to `"both"|"external"` gates, so a default run can't be
silently approved by an orchestrator that never asked for it. Threaded page→background on
`StartRunPayload.approvalRouting`; logged in the sidebar "agent options" block. Tested in
`tests/e2e/approval.spec.mjs` (approve/deny with NO UI, the opt-in guarantee, and the page-realm boundary).

**Agent runs in the debug sidebar.** `ml.agent` emits its own debug-event kinds
(not `chat`): `agent` (run start: task + model), `agent-step` (a thought OR a tool
call with args/result; `elements` is a **count**, since real DOM nodes can't cross
the window bus — they still reach `onStep`), and `agent-result` (summary + steps +
`hitCap` + `cancelled`). **In-flight rendering:** a tool call emits `agent-step`
**twice** — a `pending: true` START (name + args + best-effort In render, no result
yet) the instant it's about to run, then the DONE (result + Out + approval), sharing a
monotonic `seq`. The sidebar `onDebug` **patches the row in place by `seq`** (immutably —
signals gotcha) instead of appending, so a running step shows a pulsing "running…" until
it fills in. The START is **sidebar-only** — `onStep`/`logStep` fire once, on the DONE
(a pending event has no result). A blocking `confirm()` defers the START's paint until
approved (the case inline approvals will remove — this is the observability half of that
keystone). All share the run's own session
hash (an agent run isn't a `createChat`), so the sidebar renders it as a distinct
"agent" session. It reuses `onStep`'s existing event stream — the tracer was
already there, this just tees it to `emitDebug`. A depth counter (`inAgentRun`)
suppresses `chat*` events while a run is in flight, so the auto-wired `look`
tool's internal `ml.chat` doesn't spawn orphan chat sessions (its result already
shows as the tool step). `agent` also carries the run's resolved `config`
(system prompt, tools, maxSteps, env/vision/systemAppend) for the sidebar's "agent
options" block, and each tool step carries `argIssues` — a minimal page-side
JSON-Schema check (`validateArgs`: required/type/enum/unknown-prop) of the args
against the tool's `parameters`, rendered as a red strip. It is also APPENDED to
the tool result the model sees, so it is what teaches the model the shape it
should have sent — not only a debug decoration. Still not a full validator, but
it does understand a `oneOf`/`anyOf` UNION (checked against its branches when
every branch names a type): reading only `spec.type` meant a union property was
validated as NOTHING AT ALL, which is how `python_exec`'s `tables` — declared
"a source string OR a {name: source} map" — accepted an array, a number and
null in silence. A built-in shipping a complex schema is no longer hypothetical,
so reach for ajv only if one ships something this can't express.
An approval-gated call also carries `approval` (`"readonly"` = auto-approved via
the read-only interpreter · `"user"` = you approved · `"denied"` = you rejected),
shown as a green/red **provenance badge** + a matching left-border outline on the
step. That badge is the slot a future interactive-approval control resolves into.

**Tool render descriptors (two slots).** A tool step carries **two** independent
**serializable `RenderDescriptor`s** (`image`/`code`/`table`/`keyval`/`elements`/`locate`/
`python-in`/`python-out`) — data, never code, since functions can't cross the window bus and
page code must never run in the extension-origin iframe. `descriptorFor` fills each slot from
its **own hook** (no `target` field — the slot IS the hook):
- **In** (a visualization of the *call*) = the `ToolResult.renderIn` a `run()` returned
  (e.g. `python`'s notebook-cell header), else the tool's **`render(input, args)`** method
  (page-side, e.g. `exec`'s pretty JS). The sidebar renders the In block whenever there are
  args *or* a `renderIn`.
- **Out** (a visualization of the *result*) = the `ToolResult.render` a `run()` returned
  (e.g. `locate`'s badged image / `python`'s output — shown in the sidebar but, unlike
  `image`, NOT injected into the model's history), else an auto-derived `image`/`elements`
  from the envelope.
Either slot may be `undefined` → that block falls back to its raw view (args / result). The
sidebar (`RenderPanel`) is a registry keyed by `type` + a default fallback — it owns all UI,
so an unknown type just dumps as JSON. Custom-tool render is defensive (throw → fallback,
never breaks the run). The `agent-step` debug event carries `renderIn`/`renderOut`; the
export mirrors both (`python-in` → mode + input-image sidecar + source; `python-out` → an
image sidecar). A `code` descriptor may set `format: true` (the `exec` tool does)
→ the sidebar beautifies the JS with **js-beautify** before highlighting (bundled
into `sidebar-app` only, from the standalone `js-beautify/js/lib/beautify.js` —
the npm deps are CLI-only). Two sidebar-only code-block display prefs live in
`chrome.storage.local` (like the font scale, not in `MlConfig`): `ml_debug_codewrap`
(wrap ⇄ horizontal-scroll) and `ml_debug_codelines` (a line-number gutter). Both
ride `<html>` data-attributes (`data-codewrap`/`data-codelines`) so every code
block reacts at once; the gutter re-splits highlighted HTML per line (`htmlLines`
reopens spans that straddle a newline — matching `<` first, so a text run like
` searchResults` isn't misread as a `<span>`), and numbers stay aligned even when
a line wraps because each source line is its own flex row.

**The code COLOUR THEME** (Settings → Code blocks → Colour theme; `ml_code_theme`, and the uploaded file in
`ml_code_theme_vscode` as `{name, text}`). ONE stylesheet colours every code block AND the bench editor, because
CodeMirror's tags are mapped onto highlight.js's `hljs-*` classes (`HLJS_STYLE` in cm-editor.ts) rather than given
a palette of their own. Presets are highlight.js's own stylesheets, bundled as text (`src/sidebar/code/code-theme-css.ts`);
the list, the VS Code converter and the `.hljs` colour reader are pure in `src/code-themes.ts`. Four things matter:
- **Surface colours.** Any theme but the default sets `--code-bg`/`--code-fg` on the root (`applyCodeTheme`, prefs.ts),
  read by `.code` blocks and the editor. Without them a dark theme in a light panel drew light tokens on white. The
  default (Atom One) sets neither and keeps the panel's own colours, so it looks exactly as it did.
- **A pair follows the panel**, a single-variant theme (Nord, Monokai, Xcode…) is used as it is either way.
- **The VS Code conversion is approximate, and Settings says so.** A theme colours TextMate SCOPES; each `hljs-*`
  class takes the colour of the scope that best stands for it (`SCOPE_MAP`, TextMate's own precedence: the longest
  matching selector, later on a tie). Parent-scope selectors are skipped rather than applied everywhere, and a theme
  that `include`s another cannot be read on its own. It is stored as SOURCE TEXT and converted on load, so an improved
  converter re-reads old uploads.
- **Nothing from the file reaches CSS verbatim**: hex colours and four font-style words only (tested with injection
  payloads). The file is JSONC — VS Code's "Generate Color Theme From Current Settings" writes comments.
- **A VS Code theme can colour the whole PANEL** (`ml_code_theme_ui`, on by default; presets never do — they carry no
  UI colours, so they keep the default UI). `panelPalette` maps its workbench colours onto the panel's tokens
  (`PANEL_TOKENS`: `--bg`, `--panel`, `--fg`, `--accent`, `--ok`/`--err`/`--warn`, the JSON-tree colours), set inline on
  the root so they beat the light/dark palettes, and all removed when it is off. A token the theme does not define is
  DERIVED from its bg/fg (`color-mix`), never left at our grey; a layer given the same colour as the one under it (One
  Dark Pro's widgets match its sidebar) is derived too, or cards vanish; the accent prefers the link colour over a
  muted `focusBorder`; text on the accent is whichever of black/white contrasts more. While it is on the panel's
  light/dark is the theme's `type`, and Settings → Theme says it does not apply.
- **The editor's selection, current line, cursor and line numbers** come from the theme (`--code-sel`, `--code-line`,
  `--code-cursor`, `--code-lno`); a preset's selection is a faint tint of its own text colour. CodeMirror's base theme
  styles the FOCUSED selection with a longer selector (a fixed `#d7d4f0`), which had out-specified the editor's own
  rule in every theme — the editor's selection selector now matches it.
`tests/code-themes.test.mjs` checks EVERY preset's stylesheet for a background and a text colour; that found two
parsing gaps a sample missed (comments inside a rule, `.hljs` in a selector list).


**A claim of unreachability needs the ABSENCE of evidence, not the presence of a failure**
(`backendStateFrom`, contract.ts). During a 64-second load of a 142 GB model, `/api/ps` answered every poll in
0.4-0.8 ms while the request that triggered the load produced no bytes for the whole minute — and from that one
hanging request the panel concluded the box was down and sent the user to check their Server URL. Anything
proving the box answers (`backendAliveAt`, stamped wherever a reading comes back) now vetoes the claim, and a
load in flight is reported as a load instead. The evidence is a TIMESTAMP, bounded, because stale evidence is
exactly what a box dying looks like. Three writers (the health probe's timeout, a failed run, a failed chat)
go through ONE gate in store.ts, since three separate decisions is how one said "unreachable" beside a live
reading. And the proof of life cannot come from `/api/ps` alone: that poll is gated on the panel being open,
while the banner is shown to everyone — so the health probe, which always runs, stamps it too.

**A failed run offers Retry** (sidebar AND HUD card, for parity with Continue). It is the SAME resume a
step-capped run's Continue sends — by hash, from the stored state, with no follow-up text — so it re-asks the
turn that failed without adding a message. Always safe to offer: a call that errored produced nothing, so the
worst case is failing again. It exists because a failure is usually not about what was asked: the backend
restarting underneath a run answered "Model not found" for a model that was serving a minute earlier and was
listed again a minute later, and the only way forward was to retype something.

## A call's own title

Every tool is given one reserved parameter, `title`: a few words from the model on what THAT call is for. Optional
— a model that writes none has said nothing and nothing is shown. It exists for reading a run back: the arguments
say what ran and the result says what came of it, and neither says what the model thought it was doing, which is
the question anyone investigating a run actually has.

**It is a CLAIM, and is drawn as one** — quoted, never in place of the arguments beside it. Nothing derives it and
nothing checks it against what the call did.

The mechanics, which are the part that can go wrong silently:

- **Injected into the TOOLSET, not into the model-facing `toolDefs`** (`withCallTitle`, ml-agent-run.ts). The
  background run's descriptors are built from the toolset too, so one injection covers both loops; and both the
  loop's `validateArgs` and the panel's argument-issue strip read `tool.parameters`, against which an unannounced
  `title` reads as an unknown property and puts a ⚠ on every call that used it.
- **A schema that declares NO properties is left alone.** An empty `properties` is how this codebase spells "shape
  not specified" and `validateArgs` skips the unknown-property check entirely for it. Adding ours makes it
  non-empty, and a parameterless tool would start telling the model its own arguments were wrong.
- **Taken off the arguments at the single dispatch** (`takeCallTitle`, tool-exec.ts), so a tool is never handed a
  key its own code never declared — several of the DOM tools iterate their args. The step EVENT keeps the model's
  arguments whole, which is the log's standing promise, so the UI reads it from there and nothing was added to
  the wire.
- **The name is RESERVED, loudly.** `defineTool` throws on a tool declaring it (where it is fixable, like an
  unusable tool name), and the signature rejects a literal schema that does, with the sentence spelled as a string
  literal so the diagnostic says what to do. A schema whose keys are not literal cannot be checked that way and
  falls to the throw. `tests/types/call-title.types.ts` is a `@ts-expect-error` file, so tsc fails if the type-level
  half ever stops catching it.

**Where it is shown**: in the tool name's tooltip always, under the tool's own description; inline beside the tool
name only in the reading view and only inside an OPEN group, because expanding a folded run is the gesture that
means "I am investigating" — during a run, one per row is noise. The busy view never draws it inline: a collapsed
row there already carries the value the call returned, which is what a developer is reading. `run.md` puts it in
the step's heading, since that file is the canonical human narrative and is the surface this exists for.

The instruction lives in the SYSTEM prompt (`CALL_TITLE_CLAUSE`), said once, with only a one-line reminder and an
example in each schema: the parameter rides in every tool on every turn, so a sentence per schema is multiplied by
the toolset and re-sent for the length of the run.

## `chat_metadata`: where the user is

`chat_metadata` adds one `user focus:` line when the user is NOT on the agent's own tab, read at the moment of the
call and stamped with it (`as of 11:52:03`), since focus moves. No line means the user is on the agent's page, and the
tool's description says so. The rules are `userFocusLine` (`src/sw/user-focus.ts`, pure and tested); the worker reads the
focused window and its active tab (`src/sw/sw-focus.ts`). Setting: `agentSeesFocus`, default on, in DevTools Settings.

What it may say depends on who can READ the run's results, and every agent run with a tab executes through that
page's own `ml.createAgent`, the chat page's and the HUD's included. So every such run is told only COARSE facts: the
chat page (reading this conversation or not), another tab, or away from the browser. Naming the other tab's site
would hand it to the page the agent runs on, which could start a run just to ask. The FULL detail (site and title,
never a URL, never a private window, the title de-quoted and cut to 80 characters since the site wrote it) is kept for
a run no page can read, which today is none, and a headless agent would be.

The page-hosted loop asks the worker with `USER_FOCUS_REQUEST` → `USER_FOCUS`, answered relative to `sender.tab`,
always coarse; the background-hosted loop calls `focusLineFor` directly. Both reach the one formatter,
`formatChatMeta` (agent-loop.ts), through `ChatMeta.userFocus`.

## Traps: delegated tools and where a run starts

- **A delegated tool has a THIRD outcome, and it is the one that hurts.** `chrome.tabs.sendMessage` to a tab the
  browser has put to sleep in the background neither answers nor rejects — the content script is registered, the
  renderer is simply not running it — so the send sits. A measured run spent 13m57s inside one `pageInfo` and was
  released by the person opening the tab. Every send goes through `delegateSend` (delegate-send.ts), which watches
  the tab while it waits (`page-reachable.ts`): a `discarded` tab is reloaded in place and retried once (it has no
  document, so a reload costs nothing already lost), and a frozen one, which the browser labels as nothing unusual,
  is bounded by a deliberately generous cap. A tab hosting a run is also pinned (`autoDiscardable: false`) and
  released when it ends. And a tab can come back under a NEW id: `chrome.tabs.onReplaced` is the only notice, since
  no navigation commits and nothing is removed, so everything keyed by tab is re-filed there or the run is orphaned
  under an id nothing will send again.
- **A run never starts on a page WE own.** A run that asked for an empty tab has to open some real http(s) page, and
  the three obvious candidates are all wrong: Chrome refuses an extension on `chrome://newtab` and on a top-level
  `about:blank` (an opaque origin, refused even with `<all_urls>` — both checked against the real browser), and the
  extension's OWN page is a PRIVILEGED origin, where the model's `exec` reaches `chrome.storage` and the API key with
  it. So the floor is `AGENT_START_PAGE` (contract-config.ts), an ordinary web page published from `dist-app/`, where
  `window.ml` loads and `chrome.*` is undefined. `MlConfig.agentStartPage` overrides it and a client's own URL beats
  both. The page is exempt from the PWA worker's navigate-to-shell fallback (`src/chat/pwa/sw.js`), or an installed
  copy would answer it with the chat client — a failure only people who had opened the app would ever see.
- **Whether a new tab can be opened is the RUNTIME's answer, not the client's guess** (`capabilities.blankStart`,
  `src/chat/blank-start.ts`). A browser with limited site access will not run the extension on that page, and the
  coarse `site-access` attention code cannot tell you: it asks whether `<all_urls>` is held, so it fires for a
  runtime on "specific sites" whether or not the one page that matters is among them. The capability carries the URL,
  whether it is permitted, and — only while it is NOT — the origins that runtime already holds. That list exists for
  the REMOTE reader, which is why `remoteDescription` (hub-runtime.ts) must never strip it: no client can grant a
  permission on another machine, so the sites it already holds, and its own browser's name for wording the fix, are
  the only actionable things left. ABSENT IS NOT BLOCKED — an older runtime reports nothing here, and refusing to
  start on one that never claimed a problem breaks every run on it. The block applies only where the run would use
  the runtime's DEFAULT page: once a URL is named by the client the question has been answered, and going on blocking
  it makes the way out unreachable.
