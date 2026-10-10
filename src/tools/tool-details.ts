// tool-details.ts — a tool's description split in two: the short form every call carries, and the details `agent_api_docs` serves.

// A tool description holds TRIGGERS (when to reach for an option: "a plain GET came back empty → `rendered`") and
// MECHANICS (how it behaves once used: incognito tabs, what re-asks, pandas' dtype rules). A model that does not know
// an option exists never looks it up, so triggers stay in the schema; the mechanics move to `agent_api_docs({ tool })`
// when the run has that tool, and are appended inline when it does not. Measured on 11 models before it shipped:
// docs/spec/PROMPT_BUDGET.md, step 3.

import type { MlTool } from "../contract/contract-agent";

/** `exec`'s short form: what to reach for and when; the mechanics are {@link TOOL_DETAILS}.exec. */
export const EXEC_SHORT = (cap: number, ceiling: number): string =>
    "Escape hatch: run JS in the page, like one console cell. You get back what it console.logs AND its final " +
    "value (`await` and `return` work). Each is cut to " + cap + " chars, with a note saying how much you got: " +
    "return a compact summary, or `ml.schema(x)` for a big value's shape; `maxChars` (up to " + ceiling + ") with a " +
    "`maxCharsReason` asks the human for more room. Read-only code (queries plus `.map`/`.filter`/`.reduce`/`for…of`/" +
    "`ml.range`; no mutation, `.push`, `+=`, `while`/`for(;;)` or `for…in`) runs with NO approval prompt; anything " +
    "else asks the user first. `@tool:<id>` written in the code is that output as a plain value (no `await`). On " +
    "`ml`: `ml.pipe(text, \"grep x | head\")` filters any string; `ml.queryAll('host >>> inner')` pierces shadow " +
    "roots and same-origin iframes; `ml.a11y(el)` gives a control's role, name and the selector for click/type; " +
    "`ml.fetch(url)` reads another URL inline, and re-reading an approved one from a read-only survey is free; " +
    "`state` (`ml.state`) persists across calls: stash results and helpers there and reuse them. Use exec only " +
    "when the other tools can't answer.";

/** `fetch_url`'s short form: what to reach for and when; the mechanics are {@link TOOL_DETAILS}. */
export const FETCH_SHORT =
    "GET a URL via the extension (bypasses CORS; no cookies by default) to READ a raw file, a JSON API or another " +
    "site without navigating there. Each new URL is approved once. The result names a best-effort type; JSON comes " +
    "parsed, and an HTML page comes back as Markdown (the site's own when it publishes one; `format: \"html\"` for " +
    "the markup). TABLES (csv/tsv/parquet/arrow) come back PARSED, as a `df.head()` with the FILE's real row count " +
    "and dtypes: never split the text yourself; to use every row, pass the same URL to `python_exec`'s `tables`. " +
    "Options: `schema` (only a JSON's shape), `pipe` (scan the raw text), `ask` (a reader model answers a question " +
    "about the content, keeping a big body out of your context), `credentials` (as the user, with their cookies; " +
    "always asks), `rendered` (when a plain GET comes back empty because JavaScript draws the page). Prefer this " +
    "over `navigate` when only YOU need to read a URL, and always when the user asks you not to change their page; " +
    "when the user should SEE a user-facing page, `navigate` them there. Raw files and JSON they rarely want to see.";

/** `fetch_url`'s `rendered` parameter: the trigger only. */
export const FETCH_RENDERED_SHORT =
    "If true, run the page's JavaScript in a background tab and return the settled DOM: for a page a plain GET " +
    "returns empty. Slower; never cached.";

