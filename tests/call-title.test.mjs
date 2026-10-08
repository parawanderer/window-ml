// call-title.test.mjs — the model's own account of ONE tool call: the reserved `title` argument.
//
// It is offered on every tool rather than opted into per tool, which makes the two MECHANICAL halves the place
// this can go silently wrong: the schema the model is sent has to carry it (or nothing will ever write one), and
// the arguments the tool RUNS with must not (or a tool is handed a key its own code never declared). Both are
// invisible when broken — a missing title looks like a model that chose not to write one.
"use strict";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_TITLE, callTitleParam, withCallTitle, takeCallTitle } from "../src/tools/tool-params.ts";
import { validateArgs } from "../src/tools/validate.ts";

const schema = (props) => ({ type: "object", properties: props, required: [] });

// --- the schema the model is sent ---

test("every tool's schema gains the title, with the form pinned by an example", () => {
    const out = withCallTitle(schema({ selector: { type: "string" } }));
    assert.equal(out.properties[CALL_TITLE].type, "string");
    assert.match(out.properties[CALL_TITLE].description, /few words/, "a title, not a paragraph");
    assert.match(out.properties[CALL_TITLE].description, /"/, "…pinned by an example rather than by adjectives");
    assert.ok("selector" in out.properties, "and the tool's own parameters are untouched");
});

test("it is NEVER required, and never changes what the tool is told to do", () => {
    const before = schema({ selector: { type: "string" } });
    before.required = ["selector"];
    assert.deepEqual(withCallTitle(before).required, ["selector"], "a model that writes none is not in error");
    assert.match(callTitleParam().description, /changes nothing about how this runs/);
});

test("a tool that already declares `title` keeps ITS OWN, rather than being silently overwritten", () => {
    // The injection itself never clobbers. It runs over tools that did NOT come from `defineTool` — a server
    // tool, one over the hub — where refusing to run somebody else's tool over a cosmetic feature would be the
    // wrong trade. Those simply go without a title.
    const mine = { type: "string", description: "The page title to set." };
    const out = withCallTitle(schema({ [CALL_TITLE]: mine }));
    assert.deepEqual(out.properties[CALL_TITLE], mine);
});

test("…but writing one THROWS, where the tool is being authored", async () => {
    // A tool that quietly loses a parameter, or quietly shadows ours, is a tool that behaves differently from how
    // it reads — found months later. `defineTool` is where that is fixable, so that is where it fails, like an
    // unusable tool NAME already does. (TypeScript callers are refused earlier still: tests/types/.)
    const { defineTool } = await import("../src/ml/ml-tool-factories.ts");
    assert.throws(
        () => defineTool({ name: "set_title", parameters: schema({ [CALL_TITLE]: { type: "string" } }), run: () => "" }),
        /reserved parameter/,
        "and the message says to rename it, not merely that something is wrong",
    );
    // A tool WITHOUT the clash is unaffected, including one that declares no parameters at all.
    assert.ok(defineTool({ name: "fine", parameters: schema({ url: { type: "string" } }), run: () => "" }));
    assert.ok(defineTool({ name: "bare", run: () => "" }));
});

test("a tool with no object schema is left exactly as it is", () => {
    // There is nowhere to put it, and inventing a schema would change the shape the model is told to send.
    assert.equal(withCallTitle(undefined), undefined);
    assert.deepEqual(withCallTitle({ type: "object" }), { type: "object" });
});

test("a tool that declares NO properties is left alone, or it starts rejecting its own arguments", () => {
    // An empty `properties` is how this codebase spells "shape not specified" — `validateArgs` skips the
    // unknown-property check entirely, because it cannot call an argument unknown against a tool that never said
    // what it takes. Adding ours makes that schema non-empty, and a parameterless tool would begin telling the
    // model every argument it sent was wrong. Caught by `tests/agent.test.js`, not by anything here.
    const bare = { type: "object", properties: {} };
    assert.deepEqual(withCallTitle(bare), bare);
    assert.deepEqual(validateArgs(withCallTitle(bare), { x: 1 }), [], "…which is what that preserves");
    // A tool that DID declare its shape already had the check on, so nothing changes for it.
    assert.deepEqual(validateArgs(withCallTitle(schema({ url: { type: "string" } })), { url: "u", title: "Read the rules" }), []);
    assert.deepEqual(validateArgs(withCallTitle(schema({ url: { type: "string" } })), { url: "u", nope: 1 }), ['unknown property "nope"']);
});

test("injecting twice adds nothing twice", () => {
    const once = withCallTitle(schema({ a: { type: "string" } }));
    assert.deepEqual(withCallTitle(once), once);
});

// --- what the tool actually runs with ---

test("the title is taken off the arguments before the tool sees them", () => {
    const { args, title } = takeCallTitle({ selector: "#go", [CALL_TITLE]: "Press the search button" });
    assert.deepEqual(args, { selector: "#go" }, "a tool is never handed a key its own code did not declare");
    assert.equal(title, "Press the search button");
});

test("nothing to take returns the same object, not a copy", () => {
    const args = { selector: "#go" };
    const out = takeCallTitle(args);
    assert.equal(out.args, args, "the common case allocates nothing");
    assert.equal(out.title, undefined);
});

test("an empty or non-string title is no title at all", () => {
    // A model that emits `title: ""` or `title: 4` has said nothing; showing an empty pair of quotes beside a
    // tool name would read as a claim it never made.
    assert.equal(takeCallTitle({ [CALL_TITLE]: "   " }).title, undefined);
    assert.equal(takeCallTitle({ [CALL_TITLE]: 4 }).title, undefined);
    assert.deepEqual(takeCallTitle({ [CALL_TITLE]: "  Count the cards " }).title, "Count the cards");
});

test("a non-string title is still STRIPPED, or the tool meets a key it never declared", () => {
    // The two halves must not disagree: `title` is reserved whatever the model put in it.
    assert.deepEqual(takeCallTitle({ a: 1, [CALL_TITLE]: 4 }).args, { a: 1, [CALL_TITLE]: 4 },
        "…except that a value we will not show is left alone, so the schema check still reports it");
});
