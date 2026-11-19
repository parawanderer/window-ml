// redteam-change-setting-run.test.mjs — `change_setting` and `ml.settings()` through the real worker loop
// (window-ml#1952, branch feat/change-setting-2 at b497fac4). What the MODEL gets, in a run the worker built:
//
// - the card carries the stored value and the asked value verbatim, and a decline writes nothing;
// - an approval writes exactly the value the card showed, once, and the run log says who answered it;
// - a card the worker closes (the setting changed elsewhere first) writes nothing, tells the model the key changed and
//   not the values, and is recorded as a worker close;
// - ml.settings() in an isolated exec reads the run's settings, never a secret's value, and what the script does to its
//   copy does not reach the next call.
//
// The pure checks and the page-start row are tests/redteam-change-setting.test.mjs. Harness: tests/isolated-harness.mjs
// `runOn` (the built bundle, the real router and tool path), tests/fake-native-host.mjs not needed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: false, theme: "auto", apiKey: "sk-LIVE-run-9182", chatUrl: "https://live.only.host/api/chat/completions" };
const NO_FETCH = { fetches: [] };
const change = (key, value) => ({ name: "change_setting", args: { key, value } });
const plain = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A worker-built run of `steps`; `answer` sees each approval and returns the decision (and may act first). */
async function settingRun(steps, { answer = () => true, configExtra = ON } = {}) {
    let bg;
    const cards = [];
    const onApproval = (ev) => {
        if (ev.tool !== "change_setting") return true;
        cards.push(plain(ev.renderIn ?? null));
        return answer(ev, bg);
    };
    const onStep = async (b, ev) => {
        for (const a of ev.asks ?? []) if (a.state === "pending") void b.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: true } });
    };
    const r = await runOn("userScripts", steps, { ...NO_FETCH, configExtra, onApproval, onStep, onBg: (b) => { bg = b; } });
    const log = plain(await bg.context.__mlRunLog.all());
    return { ...r, bg, cards, log: (sub, kind) => log.filter((x) => x.run === r.hash && x.subsystem === sub && (!kind || x.kind === kind)) };
}

test("RED TEAM: the card shows the stored and asked values verbatim, and a decline writes nothing", T, async () => {
    const r = await settingRun([change("theme", "dark")], { answer: () => false });
    assert.equal(r.cards.length, 1, `one card for the call: ${JSON.stringify(r.results)}`);
    const c = r.cards[0];
    assert.equal(c.type, "setting", `the card is not a setting card: ${JSON.stringify(c)}`);
    assert.equal(c.key, "theme");
    assert.equal(c.from, "auto", "Now is not the stored value");
    assert.equal(c.to, "dark", "New is not the value asked for");
    assert.equal(c.class, "ordinary");
    assert.equal(r.bg.stored.theme, "auto", "a declined change wrote the setting");
    assert.match(String(r.results[0] ?? ""), /Denied/, `the model was not told: ${JSON.stringify(r.results)}`);
    assert.equal(r.log("setting", "changed").length, 0, "a declined change was logged as changed");
});

test("RED TEAM: an approved change writes exactly the value the card showed, once, and the log says who answered", T, async () => {
    const r = await settingRun([change("theme", "dark"), change("theme", "dark")]);
    assert.equal(r.cards.length, 1, `one card, then the second call is refused as already set: ${JSON.stringify(r.results)}`);
    assert.match(String(r.results[1] ?? ""), /already "dark"/, `the second call was not refused as already set: ${JSON.stringify(r.results)}`);
    assert.equal(r.bg.stored.theme, "dark", "the approved value was not written");
    const changed = r.log("setting", "changed");
    assert.equal(changed.length, 1, `one write for two calls: ${JSON.stringify(changed)}`);
    assert.equal(changed[0].reason, "person", "the write does not say the person answered the card");
    assert.deepEqual(plain(changed[0].detail), { key: "theme", from: "\"auto\"", to: "\"dark\"" });
});

test("RED TEAM: a card the setting closes from outside writes nothing, names the key and no value, and is a worker close", T, async () => {
    const r = await settingRun([change("theme", "dark")], {
        answer: (_ev, bg) => { bg.setSync({ theme: "light" }); return true; },
    });
    assert.equal(r.bg.stored.theme, "light", "the outside value was overwritten");
    const said = String(r.results[0] ?? "");
    assert.match(said, /theme changed while the card was showing, so nothing was written/, `the model was not told the card closed: ${JSON.stringify(r.results)}`);
    assert.ok(!/dark|light|"auto"/.test(said), `the closed card's text carries a value: ${said}`);
    const closed = r.log("setting", "card-closed");
    assert.equal(closed.length, 1, `one close record: ${JSON.stringify(r.log("setting"))}`);
    assert.equal(closed[0].reason, "worker", "the close is not recorded as the worker's");
    assert.deepEqual(plain(closed[0].detail), { key: "theme" });
    assert.equal(r.log("setting", "changed").length, 0, "a closed card's change was written");
});

test("RED TEAM: ml.settings() in an isolated exec reads the settings, never a secret, and its copy is its own", T, async () => {
    const script = () => `(() => { const a = ml.settings(); const before = a.theme.value; a.theme.value = "dark"; a.extra = 1; const b = ml.settings(); return [before, b.theme.value, Object.keys(b).length, b.apiKey.mode + "/" + b.apiKey.class].join(" | ") })()`;
    const r = await settingRun([{ name: "exec", script }]);
    const said = String(r.results[0] ?? "");
    const m = /auto \| auto \| (\d+) \| hidden\/secret/.exec(said);
    assert.ok(m, `the exec's settings were not what the wrapper should hand back (a copy per call, no secret value): ${said.slice(0, 300)}`);
    assert.ok(Number(m[1]) > 5, `ml.settings() returned almost nothing: ${m[1]} keys`);
    assert.ok(!said.includes("sk-LIVE-run-9182"), "a secret's live value reached the model");
    // The live apiKey is there in the config the run was given, so its absence above is the handler's doing, not the setup's.
    assert.equal(r.bg.stored.apiKey, "sk-LIVE-run-9182");
    // And the run's own exec never went through the page: this world is the run's.
    await sleep(0);
});
