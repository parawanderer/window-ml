// Native vision demo — the agent SEES the page with its own eyes.
//
// Paste into the devtools console on a page full of outfits/looks (a fashion
// retailer's grid, a lookbook, a Pinterest board, ...). The agent picks the
// "silliest" ones — a judgement that ONLY works from the actual pixels — and
// hands them back as live DOM nodes.
//
// The point of this example is the vision path. Because the chosen model
// (`qwen3.5:122b`) is itself vision-capable, `ml.agent` wires up NATIVE inline
// vision: each `look` screenshot goes straight into the model's OWN conversation,
// so it reasons over the real image. That's meaningfully sharper than the
// fallback — a text-only agent instead gets a delegated `ml.lookTool()`, where a
// second vision model describes the shot as text and the agent plans over that
// lossy summary. Same task, native is just better.
//
// Requires a vision-capable model available on your server (here qwen3.5:122b).

(async () => {
    const ml = await (window.ml?.ready
        ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));

    const r = await ml.agent(
        "Find me the top 3 silliest fashion outfits on this page as DOM selectors and describe why you chose those.",
        {
            model: "qwen3.5:122b",   // vision-capable → ml.agent uses NATIVE inline vision
            logDebug: true,          // watch it look, describe, and decide in the console
            maxSteps: 60,            // per-item visual classification takes many steps — give it room
            think: true,             // let it reason before acting
        }
    );

    console.log(`✅ ${r.summary}`);
    // The outfits it designated (via the built-in `answer` tool) come back as
    // LIVE DOM nodes — hover them in the console to highlight them on the page.
    console.log("chosen outfits:", r.elements);
})();
