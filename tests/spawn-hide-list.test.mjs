// spawn-hide-list.test.mjs — every process spawn carries the session's hiding rules (POLICIES.md, "What the host gets", ruling 34
// PR B): the one choke point `spawnBound`, the list the host reads (`hostHideList`) against the worker's own `resolveHidden`,
// what a spawn is sent in each host/rule combination, the call that ASKS when a path is hidden, and its card line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://test/${p}`, sendMessage: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
};
const P = await import("../src/sw/sw-policies.ts");
const { addFilesRule, removeFilesRule } = await import("../src/sw/sw-files-hide.ts");
const { spawnBound, HIDE_HOST_TOO_OLD, HIDE_LIST_UNREAD, hideRuleWords } = await import("../src/sw/sw-spawn.ts");
const { hostHideList, resolveHidden, globMatch, patternRefusal } = await import("../src/files-hide.ts");
const { shFacts, shCardLines, ShRefused } = await import("../src/shell/sh-call.ts");
await P.policiesReady;

const ROOT = new URL("..", import.meta.url).pathname;

/** Every .ts/.tsx file under a directory, as paths relative to the repo. */
function sources(dir = join(ROOT, "src")) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...sources(p));
        else if (/\.tsx?$/.test(name) && !/\.gen\.ts$/.test(name)) out.push(relative(ROOT, p));
    }
    return out;
}

// --- the choke point is the only way to spawn ---

