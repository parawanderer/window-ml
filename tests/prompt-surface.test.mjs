// prompt-surface.test.mjs — WHERE A PROMPT WAS TYPED, as the model is told it.
//
// One session can be driven from several places — started at the Commander HUD, followed up from the chat app
// — and which place it was changes whether the person can see the page at all. The sentence has to say that
// consequence rather than name the surface, and the LAST instruction's surface is the one that counts.
import test from "node:test";
import assert from "node:assert/strict";
import { PROMPT_SURFACE_LABEL, promptSurfaceClause, promptSurfaceNote } from "../src/agent/prompt-surface.ts";

// --- the sentence each surface gets ---

test("every surface has a note, and each says what it means rather than what it is called", () => {
    for (const surface of Object.keys(PROMPT_SURFACE_LABEL)) {
        const note = promptSurfaceNote({ surface });
        assert.ok(note, `${surface} has a note`);
        // The consequence, not the name: every one of them says something about the person.
        assert.match(note, /they /, `${surface} says what it means for the person`);
        assert.ok(note.length < 220, `${surface} stays one sentence`);
    }
});

test("the chat app on ANOTHER device is a different statement from the chat app in this browser", () => {
    const here = promptSurfaceNote({ surface: "chat" });
    const away = promptSurfaceNote({ surface: "chat", remote: true });
    assert.notEqual(here, away);
    // Here they MIGHT not be looking; there they cannot be. The difference is the whole reason remote is carried.
    assert.match(here, /may not be looking/i);
    assert.match(away, /cannot see the page/i);
    // `remote` means nothing anywhere else: every other surface is, by construction, this browser.
    assert.equal(promptSurfaceNote({ surface: "hud", remote: true }), promptSurfaceNote({ surface: "hud" }));
});

// --- an unknown origin claims nothing ---

test("an absent or unrecognised origin produces no sentence, rather than a guessed surface", () => {
    assert.equal(promptSurfaceNote(null), null);
    assert.equal(promptSurfaceNote(undefined), null);
    assert.equal(promptSurfaceNote({}), null);
    // An older runtime, or one that grew a surface this build has never heard of. Naming a place would be a
    // confident claim about where a person is sitting, which is exactly the thing not to invent.
    assert.equal(promptSurfaceNote({ surface: "watch" }), null);
    assert.equal(promptSurfaceClause(null), "");
    assert.equal(promptSurfaceClause({ surface: "watch" }), "");
});

test("the clause is appended prose, and it still says the console is open to them whichever way they started", () => {
    const clause = promptSurfaceClause({ surface: "hud" });
    assert.match(clause, /^\n\n/, "it appends to a system prompt rather than starting one");
    assert.match(clause, /Commander HUD/);
    assert.match(clause, /console API is open/i);
});
