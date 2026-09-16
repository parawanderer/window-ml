// python-env.ts: pyarrow is a START-UP package, prepared before any run. It cannot load later — pandas fixes its
// view of pyarrow when pandas is first imported — so these pin that it is in the start-up set, prepared, and
// offered to the model.
import { test } from "node:test";
import assert from "node:assert";
import { PY_PACKAGE_LOADS, PY_LAZY_LOADS, PY_PACKAGE_LABELS, PY_STARTUP_PREPARE } from "../src/python-env.ts";

test("pyarrow loads at start with pandas, is not bench-only tooling, and is offered to the model", () => {
    assert.ok(PY_PACKAGE_LOADS.includes("pyarrow"));
    assert.ok(!PY_LAZY_LOADS.includes("pyarrow"));
    assert.match(PY_PACKAGE_LABELS, /pyarrow/);
});

test("the start-up preparation imports pyarrow and removes the `js` bridge its timezone helper keeps", () => {
    assert.match(PY_STARTUP_PREPARE, /^import pyarrow$/m);
    assert.match(PY_STARTUP_PREPARE, /__dict__\.pop\('js', None\)/);
});
