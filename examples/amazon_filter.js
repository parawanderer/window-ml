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
// The generic devtools *workflow* is built into ml.agent's default prompt, so all
// we supply is task FACTS (`hints`) + ONE custom action tool (hideElements) — the
// "minimal setup" the agent is designed for. The loop, step cap, and action all
// live HERE, on your side; window.ml stays a primitive.

(async () => {
    // window.ml is synchronous once injected; this is the canonical ready-wait
    // in case the script somehow runs first (see the README).
    const ml = await (window.ml?.ready
        ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));

    // The task, in plain English. Edit this line to filter differently.
    const TASK =
        "Hide every search result that is Sponsored, and every result that is not " +
        "available to ship today or tomorrow. Leave all other results visible.";

    // Task-specific FACTS only. The generic devtools workflow (orient → locate →
    // walk up → verify → act → confirm → iterate) is built into ml.agent's default
    // system prompt — we pass these as `hints`, which APPEND to it (vs `system`,
    // which would replace the whole thing). This is the "minimal setup" the agent
    // is designed for: the model already knows *how*; we supply the *facts*.
    const HINTS = [
        "This page may be in Dutch (amazon.nl): sponsored = 'Gesponsord'; the fastest",
        "delivery is 'morgen' (tomorrow) — there is no 'today'. Confirm wording with",
        "sampleText rather than assuming.",
        "Result cards are `div[data-component-type=\"s-search-result\"]` (carry data-asin);",
        "in-grid SPONSORED cards also carry an `AdHolder` class — prefer that clean",
        "selector over text matching. Delivery text lives in `div[data-cy=\"delivery-recipe\"]`",
        "/ `.udm-primary-delivery-message`.",
        "IMPORTANT: sponsored content has more than one form — the in-grid cards, but",
        "ALSO a top brand banner and mid-page carousel/video blocks OUTSIDE the",
        "s-search-result grid (different markup, same 'Gesponsord' label). A grid-scoped",
        "selector misses them, so verify visually and hide those too.",
        "For a delivery filter you must read each card's text (a CSS selector can't),",
        "so hide with exec setting `style.display='none'` (never add empty CSS classes).",
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
        hints: HINTS,                      // task FACTS; the workflow is built in
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
