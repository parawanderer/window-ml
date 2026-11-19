// propose-policy-setting.test.mjs — `propose_policy` rows of consumer `setting`: what the measure says a rule covers, what is
// refused before any card, the shared step budget, and the card's note (src/sw/policy-proposal.ts,
// docs/spec/MODEL_SETTINGS.md, "Proposing a `setting` policy"). The pure measure is called directly; the judge after an
// approval runs in the real background bundle (node:vm), scripted as tests/propose-policy.test.mjs does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const PP = await import("../src/sw/policy-proposal.ts");
const { DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");
const { SETTING_CLASSES, modelWritable } = await import("../src/setting-class.ts");
const { evalPolicy } = await import("../src/readonly-exec/policy-realm.ts");

const T = { timeout: 60000 };
const DEPS = { config: { ...DEFAULT_CONFIG }, modelIds: ["m-a", "m-b", "m-c"] };
const NO_LIST = { config: { ...DEFAULT_CONFIG }, modelIds: null };
const prop = (when, over = {}) => {
    const r = PP.checkProposal({ consumer: "setting", effect: "allow", when, label: "Only Theme", ...over });
    assert.ok(r.proposal, `the proposal was refused: ${r.error}`);
    return r.proposal;
};
const measure = (when, over, deps = DEPS, called = []) => PP.measureSettingBreadth(prop(when, over), deps, called);
const key = (b, k) => b.keys.find((x) => x.key === k);
const matchedKeys = (b) => b.keys.filter((x) => x.matched > 0).map((x) => x.key);
const note = (when, over, deps = DEPS, called = []) => { const p = prop(when, over); return PP.settingBreadthNote(p, PP.measureSettingBreadth(p, deps, called)); };
const writable = Object.keys(SETTING_CLASSES).filter((k) => ["ordinary", "guarded"].includes(SETTING_CLASSES[k].class) && modelWritable(k));

/** A rule that spends about `n` loop iterations on every evaluation, then answers `c.key === "theme"`. */
const spender = (n) => `(c) => { let s = 0; for (const x of ${JSON.stringify("x".repeat(n))}) { s = s + 1; } return c.key === "theme"; }`;
/** The steps a measure of `when` spends of the shared budget. */
const stepsOf = (when, effect = "allow") => { const budget = { left: 1e12 }; PP.measureSettingBreadth(prop(when, { effect }), DEPS, [], budget); return 1e12 - budget.left; };
/** The loop length whose measure spends about `share` of SETTING_MEASURE_STEPS, from two calibration measures. */
function nFor(share) {
    const a = stepsOf(spender(0)), b = stepsOf(spender(20));
    const perIter = (b - a) / 20;   // total steps per extra iteration, over the whole measure
    return Math.max(0, Math.round((share * PP.SETTING_MEASURE_STEPS - a) / perIter));
}

// --- the measure: what a rule covers ---

test("(c) => c.key === \"theme\" covers Theme at every value, exactly, and no other key", () => {
    const b = measure('(c) => c.key === "theme"');
    const t = key(b, "theme");
    assert.equal(PP.settingCover(t), "every");
    assert.equal(t.sampled, false, "an enum key is exact");
    assert.deepEqual(matchedKeys(b), ["theme"]);
    assert.ok(b.keys.every((k) => k.key === "theme" || k.matched === 0));
    assert.equal(b.exhausted, false);
    assert.match(note('(c) => c.key === "theme"'), /^It covers: Theme \(every value\)\./);
});

test("(c) => true leads with \"every setting the agent may change\", and an allow lists the guarded keys apart", () => {
    const n = note("(c) => true");
    assert.match(n, /^It covers every setting the agent may change/);
    const guarded = writable.filter((k) => SETTING_CLASSES[k].class === "guarded");
    assert.ok(guarded.length > 0);
    assert.match(n, /always ask whatever a policy says: /);
    const apart = /always ask whatever a policy says: (.*?)\. (?:Proposed|Of the)/.exec(n)[1];
    assert.equal(apart.split(", ").length, guarded.length, "every guarded key is named in the aside");
    // a deny lists guarded keys with the rest, with no aside
    const d = note("(c) => true", { effect: "deny" });
    assert.ok(!/always ask whatever/.test(d));
});

test("one enum word reports \"some values\"", () => {
    const b = measure('(c) => c.key === "theme" && c.to === "dark"');
    assert.equal(PP.settingCover(key(b, "theme")), "some");
    assert.match(note('(c) => c.key === "theme" && c.to === "dark"'), /Theme \(some values\)/);
});

test("`from` is varied: a rule on a key's stored value alone still reports that key", () => {
    const cur = DEFAULT_CONFIG.cardCorner;
    const when = `(c) => c.key === "theme" || (c.key === "cardCorner" && c.from !== ${JSON.stringify(cur)})`;
    const b = measure(when);
    assert.ok(key(b, "cardCorner").matched > 0, "Card corner is covered");
    assert.deepEqual(matchedKeys(b).sort(), ["cardCorner", "theme"]);
    assert.match(note(when), /Theme.*Card corner|Card corner.*Theme/);
});

// --- exactness by enumeration ---

test("every boolean and enum key is measured over all its (from, to) pairs and a rule on it alone covers it \"every\"", () => {
    let seen = 0;
    for (const k of writable) {
        const d = SETTING_CLASSES[k];
        if (d.class !== "ordinary" || !["boolean", "enum"].includes(d.domain.kind)) continue;
        const n = d.domain.kind === "boolean" ? 2 : d.domain.words.length;
        const b = measure(`(c) => c.key === ${JSON.stringify(k)}`);
        const r = key(b, k);
        assert.equal(r.tried, n * (n - 1), `${k}: ${n} values`);
        assert.equal(r.matched, r.tried, k);
        assert.equal(r.sampled, false, k);
        assert.equal(PP.settingCover(r), "every", k);
        assert.deepEqual(matchedKeys(b), [k], `${k} matched another key`);
        seen++;
    }
    assert.ok(seen >= 10, `only ${seen} boolean or enum keys were enumerated`);
});

test("every integer key with a max and a range within SETTING_ENUMERATE_MAX has every `to` tried", () => {
    let seen = 0;
    for (const k of writable) {
        const d = SETTING_CLASSES[k];
        if (d.class !== "ordinary" || d.domain.kind !== "number" || !d.domain.integer || d.domain.max === undefined) continue;
        const { min, max } = d.domain;
        if (max - min + 1 > PP.SETTING_ENUMERATE_MAX) continue;
        for (let v = min; v <= max; v++) {
            const b = measure(`(c) => c.key === ${JSON.stringify(k)} && c.to === ${v}`);
            assert.ok(key(b, k).matched > 0, `${k}: to ${v} was never tried`);
            assert.equal(PP.settingCover(key(b, k)), "some", `${k} ${v}`);
        }
        seen++;
    }
    assert.ok(seen >= 1);
});

test("a bounded number: c.to === one value reports \"some values\"", () => {
    const when = '(c) => c.key === "detachedTaskMaxMin" && c.to === 7';
    const b = measure(when);
    assert.equal(PP.settingCover(key(b, "detachedTaskMaxMin")), "some");
    assert.equal(key(b, "detachedTaskMaxMin").sampled, true);
    assert.match(note(when), /Detached task limit \(minutes\) \(some values, sampled\)/);
});

// --- random samples ---

test("two measures of the same rule draw different `from` samples", () => {
    const when = '(c) => c.key === "detachedTaskMaxMin" && c.from < 31';
    const seenMatched = new Set();
    for (let i = 0; i < 16; i++) { const r = key(measure(when), "detachedTaskMaxMin"); seenMatched.add(`${r.tried}/${r.matched}`); }
    assert.ok(seenMatched.size > 1, `sixteen measures drew the same samples: ${[...seenMatched]}`);
});

// --- the residual of sampling ---

test("a value the rule NAMES is always tried: `c.from === 37` covers Detached task limit, in every measure (the literal harvest)", () => {
    const cur = DEFAULT_CONFIG.detachedTaskMaxMin;
    const v = cur === 37 ? 38 : 37;
    for (const w of [`c.from === ${v}`, `${v} === c.from`, `c.from === ${v - 7} + 7`, `c.to > ${v} && c.to < ${v + 2}`]) {
        const when = `(c) => c.key === "theme" || (c.key === "detachedTaskMaxMin" && ${w})`;
        for (let i = 0; i < 5; i++) {
            const p = prop(when), b = PP.measureSettingBreadth(p, DEPS);
            assert.ok(key(b, "detachedTaskMaxMin").matched > 0, `${w}: the named value was not tried`);
            assert.match(PP.settingBreadthNote(p, b), /^It covers: [^.]*Detached task limit \(minutes\) \(some values, sampled\)/);
        }
    }
});

test("a value the rule COMPUTES past folding is the residual: it reads \"none\" for that key, and the closing line names it", () => {
    const cur = DEFAULT_CONFIG.detachedTaskMaxMin;
    const v = cur === 37 ? 38 : 37;
    // A member read is not folded and the number appears nowhere as a constant, so the value is left to the draws.
    const when = `(c) => c.key === "theme" || (c.key === "detachedTaskMaxMin" && c.from === "${"x".repeat(v)}".length)`;
    let hit;
    for (let i = 0; i < 30 && !hit; i++) { const p = prop(when); const b = PP.measureSettingBreadth(p, DEPS); if (key(b, "detachedTaskMaxMin").matched === 0) hit = PP.settingBreadthNote(p, b); }
    assert.ok(hit, "thirty draws all included the one value");
    assert.match(hit, /^It covers: Theme \(every value\)\./);
    assert.ok(!/^It covers:[^.]*Detached/.test(hit), "the sampled key is off the covers line");
    assert.match(hit, /sampled settings? showed no match and could still be covered at a value not tried: [^.]*Detached task limit \(minutes\)/);
});

// --- could not be measured, and what is refused ---

test("with no server list a model key is unmeasured, the note names it, and an allow covering only model keys is refused", () => {
    const b = measure('(c) => c.key === "model"', {}, NO_LIST);
    assert.equal(PP.settingCover(key(b, "model")), "unmeasured");
    assert.equal(key(b, "model").tried, 0);
    const p = prop('(c) => c.key === "model"');
    assert.match(PP.settingRefusal(p, PP.measureSettingBreadth(p, NO_LIST)), /could not be measured|could not be/);
    assert.match(PP.settingRefusal(p, PP.measureSettingBreadth(p, NO_LIST)), /Default model/);
    const mixed = prop('(c) => c.key === "model" || c.key === "theme"');
    assert.equal(PP.settingRefusal(mixed, PP.measureSettingBreadth(mixed, NO_LIST)), null);
    assert.match(note('(c) => c.key === "model" || c.key === "theme"', {}, NO_LIST), /Could not be measured: .*Default model/);
    // with a list the same allow is measured and accepted
    assert.equal(PP.settingRefusal(p, PP.measureSettingBreadth(p, DEPS)), null);
});

test("an allow covering only guarded keys is refused; the same deny and ask are not", () => {
    const when = '(c) => c.key.startsWith("shell")';
    const allow = prop(when);
    assert.match(PP.settingRefusal(allow, PP.measureSettingBreadth(allow, DEPS)), /covers no setting a policy can free/);
    for (const effect of ["deny", "ask"]) {
        const p = prop(when, { effect });
        const b = PP.measureSettingBreadth(p, DEPS);
        assert.ok(matchedKeys(b).length > 0, effect);
        assert.equal(PP.settingRefusal(p, b), null, effect);
    }
    const r = PP.measureSettingRows([allow], DEPS);
    assert.ok("error" in r);
});

// --- the step budget ---

test("a rule just under SETTING_MEASURE_STEPS is measured and one just over is refused, for allow, deny and ask", () => {
    const under = nFor(0.8), over = nFor(1.3);
    for (const effect of ["allow", "deny", "ask"]) {
        const u = prop(spender(under), { effect }), o = prop(spender(over), { effect });
        const bu = PP.measureSettingBreadth(u, DEPS), bo = PP.measureSettingBreadth(o, DEPS);
        assert.equal(bu.exhausted, false, `${effect} under`);
        assert.equal(PP.settingRefusal(u, bu), null, effect);
        assert.equal(bo.exhausted, true, `${effect} over`);
        assert.match(PP.settingRefusal(o, bo), /takes too long to measure/, effect);
        assert.ok("measures" in PP.measureSettingRows([u], DEPS) && "error" in PP.measureSettingRows([o], DEPS), effect);
    }
});

test("the budget is shared across the rows of one call: two rows each over half are refused (\"rule 2:\"), each under half both measured", () => {
    const big = prop(spender(nFor(0.6))), small = prop(spender(nFor(0.4)));
    const r = PP.measureSettingRows([big, big], DEPS);
    assert.ok("error" in r, "two rows each over half were measured");
    assert.match(r.error, /^Error: rule 2: .*takes too long/);
    const ok = PP.measureSettingRows([small, small], DEPS);
    assert.ok("measures" in ok, JSON.stringify(ok));
    assert.equal(ok.measures.length, 2);
    assert.ok(ok.measures.every((m) => m && !m.exhausted));
});

// --- the realm ---

test("the policy realm gives a setting rule no Date, no ml, no clock, and Math.random stays refused", () => {
    const facts = { kind: "setting", key: "theme", from: "auto", to: "dark", class: "ordinary", widens: false, effects: "unknown" };
    for (const name of ["Date", "ml", "document", "console", "Promise", "window", "globalThis", "chrome", "setTimeout"]) {
        const r = evalPolicy(`(c) => typeof ${name} !== "undefined"`, facts);
        assert.notEqual(r.decision, "allow", `${name} is readable in a policy`);
    }
    for (const name of ["Array", "Object", "JSON", "Math", "String", "Number", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite"]) {
        assert.equal(evalPolicy(`(c) => typeof ${name} !== "undefined"`, facts).decision, "allow", `${name} left the realm`);
    }
    const dateNow = evalPolicy("(c) => Date.now() > 0", facts);
    assert.equal(dateNow.decision, undefined);
    assert.ok(dateNow.broken, "reading Date did not break the rule");
    const rnd = evalPolicy("(c) => Math.random() < 2", facts);
    assert.equal(rnd.decision, undefined);
    assert.match(rnd.broken ?? "", /random/);
    // and a proposal that reads one is refused before any measure
    assert.match(PP.checkProposal({ consumer: "setting", effect: "allow", when: "(c) => Math.random() < 2", label: "x" }).error, /random/);
});

// --- the card's text ---

test("the note holds none of the label's text outside the quote", () => {
    const label = "Only Theme";
    for (const effect of ["allow", "deny", "ask"]) {
        const n = note("(c) => true", { label, effect });
        const stripped = n.replace(`"${label}"`, "");
        assert.ok(n.includes(`"${label}"`), effect);
        assert.ok(!stripped.includes("Only Theme"), `${effect}: the label leaked into the measure's text`);
        assert.ok(!/only theme/i.test(stripped), effect);
    }
});

test("recordedSettingKeys reads change_setting keys once each, in order; the note says which the rule covers", () => {
    const msgs = [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [{ id: "1", name: "change_setting", arguments: { key: "cardCorner", value: "top-left" } }, { id: "2", name: "fetch_url", arguments: { url: "https://x.example/" } }] },
        { role: "tool", tool_call_id: "1", content: "ok" },
        { role: "assistant", content: "", tool_calls: [{ id: "3", name: "change_setting", arguments: JSON.stringify({ key: "theme", value: "dark" }) }, { id: "4", name: "change_setting", arguments: { key: "cardCorner", value: "top-right" } }, { id: "5", name: "change_setting", arguments: { key: "noSuchKey", value: 1 } }] },
    ];
    const keys = PP.recordedSettingKeys(msgs);
    assert.deepEqual(keys, ["cardCorner", "theme"]);
    assert.match(note('(c) => c.key === "theme"', {}, DEPS, keys), /Of the settings this run asked to change, it covers Theme\./);
    assert.match(note('(c) => c.key === "model"', {}, DEPS, keys), /It covers none of the 2 settings this run asked to change\./);
});

// --- in a run the worker built ---

const propose = (when, over = {}) => ({ name: "propose_policy", args: { consumer: "setting", effect: "allow", when, label: "Only Theme", ...over } });
const change = (k, value) => ({ name: "change_setting", args: { key: k, value } });
const plain = (v) => JSON.parse(JSON.stringify(v));

const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true, theme: "auto", shellEnabled: false };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A worker-built run on tab 7 whose model calls `calls` in turn; the server lists three models. Every card is recorded as `{ tool, card }` and answered by `answer(tool)`. */
async function settingRun(calls, { answer = () => true } = {}) {
    let turns = 0, bg;
    const cards = [], seen = [];
    bg = loadBackground({
        config, openTabs: [SITE], siteGate: true,
        onFetch: (call) => {
            if (/\/api\/models$/.test(call.url)) return jsonResponse({ data: [{ id: "m-a" }, { id: "m-b" }, { id: "m-c" }] });
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            seen.push(call.body.messages);
            const next = calls[turns++];
            return next
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                cards.push({ tool: msg.event.tool, card: plain(msg.event.renderIn ?? null) });
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: !!answer(msg.event.tool) } });
            }
            if (msg.type === "RUN_TOOL_IN_PAGE") return msg.payload.finish ? { result: "" } : {};
            return undefined;
        },
    });
    await bg.context.__mlStartUserRunForTest(7, { task: "tidy the settings", surface: "hud" });
    for (let i = 0; i < 400 && turns <= calls.length; i++) await new Promise((r) => setTimeout(r, 0));
    await flush(30);
    const results = (seen.at(-1) ?? []).filter((m) => m.role === "tool").map((m) => m.content);
    return { bg, cards, results };
}

