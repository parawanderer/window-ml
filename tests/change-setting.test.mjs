// change-setting.test.mjs — `change_setting` in the worker (src/sw/sw-change-setting.ts) and the `ml.settings` parts of
// src/sw/exec-routing.ts and src/sw/sw-isolated-exec.ts (docs/spec/MODEL_SETTINGS.md, "The surface" and "Who reaches it").
//
// Pure checks with a stand-in for the config and the server's model list; the write and the declined-run memory with a
// mocked `chrome.storage`; the policies through the real store.
import { test } from "node:test";
import assert from "node:assert/strict";

const syncStore = {}, sessionStore = {};
const area = (store) => ({
    get: async (k) => {
        if (typeof k === "string") return k in store ? { [k]: store[k] } : {};
        if (k && typeof k === "object") return Object.fromEntries(Object.entries(k).map(([n, d]) => [n, n in store ? store[n] : d]));
        return { ...store };
    },
    set: async (o) => { Object.assign(store, structuredClone(o)); },
});
globalThis.chrome = { storage: { sync: area(syncStore), session: area(sessionStore), local: area({}), onChanged: { addListener() {}, removeListener() {} } }, runtime: { id: "x" } };

const S = await import("../src/sw/sw-change-setting.ts");
const { DEFAULT_CONFIG } = await import("../src/contract/contract-config.ts");
const { SETTING_CLASSES, settingWidens } = await import("../src/setting-class.ts");
const P = await import("../src/sw/sw-policies.ts");
const R = await import("../src/sw/exec-routing.ts");
const I = await import("../src/sw/sw-isolated-exec.ts");

const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, ...over });
const deps = (over = {}, ids = ["m1", "m2"]) => ({ config: cfg(over), modelIds: async () => ids });
const check = (args, over, ids) => S.checkSettingChange(args, deps(over, ids));
const refused = async (args, over, ids) => { const r = await check(args, over, ids); assert.ok("error" in r, `expected a refusal for ${JSON.stringify(args)}`); return r.error; };
const accepted = async (args, over, ids) => { const r = await check(args, over, ids); assert.ok("change" in r, `expected acceptance for ${JSON.stringify(args)}: ${r.error}`); return r.change; };
let n = 0;
const run = () => `run-${++n}-${Math.random().toString(36).slice(2)}`;

// --- checkSettingChange: what is refused before any card ---

test("a call with no key is refused", async () => {
    assert.match(await refused({ value: true }), /needs `key`/);
    assert.match(await refused({ key: "", value: true }), /needs `key`/);
});

test("an unknown key is refused", async () => {
    assert.match(await refused({ key: "noSuchSetting", value: 1 }), /no setting "noSuchSetting"/);
});

test("a secret key is refused as neither readable nor changeable", async () => {
    assert.equal(SETTING_CLASSES.apiKey.class, "secret");
    assert.match(await refused({ key: "apiKey", value: "sk-x" }), /secret setting/);
});

test("a gate key is refused, and the refusal points at its Settings link", async () => {
    assert.equal(SETTING_CLASSES.autoApproveReadonly.class, "gate");
    const e = await refused({ key: "autoApproveReadonly", value: false }, { autoApproveReadonly: true });
    assert.ok(e.includes("window-ml:setting/autoApproveReadonly"), e);
});

test("a missing value is refused", async () => {
    assert.match(await refused({ key: "theme" }), /needs `value`/);
});

test("a value of the wrong type is refused", async () => {
    assert.match(await refused({ key: "autoTitles", value: "yes" }), /is not one/);
    assert.match(await refused({ key: "pythonIdleMinutes", value: "5" }), /is not one/);
});

test("a string over SETTING_STRING_MAX is refused", async () => {
    assert.match(await refused({ key: "agentStartPage", value: "https://a.example/" + "x".repeat(S.SETTING_STRING_MAX) }), /at most 2048 characters/);
});

test("an enum key given a word outside its domain is refused", async () => {
    assert.match(await refused({ key: "theme", value: "neon" }, { theme: "auto" }), /"neon" is not one/);
});

test("a value equal to the current one is refused as already set", async () => {
    assert.match(await refused({ key: "theme", value: "dark" }, { theme: "dark" }), /already "dark"\. Nothing was changed/);
});

// --- guarded keys: their bounds ---