test("ENUMERATED: HostClient.spawn is called from sw-spawn.ts alone, and the callers of spawnBound are a pinned list", () => {
    const spawnCalls = [], boundCallers = [], otherSpellings = [];
    for (const f of sources()) {
        const text = readFileSync(join(ROOT, f), "utf8");
        // src/pdf/pdf-host.ts calls an unrelated `opts.spawn()` (a worker factory), not a process host's.
        if (/\.client\.spawn\(/.test(text)) spawnCalls.push(f);
        if (/\bspawnBound\(/.test(text.replace(/export async function spawnBound\(/, "")) && f !== "src/sw/sw-spawn.ts") boundCallers.push(f);
        if (f !== "src/pdf/pdf-host.ts" && f !== "src/shell/host-protocol.ts" && (/\[\s*["'`]spawn["'`]\s*\]/.test(text) || /\.call\(\s*["'`]spawn["'`]/.test(text) || /\.spawn\s*\(/.test(text.replace(/\.client\.spawn\(/g, "")))) otherSpellings.push(f);
    }
    assert.deepEqual(spawnCalls, ["src/sw/sw-spawn.ts"], "a spawn that does not go through spawnBound would reach the host without the hiding rules");
    assert.deepEqual(boundCallers.sort(), ["src/sw/sw-library-proposal.ts", "src/sw/sw-manifest-proposal.ts", "src/sw/sw-shell-call.ts"], "a new caller of spawnBound is added here on purpose");
    assert.deepEqual(otherSpellings, [], "a spawn on a host client in another spelling");
});

// --- hostHideList agrees with resolveHidden ---

/** What the host does with the list (window-ml-host PROTOCOL.md, "The hide list"): the LAST entry that matches a path decides, a hide by the path or a directory above it, a show by the path itself. */
function hostDecides(list, path) {
    const dirs = [];
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) dirs.push(path.slice(0, at));
    for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (globMatch(e.pattern, path) || (e.effect === "hide" && dirs.some((d) => globMatch(e.pattern, d)))) return { hidden: e.effect === "hide", by: e.id };
    }
    return resolveHidden(path, []);
}

const PATTERNS = ["/r/secret.txt", "/r/*.txt", "/r/sec*", "/r/d", "/r/d/*", "/r/?ecret.txt", "/r/*", "/r/d/x.txt", "/files/agent/.env", "/files/agent/*"];
const PATHS = ["/r/secret.txt", "/r/other.txt", "/r/d", "/r/d/x.txt", "/r/d/y.log", "/r/sub/secret.txt", "/files/agent/.env", "/files/agent/.netrc"];
const BASES = PATTERNS.flatMap((source) => ["hide", "show"].flatMap((effect) => ["session", "global"].map((layer) => ({ effect, source, layer }))));

test("ENUMERATED: the host's last match is resolveHidden's answer, for every ordered list of 1 to 3 entries over 10 patterns x 2 effects x 2 layers, on 8 paths", () => {
    // 40 bases, ordered lists with repeats allowed (a repeat is a tie, told apart by its id): 40 + 40^2 + 40^3 lists, none sampled.
    const lists = [];
    const mk = (b, pos) => ({ id: `${b.layer[0]}${pos}`, ...b });
    for (const a of BASES) {
        lists.push([mk(a, 0)]);
        for (const b of BASES) {
            lists.push([mk(a, 0), mk(b, 1)]);
            for (const c of BASES) lists.push([mk(a, 0), mk(b, 1), mk(c, 2)]);
        }
    }
    assert.equal(lists.length, 40 + 1600 + 64000);
    let checked = 0;
    for (const entries of lists) {
        const list = hostHideList(entries);
        assert.equal(list.length, entries.length, "no entry of this set is refused");
        for (const path of PATHS) {
            const want = resolveHidden(path, entries), got = hostDecides(list, path);
            if (want.hidden !== got.hidden || want.by !== got.by) assert.fail(`${path} under ${JSON.stringify(entries)}: resolveHidden ${JSON.stringify(want)}, the host's last match ${JSON.stringify(got)}`);
            checked++;
        }
    }
    assert.equal(checked, lists.length * PATHS.length);
});

test("a tie (the same pattern, effect and layer twice) names the FIRST stored id, and the list ends with it", () => {
    for (const effect of ["hide", "show"]) {
        const entries = [{ id: "first", effect, source: "/r/secret.txt", layer: "session" }, { id: "second", effect, source: "/r/secret.txt", layer: "session" }];
        const list = hostHideList(entries);
        assert.deepEqual(list.map((e) => e.id), ["second", "first"]);
        assert.equal(hostDecides(list, "/r/secret.txt").by, "first");
        assert.equal(resolveHidden("/r/secret.txt", entries).by, "first");
    }
});

test("a refused entry is absent from the list, and the rest keep their order", () => {
    const entries = [{ id: "bad", effect: "hide", source: "/r/**", layer: "session" }, { id: "ok", effect: "hide", source: "/r/secret.txt", layer: "global" }, { id: "rel", effect: "hide", source: "r/x", layer: "global" }];
    assert.ok(patternRefusal("/r/**", "hide"));
    assert.deepEqual(hostHideList(entries), [{ id: "ok", effect: "hide", pattern: "/r/secret.txt" }]);
    assert.deepEqual(hostHideList([]), []);
});

// --- spawnBound ---

const FACTS = { id: "c1", argv: ["cat"], paths: [] };
/** A host whose spawn records what it was sent. */
function fakeHost(hello) {
    const seen = [];
    return { seen, h: { hello, client: { spawn: async (s) => { seen.push(s); return FACTS; } } } };
}
const S = { argv: ["cat", "/r/x"], cwd: "/r", mode: "host" };
let n = 0;
const session = () => `h-spawn-${++n}`;

test("a host that takes the list is sent the session's rules then the global ones' effect, in hostHideList's order", async () => {
    const hash = session();
    const hide = addFilesRule(hash, { effect: "hide", source: "/r/*.txt", scope: "session" });
    const show = addFilesRule(hash, { effect: "show", source: "/r/ok.txt", scope: "global" });
    try {
        const { h, seen } = fakeHost({ hideList: true });
        assert.equal(await spawnBound(h, hash, S), FACTS);
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0], { ...S, hideList: hostHideList(P.filesHideEntries(hash)) });
        assert.deepEqual(seen[0].hideList.map((e) => e.id), [show.id, hide.id], "the global show goes under the session hide");
        assert.deepEqual(hideRuleWords(hash)[hide.id], "hide /r/*.txt");
    } finally { removeFilesRule(hash, show.id, true); }
});

test("with no rules the spawn has no hideList key at all: an older extension's request, byte for byte", async () => {
    const { h, seen } = fakeHost({ hideList: true });
    await spawnBound(h, session(), S);
    await spawnBound(h, undefined, S);
    assert.equal(seen.length, 2);
    for (const s of seen) {
        assert.equal("hideList" in s, false);
        assert.equal(JSON.stringify(s), JSON.stringify(S));
    }
});

test("a host that does not say hideList: true is refused a call with a hide, and is never spawned", async () => {
    const hash = session();
    addFilesRule(hash, { effect: "hide", source: "/r/secret.txt", scope: "session" });
    for (const hello of [{}, { hideList: false }, { hideList: "yes" }, { hideList: 1 }, null]) {
        const { h, seen } = fakeHost(hello);
        await assert.rejects(spawnBound(h, hash, S), (e) => e instanceof ShRefused && e.code === "Refused" && e.message === HIDE_HOST_TOO_OLD, JSON.stringify(hello));
        assert.equal(seen.length, 0, `a host with hello ${JSON.stringify(hello)} was spawned`);
    }
});

test("a host without hideList and only show entries is spawned with no hideList", async () => {
    const hash = session();
    addFilesRule(hash, { effect: "show", source: "/r/ok.txt", scope: "session" });
    const { h, seen } = fakeHost({});
    await spawnBound(h, hash, S);
    assert.deepEqual(seen, [S]);
    assert.equal("hideList" in seen[0], false);
});

test("a store that could not be read refuses the call, and nothing is spawned", () => {
    // The module's read state is fixed at load, so a failing store is loaded in a child process.
    const script = `
        globalThis.chrome = { runtime: { getURL: (p) => p, sendMessage: async () => {} }, storage: { local: { get: async () => { throw new Error("storage down"); }, set: async () => {} } } };
        const { spawnBound, HIDE_LIST_UNREAD } = await import(${JSON.stringify(join(ROOT, "src/sw/sw-spawn.ts"))});
        const { ShRefused } = await import(${JSON.stringify(join(ROOT, "src/shell/sh-call.ts"))});
        let spawned = 0;
        const h = { hello: { hideList: true }, client: { spawn: async () => { spawned++; return {}; } } };
        let out;
        try { await spawnBound(h, "h-x", { argv: ["cat"], mode: "host" }); out = { ok: true }; } catch (e) { out = { refused: e instanceof ShRefused, code: e.code, text: e.message === HIDE_LIST_UNREAD }; }
        console.log(JSON.stringify({ ...out, spawned }));`;
    const out = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").at(-1));
    assert.deepEqual(out, { refused: true, code: "Refused", text: true, spawned: 0 });
    assert.match(HIDE_LIST_UNREAD, /could not be read/);
});

test("a rule added between two spawns applies to the second: the list is read at each call", async () => {
    const hash = session();
    const { h, seen } = fakeHost({ hideList: true });
    await spawnBound(h, hash, S);
    const r = addFilesRule(hash, { effect: "hide", source: "/r/late.txt", scope: "session" });
    await spawnBound(h, hash, S);
    assert.equal("hideList" in seen[0], false);
    assert.deepEqual(seen[1].hideList, [{ id: r.id, effect: "hide", pattern: "/r/late.txt" }]);
    // And a host that cannot take it is refused from the second call on, not the first.
    const old = fakeHost({});
    const hash2 = session();
    await spawnBound(old.h, hash2, S);
    addFilesRule(hash2, { effect: "hide", source: "/r/late.txt", scope: "session" });
    await assert.rejects(spawnBound(old.h, hash2, S), (e) => e.message === HIDE_HOST_TOO_OLD);
    assert.equal(old.seen.length, 1);
});

test("model-facing refusal texts hold no run of two spaces", () => {
    for (const t of [HIDE_HOST_TOO_OLD, HIDE_LIST_UNREAD]) assert.doesNotMatch(t, /  /);
});

// --- a hidden path asks ---

const judged = (paths) => ({ effects: "unknown", paths });
const aPath = { arg: 1, given: "secret.txt", path: "/r/secret.txt", inRoot: true, secret: false, exists: true };

test("a path a hide holds asks even under a global-style allow policy; a deny still denies; without hiddenBy the allow allows", () => {
    const ALLOW = "(c) => true";
    const run = session(), denied = session(), bare = session();
    P.addRunPolicy(run, { consumer: "sh", effect: "allow", source: ALLOW, label: "all", origin: "person" });
    P.addRunPolicy(denied, { consumer: "sh", effect: "deny", source: ALLOW, label: "none", origin: "person" });
    P.addRunPolicy(bare, { consumer: "sh", effect: "allow", source: ALLOW, label: "all", origin: "person" });
    assert.equal(P.judgeCall(bare, "sh", judged([aPath])).decision, "allow", "positive control: the allow policy allows");
    assert.equal(P.judgeCall(run, "sh", judged([{ ...aPath, hiddenBy: "p1" }])).decision, undefined);
    assert.equal(P.judgeCall(run, "sh", judged([aPath, { ...aPath, hiddenBy: "p1" }])).decision, undefined, "one hidden path among several");
    assert.equal(P.judgeCall(denied, "sh", judged([{ ...aPath, hiddenBy: "p1" }])).decision, "deny");
    assert.equal(P.judgeCall(denied, "sh", judged([aPath])).decision, "deny");
    // A non-string hiddenBy is not a hold.
    assert.equal(P.judgeCall(bare, "sh", judged([{ ...aPath, hiddenBy: undefined }])).decision, "allow");
});

// --- the card ---

const HOST_FACTS = (hiddenBy) => ({
    id: "c1", argv: ["cat", "secret.txt"], program: { path: "/usr/bin/cat", inRoot: false }, cwd: { path: "/r", inRoot: true },
    env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null,
    paths: [{ arg: 1, given: "secret.txt", path: "/r/secret.txt", inRoot: true, secret: false, exists: true, ...(hiddenBy ? { hiddenBy } : {}) }],
    effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox", expiresInMs: 1000,
});

test("the card names the rule that holds a path: its words, or the id when the words are not known", () => {
    const place = { roots: ["/r"], hideRules: { p1: "hide /r/secret.txt" } };
    const f = shFacts(HOST_FACTS("p1"), null, place);
    assert.equal(f.paths[0].hiddenBy, "p1");
    assert.equal(f.paths[0].hiddenRule, "hide /r/secret.txt");
    const line = shCardLines(f).find((l) => l.label === "Path 1");
    assert.match(line.value, /hidden by hide \/r\/secret\.txt/);
    assert.equal(line.warn, true);
    const bare = shFacts(HOST_FACTS("p1"), null, { roots: ["/r"] });
    assert.equal(bare.paths[0].hiddenRule, "the hiding rule p1");
    assert.match(shCardLines(bare).find((l) => l.label === "Path 1").value, /hidden by the hiding rule p1/);
    const none = shFacts(HOST_FACTS(undefined), null, place);
    assert.equal("hiddenBy" in none.paths[0], false);
    assert.equal("hiddenRule" in none.paths[0], false);
});

// --- end to end: ml.sh.run through the worker against a fake host ---

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const row = (id, consumer, effect, source) => ({ id, scope: "global", consumer, effect, source, label: `${effect} ${source}`, origin: "person", created: 1760000000000 });
const ALLOW_SH = row("pol-allow-sh", "sh", "allow", "(c) => true");
const HIDE_SECRET = row("pol-hide-secret", "files", "hide", "/w/proj/secret.txt");
const runs = (argv) => () => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;
const valueOf = (result) => { const m = /^value: (.*)$/m.exec(result) ?? /^(\{.*\})$/m.exec(result); assert.ok(m, `no value in: ${result}`); return JSON.parse(m[1]); };

/** A fake host that takes the list and answers `paths[].hiddenBy` from it, as the real one does (last match decides). */
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
    return { asked, onStep: async (bg, ev) => { for (const a of ev.asks ?? []) if (a.state === "pending" && !asked.some((x) => x.id === a.id)) { asked.push(a); void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: false } }); } } };
}

