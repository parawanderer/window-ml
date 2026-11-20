// composer-chips.test.mjs — the composer's chips for registered values (ruling 39, PR 2; docs/spec/SECRET_HANDLES.md, "What the
// person sees"): the pure rules (src/sidebar/transcript/turn-scan.ts), the hook that scans a draft debounced and drops a stale
// answer, the chip row, the markers and the "Sent as is" line in a bubble, and the two exports. Names only: never a token or a value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import "./stub-css.mjs";

const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, getComputedStyle: dom.window.getComputedStyle, HTMLElement: dom.window.HTMLElement });
const { h, render } = createRequire(import.meta.url)("preact");
const T = await import("../src/sidebar/transcript/turn-scan.ts");
const UI = await import("../src/sidebar/transcript/turn-scan-ui.tsx");
const { UserText, SentAsIs } = await import("../src/sidebar/transcript/user-text.tsx");
const { installServices, services } = await import("../src/sidebar/services.ts");
const { serializeSession } = await import("../src/sidebar/export/export.ts");
const { sessionToJson } = await import("../src/sidebar/export/export-json.ts");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const span = (name, token, start = 0, end = 3) => ({ start, end, name, token });

// --- the pure rules: spans to chips, choices to tokens ---

test("one chip per distinct value of the typed words, counted, in the order they first appear", () => {
    const scan = T.readScan({ data: { spans: [[span("A", "ta"), span("B", "tb"), span("A", "ta", 9, 12)], [span("A", "ta")]] } }, [1]);
    assert.deepEqual(T.chipsOf(scan), [{ token: "ta", name: "A", count: 2 }, { token: "tb", name: "B", count: 1 }]);
});

test("a file's count is its own spans, and its tokens are what 'send as is' for the file chooses", () => {
    const scan = T.readScan({ data: { spans: [[], [span("A", "ta"), span("A", "ta", 5, 8), span("B", "tb")]] } }, [-1, 1]);
    assert.equal(T.fileScanOf(scan, 0), null, "a file that was not scanned has no count");
    assert.deepEqual(T.fileScanOf(scan, 1), { count: 3, tokens: ["ta", "tb"], names: ["A", "B"] });
    let chosen = T.toggleFile(new Set(), ["ta", "tb"]);
    assert.deepEqual([...chosen], ["ta", "tb"]);
    assert.deepEqual([...T.toggleFile(chosen, ["ta", "tb"])], [], "all chosen: the same press takes them all back");
    assert.deepEqual([...T.toggleFile(new Set(["ta"]), ["ta", "tb"])].sort(), ["ta", "tb"], "some chosen: the press chooses the rest");
});

test("a send carries the chosen tokens the latest scan still holds, once each, and nothing when none", () => {
    const scan = T.readScan({ data: { spans: [[span("A", "ta"), span("A", "ta", 9, 12)], [span("A", "ta"), span("B", "tb")]] } }, [1]);
    assert.deepEqual(T.asIsFor(new Set(["ta", "gone"]), scan), ["ta"], "a token no longer in the scan is dropped, a repeated one is sent once");
    assert.equal(T.asIsFor(new Set(["gone"]), scan), undefined);
    assert.equal(T.asIsFor(new Set(), scan), undefined);
    assert.equal(T.asIsFor(new Set(["ta"]), T.readScan({ data: { spans: [[]], off: true } }, [])), undefined, "scrub off: nothing to exempt");
    const next = T.readScan({ data: { spans: [[span("B", "tb")]] } }, []);
    assert.deepEqual([...T.pruneChosen(new Set(["ta", "tb"]), next)], ["tb"], "a new scan drops what the draft no longer holds");
    const same = new Set(["tb"]);
    assert.equal(T.pruneChosen(same, next), same, "nothing dropped: the same set, so a state setter sees no change");
});

test("the worker's answer is read defensively: off, unreadable, refused and nonsense all mean no chips", () => {
    assert.equal(T.readScan({ data: { spans: [[]], off: true } }, []).off, true);
    assert.equal(T.readScan({ error: "x", unreadable: true }, []).unreadable, true);
    for (const res of [{ error: "refused" }, null, undefined, 7, { data: {} }, { data: { spans: "no" } }]) {
        const s = T.readScan(res, []);
        assert.deepEqual(T.chipsOf(s), [], JSON.stringify(res));
        assert.equal(s.unreadable, false);
    }
    assert.deepEqual(T.readScan({ data: { spans: [[{ name: "A" }, span("B", "tb"), null]] } }, []).spans, [[span("B", "tb")]], "a malformed span is dropped");
});

