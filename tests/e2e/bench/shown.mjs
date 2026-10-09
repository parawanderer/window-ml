// shown.mjs — a fingerprint of what a run's model was SHOWN (its system prompt and tool schemas), which the scoreboard
// puts in a task's item key (scores.mjs `itemKey`). Its own module because it reads the export's canonicalizer from
// src/ (TypeScript), and scores.mjs runs under plain node.

import { createHash } from "node:crypto";
import { canonicalizeText } from "../../../src/export-schema.ts";

/**
 * A fingerprint of what a run's model was SHOWN: the system prompt and the tool schemas from its session (run.json's
 * `session.config`), 12 hex. What changes between two runs of one build is taken out first: a tool pointer and the
 * session's hash (`canonicalizeText`), the test site's port, and the clock line. A tool the extension describes by the
 * model's own sight (`vision: true`: `look` reads differently to a model that sees images itself) counts by name only,
 * or models on either side of that line would never share an item and the fit could not compare them. So a change to
 * such a tool's wording alone is not a new item. Null without a session.
 */
export function shownFingerprint(session) {
    const c = session?.config;
    if (typeof c?.system !== "string") return null;
    const system = canonicalizeText(c.system, session.hash)
        .replace(/\b(127\.0\.0\.1|localhost):\d+/g, "$1:<port>")
        .replace(/^Now: .*$/gm, "Now: <now>");
    const tools = (c.tools ?? []).map((t) => (t && typeof t === "object" && t.vision ? { name: t.name, vision: true } : t));
    return createHash("sha256").update(JSON.stringify({ system, tools })).digest("hex").slice(0, 12);
}
