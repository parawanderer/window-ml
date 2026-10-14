// estimate-line.mjs — the one line a sweep's estimates come to, cloud money and local electricity apart: pure, so the
// terminal, status.md and the live page say it in the same words.

const money = (x, cur) => `${x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(2)} ${cur}`;   // as spend-predict.mjs prints money
const runsN = (n) => `${n} run${n === 1 ? "" : "s"}`;

/**
 * The whole of what the runs left are expected to cost, in one line, cloud and local apart: what a model reading the
 * sweep should quote instead of working it out. Cloud is money at the price service's rates (`forecast`); local is the
 * box's electricity (`energyForecast`), in Wh and, with an electricity price set, money. The runs neither estimate
 * covers are counted, never guessed at; with no price data at all, the cloud is left unsaid. Null with neither estimate,
 * or no run left.
 */
export function estimateLine(f, ef) {
    const left = f?.left ?? ef?.left ?? 0;
    if (!left) return null;
    const cloud = f ? f.left - f.local : null;
    const cloudPart = !f || !cloud ? null
        : cloud - f.unknown ? `cloud about ${money(f.remaining, f.currency)} over ${runsN(cloud - f.unknown)}${f.unknown ? ` (+${runsN(f.unknown)} with no estimate)` : ""}`
        : `cloud: no estimate for its ${runsN(cloud)}`;
    const local = f ? f.local : null;
    const localPart = !ef ? (local ? `local: ${runsN(local)}, no energy on record` : null)
        : `local about ${ef.remainingWh.toFixed(1)} Wh${ef.remainingCost != null ? `, ${money(ef.remainingCost, ef.currency)}` : " (no electricity price set)"}${ef.unknown ? ` (+${runsN(ef.unknown)} with no energy on record)` : ""}`;
    return `estimate for the ${runsN(left)} left: ${[cloudPart, localPart].filter(Boolean).join("; ") || "nothing to estimate"}`;
}