test("the texts to scan are the typed words, then each text file: a PDF and a refused file are not scanned, 64 at most", () => {
    const docs = [{ text: "a" }, { data: "JVBER" }, { why: "not text" }, { text: "b" }];
    assert.deepEqual(T.textsToScan("hi", docs), { texts: ["hi", "a", "b"], fileAt: [1, -1, -1, 2] });
    const many = Array.from({ length: 80 }, (_, i) => ({ text: `t${i}` }));
    const { texts, fileAt } = T.textsToScan("x", many);
    assert.equal(texts.length, 64);
    assert.equal(fileAt.filter((i) => i >= 0).length, 63);
});

test("what a shell relays: strings only, at most 64, or nothing", () => {
    assert.deepEqual(T.cleanAsIs(["a", 3, "", "b"]), ["a", "b"]);
    assert.equal(T.cleanAsIs([]), undefined);
    assert.equal(T.cleanAsIs("a"), undefined);
    assert.equal(T.cleanAsIs(Array.from({ length: 100 }, (_, i) => `t${i}`)).length, 64);
});

test("a message is split at its markers, and a message without one is one text part", () => {
    assert.deepEqual(T.splitMarks("use [REDACTED:PLUG_PASSWORD] and [REDACTED:window-ml-api-key]."), [
        { text: "use " }, { mark: "PLUG_PASSWORD" }, { text: " and " }, { mark: "window-ml-api-key" }, { text: "." }]);
    assert.deepEqual(T.splitMarks("plain"), [{ text: "plain" }]);
    assert.deepEqual(T.splitMarks("[REDACTED:A b]"), [{ text: "[REDACTED:A b]" }], "not a marker the scrub writes");
});

// --- the hook: debounced, stale answers dropped, never a block ---

/** Draw a probe that shows what the hook returns; `set(typed)` re-renders it with other words. */
function probe(scope = "s") {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const out = { state: null, docs: [], typed: "" };
    const Probe = (_props) => { out.state = UI.useTurnScan(out.typed, out.docs, scope); return h(UI.TurnChips, { chips: out.state.chips, onToggle: out.state.toggle, unreadable: out.state.unreadable }); };
    // One component for the probe's life, or every `set` would mount a new one and lose the hook's state.
    out.set = (typed, docs = out.docs) => { out.typed = typed; out.docs = docs; render(h(Probe, { n: ++out.n }), root); };
    out.n = 0;
    out.root = root;
    return out;
}

test("the draft is scanned once, after the last edit; chips name the value and a press chooses it for the send", async () => {
    const asked = [];
    installServices({ ...services(), scanTurn: async (texts, scope) => { asked.push({ texts, scope }); return { data: { spans: [[span("PLUG_PASSWORD", "tok1")]] } }; } });
    const p = probe("sess");
    p.set("a"); p.set("ab"); p.set("abc");
    await wait(UI.SCAN_DEBOUNCE_MS + 80);
    assert.equal(asked.length, 1, "three keystrokes, one question");
    assert.deepEqual(asked[0], { texts: ["abc"], scope: "sess" });
    const chip = p.root.querySelector(".tchip");
    assert.equal(chip.querySelector(".tchip-name").textContent, "PLUG_PASSWORD");
    assert.equal(chip.textContent.includes("tok1"), false, "never a token on screen");
    assert.equal(p.state.asIs(), undefined, "nothing is sent as is until it is chosen");
    chip.querySelector("button").click();
    await wait(60);
    assert.deepEqual(p.state.asIs(), ["tok1"]);
    assert.equal(p.root.querySelector(".tchip.on .tchip-as").textContent, "sent as is");
    p.state.reset();
    await wait(60);
    assert.equal(p.state.asIs(), undefined, "a sent or cleared draft forgets its choices");
});

test("an answer for an older draft is dropped", async () => {
    let n = 0;
    installServices({ ...services(), scanTurn: async (texts) => { const mine = ++n; await wait(mine === 1 ? 120 : 5); return { data: { spans: [[span(mine === 1 ? "OLD" : "NEW", `t${mine}`)]] } }; } });
    const p = probe();
    p.set("first");
    await wait(UI.SCAN_DEBOUNCE_MS + 30);   // the first question is out and slow
    p.set("second");
    await wait(UI.SCAN_DEBOUNCE_MS + 250);
    assert.deepEqual(p.state.chips.map((c) => c.name), ["NEW"]);
});

