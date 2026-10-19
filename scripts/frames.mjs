#!/usr/bin/env node
// frames.mjs — RECORD WHAT THE CHAT PAGE DRAWS, frame by frame, during a scripted interaction, for an agent that cannot watch video (skill: frames).
//
//   node scripts/frames.mjs --scenario reload --turns 12 --width phone
//   node scripts/frames.mjs --scenario send   --turns 6  --ms 2500 --watch '.msg:last-child'
//   node scripts/frames.mjs --scenario stream --turns 3  --dist ../other-clone/dist --out /tmp/frames-a
//
// It launches the built extension with a fake backend, starts a chat through the start box, plays N turns, then records one
// thing: `reload` reloads the page, `send` sends one more message through its reply, `stream` records one reply paced by the
// fake's `streamDelayMs`. Output in `--out` (default test-results/frames/<scenario>-<width>/): `frames.json` (one row per
// requestAnimationFrame: t, the scroller's scrollTop/scrollHeight, the `.msg` count, running animations, and each `--watch`
// selector's rect/opacity/transform), `shots/*.png` (a CDP screencast, named by t) and `contact.png` (up to 16 evenly spaced
// frames in a grid, each labelled with its t). The change summary goes to stdout. Not a spec: the e2e suite never runs it.

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension } from "../tests/e2e/harness.mjs";
import { startFakeLlm } from "../tests/e2e/fake-llm.mjs";
import { pickEvenly, gridFor, summarize } from "./frames-lib.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const all = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const scenario = opt("scenario", "reload");
if (!["reload", "send", "stream"].includes(scenario) || argv.includes("--help")) {
    console.error("usage: node scripts/frames.mjs --scenario reload|send|stream [--turns N] [--width phone|desktop] [--ms N] [--dist dir] [--out dir] [--watch '<css>']...");
    process.exit(2);
}
const turns = Number(opt("turns", 4));
const width = opt("width", "phone");
const ms = Number(opt("ms", scenario === "stream" ? 4000 : 2500));
const watch = all("watch");
const out = path.resolve(opt("out", `test-results/frames/${scenario}-${width}`));
const [vw, vh] = width === "desktop" ? [1280, 800] : [390, 844];
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "shots"), { recursive: true });

