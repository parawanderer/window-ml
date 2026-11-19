// What each setting is to the model (src/setting-class.ts, docs/spec/MODEL_SETTINGS.md): every key of DEFAULT_CONFIG
// in exactly one class, the five ways a declaration can be wrong, which change of a guarded key widens, the closed
// domains, and the restore preview that now lists every guarded, gate and secret setting apart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, SETTING_PLACES } from "../src/contract/contract-config.ts";
import { SETTING_CLASSES, DOMAIN_KINDS, domainAllows, hoursOk, modelWritable, restoreListsApart, settingDecl, settingWidens } from "../src/setting-class.ts";
import { planRestore } from "../src/backup/backup-settings.ts";
import { SITE_SCHEMA } from "../src/site-access.ts";

const KEYS = Object.keys(DEFAULT_CONFIG);
const ofClass = (c) => KEYS.filter((k) => SETTING_CLASSES[k].class === c).sort();

// --- the class declaration: the five failures ---

test("every key of DEFAULT_CONFIG has a class, and the declaration names nothing else", () => {
    for (const k of KEYS) assert.ok(settingDecl(k), `${k} has no class`);
    assert.deepEqual(Object.keys(SETTING_CLASSES).sort(), [...KEYS].sort());
    assert.equal(settingDecl("notASetting"), null);
    assert.equal(settingDecl("__proto__"), null);
});

test("every guarded, gate or secret setting says what changing it does", () => {
    for (const k of KEYS) {
        const d = SETTING_CLASSES[k];
        if (d.class !== "ordinary") assert.ok(typeof d.reason === "string" && d.reason.trim().length > 0, `${k} has no reason`);
    }
});

test("every gate setting has a row in DevTools Settings, which its refusal links to", () => {
    for (const k of ofClass("gate")) assert.ok(SETTING_PLACES[k], `${k} has no place`);
});

test("every ordinary setting has a domain of a known kind, and its default is in it", () => {
    for (const k of ofClass("ordinary")) {
        const { domain } = SETTING_CLASSES[k];
        assert.ok(domain && DOMAIN_KINDS.includes(domain.kind), `${k}: ${domain?.kind}`);
        if (domain.kind === "enum") assert.ok(domain.words.length > 0, k);
        if (domain.kind !== "model") assert.equal(domainAllows(domain, DEFAULT_CONFIG[k]), true, `${k}'s default ${JSON.stringify(DEFAULT_CONFIG[k])}`);
    }
});

test("the model may change a setting only with a row in DevTools Settings, and never a secret or a gate one", () => {
    // ocrNumCtx is ordinary with no control in the panel: not writable with the real table, writable once given a row.
    assert.equal(SETTING_CLASSES.ocrNumCtx.class, "ordinary");
    assert.equal(modelWritable("ocrNumCtx"), false);
    assert.equal(modelWritable("ocrNumCtx", { ...SETTING_PLACES, ocrNumCtx: { tab: "models", section: "ocr" } }), true);
    const everywhere = Object.fromEntries(KEYS.map((k) => [k, { tab: "advanced" }]));
    for (const k of [...ofClass("secret"), ...ofClass("gate")]) assert.equal(modelWritable(k, everywhere), false, k);
    assert.equal(modelWritable("notASetting", { notASetting: { tab: "advanced" } }), false);
    assert.equal(KEYS.filter((k) => modelWritable(k)).length, 51);
});

test("the secrets and the gate keys are exactly the ruled ones", async () => {
    // The ruled five as a literal, held against both the scrubber's list (plus the legacy site list) and the class
    // table: a key dropped from both, or added to one, reds here.
    const RULED = ["apiKey", "chatUrl", "modelFilter", "pageApprovalDomains", "priceSnapshotUrl"];
    const { SECRET_KEYS } = await import("../src/sw/sw-scrub.ts");
    assert.deepEqual([...SECRET_KEYS, "pageApprovalDomains"].sort(), RULED);
    assert.deepEqual(ofClass("secret"), RULED);
    assert.deepEqual(ofClass("gate"), ["autoApprovePython", "autoApproveReadonly", "autoApproveSelfSource", "shellRevealsAllow"]);
    assert.equal(ofClass("guarded").length, 24);
});

test("no shell key and not agentStartPage is ever ordinary, so no setting allow frees one", () => {
    // judgeSettingChange frees an ordinary change only; a shell key added later must be guarded, gate or secret.
    const keys = [...KEYS.filter((k) => /^shell/.test(k)), "agentStartPage"];
    assert.ok(keys.length >= 5, keys.join());
    for (const k of keys) assert.notEqual(SETTING_CLASSES[k].class, "ordinary", k);
});

// --- which change of a guarded setting widens ---

