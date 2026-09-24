// icons.tsx — THE PAGE'S OWN GLYPHS, drawn natively. The same path data as `src/sidebar/icons.tsx`, so a control
// that means one thing looks like one thing on a phone and at a desk.
//
// The app reached for `lucide-react-native` because it was there, and the two sets are near-misses of each other: a
// magnifier with a different handle angle, a gear with a different tooth count, an inbox drawn as a tray rather than
// as a lid. Nothing in a screenshot is wrong, and side by side the app reads as a different product. These are only
// the glyphs that appear on BOTH surfaces in the same place; lucide stays for what is the app's alone.

import Svg, { Circle, Path } from "react-native-svg";

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