/** `locate`'s full description and parameter descriptions: the details `agent_api_docs({ tool: "locate" })` serves. */
const LOCATE_FULL = {
    description: "Find an on-screen control by DESCRIBING how it looks — for unlabelled icons, " +
            "custom widgets, canvas, or any UI you can't reach by text or a guessed selector. Returns a " +
            "CSS selector (or an `@pt:…` coordinate, for canvas) to pass to click/type/answer. Sees only " +
            "the current viewport (scroll the target into view first). " +
            "If the target sits on a <canvas> (a game/drawing surface — no DOM nodes inside it), FIRST " +
            "identify the canvas and pass ITS selector as `selector` so the search is cropped to it; the " +
            "result is an `@pt:…` coordinate token (there's no element to select), which you verify with " +
            "look({ selector: \"@pt:…\" }) and then click. On a busy canvas UI, zoom in with `container: " +
            "true` — the grounding model outlines a panel/card/toolbar and returns an `@box:…` region " +
            "token; scope back into it (selector: \"@box:…\") to find a control, recursing box→sub-box→@pt.",
    params: {
        description: "What to find, described by its APPEARANCE — colour, shape, icon, and any " +
                        "visible text — NOT by a name, brand, or role the vision model can't see (it reads " +
                        "pixels, not names). Good: \"a red heart icon\", \"a round blue button with a " +
                        "magnifying glass\", \"the star/favourite icon next to the chat title\". Bad: \"Big Pete\", " +
                        "\"the delete handler\", \"the submit button\" (say what it LOOKS like instead).",
        filter: "Which elements to consider (default 'clickables').",
        selector: "Optional CONTAINER selector to crop scanning to (a modal, a list row) — better for a small target in a busy area. For a target on a <canvas>, pass the canvas's selector here. For iframes or shadow roots, pass a selector to the iframe or shadow root parent element here! NOT the target's own selector. An `@pt:…` token also works: re-searches the box around that point with ANY strategy (e.g. grid inside a point).",
        index: "Which match of `selector` to scope to (0-based); default 0.",
        margin: "For 'grounding': grow the predicted box by N px (try 40–120) and re-match — when a box snapped to the WRONG element. Reuses the cached box (no 2nd vision call).",
        strategy: "Default 'auto'. 'grounding' = a coordinate model points at it (needs one configured; best for a clear spot). 'marks' = numbered badges, model picks by number (robust when cluttered). 'grid' = a numbered grid, model picks the CELL (any vision model; zoom with `cells` or raise `gridSize`). 'grid-grounding' = grid narrows to a cell, THEN grounding points precisely inside it (needs a grounding model; best for a small target on a busy page or canvas, where a plain grid centre only grazes). 'auto' = grounding then marks.",
        region: "Coarse pre-crop by rough position BEFORE the grid — for a dense scene where the grid has too many near-identical cells to pick from (you can vaguely tell 'left'/'bottom' even when you can't read a cell number). Bands are full-length ('left' = left side, full height); corners are quadrants. Halves overlap, so if unsure which side, guess one and try the opposite on a miss. Composes with any strategy.",
        gridSize: "For 'grid': base cell count (default 4, 2–8; the grid maxes out ~60 cells). To go FINER, don't raise this — zoom with `cells` (a fresh grid inside a cell) or pre-crop with `region`.",
        cells: "A previously-returned cell selection (1, 2 adjacent, or a 2×2 block of 4). 'grid' draws a fresh grid inside it (recursive zoom); 'grid-grounding' grounds directly inside it (reuses the pick — no re-roll).",
        container: "Set true to OUTLINE a sub-area rather than pick a control — the grounding model boxes a container (a panel, card, toolbar, dialog) and returns an `@box:…` region token instead of a click point. Use it on a busy <canvas> UI to zoom in: get the container box, then locate({ selector: \"@box:…\", description: \"…\" }) to find a control INSIDE it (recurse as needed), and click the final `@pt:…`. Needs a grounding model.",
        verify: "For a result that is a DOM element or an `@box:…` region, also return its marked crop in THIS call, instead of a separate look(). A point/`@pt:…` result ALWAYS returns one. Default false: a DOM element selector usually needs no visual check.",
    },
};

/** `locate`'s description and parameter descriptions as every call carries them: the triggers (round 2,
 *  docs/spec/PROMPT_BUDGET.md). */
export const LOCATE: typeof LOCATE_FULL = {
    description: "Find an on-screen control by DESCRIBING how it looks: unlabelled icons, custom widgets, canvas, or any " +
        "UI you can't reach by text or a selector. Returns a CSS selector (or an `@pt:…` point, for canvas) for " +
        "click/type/answer. Sees only the current viewport. On a <canvas>, pass the canvas as `selector`; on a busy " +
        "canvas, `container: true` returns an `@box:…` region to search inside.",
    params: {
        description: "What it LOOKS like (colour, shape, icon, visible text), never a name or role the vision model " +
            "cannot see: \"a red heart icon\", not \"the submit button\".",
        filter: LOCATE_FULL.params.filter,
        selector: "A CONTAINER to crop to (a modal, a row, the <canvas>, an iframe or shadow host), not the target; or " +
            "an `@pt:…`/`@box:…` token to search around.",
        index: LOCATE_FULL.params.index,
        margin: "Grow a grounding box by N px (40–120) when it snapped to the wrong element; no second vision call.",
        strategy: "'auto' (default); 'grounding' a clear spot; 'marks' a cluttered area; 'grid' any vision model; " +
            "'grid-grounding' a small target on a busy page. Try another when a result is wrong.",
        region: "Pre-crop to a rough area (left, top-right, center…) when a grid has too many similar cells.",
        gridSize: "For 'grid': cells per side (default 4, 2–8). To go finer, zoom with `cells`.",
        cells: "Cells a previous grid result picked: zoom into them.",
        container: "Outline a panel/card/toolbar instead of a control: returns an `@box:…` to search inside.",
        verify: "Also return the marked crop for a DOM or `@box:…` result (an `@pt:…` result always has one).",
    },
};