test("a guarded setting widens in its declared direction only, and one with no direction widens both ways", () => {
    const cases = [
        ["shellEnabled", false, true, true], ["shellEnabled", true, false, false],
        ["shellSandbox", true, false, true], ["shellSandbox", false, true, false],
        ["shellRoots", ["/a"], ["/a", "/b"], true], ["shellRoots", ["/a", "/b"], ["/a"], false], ["shellRoots", ["/a", "/b"], ["/b", "/a"], false],
        ["shellPath", ["/a", "/b"], ["/b", "/a"], true], ["shellPath", ["/a", "/b"], ["/a"], false], ["shellPath", [], ["/x"], true],
        ["serverToolsOff", ["web"], [], true], ["serverToolsOff", [], ["web"], false],
        ["commanderServerTools", [], ["web"], true], ["commanderServerTools", ["web"], [], false],
        ["sessionRetentionDays", 0, 30, true], ["sessionRetentionDays", 30, 10, true], ["sessionRetentionDays", 10, 30, false], ["sessionRetentionDays", 30, 0, false],
        ["sessionStoreBudgetMB", 0, 256, true], ["sessionStoreBudgetMB", 256, 0, false],
        ["valueStoreBudgetMB", 1024, 512, true], ["valueStoreBudgetMB", 512, 1024, false],
        ["persistUiRuns", true, false, true], ["persistUiRuns", false, true, false],
        ["execDefaultWorld", "", "page", true], ["execDefaultWorld", "page", "isolated", true],
        ["agentStartPage", "", "https://x.example/", true], ["apiFormat", "openai", "ollama", true], ["debugMode", "devtools", "off", true],
    ];
    for (const [k, from, to, want] of cases) assert.equal(settingWidens(k, from, to), want, `${k}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
    for (const k of [...ofClass("ordinary"), ...ofClass("gate"), ...ofClass("secret")]) assert.equal(settingWidens(k, false, true), false, k);
});

// --- the closed domains ---

test("an ordinary setting's domain refuses what the panel's control would not hold", () => {
    const d = (k) => SETTING_CLASSES[k].domain;
    assert.equal(domainAllows(d("detachedTaskMaxMin"), 61), false);
    assert.equal(domainAllows(d("detachedTaskMaxMin"), 0), false);
    assert.equal(domainAllows(d("detachedTaskMaxMin"), 1.5), false);
    assert.equal(domainAllows(d("pythonIdleMinutes"), 100000), true, "no ceiling");
    assert.equal(domainAllows(d("pythonIdleMinutes"), -1), false);
    assert.equal(domainAllows(d("electricityPerKwh"), Number.NaN), false);
    assert.equal(domainAllows(d("electricityPerKwh"), "0.3"), false);
    assert.equal(domainAllows(d("theme"), "neon"), false);
    assert.equal(domainAllows(d("autoTitles"), "true"), false);
    assert.equal(domainAllows(d("electricityCurrency"), "USD"), true);
    for (const v of ["usd", "XXXX", "https://e.example/", "", 1]) assert.equal(domainAllows(d("electricityCurrency"), v), false, String(v));
    assert.equal(domainAllows(d("model"), "anything"), null, "a model name is the caller's to check against the server");
    for (const v of ["23-7", "0-6", "9-17"]) assert.equal(hoursOk(v), true, v);
    for (const v of ["7-7", "24-1", "23-7 ", " 23-7", "23 - 7", "a-b", "23-7\n", 237, ""]) assert.equal(hoursOk(v), false, JSON.stringify(v));
});

// --- the restore preview: every guarded, gate and secret setting listed apart (a backup written before) ---

test("a backup an older version wrote, changing every setting, lists the 30 guarded, gate and secret ones apart with what each does", () => {
    const payload = JSON.parse(readFileSync(new URL("./fixtures/backup/settings-every-key-v1.json", import.meta.url), "utf8"));
    const plan = planRestore(payload, { sync: { ...DEFAULT_CONFIG, apiKey: "sk-mine" }, local: { ml_site_schema: SITE_SCHEMA } });
    const sync = plan.changes.filter((c) => c.area === "sync");
    const risky = sync.filter((c) => c.group === "risky").map((c) => c.key).sort();
    // Written before shellRevealsAllow, taskNotifyOnly and taskTurnChainMax existed, so it changes every key but those,
    // which the restore leaves as they are.
    const LATER = ["shellRevealsAllow", "taskNotifyOnly", "taskTurnChainMax"];
    assert.deepEqual(risky, KEYS.filter((k) => SETTING_CLASSES[k].class !== "ordinary" && !LATER.includes(k)).sort());
    assert.equal(risky.length, 30);
    for (const k of LATER) assert.equal(sync.some((c) => c.key === k), false, `a backup without ${k} changes nothing of it`);
    for (const c of sync) {
        if (c.group === "risky") assert.equal(c.why, restoreListsApart(c.key), c.key);
        else assert.equal(SETTING_CLASSES[c.key].class, "ordinary", c.key);
    }
    // The 17 the restore listed apart before keep its sentences word for word.
    const by = Object.fromEntries(sync.map((c) => [c.key, c.why]));
    assert.deepEqual({ chatUrl: by.chatUrl, shellSandbox: by.shellSandbox, autoApproveSelfSource: by.autoApproveSelfSource, modelFilter: by.modelFilter, execDefaultWorld: by.execDefaultWorld }, {
        chatUrl: "requests, and the saved API key, go to this address",
        shellSandbox: "whether ml.sh runs inside a sandbox",
        autoApproveSelfSource: "reads the agent's own source without asking",
        modelFilter: "the whitelist of models a page or run may use; clearing it allows every model the server offers",
        execDefaultWorld: "which world page scripts run in",
    });
});
