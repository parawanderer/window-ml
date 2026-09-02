// Screenshot coordinate transform (util.ts): projecting an image-pixel coordinate back to the
// viewport. This is the fix for python_exec cast:'pt'/'box' clicking off-target on a dpr>1 display /
// an offset element — the sandbox computes coords in the (cropped, dpr-scaled) IMAGE, @pt/@box click
// in the VIEWPORT.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { projectShotPoint, projectShotBox, browserInfo, incognitoEnableSteps, extensionDetailsUrl, mlRange, RANGE_MAX, pageContext } from "../util.ts";

// ---- mlRange: the bounded counter loop (ml.range) ----
test("mlRange: the three forms (stop / start,stop / start,stop,step) incl. a descending range", () => {
    assert.deepEqual(mlRange(5), [0, 1, 2, 3, 4]);
    assert.deepEqual(mlRange(2, 6), [2, 3, 4, 5]);
    assert.deepEqual(mlRange(0, 10, 3), [0, 3, 6, 9]);
    assert.deepEqual(mlRange(5, 0, -1), [5, 4, 3, 2, 1]);
    assert.deepEqual(mlRange(3, 3), []);              // empty range
    assert.deepEqual(mlRange(0), []);
});
test("mlRange: throws on a length over the cap, a zero step, or non-finite args (never runs away)", () => {
    assert.throws(() => mlRange(RANGE_MAX + 1), /too large/);
    assert.throws(() => mlRange(0, 10, 0), /non-zero/);
    assert.throws(() => mlRange(Infinity), /finite/);
    assert.throws(() => mlRange(0, NaN), /finite/);
});

// ---- browserInfo: which Chromium are we in? ----
// It decides the URL scheme we hand the user for their settings pages — `chrome://extensions/
// shortcuts` is a dead link in Edge/Brave, and a dead link is worse than no advice.

test("browserInfo prefers userAgentData brands over the UA string (Brave impersonates Chrome)", () => {
    const info = browserInfo({
        userAgentData: { brands: [{ brand: "Not)A;Brand", version: "99" }, { brand: "Chromium", version: "141" }, { brand: "Brave", version: "141" }] },
        userAgent: "Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36",
    });
    assert.deepEqual(info, { name: "Brave", version: "141", scheme: "brave" });
});

test("browserInfo maps each fork to its own internal scheme", () => {
    const scheme = brand => browserInfo({ userAgentData: { brands: [{ brand, version: "1" }] } }).scheme;
    assert.equal(scheme("Microsoft Edge"), "edge");
    assert.equal(scheme("Vivaldi"), "vivaldi");
    assert.equal(scheme("Google Chrome"), "chrome");
    assert.equal(scheme("Some New Fork"), "chrome");     // unknown → the Chromium default
});

test("browserInfo falls back to UA sniffing, most specific token first", () => {
    // Edge's UA contains BOTH Chrome/ and Edg/ — matching Chrome first would misname it.
    assert.deepEqual(browserInfo({ userAgent: "Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36 Edg/141.0.1" }),
        { name: "Microsoft Edge", version: "141", scheme: "edge" });
    assert.deepEqual(browserInfo({ userAgent: "Mozilla/5.0 … Chrome/140.0.0.0 Safari/537.36" }),
        { name: "Google Chrome", version: "140", scheme: "chrome" });
});

test("browserInfo detects Brave by navigator.brave when the UA hides it", () => {
    const info = browserInfo({ brave: {}, userAgent: "Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36" });
    assert.equal(info.name, "Brave");
    assert.equal(info.scheme, "brave");
});

test("browserInfo never throws on an empty navigator — it degrades to a named unknown", () => {
    const info = browserInfo({});
    assert.match(info.name, /unknown/i);
    assert.equal(info.scheme, "chrome");        // still gives a usable settings URL
    assert.equal(info.version, null);
});