test("an emptied draft drops its chips and its choices at once, with no question asked", async () => {
    let asked = 0;
    installServices({ ...services(), scanTurn: async () => { asked++; return { data: { spans: [[span("A", "ta")]] } }; } });
    const p = probe();
    p.set("x");
    await wait(UI.SCAN_DEBOUNCE_MS + 80);
    p.state.toggle("ta");
    await wait(60);
    p.set("");
    await wait(600);
    assert.deepEqual(p.state.chips, []);
    assert.equal(p.state.asIs(), undefined);
    assert.equal(asked, 1);
});

test("a host that cannot scan gets no chips, and an unreadable store gets one quiet line", async () => {
    installServices({ ...services(), scanTurn: undefined });
    const none = probe();
    none.set("secret?");
    await wait(UI.SCAN_DEBOUNCE_MS + 50);
    assert.equal(none.root.innerHTML, "");
    installServices({ ...services(), scanTurn: async () => ({ error: "locked", unreadable: true }) });
    const bad = probe();
    bad.set("x");
    await wait(UI.SCAN_DEBOUNCE_MS + 50);
    assert.match(bad.root.querySelector(".tchips-note").textContent, /secret store could not be read/);
    assert.equal(bad.state.asIs(), undefined);
});

test("a file with registered values shows a count; its press chooses every value in it", async () => {
    installServices({ ...services(), scanTurn: async () => ({ data: { spans: [[], [span("A", "ta"), span("B", "tb")]] } }) });
    const doc = { name: "n.txt", type: "text/plain", text: "xx" };
    const p = probe();
    p.set("", [doc]);
    await wait(UI.SCAN_DEBOUNCE_MS + 80);
    const f = p.state.file(0);
    assert.equal(f.count, 2);
    assert.deepEqual(f.names, ["A", "B"]);
    f.onToggle();
    await wait(60);
    assert.deepEqual(p.state.asIs(), ["ta", "tb"]);
    assert.equal(p.state.file(0).on, true);
    p.set("", [{ ...doc }]);   // another file in its place: no count until it is scanned
    assert.equal(p.state.file(0), null);
});

// --- the transcript: markers and the quiet line ---

test("a message you sent shows each marker as a chip with the name; the raw view keeps the text as stored", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(h(UserText, { text: "pw is [REDACTED:PLUG_PASSWORD] ok", marks: true }), root);
    assert.equal(root.querySelector(".utext-mark").textContent, "PLUG_PASSWORD");
    assert.equal(root.querySelector(".utext").textContent, "pw is PLUG_PASSWORD ok");
    render(h(UserText, { text: "pw is [REDACTED:PLUG_PASSWORD] ok" }), root);
    assert.equal(root.querySelector(".utext-mark"), null);
    assert.equal(root.querySelector(".utext").textContent, "pw is [REDACTED:PLUG_PASSWORD] ok");
});

test("the 'Sent as is' line names the values, once each, and is absent without any", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(h(SentAsIs, { names: ["A", "B", "A"] }), root);
    assert.equal(root.querySelector(".sent-asis").textContent, "Sent as is: A, B");
    render(h(SentAsIs, { names: [] }), root);
    assert.equal(root.querySelector(".sent-asis"), null);
    render(h(SentAsIs, {}), root);
    assert.equal(root.querySelector(".sent-asis"), null);
});

// --- the exports: names, never a token ---

const withAsIs = {
    hash: "ab", kind: "chat", model: "m", tag: "chat", createdTs: 1, lastTs: 2, status: "ok", steps: [], config: {},
    turns: [{ id: "t1", ts: 1, user: "pw is hunter2 and a", assistant: "ok", status: "ok", display: { typed: "pw is hunter2 and a", context: [], asIs: ["PLUG_PASSWORD"] } }],
};

test("the Markdown export says which registered values were sent as is", () => {
    const { md } = serializeSession(withAsIs);
    assert.match(md, /> _Sent as is: PLUG_PASSWORD_/);
});

test("the JSON export carries the names in the turn's display", () => {
    const json = JSON.stringify(sessionToJson(withAsIs));
    assert.match(json, /"asIs":\["PLUG_PASSWORD"\]/);
});
