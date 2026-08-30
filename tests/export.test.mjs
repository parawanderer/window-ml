"use strict";
// Export: an agent run's composer attachments (the task's pasted image + a follow-up say's image) must
// come out as PNG sidecars in the zip, referenced from run.md — the same treatment as look/step images.
import { test } from "node:test";
import assert from "node:assert";
import "./stub-css.mjs";   // export.ts imports a bundled .css (hljs theme) — stub it (both loader paths) BEFORE the import below
const { serializeSession, sessionToHtml } = await import("../sidebar/export.ts");

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

test("fetch_url `ask`: the question + who-answered + tokens export in BOTH Markdown and PDF (one walk, two sinks)", () => {
    const s = {
        hash: "ask1", kind: "agent", model: "qwen3", tag: "session", createdTs: 1, lastTs: 2, status: "ok",
        turns: [], task: "check the server", answers: [{ text: "done", ts: 9, atStep: 1, status: "ok" }],
        steps: [{
            step: 1, localStep: 1, tool: "fetch_url",
            arguments: { url: "https://ani.sidestore.io/", ask: "Does it look like a valid anisette token or an error?" },
            result: "Fetched https://ani.sidestore.io/ - HTTP 200.\n\nAnswer:\nIt is not a token.",
            renderIn: { type: "action", verb: "fetch", target: "https://ani.sidestore.io/", ask: "Does it look like a valid anisette token or an error?", answeredBy: "gemma4:e2b", tokens: 572 },
        }],
    };
    const { md } = serializeSession(s);
    // The HTML sink syntax-highlights the In block, so strip tags to compare the TEXT (parity is about content).
    const htmlText = sessionToHtml(s, "run").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"');
    for (const [fmt, out] of [["markdown", md], ["pdf/html", htmlText]]) {
        assert.match(out, /Asked: Does it look like a valid anisette token/, `${fmt} shows the full question`);
        assert.match(out, /Answered by gemma4:e2b/, `${fmt} shows who answered`);
        assert.match(out, /572 tokens/, `${fmt} shows the tokens the answer spent`);
    }
});
