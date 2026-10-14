# Spec: consuming a page's WebMCP tools (decided 2026-10-14)

**Status: DEFERRED, not built.** It slots after step 2 of the Order in [SITE_PRESENCE.md](SITE_PRESENCE.md) (presence in
storage, the main-world content script, the MessagePort), which it needs. **Tracked draft:** WebMCP, W3C Web Machine
Learning Community Group "Draft Community Group Report", 13 October 2026, source commit `eada13b` of
`webmachinelearning/webmcp` (not Standards Track; Chrome origin trial M149 to M156, flag `#enable-webmcp-testing`).
**Rule: when the draft changes, this spec is updated first**, then the adapter; a quoted name below that no longer
matches the draft is a defect in this file.

Framing from the owner: design nothing new. WebMCP is what pages already standardise for "a page offers tools to an
agent", so window.ml adopts its shape as it is and only CONSUMES it, the way `ml.dynamicTools`
(`src/ml/dynamic-tools.ts`) wraps OpenWebUI's server tools. Anything WebMCP defines is referenced, never redefined.
What this file adds is the short list in section 3, each rule forced by the existing security model.

## 0. Blocker: can an isolated-world content script see the page's registrations?

Not known. The draft says nothing about extensions beyond defining a "browser agent" that may be hosted "via an extension
or plug-in" and not prescribing how tools reach it (5.2: it "does not run JavaScript on the page" and gets an
implementation-defined observation). `executeTool` takes a `RegisteredTool` carrying a `Window`, so the caller must be
script with a handle on the document. Run this in Chrome 149 or later with `chrome://flags/#enable-webmcp-testing`
enabled, as a content script declared once with `"world": "ISOLATED"` and once with `"world": "MAIN"`, on a page served
over https or localhost (the API is `[SecureContext]`):

```js
// probe.js, document_idle. Log with the world in the prefix.
const w = chrome.runtime ? "ISOLATED" : "MAIN";
const mc = document.modelContext;
console.log(w, "modelContext:", typeof mc, mc && mc.constructor && mc.constructor.name);
if (mc) {
  // The page (main world) registers one tool before this runs, e.g. name "probe_echo", execute: async (i) => "ok:" + i.x.
  mc.getTools().then(async (tools) => {
    console.log(w, "getTools:", tools.map((t) => t.name));
    if (!tools.length) return;
    try { console.log(w, "executeTool:", await mc.executeTool(tools[0], { x: 1 })); }
    catch (e) { console.log(w, "executeTool threw:", e.name, e.message); }
  });
  mc.addEventListener("toolchange", () => console.log(w, "toolchange seen"));
}
```

Record the five outputs (type, tool names, execute result or error name, `toolchange`, same under `Permissions-Policy:
tools=()`). The answer decides where the adapter lives:

| Answer | Where the adapter lives |
| --- | --- |
| Isolated world sees the page's tools and `executeTool` resolves | Adapter is a plain isolated-world content script: reads `getTools()`, calls `executeTool()`, patches nothing in the page. Preferred. Presence step 2 is then needed only for the MessagePort to the worker. |
| Sees the object, but `getTools()` is empty or `executeTool` throws `NotFoundError` | Reads work only from the page's own origin and world. Adapter moves to the main-world content script (SITE_PRESENCE step 2), which calls the same two methods and hands results over the port. Still no prototype patch. |
| `document.modelContext` is `undefined` in the isolated world | Same as the row above if the main world has it. Only if the main world also fails is wrapping `registerTool` left, which is detectable (identity, `toString`) against [detection-surface.md](../dev/detection-surface.md); then the feature waits for an extension-facing API. |

## 1. What we consume

Verbatim from the draft's WebIDL (names are the draft's; section numbers are not relied on):

```
partial interface Document { [SecureContext, SameObject] readonly attribute ModelContext modelContext; };
interface ModelContext : EventTarget {
  Promise<undefined> registerTool(ModelContextTool tool, optional ModelContextRegisterToolOptions options = {});
  Promise<sequence<RegisteredTool>> getTools(optional ModelContextGetToolOptions options = {});
  Promise<DOMString> executeTool(RegisteredTool tool, optional object inputObject,
                                 optional ModelContextExecuteToolOptions options = {});
  attribute EventHandler ontoolchange; attribute EventHandler ontoolactivated; attribute EventHandler ontoolcancel; };
dictionary ModelContextTool { required DOMString name; USVString title; required DOMString description;
  object inputSchema; required ToolExecuteCallback execute; ToolAnnotations annotations; };
dictionary ToolAnnotations { boolean readOnlyHint = false; boolean untrustedContentHint = false;
  boolean consequentialHint = false; boolean debugging = false; };
callback ToolExecuteCallback = Promise<any> (object inputObject, ToolExecuteCallbackOptions options);
dictionary ToolExecuteCallbackOptions { required AbortSignal signal; };
dictionary ModelContextRegisterToolOptions { sequence<USVString> exposedTo; AbortSignal signal; };
dictionary ModelContextGetToolOptions { sequence<USVString> fromOrigins; };
dictionary ModelContextExecuteToolOptions { AbortSignal signal; };
dictionary RegisteredTool { required DOMString name; DOMString title; required DOMString description;
  object inputSchema; required Window window; required USVString origin; ToolAnnotations annotations; };
```

