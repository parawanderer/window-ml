// chat-stop.spec.mjs — the chat page's Stop pressed in EACH state a run streams through: thinking, writing the reply,
// writing a tool call, stalled mid-call, a tool's output streaming into an open step, and an approval gate. The web
// build against the fake host (the phone app is a WebView of the same build), the real Stop button. Each state must end
// the same way: the runtime is sent `session.cancel`, nothing on screen is still live (no live call or answer, no
// pending step, no caret, no stall clock), and with time passing nothing changes. The extension's half of the same
// matrix, where the runtime itself has to stop, is tests/e2e/cancel-states.spec.mjs.
import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
// The demo world's agent waiting at an approval gate (src/chat/demo-world.ts). The other states are a fresh RUNNING
// agent session on the same runtime, this page's own (the demo's lab-box sessions are watch-only: no Stop to press).
const WAITING = "laptop:3f9a0c21", LIVE_KEY = "laptop:5709aaaa";

let server, browser;
test.beforeAll(async () => {
    test.skip(!fs.existsSync(path.join(ROOT, "chat.js")), `no web build at ${ROOT} (npm run build)`);
    server = await serveStatic(ROOT);
    browser = await chromium.launch({ channel: "chromium" });
});
test.afterAll(async () => { await browser?.close(); server?.close(); });

/** Everything that says a run is still going: each should be gone once Stop has landed. */
const LIVE = [".live-call", ".live-answer", ".live-call-quiet", ".live-call-stall", ".astep.pending", ".astep.awaiting", ".writing", ".streaming", ".pending-note", ".w-in", ".cbtn.cstop"];
const liveLeft = (page) => page.evaluate((sels) => Object.fromEntries(sels.map((s) => [s, document.querySelectorAll(s).length]).filter(([, n]) => n)), LIVE);

/** Session `key` opened at `viewport` under a fake clock, failing on any page error. Any key but the demo's own is
 *  first added as a running agent run, its start event and nothing else, as a runtime shows a run that has just begun. */
async function openSession(key, viewport = DESKTOP) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install();
    await page.goto(server.url);
    await page.locator(".chat").waitFor();
    if (key !== WAITING) await page.evaluate((k) => {
        const [runtime, hash] = k.split(":"), now = Date.now();
        globalThis.__chatFake.addSession(
            { id: { runtime, hash }, kind: "agent", status: "running", pendingApprovals: 0, saved: true, createdTs: now, lastTs: now, title: "Count the rows", model: "qwen3:32b", page: { url: "https://flights.example/", title: "Flights", tabId: 41 } },
            [{ id: hash, ts: now, save: true, session: { hash, turn: 0 }, kind: "agent", task: "Count the rows", model: "qwen3:32b", maxSteps: 12 }]);
    }, key);
    await page.evaluate((k) => { location.hash = `#s=${encodeURIComponent(k)}`; }, key);
    await page.locator(".chat-transcript").waitFor();
    return { page, errors };
}

/** Emit one event of the session's current turn, as its runtime would. */
const emit = (page, key, ev) => page.evaluate(([k, e]) => {
    const hash = k.split(":").pop();
    globalThis.__chatFake.emit(k, { id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, ...e });
}, [key, ev]);

/** Press Stop, then: the runtime was asked to cancel, nothing is live, and ten seconds later nothing has changed. */
async function stopAndSettle(page, key, errors, label) {
    const stop = page.locator(".cbtn.cstop");
    await expect(stop, `${label}: Stop is offered while the run is live`).toBeVisible();
    await stop.click();
    await expect.poll(async () => (await page.evaluate(() => globalThis.__chatFake.commands)).some((c) => c.kind === "session.cancel" || c.command?.kind === "session.cancel" || JSON.stringify(c).includes("session.cancel")),
        { message: `${label}: the runtime was sent session.cancel` }).toBe(true);
    await expect.poll(() => liveLeft(page), { message: `${label}: nothing is still live` }).toEqual({});
    const before = await page.locator(".chat-transcript").textContent();
    await page.clock.fastForward(10_000);
    expect(await liveLeft(page), `${label}: and nothing came back to life`).toEqual({});
    expect(await page.locator(".chat-transcript").textContent(), `${label}: the transcript stopped changing (no clock, no caret, no output)`).toBe(before);
    expect(errors, `${label}: no page errors`).toEqual([]);
}

