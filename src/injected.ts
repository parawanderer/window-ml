// This runs in the "Main World" (same as the page JS)

import type { MlApi } from "./contract";
import type { DerefValue } from "./contract-pointers";
import type { MlHistory } from "./contract-chat";
import type { MlTool, MlAgentHandle, MlAnswer } from "./contract-agent";
import type { AnswerMedia } from "./contract-render";
import type { RebuildConfig } from "./contract-messages";
import { htmlToMarkdown } from "./html-to-md";
import { mlPipe } from "./text-pipe";
import { truncate, elPath, describeSkeleton, queryAll, selectorError, viewportRect, jsonShape, joinShapes, jsonValue, shadowHostReport, clickSelector, elLine, isCurrentPage, typeFromExtension } from "./dom";
import { tableFromDelimited, tableShape, asTable } from "./table-data";
import { isTable } from "./table-brand";
import { makeAnswerFacade } from "./answer-set";
import { accessibleName, roleOf, ariaState } from "./a11y";
import { HUD_HINT, HUD_PROSE_PROGRESS, HUD_PROSE_QUIET, askAboutTask } from "./prompts";
import { pageContext, resolvePoint, resolveBox, agentState, mlRange } from "./util";
import { suspiciousChars } from "./security";
import { emitDebug, sessionRegistry, agentRegistry, handleRegistry } from "./bus";
import { makeDomTools } from "./tools";
import { pipeStages } from "./token-pipe";
import { makeBackgroundTaskPromise } from "./bridge";
import { makeDynamicTools } from "./dynamic-tools";
import type { DynamicToolNamespace } from "./dynamic-tools";
import { renderArgs, logStep } from "./approval";
import { captureVerify } from "./builtin-tools";
import { currentAnswer, currentDeref, currentServerAllow, currentHasTool } from "./tool-exec";
import { installToolDelegation, registerRun, endRun } from "./run-delegation";
import { DerefText } from "./ml-agent";   // run-control object (createAgent/agent) + page-loop same-origin auto-approve predicates
import { models, serverTools, execServerTool, info, capabilities, getModel, embed, config, setModel, ps, unload } from "./ml-server";
import { defineTool, lookTool, locateTool, clickTool, typeTool, navigateTool, fetchTool, pythonTool, chatMetaTool } from "./ml-tool-factories";
import { read, screenshot, _shotBox, _stitchFullPage, _resolveVisionModel, _modelSees, _nativeLookTool, _imageToDataUrl, _fetchImageBase64 } from "./ml-vision";
import { mlFetchCache } from "./ml-fetch-cache";
import { pythonExec, _loadTable, _resolveTable } from "./ml-python";
import { createChat, resumeChat, chat, step } from "./ml-chat";
import { agent } from "./ml-agent-run";
import { createAgent, resumeAgent, approveOnce, _rebuildToolset, _adoptRun } from "./ml-agent-handle";

// Every family that used to live in the window.ml literal now has a module above; what is left here is the
// object that binds them together, the small `_`-prefixed introspection helpers, and the page's own window
// message handlers. The literal is the API SURFACE — a member is either declared inline because it is a few
// lines of plumbing, or an alias to the module that owns it.

