// ml-tool-factories.ts — the `ml.xxxTool()` builders: each returns ONE MlTool a caller hands to
// `ml.agent({ extraTools })`, or runs itself.
//
// Split out of injected.ts, whose `window.ml` literal was 3,000 lines. What they have in common is their SHAPE,
// not their subject: every one is a factory rather than an operation, which is why `defineTool` — the generic way
// to make one — belongs here beside the built-ins it is the pattern for.
//
// The split between this file and `builtin-tools.ts` is where the tool's BODY lives. Most of these are three lines
// that delegate there (`lookTool`, `clickTool`, `typeTool`); the ones that stayed whole did so because their body
// is page-world work with no other home — `fetchTool` is 250 lines of the fetch ladder's approval and formatting
// rules, which only mean anything in the page.
//
// They take an explicit `this: MlApi` and are still invoked as `ml.fetchTool()`, so `this` is the live object and
// a tool built here can reach the rest of the API. The annotation is how TypeScript is told that; it is not a bind.

import { buildLookTool, buildLocateTool, buildClickTool, buildTypeTool } from "./builtin-tools";
import { subcallUsage } from "./bus";
import type { MlApi } from "./contract";
import type { MlTool, ToolResult } from "./contract-agent";
import type { VisionMemory, RenderDescriptor } from "./contract-render";
import { navTarget, errText, clipOut, askReaderNumCtx, jsonShape } from "./dom";
import { htmlToMarkdown } from "./html-to-md";
import { buildPythonTool } from "./python-tool";
import { tableShape, asTable, tableFromDelimited, tablePreview, RENDER_TABLE_ROWS } from "./table-data";
import { PIPE_REF, runPipe, pipeHint } from "./text-pipe";
import { toolNameError } from "./token-id";
import { currentHasTool } from "./tool-exec";

/**
 * Build one agent tool: a JSON-schema function signature the model sees,
 * paired with a `run(args)` that executes in the page. Compose an array of
 * these and hand it to {@link module:ml.agent} — `ml.domTools` is just the
 * default array, so adding a tool is pushing another object (the "bash
 * tools" surface).
 *
 * @param {MlTool} tool
 * @returns {MlTool} The tool with defaults filled in.
 * @throws {Error} If `name` or a `run` function is missing.
 */
export const defineTool = function({ name, description = "", summary, parameters = { type: "object", properties: {} }, run, requiresApproval = false, capabilities = [], render, precheck }: Partial<MlTool> = {}): MlTool {
    if (!name || typeof run !== "function") {
        throw new Error("ml.defineTool needs a name and a run(args) function");
    }
    // The name goes into a `@tool:<name>` reference bare, so it has to be shaped like one — and must
    // not look like a generated id, which is what keeps the three reference forms tellable apart.
    // Thrown at DEFINITION time: a custom tool with an unusable name should fail where it is written,
    // not silently become uncitable halfway through a run.
    const nameErr = toolNameError(name);
    if (nameErr) throw new Error(`ml.defineTool: ${nameErr}`);
    return { name, description, summary, parameters, run, requiresApproval, capabilities, render, precheck };
};

/**
 * Build a "look" agent tool: it screenshots an element and returns a
 * vision-model *description* as text, so a text-only reasoning agent can
 * still "see" (icons, badges, greyed-out/sponsored styling, layout). Not
 * in ml.domTools by default because it needs a vision model and a capture
 * round-trip — opt in by composing it:
 *
 * ```js
 *   ml.agent(task, { extraTools: [ml.lookTool({ model: "qwen2.5vl" })] })
 *```
 *
 * @param {Object} [opts] Options object.
 * @param {string} [opts.model=null] Vision model for the description (null = the saved default).
 * @param {number} [opts.maxTokens=512] Hard cap on the description length.
 * @returns {MlTool} A tool with `name: "look"` and `capabilities: ["vision"]`.
 */
export const lookTool = function(this: MlApi, opts: { model?: string | null; maxTokens?: number; memory?: VisionMemory } = {}): MlTool {
    return buildLookTool(this, opts);
};

/**
 * Build a delegated Set-of-Marks `locate` tool (see builtin-tools/locate): find
 * an element by describing it, via a vision sub-call over a badged screenshot.
 * Auto-wired into ml.agent alongside `look` when a vision model resolves.
 *
 * @param {Object} [opts]
 * @param {string} [opts.model=null] Vision model that reads the badges.
 * @param {number} [opts.maxTokens=64] Cap on the sub-call (it returns a number).
 * @returns {MlTool} A tool with `name: "locate"` and `capabilities: ["vision"]`.
 */
