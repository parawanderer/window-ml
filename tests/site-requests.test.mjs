// site-requests.test.mjs — the rules for a site asking for access (src/site-requests.ts), and the registrable domain the
// caps count by (sw-access-requests.ts). Pure: no chrome, no worker.
import { test } from "node:test";
import assert from "node:assert/strict";

const { askAccess, answerRequest, settleByLists, expire, pendingRequests, readStore, REQUEST_TTL_MS, MAX_PENDING, REASON_MAX, ASK_REFUSED, REQUESTS_SCHEMA } = await import("../src/site-requests.ts");
const { getDomain } = await import("tldts");

const A = "https://a.example", B = "https://b.example";
const empty = () => ({ v: REQUESTS_SCHEMA, entries: [] });
const lists = (o = {}) => ({ always: [], session: [], denied: [], agents: {}, selfApprove: [], ...o });
const domainOf = (origin) => { const h = new URL(origin).hostname; return getDomain(h, { allowPrivateDomains: true }) ?? h; };
const facts = (origin, o = {}) => ({ origin, domain: domainOf(origin), gesture: true, sitesMayAsk: true, openedByAgent: false, now: 1_000_000, ...o });
const l0 = () => lists({ always: [A] });
const ask = (store, l, input, origin = A, f = {}) => askAccess(store, l, input, facts(origin, f));

// --- one entry per origin, and what a later call answers ---

test("the first ask makes one pending entry; every later ask from the origin answers its state and makes nothing", () => {
    const r1 = ask(empty(), lists(), { reason: "Summarise threads" });
    assert.deepEqual(r1.answer, { state: "pending" });
    assert.equal(r1.store.entries.length, 1);
    assert.equal(r1.created.reason, "Summarise threads");
    for (let i = 0; i < 1000; i++) {
        const r = ask(r1.store, lists(), { reason: `again ${i}` }, A, { now: 1_000_000 + i });
        assert.equal(r.store, r1.store, "nothing changes");
        assert.deepEqual(r.answer, { state: "pending" });
    }
});

test("a reason is trimmed and cut at 200 characters; one that is not a string is dropped", () => {
    assert.equal(ask(empty(), lists(), { reason: `  ${"x".repeat(500)}  ` }).created.reason.length, REASON_MAX);
    assert.equal("reason" in ask(empty(), lists(), { reason: { toString: () => "x" } }).created, false);
    assert.equal("reason" in ask(empty(), lists(), { reason: "   " }).created, false);
});

// --- a denial is final ---

test("a denied origin is answered denied at once, with no entry, whatever it asks", () => {
    for (const input of [{}, { agents: true }, { level: "self-approve" }]) {
        const r = ask(empty(), lists({ denied: [A], always: [A] }), input, A, { gesture: true });
        assert.deepEqual(r.answer, { state: "denied" });
        assert.equal(r.store.entries.length, 0);
    }
});

test("the person's Deny on a plain request denies the origin, and its next ask is answered denied", () => {
    const s = ask(empty(), lists(), {}).store;
    const d = answerRequest(s, lists(), A, { kind: "access", answer: "deny" }, 1_000_001);
    assert.deepEqual(d.edits, [{ op: "deny", origin: A }]);
    assert.deepEqual(ask(d.store, lists({ denied: [A] }), {}).answer, { state: "denied" });
    // Lifted in Settings ("Stop denying"): unknown again, but it asked once, so still denied, and no new entry.
    const again = ask(d.store, lists(), {});
    assert.deepEqual(again.answer, { state: "denied" });
    assert.equal(again.store, d.store);
});

// --- the caps ---

test("one pending entry per registrable domain: subdomains share one, github.io users and co.uk sites do not", () => {
    let s = ask(empty(), lists(), {}, "https://a.example.com").store;
    assert.deepEqual(ask(s, lists(), {}, "https://b.example.com").answer, { state: "refused", reason: ASK_REFUSED.full });
    assert.deepEqual(ask(s, lists(), {}, "http://example.com:8080").answer, { state: "refused", reason: ASK_REFUSED.full });
    s = empty();
    for (const o of ["https://alice.github.io", "https://bob.github.io", "https://shop.co.uk", "https://news.co.uk"]) {
        const r = ask(s, lists(), {}, o);
        assert.deepEqual(r.answer, { state: "pending" }, o);
        s = r.store;
    }
    assert.deepEqual(["https://alice.github.io", "https://bob.github.io", "https://shop.co.uk", "https://news.co.uk"].map(domainOf), ["alice.github.io", "bob.github.io", "shop.co.uk", "news.co.uk"]);
    assert.equal(domainOf("http://127.0.0.1:5123"), "127.0.0.1");
    assert.equal(domainOf("http://localhost:3000"), "localhost");
});

