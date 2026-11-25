# The JavaScript dialect's page realm — the three questions ruling 102 left unchecked (2026-11-25)

Ruling 102 (`README.md` in this folder, lines 1898-1906) accepted that in a page's MAIN world the page, or an earlier
approved exec, can replace every built-in the evaluator calls, so termination by construction never held for a script
that reads a page. It left three things unchecked and unassigned: whether the worker gives up on a page leg that never
answers; whether the isolated world of approved execs persists between them; and whether the page-side evaluator could
run in the content script's isolated world. This document answers them in that order, with a file and line for every
claim. Two facts come from probes outside the suite, a CDP probe against the bundled Chromium; both are reproduced in
the appendix. Its one finding is in section 2 and is a documentation defect, not a code one.

No product change, no row added to the suite. The rows that already pin what is pinnable are named where they apply.

## 1. A delegated page leg that never answers

The bound is the worker's, it lands in about 18 seconds, and the run continues.

A worker-built run's page call is sent through `delegateSend` (`src/sw/delegate-send.ts:67`), which awaits the tab's
answer inside `watchWhileWaiting` (`src/sw/delegate-send.ts:97`). The watcher asks the browser about the tab every
`TAB_PROBE_MS = 4_000` (`src/sw/page-reachable.ts:31`). A tab that is awake and not frozen is also sent a liveness ping,
answered synchronously by the content script, with `PING_TIMEOUT_MS = 2_000` to answer (`src/sw/page-reachable.ts:32-34`).
The content script shares the renderer's main thread (`src/sw/page-reachable.ts:18-23`), so a page that has taken the
thread over misses the ping. `BUSY_STRIKES = 3` misses in a row are called busy rather than slow
(`src/sw/page-reachable.ts:36`, raised at `:130`): three probes 4 s apart, each ping allowed its 2 s, which is the
constant's own "about 18 s". A frozen tab, or a browser that does not report `frozen`, is never pinged and keeps to the
backstop, `PAGE_SILENCE_CAP_MS = 240_000` (`src/sw/page-reachable.ts:29`); an awake page that is merely slow answers its
pings, so it is never killed for being slow, which is why the cap is generous.

`PageUnreachable` carries one sentence naming the state and the seconds (`src/sw/page-reachable.ts:94-102`; the busy
line at `:97`). What happens next is in its own docstring: "The loop turns it into the tool's result, so the model is
told the page stopped answering rather than the run stopping dead" (`src/sw/page-reachable.ts:78-79`). The run
continues with the tool's result; the renderer stays stuck, and every later call on that tab pays the same wait and
ends the same way until the page recovers.

What the page leg can stop by itself is only a cooperative survey: the run gives every survey an `AbortController`
(`src/agent/run-delegation.ts:273-274`), `runAsync` refuses to resume an aborted generator and races each awaited value
against the signal (`src/readonly-exec/evaluator.ts:1342-1357`). None of that can preempt a built-in that never returns:
the abort would have to run on the event loop the page has taken. The worker's probe is therefore the only bound that
lands for that case, and it does land.

Pinned by `tests/page-reachable.test.mjs:95` ("three unresponsive probes in a row are busy") and its siblings, which
enumerate the crashed, asleep, gone and unadopted verdicts; the end-to-end shape in a real tab is
`tests/e2e/page-health.spec.mjs`. No finding for rule 9.

## 2. Does the isolated world of approved execs persist between them?

Yes, on both mechanisms, for one run in one tab on one document. The spec says otherwise about the CDP one, and that is
this document's finding.

### The user-script mechanism: one world per run, by construction

`runInUserScriptWorld` names its world `wml-${runId}` (`src/sw/sw-isolated-exec.ts:233`) and executes into it on every
call (`:240`). A world belongs to a document; the module's header says the two mechanisms share the page's DOM and
nothing else (`:5-6`), and the retry after a failed expression form refuses to run when the routed document is gone
(`:252`). So two approved execs of one run on one document share every global of that world, including the documented
`state = (globalThis.__mlState ??= {})` (`:159`). `docs/spec/SITE_ACCESS.md:559` states this half correctly: "`state`
persists across calls in the user-script world".

### The CDP mechanism: the code asks for a new world per call, Chrome hands back the same one

`runInCdpWorld` calls `Page.createIsolatedWorld` on every call with `worldName = wml-${runId}`
(`src/sw/sw-isolated-exec.ts:283, 317`) and its own docstring says "created for this call". Measured on the protocol,
the second call with the same frame and name returns the first call's execution context: the same id, the globals
visible across, and a mark set in the first context readable from the second. A navigation gives a new context and the
mark is gone, which is the document boundary the code relies on. Chrome reuses an isolated world by name on a frame,
and the extension asks for the same name every time (`src/sw/sw-isolated-exec.ts:283`).