(function() {

    /** `ml.fetch(ownUrl, { rendered: true, credentials: true })` on a local page, answered from the live
     *  document (see `isCurrentPage`). `rendered` is set because that is what it is: a settled DOM, not a
     *  response body. A plain object of strings — the serialized DOM, never a node — so handing it to the read-only dialect
     *  leaks nothing a survey of `outerHTML` would not already return. Not cached: the DOM changes, and a
     *  cached copy would answer a later read with an older page. */
    const liveDocumentFetch = (): import("./contract").FetchResult => {
        const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>\n` : "";
        const text = doctype + document.documentElement.outerHTML;
        let markdown: string | undefined;
        try { markdown = htmlToMarkdown(text); } catch { /* callers fall back to .text */ }
        return {
            url: location.href, status: 200, ok: true, type: "html", typeByHeader: null, typeByContent: "html",
            typeByExtension: typeFromExtension(location.href), contentType: "text/html", text,
            ...(markdown !== undefined ? { markdown } : {}), rendered: true, live: true,
        };
    };

    // ---- Agent tool helpers (page-context DOM introspection) ----
    // These keep observations SMALL on purpose: the point of the agent is to
    // iterate with cheap probes instead of dumping HTML into the model's
    // context. Every helper truncates hard and never returns outerHTML.



    window.ml = {
        /** The agent's persistent JS scratchpad (also injected into every `exec` body as `state`). A live
         *  page kernel: stash reusable functions/results here and pick them up on a later call. Page-lifetime,
         *  shared across runs. A GETTER (no setter) so it can't be reassigned/clobbered — mutate its props. */
        get state(): Record<string, unknown> { return agentState; },
        /** The CURRENT run's user-facing answer set — a run-bound collection (add/remove/clear/length/dump).
         *  A GETTER, so it always targets the run whose tool is executing; from the console outside a run it
         *  THROWS (a clear message beats a baffling failure on the next `.add`). Free to curate from `exec`. */
        get answer(): MlAnswer {
            const set = currentAnswer();
            if (!set) throw new Error("ml.answer is only live inside an ml.agent run (it curates that run's user-facing answer).");
            return makeAnswerFacade(set, elLine);
        },
        /**
         * Read a `@tool:<id>` pointer — an output THIS run already produced — instead of re-running the tool
         * that made it, or retyping a value. Reaches the FULL capture, not the truncated copy the model was
         * shown, so it can recover data that is otherwise unreachable.
         *
         * Run-bound like `ml.answer`: it resolves against the run whose tool is currently executing, so it is
         * live inside an approved `exec` and THROWS from a page's own console (there is no run, so there is no
         * store). The binding is what scopes it, not a permission check.
         *
         * ```js
         *   const rows = JSON.parse(await ml.dereference("@tool:a1b2c3", { pipe: ".rows" }));
         *   rows.filter(r => r[2] > 100).length
         * ```
         *
         * WHY THIS IS ASYNC, since the page path does not need it: when the run is PAGE-hosted the resolver
         * behind this is synchronous — a pure read of in-memory run state — and the await is ceremony. It is
         * async for the BACKGROUND-hosted path (design A, the default whenever a debug surface is open),
         * where the pointer store lives in the service worker and the read is a postMessage round trip. The
         * signature cannot vary by host: the same call must work either way, and returning a value in one
         * case and a promise in the other would be an invisible footgun. The cost lands in the READ-ONLY exec
         * dialect, whose evaluator is a generator precisely because every ml method is async — its `runSync`
         * driver (for arrows a host method invokes) throws NotInDialect on an await, so
         * `ids.map(id => ml.dereference(id))` inside a read-only survey falls through to approval.
         *
         * @param ref A pointer: `@tool:<id>`, the bare id, or a builtin's name for its latest call. `:in` reads
         *            the call/arguments instead of the result.
         * @param options `pipe` reduces the value first — the text-pipe dialect as a string
         *                (`".rows | head 5"`, split on unquoted `|`), or as an ARRAY with one stage per entry
         *                (`[".rows", "head 5"]`), which is never re-split. Reach for the array when a stage
         *                contains a `|` — `["grep -E error|warn"]` needs no quoting, where the string form
         *                needs `"grep -E 'error|warn'"`. (Quoting an argument with SPACES is unchanged in
         *                both forms: `grep -i 'pricing plan'`.)
         * @returns The value, reduced by the pipe. Rejects with an actionable message when the pointer doesn't
         *          exist (a MemoryFault naming the nearest real pointers) or a pipe stage is wrong.
         */
        dereference: async function(ref: string, { pipe = null }: { pipe?: string | string[] | null } = {}): Promise<DerefValue> {
            const fn = currentDeref();
            if (!fn) throw new Error("ml.dereference is only live inside an ml.agent run (it reads that run's captured tool outputs).");
            // STAGES cross the boundary, not a joined string — a stage may hold a bare `|` (see pipeStages).
            const read = await fn(String(ref ?? ""), pipeStages(pipe));
            // The advisory goes to console, NOT into the return value — this result is about to be parsed,
            // split or piped by the calling script, and exec captures console output into the step's result
            // and its live stream, so the warning still reaches the model without touching the data.
            if (read.warning) { try { console.warn(read.warning); } catch { /* no console in this realm */ } }
            // A String subclass, so every previous spelling still works while `.type`/`.json`/`.table`
            // answer what the caller used to have to sniff out of the bytes. `.pipe()` re-reads the SAME
            // pointer with more stages rather than piping the text it already holds — the store keeps the
            // fuller capture, so going back to it can return more than this text has.
            // Always a promise here: a `pipe` re-read cannot be pre-resolved (the stages are only known now),
            // so the sync path in `exec` deliberately falls through to this one. Wrapped so the type is the
            // promise it actually is rather than the union the declaration allows.
            const again = (stages: string | string[]): Promise<DerefValue> => Promise.resolve(window.ml.dereference(ref, { pipe: stages }));
            return new DerefText(read.value, read.meta, again, read.readColumns);
        },
        /**
         * The TypeScript-like type of some JSON — one document, or the JOINED type of several.
         *
         * ```js
         *   ml.schema(r.json)                                   // one document's shape
         *   await ml.schema(ml.dereference(a), ml.dereference(b))   // the type that covers both
         * ```
         *
         * Instances of the same thing collapse into one object whose sometimes-present keys become
         * optional; genuinely different things stay a union, since merging them would describe an object
         * that never existed. Arguments are AWAITED, so pointer reads can be passed straight in without
         * an await each. A JSON string is parsed; prose is refused rather than shaped, because there is
         * no honest type for it.
         *
         * @param values The documents. One value = its own shape; several = the joined type.
         * @returns The TS-like shape.
         */
        schema: async function(...values: unknown[]): Promise<string> {
            const vs = await Promise.all(values);
            if (!vs.length) throw new Error("ml.schema needs at least one value — pass a JSON value, a JSON string, a fetch result, or a pointer read.");
            const label = (i: number) => vs.length === 1 ? "the argument" : `argument ${i + 1}`;
            // A TABLE has a structure, but not a JSON one: its rows are a matrix, so a JSON shape of them
            // says `(string | number)[][]` — true, and useless. Describe it as a FRAME instead (the same
            // answer `fetch_url`'s `schema: true` and a pointer's `.schema()` give), so asking a CSV for its
            // schema returns its columns and dtypes rather than the type of its text.
            const asTable = (v: unknown): import("./contract").TableLike | undefined =>
                (v && typeof v === "object" ? (v as { table?: import("./contract").TableLike }).table : undefined);
            if (vs.some(asTable)) {
                return vs.map((v, i) => {
                    const t = asTable(v);
                    const prefix = vs.length === 1 ? "" : `${label(i)}: `;
                    return prefix + (t ? tableShape(t) : jsonShape(jsonValue(v, label(i))));
                }).join("\n\n");
            }
            return joinShapes(vs.map((v, i) => jsonValue(v, label(i))));
        },
        createChat: createChat,
        resumeChat: resumeChat,
        chat: chat,
        step: step,
        /**
         * @typedef {Object} MlTool An agent tool the model can call.
         * @property {string} name The name the model calls.
         * @property {string} [description] What it does, shown to the model.
         * @property {Object} [parameters] JSON Schema for the arguments object.
         * @property {(args: Object) => (string|{content: string, elements?: Node[]}|Promise<string|{content: string, elements?: Node[]}>)} run
         *   Executes in the page context. Returns a short string for the model, or
         *   `{ content, elements }` to also route real DOM nodes to the loop's
         *   onStep/transcript (for hovering in devtools) — `elements` never reaches
         *   the model.
         * @property {boolean} [requiresApproval] When true, {@link module:ml.agent}
         *   pauses and calls its approval gate before every model-driven call —
         *   set it on anything with side effects or arbitrary power (e.g. `exec`).
         * @property {string[]} [capabilities] Role tags the agent adapts to, e.g.
         *   `["vision"]` (this tool lets the model see) or `["answer"]` (this tool
         *   designates result element(s), surfaced on `result.elements`).
         */

        defineTool: defineTool,
        agent: agent,
        createAgent: createAgent,
        resumeAgent: resumeAgent,
        approveOnce: approveOnce,
        // OCR: transcribe baked-in text from an image to a plain string, using
        // the dedicated OCR (vision) model — so the reasoning model never sees
        // image tokens. Composes with chat:
        //   await ml.chat("Summarize: " + await ml.read($0))
        read: read,
        screenshot: screenshot,
        _shotBox: _shotBox,
        _stitchFullPage: _stitchFullPage,
        lookTool: lookTool,
        locateTool: locateTool,
        clickTool: clickTool,
        typeTool: typeTool,
        navigateTool: navigateTool,
        fetchTool: fetchTool,
        _rebuildToolset: _rebuildToolset,
        _adoptRun: _adoptRun,
        pythonExec: pythonExec,
        _loadTable: _loadTable,
        _resolveTable: _resolveTable,
        pythonTool: pythonTool,
        chatMetaTool: chatMetaTool,
        _resolveVisionModel: _resolveVisionModel,
        _modelSees: _modelSees,
        _nativeLookTool: _nativeLookTool,
        // The built-in ml.agent({ logDebug: true }) tracer; pass as onStep too.
        _logStep: logStep,
        // Design A tool delegation (run-delegation.ts): register an agent run's live toolset page-side
        // so the background loop can run its tools via RUN_TOOL_IN_PAGE. ml.agent's START_RUN shim
        // will call these; exposed under `_` so the transport is unit-testable (tests/delegation.test.js).
        _registerRun: function(runId: string, tools: MlTool[]): void { registerRun(runId, tools); },
        _endRun: function(runId: string): void { endRun(runId); },
        // Internal DOM helpers used by the agent tools, exposed under `_` (as
        // with _parseJSON below) so tests and console debugging can reach them.
        _truncate: truncate,
        _suspiciousChars: suspiciousChars,
        _renderArgs: renderArgs,
        _elPath: elPath,
        _describeSkeleton: describeSkeleton,
        _queryAll: queryAll,
        // Public alias: a shadow/iframe-piercing `document.querySelectorAll` the model can call from
        // `exec` (and the readonly dialect) instead of hand-chaining `.shadowRoot`/`.contentDocument`.
        queryAll,
        // The screen-reader + actionable view of ONE element as a single object — the a11y/reference expertise
        // the interactives/findByText tools use, exposed as a read-only primitive so `exec` can COMPOSE its own
        // finder (blessed in the readonly dialect → a survey that uses it auto-approves). One call gives the role,
        // accessible name, aria state, and the stable `>>>` reference to hand click/type. All pure reads.
        a11y: (el: Element): { role: string; name: string; state: string; selector: string } =>
            ({ role: roleOf(el), name: accessibleName(el), state: ariaState(el), selector: clickSelector(el) }),
        // PRIVATE debug helper (underscore → not in agent_api_docs, the agent never learns of it): list every
        // shadow-root host + whether the tools can enter it — `{ open, pierced, sealed, empty, hosts }`, each host
        // `{ selector, tag, state }` with state open / pierced / sealed / empty. Call `ml._shadowRoots()` from the
        // console to see where the "N closed roots" pageInfo counts actually are (sealed = real barrier; empty =
        // unopened menu/emulated host, not a barrier). Temporary; keep it OUT of the public MlApi.
        _shadowRoots: function() { return shadowHostReport(document); },
        _selectorError: selectorError,
        // Parses a structured-output reply, tolerating a stray ```json fence
        // and surfacing the raw text on failure for debugging.
        /**
         * Parse a structured-output reply, tolerating a stray ```json fence
         * and surfacing the raw text on failure for debugging.
         *
         * @param {string} text The JSON text to parse.
         * @returns {Object} The parsed JSON object.
         * @throws {Error} If the text is not valid JSON.
         */
        _parseJSON: function(text: string): unknown {
            const stripped = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
            try {
                return JSON.parse(stripped);
            } catch (err) {
                throw new Error(
                    `schema was set but the reply wasn't valid JSON (${(err as Error).message}). ` +
                    `Got: ${text.slice(0, 200)}`
                );
            }
        },
        _imageToDataUrl: _imageToDataUrl,
        _fetchImageBase64: _fetchImageBase64,
        models: models,
        serverTools: serverTools,
        /**
         * The server-side tools, as a callable NAMESPACE: `ml.dynamicTools.<bundle>.<fn>(args)`.
         *
         * Namespaced by BUNDLE rather than flattened, because function names come from the server and two
         * bundles can both expose `search` — flattening would silently call the wrong one.
         *
         * Each callable carries its own contract: `.schema` is the function's JSON Schema and `.spec` the
         * whole declaration. That is the SAME object the call validates against, so what you inspect is
         * literally what checks your arguments rather than a second copy that can drift.
         *
         * Populated in two stages, because `window.ml` is defined synchronously at document_start and the
         * tool list needs a fetch. A Proxy dispatches by name immediately — a call works before any list has
         * arrived — and the real keys appear once `ml.serverTools()` has resolved, so tab-completion works
         * from then on. `await ml.dynamicTools.load()` forces that early.
         *
         * Same gate as {@link execServerTool}: privileged, so from an untrusted page it runs only a call an
         * agent run already approved. Inside a run, the loop narrows this to the tools that run whitelisted.
         */
        get dynamicTools(): DynamicToolNamespace {
            return (this._dynamicTools ||= makeDynamicTools(this as unknown as MlApi, undefined, currentServerAllow));
        },
        execServerTool: execServerTool,
        info: info,
        capabilities: capabilities,
        getModel: getModel,
        /**
         * A bounded integer range, like Python's `range()` — the terminating counter loop for `exec`
         * (no `for`/`while` needed): `ml.range(8).map(i => …)`. Forms: `range(stop)`, `range(start, stop)`,
         * `range(start, stop, step)`. Returns a real array capped at 100k elements (over → throws), so it
         * can never run away or blow up memory.
         *
         * @param {number} a `stop`, or `start` when `b` is given.
         * @param {number} [b] `stop`.
         * @param {number} [step=1] Increment (may be negative).
         * @returns {number[]} The integer sequence.
         */
        range: mlRange,
        pipe: mlPipe,
        embed: embed,
        /**
         * GET a URL's content via the background worker — bypasses CORS (host permissions), and by DEFAULT sends
         * no cookies (uncredentialed; `credentials`/`rendered` opt in — see below). Use it to READ a page/file
         * the current DOM can't reach — a raw source file, a JSON API, another site — instead of NAVIGATING
         * there (which also dodges pages that block the extension, e.g. raw.githubusercontent.com's sandbox CSP).
         *
         * Returns a FetchResult: `.type` classifies the body as json/csv/html/xml/markdown/code/text so you can
         * chain — `.json` is pre-parsed for JSON; hand a CSV's `.text` to `python_exec`; `.language` names a
         * code file's language. The type is a best-effort HEURISTIC (resolved from the Content-Type header,
         * then a content sniff, then the URL extension — a server can mislabel, so `.typeByHeader`/`.typeByContent`/
         * `.typeByExtension` are all reported); don't treat it as authoritative.
         *
         * GET only — no headers, body, or auth. Each NEW url needs the user's one-time approval; then it's
         * remembered for the session.
         *
         * Re-reading a URL you've already fetched is FREE: a SUCCESSFUL result is cached (page-lifetime), and a
         * read-only `exec` calling `ml.fetch(url)` on a cached URL returns it with no approval (only a NEW url
         * asks). Approve the source once, then operate on it — like `python_exec` on a Google Sheet. Failures
         * (non-2xx) are NOT cached, so a retry after the server recovers re-fetches. Pass `{ fresh: true }` to
         * SKIP the cache and force a fresh fetch (a real fetch → needs approval even for a cached url).
         *
         * `{ credentials: true }` fetches AS THE USER (sends their cookies) — for authenticated data (a private
         * gist, a logged-in dashboard's API). It's a powerful, gated primitive: it ALWAYS prompts (never
         * auto-approved, never remembered), is NEVER cached, and works only via the `fetch_url` tool (an
         * explicit, human-approved URL) — an inline credentialed `ml.fetch` in `exec` is refused.
         *
         * When the body is JSON, `.json` is the parsed value and `.schema` is a compact TS-like SHAPE of it
         * (`{ id: number, items: { name: string }[] }`) — the structure to write code against without holding
         * the whole payload. When the body is HTML, `.markdown` is a clean Markdown distillation (scripts, nav,
         * and page chrome stripped) — read that for the content; `.text` still holds the original raw HTML.
         *
         * `{ rendered: true }` loads the URL in a background tab so its JavaScript runs, then returns the SETTLED
         * DOM (for client-rendered/SPA pages a raw GET returns empty). Like `credentials` it's as-the-user
         * (a real tab load carries the session), always prompts, is never cached, and works only via `fetch_url`.
         *
         * @param {string} url An absolute http(s) URL.
         * @param {{ fresh?: boolean; credentials?: boolean; rendered?: boolean }} [opts] `fresh` bypasses the read cache; `credentials` fetches with the user's cookies; `rendered` loads it in a background tab and returns the settled DOM (both gated, uncached).
         * @returns {Promise<FetchResult>} { url, status, ok, type, language?, text, json?, schema?, typeBy*, truncated?, rendered?, headers? }. `headers` is a SAFELIST of non-sensitive response headers (link/etag/lastModified/retryAfter/contentLength/contentDisposition/cacheControl/date) — auth headers (Cookie/Authorization/…) are never exposed.
         */
        fetch: function(url: string, opts?: { fresh?: boolean; credentials?: boolean; rendered?: boolean; format?: import("./contract").FetchFormat }): Promise<import("./contract").FetchResult> {
            const key = String(url);   // the real method always fetches live; `fresh` only matters for the read-only cache path
            const credentials = !!opts?.credentials;
            const rendered = !!opts?.rendered;
            const format = opts?.format === "html" ? "html" as const : "markdown" as const;
            // A SESSION RENDER OF THE PAGE YOU ARE ON. `rendered + credentials` asks for "this URL, its JS run, in
            // my own session" — and for the page the call came from, that is exactly the DOM already in front of
            // it. So it is answered from there: no second tab re-running the page's scripts (and their side
            // effects), no request, no grant. ONLY this mode: a plain or `format: "html"` fetch promises the
            // server's (or the file's) own BYTES, which the live DOM is not, and a sessionless `rendered` load is
            // a FRESH page rather than this one — those still go to the network. On a file:// page they cannot
            // (Chrome's fetch has no file scheme), and the background's refusal names this mode as the one that
            // works (see `isCurrentPage`).
            if (credentials && rendered && isCurrentPage(key, location.href)) return Promise.resolve(liveDocumentFetch());
            return makeBackgroundTaskPromise<import("./contract").FetchResult>("FETCH_URL_REQUEST", "FETCH_URL_RESPONSE", { url: key, credentials, rendered, format })
                .then(r => {
                    // For an HTML body, attach a `.markdown` distillation (scripts/nav/chrome stripped) so ANY
                    // caller — exec, a read-only survey (`ml.fetch(url).markdown`), the fetch_url tool — gets the
                    // readable content without re-converting. Computed here in the page main world (has a DOM);
                    // the cost is negligible and the cached copy carries it. `.text` still holds the raw HTML.
                    if (r && r.type === "html" && typeof r.text === "string" && r.markdown === undefined) {
                        try { r.markdown = htmlToMarkdown(r.text); } catch { /* leave undefined — callers fall back to .text */ }
                    }
                    // Same move for a CSV/TSV body: attach the PARSED table, with its separator discovered and
                    // numeric columns cast, so no caller has to re-split the text (and get the separator wrong —
                    // the reason this exists is that they did). Page-side for the same reason as `.markdown`: the
                    // text has already crossed the message channel, so parsing here adds nothing to the wire.
                    if (r && r.type === "csv" && typeof r.text === "string" && r.table === undefined) {
                        try {
                            const parsed = tableFromDelimited(r.text);
                            // A body clipped at the size cap ends mid-row, so that row is a fragment rather than
                            // data. Drop it and say the table is a prefix — silently keeping it would put a
                            // half-parsed record into a DataFrame. BEFORE wrapping: the facade is read-only, and
                            // trimming through it threw halfway, leaving the fragment dropped but the shape wrong.
                            if (r.truncated && parsed.rows.length) {
                                parsed.rows.pop();
                                parsed.shape = [parsed.rows.length, parsed.columns.length];
                                parsed.truncated = true;
                                // …unless the worker read the whole body (it is stored), in which case its real length is
                                // known: the preview is a prefix of a table this big, not the whole of a table this small.
                                const whole = typeof r.bodyLines === "number" ? r.bodyLines - (parsed.headerless ? 0 : 1) : 0;
                                if (whole > parsed.rows.length) parsed.shape = [whole, parsed.columns.length];
                            }
                            r.table = parsed;
                        } catch { /* leave undefined — callers fall back to .text */ }
                    }
                    // Every table a caller receives is a FACADE, not the bare data — a Parquet one decoded in the
                    // worker as much as a CSV parsed here: the description is pandas-shaped, so the object has to
                    // answer a pandas reach with a message rather than `undefined`. Whether the message may point
                    // at python_exec is read from the running run's toolset.
                    if (r && r.table && !isTable(r.table)) r.table = asTable(r.table, { python: currentHasTool("python_exec") });
                    // Cache ONLY a successful UNCREDENTIALED, non-rendered fetch (as-you bytes are authenticated —
                    // never cache). Keyed by url ALONE, so only the DEFAULT format is cached: `format:"html"`
                    // returns different bytes for the same url, and letting it share the key would hand a later
                    // reader the wrong document.
                    if (r && r.ok && !credentials && !rendered && format === "markdown") mlFetchCache.set(key, r);
                    return r;
                });
        },
        /**
         * Internal: the CACHE-ONLY read the read-only dialect's `ml.fetch` is bound to. Returns a prior
         * successful `ml.fetch(url)` result, or undefined on a miss (→ the dialect throws → the exec falls to
         * the normal approval, which does the real fetch). Never egresses — a pure read of already-approved bytes.
         * @param {string} url The URL to look up.
         * @returns {FetchResult|undefined} The cached result, or undefined if this URL hasn't been fetched.
         */
        _fetchCached: function(url: string, mode?: { credentials?: boolean; rendered?: boolean; format?: string }): import("./contract").FetchResult | undefined {
            // A session render of the local page you are on is its live DOM — which this dialect already reads
            // through `outerHTML` — so it answers here rather than costing an approval for the same bytes.
            if (mode?.rendered && mode?.credentials) return isCurrentPage(String(url), location.href) ? liveDocumentFetch() : undefined;
            // The cache holds DEFAULT-mode results only (see `fetch`). Any other mode is a different document,
            // so it misses rather than handing back the wrong one.
            if (mode?.rendered || mode?.credentials || mode?.format === "html") return undefined;
            return mlFetchCache.get(String(url));
        },
        config: config,
        setModel: setModel,
        ps: ps,
        /**
         * DEBUG DUMP — everything the resource panel derives its timeline from, in one object. For reporting a
         * lane that draws something that makes no sense: the drawn events are DERIVED (`eventsFrom` +
         * `machineEventFrom`, both pure), so handing over the INPUTS lets the exact picture be rebuilt and
         * turned into a test, where a screenshot can only be described.
         *
         * `{ debug }` is this tab's own `__mlDebug` stream (runs, steps, usage), `{ frames }` the server's
         * event-stream frames with the wall clock each was resolved to, plus the current `ps`/`info` and the
         * stream's status. Underscored because it is a debugging aid, not API: shape may change freely.
         *
         * TWO THINGS TO KNOW when capturing. `frames` is only collected while a resource panel is OPEN —
         * nothing subscribes to the stream when nobody is looking — so open the panel before the run you
         * want. And `debug` is the BACKGROUND's ring: it holds everything in `debugMode: "devtools"`, and
         * only the background-hosted half of a run in `"overlay"`.
         *
         * @param opts.download Save it as `ml-events-<time>.json` instead of only returning it.
         * @returns {Promise<object>} The raw inputs, JSON-serializable.
         */
        __events: async function(opts?: { download?: boolean }): Promise<Record<string, unknown>> {
            const dump = await makeBackgroundTaskPromise("DUMP_EVENTS_REQUEST", "DUMP_EVENTS_RESPONSE", {}) as Record<string, unknown>;
            if (opts?.download) {
                // Straight to a file: this is usually several megabytes of screenshots and step results, which
                // no console can be asked to hold, let alone copy out of.
                const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 1)], { type: "application/json" }));
                const a = document.createElement("a");
                a.href = url; a.download = `ml-events-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }
            return dump;
        },
        /**
         * The HOUSEKEEPING LOG: what the system decided on its own — cache evictions, sweeps, service-worker
         * restarts (inferred from a heartbeat, since an evicted worker writes nothing on its way out), Python
         * cold starts. One structured event each, oldest first, kept in `chrome.storage.session` so it outlives
         * the worker and clears with the browser. `origin` is who reported it, stamped by the worker; this page
         * sees `key` and string `detail` values only on events its own tab reported. Underscored: a debugging aid, not API.
         * See docs/dev/housekeeping.md.
         *
         * @param opts.download Save it as `ml-housekeeping-<time>.json` instead of only returning it.
         * @returns {Promise<object[]>} The events, oldest first.
         */
        __housekeeping: async function(opts?: { download?: boolean }): Promise<unknown[]> {
            const events = await makeBackgroundTaskPromise("DUMP_HOUSEKEEPING_REQUEST", "DUMP_HOUSEKEEPING_RESPONSE", {}) as unknown[];
            if (opts?.download) {
                const url = URL.createObjectURL(new Blob([JSON.stringify(events, null, 1)], { type: "application/json" }));
                const a = document.createElement("a");
                a.href = url; a.download = `ml-housekeeping-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }
            return events;
        },
        /**
         * One record per model LOAD, for tuning the server's VRAM predictor — collected in the service worker
         * while the resource panel's "load predictions" toggle is on (off by default), and kept across worker
         * restarts. Each has the server's prediction (`estimate`, verbatim), the load's own figures
         * (`complete`, verbatim), and the measured `trace`: where it peaked, where it settled, and every sample
         * between as `[ms since the load began, bytes]`. The panel must be OPEN while loads happen — the stream
         * is only connected then. Underscored: a debugging aid, not API.
         *
         * @param opts.download Save them as `ml-loads-<time>.json` instead of only returning them.
         * @param opts.clear Empty the store after reading it.
         * @returns {Promise<object[]>} The records, oldest first.
         */
        __loads: async function(opts?: { download?: boolean; clear?: boolean }): Promise<unknown[]> {
            const records = await makeBackgroundTaskPromise("DUMP_LOADS_REQUEST", "DUMP_LOADS_RESPONSE", { clear: !!opts?.clear }) as unknown[];
            if (opts?.download) {
                const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 1)], { type: "application/json" }));
                const a = document.createElement("a");
                a.href = url; a.download = `ml-loads-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }
            return records;
        },
        unload: unload,
    };

    // ---- Default agent tool registry (ml.domTools) ----
    // Generic, page-agnostic DOM introspection + escape-hatch tools; defined in
    // tools.ts. Pass this array (or a superset — `[...ml.domTools, myTool]`) to
    // ml.agent. defineTool is detached (this-free), so pass it directly.
    // Pass a `verifyArea` capability (closes over ml) so the pure `wait` domTool can `verify` too — the
    // domTools stay ml-free; they just receive this function. center=null → a viewport shot (wait is area-first).
    window.ml.domTools = makeDomTools(window.ml.defineTool,
        (ctx, center, verb, mutated) => captureVerify(window.ml as unknown as MlApi, ctx, center, verb, mutated),
        // captureAnswer: serialize each element an `answer` designates, for the HUD completion card (user-facing
        // output — NOT the debug sidebar). ml-backed, so the domTools stay ml-free. Capped + per-element failures
        // swallowed; the answer still stands without the media. An <img> → its FULL-RES src (crop fallback); any
        // other element → a screenshot crop. `mode` = show ?? (image → inline, element → highlight).
        async (els: Element[], note?: string, show?: "inline" | "highlight"): Promise<AnswerMedia[]> => {
            const ml = window.ml as unknown as MlApi & { _imageToDataUrl: (el: HTMLImageElement) => Promise<string> };
            const out: AnswerMedia[] = [];
            for (const el of els.slice(0, 6)) {
                const isImg = el instanceof HTMLImageElement;
                const kind: AnswerMedia["kind"] = isImg ? "image" : "element";
                const mode: AnswerMedia["mode"] = show || (isImg ? "inline" : "highlight");
                let image = "";
                try { image = isImg ? await ml._imageToDataUrl(el as HTMLImageElement) : await ml.screenshot(el, { noOverlay: true }); }
                catch { try { image = await ml.screenshot(el, { noOverlay: true }); } catch { /* no visual — keep the chip via selector */ image = ""; } }
                out.push({ image, label: note, selector: elPath(el), kind, mode });
            }
            return out;
        },
        // shadowResolve: describeElement's discovery into a SEALED (closed/declarative) shadow root — round-trips
        // to the background, which CDP-resolves the `>>>` selector (piercing the closed root a page selector
        // can't enter) and returns describe lines. Off (cdp flag) / no match → the message errors → null → the
        // normal "no match" path. Read-only; the privileged sealed CLICK still flows through the trusted envelope.
        async (selector: string): Promise<{ line: string }[] | null> => {
            try {
                const matches = await makeBackgroundTaskPromise<{ line: string }[]>("CDP_SHADOW_RESOLVE_REQUEST", "CDP_SHADOW_RESOLVE_RESPONSE", { selector });
                return Array.isArray(matches) ? matches : null;
            } catch { return null; }
        });

    // listen for the background loop's delegated tool-run requests (relayed by content.ts
    // as PAGE_TOOL_RUN). A no-op until an agent run registers a toolset via _registerRun.
    installToolDelegation();

    // Cross-page persistence: a FRESH document (after a same-site navigation) must RE-ADOPT any
    // background-hosted run its tab still hosts — rebuild + re-register the toolset so the loop's held
    // delegated tool can run here. content.ts asks the background on our behalf (CONTENT_READY) and relays
    // the rebuild-config back as an ADOPT_RUN window message; we rebuild, then post RUN_READOPTED so the
    // background releases the navigation barrier. We DRIVE it (post PAGE_ADOPT_HELLO now that this listener
    // exists) so content.ts only sends ADOPT_RUN after we're listening — avoiding a missed message on the
    // async <script> injection.
    window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || !e.data || e.data.type !== "ADOPT_RUN") return;
        const { runId, rebuild, resume } = e.data as { runId?: string; rebuild?: RebuildConfig; resume?: boolean };
        if (!runId || !rebuild) return;
        try { (window.ml as unknown as MlApi)._adoptRun(runId, rebuild); }
        catch { /* rebuild failed → the barrier times out and the loop gets a clear "no active run" error */ }
        // Carry the DESTINATION page's context back: the background folds it into the `navigate` tool's
        // result, so the model's next turn is oriented on the new page without a wasted look()/pageInfo turn.
        window.postMessage({ type: "RUN_READOPTED", runId, pageInfo: pageContext(n => (rebuild.toolNames || []).includes(n)) }, "*");
        // Durable resume: an INTERRUPTED (SW-evicted) run auto-CONTINUES from its checkpointed history — the
        // resume handle _adoptRun just re-registered drives a RESUME_RUN (empty follow-up = "carry on").
        if (resume) {
            try { const bg = agentRegistry.get(runId); if (bg) void bg.resume(""); }
            catch { /* resume unavailable → the run stays paused, no worse than before */ }
        }
    });
    window.postMessage({ type: "PAGE_ADOPT_HELLO" }, "*");

    // Sidebar hover-highlight for @pt/@box: the shell (a content script) can't read this main-world
    // point/box registry, so it asks us to resolve a token to viewport coords, then draws the overlay
    // itself (in its shadow root — no page mutation). `seq` echoes back so a stale hover is ignored.
    window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || !e.data || e.data.type !== "ML_HL_RESOLVE") return;
        // A CSS/custom SELECTOR the shell couldn't resolve natively (ml's :contains/:has-text/:eq that
        // document.querySelectorAll rejects) → resolve via queryAll and return the element's viewport box.
        if (typeof e.data.selector === "string") {
            let box: { left: number; top: number; right: number; bottom: number } | null = null;
            let label = "";
            try {
                const el = queryAll(e.data.selector)[e.data.index || 0];
                if (el) {
                    // viewportRect (not getBoundingClientRect) so an element inside a same-origin iframe is
                    // placed in the TOP viewport, not at its frame-local position (the overlay is top-level).
                    const r = viewportRect(el);
                    if (r.width || r.height) { box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; label = `${el.tagName.toLowerCase()} · ${Math.round(r.width)}×${Math.round(r.height)}`; }
                }
            } catch { /* still not resolvable — no box */ }
            window.postMessage({ type: "ML_HL_AT", seq: e.data.seq, point: null, box, label }, "*");
            return;
        }
        const token = String(e.data.token || "");
        const point = resolvePoint(token);
        const box = point ? null : resolveBox(token);
        window.postMessage({ type: "ML_HL_AT", seq: e.data.seq, point: point || null, box: box || null }, "*");
    });

    // The HUD composer (Spotlight bar) asks the page to START a run — relayed by the shell as
    // __mlStartAgent. Run it as a real ml.agent() call so it's a genuine session (hash, resumable,
    // appendable), which in off/devtools mode routes to the background-hosted loop like a console run.
    // Grants nothing extra: the page already has window.ml.agent, and every tool gates on the background.
    window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || !e.data || !e.data.__mlStartAgent) return;
        let task = String(e.data.__mlStartAgent.task || "").trim();
        // Composer attachments (pasted/uploaded screenshots) — the shell already sanitised them to data URLs.
        const images = Array.isArray(e.data.__mlStartAgent.images) ? e.data.__mlStartAgent.images as string[] : undefined;
        // Right-click "ask about this": the shell resolved the clicked element to a clean ElementContext.
        // Frame it around the user's question (content as context + the scope selector for the DOM tools).
        const elementContext = e.data.__mlStartAgent.elementContext as import("./contract").ElementContext | undefined;
        if (elementContext && typeof elementContext.selector === "string") task = askAboutTask(task, elementContext);
        // A `reqId` means somebody is WAITING to be told which session this became: the chat page's `agent.start`,
        // which must answer with a session id. The HUD composer sends none and is unchanged.
        const reqId = typeof e.data.__mlStartAgent.reqId === "string" ? e.data.__mlStartAgent.reqId : undefined;
        const answer = (outcome: string, hash?: string): void => {
            if (reqId) window.postMessage({ __mlSessionDone: { reqId, outcome, ...(hash ? { hash } : {}) } }, "*");
        };
        if (!task && !(images && images.length)) { answer("none"); return; }   // allow an image-only start
        // A UI-started run is a PRODUCT surface (a user typing "click the button" expects click to work),
        // so give it a capable default kit — click/type/python ON TOP of the default domTools + auto-wired
        // look/locate. (The console `ml.agent` primitive stays minimal — callers compose their own.) Each
        // added tool still requires approval, gated by the unforgeable card.
        const maxSteps = Number(e.data.__mlStartAgent.maxSteps);
        const ml = window.ml as unknown as {
            createAgent: (o?: unknown) => MlAgentHandle & { run: (t?: string, images?: (string | HTMLImageElement)[]) => Promise<unknown> };
            clickTool: () => unknown; typeTool: () => unknown; pythonTool: () => unknown; chatMetaTool: () => unknown;
        };
        // `systemAppend` (appended to the system prompt) rather than `system` (which would REPLACE the
        // preamble): the run still needs the whole method, it just isn't a console call.
        // chatMetaTool: a HUD user often asks "which model am I / how much context have I used?" — give the
        // HUD agent the self-introspection tool by default (a scripted ml.agent still opts in via extraTools).
        // HUD verbosity (passed by the shell): quiet → tell the model to stay silent between steps; progress
        // → keep between-step prose to one short live line. Defaults to progress.
        const proseClause = e.data.__mlStartAgent.hud === "quiet" ? HUD_PROSE_QUIET : HUD_PROSE_PROGRESS;
        // Commander/HUD runs allow cross-origin navigation by default — a HUD user driving a real task often
        // needs to cross sites, and each crossing still hits the consent gate (a new origin prompts), so it's
        // safe. A scripted console `ml.agent()` still defaults to same-site only.
        const opts: Record<string, unknown> = { extraTools: [ml.clickTool(), ml.typeTool(), ml.pythonTool(), ml.chatMetaTool()], systemAppend: HUD_HINT + proseClause, crossOrigin: true };
        if (Number.isFinite(maxSteps) && maxSteps > 0) opts.maxSteps = maxSteps;   // the composer's step budget
        // The composer's per-call model pick (omitted ⇒ the configured default) + a per-call FORCE-NATIVE
        // vision override for a non-Ollama model (omitted ⇒ ml.agent's default vision routing). Same knobs a
        // console ml.agent({ model, vision }) exposes — the HUD just wires the picker to them.
        const startModel = e.data.__mlStartAgent.model;
        if (typeof startModel === "string" && startModel.trim()) opts.model = startModel.trim();
        if (e.data.__mlStartAgent.vision === true) opts.vision = true;
        if (e.data.__mlStartAgent.stream === true) opts.stream = true;   // the composer's "live" toggle → stream the thinking
        opts.toolTokens = true;   // HUD runs auto-enable tool tokens (the rich answer card is where citing exact outputs pays off)
        // createAgent (not ml.agent) so the run registers a HANDLE the sidebar/HUD composer can drive —
        // follow-up run()s + say() steering from the "Send a message to this session…" box.
        // Bundles the user marked always-present. Read HERE rather than inside `ml.agent`, because this is
        // the surface that needs them: a Commander run has no code to name a bundle, while a scripted
        // `ml.agent()` said exactly what it wanted and must not have tools added behind its back.
        // `commanderTools` rather than resolving the bundles HERE: reading the config first made starting a
        // run wait on a message round-trip, so a slow or unanswered read delayed — or never started — a run
        // the user had already typed. The loop already reads the config in its own async setup.
        opts.commanderTools = true;
        // The hash is minted inside the loop, so the run itself reports it (`_onSession`) rather than the caller
        // polling the handle for one that is not there yet. Two listeners want it and they are not the same: a
        // command that is waiting for its answer, and — when this browser's own UI started the run and is keeping
        // its sessions — the worker, which is what holds them (sidebar/shell-session-relay.ts).
        const keep = e.data.__mlStartAgent.keep === true;
        opts._onSession = (hash: string) => {
            answer("started", hash);
            if (keep) window.postMessage({ __mlSessionKeep: { hash } }, "*");
        };
        try { void ml.createAgent(opts).run(task, images); }
        catch (err) { console.error("ml: UI-started run failed:", err); answer("none"); }
    });

    // Sidebar/HUD composer → drive a handle-backed session by hash. The app decides which to send from the
    // run's live state: say() to STEER a running loop or append when idle; run() a follow-up turn; cancel()
    // the in-flight turn (the stop button). Same origin check as the others; the registry holds only this
    // page's own createAgent sessions, so there's nothing cross-origin to reach.
    // Composer-initiated chat turns need a cancel channel too (the stop button). A plain chat turn is a
    // single fetch — unlike an agent loop there's no handle to hold it — so we track the in-flight
    // AbortController per session hash and abort it on cancel. Only composer-driven turns are tracked (a
    // console `history.chat()` isn't), which is fine: the stop button only fronts turns the composer started.
    const chatInflight = new Map<string, AbortController>();
    async function continueChatSession(hash: string, text: string, images?: (string | HTMLImageElement)[], started?: (found: boolean) => void): Promise<void> {
        // Same-tab sessions live in the registry; a saved session from another tab/reload rehydrates.
        const resume = (window.ml as unknown as { resumeChat: (h: string) => Promise<MlHistory> }).resumeChat;
        let h = sessionRegistry.get(hash);
        if (!h) { try { h = await resume(hash); } catch { started?.(false); return; } }   // unknown/unsaved hash → nothing to continue
        if (!h) { started?.(false); return; }
        started?.(true);
        const ctrl = new AbortController();
        chatInflight.set(hash, ctrl);
        try { await h.chat(text, { images: images || [], signal: ctrl.signal }); }
        catch { /* aborted or failed — the chat-error event already surfaced it in the sidebar */ }
        finally { if (chatInflight.get(hash) === ctrl) chatInflight.delete(hash); }
    }

    window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || !e.data) return;
        const d = e.data as { __mlSessionSend?: { hash: string; text: string; images?: string[]; elementContext?: import("./contract").ElementContext; reqId?: string }; __mlCancelSession?: { hash: string; reqId?: string }; __mlContinueRun?: { hash: string; reqId?: string } };
        // A request the shell relayed from an extension page (the chat page) carries a `reqId` and wants to hear what
        // happened, so the page can say "steered", "started a turn" or "not on this page" instead of guessing.
        const reqId = d.__mlSessionSend?.reqId ?? d.__mlCancelSession?.reqId ?? d.__mlContinueRun?.reqId;
        const done = (outcome: "steer" | "turn" | "cancelled" | "continued" | "busy" | "none"): void => {
            if (typeof reqId === "string") window.postMessage({ __mlSessionDone: { reqId, outcome } }, "*");
        };
        try {
            if (d.__mlContinueRun) {
                // "Continue (+N steps)" on a step-capped run: resume it with an EMPTY task — a resume re-enters
                // the loop with a FRESH maxSteps budget (the loop restarts its step count), so the run keeps
                // going from its stored state with N more steps, without the user typing a follow-up. Bypasses
                // the __mlSessionSend empty-text guard on purpose (there IS no text — it's "just keep going").
                const hash = String(d.__mlContinueRun.hash);
                const h = handleRegistry.get(hash);
                if (h) { if (!h.running) { void h.run(""); done("continued"); } else done("busy"); return; }   // page-hosted handle: continue over prior messages
                const bg = agentRegistry.get(hash);
                if (bg) { void bg.resume(""); done("continued"); return; }              // background-hosted / cross-page run: RESUME_RUN, empty task
                done("none");
                return;
            }
            if (d.__mlSessionSend) {
                const hash = String(d.__mlSessionSend.hash);
                const rawText = String(d.__mlSessionSend.text || "");
                const images = Array.isArray(d.__mlSessionSend.images) ? d.__mlSessionSend.images : undefined;
                // Right-click "Add to current run" carries an element context — fold it into the message the
                // same way a fresh "ask about this" run does (askAboutTask), so an appended turn/steer gets the
                // element's clean content + selector. An element-only send (no typed text) is then non-empty.
                const ec = d.__mlSessionSend.elementContext;
                const text = (ec && typeof ec.selector === "string") ? askAboutTask(rawText, ec) : rawText;
                if (!text && !(images && images.length)) { done("none"); return; }   // allow an image-only follow-up
                const h = handleRegistry.get(hash);
                // An AGENT handle holds live state: steer a RUNNING loop (say — text only, no image mid-steer),
                // else a new turn (run, which carries this turn's images).
                if (h) { if (h.running) { h.say(text); done("steer"); } else { void h.run(text, images); done("turn"); } return; }
                // No local handle — e.g. a HUD run that NAVIGATED (its page-side handle died with the old
                // document). If it re-adopted as a resumable BACKGROUND run (agentRegistry, keyed by hash),
                // continue it with a follow-up TURN rather than dropping the message into the chat path.
                const bg = agentRegistry.get(hash);
                if (bg) {
                    emitDebug({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text });
                    void bg.resume(text);
                    done("turn");
                    return;
                }
                // Otherwise it's a plain chat session — continue the conversation with another turn.
                void continueChatSession(hash, text, images, (found) => done(found ? "turn" : "none"));
                return;
            }
            if (d.__mlCancelSession) {
                const hash = String(d.__mlCancelSession.hash);
                const h = handleRegistry.get(hash);
                if (h) { h.cancel(); done("cancelled"); return; }   // agent loop hosted on THIS page
                // No local handle — a HUD/cross-page run that NAVIGATED (its page-side handle died with the old
                // document) and re-adopted as a resumable BACKGROUND run (agentRegistry). Relay CANCEL_RUN so the
                // background aborts the run's OWN controller AND resolves any open approval gate (mirrors the
                // __mlSessionSend agentRegistry fallback). Without this, the composer's Stop button was inert
                // cross-page — the run stayed stuck "waiting for your approval…" with no way to cancel it.
                if (agentRegistry.has(hash)) { window.postMessage({ type: "CANCEL_RUN_REQUEST", payload: { runId: hash } }, "*"); done("cancelled"); return; }
                const inflight = chatInflight.get(hash);   // chat turn started from the composer
                inflight?.abort();
                done(inflight ? "cancelled" : "none");
                return;
            }
        } catch (err) { console.error("ml: session composer action failed:", err); done("none"); }
    });

    // Readiness signal for scripts (e.g. userscripts) that may run before this
    // one injects. Resolves immediately since window.ml is fully synchronous:
    //   const ml = await (window.ml?.ready
    //       ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));
    window.ml.ready = Promise.resolve(window.ml);
    window.dispatchEvent(new Event("ml:ready"));

    console.log("🟢 window.ml is ready.");
})();
