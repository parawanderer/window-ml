// sw-policies.test.mjs — the policy store (src/sw/sw-policies.ts, docs/spec/POLICIES.md): the order a call is judged
// in (deny wins across scopes, a broken policy is no opinion, the built-in default last), what "Approve + remember"
// adds, removal and a session's deletion, and what is read back from storage (only well-formed policies).
import { test } from "node:test";
import assert from "node:assert/strict";

// Storage as a previous worker left it, read at module load: one well-formed global policy and assorted junk.
const STORED = {
    ml_policies_global: [
        { id: "g-ok", scope: "global", consumer: "fetch", effect: "deny", source: '(c) => c.host === "blocked.example"', label: "never blocked.example", origin: "person", created: 1 },
        { id: "g-bad-effect", scope: "global", consumer: "fetch", effect: "maybe", source: "(c) => true", label: "x", origin: "person", created: 1 },
        { id: "g-sh", scope: "global", consumer: "sh", effect: "allow", source: '(c) => c.argv[0] === "ls"', label: "ls", origin: "person", created: 1 },
        { id: "g-unknown-consumer", scope: "global", consumer: "mail", effect: "allow", source: "(c) => true", label: "x", origin: "person", created: 1 },
        { id: "g-wrong-scope", scope: "run", consumer: "fetch", effect: "allow", source: "(c) => true", label: "x", origin: "person", created: 1 },
        "not a policy",
    ],
    ml_policies_run: {
        "h-old": [{ id: "r-ok", scope: "run", consumer: "fetch", effect: "allow", source: '(c) => c.url === "https://a.example/x"', label: "fetch https://a.example/x", origin: "card", created: 1 }],
        "h-junk": "not a list",
    },
};
const writes = [];
globalThis.chrome = {
    storage: { local: {
        get: async () => structuredClone(STORED),
        set: async (o) => { writes.push(structuredClone(o)); },
    } },
};
const P = await import("../src/sw/sw-policies.ts");
await P.policiesReady;

const facts = (url) => P.fetchFacts(url);

// --- what storage held is read back, and only what is well-formed ---

test("only well-formed policies of the right scope are read back from storage; junk is dropped, never guessed at", () => {
    assert.deepEqual(P.globalPolicies().map((p) => p.id), ["g-ok", "g-sh"], "an unknown consumer is dropped too");
    assert.deepEqual(P.runPolicies("h-old").map((p) => p.id), ["r-ok"]);
    assert.deepEqual(P.runPolicies("h-junk"), []);
});

// --- the order a call is judged in ---

test("a run policy allows the call it names, and nothing else", () => {
    assert.equal(P.judgeCall("h-old", "fetch", facts("https://a.example/x")).decision, "allow");
    assert.equal(P.judgeCall("h-old", "fetch", facts("https://a.example/y")).decision, undefined);
    assert.equal(P.judgeCall("h-other", "fetch", facts("https://a.example/x")).decision, undefined, "another run does not get it");
    assert.equal(P.judgeCall(undefined, "fetch", facts("https://a.example/x")).decision, undefined, "nor does a call no run made");
});

test("deny wins over allow across scopes: a global deny refuses what a run policy allows", () => {
    P.addRunPolicy("h-deny", { consumer: "fetch", effect: "allow", source: '(c) => c.host === "blocked.example"', label: "allow blocked", origin: "card" });
    const j = P.judgeCall("h-deny", "fetch", facts("https://blocked.example/z"));
    assert.equal(j.decision, "deny");
    assert.equal(j.by.id, "g-ok");
});

test("a broken policy is no opinion, reported with its reason, and does not stop the others from deciding", () => {
    const broken = P.addRunPolicy("h-broken", { consumer: "fetch", effect: "allow", source: "(c) => c.uurl === 1", label: "typo", origin: "person" });
    P.addRunPolicy("h-broken", { consumer: "fetch", effect: "allow", source: '(c) => c.url === "https://ok.example/"', label: "ok", origin: "person" });
    const j = P.judgeCall("h-broken", "fetch", facts("https://ok.example/"));
    assert.equal(j.decision, "allow");
    assert.equal(j.by.label, "ok");
    assert.equal(j.broken.length, 1);
    assert.match(j.broken[0].reason, /no field 'uurl'/);
    assert.match(P.brokenReason(broken.id), /no field 'uurl'/, "kept for the policy page");
});

test("a broken DENY does not refuse and does not allow: the call asks", () => {
    P.addRunPolicy("h-bdeny", { consumer: "fetch", effect: "deny", source: "(c) => c.hots === 1", label: "typo deny", origin: "person" });
    const j = P.judgeCall("h-bdeny", "fetch", facts("https://x.example/"));
    assert.equal(j.decision, undefined);
    assert.equal(j.broken.length, 1);
});

test("with no person's answer the built-in default decides: a fetch reaches the network, so it is never free", () => {
    const j = P.judgeCall("h-none", "fetch", facts("https://x.example/"));
    assert.equal(j.decision, undefined);
    assert.equal(j.by, undefined);
});