The repeated `Runtime.addBinding` the second call makes is benign: measured, a second and a fifth `addBinding` with the
same name and execution context name neither throws nor duplicates the binding — one call of the binding fires exactly
one `Runtime.bindingCalled`. So the reuse does not break streaming or the ask channel; it changes what `state` means and
what a previous exec can leave behind.

Finding (rule 9), for the owner of `src/sw/sw-isolated-exec.ts` and of the spec's part 4: `docs/spec/SITE_ACCESS.md:539`
("a CDP isolated world created per call") and `:559` ("`state` persists across calls in the user-script world, not in a
CDP world (a new one per call)") are false on current Chrome. Both mechanisms persist for a run on a document. Two ways
to close it, the owner's to choose: correct the sentences, or make them true by naming the CDP world per call
(`wml-${runId}-${nonce}`), which costs a fresh world per exec and makes `state` there a one-call object as the spec says.

The suite cannot catch the reuse today: its CDP stand-in answers every `Page.createIsolatedWorld` with the fixed
`contextId` 11 (`tests/isolated-exec.test.mjs:397`), so a fresh world and a reused one are indistinguishable to it. The
naming half is pinned: one world id for the run's injections (`tests/isolated-exec.test.mjs:321`) and one `worldName`
per call (`:414`).

### What an earlier exec can leave for a later one

Persistence is a fact until something uses it. Exec 1 runs in the same realm as exec 2's wrapper, and the wrapper calls
that realm's own built-ins before exec 2's source starts: `JSON.parse` on the bindings block
(`src/sw/sw-isolated-exec.ts:108`), which carries the pointer reads sent with the call, the `ml.current` snapshot, the
settings and the member list; `Map` on the reads (`:111`); `Object.freeze`, `Object.isFrozen` and `Object.keys` in
`__freeze` (`:113-114`); `Object.freeze` again on `ml.sh` and the `ml` facade's target (`:127, :149-150`);
`Array.isArray`/`String` in `__stages`; `Error`; `Date.now` in the stream stamp; and the wrapper's `console`. Any of
them can be replaced. The two channel entry points are globals in the same realm and can be replaced as well:
`chrome.runtime.sendMessage` in the user-script route's `ask` (`:238`) and `globalThis.__mlIsoAnswer` in the CDP
route's (`:325`).

What that buys exec 1, concretely: a copy of everything the worker bound to exec 2, by wrapping `JSON.parse`; the `ml`
facade exec 2 is given, by wrapping `Object.freeze` (its target is the facade's target); and the ability to answer
exec 2's channel requests itself, by holding the ask function, which is a forged pointer read or a forged `sh`/`fs`
reply. That is a real crossing: the approval is per source text, and the realm is per run.

What it does not buy is privilege. The worker resolves pointer reads from exec 2's own approved source before the send
and the world only serves the reads it was sent (`src/pointers/named-reads.ts`;
`src/sw/sw-isolated-exec.ts:137-146`); `ml.sh` and `ml.fs` are bound only when the routing says exec 2 names them
(`:53, :398`); and every request that reaches the worker on the channel is judged per call by the call's own
server: `ml.fs` as read ops only, within its own count and forwarded to the run's session reader
(`src/sw/iso-channel.ts:111-118`), `ml.sh` by name and arity and then by the worker's policy or ask path
(`src/sw/iso-channel.ts:152-158`). `ml.current` is a deep-frozen snapshot taken for the call, not the live page
(`src/sw/sw-isolated-exec.ts:114, 398-405`), and `ml.settings` a fresh copy per access (`:156`). A poisoned world can
therefore make exec 2 do things its approval card did not show, within exactly the grant its card implied. Worth
stating in the spec, since "approval is per call" and "the realm is per run" are different promises.

## 3. Could the page-side evaluator run in the content script's isolated world?

It already does, on a hidden page. `injected-isolated.ts` is the same bundle as `injected.js`, from the same
`./injected` import with a marker imported first (`src/injected-isolated.ts:9-10`, `src/page-world-isolated.ts:5`), and
`injectRunTools` puts it into the content scripts' world with `chrome.scripting.executeScript({ world: "ISOLATED" })`
(`src/sw/sw-presence.ts:18-19, :193-200`). The marker changes exactly three things: closed shadow roots are read with
`chrome.dom.openOrClosedShadowRoot` where the main world captures them at load (`src/injected.ts:77-78`), the page's
world is told nothing of the run's tools (`src/injected.ts:679`), and the channel to `content.js` is attached in-process
instead of being handed over the page's window (`src/page-channel.ts:120`). The dialect evaluator is the same code, run
against that world's `document`.

So the question is why it is not also the route on an approved page. Three things stand in the way today, in order of
weight:

1. The page owns the run. On an approved page `window.ml` lives in the page's MAIN world, registered for the approved
   origins only (`src/sw/sw-presence.ts:18-19, :66-70`), and a run the page starts runs its page tools there: the survey
   is evaluated in the page's realm with the page's `document` and `window.ml` (`src/agent/run-delegation.ts:285-287`).
   Moving the evaluator alone into the content script's world leaves the loop and the toolset in the page and adds a
   world crossing to every survey; moving the whole run takes `window.ml` away from the page it belongs to.
2. What a survey reads changes. An isolated world shares the DOM and nothing else, so a survey there sees the same
   tree, attributes and text, but not the page's JavaScript state: expando properties on elements, accessors the page
   installed, custom-element instance properties and page globals are not there. The hidden-page path lives with this
   because that run could not touch the page otherwise; on an approved page it would change what an existing survey
   returns.
3. Where the bundle loads. `injected.js` is registered only for origins that may use `window.ml`
   (`src/sw/sw-presence.ts:18-19, :66-70`) and is ~1.0 MB; the content script on `<all_urls>` is ~22 KB
   (`manifest.json` `content_scripts`). Running the run tools in the content-script world for a run is already how the
   hidden path works, so the cost is per run rather than per page — the weakest of the three.

What the move would gain is the one thing the main world cannot give: the content script's intrinsics. Neither the page
nor an approved exec can touch another world's `Object`, `Array`, `String`, `JSON`, `RegExp` or `Promise` (execs run in
their own world, `src/sw/sw-isolated-exec.ts:233, 283`), so an evaluator running there would have its built-ins intact
and the step budget would bind a page read again, which is the construction argument ruling 102 says only the worker
realm keeps.

What the page could still do to it is everything that acts on the shared renderer rather than on JavaScript:

- Block the thread. The isolated world runs on the same main thread, so a page's own long task or infinite loop stops
  the evaluator exactly as it stops the main-world one. The bound is the worker's probe (section 1), not the realm.
- Make layout and DOM work slow. The budget charges evaluator steps and the elements a survey walks
  (`src/readonly-exec/limits.ts:39-47`), not the browser's own style and layout work, so a page can make every DOM
  call slow without spending a step.
- Run its code inside the survey's own DOM operations. Setting an attribute or text a custom element observes invokes
  the page's reaction synchronously, in the page's world, from inside the isolated world's call.
- Navigate, crash the renderer, or change the DOM between reads, which every page read has to live with today.

Verdict: the move is not a switch. It restores halting by budget for a survey that does not need page JavaScript state,
and it does not bound the page's own thread work. Which of the two arguments it is worth making true is the owner of
the page realm's call; what this check can say is that it costs items 1 and 2 above and buys the intrinsics, not
preemption.

## What a row can pin

Section 1 is pinned by `tests/page-reachable.test.mjs:95` and its siblings, with the arithmetic as constants at
`src/sw/page-reachable.ts:29-36`. Section 2's naming is pinned by `tests/isolated-exec.test.mjs:321` and `:414`; the
reuse itself is Chrome's, and an e2e row could pin it inside the extension (two approved execs, a global set by the
first, read by the second) — it would pass on today's code and fail the day the CDP world is named per call, so it
belongs with that repair, not before it. Section 3's three differences are pinnable in the injected-bundle tests if a
decision is made to keep them; no row is added here because nothing changes.

