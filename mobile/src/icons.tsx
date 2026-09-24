// icons.tsx — THE PAGE'S OWN GLYPHS, drawn natively. The same path data as `src/sidebar/icons.tsx`, so a control
// that means one thing looks like one thing on a phone and at a desk.
//
// The app reached for `lucide-react-native` because it was there, and the two sets are near-misses of each other: a
// magnifier with a different handle angle, a gear with a different tooth count, an inbox drawn as a tray rather than
// as a lid. Nothing in a screenshot is wrong, and side by side the app reads as a different product. These are only
// the glyphs that appear on BOTH surfaces in the same place; lucide stays for what is the app's alone.

import Svg, { Circle, Path, Rect } from "react-native-svg";

// The stroke widths are the page's own, unscaled: they are viewBox units, so they follow `size` by themselves.

/** What every glyph here takes: how big, and what colour — the same two the app's `IconButton` already passes. */
export interface IconProps { size?: number; color: string }

/** Search — a magnifier. */
export function IconSearch({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round">
            <Circle cx={11} cy={11} r={6.5} />
            <Path d="M16 16l4.5 4.5" />
        </Svg>
    );
}

/** Compose — a pencil over a page: start something new. */
export function IconCompose({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M11 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-4" />
            <Path d="M17.3 3.9a1.9 1.9 0 0 1 2.8 2.8L12.5 14.3 9.5 15l.7-3z" />
        </Svg>
    );
}

/** Inbox — what needs someone's hand. */
export function IconInbox({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z" />
        </Svg>
    );
}

/** Gear — settings. */
export function IconGear({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <Path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </Svg>
    );
}

/** Camera — what a tab looks like right now. */
export function IconCamera({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M2.5 8.6A2.1 2.1 0 0 1 4.6 6.5h2.6l1.2-2.3h7.2l1.2 2.3h2.6a2.1 2.1 0 0 1 2.1 2.1v9.2a2.1 2.1 0 0 1-2.1 2.1H4.6a2.1 2.1 0 0 1-2.1-2.1z" />
            <Circle cx={12} cy={13.1} r={3.9} />
        </Svg>
    );
}

/** Pin — keep this at the top. */
export function IconPin({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M9 3.5h6l-1 5.5 3.5 3.5v1.5h-11V12.5L10 9z" />
            <Path d="M12 14v6.5" />
        </Svg>
    );
}

/** Copy — take this away as text. Drawn on the page's 16 grid, as its own is. */
export function IconCopy({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
            <Rect x={5.5} y={5.5} width={8} height={8} rx={1.5} />
            <Path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
        </Svg>
    );
}

/** Trash — delete, and it does not come back. */
export function IconTrash({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M4.5 7h15M9.5 7V4.8h5V7" />
            <Path d="M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7" />
            <Path d="M10 11v6M14 11v6" />
        </Svg>
    );
}

/** Export — write this out as a file. */
export function IconExport({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </Svg>
    );
}

/** Play — set something going. The page's Continue is this glyph. */
export function IconPlay({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round">
            <Path d="M8.5 5.6 18 12l-9.5 6.4V5.6Z" />
        </Svg>
    );
}

/** A cross — stop, or close. */
export function IconStop({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round">
            <Path d="M6 6l12 12M18 6L6 18" />
        </Svg>
    );
}

/** A chevron pointing along the row: go there. */
export function IconChevronRight({ size = 22, color }: IconProps) {
    return (
        <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.9}>
            <Path d="M6 3.5L10.5 8L6 12.5" />
        </Svg>
    );
}
