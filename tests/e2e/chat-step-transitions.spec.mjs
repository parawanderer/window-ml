// chat-step-transitions.spec.mjs — the calm chat's agent-step transitions that used to jump-cut, one row each, sampled on every
// animation frame against the web build (dist-web/) and the fake host's scripted events.
//
// A final state cannot see a one-frame fault, so each row reads the layout per frame and asserts on its SHAPE, with the invariants of
// chat-transitions.spec.mjs: a change of more than 60 px takes at least 60 ms, no single frame moves more than 70% of a change, and
// a fade is a run of opacities between its ends. Then the same rows under prefers-reduced-motion, where each is a state change and
// nothing is animated.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";
import { runsOf } from "./frame-runs.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
const DESKTOP = { width: 1280, height: 800 };
const RUN = "laptop:9a8b7c6d";
const CHAT = "laptop:5c4d3e2f";

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "chat.js")), `no web build at ${ROOT} (npm run build)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

/** A session of `kind` ("agent" | "chat") opened in a fresh page, with `emit(event)` for what the run or the chat does next and
 *  `frames(ms, during, probe)` for the page's state on every animation frame while `during` runs and for `ms` after.
 *  `probe` is the source of a function body returning one frame's measurements (it runs in the page). */
async function session(kind, { reducedMotion = "no-preference", pending = false } = {}) {
    const page = await browser.newPage({ viewport: DESKTOP, reducedMotion });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.locator(".chat").waitFor();
    const key = kind === "agent" ? RUN : CHAT;
    const hash = key.split(":")[1];
    await page.evaluate(([key, kind]) => {
        const [runtime, hash] = key.split(":");
        const now = Date.now();
        const first = kind === "agent"
            ? { id: `${hash}-0`, ts: now, save: true, session: { hash, turn: 0 }, kind: "agent", task: "find fares", model: "qwen3:32b", maxSteps: 30, config: undefined }
            : { id: `${hash}-0`, ts: now, save: true, session: { hash, turn: 0 }, kind: "chat", streaming: false,
                request: { model: "fake", extend: null, messages: [{ role: "user", content: "say hello" }], images: null, toolIds: null, schema: false, think: null, maxTokens: null },
                config: { system: null, model: "fake", think: null, schema: false, toolIds: null, maxTokens: null, save: true } };
        globalThis.__chatFake.addSession({ id: { runtime, hash }, kind, status: kind === "agent" ? "running" : "done", createdTs: now, lastTs: now, pendingApprovals: 0, saved: true, title: "Live", task: kind === "agent" ? "find fares" : "say hello", model: kind === "agent" ? "qwen3:32b" : "fake" }, [first]);
    }, [key, kind]);
    await page.goto(server.url + `#/s/${encodeURIComponent(key)}`);
    await page.locator(".chat-transcript").waitFor();
    const emit = (ev) => page.evaluate(([key, ev]) => {
        const hash = key.split(":")[1];
        globalThis.__chatFake.emit(key, { id: `${hash}-0`, ts: Date.now(), save: true, session: { hash, turn: 0 }, ...ev });
    }, [key, ev]);
    const step = (over) => emit({ kind: "agent-step", step: 1, seq: 1, tool: "exec", approval: "readonly", arguments: { js: "document.title" }, ...over });
    const frames = async (ms, during, probe) => {
        await page.evaluate((src) => {
            const fn = new Function("t", src);
            const out = globalThis.__fr = [];
            const t0 = performance.now();
            const tick = () => { out.push({ t: performance.now() - t0, ...fn(performance.now() - t0) }); if (globalThis.__fr === out) requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
        }, probe);
        await page.waitForTimeout(100);
        await during();
        await page.waitForTimeout(ms);
        return page.evaluate(() => { const f = globalThis.__fr; globalThis.__fr = null; return f; });
    };
    return { page, errors, emit, step, frames, hash };
}

