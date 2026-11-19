// change-setting-glue.test.mjs — the seams around the `change_setting` tool: the host's autoApprove, the loop's reading of a
// worker-sourced decision, re-judging a pending `setting` card, the export of a setting step, and the run log of a write.
// The tool's own checks are tests/change-setting.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import "./stub-css.mjs";   // export.ts imports a bundled .css (hljs theme)

// --- a scripted chrome: sync storage is a real map, so a write can be read back ---
const area = () => { const m = {}; return { get: async (k) => (typeof k === "string" ? { [k]: m[k] } : Array.isArray(k) ? Object.fromEntries(k.filter((x) => x in m).map((x) => [x, m[x]])) : k && typeof k === "object" ? Object.fromEntries(Object.keys(k).map((x) => [x, x in m ? m[x] : k[x]])) : { ...m }), set: async (o) => { Object.assign(m, o); }, remove: async () => {} }; };
globalThis.chrome = {
    storage: { session: area(), local: area(), sync: area(), onChanged: { addListener() {}, removeListener() {} } },
    runtime: { getManifest: () => ({ version: "0" }), onMessage: { addListener() {} }, id: "x" },
    tabs: { get: async () => ({}), sendMessage: async () => {} },
};

const { runBackgroundAgent } = await import("../src/agent/agent-host.ts");
const { runAgentLoop } = await import("../src/agent/agent-loop.ts");
const { pendingApprovals } = await import("../src/sw/sw-consent.ts");
const { addGlobalPolicy, removePolicy } = await import("../src/sw/sw-policies.ts");
const { serializeSession } = await import("../src/sidebar/export/export.ts");
const { changeSettingApproved, holdSettingChange, settingChangedElsewhere } = await import("../src/sw/sw-change-setting.ts");
const { runLog, recordRunLog } = await import("../src/sw/sw-run-log.ts");

// --- agent-host: autoApprove for change_setting (what the worker says before any card) ---

/** Runs one change_setting call through the host; resolves to what the host did with the gate and the tool. */
async function hostCall(settingPolicy) {
    const turns = [{ content: "", tool_calls: [{ id: "c1", name: "change_setting", arguments: { key: "theme", value: "dark" } }] }, { content: "done", tool_calls: [] }];
    let i = 0;
    const out = { approvals: [], delegated: [], done: undefined };
    const deps = {
        callModel: async () => turns[i++] || { content: "done" },
        delegateTool: async (name, args) => { out.delegated.push(name); return { result: "ran" }; },
        approve: async (req) => { out.approvals.push(req); return true; },
        emit: (ev) => { if (ev && ev.tool === "change_setting" && !ev.pending) out.done = ev; },
        ...(settingPolicy ? { settingPolicy } : {}),
    };
    const { result } = await runBackgroundAgent({ task: "t", systemPrompt: "S", tools: [{ name: "change_setting", requiresApproval: true }] }, deps);
    out.result = result;
    return out;
}

test("settingPolicy {refused} denies the call with no card, and the reason is what the model reads", async () => {
    const o = await hostCall(async () => ({ refused: "X" }));
    assert.equal(o.approvals.length, 0, "no card");
    assert.deepEqual(o.delegated, [], "the tool never ran");
    assert.equal(o.done?.approval, "denied");
    assert.match(o.result.transcript[0].result, /X/);
});

test("settingPolicy {allow} consents with the policy's label as the reused grant, and skips the card", async () => {
    const o = await hostCall(async () => ({ allow: "label" }));
    assert.equal(o.approvals.length, 0);
    assert.deepEqual(o.delegated, ["change_setting"]);
    assert.equal(o.done?.approval, "consented");
    assert.deepEqual(o.done?.reused, [{ kind: "policy", detail: "label" }]);
});

test("settingPolicy undefined, or no settingPolicy dep at all, leaves the call to a card", async () => {
    for (const p of [async () => undefined, null]) {
        const o = await hostCall(p);
        assert.equal(o.approvals.length, 1, "the person is asked");
        assert.deepEqual(o.delegated, ["change_setting"], "and the approval let it run");
    }
});

// --- agent-loop: a decision from the worker is a denial ---

function loopDeps(approve) {
    let i = 0;
    const turns = [{ content: "", tool_calls: [{ id: "c1", name: "change_setting", arguments: { key: "theme", value: "dark" } }] }, { content: "ok", tool_calls: [] }];
    const calls = { runTool: [] };
    return { calls, deps: {
        callModel: async () => turns[i++] || { content: "" },
        runTool: async (name) => { calls.runTool.push(name); return { result: "ran" }; },
        approve: async () => approve,
        autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
        emit: () => {},
    } };
}

test("an approval resolved { approved: true, source: 'worker' } is a denial: the tool is not run and the result names the extension", async () => {
    const { deps, calls } = loopDeps({ approved: true, source: "worker" });
    const res = await runAgentLoop("x", { tools: [{ name: "change_setting", requiresApproval: true }] }, deps);
    assert.deepEqual(calls.runTool, []);
    assert.match(res.transcript[0].result, /^Denied by the extension, before the person answered/);
});

