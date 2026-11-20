// settings-survey.test.mjs — `ml.settings()` as a free read: the reader parameter of `settingEntries`, the read-only dialect over it, and the api-docs line.

// docs/spec/MODEL_SETTINGS.md, "`ml.settings()` in a read-only survey". The wire's half is tests/ml-wire.test.mjs; what a
// hostile page must not get is tests/redteam-change-setting.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

const syncStore = {};
const area = (store) => ({
    get: async (k) => (typeof k === "string" ? (k in store ? { [k]: store[k] } : {}) : { ...store }),
    set: async (o) => { Object.assign(store, structuredClone(o)); },
});
globalThis.chrome = { storage: { sync: area(syncStore), session: area({}), local: area({}), onChanged: { addListener() {}, removeListener() {} } }, runtime: { id: "x" } };

const S = await import("../src/sw/sw-change-setting.ts");
const { DEFAULT_CONFIG, SETTING_PLACES, publicConfig } = await import("../src/contract/contract-config.ts");
const { SETTING_CLASSES } = await import("../src/setting-class.ts");
const { mlFacade } = await import("../src/readonly-exec/policy.ts");
const { evalReadonly, NotInDialect, Denied } = await import("../src/readonly-exec.ts");
const { apiDocsTool } = await import("../src/tools/api-docs-tool.ts");

const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, ...over });
const PUBLIC = new Set(Object.keys(publicConfig(DEFAULT_CONFIG, false)));
const placed = Object.keys(SETTING_PLACES).filter((k) => k in SETTING_CLASSES);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// --- the class table, enumerated: every placed key, both readers ---

test("every placed, classified key: the exec reader gets a value unless secret, the survey reader follows settingReadable and the spec table", () => {
    assert.ok(placed.length > 20, "positive control: the table is not empty");
    const classes = new Set();
    const exec = S.settingEntries(cfg(), "exec"), survey = S.settingEntries(cfg(), "survey");
    for (const key of placed) {
        const cls = SETTING_CLASSES[key].class;
        classes.add(cls);
        assert.ok(S.READABLE_CLASSES.has(cls) || cls === "secret", `class ${cls} of ${key} is in neither the readable set nor secret: name it in the spec table`);
        assert.equal(S.settingReadable(key, cls, "exec"), cls !== "secret", `exec reads ${key} (${cls})`);
        if (cls === "secret") {
            assert.deepEqual(exec[key], { mode: "hidden", class: cls }, key);
            assert.deepEqual(survey[key], { mode: "hidden", class: cls }, key);
        } else {
            assert.ok(own(exec[key], "value"), `exec: ${key} has a value`);
            assert.equal(exec[key].class, cls);
            const r = S.settingReadable(key, cls, "survey");
            const expect = cls === "ordinary" || PUBLIC.has(key) ? true : "held";
            assert.equal(r, expect, `survey: ${key} (${cls})`);
            if (expect === true) assert.ok(own(survey[key], "value"), `survey: ${key} has a value`);
            else {
                assert.equal(survey[key].held, "exec", key);
                assert.ok(!own(survey[key], "value"), `survey: held ${key} has no value property`);
                assert.deepEqual(Object.keys(survey[key]).sort(), ["class", "held", "mode"], key);
            }
        }
        if (survey[key].mode === "hidden") assert.ok(!own(survey[key], "value"), key);
    }
    for (const c of ["ordinary", "guarded", "gate", "secret"]) assert.ok(classes.has(c), `the table has a ${c} key, so the row covers it`);
});

test("the default reader is exec", () => {
    const def = S.settingEntries(cfg({ shellRoots: ["/home/x"] }));
    assert.deepEqual(def, S.settingEntries(cfg({ shellRoots: ["/home/x"] }), "exec"));
    assert.deepEqual(def.shellRoots.value, ["/home/x"], "a held-for-survey key is a value by default");
    assert.ok(!own(def.shellRoots, "held"));
});