test("an approved setting allow frees an ordinary change with no card, and a guarded change still shows one", T, async () => {
    const r = await settingRun([
        propose("(c) => true"),
        change("theme", "dark"),
        change("shellEnabled", true),
    ]);
    const tools = r.cards.map((c) => c.tool);
    assert.deepEqual(tools.filter((t) => t === "propose_policy"), ["propose_policy"], `cards: ${tools}`);
    assert.equal(tools.filter((t) => t === "change_setting").length, 1, `exactly the guarded change asked: ${tools}`);
    assert.equal(r.cards.find((c) => c.tool === "change_setting").card.key, "shellEnabled");
    assert.equal(r.bg.stored.theme, "dark", `the ordinary change was not written: ${JSON.stringify(r.results)}`);
    assert.match(r.cards.find((c) => c.tool === "propose_policy").card.note ?? "", /^It covers every setting the agent may change/);
});

test("an allow covering only guarded keys never reaches a card, and the model reads the refusal", T, async () => {
    const r = await settingRun([propose('(c) => c.key.startsWith("shell")')]);
    assert.equal(r.cards.length, 0, "a card was shown");
    assert.match(String(r.results[0]), /covers no setting a policy can free/);
});

test("the same rule proposed again in one run is a new call, measured again: the second card sees what happened between", T, async () => {
    // Keyed by the call, never by the rule's text: a change_setting between the two proposals shows on the second card only.
    const when = '(c) => c.key === "theme"';
    const r = await settingRun([propose(when), change("cardCorner", "top-left"), propose(when)], { answer: (t) => t !== "propose_policy" });
    const notes = r.cards.filter((c) => c.tool === "propose_policy").map((c) => c.card.note);
    assert.equal(notes.length, 2, `every proposal got a card: ${JSON.stringify(r.results).slice(0, 600)}`);
    for (const n of notes) assert.match(n, /^It covers: Theme \(every value\)/);
    assert.ok(!/this run asked to change/.test(notes[0]), notes[0]);
    assert.match(notes[1], /It covers none of the one setting this run asked to change/);
});

