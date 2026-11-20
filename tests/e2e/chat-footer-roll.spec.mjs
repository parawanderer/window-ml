// chat-footer-roll.spec.mjs — the composer footer's usage percentage rolling its changed digits, sampled on every animation frame in the
// extension's own chat page over the REAL runtime with a scripted model.
//
// The roll (`Ticking`, ui-kit.tsx, the `chat-tick-in` keyframes of sidebar.css) is 0.22 s long, so a final state cannot see a digit that
// rolled twice, an unchanged digit that rolled with its neighbour, or a bar that slid for a frame when 9% became 10%. Each row reads the
// footer per frame. The percentage needs a KNOWN context window, which only the extension's chat page has (it reads `/api/ps` from the
// fake box); the web build's fake host reports none and draws the bare token figure instead, so it cannot be tested there.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const WINDOW = 1000;
// The fake's usage is a 4-characters-per-token estimate over the request and reply, so the reply's length sets the figure:
// three turns that read 9%, 10% (a digit gained) and 14% (only the ones digit changes).
const REPLIES = [
    { content: "a".repeat(352), want: "9%" },
    { content: "b".repeat(32), want: "10%" },
    { content: "c".repeat(144), want: "14%" },
];
const MESSAGES = ["hi", "and then", "once more"];

// --- the frame sampler and its readings ---

/** Runs in the page: on every animation frame, the footer's pieces' rects, the percentage's text and the roll animations running. */
const SAMPLER = () => {
    const ids = new WeakMap();
    let next = 0;
    const out = (globalThis.__frames = []);
    const t0 = performance.now();
    const rect = (q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    const tick = () => {
        const anims = document.getAnimations().filter((a) => a.animationName === "chat-tick-in").map((a) => {
            if (!ids.has(a)) ids.set(a, next++);
            const el = a.effect?.target;
            return { id: ids.get(a), text: el?.textContent ?? "", inPct: !!el?.closest(".usage-pct") };
        });
        out.push({
            t: performance.now() - t0,
            pct: document.querySelector(".composer-foot .usage-pct")?.textContent ?? null,
            rolled: [...document.querySelectorAll(".composer-foot .usage-pct .tick-d.rolled")].map((e) => e.textContent),
            anims,
            fill: (() => { const f = document.querySelector(".composer-foot .usage-fill"); return f ? getComputedStyle(f).transitionDuration : null; })(),
            rects: Object.fromEntries(Object.entries({ track: ".usage-track", ic: ".usage-ic", gauge: ".composer-foot .usage-gauge", spend: ".composer-foot .usage-spend", foot: ".composer-foot" }).map(([k, q]) => [k, rect(q)])),
        });
        if (globalThis.__frames === out) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
};

/** The largest move of any footer piece's rect (left, top, width, height) from the frame before the update. */
function maxDrift(frames) {
    const base = frames[0].rects;
    let worst = { drift: 0, what: "" };
    for (const f of frames) for (const [k, b] of Object.entries(base)) {
        if (!b) continue;
        const r = f.rects[k];
        if (!r) { worst = { drift: Infinity, what: `${k} vanished at ${Math.round(f.t)}ms` }; continue; }
        for (let i = 0; i < 4; i++) { const d = Math.abs(r[i] - b[i]); if (d > worst.drift) worst = { drift: d, what: `${k}[${["left", "top", "width", "height"][i]}] at ${Math.round(f.t)}ms (${f.pct})` }; }
    }
    return worst;
}

/** One chat of three turns in the extension's chat page, the window of its model known, with the frames of each turn's update.
 *  `settle` is how long each update is watched after its figure lands: longer than the 0.22 s roll, with room for a re-roll to show. */
async function threeUpdates({ reducedMotion = "no-preference", settle = 900 } = {}) {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 0 });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript(REPLIES.map((r) => ({ content: r.content })));
        fake.setResident([{ model: "fake-model", name: "fake-model", size: 1e9, size_vram: 1e9, context_length: WINDOW, expires_at: null }]);
        const chat = await ext.context.newPage();
        const errors = [];
        chat.on("pageerror", (e) => errors.push(e.message));
        await chat.emulateMedia({ reducedMotion });
        await chat.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await chat.locator(".chat").waitFor();
        await chat.getByRole("button", { name: /^Kind:/ }).click();
        await chat.getByRole("listbox", { name: "Kind" }).getByRole("option", { name: /^Chat/ }).click();
        await chat.locator(".chat-start-box textarea").fill(MESSAGES[0]);
        await chat.locator(".chat-start-box textarea").press("Enter");
        const pct = chat.locator(".composer-foot .usage-pct");
        // The chat page asks the box about its models only while the Models and memory panel is mounted; the window it learns is kept
        // (`seenContext`), so the panel is opened for the first reading and closed again, and the footer is what is sampled.
        const panel = async () => { await chat.locator(".chat-gear-btn").first().click(); await chat.getByRole("menuitem", { name: "Panels" }).click(); await chat.getByRole("menuitemcheckbox", { name: /Models and memory/ }).click(); };
        await panel();
        await expect(pct).toHaveText(REPLIES[0].want, { timeout: 30_000 });
        await panel();
        await expect(chat.locator(".chat-dock .vram")).toHaveCount(0);
        await chat.waitForTimeout(settle);

        await chat.evaluate(SAMPLER);
        const updates = [];
        for (let i = 1; i < REPLIES.length; i++) {
            await chat.waitForTimeout(150);   // a frame for Ticking's mount effect, and a baseline before the update
            const from = await chat.evaluate(() => globalThis.__frames.length);
            await chat.evaluate(() => { const d = document.querySelector(".composer-foot .usage-pct .tick-d"); if (d) d.dataset.mark = "kept"; });
            await chat.locator(".composer .cinput").fill(MESSAGES[i]);
            await chat.locator(".composer .cinput").press("Enter");
            await expect(pct).toHaveText(REPLIES[i].want, { timeout: 30_000 });
            await chat.waitForTimeout(settle);
            const frames = await chat.evaluate((from) => globalThis.__frames.slice(from), from);
            // A baseline from BEFORE the change, or a row would compare post-change frames with a post-change baseline and pass unmeasured.
            expect(frames.length, `${REPLIES[i].want}: frames were sampled`).toBeGreaterThan(20);
            expect(frames[0].pct, `${REPLIES[i].want}: the first frame is from before the update`).toBe(REPLIES[i - 1].want);
            const marked = await chat.evaluate(() => [...document.querySelectorAll(".composer-foot .usage-pct .tick-d")].map((e) => e.dataset.mark === "kept"));
            updates.push({ want: REPLIES[i].want, frames, marked });
        }
        await chat.evaluate(() => { globalThis.__frames = null; });
        return { updates, errors };
    } finally { await ext.context.close(); await fake.stop(); }
}

