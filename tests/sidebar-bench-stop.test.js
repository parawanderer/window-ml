// sidebar-bench-stop.test.js — the python bench's header button: Run when idle, Stop while a script runs, and how a Stop's answer reads.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");

after(closeSidebarWorlds);

// --- the Run / Stop button ---

/** A bench world whose PYTHON_EXEC is HELD until the test answers it, and which records every other message. */
async function heldBench() {
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: 1, stdout: "" }) });
    const real = w.window.chrome.runtime.sendMessage;
    const held = [], seen = [];
    w.window.chrome.runtime.sendMessage = (msg, cb) => {
        if (msg && msg.type === "PYTHON_EXEC" && !msg.payload.env) { held.push({ msg, cb }); seen.push(msg); return; }
        if (msg && msg.type === "PYTHON_INTERRUPT") { seen.push(msg); cb && cb({ data: { interrupted: true } }); return; }
        return real(msg, cb);
    };
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code textarea");
    ta.value = "while True: pass"; ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    const btn = () => w.shadow.querySelector(".bench-play");
    const count = (t) => seen.filter((m) => m.type === t).length;
    return { w, held, seen, btn, count };
}

const KI = 'Traceback (most recent call last):\n  File "<python_exec>", line 1, in _user\nKeyboardInterrupt';

test("python bench: the header button reads Run when idle and Stop while a script runs, and is not disabled", async () => {
    const { w, held, btn } = await heldBench();
    assert.equal(btn().getAttribute("aria-label"), "Run");
    btn().click(); await w.tick();
    assert.equal(btn().getAttribute("aria-label"), "Stop");
    assert.equal(btn().disabled, false);
    held[0].cb({ data: { ok: true, value: 1, stdout: "" } }); await w.tick();
    assert.equal(btn().getAttribute("aria-label"), "Run");
});

test("python bench: clicking Stop sends exactly one PYTHON_INTERRUPT, with no requestId, however often it is clicked", async () => {
    const { w, seen, btn, count } = await heldBench();
    btn().click(); await w.tick();
    btn().click(); btn().click(); await w.tick();
    assert.equal(count("PYTHON_INTERRUPT"), 1);
    const m = seen.find((x) => x.type === "PYTHON_INTERRUPT");
    assert.deepEqual(Object.keys(m), ["type"], "no requestId, no payload");
});

test("python bench: Ctrl/Cmd+Enter while a script runs neither stops it nor starts a second one", async () => {
    const { w, btn, count } = await heldBench();
    btn().click(); await w.tick();
    const ta = w.shadow.querySelector(".bench-code textarea");
    for (const k of [{ ctrlKey: true }, { metaKey: true }]) {
        ta.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, ...k }));
    }
    await w.tick();
    assert.equal(count("PYTHON_INTERRUPT"), 0);
    assert.equal(count("PYTHON_EXEC"), 1);
});

// --- how a Stop ends ---

test("python bench: a KeyboardInterrupt after a Stop reads Stopped, with the traceback still shown", async () => {
    const { w, held, btn } = await heldBench();
    btn().click(); await w.tick();
    btn().click(); await w.tick();
    held[0].cb({ data: { ok: false, stdout: "", error: KI } }); await w.tick();
    assert.match(w.shadow.querySelector('.bench-lost[role="status"]').textContent, /^Stopped/);
    assert.match(w.shadow.querySelector(".bench-outbody").textContent, /KeyboardInterrupt/);
    assert.equal(btn().getAttribute("aria-label"), "Run", "and Stop can be pressed again on the next run");
});

test("python bench: a KeyboardInterrupt nobody asked for is the script's own error, not Stopped", async () => {
    const { w, held, btn } = await heldBench();
    btn().click(); await w.tick();
    held[0].cb({ data: { ok: false, stdout: "", error: KI } }); await w.tick();
    assert.equal(w.shadow.querySelector(".bench-lost"), null);
});

test("python bench: a restart (stopped: restarted) shows the response's own text and the variables-lost notice", async () => {
    const { w, held, btn } = await heldBench();
    btn().click(); await w.tick();
    btn().click(); await w.tick();
    const error = "Stopped by restarting the sandbox: it did not answer the interrupt, so its variables are gone.";
    held[0].cb({ data: { ok: false, stdout: "", error, stopped: "restarted" } }); await w.tick();
    assert.match(w.shadow.querySelector(".bench-outbody").textContent, /did not answer the interrupt/);
    assert.match(w.shadow.querySelector(".bench-lost").textContent, /variables from earlier runs are gone/);
    assert.ok(![...w.shadow.querySelectorAll(".bench-lost")].some((n) => /^Stopped$/.test(n.textContent.trim())), "no second Stopped line");
});