// ---- incognitoEnableSteps: browser-correct "Allow in Incognito" instructions (private rendered fetch) ----
test("incognitoEnableSteps uses each fork's own scheme AND its own word for private browsing", () => {
    const steps = name => incognitoEnableSteps({ name, version: "1", scheme: name === "Microsoft Edge" ? "edge" : name === "Brave" ? "brave" : "chrome" });
    // Chrome: chrome:// + "Incognito"
    const chrome = incognitoEnableSteps({ name: "Google Chrome", version: "1", scheme: "chrome" });
    assert.match(chrome, /chrome:\/\/extensions/);
    assert.match(chrome, /Allow in Incognito/);
    // Edge: edge:// + "InPrivate" (NOT "Incognito" — the toggle would be unfindable)
    const edge = steps("Microsoft Edge");
    assert.match(edge, /edge:\/\/extensions/);
    assert.match(edge, /Allow in InPrivate/);
    assert.doesNotMatch(edge, /Incognito/);
    // Brave: brave:// + "Private"
    const brave = steps("Brave");
    assert.match(brave, /brave:\/\/extensions/);
    assert.match(brave, /Allow in Private/);
    // Names the extension so the user knows what to look for.
    assert.match(chrome, /window\.ml/);
});

test("incognitoEnableSteps deep-links to THIS extension's details page when given the id", () => {
    const brave = { name: "Brave", version: "1", scheme: "brave" };
    // With the id → a direct ?id= link (lands on the toggle), NOT the bare extensions list.
    const withId = incognitoEnableSteps(brave, "kbioabndhiilpdbnafipimjnbohmfkgo");
    assert.match(withId, /brave:\/\/extensions\/\?id=kbioabndhiilpdbnafipimjnbohmfkgo/);
    // Without the id → falls back to the list URL (no dangling ?id=).
    const noId = incognitoEnableSteps(brave);
    assert.match(noId, /brave:\/\/extensions(?!\/\?id=)/);
    assert.doesNotMatch(noId, /\?id=/);
});

test("extensionDetailsUrl builds a scheme-correct ?id= link, or the list URL without an id", () => {
    assert.equal(extensionDetailsUrl({ name: "Google Chrome", version: "1", scheme: "chrome" }, "abc"), "chrome://extensions/?id=abc");
    assert.equal(extensionDetailsUrl({ name: "Brave", version: "1", scheme: "brave" }, "xyz"), "brave://extensions/?id=xyz");
    assert.equal(extensionDetailsUrl({ name: "Microsoft Edge", version: "1", scheme: "edge" }), "edge://extensions");
});


test("projectShotPoint: viewport = crop-offset + image_px / dpr", () => {
    // A Retina (dpr=2) crop whose top-left sits at viewport (50, 30). Image pixel (200,100) →
    // viewport (50 + 100, 30 + 50).
    assert.deepEqual(projectShotPoint({ x: 200, y: 100 }, { left: 50, top: 30, dpr: 2 }), { x: 150, y: 80 });
});

test("projectShotPoint: dpr=1, offset 0 is the identity (the case where the old raw mint accidentally worked)", () => {
    assert.deepEqual(projectShotPoint({ x: 300, y: 200 }, { left: 0, top: 0, dpr: 1 }), { x: 300, y: 200 });
});

test("projectShotPoint: a missing/zero dpr is treated as 1 (never divide by 0)", () => {
    assert.deepEqual(projectShotPoint({ x: 40, y: 20 }, { left: 5, top: 5, dpr: 0 }), { x: 45, y: 25 });
});

test("projectShotBox projects both corners → the viewport box is dpr-shrunk + offset", () => {
    assert.deepEqual(
        projectShotBox({ left: 0, top: 0, right: 200, bottom: 100 }, { left: 10, top: 20, dpr: 2 }),
        { left: 10, top: 20, right: 110, bottom: 70 });   // 200/2=100 wide, 100/2=50 tall
});

// ---- near-area vision memory (locate snap-inject dedup) ----
// markSeen/seenNearby track which spots the DRIVER has already been shown a crop of, so a re-snap
// onto a near-identical point doesn't re-inject the same crop (the re-snap-loop case).
import { markSeen, seenNearby, SEEN_RADIUS } from "../util.ts";

test("seenNearby: false on empty memory, and a null memory never matches", () => {
    assert.equal(seenNearby({ seen: [] }, 100, 100), false);
    assert.equal(seenNearby(null, 100, 100), false);
    assert.equal(seenNearby(undefined, 100, 100), false);
});

