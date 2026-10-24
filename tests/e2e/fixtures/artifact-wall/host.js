// host.js — an extension page that embeds one sandboxed probe frame per route, as the sidebar embeds mermaid.html,
// and records what each frame said (tests/e2e/artifact-wall.spec.mjs reads `window.__said`).
window.__said = [];
addEventListener("message", (e) => { if (e.data && e.data.probe) window.__said.push(e.data); });
/** Embed a sandbox="allow-scripts" frame per probe name, each pointed at the counting servers in `cfg`. */
window.__embed = (names, cfg) => {
    for (const p of names) {
        const f = document.createElement("iframe");
        f.setAttribute("sandbox", "allow-scripts");
        f.src = `artifact-probe.html?${new URLSearchParams({ p, ...cfg })}`;
        document.body.append(f);
    }
};
/** Embed the evaluator frame (probe `eval`); resolves once its worker is ready, with the start-up time. */
window.__evalFrame = () => new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.src = "artifact-probe.html?p=eval";
    const answers = new Map();
    addEventListener("message", (e) => {
        if (e.source !== f.contentWindow || !e.data) return;
        if (e.data.ready) resolve({ startMs: e.data.startMs });
        else if (e.data.answer) answers.get(e.data.answer.id)?.(e.data.answer);
    });
    let n = 0;
    /** Run one script in the frame's evaluator. */
    window.__run = (code, current, globals) => new Promise((r) => { const id = ++n; answers.set(id, r); f.contentWindow.postMessage({ id, code, current, globals }, "*"); });
    document.body.append(f);
});