## Appendix: the probes

Both run against the bundled Chromium with the repo's Playwright, outside the extension, one page. The world name, the
frame and the flag are the three values `src/sw/sw-isolated-exec.ts:317` sends.

Reuse:

```js
const cdp = await page.context().newCDPSession(page);
const { frameTree } = await cdp.send("Page.getFrameTree");
const mk = async () => (await cdp.send("Page.createIsolatedWorld",
    { frameId: frameTree.frame.id, worldName: "wml-run1", grantUniveralAccess: false })).executionContextId;
const a = await mk(), b = await mk();
await evalIn(a, "globalThis.__mark = 'from-a'");
// b sees "from-a"; a === b; after page.goto a third mk() returns a new id with no mark.
```

Output: `{"first":5,"second":5,"sameContext":true,"bSeesMark":"from-a","aSeesMark":"from-a","bIsWindow":true}` and
`{"afterNavigation":8,"newWorld":true,"cSeesMark":null}`.

The repeated binding: with `Runtime.enable` on, one `Runtime.addBinding` before the world's creation, a second after it,
and three more before a third creation, one call of the binding fires exactly one `Runtime.bindingCalled`, and the three
`addBinding` calls after the first do not throw. Output: `{"sameContext":true,"afterTwoAddBindings":1,"afterFiveAddBindings":1}`.
