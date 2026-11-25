// redteam-spawn-hide.test.mjs — the red-team pass for ruling 34 PR B (POLICIES.md, "What the host gets"): what a call
// that names a path a `hide` holds must NOT get. The PR's own rows (tests/spawn-hide-list.test.mjs) carry the choke
// point, the list's parity with `resolveHidden`, the old host and the card. What is left for this file is the answer
// the built-in default could still give and the one wait that had no row:
//   1. a FREE call — effects inside the placement's built-in bound, NO policy stored at all — still asks when a path it
//      names is held; only the `hiddenBy` a host reports stands between it and `by: "builtin"`;
//   2. the same through the worker end to end: a session with only a `hide` and no other policy asks, and the card
//      carries the host's `hiddenBy`; without the hide the identical call is free;
//   3. a policy store that stays PENDING is refused within `POLICIES_WAIT_MS`, not spawned: the PR covers a read that
//      FAILED, and a store that never answers is the other way the list is unknown.
// Code under test: src/sw/sw-policies.ts (`judgeCall`'s `namesHidden`), src/sw/sw-spawn.ts (`spawnBound`'s wait).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

// --- 1. the built-in default does not answer a held path ---

globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://test/${p}`, sendMessage: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
};
const { globMatch } = await import("../src/files-hide.ts");
const P = await import("../src/sw/sw-policies.ts");
await P.policiesReady;

test("a free call asks when a path it names is held: the built-in default never sees it", () => {
    const aPath = { arg: 1, given: "secret.txt", path: "/r/secret.txt", inRoot: true, secret: false, exists: true };
    // A read inside the roots: the one effect `free()` takes with no bound at all (effects.ts, `isReadInRoots`).
    const effects = [{ op: "read", res: { kind: "fs", inRoot: true } }];
    const freeNoPolicy = P.judgeCall(undefined, "sh", { effects, paths: [aPath] }, "host-sandbox");
    assert.equal(freeNoPolicy.decision, "allow", "positive control: with nothing held, the built-in default allows it");
    assert.equal(freeNoPolicy.by, "builtin");
    const held = P.judgeCall(undefined, "sh", { effects, paths: [aPath, { ...aPath, hiddenBy: "p1" }] }, "host-sandbox");
    assert.equal(held.decision, undefined, "the built-in default answered a call that names a held path");
    assert.equal(held.by, undefined);
    // A hiddenBy that is not a string is not a hold (the host's field, and the one shape a broken host could send).
    for (const bad of [undefined, null, 7, true, { id: "p1" }, ["p1"]]) {
        assert.equal(P.judgeCall(undefined, "sh", { effects, paths: [{ ...aPath, hiddenBy: bad }] }, "host-sandbox").decision, "allow", `hiddenBy ${JSON.stringify(bad)} was read as a hold`);
    }
});

// --- 2. end to end: only the hide, no other policy ---

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const HIDE_SECRET = { id: "pol-rt-hide", scope: "global", consumer: "files", effect: "hide", source: "/w/proj/secret.txt", label: "hide the secret", origin: "person", created: 1760000000000 };
const runs = (argv) => () => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;
const valueOf = (result) => { const m = /^value: (.*)$/m.exec(result) ?? /^(\{.*\})$/m.exec(result); assert.ok(m, `no value in: ${result}`); return JSON.parse(m[1]); };

/** A fake host that takes the list and answers `paths[].hiddenBy` from it, as the real one does (the last match decides). */
function hidingHost() {
    const host = fakeNativeHost();
    const requests = new Map();
    return {
        host,
        spawns: () => host.calls.filter((c) => c.call === "spawn"),
        onNative: (name, e) => {
            const send = (m) => {
                const req = requests.get(m.seq);
                if (m.value?.host === "window-ml-host") m = { ...m, value: { ...m.value, hideList: true } };
                if (req?.call === "spawn" && m.value?.paths) {
                    const list = req.args.hideList ?? [];
                    m = { ...m, value: { ...m.value, paths: m.value.paths.map((p) => { const by = [...list].reverse().find((x) => x.effect === "hide" && globMatch(x.pattern, p.path)); return by ? { ...p, hiddenBy: by.id } : p; }) } };
                }
                e.send(m);
            };
            const inner = host.onNative(name, { ...e, send });
            return inner && ((msg) => { requests.set(msg.seq, msg); return inner(msg); });
        },
    };
}
function answering() {
    const asked = [];
    return {
        asked,
        onStep: async (bg, ev) => {
            for (const a of ev.asks ?? []) if (a.state === "pending" && !asked.some((x) => x.id === a.id)) {
                asked.push(a);
                void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: false } });
            }
        },
    };
}

