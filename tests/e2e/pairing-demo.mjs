#!/usr/bin/env node
// THE PAIRING SCREENS, WATCHED: what a device is allowed to do when it joins, and what the one device that cannot
// renew itself does instead. It serves dist-web/ and drives the demo world's fake account, narrating each beat; it
// asserts nothing (the specs do: chat-web.spec.mjs "a named grant is one tap" and "the signer refreshes its
// pairing", plus tests/grant-profiles.test.mjs for the rule).
//
//   node tests/e2e/pairing-demo.mjs                  # a headful window, held open at the end
//   LINGER=1500 HOLD=0 node tests/e2e/pairing-demo.mjs
//   HEADLESS=1 node tests/e2e/pairing-demo.mjs       # screenshots only, into tests/e2e/artifacts/pairing/
//
// It walks two things that are easy to get wrong and hard to see in a diff:
//
//   GRANTS. A device is offered NAMED grants ("Watch only", "Use it") rather than a wall of switches, the switches
//   stay underneath, and which name is lit is DERIVED from them — so flicking one by hand moves the selection to
//   Custom instead of leaving a stale name on screen. Only profiles this device can grant IN FULL are offered, since
//   a delegate passes on no more than it holds and the hub would refuse the rest long after the tap.
//
//   REFRESHING A PAIRING. The device that signs an account's revocations is the one device that cannot renew itself,
//   because that grant is the one a renewal may never re-issue. Its inbox item says so and the press goes straight to
//   a code, naming who can answer it. Nothing is lost by it, which the screen says, because "pair it again" is the
//   kind of phrase that makes somebody wonder.
//
//   NOBODY TO SIGN A REMOVAL. An account can reach a state where no device holds the grant at all, and a removal
//   then takes effect only on the runtime it was made on while every other one goes on trusting the device. Saying so
//   needed the hub to ANNOUNCE that it keeps the record, because until v0.4.3 "holds none" and "too old to know" were
//   the same bytes and the warning would have fired against every older hub.
//
// Build first: `node scripts/build-web.mjs` (or `npm run build:all`).
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";
import { narrate, narrateDone } from "./harness.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
if (!fs.existsSync(path.join(ROOT, "chat.js"))) { console.error(`no web build at ${ROOT}: run node scripts/build-web.mjs`); process.exit(1); }
const LINGER = Number(process.env.LINGER ?? 2600);
const HEADLESS = process.env.HEADLESS === "1";
const HOLD = process.env.HOLD !== "0" && !HEADLESS;
const OUT = path.resolve(process.env.OUT || "tests/e2e/artifacts/pairing");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serveStatic(ROOT);
const browser = await chromium.launch({ channel: "chromium", headless: HEADLESS });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: HEADLESS ? 2 : 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
if (HEADLESS) fs.mkdirSync(OUT, { recursive: true });
let shot = 0;
/** A beat: say what is about to be true, let it be seen, and keep a frame when nobody is watching. */
const beat = async (text, sub, el) => {
    await narrate(page, text, sub ? { sub } : {});
    await sleep(LINGER);
    if (!HEADLESS) return;
    const file = path.join(OUT, `${String(++shot).padStart(2, "0")}-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.png`);
    // The framed element where there is one, the whole window where it has gone: a demo that dies on a selector is
    // a demo nobody runs twice.
    // `el` may be a LOCATOR, not a selector: ".chat-att-item" first-match framed the archive-folder card under a
    // caption about the signer, which is a demo lying rather than a demo failing.
    const target = typeof el === "string" ? page.locator(el).first() : el;
    try { await (target ?? page).screenshot({ path: file, timeout: 4000 }); }
    catch { await page.screenshot({ path: file }); }
};

await page.goto(server.url);
await page.locator(".chat").waitFor();

// --- what a joining device is allowed to do ---