test("a list key refuses a relative path, a duplicate, an empty entry and too many entries", async () => {
    const roots = (v) => ({ key: "shellRoots", value: v });
    assert.match(await refused(roots(["relative/dir"]), { shellRoots: [] }), /absolute paths/);
    assert.match(await refused(roots(["/a", "/a"]), { shellRoots: [] }), /no entry twice/);
    assert.match(await refused(roots([""]), { shellRoots: [] }), /not empty/);
    assert.match(await refused(roots(["/a", "  "]), { shellRoots: [] }), /not empty/);
    const many = Array.from({ length: S.SETTING_LIST_MAX + 1 }, (_, i) => `/d${i}`);
    assert.match(await refused(roots(many), { shellRoots: [] }), /at most 64 entries/);
    const ok = await accepted(roots(["/a", "/b"]), { shellRoots: [] });
    assert.equal(ok.class, "guarded");
    assert.equal(ok.widens, true, "adding a folder widens");
});

test("a non-negative-integer key refuses -1 and 1.5 and takes 0", async () => {
    assert.match(await refused({ key: "sessionRetentionDays", value: -1 }, { sessionRetentionDays: 30 }), /whole number, 0 or more/);
    assert.match(await refused({ key: "sessionRetentionDays", value: 1.5 }, { sessionRetentionDays: 30 }), /whole number, 0 or more/);
    assert.equal((await accepted({ key: "sessionRetentionDays", value: 0 }, { sessionRetentionDays: 30 })).to, 0);
});

test("agentStartPage refuses a javascript: URL and one with credentials, and takes \"\" and an https address", async () => {
    const start = (v) => ({ key: "agentStartPage", value: v });
    const cur = { agentStartPage: "https://old.example/" };
    assert.match(await refused(start("javascript:alert(1)"), cur), /http\(s\) address/);
    assert.match(await refused(start("https://user:pw@example.com/"), cur), /no user name or password/);
    assert.match(await refused(start("not a url"), cur), /http\(s\) address/);
    assert.equal((await accepted(start(""), cur)).to, "");
    assert.equal((await accepted(start("https://example.com/"), cur)).to, "https://example.com/");
});

// --- a model-name key ---

test("a model-name key takes an id the server lists that the filter allows", async () => {
    const c = await accepted({ key: "model", value: "m2" }, { model: "m1" }, ["m1", "m2"]);
    assert.equal(c.to, "m2");
});

test("a model-name key refuses an id the server does not list", async () => {
    assert.match(await refused({ key: "model", value: "ghost" }, { model: "m1" }, ["m1", "m2"]), /not a model the server offers/);
});

test("a model-name key refuses, saying the list could not be read, when the server's list is null", async () => {
    assert.match(await refused({ key: "model", value: "m2" }, { model: "m1" }, null), /could not be read/);
});

test("a model-name key refuses an id the model filter excludes", async () => {
    assert.match(await refused({ key: "model", value: "m2" }, { model: "m1", modelFilter: "^m1$" }, ["m1", "m2"]), /not a model the server offers/);
});

// --- a valid change ---

test("a valid ordinary change carries from, to and class ordinary", async () => {
    const c = await accepted({ key: "theme", value: "dark" }, { theme: "light" });
    assert.deepEqual({ key: c.key, from: c.from, to: c.to, class: c.class, widens: c.widens }, { key: "theme", from: "light", to: "dark", class: "ordinary", widens: false });
});

test("a valid guarded change carries class guarded", async () => {
    const c = await accepted({ key: "cdp", value: true }, { cdp: false });
    assert.deepEqual({ from: c.from, to: c.to, class: c.class, widens: c.widens }, { from: false, to: true, class: "guarded", widens: true });
});

// --- judgeSettingChange ---

const change = (key, from, to, cls) => ({ key, from, to, class: cls, widens: settingWidens(key, from, to) });
const ordinary = change("theme", "light", "dark", "ordinary");

test("with no policy a change is judged null (a card)", async () => {
    assert.equal(await S.judgeSettingChange(run(), ordinary), null);
});

test("a global deny policy of consumer setting refuses, naming the policy's label", async () => {
    const p = P.addGlobalPolicy({ consumer: "setting", effect: "deny", source: '(c) => c.key === "theme"', label: "no theme changes" });
    try {
        const v = await S.judgeSettingChange(run(), ordinary);
        assert.ok(v && "refused" in v && v.refused.includes("no theme changes"), JSON.stringify(v));
    } finally { P.removePolicy(p.id); }
});

