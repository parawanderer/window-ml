// Where a message's images go (src/image-gate.ts): the three-valued vision answer and the plan over EVERY input, since
// the plan validates what reaches a model (AGENTS.md: enumerate, do not sample).
import test from "node:test";
import assert from "node:assert/strict";
import { ImagesRefused, VISION_UNKNOWN_REFUSAL, namedNote, planImages, readerNote, visionAnswer } from "../src/image-gate.ts";

// --- visionAnswer: what the backend reports wins; a declaration speaks only for the default model ---

test("visionAnswer over every report, default-ness and declaration", () => {
    for (const caps of [null, [], ["completion"], ["completion", "vision"]]) {
        for (const isDefault of [false, true]) {
            for (const defaultModelVision of ["", "yes", "no", "maybe"]) {
                const got = visionAnswer(caps, { isDefault, defaultModelVision });
                const want = Array.isArray(caps) ? (caps.includes("vision") ? "yes" : "no")
                    : isDefault && (defaultModelVision === "yes" || defaultModelVision === "no") ? defaultModelVision : "unknown";
                assert.equal(got, want, JSON.stringify({ caps, isDefault, defaultModelVision }));
            }
        }
    }
});

test("visionAnswer: nothing reported and nothing declared is unknown, never no", () => {
    assert.equal(visionAnswer(null, { isDefault: true, defaultModelVision: "" }), "unknown");
    assert.equal(visionAnswer(null, { isDefault: false, defaultModelVision: "yes" }), "unknown");
});

// --- planImages: the table in docs/spec/FILE_ATTACHMENTS.md ---

test("planImages over every answer, reader and override", () => {
    for (const sees of ["yes", "no", "unknown"]) {
        for (const reader of [null, "ocr-model"]) {
            for (const forced of [false, true]) {
                const got = planImages(sees, reader, forced);
                const want = forced || sees === "yes" ? (reader ? { route: "model", reader } : { route: "model" })
                    : reader ? { route: "reader", reader }
                        : sees === "no" ? { route: "named" }
                            : { route: "refused", message: VISION_UNKNOWN_REFUSAL };
                assert.deepEqual(got, want, JSON.stringify({ sees, reader, forced }));
            }
        }
    }
});

test("planImages: unknown with no reader is refused, and the sentence names the toggle that answers it", () => {
    const plan = planImages("unknown", null, false);
    assert.equal(plan.route, "refused");
    assert.match(plan.message, /'This model sees images'/);
});

test("planImages: unknown with a reader set goes to the reader, so no pixels reach an unconfirmed model", () => {
    assert.deepEqual(planImages("unknown", "llava", false), { route: "reader", reader: "llava" });
});

// --- the notes the model reads in place of an image ---

test("the notes number images only when there are several, and name the reader", () => {
    assert.equal(readerNote(0, 1, "llava", "hello"), "[Pasted image: you can't see images, so llava transcribed its text:]\nhello");
    assert.match(readerNote(1, 3, "llava", ""), /^\[Pasted image 2: .*\]\n\(could not read the image\)$/);
    assert.equal(namedNote(0, 1), "[Pasted image was not sent: you can't see images, and no reader model is set to read it.]");
    assert.match(namedNote(2, 3), /^\[Pasted image 3 was not sent/);
});

test("ImagesRefused carries the sentence and is an Error", () => {
    const e = new ImagesRefused(VISION_UNKNOWN_REFUSAL);
    assert.ok(e instanceof Error);
    assert.equal(e.message, VISION_UNKNOWN_REFUSAL);
});