/** Assert that every change of more than `min` px in `series` is a run: it takes time, and no frame carries most of it. */
function expectSmooth(series, what, min = 6) {
    const dump = `${what}: ${sample(series).map((p) => `${Math.round(p.t)}:${Math.round(p.v * 10) / 10}`).join(" ")}`;
    for (const r of runsOf(series, 0.25).filter((r) => r.total > min)) {
        expect(r.duration, `${what}: a ${Math.round(r.total)}px change took ${Math.round(r.duration)}ms, it snapped (${Math.round(r.from)} -> ${Math.round(r.to)})\n${dump}`).toBeGreaterThanOrEqual(60);
        expect(r.maxStep, `${what}: one frame moved ${Math.round(r.maxStep)}px of a ${Math.round(r.total)}px change\n${dump}`).toBeLessThanOrEqual(r.total * 0.7);
    }
}
/** At most ~24 evenly spaced frames, for a failure message. */
const sample = (a) => a.filter((_, i) => i % Math.max(1, Math.ceil(a.length / 24)) === 0);
const series = (frames, key) => frames.filter((f) => f[key] != null).map((f) => ({ t: f.t, v: f[key] }));

// The prompt's bottom edge is the origin every position is measured from: it does not move, and a scroll does not shift it.
const TOOL_PROBE = `
    const user = document.querySelector(".chat-transcript .msg.user");
    const o = user ? user.getBoundingClientRect().bottom : 0;
    const el = document.querySelector(".chat-transcript .astep.tool");
    const r = el?.getBoundingClientRect();
    const dot = el?.querySelector(".dot");
    return { top: r ? r.top - o : null, h: r ? r.height : null, n: document.querySelectorAll(".chat-transcript .astep.tool").length,
        aturns: document.querySelectorAll(".chat-transcript .aturn").length, dot: dot ? dot.className : null, cls: el ? el.className : null,
        color: dot ? getComputedStyle(dot).backgroundColor : null };`;

// --- 1. a finished tool call settles in place ---

test("1. a tool call that finishes collapses and turns green where it stands: its top stays put, no block appears above it, its height change is a run", async () => {
    const { page, errors, emit, step, frames } = await session("agent");
    await emit({ kind: "agent-stream", step: 1, calls: [{ index: 0, name: "exec", args: '{"js": "document.title"}', chars: 24 }] });
    await page.waitForTimeout(1600);
    await step({ pending: true });
    await page.waitForTimeout(1600);
    const f = await frames(4500, () => step({ pending: false, result: "ok", toolMs: 200 }), TOOL_PROBE);
    const seen = f.filter((x) => x.top != null);
    expect(seen.length).toBeGreaterThan(20);
    const dump = sample(f).map((x) => `${Math.round(x.t)}ms top=${x.top && Math.round(x.top)} h=${x.h && Math.round(x.h)} n=${x.n} aturns=${x.aturns} dot=${x.dot}`).join("\n");
    // In place: the block's top never moves relative to the prompt, and no second block stands beside it.
    expect(Math.max(...seen.map((x) => x.top)) - Math.min(...seen.map((x) => x.top)), `the block moved (a new block appeared above it?)\n${dump}`).toBeLessThanOrEqual(2);
    expect(Math.max(...f.map((x) => x.n)), `two tool blocks stood at once\n${dump}`).toBeLessThanOrEqual(1);
    expect(Math.max(...f.map((x) => x.aturns)), `a turn block was added around the step\n${dump}`).toBeLessThanOrEqual(1);
    // Green: the same block ends with an ok dot, and the colour is reached over frames, not in one.
    expect(seen.at(-1).dot, dump).toMatch(/\bok\b/);
    const colours = [...new Set(seen.map((x) => x.color))];
    expect(colours.length, `the dot jumped colour with no frame between\n${dump}`).toBeGreaterThan(2);
    // Collapsed: it ends short, over time.
    expectSmooth(series(f, "h"), "the step's height");
    expect(seen.at(-1).h, dump).toBeLessThan(80);
    expect(errors).toEqual([]);
    await page.close();
});

// --- 2. the live block's offsets ---

const LIVE_PROBE = `
    const live = document.querySelector(".chat-transcript .live-call");
    const think = document.querySelector(".chat-transcript .athinking");
    const hold = document.querySelector(".chat-transcript .live-hold");
    const user = document.querySelector(".chat-transcript .msg.user");
    const body = live?.querySelector(".astep-body");
    const cs = (el, p) => el ? parseFloat(getComputedStyle(el)[p]) : null;
    return { gap: live && think ? live.getBoundingClientRect().top - think.getBoundingClientRect().bottom : null,
        off: live && user ? live.getBoundingClientRect().top - user.getBoundingClientRect().bottom : null,
        padT: cs(body, "paddingTop"), padB: cs(body, "paddingBottom"), padL: cs(body, "paddingLeft"), holdT: cs(hold, "paddingTop"), holdM: cs(hold, "marginTop"),
        h: live ? live.getBoundingClientRect().height : null };`;