test("an allow policy frees an ordinary change, naming the policy", async () => {
    const p = P.addGlobalPolicy({ consumer: "setting", effect: "allow", source: '(c) => c.key === "theme"', label: "theme is free" });
    try {
        assert.deepEqual(await S.judgeSettingChange(run(), ordinary), { allow: "theme is free" });
    } finally { P.removePolicy(p.id); }
});

test("an allow policy never frees a guarded change, in either direction", async () => {
    const p = P.addGlobalPolicy({ consumer: "setting", effect: "allow", source: "(c) => true", label: "everything" });
    try {
        const on = change("cdp", false, true, "guarded"), off = change("cdp", true, false, "guarded");
        assert.equal(on.widens, true);
        assert.equal(off.widens, false);
        assert.equal(await S.judgeSettingChange(run(), on), null);
        assert.equal(await S.judgeSettingChange(run(), off), null);
    } finally { P.removePolicy(p.id); }
});

test("agentStartPage is refused by a fetch deny policy covering its host", async () => {
    const p = P.addGlobalPolicy({ consumer: "fetch", effect: "deny", source: '(c) => c.host === "blocked.example"', label: "no blocked.example" });
    try {
        const v = await S.judgeSettingChange(run(), change("agentStartPage", "", "https://blocked.example/x", "guarded"));
        assert.ok(v && "refused" in v && v.refused.includes("no blocked.example"), JSON.stringify(v));
        assert.equal(await S.judgeSettingChange(run(), change("agentStartPage", "", "https://fine.example/", "guarded")), null);
    } finally { P.removePolicy(p.id); }
});

// --- a declined guarded change ---

test("after a decline, a guarded change of that key is refused for that run only", async () => {
    const a = run(), b = run();
    const c = change("cdp", false, true, "guarded");
    assert.equal(await S.judgeSettingChange(a, c), null);
    await S.noteSettingDeclined(a, "cdp");
    const v = await S.judgeSettingChange(a, c);
    assert.ok(v && "refused" in v && v.refused.includes("declined"), JSON.stringify(v));
    assert.equal(await S.judgeSettingChange(b, c), null, "another run is not affected");
    assert.equal(await S.judgeSettingChange(a, change("pierceClosedShadow", false, true, "guarded")), null, "another key is not affected");
});

// --- writeSettingChange: compare-and-set ---

test("a write with nothing held is refused", async () => {
    const w = await S.writeSettingChange(run(), { key: "theme", value: "dark" });
    assert.equal(w.ok, false);
});

test("a write whose value differs from the held one is refused", async () => {
    const r = run();
    syncStore.theme = "light";
    S.holdSettingChange(r, ordinary, "person");
    const w = await S.writeSettingChange(r, { key: "theme", value: "auto" });
    assert.equal(w.ok, false);
    assert.equal(syncStore.theme, "light");
});

test("a write is refused when the stored value changed since the hold, and its text names neither value", async () => {
    const r = run();
    syncStore.theme = "light";
    S.holdSettingChange(r, ordinary, "person");
    syncStore.theme = "auto";
    const w = await S.writeSettingChange(r, { key: "theme", value: "dark" });
    assert.equal(w.ok, false);
    assert.equal(syncStore.theme, "auto", "nothing written over the other change");
    assert.ok(!/light|dark|auto/.test(w.text.replace(/\btheme\b/g, "")), w.text);
});

test("the happy path writes sync, and the result names the old value and how to undo", async () => {
    const r = run();
    syncStore.theme = "light";
    S.holdSettingChange(r, ordinary, "person");
    const w = await S.writeSettingChange(r, { key: "theme", value: "dark" });
    assert.equal(w.ok, true);
    assert.equal(syncStore.theme, "dark");
    const text = S.settingWriteText(w);
    assert.ok(text.includes('"light"') && text.includes("To undo it"), text);
});

test("a held change is consumed by its write: a second write fails", async () => {
    const r = run();
    syncStore.theme = "light";
    S.holdSettingChange(r, ordinary, "person");
    assert.equal((await S.writeSettingChange(r, { key: "theme", value: "dark" })).ok, true);
    syncStore.theme = "light";
    assert.equal((await S.writeSettingChange(r, { key: "theme", value: "dark" })).ok, false);
    assert.equal(syncStore.theme, "light");
});

