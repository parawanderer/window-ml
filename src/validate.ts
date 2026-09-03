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
    // No object schema, or an EMPTY `properties` (defineTool's default when a tool
    // declares none) → treat as "schema not specified" and skip: we can't know an
    // arg is "unknown" against a tool that never declared its shape, and blocking on
    // that would reject legitimate calls to schema-less tools.
    if (!schema || schema.type !== "object" || !schema.properties || !Object.keys(schema.properties).length) return [];
    const props = schema.properties as Record<string, { type?: string; enum?: unknown[]; oneOf?: { type?: string }[]; anyOf?: { type?: string }[] }>;
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
    // A property may be a UNION (`oneOf`/`anyOf`) rather than one `type` — python_exec's `tables` is "a source
    // string OR a { name: source } map". Reading only `spec.type` meant a union property was validated as
    // NOTHING AT ALL: an array, a number and null all passed silently, and `tables: ["current"]` then reached
    // the tool, where Object.keys(["current"]) is ["0"] and the model was told `"0" isn't a valid Python
    // variable name` — a message about a name it never wrote, which it could not act on.
    // Only checked when EVERY branch names a type; a branch without one means "anything", so there is nothing
    // to assert. Still not a full validator (no per-branch shape checking) — see the file header.
    const unionTypes = (spec: { oneOf?: { type?: string }[]; anyOf?: { type?: string }[] }): string[] | null => {
        const branches = Array.isArray(spec.oneOf) ? spec.oneOf : Array.isArray(spec.anyOf) ? spec.anyOf : null;
        if (!branches?.length) return null;
        const types = branches.map(b => b?.type).filter((t): t is string => typeof t === "string");
        return types.length === branches.length ? types : null;
    };
    for (const [k, v] of Object.entries(args)) {
        const spec = props[k];
        if (!spec) { issues.push(`unknown property "${k}"`); continue; }
        if (spec.type && !okType(v, spec.type)) issues.push(`"${k}" should be ${spec.type} (got ${jsType(v)})`);
        const union = spec.type ? null : unionTypes(spec);
        if (union && !union.some(t => okType(v, t))) issues.push(`"${k}" should be ${union.join(" or ")} (got ${jsType(v)})`);
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
