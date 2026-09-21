// ui.tsx — THE APP'S SMALL PIECES, drawn after the phone-width chat page: the round icon button (`.hbtn` there), the
// pill (`.tp-pill`), a count badge (`.chat-appr-badge`), a status dot, a toast, and the bottom sheet every picker and
// menu opens in. Each takes the palette, so light and dark come from one place (theme.ts).

import { forwardRef, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ActivityIndicator, Animated, Platform, Pressable, StyleSheet, Text, TextInput, View, type PressableProps, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, BottomSheetTextInput, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { Check, ChevronDown, Search, X } from "lucide-react-native";
import { SIZE, usePalette, type Palette } from "./theme";

/** A round icon-only button, 44pt: the page's header buttons. `label` is its accessible name. */
export function IconButton({ icon, label, onPress, tint, filled, disabled, style }: {
    icon: (color: string) => ReactNode; label: string; onPress?: () => void; tint?: string; filled?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
    const p = usePalette();
    const color = disabled ? p.fgFaint : tint ?? (filled ? p.accentFg : p.fg);
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={4}
            style={({ pressed }) => [s.iconButton, filled && { backgroundColor: disabled ? p.panel2 : p.fg }, pressed && { backgroundColor: filled ? p.fgDim : p.panel2 }, style]}>
            {icon(filled && !disabled ? p.bg : color)}
        </Pressable>
    );
}

/** A pill that opens a picker: its value, and a caret. `mono` sets the value in the code face, as a model name is. */
export function Pill({ text, onPress, mono, disabled, label }: { text: string; onPress?: () => void; mono?: boolean; disabled?: boolean; label: string }) {
    const p = usePalette();
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
            style={({ pressed }) => [s.pill, { backgroundColor: pressed ? p.panel2 : p.panel }]}>
            <Text numberOfLines={1} style={[s.pillText, { color: p.fg }, mono && s.mono]}>{text}</Text>
            {onPress ? <ChevronDown size={15} color={p.fgDim} /> : null}
        </Pressable>
    );
}

/** A count of things waiting on the person, in the notice colour. */
export function Badge({ n, label }: { n: number; label?: string }) {
    const p = usePalette();
    if (n <= 0) return null;
    return (
        <View style={[s.badge, { backgroundColor: p.notice }]} accessibilityLabel={label ?? `${n} waiting`}>
            <Text style={[s.badgeText, { color: p.noticeFg }]}>{n}</Text>
        </View>
    );
}

/** A small dot: online (ok), connecting (dimmed), offline (faint). */
export function Dot({ tone }: { tone: "ok" | "wait" | "off" }) {
    const p = usePalette();
    return <View style={[s.dot, { backgroundColor: tone === "ok" ? p.ok : tone === "wait" ? p.warn : p.fgFaint }]} />;
}

