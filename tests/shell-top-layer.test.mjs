// shell-top-layer.test.mjs — the keeper of the shell's hosts in the browser's top layer (src/sidebar/shell-top-layer.ts):
// what it raises and restores, in which order, from which signals, and that a page acting in a loop gets a bounded
// number of raises. Fake hosts and a fake clock here; the real browser's stacking, a modal, fullscreen and the
// capture are tests/e2e/review-look.spec.mjs ("the top layer").

import test from "node:test";
import assert from "node:assert/strict";

const { topLayerKeeper, onTopLayer, RAISE_BURST, RAISE_REFILL_MS, TOP_LAYER_POLL_MS } = await import("../src/sidebar/shell-top-layer.ts");
const { extensionRects } = await import("../src/sidebar/shell-shot.ts");

/** The browser's top layer: the open hosts, in the order they were shown (the last on top). */
function topLayerWorld() {
    const stack = [];
    let shows = 0;
    /** A fake popover host. `cancelShow` makes the page cancel its show in beforetoggle. */
    const host = (name) => {
        const h = {
            name, isConnected: true, attrs: {}, cancelShow: false,
            getAttribute: (a) => h.attrs[a] ?? null,
            setAttribute: (a, v) => { if (a === "popover" && h.attrs.popover !== v) h.hideSilently(); h.attrs[a] = String(v); },
            removeAttribute: (a) => { if (a === "popover") h.hideSilently(); delete h.attrs[a]; },
            matches: (q) => q === ":popover-open" && stack.includes(h),
            showPopover() {
                if (h.attrs.popover === undefined) throw new Error("not a popover");
                if (stack.includes(h) || h.cancelShow) return;
                shows++;
                stack.push(h);
            },
            hidePopover() { if (!stack.includes(h)) throw new Error("not open"); stack.splice(stack.indexOf(h), 1); },
            hideSilently() { if (stack.includes(h)) stack.splice(stack.indexOf(h), 1); },
        };
        return h;
    };
    const listeners = new Map(), observers = [];
    let fs = null;
    const doc = {
        listen(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); return () => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
        observe(target, filter, subtree, fn) { const o = { target, filter, fn }; observers.push(o); return () => observers.splice(observers.indexOf(o), 1); },
        fullscreenElement: () => fs,
        root: () => ({ nodeName: "HTML" }),
    };
    let now = 0, nextId = 1;
    const timers = new Map();
    const clock = {
        now: () => now,
        setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimeout: (id) => timers.delete(id),
        setInterval: (fn, ms) => { const id = nextId++; const t = { at: now + ms, fn: () => { t.at = now + ms; timers.set(id, t); fn(); }, every: ms }; timers.set(id, t); return id; },
        clearInterval: (id) => timers.delete(id),
    };
    return {
        host, doc, clock, stack, timers, listeners, observers,
        shows: () => shows,
        /** A page element entering the top layer: on the stack above ours, and its toggle event. */
        pageOpens(el = { nodeName: "DIALOG" }) { stack.push(el); for (const fn of listeners.get("toggle") ?? []) fn({ target: el, newState: "open" }); },
        /** The page's element entering fullscreen. */
        fullscreen(el) { fs = el; stack.push(el); for (const fn of listeners.get("fullscreenchange") ?? []) fn({ target: el }); },
        /** Fire the attribute observers watching `target`. */
        mutate(target) { for (const o of [...observers]) if (o.target === target || (o.filter.includes("open") && target.nodeName === "DIALOG")) o.fn([target]); },
        /** The toggle event the browser queues for one of our hosts. */
        toggled(h, newState) { for (const fn of listeners.get("toggle") ?? []) fn({ target: h, newState }); },
        /** Advance the clock by `ms`, running due timers in order. */
        async tick(ms) {
            const end = now + ms;
            for (;;) {
                const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                now = Math.max(now, due[1].at);
                timers.delete(due[0]);
                due[1].fn();
                await settle();
            }
            now = end;
        },
    };
}
/** Let queued microtasks (the keeper's coalesced flush) run. */
const settle = () => new Promise((r) => setImmediate(r));
const ids = (stack) => stack.map((e) => e.name ?? e.nodeName);

// --- promotion and order ---

