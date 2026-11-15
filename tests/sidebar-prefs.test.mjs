// tests/sidebar-prefs.test.mjs — the panel's remembered prefs coming back at init, against the person's own
// changes while the read is in flight. The stored prefs land on a `chrome.storage.local.get` callback that a
// first wave of panel opens can stretch past a click; what is pinned here is that the restore never yanks
// that click back (the bench stays open), and that the guard is PER KEY — a key nobody touched still
// restores. The rows drive the store directly: `openBench` is the toolbar click, `restorePrefs(d, snap)` is
// the callback arriving later with record `d` and the snapshot `prefsSnapshot` took when the read went out.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { visionChoices, VISION_KEY, prefsSnapshot, restorePrefs, openBench, benchOpen, benchDock, BENCH_OPEN_KEY, BENCH_DOCK_KEY } from "../src/sidebar/store.ts";
import { setComposerVision, COMMANDER_SCOPE } from "../src/sidebar/card/card-state.ts";
import { visionFor, visionKey } from "../src/vision-choice.ts";

// --- a click landing before the restore must survive it ---
test("a click landing before the restore stays open", () => {
    // A fresh profile stores nothing, and the read goes out with the bench shut.
    benchDock.value = "drawer";
    benchOpen.value = false;
    const snap = prefsSnapshot();
    openBench();               // the toolbar click, before the callback lands
    // The callback hands the default-filled record a fresh profile reads back, its remembered open false.
    restorePrefs({ [BENCH_OPEN_KEY]: false }, snap);
    assert.equal(benchOpen.value, true, "the restore must not close a bench the person opened mid-read");
});

// --- an eye click before the restore resolves must survive it ---
test("a vision choice clicked before the restore resolves survives it", () => {
    visionChoices.value = {};
    const snap = prefsSnapshot();
    setComposerVision("gpt-x", false);       // the eye click, before the read lands
    restorePrefs({ [VISION_KEY]: {} }, snap);  // a fresh profile stores nothing
    assert.equal(visionFor(visionChoices.value, COMMANDER_SCOPE, "gpt-x").on, false, "the restore must not revert the click");
});

test("a remembered vision choice still lands when nothing was clicked during the read", () => {
    visionChoices.value = {};
    const snap = prefsSnapshot();
    restorePrefs({ [VISION_KEY]: { [visionKey(COMMANDER_SCOPE, "gpt-x")]: false } }, snap);
    assert.equal(visionFor(visionChoices.value, COMMANDER_SCOPE, "gpt-x").on, false);
});

// --- the guard is per key, never a veto on the whole restore ---
test("what the person changed stays theirs, and what they did not still restores", () => {
    benchDock.value = "drawer";
    benchOpen.value = false;
    const snap = prefsSnapshot();
    openBench();                                      // changes benchOpen while the read is in flight
    restorePrefs({ [BENCH_DOCK_KEY]: "full" }, snap);  // remembers only the dock
    assert.equal(benchOpen.value, true, "the click survives");
    assert.equal(benchDock.value, "full", "the untouched key still restores");
});

test("a remembered open still lands when nothing changed while the read was in flight", () => {
    benchDock.value = "drawer";
    benchOpen.value = false;
    const snap = prefsSnapshot();
    restorePrefs({ [BENCH_OPEN_KEY]: true }, snap);
    assert.equal(benchOpen.value, true);
});

// --- the app's init is the call site; the pin is what reds if it is ever reverted ---
test("app.tsx's init restore goes through restorePrefs", () => {
    const src = readFileSync(new URL("../src/sidebar/app.tsx", import.meta.url), "utf8");
    assert.match(src, /restorePrefs\(d, /);
});
