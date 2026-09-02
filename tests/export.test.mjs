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
        summary: `The count is ![n](@tool:${id}:out) and a bogus ![x](@tool:beefee:out).`,
        steps: [{ step: 1, seq: 1, tool: "exec", token: id, arguments: { js: "x" }, result: "9",
            renderOut: { type: "code", text: "COUNT_RESULT_42", lang: "text" } }],
    };
    const { md } = serializeSession(s);
    assert.match(md, /COUNT_RESULT_42/, "the cited step's Out is inlined at the token");
    assert.match(md, /⟨unresolved @tool:beefee/, "a hallucinated token shows a visible unresolved note");
    assert.match(md, /Answer · raw \(as the model wrote it\)/, "the literal answer stays recoverable");
    assert.match(md, new RegExp(`@tool:${id}:out`), "the raw disclosure keeps the literal link");
});

test("@tool :out of a python SCALAR renders the CLEAN value in the ANSWER, not the model-facing prelude", async () => {
    // The python result string carries a model-facing prelude ("[loaded, reference directly] … df."); the
    // structured descriptor's `value` is the clean "6260". The citation must render the CLEAN value — via the
    // descriptor field, not a regex, and not `step.result`. (The step TRACE keeps the model-facing result per the
    // raw-view rule, so we isolate the ANSWER section.)
    const { toolToken } = await import("../util.ts");
    const hash = "pyrun01";
    const id = toolToken(hash, 1);
    const s = {
        hash, kind: "agent", model: "qwen", tag: "session", createdTs: 1, lastTs: 2, status: "ok", turns: [], answers: [],
        summary: `The grand total is ![total](@tool:${id}:out).`,
        steps: [{ step: 1, seq: 1, tool: "python_exec", token: id,
            result: "[loaded, reference directly] a 12×6 DataFrame → `df`.\n\n6260",
            renderOut: { type: "python-out", value: "6260" } }],
    };
    const { md } = serializeSession(s);
    const answerPart = md.slice(md.indexOf("## Answer"));   // the trace (with the model-facing result) is above this
    assert.match(answerPart, /6260/, "the clean value is rendered at the citation");
    assert.doesNotMatch(answerPart, /loaded, reference directly/, "the model-facing prelude is NOT in the citation render");
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

test("PDF/HTML sink TYPESETS math (prose $…$/$$…$$ + a | latex / auto-latex citation); .md keeps it raw", async () => {
    const { toolToken } = await import("../util.ts");
    const hash = "mathrun1";
    const id = toolToken(hash, 1);
    const s = {
        hash, kind: "agent", model: "gemma", tag: "session", createdTs: 1, lastTs: 2, status: "ok", turns: [], answers: [],
        // prose display + inline math, an explicit `| latex` cite, AND an auto-latex cite (python-out latex flag, no pipe).
        summary: "With root $r = 2$:\n\n$$y_h(x) = C_1 x^2$$\n\nThe derivative is ![d](@tool:" + id + ":out | latex) and also ![a](@tool:" + id + ":out).",
        steps: [{ step: 1, seq: 1, tool: "python_exec", token: id, result: "x^{2} e^{x}",
            renderOut: { type: "python-out", value: "x^{2} e^{x}", latex: true } }],
    };
    const html = sessionToHtml(s, "run");
    // KaTeX ran: rendered spans present, and the raw TeX source is NOT sitting as literal text in the body.
    assert.match(html, /class="katex/, "the PDF/HTML sink renders KaTeX for prose math + latex citations");
    const bodyText = html.slice(html.indexOf('<div class="doc"')).replace(/<[^>]+>/g, "");
    assert.ok(!bodyText.includes("$$y_h(x)"), "the raw $$…$$ prose is typeset, not shown literally");
    // The .md sink keeps the math notation literal (a coding assistant reads raw TeX).
    const { md } = serializeSession(s);
    assert.match(md, /\$\$y_h\(x\) = C_1 x\^2\$\$/, ".md keeps the display-math source literal");
    assert.ok(!md.includes("class=\"katex"), ".md does not run KaTeX");
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

test("agent run stats (cumulative tokens + generation rate) export into the run header — md + PDF parity", () => {
    const s = {
        hash: "st", kind: "agent", model: "qwen3", tag: "session", createdTs: 1, lastTs: 2, status: "ok",
        turns: [], task: "compute the totals", answers: [{ text: "done", ts: 9, atStep: 2, status: "ok" }],
        steps: [
            { step: 1, tool: "python_exec", arguments: { code: "1" }, result: "1", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, evalMs: 1000 } },
            { step: 2, thought: "final", usage: { promptTokens: 140, completionTokens: 40, totalTokens: 180, evalMs: 1000 } },
        ],
    };
    const { md } = serializeSession(s);
    assert.match(md, /Tokens/, "the run header carries a token line");
    assert.match(md, /240 in · 60 out/, "cumulative in/out summed across both calls");
    assert.match(md, /30\.0 tok\/s/, "60 out tokens ÷ 2s eval = 30 tok/s");
    assert.match(md, /Ollama generation time/, "and the rate's provenance/basis is recorded");
    const html = sessionToHtml(s, "run-stats-test");
    assert.match(html, /240 in/, "the PDF/HTML sink carries the same stats (parity)");
});

// Per-line PRODUCED-AT timestamps: the sidebar draws them as an unselectable gutter, so the render-in-both
// surfaces rule says the export must carry them too — but NOT folded into the Out block, or a copied log would
// be un-pasteable. They ride a separate collapsed block beside the verbatim output.
test("streamed output: the export carries a timed view BESIDE the verbatim Out (both sinks)", () => {
    const t0 = new Date("2026-09-02T14:17:30").getTime();
    const stdout = "alpha\nbeta\ngamma\n";
    const s = {
        hash: "ts1", kind: "agent", model: "m", tag: "session", createdTs: 1, lastTs: 2, status: "ok",
        turns: [], task: "stream some output", answers: [{ text: "done", ts: 9, atStep: 1, status: "ok" }],
        steps: [{
            step: 1, localStep: 1, tool: "python_exec", arguments: { code: "print('alpha')" },
            result: stdout,
            streamMarks: [[0, t0], [6, t0 + 1200], [11, t0 + 3600000]],   // the third line lands an hour later
            renderOut: { type: "python-out", stdout },
        }],
    };
    const { md } = serializeSession(s);
    assert.match(md, /Out · timed \(when each line was produced\)/, "the timed view is present, in its own disclosure");
    // The run spans an hour boundary → the FULL clock, so no line can be misread as the wrong hour.
    assert.match(md, /14:17:30 {2}alpha/, "line 1 carries the executor's stamp");
    assert.match(md, /14:17:31 {2}beta/, "line 2 carries its own (a later mark within the same burst)");
    assert.doesNotMatch(md, /^ +$/m, "no line is left as trailing whitespace (the log's final newline)");
    assert.match(md, /15:17:30 {2}gamma/, "line 3 shows the hour it actually landed in");
    // The verbatim output is still there, untouched — a copy from the Out block yields clean text.
    assert.ok(md.includes("\nalpha\nbeta\ngamma\n"), "the raw Out survives without a gutter baked into it");
    // Same content through the HTML/PDF sink.
    const html = sessionToHtml(s, "ml-agent-ts1");
    assert.match(html, /Out · timed/, "the PDF sink emits it too");
    assert.match(html.replace(/<[^>]+>/g, ""), /14:17:30\s+alpha/);
});

test("non-streaming run: no marks means no timed block (never a guessed timestamp)", () => {
    const s = {
        hash: "ts2", kind: "agent", model: "m", tag: "session", createdTs: 1, lastTs: 2, status: "ok",
        turns: [], task: "run once", answers: [{ text: "done", ts: 9, atStep: 1, status: "ok" }],
        steps: [{ step: 1, localStep: 1, tool: "python_exec", arguments: { code: "print(1)" },
                  result: "1\n", renderOut: { type: "python-out", stdout: "1\n" } }],
    };
    const { md } = serializeSession(s);
    assert.doesNotMatch(md, /Out · timed/, "a run that never streamed has nothing to time");
    assert.match(md, /1/, "the output itself still exports");
});