export const locateTool = function(this: MlApi, opts: { model?: string | null; groundingModel?: string | null; groundingRange?: number; maxTokens?: number; memory?: VisionMemory } = {}): MlTool {
    return buildLocateTool(this, opts);
};

/**
 * Build a "click" interaction tool: click a link/button/tab/result.
 * Navigation, form submit, expand/collapse — irreversible, hence gated.
 * Interaction tools that DRIVE the page (real side effects), so they are
 * `requiresApproval` and deliberately NOT in the default read-only domTools —
 * opt in per task, gated by the approval flow:
 *
 * ```js
 *   ml.agent(task, { extraTools: [ml.clickTool(), ml.typeTool()] })
 * ```
 *
 * @returns {MlTool} A tool with `name: "click"` and `requiresApproval: true`.
 */
export const clickTool = function(this: MlApi): MlTool {
    return buildClickTool(this);
};

/**
 * Build a "type" interaction tool: type text into an input/textarea/contenteditable (e.g. a search
 * box), firing input/change so the page's JS reacts. Side-effecting (it can
 * trigger live search / autosave), so gated + opt-in like click. `submit`
 * presses Enter afterwards, so "search for X" is one call without eval.
 *
 * @returns {MlTool} A tool with `name: "type"` and `requiresApproval: true`.
 */
export const typeTool = function(this: MlApi): MlTool {
    return buildTypeTool(this);
};

/**
 * Build the `navigate(url)` tool: navigate the tab to another SAME-SITE URL, continuing the run on
 * the new page. Auto-wired into ml.agent unless `navigate: false`. Same-origin only in v1 — a
 * cross-origin URL is refused (`navTarget`) pending per-origin consent. The nav is DEFERRED a tick so
 * this tool's result posts back to the loop before the document unloads; the navigation barrier then
 * holds the next delegated tool until the fresh page re-adopts the run.
 *
 * @returns {MlTool} A tool with `name: "navigate"` (no approval for same-site).
 */
export const navigateTool = function(this: MlApi, opts: { crossOrigin?: boolean } = {}): MlTool {
    const ml = this;
    const allowCrossOrigin = !!opts.crossOrigin;
    return ml.defineTool({
        name: "navigate",
        // requiresApproval so a CROSS-ORIGIN nav hits the unforgeable gate (a page can't tell the agent
        // to silently jump to another site). SAME-ORIGIN navs auto-approve (no prompt) via autoApprove.
        requiresApproval: true,
        summary: allowCrossOrigin ? "Navigates the tab to another page (any site)." : "Navigates the tab to another same-site page.",
        description: "Navigate the browser tab to another URL (absolute or site-relative, e.g. " +
            "\"/step2\" or \"https://this-site.example/page\"). The run CONTINUES on the new page: after " +
            "navigating, `wait` for it to settle, then read/act as usual. " +
            (allowCrossOrigin
                ? "This run MAY cross to other SITES (different origins) — do so only when the task needs it, and never carry sensitive info from one site into another site's forms. "
                : "Same-origin ONLY — a cross-site URL is refused (tell the user instead). ") +
            "Prefer this over clicking a link when you already know the destination URL.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The URL to go to (absolute or site-relative, e.g. \"/dashboard\")." },
                verify: { type: "string", enum: ["viewport", "text", "text-all"], description: "Fold a view of the DESTINATION page into the result (saves a `wait`+`look`/`fetch` turn to see where you landed). \"viewport\" = a SCREENSHOT (an inline look); \"text\" = the page distilled to clean Markdown (nav/chrome stripped — cheaper, no vision needed); \"text-all\" = the same Markdown but keeping nav/header/footer. Omit to skip." },
                pipe: { type: "string", description: "Optional, only with verify:\"text\"/\"text-all\". Scan/filter the destination page's Markdown before it reaches you — e.g. \"grep -i '^## ' | head\" to see just the headings of where you landed. " + PIPE_REF },
            },
            required: ["url"],
        },
        // Show the DESTINATION in the approval card — a consent gate is meaningless without the URL the
        // agent wants to leave for. An `action` render → the sidebar's intent sentence ("Agent wants to
        // go to <url>", the url styled like a significant action). Resolve relative → absolute so the
        // origin is always visible.
        render: (_input: unknown, args?: Record<string, unknown>): RenderDescriptor => {
            const raw = String((args as { url?: unknown } | undefined)?.url ?? "");
            let shown = raw;
            try { shown = new URL(raw, location.href).href; } catch { /* keep raw */ }
            return { type: "action", verb: "go to", target: shown };
        },
        run: async ({ url }: { url?: unknown } = {}): Promise<string> => {
            const t = navTarget(typeof url === "string" ? url : "", location.href, { allowCrossOrigin });
            if ("error" in t) return `Error: ${t.error}`;
            // Defer so the RESULT posts back to the (background) loop before the document unloads —
            // otherwise the delegated-tool round-trip is lost and the run can't record the nav.
            setTimeout(() => { try { location.href = t.dest; } catch { /* navigation blocked */ } }, 0);
            return `Navigating to ${t.dest} …${t.crossOrigin ? " (a DIFFERENT site — the run continues there)" : ""} wait for the new page to load, then continue.`;
        },
    });
};

