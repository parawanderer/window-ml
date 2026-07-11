// Instagram cat finder — a minimal, VISION-heavy window.ml *agent* example.
//
// Paste this whole file into the devtools console on an Instagram PROFILE page
// (a good cursed test: instagram.com/pewos_official — a cat-furniture brand, so
// telling cats from scratching posts is genuinely hard). It finds the first few
// grid photos that show a cat and hands them back as LIVE DOM nodes you can hover
// in the console.
//
// The whole point: MINIMAL setup. No custom tools, no strategy prompt — just the
// generic agent (its built-in workflow) + one vision tool. The model orients,
// reverse-engineers Instagram's obfuscated grid selector on its own, then looks
// at each post ONE AT A TIME (tight per-element crops via look's `index`) and
// designates the hits with `answer` — so the verdict is bound to the exact node.
//
// Requires:
//   1. the window.ml extension active on instagram.com (Site access), and
//   2. a VISION-capable model (qwen3.5:122b has vision). WITHOUT a vision tool the
//      agent correctly reports it can't judge image content instead of guessing.
//
// Note: Instagram's strict CSP blocks `exec` (eval) — but this leans on the DOM +
// vision tools, which don't eval, so it works fine on locked-down SPAs.

(async () => {
    const ml = await (window.ml?.ready
        ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));

    // Edit this line to find something else ("...that show a dog", "...a plant").
    const TASK = "Find the first 3 photos in this profile's grid that show a cat, and return those posts.";

    console.log("🐱 window.ml cat finder running…");
    const result = await ml.agent(TASK, {
        model: 'qwen3.5:122b',
        think: true,
        // The ONLY setup: give it eyes. lookTool reuses the resident vision model
        // (qwen3.5:122b), so no extra VRAM. The built-in prompt already knows to
        // classify a grid by looking at each item by index, not the whole page.
        extraTools: [ml.lookTool({ model: 'qwen3.5:122b' })],
        maxSteps: 40,          // per-item vision classification takes a look each
        approve: ml.approveOnce(),
        onStep: (ev) => ev.thought
            ? console.log(`#${ev.step} 💭`, ev.thought)
            : console.log(`#${ev.step} ${ev.tool}`, ev.arguments, "→", String(ev.result).slice(0, 160), ...(ev.elements || [])),
    });

    console.log(`✅ ${result.summary}`);
    console.log("🐱 cat posts (hover to highlight on the page):", result.elements);
})();
