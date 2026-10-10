// The machine-wide memory limit a person changes while sweeps run (tests/e2e/bench/memory-budget.mjs): kept beside the
// ledger, which limit wins (a sweep's flag, the machine-wide one, half the RAM), a running budget taking a change up on
// its next measurement and saying so, a hand-set limit keeping no reserve; and its three ways in: `hold.mjs --limit`,
// the page server's POST /memory-limit (JSON only), and the Memory card's control (live pages only, and not over a
// sweep's own flag).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const GB = 1024 ** 3, MB = 1024 ** 2;
const DIR = mkdtempSync(path.join(os.tmpdir(), "bench-limit-"));
// Before anything reads it: the ledger, and the limit beside it, live in this test's own directory.
process.env.BENCH_LEDGER_FILE = path.join(DIR, "ledger.json");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let mb, h, render, MemoryCard, dash;

before(async () => {
    mb = await import("../tests/e2e/bench/memory-budget.mjs");
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, localStorage: dom.window.localStorage });
    globalThis.chrome = { runtime: { sendMessage: () => {}, lastError: null }, storage: { local: { get: () => {}, set: () => {} }, sync: { get: () => {}, set: () => {} } } };
    ({ h, render } = createRequire(import.meta.url)("preact"));
    ({ MemoryCard } = await import("../tests/e2e/bench/page/memory.tsx"));
});
after(async () => { await dash?.stop?.(); try { globalThis.window?.close(); } catch { /* gone */ } });

// --- the file and which limit wins ---

test("the machine-wide limit is kept beside the ledger, set, read back with who and when, and cleared", () => {
    assert.equal(mb.limitFile(), path.join(DIR, "limit.json"));
    mb.setLimit(null);
    assert.equal(mb.readLimit(), null);
    const set = mb.setLimit(12 * GB, "sb (hold.mjs)");
    assert.deepEqual([set.bytes, set.by], [12 * GB, "sb (hold.mjs)"]);
    assert.ok(Date.parse(set.at) > 0);
    assert.throws(() => mb.setLimit(-1), /not a memory limit/);
    mb.setLimit(null);
    assert.equal(existsSync(mb.limitFile()), false);
});

test("a sweep's --memory-limit wins, then the machine-wide one, then half the RAM; a person's either way is hand-set", () => {
    const machine = { bytes: 12 * GB, by: "sb", at: "2026-10-10T12:30:00Z" };
    assert.deepEqual(mb.resolveLimit({ flag: 4 * GB, machine, total: 16 * GB }), { bytes: 4 * GB, source: "flag", handSet: true });
    assert.deepEqual(mb.resolveLimit({ machine, total: 16 * GB }), { bytes: 12 * GB, source: "machine", handSet: true, by: "sb", at: machine.at });
    assert.deepEqual(mb.resolveLimit({ total: 16 * GB }), { bytes: 8 * GB, source: "auto", handSet: false });
    assert.equal(mb.limitWhence(mb.resolveLimit({ machine, total: 16 * GB })), "set machine-wide by sb at 2026-10-10 12:30 UTC");
    assert.equal(mb.limitWhence({ source: "flag" }), "this sweep's --memory-limit");
    assert.equal(mb.limitWhence({ source: "auto" }), "half the RAM, the default");
});

// --- a running sweep ---

test("a running budget takes a changed machine-wide limit up on its next measurement, says so, and keeps no reserve under it", () => {
    mb.setLimit(null);
    const changes = [];
    const b = mb.startBudget({ total: 16 * GB, avail: () => 10 * GB, everyMs: 60_000, measure: () => [{ kind: "held", pid: process.pid, rss: 5 * GB }], onLimit: (now, was) => changes.push([was.bytes, now.bytes, now.source]) });
    // Half of 16 GB, 4 GB kept free: room min(8 - 5, 10 - 4) = 3 GB.
    assert.deepEqual([b.state().limit, b.state().reserve, b.state().room, b.state().limitSource], [8 * GB, 4 * GB, 3 * GB, "auto"]);
    mb.setLimit(14 * GB, "person (page)");
    b.refresh();
    assert.deepEqual(changes, [[8 * GB, 14 * GB, "machine"]]);
    // Hand-set: no reserve, so the free memory alone bounds it: min(14 - 5, 10 - 0) = 9 GB.
    assert.deepEqual([b.state().limit, b.state().reserve, b.state().room, b.state().limitBy], [14 * GB, 0, 9 * GB, "person (page)"]);
    mb.setLimit(4 * GB, "sb");
    b.refresh();
    assert.equal(b.canStart("t").ok, false, "lowered under what is held: nothing more starts, nothing is stopped");
    mb.setLimit(null);
    b.refresh();
    assert.equal(b.limit().source, "auto");
    assert.equal(changes.length, 3);
    b.stop();
});

test("a sweep started with --memory-limit keeps it whatever the machine-wide limit becomes", () => {
    const b = mb.startBudget({ limit: 6 * GB, total: 16 * GB, avail: () => 10 * GB, everyMs: 60_000, measure: () => [] });
    mb.setLimit(12 * GB, "sb");
    b.refresh();
    assert.deepEqual([b.limit().bytes, b.limit().source], [6 * GB, "flag"]);
    mb.setLimit(null);
    b.stop();
});

// --- hold.mjs --limit ---

