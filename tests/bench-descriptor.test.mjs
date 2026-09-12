// What the Python bench draws for a run's result (`pyBenchDescriptor`, vram.tsx, on the shared `pyValueParts`). The sandbox tells the UI how to
// render a return from its TYPE (`render`), and the log honours it; the bench has to as well, or the same
// `return` reads differently on the two surfaces.
import test from "node:test";
import assert from "node:assert/strict";
import { pyBenchDescriptor } from "../src/sidebar/vram.tsx";

test("a sympy return is TYPESET in the bench, as it is in the log", () => {
    const d = pyBenchDescriptor({ ok: true, stdout: "", value: "\\sqrt{\\pi} e^{- \\frac{1}{4}}", render: "latex" });
    assert.equal(d.latex, true);
    assert.equal(d.value, "\\sqrt{\\pi} e^{- \\frac{1}{4}}", "the LaTeX source is the value, unchanged");
});

test("the bench makes the TOOL's decision: a string that is LaTeX itself is typeset, prose is not", () => {
    // Shared with the python_exec step (py-render.ts): a model returning `sympy.latex(expr)` gets a string, and
    // both surfaces typeset it. Ordinary text, even with a backslash in it, stays text.
    assert.equal(pyBenchDescriptor({ ok: true, stdout: "", value: "\\frac{1}{2}" }).latex, true);
    assert.equal(pyBenchDescriptor({ ok: true, stdout: "", value: "C:\\Users\\me and 3 apples" }).latex, undefined);
});

test("a script that returned nothing draws no value section in the bench", () => {
    assert.equal(pyBenchDescriptor({ ok: true, stdout: "hi\n", value: null }).value, undefined);
});

test("a PIL image return is drawn as an image", () => {
    const d = pyBenchDescriptor({ ok: true, stdout: "", value: "data:image/png;base64,AAAA", render: "img" });
    assert.equal(d.image, "data:image/png;base64,AAAA");
    assert.equal(d.value, undefined);
});
