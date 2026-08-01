// The trusted-world auto-approve decision (auto-approve.ts). In design A this
// runs in the BACKGROUND (unforgeable), deciding whether a privileged python_exec may skip the gate.
// Pure, so it's tested directly — the SAME function the page loop uses today.
const { test } = require("node:test");
const assert = require("node:assert");
const { autoApprovePython } = require("../auto-approve.ts");

const ON = { autoApprovePython: true };
const yes = () => true, no = () => false;

test("readonly python (default mode), no sheet → sandbox (auto-approved)", () => {
    assert.equal(autoApprovePython({ code: "return 1" }, ON, no), "sandbox");
});

test("the feature flag gates it — OFF → null (always ask)", () => {
    assert.equal(autoApprovePython({ code: "return 1" }, { autoApprovePython: false }, no), null);
});

test("full mode (network) → null: always asks, even with the flag on", () => {
    assert.equal(autoApprovePython({ code: "return 1", mode: "full" }, ON, no), null);
});

test("hidden/bidi characters in the code → null (the suspicious-char guard)", () => {
    assert.equal(autoApprovePython({ code: "return 1  # ​hidden" }, ON, no), null);
});

test("an UN-approved external sheet → null (privileged read → asks)", () => {
    const args = { code: "return df", tables: "https://docs.google.com/spreadsheets/d/ABC/edit" };
    assert.equal(autoApprovePython(args, ON, no), null, "external sheet not yet consented → ask");
    assert.equal(autoApprovePython(args, ON, yes), "sandbox", "once the spreadsheet is approved → auto");
});

test("an external sheet inside a `tables` MAP is caught too (not just a bare string)", () => {
    const args = { code: "x", tables: { df: "#local", targets: "https://docs.google.com/spreadsheets/d/MAP/edit" } };
    assert.equal(autoApprovePython(args, ON, no), null);
});

test("'current' and plain DOM selectors are NOT external — auto-approvable", () => {
    assert.equal(autoApprovePython({ code: "x", tables: "current" }, ON, no), "sandbox");
    assert.equal(autoApprovePython({ code: "x", tables: { a: "#t", b: "current" } }, ON, no), "sandbox");
});
