// liveCallView (src/sidebar/transcript/live-call-view.ts): what a tool call still being WRITTEN is drawn as.
import { test } from "node:test";
import assert from "node:assert";
import { liveCallView } from "../src/sidebar/transcript/live-call-view.ts";

const call = (name, args) => ({ index: 0, ...(name ? { name } : {}), ...(args != null ? { args, chars: args.length } : { chars: 1234 }) });

// --- the text tools: their one long argument, growing, with the caret where it grows ---

test("python_exec, exec and answer show their text as it stands, at every prefix, and the caret while it is the part arriving", () => {
    for (const [name, field, as] of [["python_exec", "code", "python"], ["exec", "js", "javascript"], ["answer", "text", "markdown"]]) {
        const text = 'line "one"\n\tline two \\ é\n';
        const whole = JSON.stringify({ title: "t", [field]: text });
        for (let n = 0; n <= whole.length; n++) {
            const v = liveCallView(call(name, whole.slice(0, n)));
            assert.equal(v.kind, "text", `${name} at ${n}`);
            assert.equal(v.as, as);
            assert.ok(text.startsWith(v.text), `${name} at ${n}: only what was written`);
        }
        assert.equal(liveCallView(call(name, whole)).writing, false, `${name}: a whole call has no caret`);
        assert.equal(liveCallView(call(name, whole.slice(0, -5))).writing, true, `${name}: mid-field, the caret`);
        assert.equal(liveCallView(call(name, '{"title": "t')).writing, true, `${name}: its field not begun, the caret waits for it`);
        assert.equal(liveCallView(call(name, "")).text, "", "nothing yet");
    }
});

test("a text field written FIRST and then another key: the caret leaves the text once the model moved on", () => {
    const v = liveCallView(call("python_exec", '{"code": "print(1)", "mode": "scr'));
    assert.equal(v.kind, "text");
    assert.equal(v.text, "print(1)");
    assert.equal(v.writing, false, "it is writing `mode` now, not the code");
});

// --- everything else: the tree of the arguments so far ---

test("any other tool, or one not named yet, is the tree of its arguments so far; a finished answer without text too", () => {
    const t = liveCallView(call("fetch_url", '{"url": "https://exa'));
    assert.equal(t.kind, "tree");
    assert.deepEqual(t.value, { url: "https://exa" });
    assert.equal(t.writing, true);
    assert.equal(liveCallView(call(undefined, '{"code": "x')).kind, "tree", "unnamed: no guessing which tool it is");
    const sel = liveCallView(call("answer", '{"selector": "#total"}'));
    assert.equal(sel.kind, "tree", "an answer designating an element has no text to show");
    assert.equal(sel.writing, false);
});

test("text that is not JSON is shown verbatim, and a preview a hub cut to its size is just the size", () => {
    assert.deepEqual(liveCallView(call("look", "not json")), { kind: "raw", text: "not json" });
    assert.deepEqual(liveCallView(call("python_exec")), { kind: "size", chars: 1234 });
});