await beat("Pairing a device", "Settings → Devices → Pair a device: a code typed here, a fingerprint compared on both");
await page.locator(".chat-list-foot .chat-gear-btn, .chat-gear-btn").first().click();
await page.getByRole("menuitem", { name: "Settings" }).click();
await page.getByRole("tab", { name: "Devices" }).click();
await page.getByRole("button", { name: "Pair a device" }).click();
await page.getByLabel("Its code").fill("7K3M Q9XD");
await page.getByRole("button", { name: "Find it" }).click();
await page.locator(".pair-profile").first().waitFor();

await beat("Named grants, not a wall of switches", "and only the ones THIS device can grant in full: a delegate passes on no more than it holds", ".pair-card");
await beat("The default is Use it", "see sessions, and start, steer and stop them: what most devices need", ".pair-card");

await page.getByRole("radio", { name: /Watch only/ }).click();
await beat("Watch only turns the rest off", "one tap sets the switches underneath; they are the thing that is actually granted", ".pair-card");

await page.getByRole("checkbox", { name: /See its screen/ }).check();
await beat("A switch flicked by hand is Custom", "which name is lit is DERIVED from the switches, so the two can never disagree", ".pair-card");

// --- the one device that cannot renew itself ---

await page.keyboard.press("Escape");
await page.evaluate(() => {
    globalThis.__pairFake.setMembership({
        label: "Shane's phone", role: "client", hubUrl: "wss://hub.example", fingerprint: "5ab0e19c44d2",
        root: false, mayPair: true, principal: "5ab0e19c".repeat(8),
        mayRevoke: true, renewable: true, notAfterMs: Date.now() + 5 * 86_400_000,
    });
});
await page.locator(".chat-att-btn, .chat-gear-btn").first().click();
const card = page.locator(".chat-att-item", { hasText: "access runs out" }).first();
await card.waitFor();
await beat("The signer cannot renew itself", "signing revocations is the one grant a renewal may never re-issue, so this device refreshes its pairing", card);

await card.getByRole("button", { name: "Refresh pairing" }).click();
await page.locator("section[aria-label='Refresh pairing']").waitFor();
await beat("One press, and it says what it costs", "nothing: the same keys, the same name, and every session stay as they are", "section[aria-label='Refresh pairing']");

await page.getByRole("button", { name: "Show the code" }).click();
await page.locator("svg.pair-qr").waitFor();
await beat("The code names who can answer it", "a device that may pair, which is not this one; scanned or typed, because a laptop-only account has no camera to point", "section[aria-label='Refresh pairing']");

// --- the account with nobody to sign a removal ---

await page.keyboard.press("Escape");
await page.evaluate(() => {
    // A healthy certificate and NOT the signer, so the only card left is the account's: this device holding
    // `may_revoke` would contradict the very thing the next beat says.
    globalThis.__pairFake.setMembership({
        label: "Shane's phone", role: "client", hubUrl: "wss://hub.example", fingerprint: "5ab0e19c44d2",
        root: true, mayPair: true, principal: "5ab0e19c".repeat(8),
        renewable: true, notAfterMs: Date.now() + 80 * 86_400_000,
    });
    globalThis.__pairFake.setRevoker("none");
});
await page.locator(".chat-att-btn, .chat-gear-btn").first().click();
const gone = page.locator(".chat-att-item", { hasText: "remove another" }).first();
await gone.waitFor();
await beat("Nobody here can sign a removal", "the one thing a hub had to start ANNOUNCING before this could be said: absent and 'too old to know' were the same bytes", gone);
await beat("It says what actually fails, not that it is broken", "the removal works where you make it and reaches nothing else, so the obvious check looks like it worked", gone);

if (errors.length) console.error(`the page threw:\n  ${errors.join("\n  ")}`);
if (HEADLESS) console.log(`wrote ${shot} frames to ${OUT}`);
if (HOLD) {
    await narrateDone(page, "Demo finished — the browser is yours");
    await new Promise(() => {});
}
await browser.close();
server.close?.();
process.exit(errors.length ? 1 : 0);