/** Each split tool's MECHANICS, served by `agent_api_docs({ tool })` (or appended inline without that tool). */
export const TOOL_DETAILS: Readonly<Record<string, string>> = {
    exec: [
        "Output: either console.log what you want to inspect, or make the last line evaluate to it (e.g. " +
        "`[...document.querySelectorAll('.card')].map(c => c.innerText.slice(0,80))`), or both. Async: e.g. " +
        "`const r = await fetch('/api').then(x => x.json()); return r.length`. Don't dump whole elements or pages; a " +
        "bigger `maxChars` costs your own context.",
        "Auto-run: read-only BY CONSTRUCTION means only queries/reads and pure computation, including the read-only " +
        "`ml.*` reads. It runs in a mediated interpreter with no prompt; anything else falls back to real `eval` and " +
        "asks. So for a survey prefer `.map`/`.filter`/`.reduce`/`for…of` with `ml.range(n)`, and reach for mutation " +
        "or a while-loop only when the task needs it.",
        "Pointers: `@tool:abc1234`, `@tool:fetch_url` (the latest call of that tool) or `@tool:\"a label\"`. Every " +
        "pointer you name is resolved before the script starts, so `const rows = @tool:abc1234.split(\"\\n\");` works " +
        "as written. Inside a string or a comment it stays literal text.",
        "`ml.pipe` runs the same dialect as the tools' `pipe` parameter over ANY string (a survey's output, a fetch, " +
        "python's stdout); cheaper to write and get right than a `.split`/`.filter`/`.slice` chain.",
        "`ml.queryAll` is a piercing querySelectorAll returning an Array, in the DOM tools' selector dialect: `>>>` " +
        "crosses each shadow root (open, or closed and captured) and each same-origin iframe, and a trailing " +
        "`:contains(\"text\")` filters by visible text. Use it instead of hand-chaining `.shadowRoot`/`.contentDocument`.",
        "`ml.a11y(el)` → `{ role, name, state, selector }`, the same accessible-name cascade `interactives` uses " +
        "(aria-label → aria-labelledby → label/placeholder → text); hand-rolled `getAttribute('aria-label')` misses " +
        "cases. `ml.queryAll` and `ml.a11y` are read-only, so a survey composing them auto-runs.",
        "`ml.fetch(url)` is the `fetch_url` tool's GET, inline: it returns `{ url, status, ok, type: " +
        "'json'|'csv'|'html'|'code'|'text'|…, text, json?, schema? }` (full type: `agent_api_docs({ types: " +
        "[\"FetchResult\"] })`). For JSON, `.json` is parsed and `.schema` is its TS-like shape (`{ id: number, items: " +
        "{ name: string }[] }`), to learn a big payload's structure without dumping it. A NEW url asks once; re-reading " +
        "it from a read-only survey is then free (cached), like `python_exec` on a Google Sheet. Failures aren't " +
        "cached; `ml.fetch(url, { fresh: true })` skips the cache for a live re-fetch and needs approval, even for a " +
        "cached url.",
        "`state` is a live page kernel, like a notebook's cells: for multi-step work define helpers and stash " +
        "intermediate results ONCE, then reuse them (call 1: `state.rows = [...document.querySelectorAll('tr')]" +
        ".map(...)`; call 2: `state.rows.filter(r => r.total > 100).length`). It is one object for the whole page " +
        "session and every run in this tab, so it survives, but two parallel runs share it.",
    ].join("\n\n"),
    fetch_url: [
        "Also works on pages that block the extension (e.g. raw.githubusercontent.com). GET only: no request body and " +
        "no custom headers; `credentials: true` is the one way to send the user's cookies. A new url is remembered for " +
        "the session once approved.",
        "Type: json/csv/parquet/arrow/html/xml/markdown/code/text/binary, a HEURISTIC from the Content-Type header, a " +
        "content sniff and the URL extension (a server can mislabel). A code file names its language.",
        "Tables: the separator is discovered (`,` `\\t` `;` `|`), never assumed; quoted fields and embedded newlines " +
        "are handled; numeric columns are cast. The preview is the header, the first 5 rows, then `[N rows x M " +
        "columns]` and `dtypes: <col> <dtype>, …` in pandas' own names (`int64`, `float64`, `bool`, `str`, `object`) " +
        "under pandas 3's rules: text is `str`, a whole-number column holding one blank is `float64` (NaN forces the " +
        "float), and a Parquet file's dtypes are READ from its schema. 5 rows shown out of `[50,000 rows x 4 columns]` " +
        "means 50,000. `python_exec`'s `tables: { df: \"<the url>\" }` loads the already-parsed table from the cache as " +
        "a real DataFrame: no second request, and never `read_csv` (the sandbox has no network). `schema: true` on a " +
        "table returns its shape and dtypes. `pipe` skips the parsed preview and gives the raw lines your scan selected.",
        "`schema: true` on JSON returns a compact TS-like shape (`{ id: number, items: { name: string }[] }`) instead " +
        "of the payload, and a clear error saying what it was if it isn't JSON.",
        "`credentials: true` fetches AS THE USER for authenticated data (a private gist, a logged-in dashboard's API). " +
        "It ALWAYS asks (never remembered) and is never cached; use it only when public access won't do.",
        "`rendered: true` (a client-rendered SPA, an infinite-scroll feed's first screen) opens the URL in a " +
        "background tab so its JS runs and returns the SETTLED DOM, with cookie/consent/ad overlays heuristically " +
        "stripped. It renders in an INCOGNITO tab (no session or cookies): same-origin is free (no prompt, like a " +
        "same-origin navigate), cross-origin asks once and is remembered; both need the extension's 'Allow in " +
        "Incognito' setting (you get a clear message if it's off). With `credentials: true` too it renders in the " +
        "user's logged-in session (a normal tab with their cookies), which ALWAYS re-asks. Either way it is slower " +
        "than a raw GET: reach for it only when the raw HTML is clearly unrendered. It waits for the page to settle " +
        "and scrolls to trip lazy content; widgets that load only when signed in or visible may still be missing " +
        "(`credentials` covers signed-in; CDP on in settings lets it emulate the foreground). Never cached.",
        "`ask: \"<question>\"` hands the content to a fast reader model and returns its ANSWER, not the body: for a " +
        "FACT out of a big page or API, not the raw bytes to process further.",
        "HTML becomes clean Markdown (scripts, nav and chrome stripped). Many docs sites publish their own Markdown " +
        "version; this negotiates for it (asks the server, then follows a version the page declares, then a " +
        "conventional `.md` URL) and falls back to converting the HTML, so you usually get the site's authored text. " +
        "`format: \"html\"` returns the original markup with no negotiation.",
        "Showing vs fetching: when a user asks for information from a user-facing HTML page, assume they want to be " +
        "navigated there so they see it themselves; fetch it for your own use too if you like, but navigate them for " +
        "parity. If the user asks you not to change their page or what they are looking at, never navigate: fetch. " +
        "Otherwise skip the navigation only when the request is clearly a programmatic lookup or the user clearly does " +
        "not want to see your work (querying an API to locate a target before navigating, or a question that does not " +
        "suggest they want to see the page). Users rarely want raw text documents or JSON; they often do want " +
        "user-facing pages.",
    ].join("\n\n"),
    locate: [LOCATE_FULL.description, ...Object.entries(LOCATE_FULL.params).map(([k, v]) => `\`${k}\`: ${v}`)].join("\n\n"),
};