/**
 * Build the `fetch_url` tool: GET a URL's content via the background so the agent can READ a
 * file/API/other page WITHOUT navigating there. Uncredentialed by default; `credentials` fetches in the
 * user's session and `rendered` loads it in a tab so its JS runs (see the tool description).
 * requiresApproval — a new URL hits the unforgeable gate; an already-approved one auto-approves.
 * Auto-wired into ml.agent unless `fetch: false`.
 *
 * @returns {MlTool} A tool with `name: "fetch_url"` and `requiresApproval: true`.
 */
export const fetchTool = function(this: MlApi): MlTool {
    const ml = this;
    // Char budget for the ASK-mode reader sub-call: enough to fit a typical utility-model context
    // window (~6k tokens) with room for the question + answer; a larger body is clipped (and flagged).
    const FETCH_ASK_MAX = 24000;
    return ml.defineTool({
        name: "fetch_url",
        requiresApproval: true,   // a NEW url hits the unforgeable gate; an approved one auto-approves (autoApprove)
        summary: "Fetches a URL's content (GET) to read a file/API the page can't; optional as-you / rendered modes.",
        description: "GET a URL's content via the extension — bypasses CORS, and by default sends NO cookies. Use it to " +
            "READ a raw file, a JSON API, or another site WITHOUT navigating there (also works on pages " +
            "that block the extension, e.g. raw.githubusercontent.com). The result reports the body plus a " +
            "best-effort TYPE (json/csv/parquet/arrow/html/xml/markdown/code/text/binary) so you can chain — JSON comes " +
            "pre-parsed, a code file names its language. The type is a HEURISTIC " +
            "(resolved from the Content-Type header, a content sniff, and the URL extension — a server can " +
            "mislabel), not authoritative. GET only (no headers/body/auth). Each NEW url is approved once by " +
            "the user, then remembered for the session. Prefer this over `navigate` when you only need to READ a URL. " +
            "**TABLES (csv/tsv/parquet/arrow) come back PARSED, as a pandas-shaped object** — you do not need to split " +
            "the text, and you must not guess the separator: it is discovered (`,` `\\t` `;` `|`), quoted fields and " +
            "embedded newlines are handled, and numeric columns are cast. You get a `df.head()`: the header, the " +
            "first 5 rows, then `[N rows x M columns]` and `dtypes: <col> <dtype>, …` — pandas' own names " +
            "(`int64`, `float64`, `bool`, `str`, `object`), with pandas 3's rules, so text is `str` and a whole-number column holding one " +
            "blank is `float64` (NaN forces the float) and a Parquet file's dtypes are READ from its schema " +
            "rather than inferred. The row count is the FILE\'s, not the preview\'s — 5 rows shown out of " +
            "`[50,000 rows x 4 columns]` means there are 50,000. To work on ALL of them, pass the SAME URL to " +
            "python_exec\'s `tables` (e.g. `tables: { df: \"<the url>\" }`): it loads the already-parsed table " +
            "from the cache as a real DataFrame — no second request, and never `read_csv` (the sandbox has no " +
            "network). `schema: true` on a table returns just its shape + dtypes. Set `pipe` instead if you want " +
            "to scan the RAW text yourself — that skips the parsed preview and gives you the lines your scan selected. " +
            "Set `schema: true` when you KNOW it returns JSON and only need the STRUCTURE — you get a compact " +
            "TS-like shape (`{ id: number, items: { name: string }[] }`) instead of the whole payload (and a " +
            "clear error, saying what it actually was, if it isn't JSON). " +
            "Set `credentials: true` to fetch AS THE USER (sends their cookies) — for AUTHENTICATED data (a " +
            "private gist, a logged-in dashboard's API). It ALWAYS asks the user (never remembered) and is " +
            "never cached; use it ONLY when public access won't do. " +
            "Set `rendered: true` when a plain GET returns an EMPTY / skeleton page because the content is " +
            "drawn by JavaScript (a client-rendered SPA, an infinite-scroll feed's first screen): it opens the " +
            "URL in a background tab so the page's JS runs, then returns the SETTLED DOM — with cookie/consent/ad " +
            "overlays heuristically stripped. It renders in an INCOGNITO tab (NO session/cookies — a safe read), " +
            "so a SAME-ORIGIN render is FREE (no prompt, like a same-origin navigate) and a cross-origin one asks " +
            "once then is remembered (both need the extension's 'Allow in Incognito' setting on — you'll get a " +
            "clear message if it's off). ADD `credentials: true` to render in the USER'S logged-in SESSION instead " +
            "(a normal tab that carries their cookies — for a page that only shows content when signed in); that " +
            "runs as-the-user so it ALWAYS re-asks, same-origin or not, and is never remembered. " +
            "Either way it's slower/heavier than a raw GET; reach for it only when the raw fetch's HTML is clearly " +
            "unrendered. It waits for the page to settle (not a fixed delay) and scrolls to trip lazy content; a few " +
            "widgets that only load when signed-in or focused/visible may still not appear in a background render " +
            "(credentials:true covers signed-in; enabling CDP in settings lets it emulate foreground). Never cached. " +
            "Set `ask: \"<question>\"` to have a fast reader model READ the fetched content and answer that " +
            "question — you get back the ANSWER, not the (possibly huge) body, so a big page/API never floods " +
            "your context. Use it when you need a FACT out of the content, not the raw bytes to process further. " +
            "An HTML page is auto-converted to clean Markdown (scripts/nav/chrome stripped) so you get the " +
            "readable content, not tag soup. Better still, many docs sites PUBLISH their own Markdown version of a page — " +
            "this NEGOTIATES for it (asking the server, then following any version the page declares, then a " +
            "conventional `.md` URL) and falls back to converting the HTML itself, so you usually get the site's " +
            "authored text rather than our reduction of its markup. Set `format: \"html\"` if you specifically " +
            "need the original markup and no negotiation. " +
            "**NOTE:** When a user asks you to get information from a user-facing HTML page, assume the user " +
            "wants you to actually navigate them to a page by default so that they see the information themselves. " +
            "You can still use this tool to fetch the information for your own usage, but navigate the user so that " +
            "they have parity to you. Only when the prompt is clearly indicative of a programmatic lookup or the user " +
            "clearly does not want to see your work should you use this tool without updating the user's web browser view " +
            "(e.g. querying an API to locate the target in the background before navigating the user, or answering a question " +
            "that does not indicate the user would like to see the page/information off the page themselves). Users most " +
            "likely do NOT want to see raw text documents or JSON, but generally MAY be interested to see user-facing HTML " +
            "pages.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The absolute http(s) URL to fetch. The page you are on is free in every mode; with rendered + credentials it returns that page's live DOM (the only mode that reads a local file:// page)." },
                schema: { type: "boolean", description: "If true, return a compact TS-like SHAPE of the JSON (not the body). Errors if the URL isn't JSON." },
                credentials: { type: "boolean", description: "If true, fetch AS THE USER (send their cookies) for authenticated data. Always prompts; never cached/remembered." },
                rendered: { type: "boolean", description: "If true, load the URL in a background tab so its JavaScript runs, then return the SETTLED DOM — for client-rendered/SPA pages a raw GET returns empty. Renders in INCOGNITO (no session/cookies): same-origin is FREE, cross-origin asks once then remembered (needs 'Allow in Incognito'). Add credentials:true to render in the user's SESSION (a normal tab with cookies) — always re-asks. Slower/heavier; never cached." },
                ask: { type: "string", description: "If set, a fast reader model reads the fetched content and answers THIS question; you get the answer, not the body (keeps a large page out of your context). Takes precedence over `schema`." },
                format: { type: "string", enum: ["markdown", "html"], description: "What DOCUMENT to fetch. \"markdown\" (default) negotiates for the site's own Markdown version of the page and falls back to converting its HTML. \"html\" returns the ORIGINAL markup in one plain request, no negotiation — for when you need the markup itself (a selector, an attribute, an embedded script). Data bodies (JSON/CSV/code) are unaffected either way." },
                header: { type: "boolean", description: "For a CSV/TSV only. Whether the first row is a HEADER. Detected automatically (a row of text over columns of numbers is a header), so pass this only to CORRECT it: `false` when the file starts straight into data and the columns came back named after the first record, `true` when a real header was mistaken for data. With no header the columns are numbered by position, exactly as read_csv(header=None)." },
                pipe: { type: "string", description: "Optional. SCAN/FILTER the returned text through a small shell-style pipeline BEFORE it reaches you — so you read only the relevant lines instead of the whole doc (cheaper). " + PIPE_REF + " For anything MORE COMPLEX than this dialect, use exec instead: `const { markdown } = await ml.fetch('<the url>');` then process that string with JS." },
            },
            required: ["url"],
        },
        // Show the URL in the approval card + the In render (an `action` render → "fetch <url>"). The
        // note flags the SCHEMA-only ask, and — importantly for consent — a CREDENTIALED (as-you) fetch.
        render: (_input: unknown, args?: Record<string, unknown>): RenderDescriptor => {
            const a = args as { url?: unknown; schema?: unknown; credentials?: unknown; rendered?: unknown; ask?: unknown; pipe?: unknown } | undefined;
            const note = a?.rendered ? (a?.credentials ? "rendered in your session (runs the page's JS)" : "rendered privately (incognito — no cookies, runs the page's JS)") : a?.credentials ? "as you (sends your cookies)" : a?.schema ? "schema only" : a?.ask ? undefined : "full page";
            // The ASK gets its OWN line (full text, never truncated), not squeezed into the inline note.
            const ask = (typeof a?.ask === "string" && a.ask.trim()) ? a.ask.trim() : undefined;
            const pipe = (typeof a?.pipe === "string" && a.pipe.trim()) ? a.pipe.trim() : undefined;
            return { type: "action", verb: "fetch", target: String(a?.url ?? ""), ...(note ? { note } : {}), ...(ask ? { ask } : {}), ...(pipe ? { pipe } : {}) };
        },
        run: async ({ url, schema = false, credentials = false, rendered = false, ask = null, format = "markdown", pipe = null, header = undefined }: { url?: unknown; schema?: boolean; credentials?: boolean; rendered?: boolean; ask?: unknown; format?: unknown; pipe?: unknown; header?: boolean } = {}, ctx?: import("./contract").ToolContext): Promise<string | ToolResult> => {
            if (typeof url !== "string" || !url.trim()) return "Error: fetch_url needs a `url`.";
            let r: import("./contract").FetchResult;
            const wantHtml = format === "html";
            try { r = await ml.fetch(url, { credentials, rendered, format: wantHtml ? "html" : "markdown" }); }
            catch (e) { return `Error: ${errText(e)}`; }
            const mislabel = r.typeByHeader && r.typeByHeader !== r.type ? ` (header said "${r.typeByHeader}")` : "";
            // A LIVE read is not a fetch, and saying "HTTP 200" about it would claim a request that never
            // happened. What the model needs to know is that this is the DOM NOW, not the file on disk.
            const head = r.live
                ? `Read ${r.url} as rendered in your session: it is the page you are on, so this is its live DOM now (changes since load included, overlays not stripped), not a fresh load and not the ${/^file:/i.test(r.url) ? "file's bytes on disk" : "server's bytes"}.`
                : `Fetched ${r.url} — HTTP ${r.status}, type: ${r.type}${r.language ? ` (${r.language})` : ""}${mislabel}${r.truncated ? " · body truncated" : ""}.`;
            // HTML → Markdown by DEFAULT (readability): an HTML page is mostly slop (scripts/nav/chrome) to a
            // reading model, so distil it unless `raw` is set. Only HTML — json/csv/code/text/markdown are
            // already clean. Applies to BOTH the normal view and the ask-mode reader input.
            const converted = r.type === "html" && !wantHtml && !schema && r.json === undefined;
            // Say WHOSE Markdown this is. The site's own is authored for reading and is the better text;
            // ours is a reduction of the page's markup with nav/header/footer stripped. A model that
            // can't tell them apart can't judge whether a missing detail was never there or was cut.
            const by = r.negotiation?.resolvedBy;
            const mdNote = converted
                ? "\n\n(This page was HTML; the tool converted it to Markdown itself for readability — nav/header/footer stripped. Re-run with \"format\": \"html\" for the original markup.)"
                // A rung that RESOLVED is not a rung that found Markdown: a non-HTML first response (a JSON
                // API, an unrecognised body) also stops the ladder as `accept`. Only a hit is the site's own.
                : (by === "declared" || by === "sibling" || (by === "accept" && r.negotiation?.attempts?.find((a) => a.strategy === "accept")?.outcome === "hit"))
                ? `\n\n(This is the SITE'S OWN Markdown version of the page${by === "declared" ? ", the one it declares for agents" : by === "sibling" ? ", from its .md URL" : ", served by content negotiation"} — authored text, not our conversion of the HTML. Re-run with "format": "html" for the original markup.)`
                : "";
            // The body to read/return: converted Markdown for HTML (unless raw), else the JSON/raw text.
            // ml.fetch already attached `.markdown` for HTML; reuse it (fall back to a fresh conversion).
            const bodyText = (): string => r.json !== undefined ? JSON.stringify(r.json, null, 2) : (converted ? (r.markdown ?? htmlToMarkdown(r.text)) : r.text);
            // `pipe`: SCAN/FILTER the body through the safe line-scanning dialect (PIPE_CMDS). Applied to
            // BOTH the default view AND (BEFORE) the ask-reader input, so both see the filtered stream. Pure
            // text; on a bad command it returns { err } → an actionable message pointing at the exec escape
            // hatch. The FOOTER states the result's size (lines / chars, vs source) so the model has a
            // reference for what it's operating on. `pipeStr` is the trimmed pipe (falsy = no pipe).
            const pipeStr = typeof pipe === "string" && pipe.trim() ? pipe.trim() : "";
            /** ONE In descriptor for every return path, so no path can quietly drop a field. It used to
             *  be built per-path, which is why a credentialed PIPED fetch lost its "as you" note. Carries
             *  the Markdown ladder's trace when negotiation ran — the sidebar draws it as a resolution
             *  tree, and the export mirrors it. */
            const inRender = (extra: Record<string, unknown> = {}): RenderDescriptor => ({
                type: "action", verb: "fetch", target: r.url,
                ...(credentials ? { note: "as you (sends your cookies)" } : rendered ? { note: "rendered (ran the page's JS)" } : {}),
                ...(pipeStr ? { pipe: pipeStr } : {}),
                ...(r.negotiation ? { attempts: r.negotiation.attempts, resolvedBy: r.negotiation.resolvedBy } : {}),
                ...extra,
            } as RenderDescriptor);
            const nlines = (s: string): number => s === "" ? 0 : s.replace(/\n$/, "").split("\n").length;
            const doPipe = (src: string): { text: string; footer: string; err?: string } => {
                if (!pipeStr) return { text: src, footer: "" };
                let out: string;
                try { out = runPipe(src, pipeStr); }
                // The exec escape-hatch hint only makes sense when `exec` is actually wired this run — gate it.
                catch (e) { const escape = ctx?.hasTool("exec") ? ` For anything more complex, use exec: \`const { markdown } = await ml.fetch(${JSON.stringify(r.url)}${r.live ? ", { rendered: true, credentials: true }" : ""});\` then process the string in JS.` : ""; return { text: src, footer: "", err: `${head}\n\nPipe error: ${errText(e)}${pipeHint(errText(e))}${escape}` }; }
                // Minified source (essentially one line, but large) → line tools can't split it usefully. This
                // is the RAW-HTML footgun: grep/head over a one-line minified page is near-useless. Nudge to
                // drop raw:true (the default HTML→Markdown lines up cleanly) or otherwise reformat first.
                const srcLines = nlines(src);
                const minified = srcLines <= 2 && src.length > 800;
                const warn = minified ? ` — ⚠ the source is ${srcLines} line${srcLines === 1 ? "" : "s"} (minified?), so line tools couldn't split it${r.type === "html" && wantHtml ? "; drop \"format\": \"html\" to pipe the clean Markdown instead" : ""}` : "";
                return { text: out, footer: `\n\n(piped through \`${pipeStr}\`: ${nlines(out)} lines, ${out.length.toLocaleString()} chars — filtered from ${srcLines} source lines${warn})` };
            };
            // ASK mode: distill the body through a fast reader model (extend:"utility") instead of returning
            // it — a large page/API answers a question without ever entering the driver's context (the
            // look/read delegate-and-distill pattern, for text). Metered as a sub-call (runs under inAgentRun).
            if (typeof ask === "string" && ask.trim()) {
                const question = ask.trim();
                // pipe FIRST (if set): the reader answers over the FILTERED stream, not the whole page.
                const pp = doPipe(bodyText());
                if (pp.err) return pp.err;
                const body = pp.text;
                const clipped = clipOut(body, FETCH_ASK_MAX);
                const cut = clipped.length < body.length;
                // Tell the reader the content is a PIPE-PROCESSED partial view (so it doesn't assume it's the
                // whole page / treats a missing detail as "filtered out", not "absent from the source").
                const pipeForReader = pipeStr ? ` — PRE-FILTERED through the shell pipe \`${pipeStr}\`, so this is a PARTIAL view of the page, not the whole document` : "";
                const beforeU = subcallUsage();   // the reader sub-call's cost (model + tokens) for the render
                let answer: string;
                try {
                    answer = await ml.chat(
                        `Content fetched from ${r.url} (${r.type}, HTTP ${r.status}${pipeForReader}${cut ? ", truncated" : ""}):\n\n${clipped}\n\n---\nUsing ONLY the content above, answer concisely. If the answer isn't present in it, say so plainly.\n\nQuestion: ${question}`,
                        // A summariser needs a window sized to the content, not the tiny utility default —
                        // else Ollama silently drops the top of a big page. Residency guard reuses a bigger
                        // resident model for free (see background prepareRequest); only a fresh load is bounded.
                        { extend: "utility", numCtx: askReaderNumCtx(clipped.length) },
                    ) as string;
                } catch (e) { return `${head}\n\nError reading the content to answer: ${errText(e)}`; }
                // Which model answered + how many tokens it spent — the subcallUsage DELTA around the chat
                // (metered in bus.ts while inAgentRun). Best-effort: 0/unknown just omits that render line.
                const afterU = subcallUsage();
                const tokens = (afterU.prompt - beforeU.prompt) + (afterU.completion - beforeU.completion);
                const prevCalls = new Map((beforeU.byModel || []).map(m => [m.model, m.calls]));
                const answeredBy = (afterU.byModel || []).find(m => (m.calls - (prevCalls.get(m.model) || 0)) > 0)?.model || null;
                const content = `${head}\n\nAnswer${cut ? " (the content was truncated before reading — it may be incomplete)" : ""}:\n${answer}${mdNote}${pp.footer}`;
                const renderIn: RenderDescriptor = inRender({
                    ask: question,
                    ...(answeredBy ? { answeredBy } : {}), ...(tokens > 0 ? { tokens } : {}),
                    // The content handed to the reader — the in-the-middle step, so the distill is auditable
                    // (like locate's per-substep prompt). JSON is highlighted; a converted HTML page shows as
                    // the Markdown the reader actually saw, not the original tag soup.
                    askBody: clipped, askBodyLang: r.json !== undefined ? "json" : converted ? "markdown" : "text",
                    ...(cut ? { askBodyTruncated: true } : {}),
                });
                return { content, renderIn };
            }
            // `schema: true` on a TABLE means the same thing it means for JSON — the structure without
            // the payload — so it answers with the frame rather than erroring "isn't JSON". For a CSV
            // the structure IS the columns and their dtypes.
            if (schema && r.table) {
                const t = r.table;
                return { content: `${head}\n\n${tableShape(t)}`, renderIn: inRender() };
            }
            // `schema: true` — the caller wants the JSON's STRUCTURE, not the body.
            if (schema) {
                if (r.json === undefined) {
                    // Not JSON (or unparseable / truncated) — tell the model what it ACTUALLY was so it can adjust.
                    const why = r.truncated ? "the body was too large to parse whole" : `it's ${r.type}, Content-Type: ${r.contentType || "(none)"}`;
                    return `Error: you asked for the JSON schema, but ${r.url} isn't JSON — ${why}${mislabel}. First bytes:\n\n${clipOut(r.text, 600)}`;
                }
                const sig = r.schema ?? jsonShape(r.json), rawJson = JSON.stringify(r.json, null, 2);
                // If the shape is bigger than the payload itself (a tiny/flat object), just dump the JSON.
                if (sig.length >= rawJson.length) return { content: `${head}\n\n${clipOut(rawJson, 4000)}\n\n(raw JSON shown — its schema would be larger than the object itself.)`, renderIn: inRender() };
                return { content: `${head}\n\nJSON schema:\n${clipOut(sig, 4000)}`, renderIn: inRender() };
            }
            // Default: the body (HTML → Markdown unless raw), optionally scanned through `pipe` (which the
            // model uses to filter a big doc to the relevant lines BEFORE the clip). For a LARGE json, prepend
            // the shape so the structure survives the clip — but only when NOT piped (a piped body is already
            // a filtered view) and the shape is actually SMALLER than the payload.
            // An explicit `header` re-parses the body for THIS call only. The cached result keeps the
            // auto-detected table: an override is one caller's correction, not a fact about the file,
            // and rewriting the cache would hand the next reader a table it never asked for.
            if (typeof header === "boolean" && r.table && r.type === "csv") {
                try { r = { ...r, table: asTable(tableFromDelimited(r.text, { header }), { python: currentHasTool("python_exec") }) }; } catch { /* keep the detected one */ }
            }
            // A TABLE the parser understood, and the model did not ask for its own scan of the raw text:
            // show a `df.head()` rather than 4000 characters of rows. The clip is the reason — on a
            // 48,000-row CSV it leaves the first sixty rows and hides that there are 48,000, so the model
            // cannot tell whether an answer covers the file. A head plus `shape` plus `dtypes` is COMPLETE
            // information about the table, at a fraction of the tokens. `pipe` opts out, as asked: a model
            // that wrote a scan wants the lines its scan selected, not our summary of the whole.
            if (r.table && !pipeStr) {
                const t = r.table;
                const content = `${head}${mdNote}\n\n${tablePreview(t, { source: JSON.stringify(r.url) })}`;
                // The rendered Out is the table itself — which also mints a `table` POINTER (the loop reads
                // the descriptor's kind), so a later step can `dereference … | keys` for the columns. Capped:
                // this descriptor rides the debug stream and the JSON export, and a whole CSV does not belong
                // in either. python_exec gets the FULL table from the fetch cache, by URL.
                return { content, render: { type: "table", columns: t.columns, rows: t.rows.slice(0, RENDER_TABLE_ROWS), rowCount: t.shape[0], dtypes: t.dtypes, ...(t.delimiter ? { delimiter: t.delimiter } : {}), ...(t.headerless ? { headerless: true } : {}), ...(t.rows.length > RENDER_TABLE_ROWS ? { truncated: true } : {}), ...(r.valueKey && t.truncated ? { value: r.valueKey } : {}) }, renderIn: inRender() };
            }
            const pd = doPipe(bodyText());
            if (pd.err) return pd.err;
            const body = pd.text;
            const shapeLine = (!pipeStr && r.json !== undefined && r.schema && (r.truncated || body.length > 600) && r.schema.length < body.length)
                ? `JSON schema: ${r.schema}\n\n` : "";
            // The pipe footer (size/lines) goes at the END, so the model has a reference for the doc it got.
            const buildTool = (t: string): string => `${head}${mdNote}\n\n${shapeLine}${t}${pd.footer}`;
            return { content: buildTool(clipOut(body, 4000)), renderIn: inRender() };
        },
    });
};

