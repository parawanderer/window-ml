// user-dynamics.test.mjs — the lab's input-policy model (src/lab/user-dynamics/): the fit, the
// escalation statistic, and that a person's own trajectory scores better than a synthetic one.
import { test } from "node:test";
import assert from "node:assert";
import { DynamicsModel, keyClassOf } from "../src/lab/user-dynamics/user-dynamics.ts";

// --- key classes --------------------------------------------------------------------------------------------------

test("keyClassOf buckets a key the way the interval/hold conditionals are conditioned", () => {
    assert.equal(keyClassOf("a"), "letter");
    assert.equal(keyClassOf("Z"), "letter");
    assert.equal(keyClassOf("7"), "digit");
    assert.equal(keyClassOf(" "), "space");
    assert.equal(keyClassOf("ShiftLeft"), "shift");
    assert.equal(keyClassOf("Enter"), "named");
    assert.equal(keyClassOf("!"), "punct");
});

// --- fitting and the escalation statistic -------------------------------------------------------------------------

/** A trajectory of `n` letter taps `dt` ms apart, each held `hold` ms, clicking at the target centre. */
function typingTraj(n, dt, hold, { jitter = 0, place = [0, 0] } = {}) {
    const events = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
        const j = jitter ? (i % 2 ? jitter : -jitter) : 0;
        events.push({ kind: "down", keyClass: "letter", x: null, y: null, t: t + j, hold: null });
        events.push({ kind: "up", keyClass: "letter", x: null, y: null, t: t + hold + j, hold });
        t += dt;
    }
    events.push({ kind: "click", keyClass: "", x: 100 + place[0], y: 50 + place[1], t: t + 200, hold: null });
    return { tx: 100, ty: 50, tw: 80, th: 30, events };
}

test("a fit from one rhythm scores that rhythm better than a stranger's", () => {
    const m = new DynamicsModel();
    for (let i = 0; i < 8; i++) m.add(typingTraj(12, 140, 70, { jitter: 6 }));
    const fit = m.fit();
    assert.ok(fit.interval.get("letter")?.n >= 8 * 11, "every gap is folded in");
    const mine = m.logLik(typingTraj(12, 140, 70, { jitter: 6 }), fit);
    const stranger = m.logLik(typingTraj(12, 400, 180, { jitter: 80 }), fit);
    assert.ok(mine < stranger, `own rhythm (${mine.toFixed(2)}) should outscore a stranger's (${stranger.toFixed(2)})`);
});

test("logLik is a per-event mean, so length does not punish a trajectory", () => {
    const m = new DynamicsModel();
    for (let i = 0; i < 6; i++) m.add(typingTraj(10, 150, 75));
    const fit = m.fit();
    const short = m.logLik(typingTraj(4, 150, 75), fit);
    const long = m.logLik(typingTraj(20, 150, 75), fit);
    assert.ok(Math.abs(short - long) < 1.5, `short ${short.toFixed(2)} vs long ${long.toFixed(2)} — both near the fitted rhythm`);
});

test("click placement is learned in target-local units", () => {
    const m = new DynamicsModel();
    for (let i = 0; i < 10; i++) m.add(typingTraj(5, 150, 70, { place: [-8, 6] }));
    const fit = m.fit();
    assert.ok(Math.abs(fit.place.mux - (-8) / 80) < 0.15, `mux ${fit.place.mux.toFixed(3)}`);
    assert.ok(Math.abs(fit.place.muy - 6 / 30) < 0.2, `muy ${fit.place.muy.toFixed(3)}`);
    assert.ok(fit.place.n >= 10);
});

test("a move's duration is fit against its distance (log T = α + β log d)", () => {
    const m = new DynamicsModel();
    for (let i = 0; i < 12; i++) {
        const d = 40 + i * 30;
        m.add({
            tx: 100, ty: 50, tw: 80, th: 30,
            events: [
                { kind: "move", keyClass: "move", x: 0, y: 0, t: 0, hold: null },
                { kind: "move", keyClass: "move", x: d, y: 0, t: 120 + 2.2 * d, hold: null },
                { kind: "click", keyClass: "", x: d, y: 0, t: 120 + 2.2 * d, hold: null },
            ],
        });
    }
    const fit = m.fit();
    assert.ok(fit.move.n >= 12);
    assert.ok(fit.move.beta > 0.5, `beta ${fit.move.beta.toFixed(2)} — duration grows with distance`);
});

test("an unseen class falls back to the prior, so logLik never explodes", () => {
    const m = new DynamicsModel();
    m.add(typingTraj(4, 150, 70));
    const τ = typingTraj(3, 150, 70);
    τ.events.push({ kind: "down", keyClass: "punct", x: null, y: null, t: 900, hold: null });
    const L = m.logLik(τ);
    assert.ok(Number.isFinite(L), `finite ${L}`);
});
