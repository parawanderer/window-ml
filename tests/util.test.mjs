// Screenshot coordinate transform (util.ts): projecting an image-pixel coordinate back to the
// viewport. This is the fix for python_exec cast:'pt'/'box' clicking off-target on a dpr>1 display /
// an offset element — the sandbox computes coords in the (cropped, dpr-scaled) IMAGE, @pt/@box click
// in the VIEWPORT.
import { test } from "node:test";
import assert from "node:assert";
import { projectShotPoint, projectShotBox, browserInfo } from "../util.ts";

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
