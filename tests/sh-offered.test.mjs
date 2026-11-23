// sh-offered.test.mjs — a run the worker builds is offered ml.sh only when the settings turn it on AND a process host
// answers at its start (shellOffered, sw-shell.ts): the prompt's terminal clause and propose_manifest follow that one
// check. The task tool follows it too, but is also offered wherever python_exec is, as it is in these runs.
// docs/dev/shell.md, "A run is offered `ml.sh`".

import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const OFF = { shellEnabled: false, shellRoots: ["/w/proj"] };

/** What the model was sent on the run's first turn: its system prompt and the names of its tools. */
async function firstTurn({ configExtra, onNative }) {
    const r = await runOn("userScripts", [], { fetches: [], configExtra, ...(onNative ? { onNative } : {}) });
    const call = r.bg.calls.find((c) => c.url.includes("/chat/completions"));
    const system = String(call.body.messages.find((m) => m.role === "system")?.content ?? "");
    const tools = (call.body.tools ?? []).map((t) => t.function?.name ?? t.name);
    return { system, tools };
}

const SHELL_CLAUSE = /You may have terminal \(shell\) access/;

/** Asserts the run was not offered ml.sh. */
function notOffered({ system, tools }) {
    assert.doesNotMatch(system, SHELL_CLAUSE, "no terminal clause");
    assert.doesNotMatch(system, /ml\.sh/, "the prompt never names ml.sh");
    assert.ok(!tools.includes("propose_manifest"), "no propose_manifest");
}

// --- the settings and the host, both required ---

test("ACCEPTANCE: the setting on with no host installed offers no ml.sh: no clause, no propose_manifest", T, async () => {
    notOffered(await firstTurn({ configExtra: ON }));
});

test("the setting off with a host installed offers no ml.sh, and the host is not even asked", T, async () => {
    const host = fakeNativeHost({ landlockAbi: null });
    notOffered(await firstTurn({ configExtra: OFF, onNative: host.onNative }));
    assert.deepEqual(host.names(), [], "nothing was sent to the host");
});

test("the setting on and a host that answers: the clause, propose_manifest and the task tool", T, async () => {
    const host = fakeNativeHost({ landlockAbi: null });
    const { system, tools } = await firstTurn({ configExtra: ON, onNative: host.onNative });
    assert.match(system, SHELL_CLAUSE);
    assert.ok(tools.includes("propose_manifest"), `propose_manifest offered: ${tools}`);
    assert.ok(tools.includes("task"), `task offered: ${tools}`);
    assert.ok(host.names().includes("hello"), "the host was asked at the run's start");
});

test("a host that connects and never answers its hello counts as absent once the wait runs out", T, async () => {
    const silent = (name) => (name === "com.parawanderer.window_ml_host" ? () => { /* never replies */ } : null);
    notOffered(await firstTurn({ configExtra: ON, onNative: silent }));
});