test("2. the live block's padding and offset change smoothly while it is written and when its step takes over", async () => {
    const { page, errors, emit, step, frames } = await session("agent");
    const f = await frames(3800, async () => {
        await emit({ kind: "agent-stream", step: 1, reasoning: "I should read the title first." });
        await page.waitForTimeout(300);
        await emit({ kind: "agent-stream", step: 1, reasoning: "I should read the title first.", calls: [{ index: 0, name: "exec", args: '{"js": "docu', chars: 12 }] });
        await page.waitForTimeout(300);
        await emit({ kind: "agent-stream", step: 1, reasoning: "I should read the title first.", calls: [{ index: 0, name: "exec", args: '{"js": "document.title"}', chars: 24 }] });
        await page.waitForTimeout(1500);
        await step({ pending: true });
    }, LIVE_PROBE);
    expect(f.filter((x) => x.off != null).length, "the live block was never drawn").toBeGreaterThan(20);
    for (const k of ["gap", "off", "padT", "padB", "padL", "holdT", "holdM"]) expectSmooth(series(f, k), `live block ${k}`, 3);
    expect(errors).toEqual([]);
    await page.close();
});

// --- chat turns: 3, 4, 5 ---

const REPLY_PROBE = `
    const msg = document.querySelector(".chat-transcript .msg.asst");
    const note = msg?.querySelector(".pending-note");
    const body = msg?.querySelector(".asst-body");
    const md = msg?.querySelector(".asst-body .md, .asst-body .asst-answer, .asst-body p");
    const row = msg?.querySelector(".mrow");
    const stamp = msg?.querySelector(".mrow .time");
    const op = (el) => { let v = 1; for (let n = el; n && n !== document.body; n = n.parentElement) v *= parseFloat(getComputedStyle(n).opacity); return v; };
    return { note: note ? op(note) : null, noteH: note ? note.getBoundingClientRect().height : null, hasNote: !!note,
        body: body ? op(body) : null, text: md ? op(md) : null, msgH: msg ? msg.getBoundingClientRect().height : null,
        row: row ? row.getBoundingClientRect().height : null, stamp: stamp ? op(stamp) : null, stampW: stamp ? stamp.getBoundingClientRect().width : null,
        words: msg ? msg.querySelectorAll(".asst-body .word, .asst-body [data-w]").length : 0 };`;
const reply = (emit, text = "Hello there, this is the answer.") => emit({ kind: "chat-result", content: text, sources: null, structured: false, model: "fake", extend: null, reasoning: null, usage: null });

test("3. the thinking indicator fades to nothing, and is removed only once it has", async () => {
    const { page, errors, emit, frames } = await session("chat");
    await expect(page.locator(".msg.asst .pending-note")).toBeVisible();
    await page.waitForTimeout(700);
    const f = await frames(1500, () => reply(emit), REPLY_PROBE);
    const note = f.filter((x) => x.hasNote);
    const dump = sample(f).map((x) => `${Math.round(x.t)}ms note=${x.note && x.note.toFixed(2)} h=${x.noteH && Math.round(x.noteH)}`).join("\n");
    expect(note.length, `the indicator was never seen\n${dump}`).toBeGreaterThan(0);
    expect(note.some((x) => x.note > 0.05 && x.note < 0.95), `the indicator was removed without an opacity run\n${dump}`).toBe(true);
    expect(note.at(-1).note, `the indicator was removed while still visible\n${dump}`).toBeLessThanOrEqual(0.1);
    expect(errors).toEqual([]);
    await page.close();
});

test("4. the final reply's text fades in: an opacity run from nothing", async () => {
    const { page, errors, emit, frames } = await session("chat");
    await page.waitForTimeout(700);
    const f = await frames(1500, () => reply(emit), REPLY_PROBE);
    const text = f.filter((x) => x.text != null);
    const dump = sample(f).map((x) => `${Math.round(x.t)}ms text=${x.text && x.text.toFixed(2)} body=${x.body && x.body.toFixed(2)}`).join("\n");
    expect(text.length, `the reply was never drawn\n${dump}`).toBeGreaterThan(0);
    expect(text[0].text, `the reply's first frame was already opaque\n${dump}`).toBeLessThan(0.2);
    expect(text.some((x) => x.text > 0.2 && x.text < 0.9), `no frame between hidden and shown\n${dump}`).toBe(true);
    expect(text.at(-1).text).toBeGreaterThan(0.98);
    expect(errors).toEqual([]);
    await page.close();
});