// --- refused from the rule's own constants and breaks, before any card ---

test("a c.key constant that names no setting is refused, with the name", () => {
    assert.match(PP.settingLiteralRefusal(prop('(c) => c.key === "themee"')), /c\.key is compared with "themee", which is no setting/);
    assert.match(PP.settingLiteralRefusal(prop('(c) => ["theme", "cardCornr"].includes(c.key)')), /"cardCornr", which is no setting/);
    assert.equal(PP.settingLiteralRefusal(prop('(c) => c.key === "theme" || c.key === "cardCorner"')), null);
});

test("a constant a key can never hold, beside c.key === that key, is refused with what the key takes, generated from its declaration", () => {
    assert.match(PP.settingLiteralRefusal(prop('(c) => c.key === "detachedTaskMaxMin" && c.to === 517')), /c\.to is compared with 517 where c\.key is "detachedTaskMaxMin", which takes a whole number from 1 to 60: it can never match/);
    assert.match(PP.settingLiteralRefusal(prop('(c) => c.key === "theme" && c.from === 5')), /which takes one of "auto", "dark", "light"/);
    assert.match(PP.settingLiteralRefusal(prop('(c) => c.key === "shellRoots" && c.to === "/tmp"')), /takes a list of strings \(compare its entries\)/);
    for (const ok of ['(c) => c.key === "detachedTaskMaxMin" && c.to === 30', '(c) => c.key === "detachedTaskMaxMin" && c.to > 500', '(c) => c.key === "theme" && c.to !== "dark"'])
        assert.equal(PP.settingLiteralRefusal(prop(ok)), null, ok);
});

