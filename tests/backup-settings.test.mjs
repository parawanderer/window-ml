// Collecting, reading, previewing and applying a settings backup (src/backup/backup-settings.ts): the API-key rule, an
// old-shape payload read through the upgrades a stored value gets, the preview listing newly approved sites first, and an
// apply that writes exactly what the preview listed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG_ENUMS, SettingsError, applyRestore, collectSettings, parseSettings, planRestore, previewRestore, upgradeSettings, PAYLOAD_LIMITS } from "../src/backup/backup-settings.ts";
import { DEFAULT_CONFIG } from "../src/contract/contract-config.ts";
import { SITE_SCHEMA } from "../src/site-access.ts";

const fixture = () => readFileSync(new URL("./fixtures/backup/settings-pre-slice3.json", import.meta.url), "utf8");
const policy = (id, effect = "allow", over = {}) => ({ id, scope: "global", consumer: "fetch", effect, source: "(c) => true", label: `policy ${id}`, origin: "person", created: 1, ...over });

/** A writer over plain objects, recording each call. */
function memoryStorage(initial = { sync: {}, local: {} }) {
    const state = { sync: { ...initial.sync }, local: { ...initial.local } };
    const calls = [];
    return { state, calls, writer: { async set(area, items) { calls.push([area, Object.keys(items).sort()]); Object.assign(state[area], JSON.parse(JSON.stringify(items))); } } };
}

// --- collecting: the API-key rule ---

const stored = () => ({
    sync: { ...DEFAULT_CONFIG, apiKey: "sk-secret", model: "m1", notAConfigKey: 1 },
    local: { ml_debug_fontscale: 1.5, ml_hub_log: [1], ml_bgrun_x: {}, ml_site_always: ["https://a.test"], ml_site_agents: { "https://a.test": "ask" }, ml_site_schema: SITE_SCHEMA, ml_unknown_future: 1, ml_policies_global: [policy("p1")] },
    session: { ml_site_session: ["https://s.test"] },
});

test("an encrypted backup carries the API key; a plain one leaves it out and says so", () => {
    const enc = collectSettings(stored(), { encrypted: true });
    assert.equal(enc.payload.sync.apiKey, "sk-secret");
    assert.equal(enc.payload.apiKeyIncluded, true);
    assert.equal(enc.apiKeyOmitted, false);
    const plain = collectSettings(stored(), { encrypted: false });
    assert.equal("apiKey" in plain.payload.sync, false);
    assert.equal(plain.payload.apiKeyIncluded, false);
    assert.equal(plain.apiKeyOmitted, true);
    assert.ok(!JSON.stringify(plain.payload).includes("sk-secret"));
    const forced = collectSettings(stored(), { encrypted: false, includeApiKey: true });
    assert.equal(forced.payload.sync.apiKey, "sk-secret");
});

test("an empty API key is not 'omitted': there was nothing to leave out", () => {
    const s = stored();
    s.sync.apiKey = "";
    assert.equal(collectSettings(s, { encrypted: false }).apiKeyOmitted, false);
});

test("collecting takes the backed-up keys only, and reports the keys nobody classified", () => {
    const { payload, unclassified } = collectSettings(stored(), { encrypted: true });
    assert.equal(payload.local.ml_debug_fontscale, 1.5);
    assert.deepEqual(payload.local.ml_site_always, ["https://a.test"]);
    for (const never of ["ml_hub_log", "ml_bgrun_x", "ml_site_session"]) assert.equal(never in payload.local, false, never);
    assert.equal("ml_site_session" in payload.sync, false);
    assert.deepEqual(unclassified, [{ area: "sync", key: "notAConfigKey" }, { area: "local", key: "ml_unknown_future" }]);
    assert.equal(payload.sync.model, "m1");
});