test("a host the shell mounts goes into the top layer as a manual popover, and our hosts keep their order (highlight, sidebar, card) whichever mounts last", async () => {
    const w = topLayerWorld();
    const hl = w.host("hl"), sb = w.host("sidebar"), card = w.host("card");
    const mountedOnes = [];
    const k = topLayerKeeper(() => [hl, sb, card].map((h) => (mountedOnes.includes(h) ? h : null)), w.doc, w.clock);
    mountedOnes.push(card); k.promote(card);
    assert.equal(card.getAttribute("popover"), "manual");
    assert.ok(onTopLayer(card));
    mountedOnes.push(hl); k.promote(hl);
    assert.deepEqual(ids(w.stack), ["hl", "card"], "the highlight mounted after the card still stacks under it");
    assert.ok(k.manages(card) && k.manages(hl) && !k.manages(sb));
    k.stop();
});

test("a browser without the popover API (jsdom) leaves the host alone and installs nothing", () => {
    const w = topLayerWorld();
    const k = topLayerKeeper(() => [], w.doc, w.clock);
    const plain = { isConnected: true, getAttribute: () => null };
    k.promote(plain);
    assert.equal(k.manages(plain), false);
    assert.equal(w.timers.size, 0);
    assert.equal(w.listeners.size, 0);
});

// --- what the page puts above ours ---

test("a page element entering the top layer after ours (a modal, a popover) is answered by raising ours over it, in order, once per task", async () => {
    const w = topLayerWorld();
    const sb = w.host("sidebar"), card = w.host("card");
    const k = topLayerKeeper(() => [sb, card], w.doc, w.clock);
    k.promote(sb); k.promote(card);
    const dlg = { nodeName: "DIALOG" }, pop = { nodeName: "DIV" };
    w.pageOpens(dlg);
    w.pageOpens(pop);
    assert.deepEqual(ids(w.stack), ["sidebar", "card", "DIALOG", "DIV"], "nothing raised synchronously");
    const before = w.shows();
    await settle();
    assert.deepEqual(ids(w.stack), ["DIALOG", "DIV", "sidebar", "card"], "ours over both, still in order");
    assert.equal(w.shows() - before, 2, "one raise (two hosts) for the two events of the task");
    k.stop();
});

test("a dialog whose toggle event the page stopped is still noticed by its `open` attribute; fullscreen by its event and by the poll", async () => {
    const w = topLayerWorld();
    const sb = w.host("sidebar");
    const k = topLayerKeeper(() => [sb], w.doc, w.clock);
    k.promote(sb);
    const dlg = { nodeName: "DIALOG", hasAttribute: (a) => a === "open" };
    w.stack.push(dlg);
    w.mutate(dlg);
    await settle();
    assert.deepEqual(ids(w.stack), ["DIALOG", "sidebar"]);
    const fs = { nodeName: "VIDEO" };
    w.fullscreen(fs);
    await settle();
    assert.deepEqual(ids(w.stack), ["DIALOG", "VIDEO", "sidebar"], "raised over the fullscreen element");
    k.stop();

    // The poll alone: a fullscreen element whose event never reached us.
    const w2 = topLayerWorld();
    const sb2 = w2.host("sidebar");
    const k2 = topLayerKeeper(() => [sb2], w2.doc, w2.clock);
    k2.promote(sb2);
    const fs2 = { nodeName: "DIV" };
    w2.stack.push(fs2);
    w2.doc.fullscreenElement = () => fs2;
    await w2.tick(TOP_LAYER_POLL_MS);
    assert.deepEqual(ids(w2.stack), ["DIV", "sidebar"]);
    k2.stop();
});

// --- what the page does to our host ---

test("the page taking our host out (hidePopover, the attribute removed or changed) is restored, whether the event, the attribute watch or only the poll tells us", async () => {
    for (const [how, act] of [
        ["hidePopover() with its toggle event", (w, h) => { h.hidePopover(); w.toggled(h, "closed"); }],
        ["the attribute removed", (w, h) => { h.removeAttribute("popover"); w.mutate(h); }],
        ["the attribute set to auto", (w, h) => { h.setAttribute("popover", "auto"); w.mutate(h); }],
        ["hidePopover() with its events stopped by the page (the poll)", async (w, h) => { h.hidePopover(); await w.tick(TOP_LAYER_POLL_MS); }],
    ]) {
        const w = topLayerWorld();
        const sb = w.host("sidebar");
        const k = topLayerKeeper(() => [sb], w.doc, w.clock);
        k.promote(sb);
        await act(w, sb);
        await settle();
        assert.ok(onTopLayer(sb), how);
        k.stop();
    }
});