test("with only a hide and no policy at all, ml.sh asks; the card carries the host's hiddenBy; nothing starts on decline", T, async () => {
    const hh = hidingHost(), ask = answering();
    await runOn("userScripts", [runs(["cat", "secret.txt"])], { fetches: [], onNative: hh.onNative, configExtra: ON, onStep: ask.onStep, localExtra: { ml_policies_global: [HIDE_SECRET] } });
    const spawns = hh.spawns();
    assert.ok(spawns.length >= 1);
    assert.deepEqual(spawns[0].args.hideList, [{ id: HIDE_SECRET.id, effect: "hide", pattern: "/w/proj/secret.txt" }]);
    assert.ok(ask.asked.length >= 1, "a free call that names a held file ran without asking");
    const paths = ask.asked[0].facts?.paths ?? [];
    assert.equal(paths.find((p) => p.path === "/w/proj/secret.txt")?.hiddenBy, HIDE_SECRET.id, `the card does not name the rule that holds the path: ${JSON.stringify(ask.asked[0].facts)}`);
    assert.equal(hh.host.calls.filter((c) => c.call === "start").length, 0, "the call started although the person denied it");
});

test("the same call without the hide is free: the built-in default answers it and no list is sent", T, async () => {
    const hh = hidingHost(), ask = answering();
    const { results } = await runOn("userScripts", [runs(["cat", "secret.txt"])], { fetches: [], onNative: hh.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(valueOf(results[0]).approvedBy, "builtin", results[0].slice(0, 300));
    assert.equal(ask.asked.length, 0);
    assert.equal("hideList" in hh.spawns()[0].args, false);
});

// --- 3. a store that never answers is refused, not spawned ---

test("a policy store still pending after POLICIES_WAIT_MS refuses the spawn with HIDE_LIST_LOADING and starts nothing", () => {
    // The module's read state is fixed at load, so a store that never answers is loaded in a child process.
    const script = `
        globalThis.chrome = { runtime: { getURL: (p) => p, sendMessage: async () => {} }, storage: { local: { get: () => new Promise(() => {}), set: async () => {} } } };
        const { spawnBound, HIDE_LIST_LOADING, POLICIES_WAIT_MS } = await import(${JSON.stringify(join(ROOT, "src/sw/sw-spawn.ts"))});
        const { ShRefused } = await import(${JSON.stringify(join(ROOT, "src/shell/sh-call.ts"))});
        let spawned = 0;
        const h = { hello: { hideList: true }, client: { spawn: async () => { spawned++; return {}; } } };
        const t0 = Date.now();
        let out;
        try { await spawnBound(h, "h-x", { argv: ["cat"], mode: "host" }); out = { ok: true }; } catch (e) { out = { refused: e instanceof ShRefused, code: e.code, text: e.message === HIDE_LIST_LOADING }; }
        console.log(JSON.stringify({ ...out, spawned, ms: Date.now() - t0, wait: POLICIES_WAIT_MS }));`;
    const out = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").at(-1));
    assert.equal(out.refused, true, "a pending store did not refuse the spawn");
    assert.equal(out.code, "Refused");
    assert.equal(out.text, true, "the refusal is not HIDE_LIST_LOADING");
    assert.equal(out.spawned, 0, "the host was spawned while the hiding rules were unknown");
    assert.ok(out.ms >= out.wait - 100 && out.ms < out.wait + 3000, `the wait was ${out.ms} ms, not ~${out.wait}`);
});
