// start-run-strip.test.mjs — what a page's START_RUN may not set, at the payload's top level and inside its `rebuild`.

import { test } from "node:test";
import assert from "node:assert/strict";

/** sw-run-host.ts, imported with a `chrome` that answers any path. */
async function runHost() {
    const deep = () => new Proxy(function () {}, {
        get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : deep()),
        apply: () => deep(),
    });
    const prev = globalThis.chrome;
    globalThis.chrome = deep();
    try { return await import("../src/sw/sw-run-host.ts"); } finally { globalThis.chrome = prev; }
}

const SITE = { tab: { id: 7, url: "https://site.example/p" }, url: "https://site.example/p", origin: "https://site.example", frameId: 0 };
/** A sender the browser stamped with no origin: the top level then gets no `pageOrigin`/`pageUrl` back. */
const NO_ORIGIN = { tab: { id: 7 }, frameId: 0 };
const CFG = { autoApprovePython: false, autoApproveReadonly: false, autoApproveSelfSource: false, selfIntrospection: false };
/** The keys the sender's stamp puts back at the top level, read from `sender`, never from the page. */
const RESTAMPED = new Set(["pageOrigin", "pageUrl"]);

// --- one list of keys, stripped at both levels ---

test("PAGE_STRIPPED_KEYS is the person's fields and the sender's, and nothing was dropped from it", async () => {
    const { PAGE_STRIPPED_KEYS } = await runHost();
    assert.deepEqual([...PAGE_STRIPPED_KEYS].sort(), ["builtBy", "display", "files", "inputScrubbed", "origin", "pageOrigin", "pageUrl", "sends"]);
});

test("ADVERSARIAL: each stripped key a page writes, at the top level and inside `rebuild`, is gone from both; the control keys stay", async () => {
    const { PAGE_STRIPPED_KEYS, pageStartPayload } = await runHost();
    for (const key of PAGE_STRIPPED_KEYS) {
        const forged = `forged-${key}`;
        for (const [name, sender] of [["SITE", SITE], ["NO_ORIGIN", NO_ORIGIN]]) {
            const out = pageStartPayload({ runId: "r1", task: "t", tools: [], [key]: forged, rebuild: { toolNames: ["exec"], [key]: forged } }, sender, CFG);
            const why = `${key} (sender ${name})`;
            assert.equal(Object.hasOwn(out.rebuild, key), false, `rebuild.${why} survived`);
            if (RESTAMPED.has(key) && name === "SITE") assert.notEqual(out[key], forged, `${why}: the page's value, not the sender's`);
            else assert.equal(Object.hasOwn(out, key), false, `${why} survived`);
            assert.equal(out.task, "t", `${why}: the control key at the top level`);
            assert.deepEqual(out.rebuild.toolNames, ["exec"], `${why}: the control key inside rebuild`);
        }
    }
});

test("the strip copies: the page's payload and its `rebuild` are left as sent", async () => {
    const { pageStartPayload } = await runHost();
    const rebuild = { toolNames: [], builtBy: "worker", files: [] };
    const sent = { runId: "r1", task: "t", tools: [], files: [], rebuild };
    const out = pageStartPayload(sent, SITE, CFG);
    assert.notEqual(out.rebuild, rebuild);
    assert.deepEqual(Object.keys(rebuild), ["toolNames", "builtBy", "files"]);
    assert.ok(Object.hasOwn(sent, "files"));
});