test("our own raises fire our own toggle events, which cost nothing: no loop of the keeper with itself", async () => {
    const w = topLayerWorld();
    const sb = w.host("sidebar");
    const k = topLayerKeeper(() => [sb], w.doc, w.clock);
    k.promote(sb);
    const before = w.shows();
    for (let i = 0; i < 50; i++) { w.toggled(sb, "open"); w.mutate(sb); await settle(); }
    await w.tick(TOP_LAYER_POLL_MS * 5);
    assert.equal(w.shows(), before, "no show while every host is on top");
    k.stop();
});

// --- the budget ---

test("a page hiding our host in a loop gets the burst, then one restore per refill, and nothing between", async () => {
    const w = topLayerWorld();
    const sb = w.host("sidebar");
    const k = topLayerKeeper(() => [sb], w.doc, w.clock);
    k.promote(sb);
    const before = w.shows();
    for (let i = 0; i < 100; i++) { if (onTopLayer(sb)) sb.hidePopover(); w.toggled(sb, "closed"); await settle(); }
    assert.equal(w.shows() - before, RAISE_BURST, "the burst, then nothing while it is spent");
    assert.equal(onTopLayer(sb), false, "the page holds it out");
    const span = RAISE_REFILL_MS * 5;
    for (let t = 0; t < span; t += 50) { await w.tick(50); if (onTopLayer(sb)) sb.hidePopover(); w.toggled(sb, "closed"); await settle(); }
    assert.ok(w.shows() - before <= RAISE_BURST + 5 + 1, `one per refill past the burst (${w.shows() - before})`);
    assert.ok(w.shows() - before >= RAISE_BURST + 4, "still trying, once per refill");
    k.stop();
});

test("a page reopening its modal in a loop gets the same bound; the budget refills when it stops", async () => {
    const w = topLayerWorld();
    const sb = w.host("sidebar");
    const k = topLayerKeeper(() => [sb], w.doc, w.clock);
    k.promote(sb);
    const before = w.shows();
    for (let i = 0; i < 100; i++) { w.pageOpens({ nodeName: "DIALOG" }); await settle(); }
    assert.equal(w.shows() - before, RAISE_BURST);
    await w.tick(RAISE_REFILL_MS * RAISE_BURST * 2);
    const mid = w.shows();
    w.pageOpens({ nodeName: "DIALOG" });
    await settle();
    assert.equal(w.shows(), mid + 1, "a fresh modal after the page went quiet is raised over at once");
    k.stop();
});

test("a show the page cancels (beforetoggle) is retried within the same budget, and a released host stops every timer", async () => {
    const w = topLayerWorld();
    const sb = w.host("sidebar");
    const k = topLayerKeeper(() => [sb], w.doc, w.clock);
    k.promote(sb);
    sb.cancelShow = true;
    sb.hidePopover();
    w.toggled(sb, "closed");
    await settle();
    await w.tick(RAISE_REFILL_MS * 20);
    assert.equal(onTopLayer(sb), false);
    k.release(sb);
    assert.equal(w.timers.size, 0, "no poll, no retry");
    assert.equal(w.listeners.get("toggle")?.length ?? 0, 0, "no listener");
});

// --- the shot: a host the shell put in the top layer and the page kept out is refused ---

test("a shot's answer is `tampered` when a host the shell put in the top layer is out of it now; one never put there, or on top, is not", () => {
    const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, window: globalThis.window, chrome: globalThis.chrome };
    const docEl = {};
    Object.assign(globalThis, {
        document: { documentElement: docEl, querySelectorAll: () => [] },
        getComputedStyle: () => ({ visibility: "visible", getPropertyValue: () => "" }),
        window: { innerWidth: 1000, innerHeight: 700 },
        chrome: { runtime: { id: "x" } },
    });
    try {
        const w = topLayerWorld();
        const h = Object.assign(w.host("sidebar"), { parentNode: docEl, shadowRoot: { querySelectorAll: () => [] } });
        const answer = (topLayer) => extensionRects({ hosts: [{ host: h, kind: "sidebar", topLayer }], lightboxId: "l", highlightId: "hl", extensionOrigin: "chrome-extension://x/" });
        h.attrs.popover = "manual"; h.showPopover();
        assert.equal(answer(true).tampered, undefined, "on top");
        h.hidePopover();
        assert.equal(answer(true).tampered, true, "out of the top layer the shell put it in");
        assert.equal(answer(undefined).tampered, undefined, "a host never put there (no popover API)");
        h.showPopover(); h.attrs.popover = "auto";
        assert.equal(answer(true).tampered, true, "open, but as the page's auto popover");
    } finally { Object.assign(globalThis, saved); }
});