/**
 * Agent tool wrapping {@link module:ml.pythonExec} — sandboxed Python (numpy/Pillow)
 * for pixel/array work. Opt-in like clickTool; `requiresApproval` (arbitrary code). A
 * returned `[x,y]`/`{x,y}` becomes a clickable `@pt`, a box an `@box`, a base64 image is
 * shown — the same coordinate currency as locate.
 *
 * @returns {MlTool} A tool with `name: "python_exec"` and `requiresApproval: true`.
 */
export const pythonTool = function(this: MlApi): MlTool {
    return buildPythonTool(this);
};

/**
 * A read-only self-introspection tool for `ml.agent` — pass it via `extraTools` (it is NOT a default
 * tool). Lets the agent answer questions about ITSELF: which model it's on, its context window and
 * how much is used, tokens generated so far this run, the message/image counts, and the model's
 * capabilities. The agent LOOP answers it (it holds the live token/message state), so the numbers are
 * accurate on both the page and background paths. Handy in the HUD, unneeded for most automation.
 *
 *   ml.agent(task, { extraTools: [ml.chatMetaTool()] })
 *
 * @returns {MlTool} A tool with `name: "chat_metadata"`, no args, no approval.
 */
export const chatMetaTool = function(this: MlApi): MlTool {
    return {
        name: "chat_metadata",
        description: "Report metadata about THIS conversation: the model you're running on, its context window and how much of it is used, how many tokens you've generated this run, the number of messages and images so far, which features the model supports (tools/vision/thinking), and where the user is when they are NOT on your page (a \"user focus\" line; no such line means they are on it). Call it when the user asks about your model, context, or token usage, or before relying on them seeing the page. Read-only; costs nothing.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        requiresApproval: false,
        capabilities: ["meta"],
        summary: "Introspect this run: model, context, tokens, messages.",
        // Answered by the agent loop (it owns the live stats); this stub never runs.
        run: async () => "(chat_metadata is answered by the agent loop)",
    } as MlTool;
};
