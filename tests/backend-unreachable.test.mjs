"use strict";
// isBackendUnreachable (contract.ts) — the pure detector that tells a DEAD BOX (server down / wrong host /
// refused) apart from an HTTP error (a reachable box that rejected the request). Drives the devtools-panel
// offline banner + the HUD card's distinct "backend unreachable" treatment, so both surfaces flag the same
// condition. A false positive would nag on a normal model error; a false negative hides a dead backend.
import { test } from "node:test";
import assert from "node:assert";
import { isBackendUnreachable } from "../src/contract.ts";

test("the background's translated message is detected", () => {
    assert.equal(isBackendUnreachable("Couldn't reach the server at http://gpubox:11434 (Failed to fetch). Is OpenWebUI / Ollama running there?"), true);
});

test("raw network-level rejects are detected (in case one slips through untranslated)", () => {
    for (const m of ["Failed to fetch", "TypeError: NetworkError when attempting to fetch resource.",
        "net::ERR_CONNECTION_REFUSED", "ECONNREFUSED 127.0.0.1:11434", "getaddrinfo ENOTFOUND gpubox",
        "net::ERR_NAME_NOT_RESOLVED", "Could not reach an Ollama API behind http://x"]) {
        assert.equal(isBackendUnreachable(m), true, m);
    }
});

test("an HTTP status error is NOT unreachable (the box answered)", () => {
    assert.equal(isBackendUnreachable("HTTP 500 from http://x: internal error"), false);
    assert.equal(isBackendUnreachable("HTTP 401 from http://x: unauthorized"), false);
});

test("unrelated errors and empties are not flagged", () => {
    assert.equal(isBackendUnreachable(""), false);
    assert.equal(isBackendUnreachable(null), false);
    assert.equal(isBackendUnreachable(undefined), false);
    assert.equal(isBackendUnreachable("The model returned no content."), false);
    assert.equal(isBackendUnreachable("Tool 'exec' was denied."), false);
});
