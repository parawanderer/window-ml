# Artifacts: the spike's findings

The four open questions of [ARTIFACTS.md](../../spec/ARTIFACTS.md), measured on 2026-10-24 before any of phase 1 is
built. Each answer says what was measured, where the probe lives, and what it changes in the spec.

## The answer in one paragraph

The evaluator belongs in a **worker the sandbox frame starts from a blob**, not in the frame itself. Every CSP the
spec proposed works for what CSP governs, but three routes leave any window whatever the CSP says: a `<link
rel=preconnect>`, WebRTC's STUN packets, and `top.postMessage`. A dedicated worker has none of the three, and the
nine network routes a worker does have all stay shut under the sandbox CSP. The read-only evaluator already runs
without a DOM (it does in the service worker today), bundles to 55 KB, starts in about 3 ms there, and needs no new
construct to give an artifact writable state, a writable view and event handlers. So the frame is reduced to a
renderer that applies a sanitized view, and an escape of the evaluator lands somewhere with nothing to reach.

## Q1. The second wall

**Measured** by `tests/e2e/artifact-wall.spec.mjs`: a sandbox page (`fixtures/artifact-wall/probe.js`) runs one
route per frame, UNMEDIATED (it stands for an escaped evaluator), against a server that counts HTTP hits, bare TCP
connections and UDP datagrams. Each variant is a copy of the built extension with its manifest rewritten, so the real
manifest is untouched. Chromium's local-network checks are off for the run: the server is on loopback, and those
checks would refuse loads that CSP lets through to a public host.