test("5. the reply's time row grows into place: its height change is a run, not a step", async () => {
    const { page, errors, emit, frames } = await session("chat");
    await page.waitForTimeout(700);
    const f = await frames(1800, () => reply(emit), REPLY_PROBE);
    expectSmooth(series(f, "row"), "the reply header row", 3);
    expectSmooth(series(f, "msgH"), "the reply's height", 6);
    // The time itself arrives with it: not at full width and opacity in the first frame the row is drawn.
    const stamp = f.filter((x) => x.stamp != null);
    expect(stamp.length).toBeGreaterThan(0);
    expect(stamp.some((x) => x.stamp > 0.05 && x.stamp < 0.95 || x.stampW < stamp.at(-1).stampW - 1), "the time was cut in at full strength").toBe(true);
    expect(errors).toEqual([]);
    await page.close();
});

// --- 6. live JSON args ---

const ARGS_PROBE = `
    const live = document.querySelector(".chat-transcript .live-call");
    const args = live?.querySelector(".jt-args");
    const caret = live?.querySelector(".live-caret");
    const rows = args ? [...args.querySelectorAll(".jt-val")]   /* the closing brace row is the tree's, not the model's text */ : [];
    const last = rows.reduce((a, el) => { const r = el.getBoundingClientRect(); return r.width && (!a || r.bottom > a.bottom + 0.5 || (Math.abs(r.bottom - a.bottom) <= 0.5 && r.right > a.right)) ? r : a; }, null);
    const c = caret?.getBoundingClientRect();
    const bg = (el) => { let n = el; while (n && n !== document.body) { const b = getComputedStyle(n).backgroundColor; if (!/rgba?\\(0, 0, 0, 0\\)|transparent/.test(b)) return b; n = n.parentElement; } return "none"; };
    return { has: !!args, bg: args ? bg(args) : null, ownBg: args ? getComputedStyle(args).backgroundColor : null, caret: !!caret,
        dx: c && last ? c.left - last.right : null, dy: c && last ? (c.top + c.height / 2) - (last.top + last.height / 2) : null, lastBottom: last?.bottom ?? null, caretBottom: c?.bottom ?? null };`;

test("6. live JSON arguments: the background is there from the first frame and the caret sits at the end of the text", async () => {
    const { page, errors, emit, frames } = await session("agent");
    const f = await frames(1200, async () => {
        await emit({ kind: "agent-stream", step: 1, calls: [{ index: 0, name: "fetch_url", args: '{"url": "https://example.com/fares", "format": "mark', chars: 50 }] });
        await page.waitForTimeout(250);
        await emit({ kind: "agent-stream", step: 1, calls: [{ index: 0, name: "fetch_url", args: '{"url": "https://example.com/fares", "format": "markdown", "maxChars": 20', chars: 70 }] });
    }, ARGS_PROBE);
    const seen = f.filter((x) => x.has);
    const dump = sample(seen).map((x) => `${Math.round(x.t)}ms ownBg=${x.ownBg} bg=${x.bg} caret=${x.caret} dx=${x.dx && Math.round(x.dx)} dy=${x.dy && Math.round(x.dy)}`).join("\n");
    expect(seen.length, "no JSON arguments were drawn").toBeGreaterThan(5);
    expect(seen[0].ownBg, `the arguments had no background of their own in their first frame\n${dump}`).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(new Set(seen.map((x) => x.ownBg)).size, `the background changed while writing\n${dump}`).toBe(1);
    const withCaret = seen.filter((x) => x.caret);
    expect(withCaret.length, `no caret was drawn\n${dump}`).toBeGreaterThan(0);
    for (const x of withCaret) {
        expect(Math.abs(x.dy), `the caret is on a different line than the last text (dy=${x.dy})\n${dump}`).toBeLessThanOrEqual(10);
        expect(x.dx, `the caret is not after the last text (dx=${x.dx})\n${dump}`).toBeGreaterThanOrEqual(-2);
        expect(x.dx, `the caret is far from the end of the text (dx=${x.dx})\n${dump}`).toBeLessThanOrEqual(40);
    }
    expect(errors).toEqual([]);
    await page.close();
});

