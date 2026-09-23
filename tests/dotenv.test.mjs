// The `.env` reader the scripts share (scripts/dotenv.mjs). It is three lines of parsing, and every one of them is a
// case that bit someone: a token containing `=`, a quoted value, a `#` inside a value, and a real environment
// variable that must win over the file.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDotenv, fromEnv } from "../scripts/dotenv.mjs";

/** A `.env` written to a throwaway directory, returning its path. */
function envFile(text) {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "wml-dotenv-")), ".env");
    writeFileSync(file, text);
    return file;
}

test("a missing file is empty, not an error: nothing here guards its own absence", () => {
    assert.deepEqual(readDotenv(path.join(tmpdir(), "wml-dotenv-nope", ".env")), {});
});

test("it splits on the FIRST = only, so a key or a token may contain one", () => {
    const d = readDotenv(envFile("OPENWEBUI_KEY=sk-abc==\nWINDOWML_HUB=wss://h.example:8787\n"));
    assert.equal(d.OPENWEBUI_KEY, "sk-abc==");
    assert.equal(d.WINDOWML_HUB, "wss://h.example:8787");
});

test("comments and blank lines are skipped, and `export ` is not part of the name", () => {
    const d = readDotenv(envFile("# a note\n\nexport A=1\nB=2\nnot-a-pair\n"));
    assert.deepEqual(d, { A: "1", B: "2" });
});

test("one layer of quotes comes off; a # inside a value stays, because it is a value", () => {
    const d = readDotenv(envFile(`A="quoted"\nB='single'\nC=pa#ss\nD="keep \\"inner\\""\n`));
    assert.equal(d.A, "quoted");
    assert.equal(d.B, "single");
    assert.equal(d.C, "pa#ss", "a value is not trimmed at a #: that is a comment only at the start of a line");
    assert.equal(d.D, 'keep \\"inner\\"');
});

test("a real environment variable beats the file, so one command can override a checked-out default", () => {
    const key = "WML_DOTENV_TEST_KEY";
    delete process.env[key];
    assert.equal(fromEnv(key, "fallback"), "fallback");
    process.env[key] = "from-the-environment";
    try {
        assert.equal(fromEnv(key, "fallback"), "from-the-environment");
    } finally {
        delete process.env[key];
    }
});