- **Registration** is the page's job and happens in its main world. We never call `registerTool`.
- **Names:** 1 to 128 characters of ASCII letters, digits, `_`, `-` and `.`. A page's registered name can therefore be
  unusable as a `window.ml` tool name (see the mapping).
- **Unregistering** is aborting the `signal` the page passed at registration; there is no `unregisterTool`. We see it as
  a `toolchange` event and a shorter `getTools()`. An abort does not cancel a running `execute`.
- **Listing:** `getTools()` with no options returns the document's own tools (and allowed descendant frames). We pass no
  `fromOrigins` (section 4).
- **Calling:** `executeTool(tool, input, { signal })` resolves with a string, the JSON of the callback's result. Our
  `AbortSignal` is `ABORT_TASK`'s.
- **Events:** `toolchange` re-lists. `toolactivated` and `toolcancel` fire in the page, which is a signal to it (3.3).
- **Policy:** access is gated by the policy-controlled feature `tools`, default allowlist `'self'`. A site that sets
  `Permissions-Policy: tools=()` gets no tools from us either.
- **Annotations** are the page's own claims: read for display only (3.4).

| WebMCP | window.ml (`MlTool`, `defineTool`) | Note |
| --- | --- | --- |
| `name` | `name` | Mapped, see 3.6. The original is kept for display and for the call. |
| `title` | the card and transcript label | `defineTool` has no `title` field. Not the reserved call-title parameter below. |
| `description` | `description` | Delimited and marked as the site's (3.6). |
| `inputSchema` | `parameters` | Both JSON Schema. A property named `title` is refused by `defineTool` (reserved call title): rename or refuse the tool. |
| `execute(input, { signal })` | `run(args)` | Reached only via `executeTool`; `run` returns the string and its page-writable label. |
| `annotations.readOnlyHint` | none | Never sets `requiresApproval` (3.4). |
| `annotations.consequentialHint` | the card's warning line | Display only; it can add a warning, never remove one. |
| `annotations.untrustedContentHint` | none | Ignored: results are page-writable regardless (3.3). |
| `RegisteredTool.origin` | the tool's target origin | Must equal the tab's origin, else the tool is dropped. |
| result string | `string` result | Not a `@tool:` value (3.3). |

## 2. The adapter

A new `src/ml/` or `src/sw/` module beside `dynamic-tools.ts`, in its spirit: the list is read at run start and on
`toolchange`, each entry becomes a tool whose target carries `via: "page"`, the origin and the original name, the way
`RemoteToolTarget` does today. The model's call goes: gate, worker, relay to the content script, `executeTool`, result
back as text. The page holds the truth, so after a worker restart the list is re-read, never cached. A tool that appears
mid-run is announced to the model, not silently added. Declare any module-level list with `defineState` (realm `page`).

## 3. What window.ml adds

Seven rules. Each is forced by an existing model, named in the last column.

| # | Rule | Reason | From |
| --- | --- | --- | --- |
| 1 | Feature-detect only. No polyfill, no `registerTool` call, no shim installed so that a page can use WebMCP. | A polyfill is a mark we left in a page that may be hidden, and makes window.ml a provider of a standard. | [SITE_PRESENCE.md](SITE_PRESENCE.md) |
| 2 | A hidden origin offers nothing: no listing, no call, no answer. | Reading is silent, but a call runs page code and fires `toolactivated`, which tells the page an agent is there. | [SITE_PRESENCE.md](SITE_PRESENCE.md), [detection-surface.md](../dev/detection-surface.md) |
| 3 | A visible origin needs `use` approval before the first call; a listing alone is allowed from presence. | The first call reveals the agent. | [SITE_ACCESS.md](SITE_ACCESS.md) |
| 4 | Every call is gated with the literal arguments on the card. `readOnlyHint` never skips it. `autoApproveReadonly` never applies to a page tool. | The hint is declared by the page the gate defends against. | [site-access.md](../dev/site-access.md) |
| 5 | A result is labelled page-writable, shown to the model as the site's, and never becomes a `@tool:` value other tools treat as trusted. | `execute` runs in the page's main world; the draft says agents' models treat tool results as trusted. | #652, [detection-surface.md](../dev/detection-surface.md) |
| 6 | Arguments never carry a `@tool:` pointer value or another origin's content. A pointer resolves only if its value came from the same origin, else the call is refused before the gate. | The page sees and may log every argument (the draft names over-parameterisation). | [SITE_ACCESS.md](SITE_ACCESS.md) |
| 7 | Names are namespaced, e.g. `site_<n>_<name>` with `<n>` per origin and run. The model sees descriptions in a block marked as the site's, capped in length. A page tool can never shadow a builtin; a name not in the registry is the site's. | `toolNameError` is stricter than the draft (identifier, no `-` or `.`). Descriptions are an injection surface. | Q18 in [SITE_ACCESS_SLICE3.md](SITE_ACCESS_SLICE3.md), `src/pointers/token-id.ts` |

