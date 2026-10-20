// The trusted-world auto-approve decision (auto-approve.ts). In design A this
// runs in the BACKGROUND (unforgeable), deciding whether a privileged python_exec may skip the gate.
// Pure, so it's tested directly — the SAME function the page loop uses today.
import { test } from "node:test";
import assert from "node:assert";
import { autoApprovePython } from "../src/agent/auto-approve.ts";

const ON = { autoApprovePython: true };
const yes = () => true, no = () => false;
const inside = () => true;   // the membership verdict, stubbed: the real one is false for every cell until Pyodide carries a predicate

test("the feature flag gates it — OFF → null (always ask)", () => {
    assert.equal(autoApprovePython({ code: "return 1" }, { autoApprovePython: false }, no), null);
});

test("a cell outside the dialect → null: always asks, even with the flag on (until membership ships, every cell)", () => {
    assert.equal(autoApprovePython({ code: "return 1" }, ON, no), null);
    assert.equal(autoApprovePython({ code: "return 1", mode: "full" }, ON, no), null, "a stale mode field changes nothing");
});

test("hidden/bidi characters in the code → null (the suspicious-char guard)", () => {
    assert.equal(autoApprovePython({ code: "return 1  # ​hidden" }, ON, no, inside), null);
});

test("an UN-approved external sheet → null (privileged read → asks)", () => {
    const args = { code: "return df", tables: "https://docs.google.com/spreadsheets/d/ABC/edit" };
    assert.equal(autoApprovePython(args, ON, no, inside), null, "external sheet not yet consented → ask");
    assert.equal(autoApprovePython(args, ON, yes, inside), "sandbox", "once the spreadsheet is approved → auto");
});

test("an external sheet inside a `tables` MAP is caught too (not just a bare string)", () => {
    const args = { code: "x", tables: { df: "#local", targets: "https://docs.google.com/spreadsheets/d/MAP/edit" } };
    assert.equal(autoApprovePython(args, ON, no, inside), null);
});

test("'current' and plain DOM selectors are NOT external — auto-approvable", () => {
    assert.equal(autoApprovePython({ code: "x", tables: "current" }, ON, no, inside), "sandbox");
    assert.equal(autoApprovePython({ code: "x", tables: { a: "#t", b: "current" } }, ON, no, inside), "sandbox");
});

test("a RAISED output cap (maxChars > default) → null: it costs the agent's own context, so it asks", () => {
    assert.equal(autoApprovePython({ code: "x", maxChars: 8000, maxCharsReason: "big dump" }, ON, no, inside), null, "raise → gate");
    assert.equal(autoApprovePython({ code: "x", maxChars: 2000 }, ON, no, inside), "sandbox", "at the default → still auto");
    assert.equal(autoApprovePython({ code: "x", maxChars: 500 }, ON, no, inside), "sandbox", "a SMALLER cap is harmless → auto");
});