/** A toast at the bottom: a failed command, and the like. Fades in, stays four seconds, fades out. */
export function Toast({ notice, bottom }: { notice: { id: number; text: string; tone: "error" | "info" } | null; bottom: number }) {
    const p = usePalette();
    const a = useRef(new Animated.Value(0)).current;
    useEffect(() => {
        if (!notice) return;
        if (notice.tone === "error") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        a.setValue(0);
        Animated.sequence([
            Animated.timing(a, { toValue: 1, duration: 180, useNativeDriver: true }),
            Animated.delay(4000),
            Animated.timing(a, { toValue: 0, duration: 220, useNativeDriver: true }),
        ]).start();
    }, [notice?.id]);
    if (!notice) return null;
    return (
        <Animated.View pointerEvents="none" style={[s.toast, { bottom, backgroundColor: p.scheme === "dark" ? p.panel2 : p.fg, opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
            <Text style={{ color: p.scheme === "dark" ? p.fg : p.bg, fontSize: SIZE.small, lineHeight: 19 }}>{notice.text}</Text>
        </Animated.View>
    );
}

/** A bottom sheet: the page's picker lists, as a phone opens them. Present it with `ref.current?.present()`. */
export const Sheet = forwardRef<BottomSheetModal, { title?: string; children: ReactNode; note?: string; header?: ReactNode; tall?: boolean }>(function Sheet({ title, children, note, header, tall }, ref) {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const backdrop = useMemo(() => (props: BottomSheetBackdropProps) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} />, []);
    return (
        // `accessible={false}`: the library makes the sheet ONE accessibility element ("Bottom Sheet") by default,
        // which hides every row inside it from VoiceOver, TalkBack and anything that drives the app by name.
        // `tall`: a sheet with a filter takes a fixed, tall height instead of hugging its content, so the results stay
        // on screen while the keyboard is up and the list does not resize under the thumb on every keystroke.
        <BottomSheetModal ref={ref} accessible={false} enableDynamicSizing={!tall} maxDynamicContentSize={560}
            snapPoints={tall ? ["88%"] : undefined} topInset={insets.top + 8} keyboardBehavior="interactive" keyboardBlurBehavior="restore" backdropComponent={backdrop}
            backgroundStyle={{ backgroundColor: p.bg }} handleIndicatorStyle={{ backgroundColor: p.panel2, width: 40 }}>
            {/* The title and anything sticky (a filter) sit ABOVE the scroller, so a long list scrolls under them
                rather than carrying them away. */}
            {title ? <Text style={[s.sheetTitle, { color: p.fg }]}>{title}</Text> : null}
            {note ? <Text style={[s.sheetNote, { color: p.fgDim, backgroundColor: p.panel }]}>{note}</Text> : null}
            {header}
            <BottomSheetScrollView contentContainerStyle={s.sheetBody}>
                {children}
            </BottomSheetScrollView>
        </BottomSheetModal>
    );
});

/**
 * A sheet's filter field, for a list too long to scroll through (a box with fifty models). Give it to `Sheet` as its
 * `header` so it stays put while the list moves under it.
 */
export function SheetFilter({ value, onChangeText, placeholder }: { value: string; onChangeText: (t: string) => void; placeholder: string }) {
    const p = usePalette();
    return (
        <View style={[s.filter, { backgroundColor: p.panel }]}>
            <Search size={17} color={p.fgFaint} />
            {/* The sheet's own input, so typing in it keeps the sheet above the keyboard. */}
            {/* `testID` so a Maestro flow can reach it: a placeholder is not in the accessibility tree on either side. */}
            <BottomSheetTextInput testID="sheet-filter" value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={p.fgFaint} autoCapitalize="none"
                autoCorrect={false} returnKeyType="search" accessibilityLabel={placeholder} style={[s.filterInput, { color: p.fg }]} />
            {value ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Clear the filter" onPress={() => onChangeText("")} hitSlop={10}>
                    <X size={17} color={p.fgDim} />
                </Pressable>
            ) : null}
        </View>
    );
}

/** One row of a sheet: a title, an optional line under it, and a check when it is the chosen one. */
export function SheetRow({ title, detail, chosen, disabled, onPress, mono, danger }: {
    title: string; detail?: string; chosen?: boolean; disabled?: boolean; onPress?: () => void; mono?: boolean; danger?: boolean;
} & Pick<PressableProps, "onPress">) {
    const p = usePalette();
    return (
        <Pressable accessibilityRole="button" accessibilityState={{ selected: !!chosen, disabled: !!disabled }} disabled={disabled} onPress={onPress}
            style={({ pressed }) => [s.sheetRow, pressed && { backgroundColor: p.panel }]}>
            <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[s.sheetRowTitle, { color: danger ? p.err : disabled ? p.fgFaint : p.fg }, mono && s.mono]}>{title}</Text>
                {detail ? <Text style={[s.sheetRowDetail, { color: p.fgDim }]}>{detail}</Text> : null}
            </View>
            {chosen ? <Check size={20} color={p.accent} /> : null}
        </Pressable>
    );
}

/** A text button in the page's pill shape (`.pair-card .btn`): `primary` is filled, the rest outlined. `busy` shows a
 *  spinner and refuses taps, so an action that talks to the hub cannot be sent twice. */
export function Button({ title, onPress, primary, danger, disabled, busy, small }: { title: string; onPress?: () => void; primary?: boolean; danger?: boolean; disabled?: boolean; busy?: boolean; small?: boolean }) {
    const p = usePalette();
    const off = disabled || busy;
    const fg = primary ? p.bg : danger ? p.err : p.fg;
    return (
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!off, busy: !!busy }} disabled={off} onPress={onPress}
            style={({ pressed }) => [s.button, small && s.buttonSmall, primary ? { backgroundColor: off ? p.fgFaint : p.fg } : { borderColor: p.border, borderWidth: 1 }, pressed && { opacity: 0.8 }]}>
            {busy ? <ActivityIndicator size="small" color={fg} /> : <Text style={[s.buttonText, small && s.buttonTextSmall, { color: fg }]}>{title}</Text>}
        </Pressable>
    );
}

