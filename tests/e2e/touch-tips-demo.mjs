#!/usr/bin/env node
// touch-tips-demo.mjs — a NARRATED VISUAL demo (not a test) of READING A TOOLTIP WITHOUT A POINTER, which is the
// half of the panel's tip primitive a phone never had.
//
//   npm run build && node tests/e2e/touch-tips-demo.mjs      # HOLD=0 exits instead of leaving the browser open
//
// A touch raises `pointerover` and then, a moment later, the synthetic `pointerout` that ends it. So every
// anchored tip on a phone appeared and vanished inside one tap, and the prose in it was simply unreachable — a
// failure that is invisible in a screenshot and invisible on a desktop, which is why it survived this long.
//
// One PHONE window (`hasTouch`), left open at the end. The beats:
//
//   1. A dot's tip is unreachable: a tap used to show it and the same tap's leave took it away again.
//   2. A TAP now holds it open — the status, then under a rule when it ran and how long the TOOL took.
//   3. …and the tap is NOT stolen: the step it was on opens too, which is what pressing a row means.
//   4. The next tap anywhere puts it away — the gesture people already use.
//   5. A trigger that IS a control (an icon button) raises nothing. Its tip is that control's NAME, which
//      `aria-label` already carries, and a popup on every button a finger lands on is a flicker, not help.
//
// NO DESKTOP BEAT, and the reason is a trap worth knowing before writing one: a synthetic hover CANNOT BE HELD IN
// A HEADFUL WINDOW. `page.mouse.move` is a CDP event, while the real cursor is wherever the hand left it — so
// Chromium corrects the pointer position straight back out and raises a genuine `pointerout` within a frame or
// two. It holds fine headless, which is why the spec can assert it and a watched demo cannot. (Measured: headless
// the tip survives a second; headful it is gone in under 900ms with three `pointerout`s, the last with a null
// `relatedTarget`.) Hover the dot yourself in the window this leaves open.
//
// Screenshots land in tests/e2e/artifacts/touch-tips-demo/.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "./static-server.mjs";
import { narrate, narrateDone } from "./harness.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
if (!fs.existsSync(path.join(ROOT, "chat.js"))) { console.error(`no web build at ${ROOT}: run node scripts/build-web.mjs`); process.exit(1); }
const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "touch-tips-demo");
fs.mkdirSync(ART, { recursive: true });
const HOLD = process.env.HOLD !== "0";
const BEAT = Number(process.env.BEAT || 2200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WAITING = "laptop:3f9a0c21";
const server = await serveStatic(ROOT);
const browser = await chromium.launch({ channel: "chromium", headless: false });
const errors = [];
const shot = (page, name) => page.screenshot({ path: path.join(ART, `${name}.png`) });
/** What the beat actually produced, printed. A demo never ASSERTS (the spec does — chat-web.spec.mjs), but a
 *  headless run of one should still say what it saw, or checking it means opening six screenshots. */
const observe = async (page, label) => {
    const tip = page.locator(".tt-layer");
    const up = await tip.count() ? await tip.isVisible() : false;
    const text = up ? (await tip.innerText()).replace(/\s+/g, " ").trim().slice(0, 60) : "";
    const open = await page.locator(".astep.tool.open").count();
    console.log(`  ${label}: tip ${up ? `UP — "${text}"` : "down"}, ${open} step(s) open`);
};

// ── A finger ───────────────────────────────────────────────────────────────────────────────────────────
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark" });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`phone: ${e.message}`));
await page.goto(server.url + `#/s/${encodeURIComponent(WAITING)}`);
await page.locator(".astep.tool").first().waitFor();

await narrate(page, "1 · On a phone there is no hover", { sub: "a touch raises pointerover and then the synthetic pointerout that ends it — so every tip here used to flash and go" });
await sleep(BEAT); await shot(page, "1-phone-before");
await observe(page, "1 before");

await narrate(page, "2 · A tap holds it open", { sub: "and it is the same tip: the status, then when it ran and how long it took" });
const step = page.locator(".astep.tool").first();
await step.locator(".astep-head .dot").first().tap();
await sleep(BEAT + 600); await shot(page, "2-tap-holds-it");
await observe(page, "2 after the tap");

await narrate(page, "3 · …and the tap was not stolen", { sub: "the step it was on opened too, which is what pressing a row means. Trading that for a tooltip would be the wrong fix" });
await sleep(BEAT + 400); await shot(page, "3-step-opened-too");
await observe(page, "3 the step");

await narrate(page, "4 · The next tap anywhere puts it away", { sub: "the gesture people already use. A scroll releases it too, or a tip outlives the thing it was about" });
await page.locator(".chat-transcript").tap({ position: { x: 8, y: 8 } });
await sleep(BEAT + 400); await shot(page, "4-dismissed");
await observe(page, "4 after a tap elsewhere");

await narrate(page, "5 · A control raises nothing", { sub: "an icon button's tip is that button's NAME, which aria-label already carries — a popup on every button a finger lands on is a flicker, not help" });
const btn = page.locator(".chat-rail .hbtn, .chat-list .hbtn, .head .hbtn").first();
if (await btn.count()) { await btn.tap(); await sleep(400); }
await sleep(BEAT + 400); await shot(page, "5-a-control-is-silent");
await observe(page, "5 after tapping a control");

await narrate(page, "That is the rule", { sub: "naming a control is aria-label · explaining anything is the tip · and a finger can now read the second kind" });
await sleep(BEAT);
await narrateDone(page);
console.log(`screenshots in ${ART}`);
if (errors.length) console.error("page errors:\n" + errors.join("\n"));
if (HOLD) await new Promise(() => {});
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