test("a worker denial's feedback follows the attribution, exactly as the worker wrote it", async () => {
    const fb = settingChangedElsewhere("shellRoots");
    const { deps } = loopDeps({ approved: true, source: "worker", feedback: fb });
    const res = await runAgentLoop("x", { tools: [{ name: "change_setting", requiresApproval: true }] }, deps);
    assert.ok(res.transcript[0].result.startsWith(`Denied by the extension, before the person answered: ${fb}`), res.transcript[0].result);
});

test("a closed card's text names a shell key, and neither its old nor its new value", () => {
    const t = settingChangedElsewhere("shellRoots");
    assert.match(t, /^shellRoots changed while the card was showing/);
    // No value at all: no path, no list, no JSON.
    assert.doesNotMatch(t, /[\[\]{}"\/]|Users/);
});

// --- rejudgePending: a policy added while a `setting` card waits ---

/** Opens a pending `setting` card whose facts carry `class`; resolves to the decision it gets (or "pending"). */
async function settingCard(klass, runId) {
    const key = `${runId}:1`;
    let decision = "pending";
    pendingApprovals.set(key, {
        resolve: (d) => { decision = d; },
        descriptor: { key, runId, seq: 1, step: 1, tool: "change_setting", arguments: {}, ts: Date.now(), routing: "ui", consumer: "setting",
            facts: { kind: "setting", key: "theme", from: "auto", to: "dark", class: klass, widens: false, effects: "unknown" } },
    });
    return { key, get: () => decision };
}

test("a new global allow of consumer setting answers a pending ORDINARY setting card, as approved by policy", async () => {
    const card = await settingCard("ordinary", "glue-ord");
    const p = addGlobalPolicy({ consumer: "setting", effect: "allow", source: "(c) => true", label: "every setting" });
    try {
        await new Promise((r) => setTimeout(r, 0));
        assert.deepEqual([card.get().approved, card.get().source], [true, "policy"]);
        assert.equal(pendingApprovals.has(card.key), false);
    } finally { removePolicy(p.id); pendingApprovals.delete(card.key); }
});

test("the same allow leaves a pending GUARDED setting card for the person", async () => {
    const card = await settingCard("guarded", "glue-grd");
    const p = addGlobalPolicy({ consumer: "setting", effect: "allow", source: "(c) => true", label: "every setting" });
    try {
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(card.get(), "pending");
        assert.equal(pendingApprovals.has(card.key), true);
    } finally { removePolicy(p.id); pendingApprovals.delete(card.key); }
});

// --- export: a setting step and a denied step's result ---

const session = (steps) => ({ hash: "set1", kind: "agent", model: "m", tag: "session", createdTs: 1, lastTs: 2, status: "ok", turns: [], task: "t", answers: [], steps });

test("a step with a setting render exports 'Change setting', the name and both values", () => {
    const { md } = serializeSession(session([{
        step: 1, localStep: 1, seq: 1, tool: "change_setting", arguments: { key: "theme", value: "dark" }, result: "Changed theme from \"auto\" to \"dark\".",
        renderIn: { type: "setting", key: "theme", name: "Theme", class: "ordinary", from: "auto", to: "dark", synced: true },
    }]));
    assert.match(md, /Change setting/);
    assert.match(md, /Theme/);
    assert.match(md, /auto/);
    assert.match(md, /dark/);
});

test("a denied step's result sentence is in the export", () => {
    const sentence = `Denied by the extension, before the person answered: ${settingChangedElsewhere("theme")}`;
    const { md } = serializeSession(session([{
        step: 1, localStep: 1, seq: 1, tool: "change_setting", arguments: { key: "theme", value: "dark" }, result: sentence, approval: "denied",
        renderIn: { type: "setting", key: "theme", name: "Theme", class: "ordinary", from: "auto", to: "dark", synced: true },
    }]));
    assert.ok(md.includes(sentence), "the sentence is carried verbatim");
});

// --- the run log of a setting change ---

test("a held change that is written records setting/changed with reason person", async () => {
    await chrome.storage.sync.set({ theme: "auto" });
    holdSettingChange("glue-run1", { key: "theme", from: "auto", to: "dark", class: "ordinary", widens: false }, "person");
    const text = await changeSettingApproved("glue-run1", { key: "theme", value: "dark" });
    assert.match(text, /^Changed theme/);
    assert.equal((await chrome.storage.sync.get("theme")).theme, "dark");
    const rec = (await runLog.forRun("glue-run1")).find((r) => r.subsystem === "setting" && r.kind === "changed");
    assert.ok(rec, "a setting/changed record");
    assert.equal(rec.reason, "person");
});

test("a setting/card-closed record with reason worker is kept by the run log", async () => {
    recordRunLog("glue-run2", { subsystem: "setting", kind: "card-closed", reason: "worker", detail: { key: "theme" } });
    const rec = (await runLog.forRun("glue-run2")).find((r) => r.subsystem === "setting" && r.kind === "card-closed");
    assert.ok(rec, "not dropped");
    assert.equal(rec.reason, "worker");
});
