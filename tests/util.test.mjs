// Screenshot coordinate transform (util.ts): projecting an image-pixel coordinate back to the
// viewport. This is the fix for python_exec cast:'pt'/'box' clicking off-target on a dpr>1 display /
// an offset element — the sandbox computes coords in the (cropped, dpr-scaled) IMAGE, @pt/@box click
// in the VIEWPORT.
import { test } from "node:test";
import assert from "node:assert";
import { projectShotPoint, projectShotBox } from "../util.ts";

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
