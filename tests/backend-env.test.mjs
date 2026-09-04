"use strict";
// How a `.env` becomes a backend for the observe/bench harnesses.
//
// The wire format is a property of the ENDPOINT rather than of the server — OpenWebUI serves the OpenAI
// shape at /api/chat/completions and a raw Ollama passthrough at /ollama/api/chat — so it cannot be
// inferred from the host and has to be declared. Before this existed the harness appended the OpenAI
// route and hardcoded the OpenAI format, which made ".env.example" untrue where it said "or Ollama":
// a bare Ollama was sent an OpenAI-shaped body at a route it does not serve.

import { test } from "node:test";
import assert from "node:assert/strict";
import { backendFromDotenv } from "../tests/e2e/run-once.mjs";

test("a bare host keeps working exactly as before — no format, no path", () => {
    // The compatibility case, and the one that matters most: every .env written before this change has
    // neither key, and must resolve to precisely what it used to.
    const b = backendFromDotenv({ OPENWEBUI_URL: "http://gpubox:3000", OPENWEBUI_MODEL: "m", OPENWEBUI_KEY: "k" });
    assert.equal(b.chatUrl, "http://gpubox:3000/api/chat/completions");
    assert.equal(b.apiFormat, "openai");
    assert.equal(b.model, "m");
    assert.equal(b.key, "k");
});

test("a trailing slash does not produce a doubled slash", () => {
    assert.equal(backendFromDotenv({ OPENWEBUI_URL: "http://h:3000/" }).chatUrl, "http://h:3000/api/chat/completions");
});

test("ollama format on a bare host gets Ollama's route, not OpenWebUI's", () => {
    const b = backendFromDotenv({ OPENWEBUI_URL: "http://localhost:11434", OPENWEBUI_API_FORMAT: "ollama" });
    assert.equal(b.chatUrl, "http://localhost:11434/api/chat");
    assert.equal(b.apiFormat, "ollama");
});

test("a URL that already names an endpoint is used as given", () => {
    // OpenWebUI's passthrough is neither default route, so it can only be reached by writing it out.
    const b = backendFromDotenv({ OPENWEBUI_URL: "http://h:3000/ollama/api/chat", OPENWEBUI_API_FORMAT: "ollama" });
    assert.equal(b.chatUrl, "http://h:3000/ollama/api/chat");
    assert.equal(b.apiFormat, "ollama");
});

test("a port is not mistaken for a path", () => {
    // The reason this uses `new URL` and not a regex for "does it contain a slash after the host".
    assert.equal(backendFromDotenv({ OPENWEBUI_URL: "http://h:11434" }).chatUrl, "http://h:11434/api/chat/completions");
});

test("an unknown format is refused, loudly, before anything is sent", () => {
    // The failure it prevents is not loud on its own: an unknown route returns OpenWebUI's SPA HTML, so a
    // mismatch surfaces as "the response was not JSON" from deep inside the request path.
    assert.throws(() => backendFromDotenv({ OPENWEBUI_URL: "http://h", OPENWEBUI_API_FORMAT: "openAI-compatible" }),
        /must be "openai" or "ollama"/);
    assert.equal(backendFromDotenv({ OPENWEBUI_URL: "http://h", OPENWEBUI_API_FORMAT: " OpenAI " }).apiFormat, "openai",
        "case and surrounding space are the user being human, not an error");
});

test("E2E_MODEL overrides the file, so one .env can drive a model sweep", () => {
    const b = backendFromDotenv({ OPENWEBUI_URL: "http://h", OPENWEBUI_MODEL: "from-file" }, { E2E_MODEL: "from-env" });
    assert.equal(b.model, "from-env");
});

test("the utility and vision readers come through, since a run needs all three roles", () => {
    const b = backendFromDotenv({ OPENWEBUI_URL: "http://h", OPENWEBUI_UTILITY_MODEL: "u", OPENWEBUI_VISION_MODEL: "v" });
    assert.equal(b.utilityModel, "u");
    assert.equal(b.visionModel, "v");
});