Further decisions that follow from these:

- **Cross-origin and frames.** Top document only. We never pass `fromOrigins`, so a frame's tools are not listed, and a
  tool whose `RegisteredTool.origin` differs from the tab's is dropped.
- **Start card.** Page tools get their own line under the builtin table, in the registry's terms: "N tools offered by
  `<origin>` (not window.ml's): <titles>". The card's existing caveat "tools as the site's page provides them" covers
  them, and each tool's first call has its own approval card, never a blanket start approval. Wording needs owner
  approval before it ships (new strings).
- **Cancellation.** `ABORT_TASK` aborts the `executeTool` signal. A page that ignores it is not stopped; the run reports
  the result as not received.
- **Size.** Description and schema are length-capped before the model sees them; the cap is a budget line in
  [PROMPT_BUDGET.md](PROMPT_BUDGET.md).

## 4. Conformance notes

What we do NOT implement, on purpose:

- **Declarative tools** (`<form toolname tooldescription>`, `toolautosubmit`, `SubmitEvent.agentInvoked`). Only in an
  explainer, not in the draft; the draft leaves open whether `getTools` reaches them. We pick them up only if they appear
  in `getTools()`.
- **`exposedTo` and `fromOrigins`.** Cross-origin tool sharing; unneeded until a real site needs a frame's tools, and
  then only with a per-origin approval.
- **Tool discovery without a visit** (service-worker doc). Needs a visit under our model.
- **Providing tools** (a page using `ml.defineTool` and exposing it to WebMCP agents). Out of scope.

What the draft leaves to the "browser agent", and so to us:

- **Consent.** The draft has no per-call consent; `consequentialHint` only lets an agent ask. Ours is the gate (3.4).
- **Observation.** The draft does not prescribe how tools reach the agent. Ours is the relay and the MessagePort.
- **Trust in annotations.** Treated as untrusted display text (3.4).

## 5. Tests a future PR must carry

Red-team, in `tests/redteam.test.js` and `tests/e2e/site-access.spec.mjs`, each failing first (the `redteam` skill):

- A hidden page that registers tools and posts every page-started message type gets no answer, no `toolactivated`, and
  no `executeTool` call.
- A visible page without `use` approval gets no call.
- A tool with `readOnlyHint: true` still raises the gate; its card shows the arguments verbatim.
- A page tool named `exec`, `click`, `python_exec` or any builtin never resolves to the builtin or shadows it.
- A result containing `@tool:` text, a fake `console (page-writable):` line or a fake approval is shown labelled and
  never promoted to a pointer value.
- A call whose arguments contain a pointer from another origin is refused before the gate and before any page code runs.
- A tool registered after the run started is announced, not silently callable; one aborted mid-run fails cleanly.
- A frame's tools are never listed; a `RegisteredTool` with a foreign `origin` is dropped.
- A description of 100 kB is capped; one imitating a system message appears only inside the site block.
- `Permissions-Policy: tools=()` yields no tools.

Plus an e2e fixture page registering tools with the real API under the flag (`document.modelContext.registerTool` with
an `inputSchema`, an `execute`, an abort `signal` and each annotation), skipped where the flag is unavailable; and an
upgrade test that an install without this feature behaves as before. The section 0 probe becomes a test whose recorded
answer pins the adapter's location.

## 6. Sources

- WebMCP draft, 13 October 2026: https://webmachinelearning.github.io/webmcp/ (source:
  https://github.com/webmachinelearning/webmcp, `index.bs` at `eada13b`).
- Chrome, imperative API: https://developer.chrome.com/docs/ai/webmcp/imperative-api (updated 2026-09-21).
- Declarative explainer: https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md
- Implementation status: https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md
- Research with sources: `tmp/WEBMCP_RESEARCH.md` (local, not committed).
- Related: [SITE_PRESENCE.md](SITE_PRESENCE.md), [SITE_ACCESS.md](SITE_ACCESS.md),
  [SITE_ACCESS_SLICE3.md](SITE_ACCESS_SLICE3.md), [site-access.md](../dev/site-access.md),
  [detection-surface.md](../dev/detection-surface.md), `src/ml/dynamic-tools.ts`.