/** The roll animations of one update: how many distinct ones started, on what text, and whether any started after another had finished. */
function rolls(frames) {
    const seen = new Map();
    for (const f of frames) for (const a of f.anims) {
        const r = seen.get(a.id) ?? { id: a.id, text: a.text, inPct: a.inPct, first: f.t, last: f.t, frames: 0 };
        r.last = f.t; r.frames++; seen.set(a.id, r);
    }
    return [...seen.values()];
}

// --- 1. one roll per update ---

test("1. a usage update rolls each changed digit once and no unchanged digit: the roll starts, ends, and does not start again", async () => {
    test.setTimeout(120_000);
    const { updates, errors } = await threeUpdates();
    const [gain, one] = updates;
    for (const u of updates) {
        const r = rolls(u.frames);
        const dump = `${u.want}: ${JSON.stringify(r)}`;
        console.log(`footer roll at ${u.want}: ${r.length} roll(s) ${JSON.stringify(r.map((x) => `${x.text} ${Math.round(x.last - x.first)}ms`))}, ${u.frames.length} frames`);
        expect(r.every((x) => x.inPct), `a roll outside the percentage\n${dump}`).toBe(true);
        // Every roll ended before the watch did, and it ran for about its 0.22 s: a stuck one or a restarted one is not that.
        const end = u.frames.at(-1).t;
        for (const x of r) {
            expect(x.last, `a roll was still running at the end\n${dump}`).toBeLessThan(end - 100);
            expect(x.last - x.first, `a roll that ran ${Math.round(x.last - x.first)} ms\n${dump}`).toBeLessThan(400);
        }
        // Nothing starts once the first roll has ended: one burst per update.
        const firstEnd = Math.min(...r.map((x) => x.last));
        expect(r.filter((x) => x.first > firstEnd + 20).length, `a roll started after the burst had ended\n${dump}`).toBe(0);
        // The settled digits carry the rolled class once each, and no running animation is left.
        expect(u.frames.at(-1).anims, dump).toEqual([]);
    }
    // 9% -> 10%: both digits are new, one roll each.
    expect(rolls(gain.frames).map((x) => x.text).sort(), "9% to 10% rolls its two digits once each").toEqual(["0", "1"]);
    // 10% -> 14%: only the ones digit changed; the tens digit stays the same element and does not roll.
    expect(rolls(one.frames).map((x) => x.text), "10% to 14% rolls the 4 alone").toEqual(["4"]);
    expect(one.marked, "the unchanged tens digit is the same element, the changed one is new").toEqual([true, false]);
    expect(errors).toEqual([]);
});

// --- 2. neighbours stay put ---

test("2. the bar and the footer beside the gauge do not move by more than half a pixel on any frame, including when 9% gains a digit", async () => {
    test.setTimeout(120_000);
    const { updates, errors } = await threeUpdates();
    for (const u of updates) {
        const w = maxDrift(u.frames);
        console.log(`footer drift across ${u.want}: ${w.drift.toFixed(3)} px over ${u.frames.length} frames (${w.what})`);
        expect(w.drift, `a footer piece moved: ${w.what}`).toBeLessThanOrEqual(0.5);
    }
    expect(errors).toEqual([]);
});

// --- 3. reduced motion ---

test("3. under reduced motion nothing rolls and the fill does not ease", async () => {
    test.setTimeout(120_000);
    const { updates, errors } = await threeUpdates({ reducedMotion: "reduce" });
    for (const u of updates) {
        expect(rolls(u.frames), `${u.want}: a roll ran under reduced motion`).toEqual([]);
        expect([...new Set(u.frames.map((f) => f.fill))], `${u.want}: the fill eases`).toEqual(["0s"]);
        // The figure still changed and the changed digits are still marked: only the motion went.
        expect(u.frames.at(-1).pct).toBe(u.want);
        expect(u.frames.at(-1).rolled.length, "the changed digits are still marked").toBeGreaterThan(0);
    }
    expect(errors).toEqual([]);
});
