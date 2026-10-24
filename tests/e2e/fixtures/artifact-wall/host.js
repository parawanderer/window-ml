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