test("the built-in default allows a call whose effects are inside the bound, and a person's deny still wins over it", () => {
    const pure = { kind: "fetch", url: "cache", host: "", effects: [] };
    assert.equal(P.judgeCall("h-none", "fetch", pure).by, "builtin");
    assert.equal(P.judgeCall("h-none", "fetch", pure).decision, "allow");
    P.addRunPolicy("h-pure-deny", { consumer: "fetch", effect: "deny", source: '(c) => c.url === "cache"', label: "no cache", origin: "person" });
    assert.equal(P.judgeCall("h-pure-deny", "fetch", pure).decision, "deny");
});

// --- "Approve + remember" ---

test("remembering URLs makes one exact-URL policy each, de-duplicated, whose source is the literal the person saw", () => {
    const tricky = 'https://a.example/q?x="1"&y=\\';
    const made = P.rememberFetchUrls("h-rem", ["https://a.example/1", tricky, "https://a.example/1"]);
    assert.equal(P.runPolicies("h-rem").length, 2);
    assert.equal(made[0].id, made[2].id);
    assert.equal(P.judgeCall("h-rem", "fetch", facts(tricky)).decision, "allow", "a URL with quotes and a backslash is one literal");
    assert.equal(P.judgeCall("h-rem", "fetch", facts("https://a.example/1?")).decision, undefined, "exact, not a prefix");
    assert.equal(P.runPolicies("h-rem")[0].origin, "card");
});

test("a remembered URL is a fact the person saw: a URL that tries to break out of the literal stays a literal", () => {
    const evil = 'x" || true || "';
    P.rememberFetchUrls("h-inj", [evil]);
    assert.equal(P.judgeCall("h-inj", "fetch", facts("https://anything.example/")).decision, undefined);
});

// --- removal, and a session's deletion ---

test("a removed policy stops deciding at once, from whichever scope held it", () => {
    const [p] = P.rememberFetchUrls("h-rm", ["https://rm.example/"]);
    assert.equal(P.judgeCall("h-rm", "fetch", facts("https://rm.example/")).decision, "allow");
    assert.equal(P.removePolicy(p.id), true);
    assert.equal(P.judgeCall("h-rm", "fetch", facts("https://rm.example/")).decision, undefined);
    assert.equal(P.removePolicy(p.id), false);
});

test("a deleted session's run policies go with it, and are written away", () => {
    P.rememberFetchUrls("h-del", ["https://del.example/"]);
    const before = writes.length;
    P.forgetRunPolicies("h-del");
    assert.deepEqual(P.runPolicies("h-del"), []);
    assert.ok(writes.length > before);
    assert.ok(!("h-del" in writes.at(-1).ml_policies_run));
});

test("an ARCHIVED session loses its run policies and the loss is recorded with the time; a DELETED one leaves no record", () => {
    P.rememberFetchUrls("h-arch", ["https://arch.example/"]);
    P.forgetRunPolicies("h-arch", "archived");
    assert.deepEqual(P.runPolicies("h-arch"), []);
    assert.equal(P.judgeCall("h-arch", "fetch", facts("https://arch.example/")).decision, undefined, "it no longer allows");
    const lost = P.archivedPolicyLoss("h-arch");
    assert.deepEqual(lost.labels, ["fetch https://arch.example/"]);
    assert.ok(Math.abs(lost.at - Date.now()) < 5000);
    const cur = P.withPolicies({}, "h-arch");
    assert.deepEqual(cur.policiesRemoved.labels, ["fetch https://arch.example/"], "the model is told");
    assert.match(cur.policiesRemoved.at, /^\d{4}-\d\d-\d\dT/);
    assert.ok(writes.at(-1).ml_policies_archived["h-arch"], "and it is kept in storage");
    P.forgetRunPolicies("h-arch", "deleted");
    assert.equal(P.archivedPolicyLoss("h-arch"), undefined, "a deleted session takes its record with it");
    P.forgetRunPolicies("h-nothing", "archived");
    assert.equal(P.archivedPolicyLoss("h-nothing"), undefined, "a session that had none lost none");
});

test("an edit changes a policy in place, keeps its id and scope, and refuses an effect that is not allow or deny", () => {
    const g = P.addGlobalPolicy({ consumer: "fetch", effect: "allow", source: "(c) => false", label: "g" });
    const e = P.editPolicy(g.id, { source: '(c) => c.host === "edit.example"', effect: "maybe", label: "edited" });
    assert.equal(e.id, g.id);
    assert.equal(e.scope, "global");
    assert.equal(e.effect, "allow", "an effect that is no effect is ignored");
    assert.equal(P.judgeCall(undefined, "fetch", facts("https://edit.example/")).decision, "allow");
    assert.equal(P.editPolicy("no-such-id", { label: "x" }), undefined);
    P.removePolicy(g.id);
});