// --- 7. the composer placeholder ---

const PH_PROBE = `
    const el = document.querySelector(".composer .cinput");
    const cs = el ? getComputedStyle(el, "::placeholder") : null;
    const alpha = cs ? (() => { const m = cs.color.match(/[\\d.]+/g); return (m.length > 3 ? parseFloat(m[3]) : 1) * parseFloat(cs.opacity); })() : null;
    return { ph: el ? el.getAttribute("placeholder") : null, a: alpha };`;

test("7. the composer's placeholder fades between its two sentences instead of cutting, and changes its words while invisible", async () => {
    const { page, errors, emit, frames } = await session("agent");
    await expect(page.locator(".composer .cinput")).toHaveAttribute("placeholder", /Steer/);
    await page.waitForTimeout(500);
    const f = await frames(1500, () => emit({ kind: "agent-result", summary: "Done.", steps: 0, hitCap: false }), PH_PROBE);
    const dump = sample(f).map((x) => `${Math.round(x.t)}ms a=${x.a && x.a.toFixed(2)} ph=${x.ph}`).join("\n");
    const phs = [...new Set(f.map((x) => x.ph))];
    expect(phs.length, `the placeholder never changed\n${dump}`).toBe(2);
    const swap = f.findIndex((x, i) => i > 0 && x.ph !== f[i - 1].ph);
    expect(f[swap].a, `the words changed while the placeholder was ${f[swap].a} visible\n${dump}`).toBeLessThan(0.15);
    expect(f.some((x) => x.a > 0.1 && x.a < 0.9), `no frame between visible and hidden\n${dump}`).toBe(true);
    expect(f.at(-1).a, dump).toBeGreaterThan(0.95);
    expect(errors).toEqual([]);
    await page.close();
});

// --- 8. reduced motion ---

test("8. with reduced motion every row above is a state change: nothing animates or transitions, and nothing breaks", async () => {
    // The agent's run: live call -> pending step -> done step -> result.
    const a = await session("agent", { reducedMotion: "reduce" });
    const moving = (page) => page.evaluate(() => [...document.querySelector(".chat-transcript").getAnimations({ subtree: true }), ...document.querySelector(".composer").getAnimations({ subtree: true })].map((x) => x.animationName || x.transitionProperty).filter((n) => n !== "live-caret"));
    const seen = new Set();
    const watch = async (page) => { for (const n of await moving(page)) seen.add(n); };
    await a.emit({ kind: "agent-stream", step: 1, reasoning: "Reading.", calls: [{ index: 0, name: "fetch_url", args: '{"url": "https://example.com", "format": "mark', chars: 40 }] });
    await a.page.waitForTimeout(300); await watch(a.page);
    await a.step({ pending: true });
    await a.page.waitForTimeout(1500); await watch(a.page);
    await a.step({ pending: false, result: "ok", toolMs: 200 });
    for (let i = 0; i < 8; i++) { await a.page.waitForTimeout(500); await watch(a.page); }
    await a.emit({ kind: "agent-result", summary: "Done, three fares.", steps: 1, hitCap: false });
    for (let i = 0; i < 4; i++) { await a.page.waitForTimeout(150); await watch(a.page); }
    expect(await a.page.locator(".composer .cinput").getAttribute("placeholder")).toMatch(/continue/);
    expect([...seen], "nothing animated or transitioned").toEqual([]);
    await expect(a.page.locator(".msg.asst .md")).toHaveText("Done, three fares.");
    expect(a.errors).toEqual([]);
    await a.page.close();

    // A chat turn: the indicator goes at once with the reply, and the reply is there at full strength in its first frame.
    const c = await session("chat", { reducedMotion: "reduce" });
    await expect(c.page.locator(".msg.asst .pending-note")).toBeVisible();
    const f = await c.frames(900, () => reply(c.emit), REPLY_PROBE);
    const text = f.filter((x) => x.text != null);
    expect(text[0].text, "the reply faded in under reduced motion").toBeGreaterThan(0.98);
    expect(f.filter((x) => x.hasNote && x.text != null).length, "the indicator stood beside the reply").toBe(0);
    expect((await moving(c.page)).length, "something still animates in the chat turn").toBe(0);
    expect(c.errors).toEqual([]);
    await c.page.close();
});
