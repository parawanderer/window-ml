/**
 * @file Pure validators for window.ml: a minimal JSON-Schema arg check (for the debug
 * view) and the `extend` profile guard. Extracted from injected.ts; no closure state.
 */

import type { JsonSchema, ExtendProfile } from "./contract";

/**
 * Minimal JSON-Schema check of a tool call's args vs the tool's `parameters`
 * (required / type / enum / unknown-property) — catches the model sending a
 * real tool the wrong shape. Not a full validator; enough to flag mistakes in
 * the debug view.
 *
 * @param {JsonSchema | undefined} schema The tool's `parameters` schema.
 * @param {Record<string, unknown>} args The tool call's arguments.
 * @returns {string[]} Human-readable issue strings ([] = clean).
 */
export const validateArgs = (schema: JsonSchema | undefined, args: Record<string, unknown>): string[] => {
    if (!schema || schema.type !== "object" || !schema.properties) return [];
    const props = schema.properties as Record<string, { type?: string; enum?: unknown[] }>;
    const issues: string[] = [];
    for (const req of (schema.required || [])) if (!(req in args)) issues.push(`missing required "${req}"`);
    const jsType = (v: unknown): string => Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    const okType = (v: unknown, t: string): boolean => {
        switch (t) {
            case "string": return typeof v === "string";
            case "integer": return typeof v === "number" && Number.isInteger(v);
            case "number": return typeof v === "number";
            case "boolean": return typeof v === "boolean";
            case "array": return Array.isArray(v);
            case "object": return v != null && typeof v === "object" && !Array.isArray(v);
            default: return true;
        }
    };
    for (const [k, v] of Object.entries(args)) {
        const spec = props[k];
        if (!spec) { issues.push(`unknown property "${k}"`); continue; }
        if (spec.type && !okType(v, spec.type)) issues.push(`"${k}" should be ${spec.type} (got ${jsType(v)})`);
        if (Array.isArray(spec.enum) && !spec.enum.includes(v)) issues.push(`"${k}" not in [${spec.enum.join(", ")}]`);
    }
    return issues;
};

/**
 * Validate the `extend` profile option — throw on anything but a known value.
 *
 * @param {ExtendProfile | null | undefined} extend The profile to validate.
 * @returns {void}
 * @throws {Error} If `extend` is neither "default" nor "utility" (nor null/undefined).
 */
export const validateExtend = (extend: ExtendProfile | null | undefined): void => {
    if (extend != null && extend !== "default" && extend !== "utility")
        throw new Error(`ml: invalid extend "${extend}" — use "default" or "utility".`);
};