/** A labelled text field: the label above, the box a raised panel, a hint under it when there is one. */
export function Field({ label, hint, mono, ...input }: { label: string; hint?: string; mono?: boolean } & TextInputProps) {
    const p = usePalette();
    return (
        <View style={s.field}>
            <Text style={[s.fieldLabel, { color: p.fgDim }]}>{label}</Text>
            <TextInput placeholderTextColor={p.fgFaint} autoCorrect={false} {...input} accessibilityLabel={label}
                style={[s.fieldInput, { color: p.fg, backgroundColor: p.panel, borderColor: p.border }, mono && s.mono]} />
            {hint ? <Text style={[s.fieldHint, { color: p.fgFaint }]}>{hint}</Text> : null}
        </View>
    );
}

/** A rounded card grouping what belongs together (`.pair-box` on the page). */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
    const p = usePalette();
    return <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg, borderColor: p.border }, style]}>{children}</View>;
}

/** A thin rule between groups. */
export function Rule({ p }: { p: Palette }) {
    return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.border, marginVertical: 6 }} />;
}

const s = StyleSheet.create({
    // The page's `.hbtn`: a 44pt circle, its icon centred, no border until pressed.
    iconButton: { width: SIZE.target, height: SIZE.target, borderRadius: SIZE.target / 2, alignItems: "center", justifyContent: "center" },
    // The page's `.tp-pill`: a rounded capsule with the value and a caret.
    pill: { flexDirection: "row", alignItems: "center", gap: 4, height: 34, paddingHorizontal: 12, borderRadius: 17, maxWidth: 240 },
    // The pill's value, shrinking before the caret does.
    pillText: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
    // A model name or an identifier: the code face, as the page sets it.
    mono: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 14 },
    // A count: a capsule at least as wide as it is tall.
    badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
    // The count's figure.
    badgeText: { fontSize: 12, fontWeight: "700" },
    // A runtime's connection, beside its name.
    dot: { width: 8, height: 8, borderRadius: 4 },
    // The toast: a dark capsule above the bottom edge, centred, never under a finger.
    toast: { position: "absolute", left: SIZE.gutter, right: SIZE.gutter, paddingVertical: 12, paddingHorizontal: 16, borderRadius: SIZE.radius, alignSelf: "center" },
    // What a sheet holds, with room under the last row for the home bar.
    sheetBody: { paddingHorizontal: 8, paddingBottom: 36 },
    // The filter field above a sheet's list: an icon, the field, and a clear button.
    filter: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 12, borderRadius: 12 },
    // The field itself, tall enough to tap.
    filterInput: { flex: 1, fontSize: SIZE.text, paddingVertical: 11 },
    // A sheet's heading, left-aligned with its rows.
    sheetTitle: { fontSize: SIZE.heading, fontWeight: "700", paddingHorizontal: 12, paddingTop: 4, paddingBottom: 10 },
    // Why a sheet's rows cannot be chosen, above them.
    sheetNote: { fontSize: SIZE.small, lineHeight: 19, padding: 12, borderRadius: 12, marginHorizontal: 4, marginBottom: 8 },
    // A row: 52pt, its title and detail on the left, the check on the right.
    sheetRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
    // A row's title.
    sheetRowTitle: { fontSize: SIZE.text },
    // A row's second line.
    sheetRowDetail: { fontSize: SIZE.small, marginTop: 2, lineHeight: 18 },
    // A text button: a 48pt capsule, its text centred.
    button: { height: 48, borderRadius: 24, paddingHorizontal: 22, alignItems: "center", justifyContent: "center" },
    // A button's text.
    buttonText: { fontSize: SIZE.text, fontWeight: "600" },
    // A small button: an action beside something, not the point of the screen. Still a 36pt target.
    buttonSmall: { height: 36, borderRadius: 18, paddingHorizontal: 16 },
    // A small button's text.
    buttonTextSmall: { fontSize: 14 },
    // A field: its label, box and hint stacked.
    field: { gap: 6 },
    // A field's label, above the box.
    fieldLabel: { fontSize: SIZE.small, fontWeight: "600" },
    // A field's box: 48pt, rounded, raised out of the canvas.
    fieldInput: { minHeight: 48, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: SIZE.text },
    // What to put in a field, under it.
    fieldHint: { fontSize: 12.5, lineHeight: 17 },
    // A card: a rounded box with a hairline edge, padded.
    card: { borderRadius: SIZE.radius + 2, borderWidth: StyleSheet.hairlineWidth, padding: SIZE.gutter, gap: 14 },
});
