// The session views are SHARED: the in-page sidebar, the DevTools panel and the Commander HUD render them in an
// extension frame, and the chat page's core (docs/spec/CHAT_PAGE.md) will render them in a plain web page and a
// phone app, where there is no `chrome` and no parent frame. So every module they reach calls its host through the
// services seam (src/sidebar/services.ts) instead. This walks their imports from the roots and fails on a direct
// `chrome.*` call or a post to the parent frame, so the seam cannot quietly erode.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src");
/** The views the chat core reuses, and the state they reduce into. */
const ROOTS = ["sidebar/session-detail.tsx", "sidebar/reply.tsx", "sidebar/agent-detail.tsx", "sidebar/composer.tsx", "sidebar/debug-reducer.ts", "sidebar/store.ts"];
/** The extension frames' own implementation of the seam: the one place those calls belong. */
const ALLOWED = new Set(["sidebar/services-ext.ts"]);

/** Strip comments, roughly but safely for this purpose: a comment that NAMES a call is not a call. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

function resolve(from, spec) {
    const base = path.resolve(path.dirname(path.join(SRC, from)), spec);
    for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
        const f = base + ext;
        if (fs.existsSync(f) && fs.statSync(f).isFile()) return path.relative(SRC, f);
    }
    return null;
}

function closure() {
    const seen = new Set();
    const queue = [...ROOTS];
    while (queue.length) {
        const f = queue.shift();
        if (seen.has(f)) continue;
        seen.add(f);
        const text = fs.readFileSync(path.join(SRC, f), "utf8");
        for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["'](\.[^"']+)["']/g)) {
            if (/^\s*(?:import|export)\s+type\b/.test(m[0].trim())) continue;   // erased at build
            const r = resolve(f, m[1]);
            if (r && !r.endsWith(".css")) queue.push(r);
        }
    }
    return [...seen];
}

test("the shared session views reach no chrome.* call and no parent frame, except through the services seam", () => {
    const files = closure();
    assert.ok(files.length > 10, `walked the imports (${files.length} modules)`);
    const offences = [];
    for (const f of files) {
        if (ALLOWED.has(f)) continue;
        const lines = code(fs.readFileSync(path.join(SRC, f), "utf8")).split("\n");
        lines.forEach((l, i) => {
            if (/\bchrome\s*\.\s*(runtime|storage|permissions|tabs|devtools|debugger|scripting|commands|action)\b/.test(l)) offences.push(`${f}:${i + 1} chrome: ${l.trim()}`);
            if (/\bwindow\.parent\.postMessage\b/.test(l)) offences.push(`${f}:${i + 1} parent: ${l.trim()}`);
        });
    }
    assert.deepEqual(offences, [], "route these through services() (src/sidebar/services.ts)");
});

test("the extension services are NOT in the shared closure: only an entry point installs them", () => {
    assert.ok(!closure().includes("sidebar/services-ext.ts"));
});
