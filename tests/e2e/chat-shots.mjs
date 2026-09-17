#!/usr/bin/env node
// SCREENSHOTS OF THE CHAT PAGE, at a phone's width and a desktop's, against the fake host's demo world. For looking at
// a layout change without a phone: it serves dist-web/, opens each session the demo world has, and writes a PNG per
// view. It asserts nothing (the spec, chat-web.spec.mjs, does); it fails only when the page throws.
//
//   node tests/e2e/chat-shots.mjs                 # into tests/e2e/artifacts/chat/
//   OUT=/some/dir THEME=light node tests/e2e/chat-shots.mjs
//   SERVE=1 node tests/e2e/chat-shots.mjs         # just serve dist-web/ and print the URL, until Ctrl+C
//
// Build first: `npm run build` (or `node scripts/build-web.mjs` for the web bundle alone).
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
if (!fs.existsSync(path.join(ROOT, "chat.js"))) { console.error(`no web build at ${ROOT}: run node scripts/build-web.mjs`); process.exit(1); }
const server = await serveStatic(ROOT);
if (process.env.SERVE) { console.log(`serving ${ROOT} at ${server.url}`); await new Promise(() => {}); }

const OUT = path.resolve(process.env.OUT || "tests/e2e/artifacts/chat");
fs.mkdirSync(OUT, { recursive: true });
const PHONE = { width: 390, height: 844 }, DESKTOP = { width: 1280, height: 800 };
const SESSIONS = { waiting: "laptop:3f9a0c21", chat: "laptop:7b21d4e8", capped: "laptop:c0ffee12", watched: "lab-box:1d2e3f40", offline: "old-mac:aa55aa55" };
const views = [
    ["phone-list", PHONE, null],
    ["desktop-list", DESKTOP, null],
    ...Object.entries(SESSIONS).flatMap(([name, key]) => [[`phone-${name}`, PHONE, key], [`desktop-${name}`, DESKTOP, key]]),
];

const browser = await chromium.launch({ channel: "chromium" });
const errors = [];
for (const [name, viewport, key] of views) {
    const page = await browser.newPage({ viewport, colorScheme: process.env.THEME === "light" ? "light" : "dark" });
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(server.url + (key ? `#s=${encodeURIComponent(key)}` : ""));
    await page.locator(key ? ".chat-transcript" : ".chat-list").waitFor();
    await page.waitForTimeout(300);   // the fake host delivers in microtasks; KaTeX and fonts settle after
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    await page.close();
}
await browser.close();
await server.close();
console.log(`${views.length} screenshots in ${OUT}`);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
