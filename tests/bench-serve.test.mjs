"use strict";
// The bench's live dashboard. Two things are worth a test: it must not serve files outside the sweep, and
// its pushed state must be the same numbers the report shows.
//
// The traversal guard matters more than "it's only localhost" suggests. The paths in those links are built
// from a SPEC's task ids and dimension values, and a spec is code someone else may have written — so the
// server is reading a path it did not choose. curl normalises `..` before sending, which is exactly how a
// guard like this gets believed without ever being exercised; these requests use encoded dots.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { startDashboard } = await import("../tests/e2e/bench/serve.mjs");

/** A sweep directory with one artifact in it, plus a secret OUTSIDE it to try to reach. */
async function fixture() {
    const base = await mkdtemp(join(tmpdir(), "bench-serve-"));
    const sweep = join(base, "sweep");
    await mkdir(join(sweep, "task", "combo", "r0"), { recursive: true });
    await writeFile(join(sweep, "task", "combo", "r0", "run.md"), "# a run\n");
    await writeFile(join(base, "secret.txt"), "must not be served");
    return { base, sweep };
}

test("serves an artifact inside the sweep, and 404s one that is not written yet", async () => {
    const { sweep } = await fixture();
    const d = await startDashboard({ artifactRoot: sweep });
    try {
        const ok = await fetch(`${d.url}/artifacts/task/combo/r0/run.md`);
        assert.equal(ok.status, 200);
        assert.match(await ok.text(), /# a run/);
        assert.equal((await fetch(`${d.url}/artifacts/task/combo/r0/run.json`)).status, 404,
            "a run mid-flight has not written everything — that is a 404, not an error");
    } finally { await d.stop(); }
});

test("refuses to escape the sweep directory, including through encoded dots", async () => {
    const { sweep } = await fixture();
    const d = await startDashboard({ artifactRoot: sweep });
    try {
        for (const attempt of [
            "/artifacts/%2e%2e%2fsecret.txt",
            "/artifacts/" + encodeURIComponent("../secret.txt"),
            "/artifacts/task/%2e%2e/%2e%2e/secret.txt",
            "/artifacts/" + encodeURIComponent("../../../../../../etc/passwd"),
        ]) {
            const res = await fetch(`${d.url}${attempt}`);
            // NOT a specific status: some of these never reach the artifact handler at all, because the
            // URL parser normalises the dots and the path stops starting with /artifacts/ (a 404 rather
            // than the guard's 403). Asserting 403 would have been asserting WHICH layer refused, and
            // would fail on an attempt that a lower layer had already made harmless. The property is that
            // the bytes do not come back.
            assert.notEqual(res.status, 200, `${attempt} must not be served`);
            assert.doesNotMatch(await res.text(), /must not be served/, `${attempt} leaked the file`);
        }
    } finally { await d.stop(); }
});

test("the page is self-contained — no build step, no CDN, no dependency", async () => {
    const { sweep } = await fixture();
    const d = await startDashboard({ artifactRoot: sweep });
    try {
        const html = await (await fetch(`${d.url}/`)).text();
        assert.match(html, /<!doctype html>/i);
        assert.match(html, /EventSource\("\/events"\)/, "it must subscribe to the stream");
        assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/, "a local dev view must not fetch from the internet");
    } finally { await d.stop(); }
});

test("the page's script PARSES — a blank dashboard is otherwise indistinguishable from an idle one", async () => {
    // The page is authored inside a template literal, so an escape that is right in the SOURCE can be
    // wrong in the OUTPUT: `class=\"live\"` unescaped to a bare quote and broke the whole script, and the
    // page then sat on "waiting for the sweep…" forever — which is exactly what a not-yet-started sweep
    // looks like. Checking that `EventSource(` appears in the text did not catch it, because the text was
    // fine; the PROGRAM was not.
    const { sweep } = await fixture();
    const d = await startDashboard({ artifactRoot: sweep });
    try {
        const html = await (await fetch(`${d.url}/`)).text();
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        assert.ok(scripts.length, "the page must carry a script");
        for (const src of scripts) {
            // Compiled, never run: it touches document/EventSource, which do not exist here. A SyntaxError
            // throws at construction, which is the failure being guarded.
            assert.doesNotThrow(() => new Function(src), "the page script does not parse");
        }
    } finally { await d.stop(); }
});

test("a late subscriber gets the CURRENT state, not an empty page", async () => {
    // A sweep runs for hours; opening the tab at hour three must not show "nothing has started".
    const { sweep } = await fixture();
    const d = await startDashboard({ artifactRoot: sweep });
    try {
        d.update({ name: "half-done", runs: [{ state: "done", taskId: "t", repeat: 0, combo: {} }], rows: [], jobs: 1, started: Date.now() });
        const res = await fetch(`${d.url}/events`);
        const reader = res.body.getReader();
        const chunk = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("no frame within 3s")), 3000);
            reader.read().then(({ value }) => { clearTimeout(t); resolve(new TextDecoder().decode(value)); }, reject);
        }).finally(() => reader.cancel().catch(() => {}));   // the reader holds the lock; cancel THROUGH it
        const state = JSON.parse(chunk.replace(/^data: /, ""));
        assert.equal(state.name, "half-done");
        assert.equal(state.runs[0].state, "done");
        assert.ok(state.columns?.length, "the column definitions ride along, so the page never invents them");
    } finally { await d.stop(); }
});

test("the column set comes from metrics.mjs, so the page cannot show a different table to the report", async () => {
    const { COLUMNS } = await import("../tests/e2e/bench/metrics.mjs");
    const { sweep } = await fixture();
    const d = await startDashboard({ artifactRoot: sweep });
    try {
        d.update({ name: "x", runs: [], rows: [], jobs: 1, started: Date.now() });
        const res = await fetch(`${d.url}/events`);
        const reader = res.body.getReader();
        try {
            const { value } = await reader.read();
            const state = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ""));
            assert.deepEqual(state.columns.map((c) => c.key), COLUMNS.map((c) => c.key));
        } finally { await reader.cancel().catch(() => {}); }
    } finally { await d.stop(); }
});