// --- the held set, pinned ---

test("the keys held from a survey today are exactly the spec's eighteen", () => {
    const held = Object.entries(S.settingEntries(cfg(), "survey")).filter(([, e]) => e.held === "exec").map(([k]) => k).sort();
    const spec = ["shellEnabled", "shellRoots", "shellPath", "shellSandbox", "execDefaultWorld", "agentStartPage", "agentSeesFocus", "siteRequests", "listPageSessions", "persistUiRuns", "sessionArchive", "sessionRetentionDays", "sessionStoreBudgetMB", "valueStoreBudgetMB", "exportToolDefs", "taskNotifyOnly", "taskTurnChainMax", "shellRevealsAllow"].sort();
    assert.equal(spec.length, 18);
    assert.deepEqual(held, spec);
});

// --- the publicConfig derivation, both directions ---

test("a key added to the public set becomes a value, and one removed becomes held, with ordinary keys unmoved", () => {
    assert.ok(!PUBLIC.has("shellRoots") && PUBLIC.has("cdp"), "premises: shellRoots is not public, cdp is");
    const config = cfg({ shellRoots: ["/a"] });
    const plus = new Set([...PUBLIC, "shellRoots"]);
    const a = S.settingEntries(config, "survey", SETTING_PLACES, plus);
    assert.deepEqual(a.shellRoots.value, ["/a"]);
    assert.ok(!own(a.shellRoots, "held"));
    const minus = new Set(PUBLIC); minus.delete("cdp");
    const b = S.settingEntries(config, "survey", SETTING_PLACES, minus);
    assert.equal(b.cdp.held, "exec");
    assert.ok(!own(b.cdp, "value"));
    const none = S.settingEntries(config, "survey", SETTING_PLACES, new Set());
    for (const key of placed) {
        const c = SETTING_CLASSES[key].class;
        if (c === "ordinary") assert.ok(own(none[key], "value"), `${key} stays a value with an empty public set`);
        if (c === "guarded" || c === "gate") assert.equal(none[key].held, "exec", `${key} is held with an empty public set`);
    }
});

// --- a class nobody may read ---

test("a class outside READABLE_CLASSES is unreadable to both readers", () => {
    assert.equal(S.settingReadable("anything", "future", "exec"), false);
    assert.equal(S.settingReadable("anything", "future", "survey"), false);
    assert.equal(S.settingReadable("anything", "future", "survey", new Set(["anything"])), false, "being public does not make it readable");
    assert.deepEqual([...S.READABLE_CLASSES].sort(), ["gate", "guarded", "ordinary"]);
});

// --- copies ---

test("settingEntries returns fresh objects and fresh values each call", () => {
    const config = cfg({ shellRoots: ["/a"], serverToolsOff: ["x"] });
    const listKey = placed.find((k) => Array.isArray(config[k]) && S.settingReadable(k, SETTING_CLASSES[k].class, "survey") === true);
    assert.ok(listKey, "positive control: a list-valued key readable by a survey");
    const before = structuredClone(config[listKey]);
    for (const reader of ["survey", "exec"]) {
        const k = reader === "exec" ? "shellRoots" : listKey;
        const a = S.settingEntries(config, reader), b = S.settingEntries(config, reader);
        assert.notEqual(a, b);
        assert.notEqual(a[k], b[k]);
        assert.notEqual(a[k].value, b[k].value);
        const kept = structuredClone(config[k]);
        a[k].value.push("INJECTED");
        assert.deepEqual(config[k], kept, `${reader}: the config's list is untouched`);
        assert.deepEqual(S.settingEntries(config, reader)[k].value, kept, `${reader}: a later call is unchanged`);
        assert.deepEqual(b[k].value, kept, `${reader}: an earlier sibling is unchanged`);
    }
    assert.deepEqual(config[listKey], before);
});

// --- the secret never appears ---

