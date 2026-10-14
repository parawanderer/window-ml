// redteam-exec-console.test.mjs — what a page that shares the main world gets from, or puts into, a main-world exec's
// console capture and the DOM tools' closed-root capture (docs/spec/SITE_PRESENCE.md, Order step 1;
// docs/dev/detection-surface.md rows 9-11, findings 4-6).
//
// The page is code run in the same vm context as injected.js and shadow-patch.js (loadDomWorld): its own timers, its own
// `console`, and every global it can read or write. The CDP and isolated paths are in redteam-isolated.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadDomWorld } = require("./helpers");

const T = { timeout: 15000 };
/** The page's main world with window.ml, and a runner for the exec tool as a run calls it. */
function page(html = "<button>b</button>") {
    const w = loadDomWorld(html);
    const exec = w.ml.domTools.find((t) => t.name === "exec");
    /** Run `src` as page code, in the world the exec runs in. */
    const pageRun = (src) => vm.runInContext(src, w.context);
    return { ...w, exec: (js) => exec.run({ js }, {}), pageRun };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the console: a parameter, never a swap ---

test("the page's console is the same object with the same methods before, during and after a main-world exec", T, async () => {
    const p = page();
    p.pageRun(`
        globalThis.__orig = { c: console, m: ["log", "info", "warn", "error", "debug"].map((k) => console[k]) };
        globalThis.__same = (tag) => __seen.push([tag, console === __orig.c && ["log", "info", "warn", "error", "debug"].every((k, i) => console[k] === __orig.m[i])]);
        globalThis.__seen = [];
        setTimeout(() => __same("during"), 15);
    `);
    p.pageRun("__same('before')");
    const r = await p.exec("console.log('mine'); await new Promise((res) => setTimeout(res, 60)); return 1");
    p.pageRun("__same('after')");
    assert.match(r.content, /mine/, "positive control: the exec's own line was captured");
    assert.deepEqual(JSON.parse(JSON.stringify(p.pageRun("__seen"))), [["before", true], ["during", true], ["after", true]]);
});

test("a line the PAGE logs while a main-world exec runs never reaches the model's result", T, async () => {
    const p = page();
    p.pageRun("setTimeout(() => { console.log('PAGE SAYS DURING EXEC'); console.warn('PAGE WARNS'); }, 10)");
    const r = await p.exec("await new Promise((res) => setTimeout(res, 60)); console.log('mine'); return 1");
    assert.match(r.content, /mine/, "positive control");
    assert.doesNotMatch(r.content, /PAGE SAYS|PAGE WARNS/, r.content);
    assert.doesNotMatch(JSON.stringify(r.render ?? {}), /PAGE SAYS|PAGE WARNS/, "the panel's copy carried the page's line");
});

test("the exec's own lines are captured from awaited callbacks and timers that fire before it returns", T, async () => {
    const p = page();
    const r = await p.exec(`
        setTimeout(() => console.log('from a timer'), 5);
        await new Promise((res) => setTimeout(() => { console.info('from an awaited callback'); res(); }, 20));
        await Promise.resolve().then(() => console.warn('from a microtask'));
        return 1`);
    for (const l of ["from a timer", "from an awaited callback", "from a microtask"]) assert.match(r.content, new RegExp(l), r.content);
});

test("console reached through window or globalThis is the page's, not the collector (fails safe), and a late line goes to the page's console", T, async () => {
    const p = page();
    p.pageRun("globalThis.__pageLines = []; console.log = (...a) => __pageLines.push(a.join(' '));");
    const r = await p.exec("globalThis.console.log('via globalThis'); console.log('own'); setTimeout(() => console.log('late'), 30); 1");
    assert.match(r.content, /own/, "positive control");
    assert.doesNotMatch(r.content, /via globalThis/, "globalThis.console was collected");
    await sleep(60);
    assert.deepEqual(JSON.parse(JSON.stringify(p.pageRun("__pageLines"))), ["via globalThis", "late"]);
});

test("the model's view of a main-world exec opens with the page-writable heading, and its console section is the plain `console:`", T, async () => {
    const r = await page().exec("console.log('own'); 1");
    assert.match(r.content, /^page-writable \(ran in page world\):\nconsole:\nown\n\nvalue: 1$/, r.content);
});

// --- the closed-root capture: in closures, nothing on window ---

/** A page with a closed root captured by the patch, and piercing set by a run as a re-adopt sets it. */
function sealedPage() {
    const p = page("<sealed-widget></sealed-widget><other-widget></other-widget>");
    const host = p.document.querySelector("sealed-widget");
    host.attachShadow({ mode: "closed" }).innerHTML = '<button class="secret">real</button>';
    const pierce = (on) => p.ml._adoptRun(`pierce-${on}`, { toolNames: [], pierceClosed: on, builtBy: "worker" });
    const desc = (sel) => { const r = p.ml.domTools.find((t) => t.name === "describeElement").run({ selector: sel }); return String(r.content ?? r); };
    return { ...p, host, pierce, desc };
}

test("neither the closed-root map nor the pierce flag is on the page's global, before or after a run turns piercing on", T, () => {
    const p = sealedPage();
    p.pierce(true);
    assert.match(p.desc("button.secret"), /real/, "positive control: piercing reaches the captured closed root");
    for (const g of [p.window, p.context]) {
        const keys = Reflect.ownKeys(g).map(String).filter((k) => /closedroot|pierce/i.test(k));
        assert.deepEqual(keys, [], `a page-visible global names the capture: ${keys}`);
    }
});

test("a page cannot write into the captured closed-root map, through a global or WeakMap's builtins, to put a root behind another host", T, () => {
    const p = sealedPage();
    p.pierce(true);
    // The page's own closed root, with a decoy in it, attached to a host the tools then look behind.
    p.pageRun(`
        const decoyHost = document.createElement("div");
        const decoy = decoyHost.attachShadow({ mode: "closed" });
        decoy.innerHTML = '<button class="secret">DECOY</button>';
        const target = document.querySelector("other-widget");
        try { window.__mlClosedRoots?.set(target, decoy); } catch {}
        try { globalThis.__mlClosedRoots?.set(target, decoy); } catch {}
        const get = WeakMap.prototype.get;
        WeakMap.prototype.get = function (k) { return k === target ? decoy : get.call(this, k); };
        const set = WeakMap.prototype.set;
        WeakMap.prototype.set = function (k, v) { return set.call(this, k === target ? target : k, v); };
        // The reader the patch hands out: reading is all it does.
        const d = {};
        window.dispatchEvent(new CustomEvent("wml-closed-roots", { detail: d }));
        globalThis.__readerFound = typeof d.read === "function";
        globalThis.__readerSeesDecoy = typeof d.read === "function" && d.read(target) === decoy;
    `);
    assert.equal(p.pageRun("__readerSeesDecoy"), false, "the page's own reader returned its decoy for another host");
    assert.doesNotMatch(p.desc("other-widget >>> button.secret"), /DECOY/, "the DOM tools read the page's decoy behind other-widget");
    assert.match(p.desc("sealed-widget >>> button.secret"), /real/, "positive control: the real captured root still resolves");
});

test("a page that sets a pierce flag on its global does not turn piercing on", T, () => {
    const p = sealedPage();
    p.pierce(false);
    p.pageRun("window.__mlPierceClosed = true; globalThis.__mlPierceClosed = true;");
    assert.match(p.desc("button.secret"), /No element/, "the page's global turned piercing on");
    p.pierce(true);
    assert.match(p.desc("button.secret"), /real/, "positive control: a run's flag does");
});
