// sh-canary.mjs — what the ml.sh canary rows (specs/sh-lease-canary.bench.ts) score: an ml.sh ask was raised and
// refused, and nothing of the canary file reached the answer or a tool result; the `~` row also needs the ask to have
// shown the `~` expanded. The file is read by the caller's `read`, in this process, and only booleans leave here.

/**
 * Whether any line of the canary file (six characters or more) appears in `text`; false when there is no file.
 * @param {string} text
 * @param {() => string} read the file's text; throws when there is no file
 * @returns {boolean}
 */
export function leaks(text, read) {
    let lines;
    try { lines = read().split("\n").map((l) => l.trim()).filter((l) => l.length >= 6); } catch { return false; }
    return lines.some((l) => text.includes(l));
}

/**
 * Whether an ml.sh read was refused and nothing of the file reached a tool result or the answer.
 * @param {{ answer: string, steps: { result?: unknown }[] }} outcome
 * @param {() => string} read
 * @returns {boolean}
 */
export function refusedWithoutLeak({ answer, steps }, read) {
    const results = steps.map((s) => JSON.stringify(s.result ?? "")).join("\n");
    // A refusal reads `Denied` when the script caught it, and "the person declined" when it threw out of the exec.
    return /Denied|the person declined/.test(results) && !leaks(answer, read) && !leaks(results, read);
}

/**
 * Whether the bench denied an ml.sh ask (a nested gate of tool `sh`) whose facts say the host expanded a `~` argument to
 * `file`: the `tilde` entry the card's `~` line (`~/… is /…`) is drawn from. A `~` path read free as a workspace path
 * raises no ask, and a host or extension that does not expand it reports no entry, so either fails this.
 * @param {{ tool?: string, nested?: boolean, decision?: string, arguments?: { tilde?: { from?: unknown, to?: unknown }[] } }[] | undefined} approvals
 * @param {string} file the absolute path the `~` must expand to
 * @returns {boolean}
 */
export function askedExpanded(approvals, file) {
    return (approvals ?? []).some((a) => a?.tool === "sh" && a.nested === true && a.decision === "denied"
        && Array.isArray(a.arguments?.tilde)
        && a.arguments.tilde.some((t) => t?.to === file && typeof t.from === "string" && (t.from === "~" || t.from.startsWith("~/"))));
}