test("settingTakes describes every key the agent may change, from its declaration alone (enumerated, not sampled)", async () => {
    const { SETTING_CLASSES, modelWritable } = await import("../src/setting-class.ts");
    for (const k of Object.keys(SETTING_CLASSES).filter((k) => modelWritable(k))) {
        const t = PP.settingTakes(k);
        assert.ok(typeof t === "string" && t.length > 3 && !/undefined/.test(t), `${k}: ${t}`);
    }
});

test("a rule that breaks on any value it is tried on is refused for every effect, naming at most three keys and the repair; one that short-circuits passes", () => {
    for (const effect of ["allow", "deny", "ask"]) {
        const p = prop('(c) => c.to.startsWith("d")', { effect });
        const r = PP.settingRefusal(p, PP.measureSettingBreadth(p, DEPS));
        assert.match(r, /^Error: the rule breaks on \d+ settings \([a-zA-Z]+, [a-zA-Z]+, [a-zA-Z]+, …: [^)]*startsWith[^)]*\); guard it by c\.key or by typeof/, effect);
    }
    const guarded = prop('(c) => c.key === "theme" && c.to.startsWith("d")');
    assert.equal(PP.settingRefusal(guarded, PP.measureSettingBreadth(guarded, DEPS)), null);
    const typed = prop('(c) => typeof c.to === "string" && c.to.startsWith("d")');
    assert.equal(PP.settingRefusal(typed, PP.measureSettingBreadth(typed, DEPS)), null);
});