test("at most 5 pending in all; a sixth site is refused until one is answered or expires", () => {
    let s = empty();
    for (let i = 0; i < MAX_PENDING; i++) s = ask(s, lists(), {}, `https://s${i}.test${i}.com`).store;
    const sixth = "https://six.other.com";
    assert.deepEqual(ask(s, lists(), {}, sixth).answer, { state: "refused", reason: ASK_REFUSED.full });
    assert.equal(ask(s, lists(), {}, sixth).store, s, "a refusal stores nothing");
    s = answerRequest(s, lists(), "https://s0.test0.com", { kind: "access", answer: "deny" }, 1_000_001).store;
    assert.deepEqual(ask(s, lists(), {}, sixth).answer, { state: "pending" });
});

// --- expiry and the one re-ask ---

test("an entry nobody answers expires after 7 days; the origin may ask once more, never a third time", () => {
    const t0 = 1_000_000;
    let s = ask(empty(), lists(), {}, A, { now: t0 }).store;
    assert.deepEqual(ask(s, lists(), {}, A, { now: t0 + REQUEST_TTL_MS - 1 }).answer, { state: "pending" });
    assert.equal(pendingRequests(s, t0 + REQUEST_TTL_MS).length, 0, "not waiting once past its expiry");
    assert.equal(expire(s, t0 + REQUEST_TTL_MS).store.entries[0].state, "expired");
    const second = ask(s, lists(), {}, A, { now: t0 + REQUEST_TTL_MS });
    assert.deepEqual(second.answer, { state: "pending" });
    assert.equal(second.created.asks, 2);
    s = second.store;
    const third = ask(s, lists(), {}, A, { now: t0 + 2 * REQUEST_TTL_MS + 1 });
    assert.deepEqual(third.answer, { state: "denied" }, "asked twice: denied by default");
    assert.equal(third.store, s);
    assert.equal(s.entries.length, 1, "still one entry for the origin");
});

// --- the gesture, the setting, a page an agent opened ---

test("no gesture, the setting off, or a page a running agent opened: refused, and nothing is created", () => {
    assert.deepEqual(ask(empty(), lists(), {}, A, { gesture: false }).answer, { state: "refused", reason: ASK_REFUSED.gesture });
    assert.deepEqual(ask(empty(), lists(), {}, A, { sitesMayAsk: false }).answer, { state: "refused", reason: ASK_REFUSED.off });
    assert.deepEqual(ask(empty(), lists(), {}, A, { openedByAgent: true }).answer, { state: "refused", reason: ASK_REFUSED.openedByAgent });
    assert.deepEqual(ask(empty(), lists({ always: [A] }), { agents: true }, A, { gesture: false }).answer, { state: "refused", reason: ASK_REFUSED.gesture });
    // The setting is about sites that may not use window.ml: an allowed one may still ask for agents with it off.
    assert.deepEqual(ask(empty(), lists({ always: [A] }), { agents: true }, A, { sitesMayAsk: false }).answer, { state: "granted", agents: "pending" });
});

// --- agents, from a site that may use window.ml ---

test("an allowed site asking for agents: its level answers when it has one; otherwise one entry, answered pending", () => {
    for (const [level, agents] of [["ask", "granted"], ["always", "granted"], ["denied", "denied"]]) {
        const r = ask(empty(), lists({ always: [A], agents: { [A]: level } }), { agents: true });
        assert.deepEqual(r.answer, { state: "granted", agents }, level);
        assert.equal(r.store.entries.length, 0, `${level}: no entry`);
    }
    const r = ask(empty(), lists({ session: [A] }), { agents: true });
    assert.deepEqual(r.answer, { state: "granted", agents: "pending" });
    assert.equal(r.created.agents, true);
    assert.deepEqual(ask(r.store, lists({ session: [A] }), {}).answer, { state: "granted", agents: "pending" }, "a plain ask reads the agents entry");
    assert.deepEqual(ask(empty(), lists({ always: [A] }), {}).answer, { state: "granted", agents: "off" }, "no agents asked, none made");
});

