// page-reachable.test.mjs — what happens when a delegated page tool gets no answer at all: the tab is watched
// while the call is outstanding, a tab the browser has put to sleep ends the wait at once, and a tab that simply
// never answers is bounded rather than left to hang (the failure this exists for ran 13m57s).
"use strict";
import { test } from "node:test";
import assert from "node:assert";
import { watchWhileWaiting, PageUnreachable, reachabilityNote, PAGE_SILENCE_CAP_MS } from "../src/sw/page-reachable.ts";

// A sleep that returns immediately but still yields, so a test runs a 4-minute cap in microseconds without
// pretending the awaits do not happen.
const fast = () => Promise.resolve();
const never = new Promise(() => {});

// --- a delegated call that answers ---

test("an answer wins, and costs no probe when it is prompt", async () => {
    let probes = 0;
    const v = await watchWhileWaiting(Promise.resolve("done"), async () => { probes++; return "awake"; }, { sleep: fast });
    assert.equal(v, "done");
    assert.equal(probes, 0, "a send that has already settled is never second-guessed");
});

test("a slow but honest call is waited out, not killed", async () => {
    let probes = 0;
    const slow = new Promise((r) => setTimeout(() => r("look result"), 30));
    const v = await watchWhileWaiting(slow, async () => { probes++; return "awake"; }, { probeMs: 1, capMs: 10_000, sleep: () => new Promise((r) => setTimeout(r, 1)) });
    assert.equal(v, "look result");
    assert.ok(probes > 0, "the tab was actually watched while it ran");
});

test("the send's own rejection is passed through untouched", async () => {
    await assert.rejects(
        watchWhileWaiting(Promise.reject(new Error("Receiving end does not exist")), async () => "awake", { sleep: fast }),
        /Receiving end does not exist/,
        "the navigation path recognises Chrome's own wording, so it must not be rewritten here",
    );
});

// --- a delegated call that gets nothing back ---