test("a named string is tried with a value carrying it: c.from.startsWith on a guarded string key and on a listed one", () => {
    const p = prop('(c) => c.key === "theme" || (c.key === "electricityOffPeakHours" && c.from.startsWith("1-"))');
    for (let i = 0; i < 5; i++) assert.ok(key(PP.measureSettingBreadth(p, DEPS), "electricityOffPeakHours").matched > 0);
    const g = prop('(c) => c.key === "theme" || (c.key === "agentStartPage" && typeof c.to === "string" && c.to.endsWith(".corp"))', { effect: "deny" });
    for (let i = 0; i < 5; i++) assert.ok(key(PP.measureSettingBreadth(g, DEPS), "agentStartPage").matched > 0);
});

test("the literals run inside the one budget: a rule naming many constants is still measured, and refused only past the budget", () => {
    const nums = Array.from({ length: 40 }, (_, i) => `c.to === ${i * 3}`).join(" || ");
    const p = prop(`(c) => c.key === "theme" || (c.key === "detachedTaskMaxMin" && (${nums}))`);
    const budget = { left: PP.SETTING_MEASURE_STEPS };
    const b = PP.measureSettingBreadth(p, DEPS, [], budget);
    assert.equal(b.exhausted, false);
    assert.ok(PP.SETTING_MEASURE_STEPS - budget.left < PP.SETTING_MEASURE_STEPS);
});
