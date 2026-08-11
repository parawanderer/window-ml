"use strict";
// Export: an agent run's composer attachments (the task's pasted image + a follow-up say's image) must
// come out as PNG sidecars in the zip, referenced from run.md — the same treatment as look/step images.
import { test } from "node:test";
import assert from "node:assert";
import { register } from "node:module";
register("./css-null.mjs", import.meta.url);   // export.ts imports a bundled .css (hljs theme) — stub it for node
const { serializeSession } = await import("../sidebar/export.ts");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("agent session: task image + follow-up (say) image export as PNG sidecars referenced from run.md", () => {
    const s = {
        hash: "abc", kind: "agent", model: "m", tag: "session", createdTs: 1, lastTs: 2,
        status: "ok", turns: [], steps: [],
        task: "look at this", taskImages: [PNG],
        says: [{ text: "and this?", ts: 3, atStep: 0, images: [PNG] }],
        answers: [{ text: "done", ts: 4, atStep: 0, status: "ok" }],
    };
    const { md, images } = serializeSession(s);
    const names = images.map(i => i.name);
    assert.ok(names.some(n => n.includes("task-img-1")), `expected a task-img sidecar, got ${names.join()}`);
    assert.ok(names.some(n => n.includes("say-0-img-1")), `expected a say-image sidecar, got ${names.join()}`);
    assert.ok(images.every(i => i.bytes && i.bytes.length > 0), "each sidecar carries decoded PNG bytes");
    assert.match(md, /task-img-1\.png/, "run.md references the task image");
    assert.match(md, /say-0-img-1\.png/, "run.md references the follow-up image");
});