test("a list nobody ever wrote is collected as empty, so a restore can tell 'none' from 'not in this version'", () => {
    const { payload } = collectSettings({ sync: {}, local: {} }, { encrypted: true });
    assert.deepEqual(payload.local.ml_policies_global, []);
    assert.deepEqual(payload.local.ml_site_denied, []);
    assert.deepEqual(payload.local.ml_site_agents, {});
    assert.equal("ml_site_schema" in payload.local, false);
});

test("the payload is a copy: changing storage afterwards does not change it", () => {
    const s = stored();
    const { payload } = collectSettings(s, { encrypted: true });
    s.local.ml_site_always.push("https://later.test");
    assert.deepEqual(payload.local.ml_site_always, ["https://a.test"]);
});

// --- reading a payload ---

test("a payload that is not ours, too large, from a newer layout or not JSON is refused with a reason", () => {
    const reason = (raw) => { try { parseSettings(raw); } catch (e) { assert.ok(e instanceof SettingsError); return e.reason; } };
    assert.equal(reason("{not json"), "bad-format");
    assert.equal(reason({ format: "something else", v: 1, sync: {}, local: {} }), "bad-format");
    assert.equal(reason({ format: "wml-settings", v: 1, sync: [], local: {} }), "bad-format");
    assert.equal(reason({ format: "wml-settings", sync: {}, local: {} }), "bad-format");
    assert.equal(reason({ format: "wml-settings", v: 2, sync: {}, local: {} }), "newer-version");
    assert.equal(reason("x".repeat(PAYLOAD_LIMITS.bytes + 1)), "too-large");
    assert.equal(reason(null), "bad-format");
});

// --- the upgrade: an old-shape payload (a fixture of what the build before slice 3 wrote) ---

