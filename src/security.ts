// Scan model-written strings (esp. exec source) for invisible / bidi / format-
// control characters — the vector for Trojan-Source and homoglyph prompt-injection.
// Surfaced in the approval prompt so a human can catch a hidden payload before
// allowing a call. Pure; bundled into injected.js.

const SUSPICIOUS_CHARS: { [key: number]: string } = {
    0x202A: "LEFT-TO-RIGHT EMBEDDING", 0x202B: "RIGHT-TO-LEFT EMBEDDING",
    0x202C: "POP DIRECTIONAL FORMATTING", 0x202D: "LEFT-TO-RIGHT OVERRIDE",
    0x202E: "RIGHT-TO-LEFT OVERRIDE", 0x2066: "LEFT-TO-RIGHT ISOLATE",
    0x2067: "RIGHT-TO-LEFT ISOLATE", 0x2068: "FIRST STRONG ISOLATE",
    0x2069: "POP DIRECTIONAL ISOLATE", 0x200E: "LEFT-TO-RIGHT MARK",
    0x200F: "RIGHT-TO-LEFT MARK", 0x061C: "ARABIC LETTER MARK",
    0x200B: "ZERO WIDTH SPACE", 0x200C: "ZERO WIDTH NON-JOINER",
    0x200D: "ZERO WIDTH JOINER", 0x2060: "WORD JOINER",
    0xFEFF: "ZERO WIDTH NO-BREAK SPACE (BOM)", 0x00AD: "SOFT HYPHEN",
    0x180E: "MONGOLIAN VOWEL SEPARATOR"
};

/**
 * Scan a string for suspicious/bidi/format-control characters.
 * Returns [{ index, code, name }]. Also flags other C0/C1 control chars
 * (except tab/newline/CR, which are normal).
 *
 * @param {string} str The string to scan.
 * @returns {Array<{index: number, code: string, name: string}>} Array of findings.
 */
export const suspiciousChars = (str: string): { index: number; code: string; name: string }[] => {
    const out: { index: number; code: string; name: string }[] = [];
    const s = String(str == null ? "" : str);
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        let name = SUSPICIOUS_CHARS[code];
        if (!name && (code <= 0x08 || code === 0x0B || code === 0x0C ||
            (code >= 0x0E && code <= 0x1F) || (code >= 0x7F && code <= 0x9F))) {
            name = "CONTROL CHARACTER";
        }
        if (name) out.push({ index: i, code: "U+" + code.toString(16).toUpperCase().padStart(4, "0"), name });
    }
    return out;
};

/**
 * Generate a warning banner for the approval prompt when any string arg hides suspicious chars.
 *
 * @param {Object} args The arguments object to check.
 * @returns {string} Warning banner if suspicious chars found, empty string otherwise.
 */
export const suspiciousArgsWarning = (args: unknown): string => {
    const findings: { index: number; code: string; name: string }[] = [];
    for (const v of Object.values(args || {})) {
        if (typeof v === "string") findings.push(...suspiciousChars(v));
    }
    if (!findings.length) return "";
    const names = [...new Set(findings.map(f => f.name))].slice(0, 4).join(", ");
    return `⚠ WARNING: ${findings.length} hidden/suspicious character(s) — ${names} ` +
        `— possible prompt-injection. Inspect carefully before allowing.\n\n`;
};
