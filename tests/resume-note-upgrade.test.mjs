// A resume note written BEFORE run policies existed (no `kept`) meets the current code: the index accepts it, the
// reducer stores it, and both exports render it without a "kept" line. The upgrade fixture AGENTS.md asks for.
import "./stub-css.mjs";   // export.ts imports a bundled .css — stub it BEFORE the imports below
import test from "node:test";
import assert from "node:assert/strict";
import { SessionIndex } from "../src/session/session-index.ts";
import { onDebug } from "../src/sidebar/debug-reducer.ts";
import { sessionMap } from "../src/sidebar/store.ts";

const { serializeSession } = await import("../src/sidebar/export/export.ts");
const { sessionToJson } = await import("../src/sidebar/export/export-json.ts");

/** What the code BEFORE run policies wrote into a `session-resumed` event: five `dropped` strings, the last one
 *  claiming all approval grants are asked again, and no `kept`. */
const OLD_RESUME_NOTE = {
    kind: "session-resumed", id: "abcd1234-r1", ts: 174_800_000, save: false, session: { hash: "abcd1234", turn: 0 },
    url: "https://new.example/page", fromUrl: "https://old.example/", afterMs: 172_800_000,
    dropped: [
        "live references to elements on the old page",
        "the page's state object",
        "cached fetches",
        "tools a page script defined (functions cannot be stored)",
        "approval grants (consent belongs to the tab it was given in, and is asked again)",
    ],
};

// --- an old resume note under the current code ---

test("an old resume note is accepted by the index, reduced, and exported without a kept line", () => {
    const ix = new SessionIndex({ runtime: "local", spawn: "w1", now: () => 1000 });
    ix.ingest({ kind: "agent", id: "abcd1234", ts: 1, save: false, session: { hash: "abcd1234", turn: 0 }, task: "t", model: "m", maxSteps: 10, config: null }, { tabId: 1, trusted: true });
    assert.equal(ix.ingest(OLD_RESUME_NOTE, { tabId: 1, trusted: true }).accepted, true);

    sessionMap.clear();
    onDebug({ kind: "agent", session: { hash: "abcd1234" }, ts: 1000, task: "t", model: "m" }, "local");
    onDebug(OLD_RESUME_NOTE, "local");
    const s = sessionMap.get("local:abcd1234");
    assert.equal(s.resumes.length, 1);
    assert.equal("kept" in s.resumes[0], false);

    const { md } = serializeSession(s);
    assert.match(md, /did not survive the resume: .*approval grants \(consent belongs/);
    assert.doesNotMatch(md, /kept across the resume/);
    const r = sessionToJson(s).session.resumes[0];
    assert.equal("kept" in r, false);
    assert.equal(r.dropped.length, 5);
});

test("a resume note with kept is reduced and exported with it", () => {
    sessionMap.clear();
    onDebug({ kind: "agent", session: { hash: "abcd1234" }, ts: 1000, task: "t", model: "m" }, "local");
    onDebug({ ...OLD_RESUME_NOTE, kept: ["fetch https://a.example/x"] }, "local");
    const s = sessionMap.get("local:abcd1234");
    assert.deepEqual(s.resumes[0].kept, ["fetch https://a.example/x"]);
    assert.match(serializeSession(s).md, /kept across the resume: fetch https:\/\/a\.example\/x/);
    assert.deepEqual(sessionToJson(s).session.resumes[0].kept, ["fetch https://a.example/x"]);
});
