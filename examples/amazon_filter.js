// Amazon search filter — a window.ml *agent* example.
//
// Paste this whole file into the devtools console on an Amazon SEARCH RESULTS
// page (e.g. after searching "usb-c cable"). It tells a local LLM, in plain
// English, to hide the result cards you don't want — and the model works out the
// DOM on its own using window.ml's agent tools, exactly like you would by hand:
// find a title, walk UP to the repeating card, generalize a selector, verify it,
// then hide the bad ones with ONE rule.
//
// Requires:
//   1. the window.ml extension active on amazon.com (Site access), and
//   2. a tool-capable model selected (see ml.getModel() / the popup). Bigger
//      models drive the loop more reliably — loop reliability scales with size.
//
// The loop, the step cap, and the action all live HERE, on your side. window.ml
// stays a primitive. This also shows the extensibility point: we compose ONE
// custom tool (hideElements) on top of the generic ml.domTools.

(async () => {
    // window.ml is synchronous once injected; this is the canonical ready-wait
    // in case the script somehow runs first (see the README).
    const ml = await (window.ml?.ready
        ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));

    // The task, in plain English. Edit this line to filter differently.
    const TASK =
        "Hide every search result that is Sponsored, and every result that is not " +
        "available to ship today or tomorrow. Leave all other results visible.";

    // Task-specific strategy prompt. This is the part we deliberately keep OUT of
    // window.ml core: the loop is generic, the how-to lives with the task.
    const STRATEGY = [
        "You are filtering the current Amazon SEARCH RESULTS page by hiding result",
        "cards. You cannot see the page — use the tools to discover its structure.",
        "",
        "This page may NOT be in English.",
        "Never assume the wording; discover it with sampleText first.",
        "",
        "If the task or the page is unclear, call look with NO selector FIRST to see",
        "the page — a screenshot often makes the intended edit obvious, the way a",
        "glance at devtools would. look sees the viewport; pass scope:'page' to",
        "scroll+stitch the whole page when what you need is below the fold. Use look",
        "on a specific element to judge how it *looks* (greyed-out / sponsored).",
        "",
        "Method (like a human in devtools):",
        "1. Pick a visible product title and findByText it to get its element path.",
        "2. Walk UP with ancestors (describeElement goes DOWN) until you reach the",
        "   element that repeats once per result — the result CARD. On Amazon it's",
        '   `div[data-component-type="s-search-result"]` carrying a `data-asin`;',
        "   confirm with countMatches before trusting it (a search page has ~20-60).",
        "3. Find the signal for each filter. FIRST check whether the target cards",
        "   carry a distinguishing class or attribute (describeElement / inspect the",
        "   card's own classes — e.g. Amazon marks sponsored cards with an 'AdHolder'",
        "   class), because a CSS selector is simpler and more robust than text.",
        "   Otherwise READ cards with sampleText and confirm the exact wording (e.g.",
        "   'Gesponsord'). If a filter's signal is not present on the page (e.g. no",
        "   'delivery today' wording — the fastest may be 'morgen'/tomorrow), do NOT",
        "   guess — skip that filter and say so at the end.",
        "4. VERIFY before acting: countMatches / sampleText the cards you intend to",
        "   hide. If that matches all / none / an implausible number, reconsider.",
        "5. Apply each filter AS SOON AS it's verified — don't investigate every",
        "   filter before acting. Sponsored is easy: hide it",
        "   first with hideElements, THEN work out the delivery filter.",
        "   - If the cards to hide share a plain CSS selector, call hideElements.",
        "   - If the filter depends on TEXT inside each card (a 'Sponsored' label),",
        "     a CSS selector can't express it. Use exec to loop the cards and set",
        "     `card.style.display = 'none'` on the matching ones. Do NOT add CSS",
        "     classes — they have no styling and hide nothing. (You'll be asked to",
        "     approve exec once.)",
        "6. Sponsored content has MORE than one form: the in-grid result cards, but",
        "   ALSO a top brand banner and mid-page carousel/video blocks that live",
        "   OUTSIDE the s-search-result grid (different markup, same 'Gesponsord'",
        "   label). A selector scoped to the grid will miss them.",
        "7. VERIFY VISUALLY at the end: scroll to top and call look (and a scope:'page'",
        "   overview) to confirm nothing sponsored or too-slow-to-ship is still",
        "   visible. If something remains, find and hide that block too, then look",
        "   again — repeat until the page is clean.",
        "",
        "Prefer data-* attributes and structural anchors over Amazon's obfuscated,",
        "build-versioned class names. When done, reply with one line: how many cards",
        "you hid, by which filter, and any filter you had to skip.",
    ].join("\n");

    // The one custom ACTION tool, composed on top of the generic ml.domTools.
    // (ml.domTools already gives the model findByText / describeElement /
    // countMatches / sampleText / exec — the read-only "look around" tools.)
    const hideElements = ml.defineTool({
        name: "hideElements",
        description: "Hide every element matching a CSS selector (sets display:none). " +
            "Returns how many were hidden. This is the action that applies the filter.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector for the cards to hide." },
                reason: { type: "string", description: "Short note on why (for the log)." },
            },
            required: ["selector"],
        },
        run: ({ selector, reason }) => {
            let els;
            // _queryAll adds :contains()/:has-text() support on top of CSS.
            try { els = ml._queryAll(selector); }
            catch (e) { return `Invalid selector: ${e.message}`; }
            els.forEach(el => { el.style.display = "none"; });
            // content → the model; elements → your console (hover to highlight).
            return {
                content: `Hid ${els.length} element(s)${reason ? ` — ${reason}` : ""}.`,
                elements: els.slice(0, 50),
            };
        },
    });

    console.log("🤖 window.ml agent running…");
    const result = await ml.agent(TASK, {
        model: 'qwen3.5:122b',
        think: true,                       // surface the model's reasoning (below)
        system: STRATEGY,
        // ml.domTools (read-only probes) + your action + eyes. lookTool lets the
        // model screenshot the page (no selector) to ORIENT when the task is
        // vague, or an element to judge how it *looks* (sponsored/greyed-out).
        // qwen3.5:122b has vision, so this reuses the resident model — no extra VRAM.
        extraTools: [hideElements, ml.lookTool({ model: 'qwen3.5:122b' })],
        maxSteps: 45,       // two-filter task; give it room to explore AND act
        // exec (arbitrary JS) is gated. approveOnce remembers your answer per exact
        // (tool + arguments), so an identical repeat won't re-ask — but every NEW
        // exec script still has to be approved (you always see new code before it runs).
        approve: ml.approveOnce(),
        // Watch the loop live: reasoning (💭) interleaved with tool calls. Logged
        // in FULL (no truncation) — args and result go as separate console args so
        // multiline text stays readable, and `...(ev.elements || [])` appends the
        // real DOM nodes the tool touched so you can hover them (Chrome highlights
        // them on the page).
        onStep: (ev) => ev.thought
            ? console.log(`#${ev.step} 💭`, ev.thought)
            : console.log(`#${ev.step} ${ev.tool}`, ev.arguments, "→", ev.result, ...(ev.elements || [])),
    });

    console.log(`✅ ${result.summary} (${result.steps} steps${result.hitCap ? ", hit step cap" : ""})`);
    console.table(result.transcript);   // full tool-by-tool trace
})();
