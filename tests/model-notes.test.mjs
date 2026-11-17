// model-notes.test.mjs — what an output embedded in an answer drops of the text written for the model alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutModelNotes } from "../src/sidebar/transcript/model-notes.ts";

// --- the notes go, the output stays ---

test("both notes are dropped and the console and value are kept", () => {
    const out = "console:\nhello\n\nvalue: ok\n\n(Ran in an isolated world because it runs programs through ml.sh: it shares the page's DOM (clicks and reads work), but x.)\n(ml.sh waited 2 s for the person to approve.)";
    assert.equal(withoutModelNotes(out), "console:\nhello\n\nvalue: ok");
});

test("text without notes is returned as it was, and a mid-line mention is left alone", () => {
    assert.equal(withoutModelNotes("a (ml.sh waited 2 s for the person to approve.) b"), "a (ml.sh waited 2 s for the person to approve.) b");
    assert.equal(withoutModelNotes("plain"), "plain");
});