test("an old-shape payload is read through the upgrades a stored value gets", () => {
    const up = upgradeSettings(parseSettings(fixture()));
    // protoStream shipped as a boolean: the worker's own read maps it
    assert.equal(up.sync.protoStream, "auto");
    // site lists: the slice 3 migration (agents "ask" for every approved origin, the whitelist became origins, the marker is set)
    assert.equal(up.local.ml_site_schema, SITE_SCHEMA);
    assert.deepEqual(up.local.ml_site_always, ["https://example.com", "https://old.test"], "an entry that is not an origin is left out");
    assert.deepEqual(up.local.ml_site_agents, { "https://example.com": "ask", "https://old.test": "ask" });
    assert.deepEqual(up.local.ml_site_selfapprove, ["https://dev.example.com", "https://localhost"]);
    assert.deepEqual(up.local.ml_site_denied, ["https://bad.test"]);
    assert.ok(up.notes.some((n) => /upgraded from layout 1 to 2/.test(n)));
    assert.ok(up.notes.some((n) => n.includes("*.wild.test") && n.includes("host.test:8080/path")), "the whitelist entries that trusted nothing are named");
    assert.ok(up.notes.some((n) => /not a site's origin/.test(n)));
    // policies: the worker's validator; the malformed and repeated ones go, and only known fields stay
    assert.deepEqual(up.local.ml_policies_global.map((p) => p.id), ["pol-1"]);
    assert.equal(up.local.ml_policies_global[0].effect, "allow");
    assert.equal("extra" in up.local.ml_policies_global[0], false);
    assert.ok(up.notes.some((n) => /2 policies/.test(n)));
    // drops, each with a reason
    const dropped = Object.fromEntries(up.dropped.map((d) => [`${d.area}:${d.key}`, d.reason]));
    assert.match(dropped["sync:aSettingThisVersionDoesNotHave"], /not a setting/);
    assert.match(dropped["sync:ocrNumCtx"], /wrong type/);
    assert.match(dropped["local:ml_hub_log"], /not restored/);
    assert.match(dropped["local:ml_future_pref"], /not a key this version keeps/);
    // what survives
    assert.equal(up.sync.model, "qwen3:8b");
    assert.equal(up.local.ml_debug_fontscale, 1.2);
});

test("the old payload previews against a modern install: the approvals first, the old whitelist as self-approval", () => {
    const current = { sync: { ...DEFAULT_CONFIG }, local: { ml_site_schema: SITE_SCHEMA } };
    const plan = planRestore(fixture(), current);
    assert.ok(plan.sites[0].becomesApproved);
    const approved = plan.sites.filter((s) => s.becomesApproved).map((s) => s.origin).sort();
    assert.deepEqual(approved, ["https://dev.example.com", "https://example.com", "https://localhost", "https://old.test"], "self-approval implies use");
    // every approval row comes before every row that is not one
    const firstNonApproval = plan.sites.findIndex((s) => !s.becomesApproved);
    assert.ok(firstNonApproval === -1 || plan.sites.slice(firstNonApproval).every((s) => !s.becomesApproved));
    assert.deepEqual(plan.sites.filter((s) => s.gainsSelfApprove).map((s) => s.origin).sort(), ["https://dev.example.com", "https://localhost"]);
    // the denied site is a change too, but not an approval
    assert.ok(plan.sites.some((s) => s.origin === "https://bad.test" && s.use[1] === "denied" && !s.becomesApproved));
});

test("a current-version payload round trips: collected, previewed against the same storage, nothing changes", () => {
    const s = stored();
    const { payload } = collectSettings(s, { encrypted: true });
    const plan = planRestore(payload, { sync: s.sync, local: s.local, session: s.session });
    assert.deepEqual(plan.changes.map((c) => c.key), [], "nothing to write");
    assert.deepEqual(plan.sites, []);
    assert.deepEqual(plan.policies, []);
    assert.ok(plan.unchanged > 40);
});

// --- the preview ---

test("changes are listed with the sites first, then policies, then settings that send traffic or widen what runs, then the rest", () => {
    const current = { sync: { ...DEFAULT_CONFIG, apiKey: "old-key", theme: "light" }, local: { ml_debug_fontscale: 1, ml_site_schema: SITE_SCHEMA, ml_policies_global: [policy("keep"), policy("gone")] } };
    const payload = {
        format: "wml-settings", v: 1, created: "x", apiKeyIncluded: true,
        sync: { theme: "dark", apiKey: "new-key", chatUrl: "https://elsewhere.test/v1", shellEnabled: true, model: "m" },
        local: { ml_debug_fontscale: 2, ml_site_schema: SITE_SCHEMA, ml_site_always: ["https://new.test"], ml_site_denied: [], ml_site_agents: {}, ml_site_selfapprove: [], ml_policies_global: [policy("keep"), policy("fresh")] },
    };
    const plan = planRestore(payload, current);
    assert.deepEqual([...new Set(plan.changes.map((c) => c.group))], ["sites", "policies", "risky", "settings"]);
    const by = Object.fromEntries(plan.changes.map((c) => [c.key, c]));
    assert.equal(by.chatUrl.group, "risky");
    assert.match(by.chatUrl.why, /API key/);
    assert.equal(by.shellEnabled.group, "risky");
    assert.equal(by.theme.kind, "changed");
    assert.equal(by.model.kind, "changed");   // "" -> "m"
    assert.equal(by.ml_site_always.kind, "added");
    assert.equal("ml_site_denied" in by, false, "a list that was never written and a backup that says none agree");
    // the credential never appears in the text shown for it
    assert.deepEqual(by.apiKey.shown, { before: "(set)", after: "(set)" });
    assert.ok(!JSON.stringify(plan.changes.map((c) => c.shown)).includes("new-key"));
    assert.deepEqual(plan.policies.map((p) => [p.id, p.kind]), [["fresh", "added"], ["gone", "removed"]]);
    assert.deepEqual(plan.sites.map((s) => [s.origin, s.becomesApproved]), [["https://new.test", true]]);
});

test("a list the backup holds empty, that is not empty here, is a removal", () => {
    const current = { sync: {}, local: { ml_site_always: ["https://a.test"], ml_site_schema: SITE_SCHEMA } };
    const plan = planRestore({ format: "wml-settings", v: 1, created: "x", apiKeyIncluded: false, sync: {}, local: { ml_site_always: [], ml_site_schema: SITE_SCHEMA } }, current);
    assert.equal(plan.changes.find((c) => c.key === "ml_site_always").kind, "removed");
    assert.deepEqual(plan.sites.map((s) => [s.origin, s.use]), [["https://a.test", ["always", "unknown"]]]);
});

test("a key the backup does not carry is left alone, never removed", () => {
    const current = { sync: { ...DEFAULT_CONFIG, model: "mine" }, local: { ml_debug_fontscale: 1, ml_site_always: ["https://a.test"], ml_policies_global: [policy("p")] } };
    const plan = planRestore({ format: "wml-settings", v: 1, created: "x", apiKeyIncluded: false, sync: { theme: "dark" }, local: {} }, current);
    assert.deepEqual(plan.changes.map((c) => c.key), ["theme"]);
});

test("a site allowed only for this browser session is not 'newly approved' when the backup approves it for good", () => {
    const current = { sync: {}, local: { ml_site_schema: SITE_SCHEMA }, session: { ml_site_session: ["https://s.test"] } };
    const plan = planRestore({ format: "wml-settings", v: 1, created: "x", apiKeyIncluded: false, sync: {}, local: { ml_site_schema: SITE_SCHEMA, ml_site_always: ["https://s.test"] } }, current);
    assert.deepEqual(plan.sites.map((s) => [s.origin, s.use, s.becomesApproved]), [["https://s.test", ["session", "always"], false]], "it could use window.ml and still can; only how long it lasts changes");
    assert.deepEqual(plan.changes.map((c) => c.key), ["ml_site_always"]);
});

test("an origin in the site lists that is not an origin never reaches storage", () => {
    const payload = { format: "wml-settings", v: 1, created: "x", apiKeyIncluded: false, sync: {}, local: { ml_site_schema: SITE_SCHEMA, ml_site_always: ["javascript:alert(1)", "https://ok.test/path", "https://ok.test", "file:///etc/passwd"], ml_site_agents: { "https://ok.test": "always", "evil": "always", "https://x.test": "root" } } };
    const up = upgradeSettings(parseSettings(payload));
    assert.deepEqual(up.local.ml_site_always, ["https://ok.test"]);
    assert.deepEqual(up.local.ml_site_agents, { "https://ok.test": "always" });
});

test("a newer site layout is not guessed at: its site keys are dropped with the reason", () => {
    const payload = { format: "wml-settings", v: 1, created: "x", apiKeyIncluded: false, sync: {}, local: { ml_site_schema: SITE_SCHEMA + 1, ml_site_always: ["https://a.test"], ml_debug_fontscale: 2 } };
    const up = upgradeSettings(parseSettings(payload));
    assert.equal("ml_site_always" in up.local, false);
    assert.equal(up.local.ml_debug_fontscale, 2);
    assert.ok(up.dropped.some((d) => d.key === "ml_site_always" && /newer layout/.test(d.reason)));
});

// --- hostile payloads ---

test("a payload cannot name its own keys: __proto__, the never-restored keys, oversize values and wrong types are dropped", () => {
    const text = `{"format":"wml-settings","v":1,"sync":{"__proto__":{"polluted":1},"constructor":1,"theme":{"x":1},"model":${JSON.stringify("m".repeat(PAYLOAD_LIMITS.value + 1))}},"local":{"ml_bgrun_abc":{"p":1},"ml_session_deadbeef":{"messages":[]},"ml_run_log":[],"__proto__":[]}}`;
    const up = upgradeSettings(parseSettings(text));
    assert.deepEqual(up.sync, {});
    assert.deepEqual(up.local, {});
    assert.equal({}.polluted, undefined);
    assert.equal(up.dropped.length, 8, "four in sync, four in local");
    const plan = previewRestore(up, { sync: {}, local: {} });
    assert.deepEqual(plan.changes, []);
});

test("the API key arrives only if the backup carried it, and a restore of a plain backup keeps the key already here", () => {
    const current = { sync: { ...DEFAULT_CONFIG, apiKey: "mine" }, local: {} };
    const plain = collectSettings({ sync: { ...DEFAULT_CONFIG, apiKey: "theirs", theme: "dark" }, local: {} }, { encrypted: false });
    const plan = planRestore(plain.payload, current);
    assert.equal(plan.changes.some((c) => c.key === "apiKey"), false);
    assert.equal(plan.apiKeyIncluded, false);
});

// --- applying ---

test("apply writes exactly the preview's keys and values, one set per area, with the site layout marker alongside the lists", async () => {
    const m = memoryStorage({ sync: { ...DEFAULT_CONFIG }, local: { ml_debug_fontscale: 1 } });
    const plan = planRestore(fixture(), { sync: m.state.sync, local: m.state.local });
    const before = JSON.stringify(m.state);
    const done = await applyRestore(plan, m.writer);
    assert.deepEqual(m.calls.map(([a]) => a), ["sync", "local"]);
    assert.deepEqual(done.sync.sort(), plan.changes.filter((c) => c.area === "sync").map((c) => c.key).sort());
    assert.deepEqual(done.local.sort(), plan.changes.filter((c) => c.area === "local").map((c) => c.key).sort());
    assert.ok(done.local.includes("ml_site_schema") && done.local.includes("ml_site_always"), "lists and marker in the same write");
    for (const c of plan.changes) assert.deepEqual(m.state[c.area][c.key], c.after);
    // nothing outside the preview changed
    const changedKeys = new Set(plan.changes.map((c) => `${c.area}:${c.key}`));
    const prev = JSON.parse(before);
    for (const area of ["sync", "local"]) for (const k of Object.keys(prev[area])) if (!changedKeys.has(`${area}:${k}`)) assert.deepEqual(m.state[area][k], prev[area][k]);
    for (const area of ["sync", "local"]) for (const k of Object.keys(m.state[area])) assert.ok(k in prev[area] || changedKeys.has(`${area}:${k}`), `${k} was written without being previewed`);
    // never-restored keys did not sneak in
    assert.equal("ml_hub_log" in m.state.local, false);
});

test("applying twice changes nothing the second time", async () => {
    const m = memoryStorage({ sync: { ...DEFAULT_CONFIG }, local: {} });
    await applyRestore(planRestore(fixture(), m.state), m.writer);
    const again = planRestore(fixture(), m.state);
    assert.deepEqual(again.changes, []);
    assert.deepEqual(again.sites, []);
    m.calls.length = 0;
    await applyRestore(again, m.writer);
    assert.deepEqual(m.calls, [], "an empty plan writes nothing");
});

test("a backup round trip through apply restores the settings it collected", async () => {
    const s = stored();
    const { payload } = collectSettings(s, { encrypted: true });
    const fresh = memoryStorage({ sync: { ...DEFAULT_CONFIG }, local: {} });
    await applyRestore(planRestore(payload, fresh.state), fresh.writer);
    assert.equal(fresh.state.sync.model, "m1");
    assert.equal(fresh.state.sync.apiKey, "sk-secret");
    assert.deepEqual(fresh.state.local.ml_site_always, ["https://a.test"]);
    assert.equal(fresh.state.local.ml_debug_fontscale, 1.5);
    assert.deepEqual(fresh.state.local.ml_policies_global.map((p) => p.id), ["p1"]);
});

test("a setting that is one of a few words must be one of them", () => {
    for (const [key, words] of Object.entries(CONFIG_ENUMS)) assert.ok(words.includes(DEFAULT_CONFIG[key]), `${key}'s default is in its list`);
    const payload = { format: "wml-settings", v: 1, created: "x", apiKeyIncluded: false, sync: { theme: "<script>", debugMode: "overlay", cardCorner: "middle" }, local: {} };
    const up = upgradeSettings(parseSettings(payload));
    assert.deepEqual(up.sync, { debugMode: "overlay" });
    assert.deepEqual(up.dropped.map((d) => d.key).sort(), ["cardCorner", "theme"]);
});