test("seenNearby: a spot within SEEN_RADIUS of a seen point matches; outside it doesn't", () => {
    const mem = { seen: [] };
    markSeen(mem, 200, 200);
    assert.equal(seenNearby(mem, 200, 200), true, "exact hit");
    assert.equal(seenNearby(mem, 200 + SEEN_RADIUS - 1, 200), true, "just inside the radius");
    assert.equal(seenNearby(mem, 200 + SEEN_RADIUS + 5, 200), false, "just outside the radius");
});

test("seenNearby: honours a custom radius and matches ANY seen point", () => {
    const mem = { seen: [] };
    markSeen(mem, 0, 0);
    markSeen(mem, 500, 500);
    assert.equal(seenNearby(mem, 30, 40, 50), true, "50px within (0,0) — hypot 50");
    assert.equal(seenNearby(mem, 30, 40, 40), false, "40px radius excludes hypot 50");
    assert.equal(seenNearby(mem, 505, 495, 20), true, "near the SECOND seen point");
});

test("markSeen: rounds coordinates and is a no-op on a null memory", () => {
    const mem = { seen: [] };
    markSeen(mem, 12.6, 40.2);
    assert.deepEqual(mem.seen, [{ x: 13, y: 40 }]);
    markSeen(null, 1, 1);   // no throw
});

test("toolToken: deterministic 6-hex id from (runHash, seq); opaque + varies", async () => {
    const { toolToken } = await import("../util.ts");
    const t = toolToken("abcd1234", 3);
    assert.match(t, /^[0-9a-f]{6}$/, "6 hex");
    assert.equal(toolToken("abcd1234", 3), t, "deterministic — same inputs, same id (survives replay)");
    assert.notEqual(toolToken("abcd1234", 4), t, "differs by seq");
    assert.notEqual(toolToken("wxyz9999", 3), t, "differs by run");
});

// ---- pageContext: the "Markdown:" line, and WHOSE tools it may name ----
// pageContext reads browser globals, so stand a jsdom document up as `document`/`location` for the call.
function withPage(html, url, fn) {
    const dom = new JSDOM(html, { url });
    const saved = [globalThis.document, globalThis.location];
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, "location", { value: dom.window.location, configurable: true, writable: true });
    try { return fn(); }
    finally {
        globalThis.document = saved[0];
        Object.defineProperty(globalThis, "location", { value: saved[1], configurable: true, writable: true });
        dom.window.close();
    }
}
const DECLARED = '<head><link rel="alternate" type="text/markdown" href="/guide.md"></head><body></body>';
const AFFORDANCE = "<head></head><body><button>Copy Page as Markdown</button></body>";
const line = (out) => (out.split("\n").find((l) => l.startsWith("Markdown:")) ?? "");

// A run can be built with `fetch: false`, a custom `tools` array, or the unattended toolset. Advice naming a
// tool that isn't wired costs the model a turn to discover it doesn't exist.
test("pageContext: the FACT is unconditional, the tool advice is gated on the run actually having it", () => {
    withPage(DECLARED, "https://docs.test/guide", () => {
        const withFetch = line(pageContext((n) => n === "fetch_url"));
        assert.match(withFetch, /declares a Markdown version at https:\/\/docs\.test\/guide\.md/);
        assert.match(withFetch, /fetch_url it/, "names the tool when the run has it");

        // No fetch_url wired: the URL is still worth knowing (the model can navigate there) — but nothing
        // may point at a tool that isn't there.
        const without = line(pageContext((n) => n === "click"));
        assert.match(without, /declares a Markdown version at https:\/\/docs\.test\/guide\.md/);
        assert.doesNotMatch(without, /fetch_url/, "must not name a tool this run lacks");

        // No predicate at all (the callers that have no toolset to consult) behaves like "no tools known".
        assert.doesNotMatch(line(pageContext()), /fetch_url/);
    });
});

// The affordance is a CONTROL, not a URL — there is nothing to act on without a fetch, so it earns no line.
test("pageContext: the copy-as-Markdown hint appears only when fetch_url is wired", () => {
    withPage(AFFORDANCE, "https://docs.test/guide", () => {
        assert.match(line(pageContext((n) => n === "fetch_url")), /copy-as-Markdown control/);
        assert.equal(line(pageContext(() => false)), "", "no fetch_url → no line at all");
    });
    // A page with neither says nothing either way.
    withPage("<head></head><body></body>", "https://docs.test/guide", () => {
        assert.equal(line(pageContext(() => true)), "");
    });
});
