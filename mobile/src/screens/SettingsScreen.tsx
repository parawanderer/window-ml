// SettingsScreen.tsx — THE APP'S SETTINGS, as a phone draws them: grouped rows in rounded cards, not the chat page's
// desktop tabs. The theme (the system's, or light or dark), this device's account, and the runtimes it can see with what
// it may do on each. Pairing and the device list arrive as screens of their own.

import { useContext } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Check, ChevronLeft, ChevronRight } from "lucide-react-native";
import type { Routes } from "../routes";
import { useEmbed } from "../embed";
import { SIZE, ThemeChoiceContext, usePalette, type ThemeChoice } from "../theme";
import { Dot, IconButton } from "../ui";

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
                    {e.runtimes.length ? e.runtimes.map((r, i) => (
                        <View key={r.id} style={[s.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }]}>
                            <Dot tone={r.online ? "ok" : "off"} />
                            <View style={{ flex: 1 }}>
                                <Text style={[s.rowText, { color: p.fg }]}>{r.name}</Text>
                                <Text style={{ color: p.fgDim, fontSize: SIZE.small, marginTop: 2 }}>{r.online ? "online" : "offline"} · {access(r.grants.map((g) => g.scope))}</Text>
                            </View>
                        </View>
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
});
