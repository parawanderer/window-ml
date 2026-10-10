// SettingsScreen.tsx — THE APP'S SETTINGS, as a phone draws them: grouped rows in rounded cards, not the chat page's
// desktop tabs. The theme (the system's, or light or dark), this device's account, and the runtimes it can see with what
// it may do on each, and on Android whether the app checks GitHub for a newer build of itself. Pairing and the device list arrive as screens of their own.

import { useContext, useEffect, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Check, ChevronLeft, ChevronRight } from "lucide-react-native";
import type { Routes } from "../routes";
import { useEmbed } from "../embed";
import { SIZE, ThemeChoiceContext, usePalette, type ThemeChoice } from "../theme";
import { Dot, IconButton } from "../ui";
import { CODE_SIZES } from "../../../src/native/text-size";
import { setCodeSize, useCodeSize } from "../code-size";
import { NOTIFY_WHAT, askNotify, notifyState, type NotifyPermission } from "../notify";
import { setUpdateCheck, useAppUpdate } from "../app-update";
import { BUILD } from "../generated/build";

const THEMES: { value: ThemeChoice; label: string }[] = [
    { value: "system", label: "Same as the phone" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
];

/** What a runtime lets this device do, in words. */
function access(scopes: string[]): string {
    if (scopes.includes("control")) return "full control";
    if (scopes.includes("approve") || scopes.includes("drive")) return "can drive and answer";
    return "view only";
}

/** The settings screen. */
export function SettingsScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const nav = useNavigation<NativeStackNavigationProp<Routes>>();
    const e = useEmbed();
    const { choice, setChoice } = useContext(ThemeChoiceContext);
    const code = useCodeSize();
    const update = useAppUpdate();
    // Read once: the answer only changes by a press here or a trip to the phone's own settings, and coming back
    // from those remounts the screen.
    const [notify, setNotify] = useState<NotifyPermission | null>(null);
    useEffect(() => { void notifyState().then(setNotify); }, []);
    // Leaving forgets this phone's membership (never a root: a phone holding one keeps it) and starts over at Welcome.
    const leave = () => Alert.alert("Leave the account?", "This phone stops reaching your browsers. To come back, pair it again from a device in the account.",
        [{ text: "Stay", style: "cancel" }, { text: "Leave", style: "destructive", onPress: () => { void e.pairing("leave"); } }]);
    return (
        <View style={[s.screen, { backgroundColor: p.scheme === "dark" ? p.bg : p.panel, paddingTop: insets.top }]}>
            <View style={s.bar}>
                <IconButton label="Back" icon={(c) => <ChevronLeft size={26} color={c} />} onPress={() => nav.goBack()} />
                <Text style={[s.barTitle, { color: p.fg }]}>Settings</Text>
            </View>
            <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
                <Text style={[s.group, { color: p.fgDim }]}>Appearance</Text>
                <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg }]}>
                    {THEMES.map((t, i) => (
                        <Pressable key={t.value} accessibilityRole="radio" accessibilityState={{ checked: choice === t.value }} onPress={() => setChoice(t.value)}
                            style={({ pressed }) => [s.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }, pressed && { backgroundColor: p.panel2 }]}>
                            <Text style={[s.rowText, { color: p.fg }]}>{t.label}</Text>
                            {choice === t.value ? <Check size={20} color={p.accent} /> : null}
                        </Pressable>
                    ))}
                </View>

                {/* CODE SIZE, the page's own setting on its "This page" tab, which this app had no answer to: a code
                    block on a phone was whatever the page shipped with. Its sibling there, PANEL TEXT SIZE, is not
                    here on purpose — `--panel-fs` drives the docked panels (the resource graphs, the Python bench,
                    the housekeeping log) and this app has none of them, so it would be a control with nothing to
                    change. */}
                <Text style={[s.group, { color: p.fgDim }]}>Code size</Text>
                <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg }]}>
                    {CODE_SIZES.map((o, i) => (
                        <Pressable key={o.px} accessibilityRole="radio" accessibilityState={{ checked: code === o.px }} onPress={() => setCodeSize(o.px)}
                            style={({ pressed }) => [s.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }, pressed && { backgroundColor: p.panel2 }]}>
                            {/* The label AT the size it sets, in the code face: "Large" tells you less than seeing it. */}
                            <Text style={[s.rowText, s.codeSample, { color: p.fg, fontSize: o.px * 1.3 }]}>{o.label}</Text>
                            {code === o.px ? <Check size={20} color={p.accent} /> : null}
                        </Pressable>
                    ))}
                </View>

                {/* NOTIFICATIONS, the one thing here that reaches someone with the app closed. Asked only on a press:
                    an OS prompt nobody opened is answered "no" and then cannot be asked again. What it will say is on
                    the row, because "allow notifications" alone is a question nobody can answer. */}
                <Text style={[s.group, { color: p.fgDim }]}>Notifications</Text>
                <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg }]}>
                    <Pressable testID="notify-row" accessibilityRole="button" disabled={notify !== "undetermined"}
                        onPress={() => void askNotify().then(setNotify)}
                        style={({ pressed }) => [s.row, pressed && notify === "undetermined" && { backgroundColor: p.panel2 }]}>
                        <View style={{ flex: 1 }}>
                            <Text style={[s.rowText, { color: p.fg }]}>{notify === "granted" ? "On" : notify === "denied" ? "Off" : "Allow notifications"}</Text>
                            <Text style={{ color: p.fgDim, fontSize: SIZE.small, marginTop: 2 }}>{NOTIFY_WHAT}{notify === "denied" ? " Turned off for this app in the phone's settings, which is the only way back." : ""}</Text>
                        </View>
                        {notify === "granted" ? <Check size={20} color={p.accent} /> : notify === "undetermined" ? <ChevronRight size={20} color={p.fgFaint} /> : null}
                    </Pressable>
                </View>

                {/* APP UPDATES, Android only: iOS has no build to download. The switch says what it costs, because each
                    check tells GitHub this phone's address; the row below opens the build against the newest one. */}
                {update.supported ? <>
                    <Text style={[s.group, { color: p.fgDim }]}>App updates</Text>
                    <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg }]}>
                        <View style={s.row}>
                            <View style={{ flex: 1 }}>
                                <Text style={[s.rowText, { color: p.fg }]}>Check GitHub for new builds</Text>
                                <Text style={{ color: p.fgDim, fontSize: SIZE.small, marginTop: 2 }}>
                                    {BUILD.repo ? `A few times a day, from ${BUILD.repo}. GitHub sees this phone's address each time.` : "This build was made outside CI and names no repository, so it cannot check."}
                                </Text>
                            </View>
                            <Switch testID="update-switch" accessibilityLabel="Check GitHub for new builds" value={update.enabled} disabled={!BUILD.repo}
                                onValueChange={setUpdateCheck} trackColor={{ true: p.accent, false: p.panel2 }} />
                        </View>
                        <Pressable testID="update-row" accessibilityRole="button" onPress={() => nav.navigate("Update")}
                            style={({ pressed }) => [s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }, pressed && { backgroundColor: p.panel2 }]}>
                            <Text style={[s.rowText, { color: p.fg }]}>This build</Text>
                            <Text style={{ color: update.last?.state === "behind" && !update.off ? p.accent : p.fgDim, fontSize: SIZE.small }}>
                                {update.off || !update.last ? (BUILD.sha?.slice(0, 7) ?? "unknown")
                                    : update.last.state === "behind" ? `${update.last.commits} behind`
                                    : update.last.state === "current" ? "newest" : BUILD.sha?.slice(0, 7) ?? "unknown"}
                            </Text>
                            <ChevronRight size={20} color={p.fgFaint} />
                        </Pressable>
                    </View>
                </> : null}

                <Text style={[s.group, { color: p.fgDim }]}>This device</Text>
                <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg }]}>
                    <View style={s.row}>
                        <Text style={[s.rowText, { color: p.fg }]}>{e.account ? e.account.label : "In no account"}</Text>
                        <Text style={{ color: p.fgFaint, fontSize: SIZE.small }}>{e.demo ? "demo" : e.account ? e.account.hubUrl : ""}</Text>
                    </View>
                    <View style={[s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }]}>
                        <Text style={[s.rowText, { color: p.fg }]}>Hub</Text>
                        <Text style={{ color: p.fgDim, fontSize: SIZE.small }}>{e.status.state === "online" ? "connected" : e.status.state === "connecting" ? "connecting…" : "offline"}</Text>
                    </View>
                    {e.pairingInfo?.devices ? (
                        <Pressable accessibilityRole="button" onPress={() => nav.navigate("Devices")}
                            style={({ pressed }) => [s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }, pressed && { backgroundColor: p.panel2 }]}>
                            <Text style={[s.rowText, { color: p.fg }]}>Devices</Text>
                            <ChevronRight size={20} color={p.fgFaint} />
                        </Pressable>
                    ) : null}
                    {e.account && !e.account.root && !e.demo ? (
                        <Pressable accessibilityRole="button" onPress={leave}
                            style={({ pressed }) => [s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }, pressed && { backgroundColor: p.panel2 }]}>
                            <Text style={[s.rowText, { color: p.err }]}>Leave the account</Text>
                        </Pressable>
                    ) : null}
                </View>

                <Text style={[s.group, { color: p.fgDim }]}>Runtimes</Text>
                <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg }]}>
                    {/* A row OPENS that runtime: what it is, the models it offers, what it keeps (RuntimeScreen). */}
                    {e.runtimes.length ? e.runtimes.map((r, i) => (
                        <Pressable key={r.id} accessibilityRole="button" accessibilityLabel={`${r.name}: what it is, its models and its storage`}
                            onPress={() => nav.navigate("Runtime", { id: r.id })}
                            style={({ pressed }) => [s.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }, pressed && { backgroundColor: p.panel2 }]}>
                            <Dot tone={r.online ? "ok" : "off"} />
                            <View style={{ flex: 1 }}>
                                <Text style={[s.rowText, { color: p.fg }]}>{r.name}</Text>
                                <Text style={{ color: p.fgDim, fontSize: SIZE.small, marginTop: 2 }}>{r.online ? "online" : "offline"} · {access(r.grants.map((g) => g.scope))}</Text>
                            </View>
                            <ChevronRight size={20} color={p.fgFaint} />
                        </Pressable>
                    )) : <View style={s.row}><Text style={{ color: p.fgDim, fontSize: SIZE.small }}>None yet.</Text></View>}
                </View>
            </ScrollView>
        </View>
    );
}

const s = StyleSheet.create({
    // The screen, on the grouped-list ground (a shade under the cards in light, the canvas in dark).
    screen: { flex: 1 },
    // Back and the screen's name.
    bar: { flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 6, height: 52 },
    // "Settings".
    barTitle: { fontSize: SIZE.heading, fontWeight: "600" },
    // A group's label, small and uppercase, above its card.
    group: { fontSize: 13, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", paddingHorizontal: SIZE.gutter + 12, paddingTop: 24, paddingBottom: 8 },
    // A rounded card holding a group's rows.
    card: { marginHorizontal: SIZE.gutter, borderRadius: SIZE.radius, overflow: "hidden" },
    // A row: 52pt, its text on the left, a value or check on the right.
    row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 16, paddingVertical: 10 },
    // A row's main text.
    rowText: { fontSize: SIZE.text, flex: 1 },
    // A code-size row's label, set in the code face at the size it chooses.
    codeSample: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
});