test("answering an agents request: allowing sets the level to ask; denying sets it to denied; the entry is final", () => {
    const l = lists({ always: [A] });
    const s = ask(empty(), l, { agents: true }).store;
    assert.deepEqual(answerRequest(s, l, A, { kind: "access", answer: "agents" }, 1_000_001).edits, [{ op: "agents", origin: A, level: "ask" }]);
    const d = answerRequest(s, l, A, { kind: "access", answer: "deny" }, 1_000_001);
    assert.deepEqual(d.edits, [{ op: "agents", origin: A, level: "denied" }], "the site stays allowed");
    // Later set back to off by the person: answered once, so no new entry and no card.
    const later = ask(d.store, l, { agents: true });
    assert.deepEqual(later.answer, { state: "granted", agents: "off" });
    assert.equal(later.store, d.store);
});

test("a plain request that also asked for agents: Allow grants agents only with the box ticked", () => {
    const s = ask(empty(), lists(), { agents: true }).store;
    assert.deepEqual(answerRequest(s, lists(), A, { kind: "access", answer: "always" }, 1_000_001).edits, [{ op: "allow", origin: A, scope: "always" }]);
    assert.deepEqual(answerRequest(s, lists(), A, { kind: "access", answer: "session", agents: true }, 1_000_001).edits,
        [{ op: "allow", origin: A, scope: "session" }, { op: "agents", origin: A, level: "ask" }]);
});

// --- self-approval ---

test("self-approval: refused from a site not allowed; its own entry from an allowed one; Allow adds it, Deny is final", () => {
    assert.deepEqual(ask(empty(), lists(), { level: "self-approve" }).answer, { state: "refused", reason: ASK_REFUSED.first });
    assert.equal(ask(empty(), lists(), { level: "self-approve" }).store.entries.length, 0);
    const l = lists({ always: [A], agents: { [A]: "ask" } });
    const r = ask(empty(), l, { level: "self-approve", agents: true });
    assert.deepEqual(r.answer, { state: "pending" });
    assert.deepEqual([r.created.kind, r.created.agents], ["selfApprove", false]);
    assert.deepEqual(answerRequest(r.store, l, A, { kind: "selfApprove", answer: "allow" }, 1_000_001).edits, [{ op: "selfApprove", origin: A, on: true }]);
    const d = answerRequest(r.store, l, A, { kind: "selfApprove", answer: "deny" }, 1_000_001);
    assert.deepEqual(d.edits, [], "the site keeps what it had");
    assert.deepEqual(ask(d.store, l, { level: "self-approve" }).answer, { state: "denied" });
    assert.deepEqual(ask(empty(), lists({ selfApprove: [A] }), { level: "self-approve" }).answer, { state: "granted", agents: "granted" });
    // The two kinds are separate entries: an answered access entry does not block a self-approval one. A pending one
    // does, as any pending entry of the same registrable domain would.
    const agentsAsk = ask(empty(), l0(), { agents: true }).store;
    assert.deepEqual(ask(agentsAsk, l0(), { level: "self-approve" }, A, { now: 1_000_002 }).answer, { state: "refused", reason: ASK_REFUSED.full });
    const answered = answerRequest(agentsAsk, l0(), A, { kind: "access", answer: "agents" }, 1_000_002).store;
    const both = ask(answered, lists({ always: [A], agents: { [A]: "ask" } }), { level: "self-approve" }, A, { now: 1_000_003 });
    assert.deepEqual(both.answer, { state: "pending" });
    assert.equal(both.store.entries.length, 2);
});

// --- settled some other way, revoked, the store read back ---

test("a request the person settles elsewhere stops waiting: allowed, denied, given agents, revoked", () => {
    const s = ask(empty(), lists(), { agents: true }).store;
    assert.equal(settleByLists(s, lists({ always: [A] })).changed, false, "allowed but agents still off: still waiting for agents");
    assert.equal(settleByLists(s, lists({ always: [A], agents: { [A]: "ask" } })).changed, true);
    assert.equal(settleByLists(s, lists({ denied: [A] })).changed, true);
    const plain = ask(empty(), lists(), {}).store;
    assert.equal(settleByLists(plain, lists({ session: [A] })).store.entries[0].state, "answered");
    const self = ask(empty(), lists({ always: [A] }), { level: "self-approve" }).store;
    assert.equal(settleByLists(self, lists()).changed, true, "revoked: a self-approval request has nothing to stand on");
    assert.equal(settleByLists(self, lists({ always: [A] })).changed, false);
    // Allowed by Settings and then revoked: it asked once, so it is answered denied with no new entry.
    const allowed = settleByLists(plain, lists({ always: [A] })).store;
    assert.deepEqual(ask(allowed, lists(), {}).answer, { state: "denied" });
});

