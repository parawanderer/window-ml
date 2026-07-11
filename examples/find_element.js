// Find a DOM element by describing it — the simplest window.ml *agent* demo.
//
// Paste this into the devtools console on ANY page (no login needed — try
// https://example.com). Ask for an element in plain English and get the LIVE
// node back, hoverable in the console. This is the agent's "hello world":
// the default tools + one vision tool + a single ml.agent call.
//
// The nice bit: vision makes it typo-proof. This asks for 'Exampl Domain'
// (missing an 'e') — findByText finds nothing, so the agent LOOKS at the page,
// reads the real text, and returns the right element anyway.

(async () => {
    const ml = await (window.ml?.ready
        ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));

    const r = await ml.agent("Get me the element that says 'Exampl Domain'", {
        model: 'qwen3.5:122b',
        // Eyes — lets it recover from the typo by reading the page. Drop this and
        // it can still find exact text with findByText, but won't self-correct.
        extraTools: [ml.lookTool({ model: 'qwen3.5:122b' })],
        onStep: (ev) => ev.thought
            ? console.log(`#${ev.step} 💭`, ev.thought)
            : console.log(`#${ev.step} ${ev.tool}`, ev.arguments, "→", String(ev.result).slice(0, 120), ...(ev.elements || [])),
    });

    console.log(`✅ ${r.summary}`);
    console.log("element (hover to highlight on the page):", r.elements[0]);
})();
