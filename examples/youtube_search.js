// "Search for cat videos" — the tiniest window.ml *page-driving* demo.
//
// Paste this into the devtools console on https://www.youtube.com. The agent
// finds the search box, types the query, and submits — from plain English, with
// no selectors and no loop on your side.
//
// This one DRIVES the page (types + presses Enter), so it needs the opt-in
// interaction tools. They have real side effects, so they're NOT in the default
// read-only tool set and each action is approval-gated — you'll get a confirm()
// to OK before it types/submits. Everything else is built in: the agent locates
// the box with its recon tools, and vision auto-wires if your model can see.
//
// Requires the window.ml extension active on youtube.com and a tool-capable
// model selected in the popup (bigger models drive the loop more reliably).

(async () => {
    const ml = await (window.ml?.ready
        ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));

    const r = await ml.agent("Search for cat videos.", {
        // Hand it the two page-driving tools (gated). typeTool can submit on its
        // own (Enter), clickTool is there in case it prefers the search button.
        extraTools: [ml.typeTool(), ml.clickTool()],
        logDebug: true,   // watch each thought + tool call in the console
    });

    console.log(`✅ ${r.summary}`);
})();