// --- Stop while the model is streaming ---

test("Stop while the model is thinking: the thinking line goes, and nothing is left live", async () => {
    const { page, errors } = await openSession(LIVE_KEY);
    await emit(page, LIVE_KEY, { kind: "agent-stream", step: 9, localStep: 9, reasoning: "Weighing the title against the heading", tokens: 12 });
    await expect.poll(() => liveLeft(page).then((l) => Object.keys(l).length), { message: "the thinking shows as live" }).toBeGreaterThan(1);
    await stopAndSettle(page, LIVE_KEY, errors, "thinking");
    await page.close();
});

test("Stop while the reply is being written: what arrived stays, settled, with no caret", async () => {
    const { page, errors } = await openSession(LIVE_KEY);
    await emit(page, LIVE_KEY, { kind: "agent-stream", step: 9, localStep: 9, content: "The title says Dice lab and" });
    await expect(page.locator(".chat-transcript")).toContainText("Dice lab");
    await stopAndSettle(page, LIVE_KEY, errors, "reply");
    await page.close();
});

const ARGS = JSON.stringify({ js: "const rows = document.querySelectorAll('tr');\nrows.length" });

test("Stop while a tool call is being written: the live call goes, and no step is drawn for it", async () => {
    const { page, errors } = await openSession(LIVE_KEY);
    const steps = await page.locator(".astep.tool").count();
    await emit(page, LIVE_KEY, { kind: "agent-stream", step: 9, localStep: 9, calls: [{ index: 0, name: "exec", args: ARGS.slice(0, 30), chars: 30 }] });
    await expect(page.locator(".live-call")).toHaveCount(1);
    await stopAndSettle(page, LIVE_KEY, errors, "writing a call");
    expect(await page.locator(".astep.tool").count(), "no step: the call never ran").toBe(steps);
    await page.close();
});

test("Stop while a tool call has stalled mid-write: the stall notice and its clock go with it", async () => {
    const { page, errors } = await openSession(LIVE_KEY);
    await emit(page, LIVE_KEY, { kind: "agent-stream", step: 9, localStep: 9, calls: [{ index: 0, name: "exec", args: ARGS.slice(0, 30), chars: 30 }] });
    await page.clock.fastForward(6000);
    await expect(page.locator(".live-call-quiet, .live-call-stall").first(), "it says it has gone quiet").toBeAttached();
    await stopAndSettle(page, LIVE_KEY, errors, "stalled call");
    await page.close();
});

// --- Stop while a tool runs ---

test("Stop while a tool's output streams into its step: the step is not left running and the output stops", async () => {
    const { page, errors } = await openSession(LIVE_KEY);
    await emit(page, LIVE_KEY, { kind: "agent-step", step: 9, seq: 90, pending: true, tool: "exec", arguments: { js: "for (const c of checks) console.log(c)" } });
    await emit(page, LIVE_KEY, { kind: "agent-step", step: 9, seq: 90, streamOutput: "checked part 1\nchecked part 2\n" });
    await expect(page.locator(".astep.pending")).toHaveCount(1);
    await stopAndSettle(page, LIVE_KEY, errors, "tool output");
    await page.close();
});

test("Stop at an approval gate: the gate's buttons go and nothing is left waiting", async () => {
    const { page, errors } = await openSession(WAITING);
    await expect(page.locator(".appr-btn.yes, .chat-approve, [data-approve]").first(), "the gate is open").toBeVisible();
    await stopAndSettle(page, WAITING, errors, "approval");
    expect(await page.locator(".appr-btn.yes, .chat-approve, [data-approve]").count(), "no Approve left to press").toBe(0);
    await page.close();
});

test("on a phone's width too: Stop while a call is being written leaves nothing live", async () => {
    const { page, errors } = await openSession(LIVE_KEY, PHONE);
    await emit(page, LIVE_KEY, { kind: "agent-stream", step: 9, localStep: 9, calls: [{ index: 0, name: "exec", args: ARGS.slice(0, 30), chars: 30 }] });
    await expect(page.locator(".live-call")).toHaveCount(1);
    await stopAndSettle(page, LIVE_KEY, errors, "phone");
    await page.close();
});