test("a survey's entries carry neither the API key nor the server URL", () => {
    const e = S.settingEntries(cfg({ apiKey: "sk-SENTINEL-123", chatUrl: "https://secret.example" }), "survey");
    const text = JSON.stringify(e);
    assert.ok(!text.includes("sk-SENTINEL-123"), "the key");
    assert.ok(!text.includes("secret.example"), "the url");
    assert.ok(text.length > 100, "positive control: entries were produced");
});

// --- the dialect over a worker-realm facade ---

const entries = () => S.settingEntries(cfg({ theme: "dark" }), "survey");
const hostMl = (extra = {}) => ({ config: async () => ({ model: "m" }), range: (n) => Array.from({ length: n }, (_, i) => i), settings: async () => entries(), ...extra });
const inWorker = async (js, ml = hostMl()) => (await evalReadonly(js, null, ml, undefined, { realm: "worker" })).value;
const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;

test("the facade has settings in the worker realm only over a host ml that has it", () => {
    assert.equal(typeof mlFacade(hostMl(), undefined, undefined, undefined, "worker").settings, "function");
    const bare = { config: async () => ({}), range: () => [] };
    assert.ok(!("settings" in mlFacade(bare, undefined, undefined, undefined, "worker")), "worker realm, host without settings");
    assert.ok(!("settings" in mlFacade(bare)), "page realm, host without settings");
});

test("ml.settings() returns the entries the host built, as a copy", async () => {
    const r = await inWorker("ml.settings()");
    assert.deepEqual(JSON.parse(JSON.stringify(r)), entries());
    assert.equal(await inWorker("const s = ml.settings(); s.theme.value"), "dark");
});

test("ml.settings() with no settings on the host is not in the dialect (or defers), never an answer", async () => {
    const bare = { config: async () => ({}), range: () => [] };
    await assert.rejects(inWorker("ml.settings()", bare), (e) => outOfDialect(e) || e?.constructor?.name === "NeedsPage");
});

test("ml.settings, taken out of its call shape, is refused, and a bare reference is inert", async () => {
    // Each shape's one outcome, pinned: a widening of the dialect that lets one of these call the host is a change here.
    const refused = [
        "const f = ml.settings; f()",
        "ml.settings.call(null)",
        "ml.settings.apply(null, [])",
        "ml.settings.bind(null)()",
        "const { settings } = ml; settings()",
        "[1].map(ml.settings)",
        "[ml.settings][0]()",
        "(0, ml.settings)()",
    ];
    for (const js of refused) await assert.rejects(inWorker(js), (e) => e instanceof NotInDialect, js);
    // The method reference itself is the inert METHOD_REF, never the host's function: calling it only throws.
    const ref = await inWorker("ml.settings");
    assert.equal(typeof ref, "function");
    assert.equal(ref.name, "METHOD_REF");
    assert.throws(() => ref(), NotInDialect);
    // A computed literal key is the same call, mediated by the facade; positive control for the refusals above.
    assert.deepEqual(JSON.parse(JSON.stringify(await inWorker('ml["settings"]()'))), entries());
});

// --- the api-docs line ---

test("agent_api_docs names ml.settings() in the free list only when freeSettings says the run has it", async () => {
    const section = async (extra) => {
        const tool = apiDocsTool((d) => d, { invocation: async () => null, config: async () => ({ ...publicConfig(DEFAULT_CONFIG, false), autoApproveReadonly: true }), ...extra });
        const text = await tool.run({ search: "Reading your own setup" });
        const i = text.indexOf("Reading your own setup");
        assert.ok(i >= 0, "positive control: the section is there");
        return text.slice(i, i + 600);
    };
    assert.match(await section({ freeSettings: () => true }), /`ml\.settings\(\)`/);
    assert.doesNotMatch(await section({ freeSettings: () => false }), /ml\.settings\(\)/);
    assert.doesNotMatch(await section({}), /ml\.settings\(\)/);
    assert.match(await section({}), /`ml\.config\(\)`/, "the other free methods are still named");
});