test("every change tells the listeners, which is how a card already showing is judged again", () => {
    let n = 0;
    const off = P.onPoliciesChanged(() => n++);
    const g = P.addGlobalPolicy({ consumer: "fetch", effect: "deny", source: "(c) => false", label: "l" });
    P.editPolicy(g.id, { label: "l2" });
    P.removePolicy(g.id);
    P.rememberFetchUrls("h-listen", ["https://l.example/"]);
    P.forgetRunPolicies("h-listen");
    off();
    P.addGlobalPolicy({ consumer: "fetch", effect: "deny", source: "(c) => false", label: "after" });
    assert.equal(n, 5);
});

test("the policy page's view lists the global policies, each session's, the built-in default and why any broke", () => {
    P.addRunPolicy("h-view", { consumer: "fetch", effect: "allow", source: "(c) => c.nope", label: "broken one", origin: "person" });
    P.judgeCall("h-view", "fetch", facts("https://v.example/"));
    const v = P.policyView();
    const run = v.runs.find((r) => r.hash === "h-view");
    assert.equal(run.policies[0].label, "broken one");
    assert.match(v.broken[run.policies[0].id], /no field 'nope'/);
    assert.match(v.builtin.source, /free/);
    assert.ok(v.global.length >= 1);
});

test("what the model reads lists the global and the run's policies, as written", () => {
    const seen = P.policiesForModel("h-old");
    const rows = seen.map((p) => `${p.scope} ${p.effect} ${p.label}`);
    for (const want of ["global deny never blocked.example", "global allow ls", "run allow fetch https://a.example/x"]) assert.ok(rows.includes(want), want);
    assert.equal(rows.at(-1), "run allow fetch https://a.example/x", "the run's own come after the global ones");
    assert.deepEqual(Object.keys(P.withPolicies({ a: 1 }, "h-old")).sort(), ["a", "policies"]);
});

test("once storage has been read, the store says so", () => {
    assert.equal(P.policiesLoaded(), true);
});

// --- consumers ---

test("a policy is evaluated only over calls of its own consumer: an sh policy never decides a fetch, nor a fetch policy an sh call", () => {
    P.addRunPolicy("h-cons", { consumer: "sh", effect: "deny", source: "(c) => true", label: "no shell", origin: "person" });
    assert.equal(P.judgeCall("h-cons", "fetch", facts("https://a.example/")).decision, undefined);
    P.addRunPolicy("h-cons2", { consumer: "fetch", effect: "deny", source: "(c) => true", label: "no fetch", origin: "person" });
    const sh = { argv: ["git", "status"], effects: [{ op: "exec", res: { kind: "process" } }] };
    assert.equal(P.judgeCall("h-cons2", "sh", sh).decision, undefined);
    assert.equal(P.judgeCall("h-cons", "sh", sh).decision, "deny");
});

test("the policy page re-reads on exactly the keys the store writes (it keeps its own copy, not importing worker code)", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../src/sidebar/settings/settings.tsx", import.meta.url), "utf8");
    const keys = JSON.parse(page.match(/const POLICY_STORAGE_KEYS = (\[[^\]]*\])/)[1]);
    assert.deepEqual(keys.sort(), [P.GLOBAL_POLICIES_KEY, P.RUN_POLICIES_KEY, P.ARCHIVED_POLICIES_KEY].sort());
});

test("policies are kept in local storage, never sync", () => {
    assert.ok(writes.length > 0);
    assert.ok(!globalThis.chrome.storage.sync, "the store never reached for sync");
});

// --- SHELL.md's name-immutable top level at the judge (2026-10-19): a top-level write is not the builtin's allow ---

test("judgeCall: a shell call that claims a top-level write in a root is not the builtin's allow", { todo: "OPEN (SHELL.md name-immutable top level, 2026-10-19): free() treats any in-root fs effect as covered by write(fs(roots)), so a call that creates .envrc / .mcp.json / .vscode/ at a root's top level is judged allow/builtin and runs UNASKED. With the narrow write envelope absent from HostSpawn and protectedChanged absent from HostDone, nothing refuses the write and nothing reports it. The host's narrow envelope (window-ml-host #12) would fail the write as ok:false; the extension's half of the rule is not implemented. What holds instead: a write OUTSIDE the roots or to a secret-flagged path asks, and unknown effects always ask." }, () => {
    const topLevelWrite = {
        argv: ["git", "diff", "--output=.envrc"],
        effects: [{ op: "write", res: { kind: "fs", path: "/r/.envrc", inRoot: true, secret: false, topLevel: true } }],
    };
    const j = P.judgeCall("h-top", "sh", topLevelWrite, "host-sandbox");
    assert.notEqual(j.decision, "allow", "a top-level write is never the built-in default's allow");
    assert.notEqual(j.by, "builtin", "…so it is never the builtin that allows it");
    // Positive control: the same call writing below a top-level directory is the builtin's allow.
    const nested = { ...topLevelWrite, effects: [{ op: "write", res: { kind: "fs", path: "/r/src/a.ts", inRoot: true, secret: false, topLevel: false } }] };
    const ok = P.judgeCall("h-top", "sh", nested, "host-sandbox");
    assert.equal(ok.decision, "allow", "a write below a top-level directory is free under the OS sandbox");
    assert.equal(ok.by, "builtin", "…and the builtin is what allows it");
});
