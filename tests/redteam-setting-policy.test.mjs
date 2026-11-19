// redteam-setting-policy.test.mjs — an approved `setting` policy frees exactly the ordinary settings it was approved for, and no
// other consumer's call (#2001): the judge frees a change only when its class is ordinary, the policy store keeps a consumer's
// rules apart, and every key a broad allow can free is a key the measure put on the card. Source: src/sw/sw-change-setting.ts
// (judgeSettingChange), src/sw/sw-policies.ts (judgeCall), src/sw/policy-proposal.ts (measureSettingBreadth).
import { test } from "node:test";
import assert from "node:assert/strict";

// The policy store reads `chrome.storage` when it loads; an empty one is enough (nothing here seeds a stored rule).
const writes = [];
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async (o) => { writes.push(o); } } } };

const P = await import("../src/sw/sw-policies.ts");
const S = await import("../src/sw/sw-change-setting.ts");
const PP = await import("../src/sw/policy-proposal.ts");
const { DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");
const { SETTING_CLASSES, modelWritable, settingDecl } = await import("../src/setting-class.ts");

const T = { timeout: 60000 };
const allow = (runId, consumer = "setting", source = "(c) => true") =>
    P.addRunPolicy(runId, { consumer, effect: "allow", source, label: "Everything", origin: "proposed" });
const deny = (runId, source = "(c) => true") =>
    P.addRunPolicy(runId, { consumer: "setting", effect: "deny", source, label: "Nothing", origin: "proposed" });
const deps = { config: { ...DEFAULT_CONFIG }, modelIds: async () => null };
const changeOf = async (key, value) => {
    const r = await S.checkSettingChange({ key, value }, deps);
    assert.ok("change" in r, `${key}: the change check refused the probe value: ${"error" in r ? r.error : ""}`);
    return r.change;
};

// --- the judge frees class ordinary alone, enumerated over every setting a run may change ---

test("an approved setting allow frees a change of exactly the ordinary class, for every setting a run may change", T, async () => {
    const run = "rt-setting-classes";
    allow(run);
    const freed = [], asked = [];
    for (const key of Object.keys(SETTING_CLASSES)) {
        if (!modelWritable(key)) continue;
        const decl = settingDecl(key);
        assert.ok(decl, `${key} is model-writable but has no declaration: the measure and the judge disagree`);
        const change = { key, from: null, to: undefined, class: decl.class, widens: false };
        if (key === "agentStartPage") continue;   // judged as navigation too; its own row below covers the class rule
        const v = await S.judgeSettingChange(run, change);
        if (v && "allow" in v) freed.push(key); else asked.push(key);
        assert.equal(!!(v && "allow" in v), decl.class === "ordinary",
            `${key} is class ${decl.class} and was ${v && "allow" in v ? "freed" : "not freed"}`);
    }
    assert.ok(freed.length > 0, "positive control: no ordinary setting was freed, so the store or the judge is broken");
    assert.ok(asked.some((k) => settingDecl(k).class === "guarded"), "there is no guarded setting in the table: the split is untested");
});

test("a setting allow never frees agentStartPage, whatever its rule", T, async () => {
    const run = "rt-setting-startpage";
    P.addRunPolicy(run, { consumer: "setting", effect: "allow", source: '(c) => c.key === "agentStartPage"', label: "Start page", origin: "proposed" });
    const c = await changeOf("agentStartPage", "https://news.example/");
    assert.equal(c.class, "guarded");
    assert.equal(await S.judgeSettingChange(run, c), null, "the start page was freed by a setting allow");
});

test("a setting deny refuses a guarded change too: the narrow direction is never sampled away", T, async () => {
    const run = "rt-setting-deny";
    deny(run);
    const c = await changeOf("shellEnabled", true);
    const v = await S.judgeSettingChange(run, c);
    assert.ok(v && "refused" in v, JSON.stringify(v));
});

// --- one consumer's approved rule decides that consumer alone ---

test("a fetch allow frees no setting change, and a setting allow frees no fetch call", T, async () => {
    const runF = "rt-setting-cross-fetch";
    allow(runF, "fetch");
    const ordinary = await changeOf("theme", "dark");
    assert.equal(await S.judgeSettingChange(runF, ordinary), null, "a fetch rule freed a setting change");

    const runS = "rt-setting-cross-setting";
    allow(runS, "setting");
    const url = "https://site.example/page";
    const j = P.judgeCall(runS, "fetch", P.fetchFacts(url));
    assert.notEqual(j.decision, "allow", `a setting rule freed a fetch: ${JSON.stringify(j.decision)} by ${j.by?.label}`);

    // positive control: each rule does free its own consumer's call.
    assert.ok(await S.judgeSettingChange(runS, ordinary), "positive control: the setting rule freed no setting change");
    const j2 = P.judgeCall(runF, "fetch", P.fetchFacts(url));
    assert.equal(j2.decision, "allow", "positive control: the fetch rule freed no fetch");
});

// --- what the card names is what the judge can free ---

test("every setting a broad allow frees is a key the measure listed on the card (the ratchet)", T, async () => {
    const run = "rt-setting-measured";
    allow(run);
    const checked = PP.checkProposal({ consumer: "setting", effect: "allow", when: "(c) => true", label: "Everything" });
    assert.ok(checked.proposal, `the proposal was refused: ${checked.error}`);
    const b = PP.measureSettingBreadth(checked.proposal, { config: { ...DEFAULT_CONFIG }, modelIds: ["m-a"] });
    const listed = new Set(b.keys.map((k) => k.key));
    const freedUnlisted = [];
    for (const key of Object.keys(SETTING_CLASSES)) {
        if (!modelWritable(key)) continue;
        const v = await S.judgeSettingChange(run, { key, from: null, to: undefined, class: settingDecl(key).class, widens: false });
        if (v && "allow" in v && !listed.has(key)) freedUnlisted.push(key);
    }
    assert.deepEqual(freedUnlisted, [], "a key a broad allow frees was not measured: it is free without appearing on the card");
    assert.ok(listed.size > 0, "the measure listed no key: the ratchet proves nothing");
});