test("ml.sh.run cat secret.txt with a hide rule: the spawn carries the list, the host names the hold, and the call ASKS despite an allow policy", T, async () => {
    const hh = hidingHost(), ask = answering();
    await runOn("userScripts", [runs(["cat", "secret.txt"])], { fetches: [], onNative: hh.onNative, configExtra: ON, onStep: ask.onStep, localExtra: { ml_policies_global: [ALLOW_SH, HIDE_SECRET] } });
    const spawns = hh.spawns();
    assert.ok(spawns.length >= 1);
    assert.deepEqual(spawns[0].args.hideList, [{ id: HIDE_SECRET.id, effect: "hide", pattern: "/w/proj/secret.txt" }]);
    assert.ok(ask.asked.length >= 1, "a call that names a hidden file ran without asking");
    assert.equal(hh.host.calls.filter((c) => c.call === "start").length, 0, "the call started although the person denied it");
});

test("positive control: the same call with no hide rule runs unasked under the same allow policy, with no hideList sent", T, async () => {
    const hh = hidingHost(), ask = answering();
    const { results } = await runOn("userScripts", [runs(["cat", "secret.txt"])], { fetches: [], onNative: hh.onNative, configExtra: ON, onStep: ask.onStep, localExtra: { ml_policies_global: [ALLOW_SH] } });
    assert.equal(valueOf(results[0]).ok, true, results[0].slice(0, 300));
    assert.equal(ask.asked.length, 0);
    assert.equal("hideList" in hh.spawns()[0].args, false);
});
