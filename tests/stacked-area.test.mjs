// The stacked area (src/sidebar/resource/resource-area.tsx) drawn from a THINNED run: its edges are cached per drawing
// so a hover reuses them, and the snapped marks read the sample under the crosshair, which the thinning may have left
// out of the frames drawn.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, A, doc;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.HTMLElement = dom.window.HTMLElement;
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    A = await import("../src/sidebar/resource/resource-area.tsx");
});

const GB = 1024 ** 3;
const band = (model, bytes) => ({ key: model, label: model, kind: "model", model, bytes });
const free = (bytes) => ({ key: "free", label: "free", kind: "free", bytes });
const show = (props) => { const host = doc.getElementById("root"); render(h(A.StackedArea, { ceiling: 100 * GB, hidden: new Set(), scope: "t", ...props }), host); return host; };
const pts = (host) => [...host.querySelectorAll("polygon.rc-band")].map((p) => p.getAttribute("points"));

// --- the marks on a thinned run ---

test("the snapped marks read the sample under the crosshair, though the thinned frames drawn do not hold it", () => {
    // Three frames drawn (the thinning kept the ends and one between); the snapped sample sits between them, with a
    // model holding 50 GiB that no drawn frame shows.
    const frames = [[band("a", 10 * GB), free(90 * GB)], [band("a", 10 * GB), free(90 * GB)], [band("a", 10 * GB), free(90 * GB)]];
    const host = show({ frames, times: [0, 500, 1000], snap: { bands: [band("a", 50 * GB), free(50 * GB)], t: 250 } });
    const dot = host.querySelector(".rc-snapdot");
    assert.ok(dot, "a mark is drawn");
    assert.equal(parseFloat(dot.style.left), 25, "at the snapped sample's own time");
    assert.equal(parseFloat(dot.style.top), 50, "at its own top (50 of 100 GiB), not a drawn frame's (10)");
});

// --- the edge cache ---

test("hiding a model redraws the stack from the same frames: the cached edges are keyed on what is hidden", () => {
    const frames = [[band("a", 10 * GB), band("b", 20 * GB), free(70 * GB)], [band("a", 10 * GB), band("b", 20 * GB), free(70 * GB)]];
    const times = [0, 1000];
    const all = pts(show({ frames, times }));
    const hid = pts(show({ frames, times, hidden: new Set(["a"]) }));
    assert.notDeepEqual(hid, all, "b drops to the floor when a is hidden");
    assert.deepEqual(pts(show({ frames, times })), all, "and comes back when it is shown");
});

// A cached edge reversed IN PLACE to draw the band above's floor came back reversed on the next render: the band was
// drawn from its far end, so the hover render that only moved the pointer turned it into a bow-tie.
test("new frames draw new edges, and the same frames re-rendered draw the same ones", () => {
    const times = [0, 1000];
    const one = [[band("a", 10 * GB), free(90 * GB)], [band("a", 10 * GB), free(90 * GB)]];
    const two = [[band("a", 40 * GB), free(60 * GB)], [band("a", 40 * GB), free(60 * GB)]];
    const first = pts(show({ frames: one, times }));
    const again = pts(show({ frames: one, times, snap: { bands: one[0], t: 0 } }));
    assert.deepEqual(again, first, "a hover render reuses them");
    assert.notDeepEqual(pts(show({ frames: two, times })), first, "a new drawing does not");
});