| Route | Today | Sandbox CSP + `default-src 'none'`, `img-src data:` | + the embedder's `frame-src 'self'` |
| --- | --- | --- | --- |
| The frame navigating itself: `location`, meta refresh, a link's click, via a `data:` or `blob:` page | leaks | leaks | blocked |
| Stylesheet, `@import`, `@font-face`, video, audio, prefetch, preload | leaks | blocked | blocked |
| `img`, CSS background, fetch, XHR, beacon, WebSocket, EventSource, iframe, srcdoc child, object, script, worker, form, popup, top navigation, `<a ping>` | blocked | blocked | blocked |
| `<link rel=preconnect>` (a TCP connect; a real hostname carries data out through DNS) | leaks | leaks | **leaks** |
| WebRTC STUN (UDP, outside `connect-src`) | leaks | leaks | **leaks** |
| `top.postMessage` (the frame's top is the site, under the in-page sidebar) | leaks | leaks | **leaks** |

- **`frame-src 'self'` on the embedder works**, for every route of self-navigation, including through a `data:` or
  `blob:` page. The spec's "to be verified" is verified.
- **No CSP directive governs the last three.** They need a window: a document to put a `<link>` in, the
  `RTCPeerConnection` constructor, a `top`.
- **A dedicated worker started from a blob has none of them.** Its scope has no `RTCPeerConnection`, `document`,
  `top`, `parent` or `open`, and fetch, XHR, WebSocket, EventSource, `importScripts`, dynamic `import()`, a nested
  worker, `FontFace` and WebTransport all reached nothing. It needs one more directive in the sandbox CSP,
  `worker-src blob:` (without it the worker does not start).

**What it changes in the spec.** The sandbox CSP becomes `sandbox allow-scripts; default-src 'none'; script-src
'self'; worker-src blob:; object-src 'none'; connect-src 'none'; img-src data:; frame-src 'none'; base-uri 'none';
form-action 'none'`, the extension pages gain `frame-src 'self'` (the mermaid frame is `'self'` too), and the
evaluator runs in the frame's worker. The frame's own window runs only our renderer, which applies a view the
sanitizer has passed, so the three window routes are reachable only by a bug in code we wrote, not by anything a
model wrote. The test asserts the exact set of routes that leak under each variant: a route closing or opening is a
failure that says which.

## Q2. The evaluator in a sandbox page

**Measured** by the last test of `artifact-wall.spec.mjs`: `fixtures/artifact-wall/eval-worker.ts` wraps
`evalReadonly` as a worker body, the spec bundles it with esbuild, and the probe frame starts it from a blob under
the wall's CSP.

| | |
| --- | --- |
| Bundle | 55 KB minified, 18 KB gzipped: the evaluator 24.6 KB, the parser 10.1 KB, the policy 7.3 KB, regex costing 4.4 KB |
| Dependencies | `readonly-exec/` only, plus `table-brand`, `effects` and `output-clip` (under 1 KB together); no `chrome.*` |
| Start | about 3 ms from `new Worker` to ready |
| A todo filter over `state`, an `ml.current` reader | 0.2 to 1.6 ms each |
| `fetch(…)`, `globalThis`, `self` | refused by the dialect, before the worker's own wall is reached |
| A script that spends the whole 3M-step budget | refused after 178 ms |

The evaluator already ran without a document (the worker realm, `sw-readonly.ts`), so nothing had to change for it
to run here. One thing to fix in the real bundle: minification renames the error classes, so a refusal reads `k:
'fetch' is not available`; the build needs `keepNames`, or the frame must not print `constructor.name`.

## Q3. The realm's shape

**Prototyped** on the `Evaluator` itself, the way `evalPolicy` builds the policy realm (scratch at
`tmp/spike-q3-realm.ts` in the spike's clone, not committed: it reaches the private `fuel` and `ownedCopy`, which the
real realm replaces with an API).

- **Ownership extends without a new rule.** The dialect lets a script write only what it built. `state` and `root`
  handed in as `ownedCopy` copies are the script's: field writes, `push` and building the tree all work, and the host
  reads the copies back after the run. Handed in as plain globals they are refused, which is the right default.
- **`root` as plain data needs no new method kind.** A view tree of `{ tag, attrs, text, children, on }` is ordinary
  data the script owns; the host diffs it after each run and sends it through the sanitizer to the frame. A
  DOM-like facade would need an identity-registered receiver with its own allowlist, as `ml.answer` has.
- **Handlers are the script's own arrows, called later.** A script returns them, or stores them in the tree (`on: {
  click: () => … }`), and the host calls each with `callOwn`, which already exists for policies. Closures persist
  across events, since the evaluator lives as long as the worker.
- **A budget per event works**: resetting the fuel before each call, an event over its budget is refused and the next
  one runs.
- **To build**: a public `refuel(n)` (the refusal still names the start budget); a ROLLBACK per event, since a refused
  handler's partial writes to `state` survive today (the host snapshots `state` before each event, as `ml.answer` has
  its checkpoint); and a function-to-id map when the view crosses to the frame, since a function cannot be cloned.

## Q4. What models write

**Measured** by [q4/](q4/): `ask.mjs` puts one prompt to each model, the artifact format and the dialect's rules as
a tool description would state them, under two shapes of `root`. `grade.mts` (`node --import tsx
docs/plan/artifacts/q4/grade.mts`) parses every script with the dialect's own parser. It runs each `data` artifact
in the Q3 realm, with `ml.current` and a CSV pointer stubbed, fires two rounds of events at every handler it
registered, and checks the drawn view for the right answer. The raw replies and `grades.json` are kept beside them.

- **Tasks**: a todo list shared with the person; a Python figure from a pointer, with the three wettest months and
  the yearly total computed from a CSV pointer; a panel over `ml.current` (messages by role, the last five tool calls,
  the longest message).
- **Shapes of `root`**: `data`, the view as a plain tree the script writes (Q3), and `dom`, a DOM-like element facade
  with `querySelector`, `addEventListener` and `root.create`. The second facade does not exist, so its scripts are
  only parsed, and the DOM methods they call are listed against what it promised.
- **Panel**: DeepSeek v4 pro, Gemini flash, Claude Sonnet 5.5, Kimi k3 and the local qwen3.6:35b. GPT-6.1 was asked
  and is missing: OpenRouter refused every call ("could not verify available credits"), twice.

The `data` shape, run, with the view checked for the right answer:

| Model | Todo | Figure | `ml.current` panel |
| --- | --- | --- | --- |
| Kimi k3 | right | right | right |
| Claude Sonnet 5.5 | right | refused: `Number.isNaN` | right |
| DeepSeek v4 pro | refused: `Math.random` (for an id) | right | right |
| Gemini flash | right (one handler refused `Math.random`) | right | refused: the thousands-separator regex |
| qwen3.6:35b | refused: a function declaration and `for(;;)`, both stated as unavailable | not valid JSON | ran, counted every role 0 |

- **The four hosted models got 9 of 12 right, and all three misses are small gaps in the dialect**, not in how the
  models read it: `Math.random`, `Number.isNaN`, and `riskyRegex` refusing `/\B(?=(\d{3})+(?!\d))/g`, whose repeated
  group holds only a fixed count and cannot backtrack without end. With those three, 12 of 12.
- **The rules as stated were followed.** Across 30 artifacts, only the local model wrote a construct the prompt named
  as unavailable. What it gets back on a refused write is what repairs it, so the test render on write (ARTIFACTS.md,
  "Writing and editing") is load-bearing for small models.
- **The `dom` shape parsed 13 of 15.** Its refusals were array destructuring in a `for…of` head (`for (const [role, n]
  of Object.entries(counts))`, Sonnet) and numeric keys in an object literal (`{ 1: … }`, qwen). Only one model reached
  for a DOM method the facade did not promise (`getElementById`).
- **Both shapes are writable by models.** The `data` shape is the one measured running, needs no new receiver kind in
  the dialect, and is what a worker can hold anyway, since a worker has no DOM: a `dom` facade would be a mirror tree
  in the worker with methods over it. Phase 1 takes the `data` shape; a `find(selector)` helper over it is the first
  thing to add if models ask for one.

**The dialect additions this finds**, each a dialect change under the rule for extending it (adversarial tests and a
re-check of the whole contract), scoped to the artifact realm where a reason exists to keep the others as they are:

| Addition | Seen | Note |
| --- | --- | --- |
| `Math.random()` | 2 of 4 todo lists, for ids | not a leak; refused today because a survey should be repeatable, which an artifact need not be. Or offer `ml.id()` |
| `Number.isNaN`, `isInteger`, `isFinite` | 1 figure, 1 `dom` figure | pure statics; plausibly every realm |
| array destructuring in a `for…of` head | 1 | the arrow-parameter form already works |
| numeric keys in an object literal | 1 | |
| `riskyRegex` passing a group with only fixed counts | 1 | a refinement of the check, not a loosening of the rule |

**Done 2026-10-24, in every realm:** the last four rows. `Math.random` waits for the artifact realm (it breaks the
dialect's contract property 5, no randomness, which every other realm keeps). Re-graded with `grade.mts` on the same
replies: the hosted models' `data` artifacts went from 9 of 12 right to 11 of 12 (Sonnet's figure, Gemini's current
viewer), the one left DeepSeek's `Math.random`; the `dom` shape parses 15 of 15, from 13 (Sonnet's `for…of`, qwen's
keys). The Python dialect's regex check was ported the same day, and building its parity found three exponential
escapes there, closed in the fork (`docs/spec/PYTHON_DIALECT.md`).

## The estimate, revised

The spike answered the questions that could have changed the design, and one did: the evaluator moves into a worker
in the frame. The plan for phase 1 (ARTIFACTS.md, "Order"), by part:

| Part | Hours |
| --- | --- |
| The frame: CSPs (the test exists), the blob worker, a renderer from a sanitized view tree, events forwarded to the worker | 6 to 9 |
| The artifact realm: `state` and `root` adopted, `refuel`, a rollback per event, handler ids across the boundary, `ml.current` and pointers | 4 to 6 |
| The five dialect additions above, with their adversarial tests (four done 2026-10-24; `Math.random` with the realm) | 4 to 6 |
| The `artifact` tool, the store, versions, state kept across code rewrites | 6 to 9 |
| `![…](@artifact:<id>)` with `{side}`/`{collapsed}`, live embeds, a snapshot per answer | 5 to 8 |
| `ml.artifact(<ref>)` from `exec`, a test render on write | 3 to 5 |
| The red-team pass | 3 to 4 |
| **Phase 1** | **31 to 47** |

That is a little above the 26 to 44 before the spike: the worker split adds the renderer and the event forwarding,
and the dialect gaps are now known rather than guessed. The one estimate on record (`docs/vitals/estimates.md`) came
in at under a third of its figure, so read this as an upper bound.