/**
 * Finish the split for one run: a tool with {@link TOOL_DETAILS} gets a pointer to them when `agent_api_docs` is in
 * the toolset, and the details themselves appended when it is not, so no run loses the text. Returns new tool objects; the shared definitions are never mutated.
 * @param toolset the run's tools
 * @returns the toolset with each split tool's description finished
 */
export function withToolDetails(toolset: MlTool[]): MlTool[] {
    const docs = toolset.some((t) => t.name === "agent_api_docs");
    return toolset.map((t) => {
        const more = TOOL_DETAILS[t.name];
        if (!more) return t;
        return { ...t, description: docs ? `${t.description} Details: \`agent_api_docs({ tool: "${t.name}" })\`.` : `${t.description}\n\n${more}` };
    });
}

/**
 * The `agent_api_docs({ tool })` section: a split tool's details, for a tool this run has.
 * @param name the tool asked about
 * @param hasTool whether the run has a tool by that name
 * @returns the section, or a line naming the tools that have one
 */
export function toolDetailsSection(name: string, hasTool: (n: string) => boolean): string {
    const have = Object.keys(TOOL_DETAILS).filter((n) => hasTool(n));
    const body = have.includes(name) ? TOOL_DETAILS[name] : undefined;
    if (body) return `## Tool reference: \`${name}\`\n\n${body}`;
    return `No tool reference for \`${name}\`.${have.length ? ` These tools have one: ${have.map((n) => `\`${n}\``).join(", ")}.` : ""}`;
}
