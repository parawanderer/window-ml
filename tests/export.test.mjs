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
            renderIn: { type: "action", verb: "fetch", target: "https://ani.sidestore.io/", ask: "Does it look like a valid anisette token or an error?", answeredBy: "gemma4:e2b", tokens: 572, askBody: '{"error":"unauthorized: invalid client"}', askBodyLang: "json" },
        }],
    };
    const { md } = serializeSession(s);
    // The HTML sink syntax-highlights the In block, so strip tags to compare the TEXT (parity is about content).
    const htmlText = sessionToHtml(s, "run").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"');
    for (const [fmt, out] of [["markdown", md], ["pdf/html", htmlText]]) {
        assert.match(out, /Asked: Does it look like a valid anisette token/, `${fmt} shows the full question`);
        assert.match(out, /Answered by gemma4:e2b/, `${fmt} shows who answered`);
        assert.match(out, /572 tokens/, `${fmt} shows the tokens the answer spent`);
        // The in-the-middle step: the raw content the reader saw is exported in BOTH sinks.
        assert.match(out, /content read by the model/, `${fmt} labels the raw content block`);
        assert.match(out, /unauthorized: invalid client/, `${fmt} includes the raw content the reader read`);
    }
});

test("@tool citations in an answer RESOLVE to the cited step's output; unresolved ones show a note; raw kept", async () => {
    const { toolToken } = await import("../util.ts");
    const hash = "run12345";
    const id = toolToken(hash, 1);   // the token for step seq 1
    const s = {
        hash, kind: "agent", model: "qwen3", tag: "session", createdTs: 1, lastTs: 2, status: "ok", turns: [], answers: [],
        summary: `The count is [n](@tool:${id}:out) and a bogus [x](@tool:beefee:out).`,
        steps: [{ step: 1, seq: 1, tool: "exec", token: id, arguments: { js: "x" }, result: "9",
            renderOut: { type: "code", text: "COUNT_RESULT_42", lang: "text" } }],
    };
    const { md } = serializeSession(s);
    assert.match(md, /COUNT_RESULT_42/, "the cited step's Out is inlined at the token");
    assert.match(md, /⟨unresolved @tool:beefee/, "a hallucinated token shows a visible unresolved note");
    assert.match(md, /Answer · raw \(as the model wrote it\)/, "the literal answer stays recoverable");
    assert.match(md, new RegExp(`@tool:${id}:out`), "the raw disclosure keeps the literal link");
});

test("a step's model-facing Out (with an @tool token line) stays recoverable in BOTH sinks (raw-view rule)", () => {
    const s = {
        hash: "tt1", kind: "agent", model: "qwen3", tag: "session", createdTs: 1, lastTs: 2, status: "ok",
        turns: [], task: "count elements", answers: [{ text: "9", ts: 9, atStep: 1, status: "ok" }],
        steps: [{
            step: 1, localStep: 1, seq: 1, tool: "exec",
            arguments: { js: "document.querySelectorAll('*').length" },
            result: "9",   // the CLEAN Out (pretty view)
            // what the model ACTUALLY saw — the clean result PLUS the appended token line
            modelResult: "9\n\n[output token @tool:e7ed9f — cite this exact result …]",
            renderIn: { type: "code", text: "document.querySelectorAll('*').length", lang: "javascript" },
        }],
    };
    const { md } = serializeSession(s);
    const htmlText = sessionToHtml(s, "run").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"');
    for (const [fmt, out] of [["markdown", md], ["pdf/html", htmlText]]) {
        assert.match(out, /Out · raw \(as the model saw it\)/, `${fmt} discloses the model-facing Out`);
        assert.match(out, /@tool:e7ed9f/, `${fmt} keeps the token line the model saw`);
    }
});

import { config } from "../sidebar/store.ts";
import { BUILD_INFO } from "../build-info.gen.ts";

test("run export: build hash + system-prompt size tag; tool defs gated on the setting (both sinks)", () => {
    const s = {
        hash: "bh1", kind: "agent", model: "qwen3", tag: "session", createdTs: 1, lastTs: 2, status: "ok",
        turns: [], steps: [], task: "do it", answers: [{ text: "done", ts: 9, atStep: 0, status: "ok" }],
        agentConfig: {
            system: "You are an automation agent.", customSystem: false, maxSteps: 5, think: null, env: true, vision: null,
            tools: [{ name: "click", requiresApproval: true, description: "Click an element.", parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] } }],
        },
    };
    // The build stamp rides the top-of-run meta in BOTH formats — pinnable to a build when reproducing.
    for (const out of [serializeSession(s).md, sessionToHtml(s, "run")]) {
        assert.ok(out.includes(BUILD_INFO.shortCommit), "the run export carries the build's short commit");
        assert.match(out.replace(/<[^>]+>/g, ""), /System prompt.*chars.*~.*tokens/s, "the system prompt is annotated with its char + token cost");
    }
    // OFF by default → no tool-definitions dump.
    config.value = { ...config.value, exportToolDefs: false };
    assert.doesNotMatch(serializeSession(s).md, /Tool definitions/, "off by default: no tool-defs dump");
    // ON → the full definitions (JSON, with parameters) appear, annotated with their cost.
    config.value = { ...config.value, exportToolDefs: true };
    try {
        const md = serializeSession(s).md;
        assert.match(md, /Tool definitions \(1\).*chars.*~.*tokens/s, "on: the tool-defs section with its size tag");
        assert.match(md, /"Click an element\."/, "the tool description is dumped");
        assert.match(md, /"selector"/, "the parameter schema is dumped");
        assert.match(sessionToHtml(s, "run").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"'), /Tool definitions/, "the PDF/HTML sink includes it too");
    } finally {
        config.value = { ...config.value, exportToolDefs: false };   // don't leak the toggle to other tests
    }
});