// --- settingEntries: what ml.settings() returns ---

test("every entry of settingEntries is a classified key with a place", async () => {
    const { SETTING_PLACES } = await import("../src/contract/contract-config.ts");
    const e = S.settingEntries(cfg());
    assert.ok(Object.keys(e).length > 0);
    for (const k of Object.keys(e)) {
        assert.ok(k in SETTING_PLACES, `${k} has no place`);
        assert.ok(k in SETTING_CLASSES, `${k} is not classified`);
    }
});

test("a secret entry is exactly { mode: hidden, class: secret } with no value property", () => {
    const e = S.settingEntries(cfg({ apiKey: "sk-secret" }));
    const secrets = Object.keys(e).filter((k) => SETTING_CLASSES[k].class === "secret");
    assert.ok(secrets.length > 0, "at least one secret key has a place");
    for (const k of secrets) {
        assert.deepEqual(e[k], { mode: "hidden", class: "secret" });
        assert.ok(!("value" in e[k]));
    }
    assert.ok(!JSON.stringify(e).includes("sk-secret"));
});

test("a gate entry is read-only with its value, and an ordinary placed key is read-write", () => {
    const e = S.settingEntries(cfg({ autoApproveReadonly: true, theme: "dark" }));
    assert.deepEqual(e.autoApproveReadonly, { value: true, mode: "read", class: "gate" });
    assert.deepEqual(e.theme, { value: "dark", mode: "read-write", class: "ordinary" });
});

test("settingEntries over a custom places table holds only the keys in it", () => {
    const e = S.settingEntries(cfg({ theme: "dark" }), { theme: { tab: "x" } });
    assert.deepEqual(Object.keys(e), ["theme"]);
});

test("a key nobody classed is neither listed nor writable, even with a row in Settings", async () => {
    // What a lane adding a key to DEFAULT_CONFIG gets before it classifies it: nothing (MODEL_SETTINGS.md, "a key nobody
    // classed"). The class table's type and the class test also refuse it; this is the run-time half.
    const { modelWritable } = await import("../src/setting-class.ts");
    const places = { futureList: { tab: "advanced" }, theme: { tab: "appearance" } };
    const e = S.settingEntries(cfg({ futureList: ["ps"], theme: "dark" }), places);
    assert.deepEqual(Object.keys(e), ["theme"]);
    assert.equal(modelWritable("futureList", places), false);
    assert.match(await refused({ key: "futureList", value: ["ps", "lsof"] }, { futureList: ["ps"] }), /no setting "futureList"/);
});

// --- exec routing: ml.settings never enters the page's world ---

test("execNames sees ml.settings", () => {
    assert.equal(R.execNames("ml.settings()").settings, true);
    assert.equal(R.execNames("return ml . settings()").settings, true);
    assert.equal(R.execNames("document.title").settings, false);
});

test("an exec naming ml.settings is routed isolated with reason settings", () => {
    assert.deepEqual(R.routeExec("ml.settings()", true, { userScripts: true, cdp: false }), { where: "isolated", how: "userScripts", reason: "settings" });
    assert.deepEqual(R.routeExec("ml.settings()", true, { userScripts: false, cdp: true }), { where: "isolated", how: "cdp", reason: "settings" });
});

test("an exec naming ml.settings is refused, pointing at change_setting, when no isolation is available", () => {
    const r = R.routeExec("ml.settings()", true, { userScripts: false, cdp: false });
    assert.equal(r.where, "refused");
    assert.match(r.result, /change_setting/);
});

test("world page is refused for an exec naming ml.settings", () => {
    const r = R.routeExec("ml.settings()", true, { userScripts: true, cdp: true }, { world: "page" });
    assert.equal(r.where, "refused");
    assert.match(r.result, /ml\.settings/);
});

test("a survey naming ml.settings is never handed to the page", () => {
    assert.equal(R.surveyMayEnterPage(" ml.settings()"), false);
    assert.equal(R.surveyMayEnterPage("document.title"), true);
});

// --- the isolated world's members ---

test("isolatedMembers gives settings only when the worker bound them", () => {
    assert.ok(!I.isolatedMembers({ reads: [] }).includes("settings"));
    assert.ok(I.isolatedMembers({ reads: [], settings: {} }).includes("settings"));
});