test("a discarded tab ends the wait at once, rather than at the cap", async () => {
    const e = await watchWhileWaiting(never, async () => "asleep", { probeMs: 1000, capMs: PAGE_SILENCE_CAP_MS, sleep: fast })
        .then(() => null, (x) => x);
    assert.ok(e instanceof PageUnreachable);
    assert.equal(e.state, "asleep");
    assert.equal(e.waitedMs, 1000, "one probe interval, not the four-minute backstop");
    assert.match(e.message, /discarded this run's tab/);
});

test("a closed tab says so, and a probe that throws is read as closed", async () => {
    const closed = await watchWhileWaiting(never, async () => "gone", { probeMs: 1, sleep: fast }).then(() => null, (x) => x);
    assert.equal(closed.state, "gone");
    const threw = await watchWhileWaiting(never, async () => { throw new Error("No tab with id: 7"); }, { probeMs: 1, sleep: fast })
        .then(() => null, (x) => x);
    assert.equal(threw.state, "gone", "chrome.tabs.get throwing IS the tab being gone");
});

test("a tab that looks awake and never answers is still bounded", async () => {
    let probes = 0;
    const e = await watchWhileWaiting(never, async () => { probes++; return "awake"; }, { probeMs: 10, capMs: 50, sleep: fast })
        .then(() => null, (x) => x);
    assert.equal(e.state, "silent", "a FROZEN tab reports nothing unusual, so the cap is the only thing left");
    assert.equal(e.waitedMs, 50);
    assert.equal(probes, 5);
});

test("the cap is generous enough for the slowest honest tool this repo has measured", () => {
    // A real `look` — screenshot plus a vision model's reply — took 56s on the run that prompted all this.
    assert.ok(PAGE_SILENCE_CAP_MS >= 56_000 * 3, `the cap (${PAGE_SILENCE_CAP_MS}ms) must leave room for a slow look`);
});

// --- what the person and the model are told ---

test("each reason reads as a different thing to do about it", () => {
    assert.match(reachabilityNote("gone", 1000), /closed/);
    assert.match(reachabilityNote("asleep", 1000), /background/);
    assert.match(reachabilityNote("silent", 240_000), /240s/);
    // Model-facing, so no padding: AGENTS.md's rule about runs of spaces in a generated string.
    for (const s of ["gone", "asleep", "silent"]) assert.ok(!/ {2}/.test(reachabilityNote(s, 1000)), s);
});

// --- a crashed renderer and a page whose thread spins (page-health) ---

// A probe that plays a scripted sequence of verdicts, then repeats the last.
const scripted = (states) => { let i = 0; return async () => states[Math.min(i++, states.length - 1)]; };

test("a crashed tab ends the wait at once, with state crashed", async () => {
    const e = await watchWhileWaiting(never, async () => "crashed", { probeMs: 1000, capMs: PAGE_SILENCE_CAP_MS, sleep: fast })
        .then(() => null, (x) => x);
    assert.ok(e instanceof PageUnreachable);
    assert.equal(e.state, "crashed");
    assert.equal(e.waitedMs, 1000);
});

test("three unresponsive probes in a row are busy, waited 3 x probeMs", async () => {
    let probes = 0;
    const e = await watchWhileWaiting(never, async () => { probes++; return "unresponsive"; }, { probeMs: 4000, sleep: fast })
        .then(() => null, (x) => x);
    assert.ok(e instanceof PageUnreachable);
    assert.equal(e.state, "busy");
    assert.equal(e.waitedMs, 12000);
    assert.equal(probes, 3);
});

test("two unresponsive probes are a strike count, not a verdict: an awake probe resets it", async () => {
    let resolveSend;
    const send = new Promise((r) => { resolveSend = r; });
    const states = ["unresponsive", "unresponsive", "awake", "unresponsive", "unresponsive", "awake"];
    let i = 0;
    const probe = async () => { const s = states[i++]; if (i === states.length) resolveSend("ok"); return s; };
    const v = await watchWhileWaiting(send, probe, { probeMs: 1, capMs: 10_000, sleep: fast });
    assert.equal(v, "ok", "never 5 strikes in a row, so never busy");
    assert.equal(i, states.length);
});

test("the busyStrikes option sets how many missed pings make a page busy", async () => {
    const one = await watchWhileWaiting(never, scripted(["unresponsive"]), { probeMs: 10, busyStrikes: 1, sleep: fast }).then(() => null, (x) => x);
    assert.equal(one.state, "busy");
    assert.equal(one.waitedMs, 10);
    const five = await watchWhileWaiting(never, scripted(["unresponsive"]), { probeMs: 10, busyStrikes: 5, sleep: fast }).then(() => null, (x) => x);
    assert.equal(five.state, "busy");
    assert.equal(five.waitedMs, 50);
});

test("a send that settles while the probe is still pending wins over its verdict", async () => {
    for (const verdict of ["unresponsive", "crashed"]) {
        let resolveSend, resolveProbe;
        const send = new Promise((r) => { resolveSend = r; });
        const probe = () => new Promise((r) => { resolveProbe = r; });
        const p = watchWhileWaiting(send, probe, { probeMs: 1, busyStrikes: 1, sleep: fast });
        for (let k = 0; k < 10 && !resolveProbe; k++) await Promise.resolve();
        assert.ok(resolveProbe, "the probe is out");
        resolveSend("answered");
        await Promise.resolve();
        resolveProbe(verdict);
        assert.equal(await p, "answered", verdict);
    }
});

test("reachabilityNote: crashed says crashed, busy says busy and the seconds; neither says asleep", () => {
    const c = reachabilityNote("crashed", 1000);
    assert.match(c, /crashed/);
    assert.doesNotMatch(c, /asleep/);
    const b = reachabilityNote("busy", 12000);
    assert.match(b, /busy/);
    assert.match(b, /12s/);
    assert.doesNotMatch(b, /asleep/);
    for (const [s, n] of [["crashed", 1000], ["busy", 12000]]) assert.ok(!/ {2}/.test(reachabilityNote(s, n)), s);
});
