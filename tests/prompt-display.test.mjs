// prompt-display.test.mjs — a person's message SHOWN as they wrote it while the model gets it framed: a right-clicked
// element is folded into the model's text (askAboutTask), and `PromptDisplay` keeps the typed words and the element
// beside it (framePrompt, src/agent/prompts.ts). Here: the helper, the line a list or title shows (promptLine, the
// session index), and run.json carrying both. The rendering and run.md are in sidebar-prompt-display.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";

const { framePrompt, askAboutTask } = await import("../src/agent/prompts.ts");
const { promptLine } = await import("../src/contract/contract-run.ts");
const { SessionIndex } = await import("../src/session/session-index.ts");
const { sessionToJson } = await import("../src/sidebar/export/export-json.ts");

const EL = { selector: "#price", role: "cell", text: "€4.20\nper kilo", media: [], links: [] };

// --- the one helper every "ask about this" path frames through ---

test("framePrompt: with an element, the model gets the framed text and the display keeps what was typed", () => {
    const r = framePrompt("  is this cheap?  ", EL);
    assert.equal(r.text, askAboutTask("  is this cheap?  ", EL), "the model's text is exactly the framing it always was");
    assert.match(r.text, /SELECTED CONTENT[\s\S]*€4\.20[\s\S]*User's question: is this cheap\?/);
    assert.deepEqual(r.display, { typed: "is this cheap?", context: [{ kind: "element", element: EL }] });
});

test("framePrompt: an element sent with no words asks the default question and shows no words", () => {
    const r = framePrompt("", EL);
    assert.match(r.text, /User's question: Tell me about the selected content\./);
    assert.equal(r.display.typed, "");
});

test("framePrompt: no element (or one with no selector) is the text as typed, with no display", () => {
    for (const ctx of [undefined, null, { role: "cell", text: "x" }]) {
        const r = framePrompt("hello", ctx);
        assert.equal(r.text, "hello");
        assert.equal("display" in r, false, "absent, not empty: the plain case records nothing new");
    }
});

// --- the line a list or a title shows ---

test("promptLine: the typed words, else what was attached, never the framed block", () => {
    const { text, display } = framePrompt("is this cheap?", EL);
    assert.equal(promptLine(text, display), "is this cheap?");
    const bare = framePrompt("", EL);
    assert.equal(promptLine(bare.text, bare.display), "About a selected cell");
    assert.equal(promptLine("plain words"), "plain words", "no display: the text is what was typed");
});

test("the session index lists an ask-about run by what was typed, and an old framed run as it always did", () => {
    const ix = new SessionIndex({ runtime: "local", spawn: "w1", now: () => 1 });
    const ev = (hash, over) => ({ kind: "agent", id: hash, ts: 1, save: false, session: { hash, turn: 0 }, model: "m", maxSteps: 10, config: null, ...over });
    const bg = { tabId: 4, trusted: true };
    const { text, display } = framePrompt("is this cheap?", EL);
    ix.ingest(ev("aaaa0001", { task: text, display }), bg);
    assert.equal(ix.get("aaaa0001").task, "is this cheap?");
    // UPGRADE: a run recorded before `display` existed has only the framed task, and keeps showing it.
    ix.ingest(ev("aaaa0002", { task: text }), bg);
    assert.match(ix.get("aaaa0002").task, /^The user RIGHT-CLICKED/);
    // A session whose first message is a follow-up takes its line from the say the same way.
    ix.ingest({ kind: "agent-say", id: "aaaa0003", ts: 1, save: false, session: { hash: "aaaa0003", turn: 0 }, text, display }, bg);
    assert.equal(ix.get("aaaa0003").task, "is this cheap?");
});

// --- run.json: the model's text stays `text`; the display rides beside it ---

const session = (over = {}) => ({
    hash: "abc12345", kind: "agent", model: "m", tag: "session", createdTs: 1_700_000_000_000, lastTs: 1_700_000_009_000,
    status: "ok", config: {}, turns: [], steps: [], maxSteps: 10, summary: "cheap", ...over,
});

test("run.json: the task and a follow-up keep the model's text, with the display beside each", () => {
    const first = framePrompt("is this cheap?", EL);
    const next = framePrompt("and this one?", { ...EL, selector: "#other" });
    const s = session({
        task: first.text, taskDisplay: first.display,
        says: [{ text: next.text, ts: 1_700_000_005_000, atStep: 1, display: next.display }],
        answers: [{ text: "yes", ts: 1_700_000_004_000, atStep: 1, status: "ok" }, { text: "no", ts: 1_700_000_008_000, atStep: 2, status: "ok" }],
    });
    const out = sessionToJson(s).session;
    assert.equal(out.task, first.text, "what the model got");
    assert.deepEqual(out.taskDisplay, first.display);
    const say = out.messages.find((m) => m.role === "user");
    assert.equal(say.text, next.text);
    assert.deepEqual(say.display, next.display);
});

test("run.json UPGRADE: a session recorded before display existed exports exactly as before, with no display keys", () => {
    const framed = askAboutTask("is this cheap?", EL);
    const out = sessionToJson(session({ task: framed, says: [{ text: framed, ts: 1_700_000_005_000, atStep: 1 }] })).session;
    assert.equal(out.task, framed);
    assert.equal("taskDisplay" in out, false);
    assert.ok(out.messages.every((m) => !("display" in m)));
});
