#!/usr/bin/env node
// probe.mjs — LOOK AT A PAGE ONCE, from the command line: open a URL or a built file at a phone's or a desktop's size,
// wait for it, evaluate an expression in it, and print the page's errors, the answer and a screenshot. It replaces the
// throwaway `zz-*-probe.spec.mjs` files a session kept writing to answer "what is on screen, and why" (skill: probe).
//
//   node scripts/probe.mjs dist-web/index.html                            # desktop Chromium, screenshot + errors
//   node scripts/probe.mjs dist-web/index.html --phone --touch --dark     # a phone: 390x844, a finger, dark scheme
//   node scripts/probe.mjs dist-native/embed-demo.html --phone \
//       --wait '.chat-row' --eval 'document.querySelectorAll(".chat-row").length'
//   node scripts/probe.mjs http://127.0.0.1:5173/#/settings --size 1280x800 --webkit --shot /tmp/s.png
//
// A path is served over HTTP from its own directory (IndexedDB and WebCrypto need an origin), with the hash or query
// kept. `--wait` takes milliseconds or a selector. `--eval` is an EXPRESSION (wrap statements in an IIFE); its value is
// printed as JSON. `--before` runs a script before the page's own (an init script: stub a global, set a flag).
// Exit 1 on a page error, so it can gate a check; `--allow-errors` turns that off.

import { chromium, webkit } from "@playwright/test";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "../tests/e2e/static-server.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const target = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !["phone", "touch", "dark", "webkit", "allow-errors", "full"].includes(argv[i - 1].slice(2))));
if (!target) {
    console.error("usage: node scripts/probe.mjs <url|file> [--phone|--size WxH] [--touch] [--dark] [--webkit] [--wait ms|selector] [--eval expr] [--before js] [--shot file] [--full] [--allow-errors]");
    process.exit(2);
}

const [w, h] = (opt("size") ?? (flag("phone") ? "390x844" : "1280x800")).split("x").map(Number);
let url = target, server = null;
if (!/^[a-z]+:\/\//i.test(target)) {
    const [file, rest = ""] = target.split(/(?=[#?])/);
    if (!existsSync(file)) { console.error(`✗ no such file: ${file}`); process.exit(2); }
    const dir = statSync(file).isDirectory() ? file : path.dirname(file);
    server = await serveStatic(dir);
    url = server.url + (statSync(file).isDirectory() ? "" : path.basename(file)) + rest;
}

const browser = await (flag("webkit") ? webkit.launch() : chromium.launch({ channel: "chromium" }));
const touch = flag("touch");
const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: flag("dark") ? "dark" : "light", ...(touch ? { hasTouch: true, isMobile: !flag("webkit") } : {}) });
if (opt("before")) await ctx.addInitScript(opt("before"));
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`console.${m.type()}: ${m.text()}`); });
let code = 0;
try {
    await page.goto(url, { waitUntil: "load" });
    const wait = opt("wait");
    if (wait && /^\d+$/.test(wait)) await page.waitForTimeout(Number(wait));
    else if (wait) await page.locator(wait).first().waitFor({ timeout: 15_000 });
    else await page.waitForTimeout(500);
    console.log(`url: ${page.url()}  (${w}x${h}${touch ? ", touch" : ""}${flag("dark") ? ", dark" : ""}${flag("webkit") ? ", webkit" : ""})`);
    if (opt("eval")) {
        const v = await page.evaluate((src) => (0, eval)(src), opt("eval"));
        console.log(`eval: ${JSON.stringify(v, null, 1)}`);
    }
    const shot = opt("shot") ?? "test-results/probe.png";
    await page.screenshot({ path: shot, fullPage: flag("full") });
    console.log(`shot: ${shot}`);
} catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    code = 1;
}
for (const e of errors) console.log(e);
if (errors.some((e) => e.startsWith("pageerror")) && !flag("allow-errors")) code = 1;
await browser.close();
server?.close();
process.exit(code);
