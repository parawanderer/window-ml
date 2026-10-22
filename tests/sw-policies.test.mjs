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

test("an ALLOW that read a null fact does not decide the call, a DENY that did still refuses it (POLICIES.md, 2026-10-21)", () => {
    P.addRunPolicy("h-null", { consumer: "sh", effect: "allow", source: '(c) => c.argv[0] === "git" && !c.repoConfigRunsCode', label: "git", origin: "proposed" });
    const git = (repoConfigRunsCode) => ({ argv: ["git", "status"], repoConfigRunsCode, effects: [{ op: "exec", res: { kind: "process" } }] });
    assert.equal(P.judgeCall("h-null", "sh", git(false)).decision, "allow", "the control: the fact is known");
    assert.equal(P.judgeCall("h-null", "sh", git(null)).decision, undefined, "unknown: the call asks");
    P.addRunPolicy("h-null-deny", { consumer: "sh", effect: "deny", source: "(c) => c.repoConfigRunsCode !== false", label: "only a known-clean repo", origin: "person" });
    assert.equal(P.judgeCall("h-null-deny", "sh", git(null)).decision, "deny");
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

test("a stored policy over writes sees a names write: has(\"write\") and c.effects.writes both carry it (#786)", () => {
    // Universals over writes must not fail open for rm/mv/sed -i: the names write is a write, not an operation of its own.
    P.addRunPolicy("h-names", { consumer: "sh", effect: "deny", source: '(c) => c.effects.has("write")', label: "no writes", origin: "person" });
    P.addRunPolicy("h-names2", { consumer: "sh", effect: "allow", source: '(c) => c.effects.writes.every((r) => r.path.startsWith("/r/src/"))', label: "src only", origin: "person" });
    const rmTop = { argv: ["find", ".envrc", "-delete"], effects: [{ op: "write", res: { kind: "fs", path: "/r/.envrc", inRoot: true, secret: false, exists: true, topLevel: true, isRoot: false, names: true } }] };
    assert.equal(P.judgeCall("h-names", "sh", rmTop, "host-sandbox").decision, "deny", "a has(\"write\") deny fires for a names write");
    assert.notEqual(P.judgeCall("h-names2", "sh", rmTop, "host-sandbox").decision, "allow", "a writes-under-src allow does not cover a top-level names write");
});

// --- SHELL.md's name-immutable top level at the judge (2026-10-19): a name claim at the top level is not the builtin's allow ---

test("judgeCall: a shell call that claims a top-level name in a root is not the builtin's allow", () => {
    // Vector: git diff --output=.envrc claims a write to an ABSENT top-level entry and must run ASKED.
    const topLevelWrite = {
        argv: ["git", "diff", "--output=.envrc"],
        effects: [{ op: "write", res: { kind: "fs", path: "/r/.envrc", inRoot: true, secret: false, topLevel: true, exists: false } }],
    };
    const j = P.judgeCall("h-top", "sh", topLevelWrite, "host-sandbox");
    assert.notEqual(j.decision, "allow", "a write that creates a top-level name is never the built-in default's allow");
    assert.notEqual(j.by, "builtin", "…so it is never the builtin that allows it");
    // A write-names claim at the top level (sed -i, rm, mv over .envrc) asks the same way.
    const names = {
        argv: ["sed", "-i", "s/.*/pwned/", ".envrc"],
        // write-names projects onto a write marked names (#786), so has("write") and c.effects.writes still see it.
        effects: [{ op: "write", res: { kind: "fs", path: "/r/.envrc", inRoot: true, secret: false, topLevel: true, exists: true, names: true } }],
    };
    const jn = P.judgeCall("h-top", "sh", names, "host-sandbox");
    assert.notEqual(jn.decision, "allow", "a name operation at the top level is never the built-in default's allow");
    // Positive control: an in-place write to an existing top-level file stays free (the ruling's refinement).
    const inplace = {
        argv: ["sed", "-i", "s/.*/pwned/", ".envrc"],
        effects: [{ op: "write", res: { kind: "fs", path: "/r/.envrc", inRoot: true, secret: false, topLevel: true, exists: true } }],
    };
    const okInplace = P.judgeCall("h-top", "sh", inplace, "host-sandbox");
    assert.equal(okInplace.decision, "allow", "an in-place write to an existing top-level file is still free");
    assert.equal(okInplace.by, "builtin", "…and the builtin is what allows it");
    // Positive control: the same call writing below a top-level directory is the builtin's allow.
    const nested = { ...topLevelWrite, effects: [{ op: "write", res: { kind: "fs", path: "/r/src/a.ts", inRoot: true, secret: false, topLevel: false } }] };
    const ok = P.judgeCall("h-top", "sh", nested, "host-sandbox");
    assert.equal(ok.decision, "allow", "a write below a top-level directory is free under the OS sandbox");
    assert.equal(ok.by, "builtin", "…and the builtin is what allows it");
});

// --- why a call asks: the policy that used to cover it is gone (lane 9) ---

const allowUrl = (url) => ({ consumer: "fetch", effect: "allow", source: P.fetchUrlPolicySource(url), label: `fetch ${url}`, origin: "card" });

test("a call a REMOVED policy would have allowed asks with the cause removed, and the decision is the same as without it", () => {
    const p = P.addRunPolicy("h-lap-rm", allowUrl("https://rm.example/a"));
    assert.equal(P.judgeCall("h-lap-rm", "fetch", facts("https://rm.example/a")).decision, "allow");
    P.removePolicy(p.id);
    const j = P.judgeCall("h-lap-rm", "fetch", facts("https://rm.example/a"));
    assert.equal(j.decision, undefined);
    assert.equal(j.lapsed.cause, "removed");
    assert.equal(j.lapsed.id, p.id);
    assert.match(P.lapsedSentence(j.lapsed), /removed by the person/);
    assert.equal(P.judgeCall("h-lap-rm", "fetch", facts("https://rm.example/other")).lapsed, undefined, "a call it would not have covered gets no reason");
    assert.equal(P.judgeCall("h-lap-other", "fetch", facts("https://rm.example/a")).lapsed, undefined, "another run is not told about this one's policy");
});

test("an ARCHIVED session's call asks with the cause archived; deleting the session drops the reason", () => {
    P.addRunPolicy("h-lap-ar", allowUrl("https://ar.example/a"));
    P.forgetRunPolicies("h-lap-ar", "archived");
    const j = P.judgeCall("h-lap-ar", "fetch", facts("https://ar.example/a"));
    assert.equal(j.decision, undefined);
    assert.equal(j.lapsed.cause, "archived");
    P.forgetRunPolicies("h-lap-ar", "deleted");
    assert.equal(P.judgeCall("h-lap-ar", "fetch", facts("https://ar.example/a")).lapsed, undefined);
});

test("a NARROWED policy: the call it no longer covers asks with the cause narrowed; one it still covers still runs", () => {
    const p = P.addRunPolicy("h-lap-nar", { consumer: "fetch", effect: "allow", source: '(c) => c.host === "nar.example"', label: "nar.example", origin: "person" });
    P.editPolicy(p.id, { source: '(c) => c.url === "https://nar.example/keep"' });
    assert.equal(P.judgeCall("h-lap-nar", "fetch", facts("https://nar.example/keep")).decision, "allow");
    const j = P.judgeCall("h-lap-nar", "fetch", facts("https://nar.example/other"));
    assert.equal(j.decision, undefined);
    assert.equal(j.lapsed.cause, "narrowed");
    P.editPolicy(p.id, { label: "renamed" });
    assert.equal(P.judgeCall("h-lap-nar", "fetch", facts("https://nar.example/other")).lapsed.cause, "narrowed", "a label edit is not a narrowing and does not clear it");
});

test("a removed GLOBAL allow is the reason for every run; a removed deny needs none", () => {
    const g = P.addGlobalPolicy({ consumer: "fetch", effect: "allow", source: '(c) => c.host === "glob.example"', label: "glob" });
    const d = P.addGlobalPolicy({ consumer: "fetch", effect: "deny", source: '(c) => c.host === "den.example"', label: "den" });
    P.removePolicy(g.id); P.removePolicy(d.id);
    assert.equal(P.judgeCall("h-any", "fetch", facts("https://glob.example/")).lapsed.cause, "removed");
    assert.equal(P.judgeCall("h-any", "fetch", facts("https://den.example/")).lapsed, undefined);
});

test("a reason never re-allows: a decision other than ask carries none, and a live allow wins over a gone one", () => {
    const old = P.addRunPolicy("h-lap-live", allowUrl("https://live.example/a"));
    P.removePolicy(old.id);
    P.addRunPolicy("h-lap-live", allowUrl("https://live.example/a"));
    const j = P.judgeCall("h-lap-live", "fetch", facts("https://live.example/a"));
    assert.equal(j.decision, "allow");
    assert.equal(j.lapsed, undefined);
});

test("a gone policy that breaks is no reason, and the record is written to storage", () => {
    const p = P.addRunPolicy("h-lap-brk", { consumer: "fetch", effect: "allow", source: "(c) => c.nothing === 1", label: "typo", origin: "person" });
    P.removePolicy(p.id);
    assert.equal(P.judgeCall("h-lap-brk", "fetch", facts("https://x.example/")).lapsed, undefined);
    assert.ok(writes.at(-1).ml_policies_lapsed["h-lap-brk"], "kept in storage so a worker restart still knows");
});

test("a resumed session is told once that an archive took its run policies; a session that lost none is told nothing", () => {
    P.addRunPolicy("h-told", allowUrl("https://told.example/a"));
    P.forgetRunPolicies("h-told", "archived");
    const first = P.takeArchiveNotice("h-told");
    assert.match(first, /^window\.ml note \(from the extension, not from the person\)/);
    assert.match(first, /archived on .* run policies were removed .*fetch https:\/\/told\.example\/a/);
    assert.equal(P.takeArchiveNotice("h-told"), undefined, "once");
    assert.equal(writes.at(-1).ml_policies_archived["h-told"].told, true, "and not again after a worker restart");
    assert.equal(P.archivedPolicyLoss("h-told").labels.length, 1, "the resume note's record is kept");
    assert.equal(P.takeArchiveNotice("h-never"), undefined);
});

test("the run log keeps a lapsed record: its reason is the cause slug, never the sentence (the sanitizer drops a non-slug reason)", async () => {
    const { sanitizeRunReport } = await import("../src/log/run-log.ts");
    const rec = (reason) => sanitizeRunReport({ run: "a".repeat(64), subsystem: "policy", kind: "lapsed", reason, detail: { tool: "fetch_url", policy: "fetch https://a.example/" } });
    assert.equal(rec("removed")?.reason, "removed");
    assert.equal(rec("Asking because the policy was removed.")?.reason, undefined, "a sentence would be dropped");
});

// --- an `ask` policy: the third answer (POLICIES.md, "A policy may also answer ask") ---

const ANSWERS = ["deny", "ask", "allow", undefined];
/** Strictest first: deny, ask, allow, nothing. */
const strictest = (...as) => ANSWERS.find((a) => as.includes(a));
const PREC_URL = "https://prec.example/";
const precPolicy = (effect, url = PREC_URL) => ({ consumer: "fetch", effect, source: `(c) => c.url === ${JSON.stringify(url)}`, label: `prec ${effect}`, origin: "person" });
/** A fetch call the built-in default frees (no effects), and the same URL as a real fetch (never free). */
const FREE_FETCH = { kind: "fetch", url: PREC_URL, host: "prec.example", effects: [] };

test("precedence over every pair of {deny, ask, allow, none} across the global and the run's scope, with and without the built-in default", () => {
    let n = 0;
    for (const g of ANSWERS) for (const r of ANSWERS) for (const free of [false, true]) {
        const run = `h-prec-${n++}`;
        const added = [];
        if (g) added.push(P.addGlobalPolicy(precPolicy(g)));
        if (r) P.addRunPolicy(run, precPolicy(r));
        const j = P.judgeCall(run, "fetch", free ? FREE_FETCH : facts(PREC_URL));
        const want = strictest(g, r, free ? "allow" : undefined);
        const tag = `global ${g}, run ${r}, builtin ${free ? "free" : "none"}`;
        assert.equal(j.decision, want, tag);
        if (want === "ask" || want === "deny") assert.ok(j.by && j.by !== "builtin" && j.by.effect === want, `${tag}: the policy that decided is named`);
        if (want === "allow" && !g && !r) assert.equal(j.by, "builtin", tag);
        for (const a of added) P.removePolicy(a.id);
    }
    assert.equal(n, 32);
});

test("precedence among policies of ONE scope, in both orders: the strictest answer wins whatever the list order", () => {
    let n = 0;
    for (const a of ANSWERS.filter(Boolean)) for (const b of ANSWERS.filter(Boolean)) for (const free of [false, true]) {
        const run = `h-prec2-${n++}`;
        P.addRunPolicy(run, { ...precPolicy(a), label: "first" });
        P.addRunPolicy(run, { ...precPolicy(b), label: "second", source: `(c) => c.url === ${JSON.stringify(PREC_URL)} || false` });
        const j = P.judgeCall(run, "fetch", free ? FREE_FETCH : facts(PREC_URL));
        assert.equal(j.decision, strictest(a, b), `${a} then ${b}`);
    }
});

test("a deny and an ask that both match: the deny wins, and the ask never turns a refusal into a card", () => {
    P.addRunPolicy("h-da", precPolicy("ask"));
    P.addGlobalPolicy({ ...precPolicy("deny"), label: "d" });
    const j = P.judgeCall("h-da", "fetch", facts(PREC_URL));
    assert.equal(j.decision, "deny");
    assert.equal(j.by.label, "d");
    for (const p of P.globalPolicies().filter((x) => x.label === "d")) P.removePolicy(p.id);
});

test("an ask beats a remembered allow (a card's \"remember\"), a stored allow and the built-in default, and it carries the policy", () => {
    P.rememberFetchUrls("h-rem", [PREC_URL]);
    assert.equal(P.judgeCall("h-rem", "fetch", facts(PREC_URL)).decision, "allow", "the control: the remembered URL runs");
    const a = P.addRunPolicy("h-rem", precPolicy("ask"));
    const j = P.judgeCall("h-rem", "fetch", facts(PREC_URL));
    assert.equal(j.decision, "ask");
    assert.equal(j.by.id, a.id);
    assert.equal(P.judgeCall("h-rem", "fetch", FREE_FETCH).decision, "ask", "and the built-in default");
    P.removePolicy(a.id);
    assert.equal(P.judgeCall("h-rem", "fetch", facts(PREC_URL)).decision, "allow", "removed, the allow runs again");
});

test("an ask asks only about what it matches, and only for its own consumer and run", () => {
    P.addRunPolicy("h-scope", precPolicy("ask"));
    assert.equal(P.judgeCall("h-scope", "fetch", facts("https://other.example/")).decision, undefined);
    assert.equal(P.judgeCall("h-other-run", "fetch", facts(PREC_URL)).decision, undefined);
    assert.equal(P.judgeCall(undefined, "fetch", facts(PREC_URL)).decision, undefined);
    assert.equal(P.judgeCall("h-scope", "sh", { argv: ["ls"], url: PREC_URL, effects: [] }).decision, "allow", "an ask over fetch never asks about sh");
});

test("an ASK that read a null fact still fires, as a DENY does; an ALLOW over the same fact does not (rule 1, the narrow direction)", () => {
    const git = (repoConfigRunsCode) => ({ argv: ["git", "status"], repoConfigRunsCode, effects: [{ op: "exec", res: { kind: "process" } }] });
    const src = '(c) => c.argv[0] === "git" && !c.repoConfigRunsCode';
    P.addRunPolicy("h-null-ask", { consumer: "sh", effect: "ask", source: src, label: "git asks", origin: "person" });
    assert.equal(P.judgeCall("h-null-ask", "sh", git(false)).decision, "ask", "known fact: fires");
    assert.equal(P.judgeCall("h-null-ask", "sh", git(null)).decision, "ask", "unknown: fires too");
    P.addRunPolicy("h-null-allow", { consumer: "sh", effect: "allow", source: src, label: "git allows", origin: "person" });
    assert.equal(P.judgeCall("h-null-allow", "sh", git(null)).decision, undefined, "the control: an allow over null is no opinion");
    // Both stored: the ask fires on the null, so the call asks rather than runs.
    P.addRunPolicy("h-null-allow", { consumer: "sh", effect: "ask", source: src, label: "git asks", origin: "person" });
    assert.equal(P.judgeCall("h-null-allow", "sh", git(null)).decision, "ask");
});

test("over an undescribed call (effects: unknown) an ask that needs a resource's field does not fire, one that tests an absence does", () => {
    const unknownCall = { argv: ["rm", "x"], effects: "unknown" };
    // Needs a field of a resource to hold: unknown has no such resource, so the policy is silent and the call asks anyway.
    P.addRunPolicy("h-unk-field", { consumer: "sh", effect: "ask", source: "(c) => c.effects.writes.some((r) => r.inRoot === true)", label: "writes in a root", origin: "person" });
    const field = P.judgeCall("h-unk-field", "sh", unknownCall, "host-sandbox");
    assert.equal(field.decision, undefined, "no opinion: the policy did not fire");
    assert.equal(field.broken.length, 0, "and it is not broken");
    // Tests an absence ("no secret is written"): unknown cannot show one, so the ask fires.
    P.addRunPolicy("h-unk-abs", { consumer: "sh", effect: "ask", source: "(c) => c.effects.writes.every((r) => !r.secret)", label: "no secret write", origin: "person" });
    const abs = P.judgeCall("h-unk-abs", "sh", unknownCall, "host-sandbox");
    assert.equal(abs.decision, "ask");
    assert.equal(abs.by.label, "no secret write");
    // The same two as allows: neither runs the call.
    P.addRunPolicy("h-unk-allow", { consumer: "sh", effect: "allow", source: "(c) => c.effects.writes.every((r) => !r.secret)", label: "allow", origin: "person" });
    assert.notEqual(P.judgeCall("h-unk-allow", "sh", unknownCall, "host-sandbox").decision, "deny");
});

test("a broken ask is no opinion, recorded as broken, and does not stop the others; the call still asks where nothing frees it", () => {
    const b = P.addRunPolicy("h-bask", { consumer: "fetch", effect: "ask", source: "(c) => c.hots === 1", label: "typo ask", origin: "person" });
    const j = P.judgeCall("h-bask", "fetch", facts("https://x.example/"));
    assert.equal(j.decision, undefined, "no opinion: a fetch is never free, so the tiers above decide, which is the card");
    assert.equal(j.broken.length, 1);
    assert.match(P.brokenReason(b.id), /no field 'hots'/);
    P.addRunPolicy("h-bask", { consumer: "fetch", effect: "deny", source: '(c) => c.host === "x.example"', label: "deny x", origin: "person" });
    assert.equal(P.judgeCall("h-bask", "fetch", facts("https://x.example/")).decision, "deny", "a live deny still decides past it");
});

test("an edit may make a policy an ask, and an ask back into an allow; the edit that narrows an allow is reasoned as narrowed", () => {
    const p = P.addRunPolicy("h-edit-ask", { ...precPolicy("allow"), label: "editable" });
    assert.equal(P.judgeCall("h-edit-ask", "fetch", facts(PREC_URL)).decision, "allow");
    const e = P.editPolicy(p.id, { effect: "ask" });
    assert.equal(e.effect, "ask");
    assert.equal(P.judgeCall("h-edit-ask", "fetch", facts(PREC_URL)).decision, "ask");
    P.editPolicy(p.id, { effect: "allow" });
    assert.equal(P.judgeCall("h-edit-ask", "fetch", facts(PREC_URL)).decision, "allow");
    P.editPolicy(p.id, { effect: "ask" });
    P.removePolicy(p.id);
    const j = P.judgeCall("h-edit-ask", "fetch", facts(PREC_URL));
    assert.equal(j.decision, undefined);
    assert.equal(j.lapsed?.cause, "narrowed", "allow to ask is a narrowing: the allow's source is remembered as lapsed");
    assert.equal(P.lapsedLine(j.lapsed), 'Asking because the policy "editable" was edited and no longer covers this call.');
});

test("a removed ask leaves no lapsed reason (it allowed nothing), and an added one is on the policy page and in what the model reads", () => {
    const own = "https://own.example/";   // a URL no allow in the file above ever covered, so no other reason is in play
    const a = P.addGlobalPolicy({ ...precPolicy("ask", own), label: "listed ask" });
    assert.ok(P.policyView().global.some((p) => p.id === a.id && p.effect === "ask"));
    assert.ok(P.policiesForModel("h-x").some((p) => p.effect === "ask" && p.label === "listed ask"));
    P.removePolicy(a.id);
    assert.equal(P.judgeCall("h-x", "fetch", facts(own)).lapsed, undefined);
});

test("askWhyOf names the ask policy for the card and the model, says nothing for an unloaded or unanswered call, and speaks a hostile label safely", () => {
    const own = "https://why.example/";
    const a = P.addRunPolicy("h-why", { ...precPolicy("ask", own), label: 'evil "x" \nsecond line' });
    const why = P.askWhyOf(P.judgeCall("h-why", "fetch", facts(own)));
    assert.equal(why.cause, P.ASK_POLICY_CAUSE);
    assert.ok(P.askedByPolicy(why));
    assert.match(why.line, /^Asking because the policy "evil 'x' second line" asks about calls like this\.$/);
    assert.match(why.detail, /asks the person about calls like it; the call itself did not change/);
    assert.equal(why.policy, "evil 'x' second line");
    assert.equal(P.askWhyOf(P.judgeCall("h-why-none", "fetch", facts(own))), undefined, "no policy involved: no reason");
    assert.equal(P.askWhyOf({ decision: "ask", broken: [] }), undefined, "an unloaded store names no policy");
    assert.equal(P.askedByPolicy({ line: "", detail: "", cause: "removed" }), false);
    P.removePolicy(a.id);
});

test("an ask never allows: no combination with a matching ask returns allow, whatever else holds", () => {
    for (const eff of ["allow", "deny", "ask"]) for (const free of [false, true]) {
        const run = `h-never-${eff}-${free}`;
        P.addRunPolicy(run, precPolicy("ask"));
        P.addRunPolicy(run, { ...precPolicy(eff), source: `(c) => c.url === ${JSON.stringify(PREC_URL)} && true` });
        assert.notEqual(P.judgeCall(run, "fetch", free ? FREE_FETCH : facts(PREC_URL)).decision, "allow", `${eff}, free ${free}`);
    }
});
