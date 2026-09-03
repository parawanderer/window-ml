"use strict";
// The id's surface FORM, which is a build-time experiment (docs/POINTER-IDENTIFIERS.md §6).
//
// The property that matters here is that the experiment is CONTROLLED. `syllable` is a transcoding of
// `hex`, one syllable per hex character, so the payload, the check character and the collision space are
// bit-identical and the only variable is what the model reads. If the transcoding were lossy or not
// bijective, an A/B between the two arms would be measuring two things at once and could not attribute a
// difference to the form.

import { test } from "node:test";
import assert from "node:assert/strict";
const {
    TOKEN_FORMAT, TOKEN_LEN, TOKEN_PAYLOAD_LEN, checkChar, isTokenShape, isTokenValid,
    toSyllables, fromSyllables, formatToken, toolNameError,
} = await import("../token-id.ts");
const { toolToken } = await import("../util.ts");

const HEX = "0123456789abcdef";
/** A spread of ids across runs and steps, as the mint would produce them. */
const sample = () => Array.from({ length: 200 }, (_, i) => toolToken(`run${i % 7}`, i));

test("the shipped build mints hex — the variant is opt-in at build time", () => {
    assert.equal(TOKEN_FORMAT, "hex", "a plain `npm run build` must not carry the experiment");
    assert.match(toolToken("abc", 1), /^[0-9a-f]{7}$/);
});

test("toSyllables is bijective over every hex digit", () => {
    // One syllable per digit, so the mapping is total and reversible by construction. Anything less and
    // two different ids could render the same, which would resolve to the wrong output with no error.
    for (const c of HEX) {
        const sy = toSyllables(c);
        assert.equal(sy.length, 2, `digit ${c} must render as exactly one syllable`);
        assert.equal(fromSyllables(sy), c);
    }
    assert.equal(new Set([...HEX].map((c) => toSyllables(c))).size, 16, "no two digits may share a syllable");
});

test("a real id round-trips through the syllable form unchanged", () => {
    for (const hex of sample()) {
        const sy = toSyllables(hex);
        assert.equal(sy.length, TOKEN_LEN * 2);
        assert.equal(fromSyllables(sy), hex, `${hex} did not survive the round trip`);
    }
});

test("no two distinct ids render to the same syllable form", () => {
    // The collision space must be the SAME in both arms, or the experiment confounds form with collision
    // rate. Bijectivity per character gives this, but it is the property worth asserting directly.
    const ids = [...new Set(sample())];
    assert.equal(new Set(ids.map(toSyllables)).size, ids.length);
});

test("fromSyllables rejects anything that is not syllables", () => {
    assert.equal(fromSyllables("hello!"), null);
    assert.equal(fromSyllables("bax"), null, "an odd trailing character is not a syllable");
    assert.equal(fromSyllables("baqu"), null, "`qu` is not in the alphabet");
    assert.equal(fromSyllables(""), null);
});

test("the check character survives transcoding, so a corrupted syllable id still fails", () => {
    // The whole point of the check is that a single-character corruption cannot silently resolve. Under
    // the syllable form a "character" is a syllable, and the guarantee has to hold there too.
    const hex = toolToken("run", 3);
    assert.equal(fromSyllables(toSyllables(hex)), hex);

    let tried = 0;
    for (let pos = 0; pos < TOKEN_LEN; pos++) {
        for (const c of HEX) {
            if (c === hex[pos]) continue;
            const bad = hex.slice(0, pos) + c + hex.slice(pos + 1);
            assert.equal(fromSyllables(toSyllables(bad)), bad, "a corrupted id must still transcode back faithfully");
            // Rechecked through the same arithmetic isTokenValid uses, so this holds whichever form this
            // build happens to mint.
            const valid = bad[TOKEN_PAYLOAD_LEN] === checkChar(bad.slice(0, TOKEN_PAYLOAD_LEN));
            assert.equal(valid, false, `single-syllable corruption at ${pos} produced a VALID id`);
            tried++;
        }
    }
    assert.equal(tried, TOKEN_LEN * 15, "every single-character substitution must have been tried");
});

test("formatToken renders this build's form, and the mapping is positional", () => {
    assert.equal(formatToken("a39f599"), TOKEN_FORMAT === "syllable" ? toSyllables("a39f599") : "a39f599");
    assert.equal(toSyllables("a39"), toSyllables("a") + toSyllables("3") + toSyllables("9"));
});

test("a syllable id is a valid identifier, so the tool-name guard has to move with the build", () => {
    // The three-form dispatch depends on a tool name never having an id's SHAPE. Under hex the collision
    // is `deadbee`; under syllables it is a 14-character name drawn entirely from the alphabet — and
    // because `isTokenShape` is built from the same source as the mint, the guard adapts with the build.
    const syId = toSyllables(toolToken("run", 1));
    assert.match(syId, /^[a-z]+$/, "a syllable id is letters only — an identifier, hence the hazard");
    if (TOKEN_FORMAT === "syllable") {
        assert.ok(toolNameError(syId), "a syllable-shaped tool name must be refused on a syllable build");
    } else {
        assert.equal(toolNameError(syId), null, "on a hex build that name is unambiguous, so it is allowed");
        assert.ok(toolNameError("deadbee"), "…while the HEX-shaped collision is refused");
    }
});

test("the mint is deterministic, and a corrupted mint is recognised-but-invalid", () => {
    const minted = toolToken("run", 9);
    assert.equal(minted, toolToken("run", 9), "the same run and step must mint the same id");
    assert.ok(isTokenShape(minted), "the mint must produce something the parser recognises");
    assert.ok(isTokenValid(minted), "and something that passes its own check");

    // Shape without validity is what lets a fault say "you mistyped this" rather than "no such thing".
    const hex = TOKEN_FORMAT === "syllable" ? fromSyllables(minted) : minted;
    const flipped = hex.slice(0, -1) + (hex.at(-1) === "0" ? "1" : "0");
    const bad = formatToken(flipped);
    assert.ok(isTokenShape(bad), "a corrupted id still LOOKS like an id");
    assert.equal(isTokenValid(bad), false, "…but must not validate");
});