const ANSWER = (i) => `Answer ${i + 1}: a service worker is a background script that runs apart from any page and wakes for the events it has registered, then sleeps again. It has no DOM, so it talks to pages by messages.`;
const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: scenario === "stream" ? 70 : 0 });
const ext = await launchExtension({ dist: opt("dist") });
let code = 0;
try {
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
    fake.setScript(Array.from({ length: turns + 2 }, (_, i) => ({ content: ANSWER(i) })));
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: vw, height: vh });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // The recorder lives in the page and survives a reload because it is an init script; `__frames` starts empty in each new document.
    await page.addInitScript((sels) => {
        const frames = (window.__frames = []);
        const info = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return { rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10), opacity: cs.opacity, transform: cs.transform }; };
        const tick = () => {
            const sc = document.querySelector(".chat-transcript");
            const row = {
                epoch: performance.timeOrigin + performance.now(),
                scrollTop: sc ? Math.round(sc.scrollTop * 10) / 10 : -1,
                scrollHeight: sc ? sc.scrollHeight : -1,
                msgs: document.querySelectorAll(".msg").length,
                anims: document.getAnimations().map((a) => ({ name: a.animationName || a.transitionProperty || a.id || "?", target: String(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? a.effect?.target?.tagName ?? "") })),
            };
            if (sels.length) row.watch = Object.fromEntries(sels.map((s) => [s, [...document.querySelectorAll(s)].slice(0, 6).map(info)]));
            frames.push(row);
            if (frames.length < 4000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }, watch);
    await page.goto(`chrome-extension://${ext.extensionId}/chat.html`);
    await page.locator(".chat").waitFor();

    const settled = async (k) => {
        const t0 = Date.now();
        while (fake.calls().length < k) { if (Date.now() - t0 > 30000) throw new Error(`the fake saw ${fake.calls().length} calls, wanted ${k}`); await page.waitForTimeout(50); }
        await page.locator(".chat-main .msg.asst").nth(k - 1).waitFor({ timeout: 30000 });
        await page.locator(".chat-main .msg.asst.streaming").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(400);
    };
    // Turn 1 goes through the start box, later ones through the composer.
    if (turns >= 1) {
        // On a phone the session list comes first and the start page is behind its "New session" button.
        if (!(await page.getByRole("button", { name: /^Kind:/ }).isVisible())) await page.getByRole("button", { name: "New session" }).first().click();
        await page.getByRole("button", { name: /^Kind:/ }).click();
        await page.getByRole("listbox", { name: "Kind" }).getByRole("option", { name: /^Chat/ }).click();
        await page.locator(".chat-start-box textarea").fill("Turn 1: what is a service worker?");
        await page.locator(".chat-start-box textarea").press("Enter");
        await page.waitForURL(/#\/s\/local%3A/);
        await settled(1);
    }
    for (let k = 2; k <= turns; k++) {
        await page.locator(".composer .cinput").fill(`Turn ${k}: tell me more.`);
        await page.locator(".composer .cinput").press("Enter");
        await settled(k);
    }

    // Record.
    if (scenario !== "reload") await page.locator(".composer .cinput").fill(`Turn ${turns + 1}: one more question.`);
    const cdp = await ext.context.newCDPSession(page);
    const shots = [];
    cdp.on("Page.screencastFrame", async (f) => {
        shots.push({ epoch: f.metadata.timestamp * 1000, data: f.data });
        await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await page.evaluate(() => { window.__frames.length = 0; });
    const t0 = Date.now();
    if (scenario === "reload") await page.reload();
    else await page.locator(".composer .cinput").press("Enter");
    await page.waitForTimeout(ms);
    await cdp.send("Page.stopScreencast").catch(() => {});
    const raw = await page.evaluate(() => window.__frames);
    // A reload starts a new document whose first frames are its own: `t` is measured from just before the trigger either way.
    const rows = raw.map((r) => { const { epoch, ...rest } = r; return { t: Math.round((epoch - t0) * 10) / 10, ...rest }; }).filter((r) => r.t >= -50);
    writeFileSync(path.join(out, "frames.json"), JSON.stringify(rows, null, 1));
    const named = shots.map((s) => ({ t: Math.round(s.epoch - t0), data: s.data })).filter((s) => s.t >= -50).sort((a, b) => a.t - b.t);
    for (const s of named) writeFileSync(path.join(out, "shots", `${String(Math.max(0, s.t)).padStart(6, "0")}.png`), Buffer.from(s.data, "base64"));

    // Contact sheet: a plain page of labelled images, screenshotted.
    if (named.length) {
        const picks = pickEvenly(named.length, 16).map((i) => named[i]);
        const cw = Math.round(width === "desktop" ? 320 : 150), ch = Math.round(cw * (vh / vw));
        const { cols, rows: grows } = gridFor(picks.length, vw, vh);
        const cells = picks.map((s) => `<figure><img src="data:image/png;base64,${s.data}"><figcaption>t=${s.t}ms</figcaption></figure>`).join("");
        const sheet = await chromium.launch({ channel: "chromium" });
        const sp = await sheet.newPage({ viewport: { width: cols * (cw + 8) + 8, height: grows * (ch + 30) + 8 } });
        await sp.setContent(`<style>body{margin:0;padding:8px;background:#222;display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:8px;font:12px monospace;color:#fff}figure{margin:0}img{width:${cw}px;height:${ch}px;object-fit:contain;display:block;background:#fff;outline:1px solid #666}figcaption{height:22px;line-height:22px}</style>${cells}`);
        await sp.waitForTimeout(200);
        await sp.screenshot({ path: path.join(out, "contact.png") });
        await sheet.close();
    }

    console.log(`scenario=${scenario} turns=${turns} width=${width} (${vw}x${vh}) ms=${ms}${opt("dist") ? ` dist=${opt("dist")}` : ""}`);
    console.log(`${rows.length} animation frames, ${named.length} screencast frames`);
    for (const l of summarize(rows)) console.log(l);
    console.log(`frames: ${path.join(out, "frames.json")}\ncontact sheet: ${path.join(out, "contact.png")}\nshots: ${path.join(out, "shots")}`);
    if (errors.length) { console.log("pageerrors:", errors); code = 1; }
} catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    code = 1;
} finally {
    await ext.context.close();
    await fake.stop();
}
process.exit(code);
