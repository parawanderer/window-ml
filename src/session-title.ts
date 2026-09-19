// session-title.ts — how a session's short title is asked for and cleaned up, shared by the runtime (which titles the
// sessions it keeps, so every device shows one name) and the sidebar (which still titles what the runtime does not).
// One prompt, so the two never phrase titles differently.

/** The longest title a runtime keeps, whether generated or typed. */
export const TITLE_MAX = 80;

/** The side call that asks the utility model for a title. */
export function titleMessages(prompt: string): { role: "system" | "user"; content: string }[] {
    const p = prompt.length > 500 ? `${prompt.slice(0, 499)}…` : prompt;
    return [
        { role: "system", content: "You write terse 3-6 word titles for a request. Reply with ONLY the title — no quotes, no trailing punctuation, no preamble." },
        { role: "user", content: `Summarise this request as a short title:\n\n${p}` },
    ];
}

/** A model's reply as a title: its first non-empty line, quotes and trailing punctuation stripped, capped. */
export function cleanTitle(raw: string, max = 60): string {
    const line = raw.trim().split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
    return capTitle(line.replace(/^["'`*]+|["'`*.]+$/g, "").trim(), max);
}

/** A title as a runtime stores it: whitespace collapsed, capped with an ellipsis. Empty stays empty. */
export function capTitle(raw: string, max = TITLE_MAX): string {
    const t = raw.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