test("hold.mjs --limit shows, sets, refuses a non-size, and goes back to half the RAM", () => {
    const run = (...a) => execFileSync(process.execPath, ["--import", "tsx", "tests/e2e/bench/hold.mjs", "--limit", ...a], { cwd: ROOT, encoding: "utf8", env: { ...process.env } });
    mb.setLimit(null);
    assert.match(run(), /machine-wide memory limit: .* \(half the RAM, the default\)/);
    assert.match(run("6G"), /machine-wide memory limit: 6\.0 GB \(set machine-wide by .* \(hold\.mjs\) at .* UTC\), was /);
    assert.equal(mb.readLimit().bytes, 6 * GB);
    assert.match(run("6G"), /keeps no share of the RAM free, so past what this machine has free it swaps/);
    assert.throws(() => run("lots"), (e) => /not a size: lots/.test(String(e.stdout)));
    assert.equal(mb.readLimit().bytes, 6 * GB, "a refused size changes nothing");
    assert.match(run("auto"), /\(half the RAM, the default\), was 6\.0 GB/);
    assert.equal(mb.readLimit(), null);
});

// --- the page server ---

test("POST /memory-limit sets the machine-wide limit from the page: JSON only, a size or auto, answering what is set", async () => {
    const { startDashboard } = await import("../tests/e2e/bench/serve.mjs");
    dash = await startDashboard({ port: 0, artifactRoot: DIR });
    const post = (body, type = "application/json") => fetch(`${dash.url}memory-limit`.replace(/([^/])memory/, "$1/memory"), { method: "POST", headers: { "content-type": type }, body });
    assert.equal((await post(JSON.stringify({ limit: "12G" }), "text/plain")).status, 415, "a cross-origin form post is refused");
    assert.equal((await post("nope")).status, 400);
    const bad = await post(JSON.stringify({ limit: "lots" }));
    assert.deepEqual([bad.status, await bad.text()], [400, "not a size: 12G, 512M, or auto"]);
    assert.equal(mb.readLimit(), null);
    const ok = await post(JSON.stringify({ limit: "10G" }));
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.deepEqual([j.bytes, j.source], [10 * GB, "machine"]);
    assert.match(j.text, /^10\.0 GB \(set machine-wide by person \(page\) at /);
    assert.equal(mb.readLimit().by, "person (page)");
    assert.deepEqual((await (await post(JSON.stringify({ limit: "auto" }))).json()).source, "auto");
    assert.equal(mb.readLimit(), null);
});

// --- the Memory card's control ---

const MEM = { limit: 8 * GB, used: 2 * GB, byKind: { runner: 200 * MB }, available: 9 * GB, total: 16 * GB, reserve: 4 * GB, room: 5 * GB, active: true, whenFull: "pause",
    paused: null, resume: "x", hints: [], runner: null, groups: [], wouldHold: [], history: [], limitSource: "auto" };
const card = (m, live) => { const root = document.getElementById("root"); render(null, root); render(h(MemoryCard, { m, live }), root); return root; };
const tick = () => new Promise((r) => setTimeout(r, 20));

test("the card names where its limit came from; the control is on a live page only, and not over a sweep's own flag", () => {
    let root = card(MEM, true);
    assert.match(root.querySelector("header .sub").textContent, /2\.0 GB of a 8\.0 GB limit \(half the RAM, the default\)/);
    assert.ok(root.querySelector(".mlimit input"));
    assert.equal(root.querySelector(".mlimit button[type=button]"), null, "nothing to go back from");
    root = card(MEM, false);
    assert.equal(root.querySelector(".mlimit"), null, "a saved report has no server to set it on");
    root = card({ ...MEM, limitSource: "machine", limitBy: "sb (hold.mjs)", limitAt: "2026-10-10T12:30:00Z", reserve: 0 }, true);
    assert.match(root.querySelector("header .sub").textContent, /\(set machine-wide by sb \(hold\.mjs\) at 2026-10-10 12:30 UTC\)/);
    assert.ok(root.querySelector(".mlimit button[type=button]"), "back to half the RAM");
    root = card({ ...MEM, limitSource: "flag" }, true);
    assert.equal(root.querySelector(".mlimit input"), null);
    assert.match(root.querySelector(".mlimit").textContent, /started with --memory-limit, which wins/);
});

test("the control posts what was typed, or auto, and says what is set or why it was not", async () => {
    const sent = [];
    globalThis.fetch = async (url, init) => {
        sent.push([url, init.headers["content-type"], JSON.parse(init.body)]);
        const limit = JSON.parse(init.body).limit;
        return limit === "lots" ? { ok: false, text: async () => "not a size: 12G, 512M, or auto" } : { ok: true, json: async () => ({ text: limit === "auto" ? "8.0 GB (half the RAM, the default)" : "12.0 GB (set machine-wide by person (page) at …)" }) };
    };
    const root = card({ ...MEM, limitSource: "machine" }, true);
    const input = root.querySelector(".mlimit input");
    const type = async (v) => { input.value = v; input.dispatchEvent(new window.Event("input", { bubbles: true })); await tick(); };
    const submit = () => root.querySelector(".mlimit").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await type("12G"); submit(); await tick();
    assert.deepEqual(sent[0], ["/memory-limit", "application/json", { limit: "12G" }]);
    assert.match(root.querySelector(".mlimit").textContent, /Set: 12\.0 GB \(set machine-wide by person \(page\).*Running sweeps take it up within 5 s/);
    await type("lots"); submit(); await tick();
    assert.match(root.querySelector(".mlimit").textContent, /Not set: not a size/);
    root.querySelector(".mlimit button[type=button]").click(); await tick();
    assert.deepEqual(sent.at(-1)[2], { limit: "auto" });
    await type("  "); submit(); await tick();
    assert.equal(sent.length, 3, "nothing typed, nothing sent");
});