test("only a pending entry can be answered; an answer names its kind", () => {
    const s = ask(empty(), lists(), {}).store;
    assert.deepEqual(answerRequest(s, lists(), B, { kind: "access", answer: "always" }, 1_000_001).edits, []);
    assert.deepEqual(answerRequest(s, lists(), A, { kind: "selfApprove", answer: "allow" }, 1_000_001).edits, []);
    const once = answerRequest(s, lists(), A, { kind: "access", answer: "always" }, 1_000_001);
    assert.deepEqual(answerRequest(once.store, lists({ always: [A] }), A, { kind: "access", answer: "deny" }, 1_000_002).edits, [], "answered twice: the second is nothing");
    assert.deepEqual(answerRequest(s, lists(), A, { kind: "access", answer: "always" }, 1_000_000 + REQUEST_TTL_MS).edits, [], "expired");
});

test("the store read back: this build's layout is kept; an older, damaged or foreign value is an empty store", () => {
    // A fixture of what this build writes, as it sits in chrome.storage.local.
    const written = { v: 1, entries: [{ origin: A, domain: "a.example", kind: "access", agents: true, reason: "r", at: 5, state: "pending", asks: 1 }] };
    assert.deepEqual(readStore(JSON.parse(JSON.stringify(written))), written);
    for (const raw of [undefined, null, "x", [], { v: 2, entries: written.entries }, { entries: written.entries }, { v: 1, entries: "x" }]) {
        assert.deepEqual(readStore(raw), empty(), JSON.stringify(raw));
    }
    assert.deepEqual(readStore({ v: 1, entries: [{ origin: A }, null, written.entries[0]] }).entries, written.entries, "a malformed entry is dropped");
});

// --- every (entry state x levels x ask x facts): the invariants ---

test("enumerated: whatever the entry, levels, ask and facts, the rules hold", () => {
    const T0 = 10 * REQUEST_TTL_MS;
    const entryStates = [null, ["pending", 1, 0], ["pending", 1, REQUEST_TTL_MS], ["answered", 1, 0], ["expired", 1, 0], ["expired", 2, 0]];
    const levelSets = [
        lists(), lists({ always: [A] }), lists({ session: [A] }), lists({ denied: [A] }), lists({ denied: [A], always: [A] }),
        ...["ask", "always", "denied"].map((lv) => lists({ always: [A], agents: { [A]: lv } })), lists({ selfApprove: [A] }),
    ];
    const inputs = [{}, { agents: true }, { level: "self-approve" }, { level: "self-approve", agents: true }, { agents: "yes" }, { level: "admin" }];
    const factSets = [];
    for (const gesture of [true, false]) for (const sitesMayAsk of [true, false]) for (const openedByAgent of [true, false]) factSets.push({ gesture, sitesMayAsk, openedByAgent });
    let n = 0;
    for (const es of entryStates) for (const kind of ["access", "selfApprove"]) for (const l of levelSets) for (const input of inputs) for (const f of factSets) {
        const store = es ? { v: 1, entries: [{ origin: A, domain: "a.example", kind, agents: true, at: T0 - es[2], state: es[0], asks: es[1] }] } : empty();
        const r = askAccess(store, l, input, { ...facts(A, f), now: T0 });
        const label = JSON.stringify({ es, kind, l, input, f });
        n++;
        const denied = l.denied.includes(A);
        if (denied) assert.deepEqual(r.answer, { state: "denied" }, label);
        if (r.store !== store) {
            assert.ok(r.created, label);
            assert.ok(f.gesture && !f.openedByAgent && !denied, `created only with a gesture, not from an agent's page, not denied: ${label}`);
            assert.equal(r.store.entries.filter((e) => e.origin === A && e.kind === r.created.kind).length, 1, label);
            assert.ok(r.created.asks <= 2, label);
            const prior = store.entries.find((e) => e.kind === r.created.kind);
            assert.ok(!prior || prior.state === "expired" || (prior.state === "pending" && T0 - prior.at >= REQUEST_TTL_MS), `never over a live or answered entry: ${label}`);
            assert.ok(r.answer.state === "pending" || (r.answer.state === "granted" && r.answer.agents === "pending"), label);
            if (r.created.kind === "selfApprove") assert.ok(["always", "session"].includes(l.always.includes(A) ? "always" : l.session.includes(A) ? "session" : "x"), `self-approval only from an allowed origin: ${label}`);
        }
        assert.ok(["granted", "pending", "denied", "refused"].includes(r.answer.state), label);
        if (r.answer.state === "refused") assert.ok(Object.values(ASK_REFUSED).includes(r.answer.reason), label);
    }
    assert.ok(n > 2000, `enumerated ${n}`);
});
