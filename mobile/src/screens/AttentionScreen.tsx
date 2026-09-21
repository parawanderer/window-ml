// AttentionScreen.tsx — WHAT THE RUNTIMES NEED A HAND WITH: a runtime with no model, site access left on "on click", an
// archive folder that lost its permission. The chat page's attention list (src/chat/attention-page.tsx) as a phone
// screen, in the page's own words (src/native/snapshot.ts `attentionForApp`).
//
// A phone fixes none of it: every fix is a click in the runtime's own browser or its Settings. So each item says WHICH
// device, and the screen offers no button that could not work. Suggestions can be put away on this phone.

import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { X } from "lucide-react-native";
import type { AttentionRow } from "../../../src/native/bridge";
import { useEmbed } from "../embed";
import { Bar } from "./AccountScreens";
import { SIZE, usePalette } from "../theme";

/** Where this phone keeps the suggestions it was told to put away, by `runtime:code`. */
const DISMISSED = "attention-dismissed";

/** Each level as a heading: how much it costs to leave it. */
const GROUPS: { level: AttentionRow["level"]; title: string }[] = [
    { level: "blocks", title: "Stops it working" },
    { level: "limits", title: "Holds it back" },
    { level: "suggests", title: "Suggestions" },
];

/** The attention screen. */
export function AttentionScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const e = useEmbed();
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    useEffect(() => {
        void AsyncStorage.getItem(DISMISSED).then((raw) => { try { setHidden(new Set(JSON.parse(raw ?? "[]") as string[])); } catch { /* none */ } });
    }, []);
    // Only a suggestion can be put away: a problem stays until the runtime stops reporting it.
    const dismiss = (key: string) => {
        const next = new Set(hidden).add(key);
        setHidden(next);
        void AsyncStorage.setItem(DISMISSED, JSON.stringify([...next]));
    };
    const items = e.attention.items.filter((i) => i.level !== "suggests" || !hidden.has(i.key));
    const tone = (level: AttentionRow["level"]) => (level === "blocks" ? p.err : level === "limits" ? p.notice : p.fgFaint);

    return (
        <View style={[s.screen, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <Bar title="Needs attention" />
            <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
                {!items.length ? (
                    <Text style={[s.empty, { color: p.fgDim }]}>Nothing needs your hand. Every runtime this phone can see is set up.</Text>
                ) : null}
                {GROUPS.map((g) => {
                    const rows = items.filter((i) => i.level === g.level);
                    if (!rows.length) return null;
                    return (
                        <View key={g.level}>
                            <Text style={[s.group, { color: tone(g.level) }]}>{g.title}</Text>
                            <View style={[s.card, { backgroundColor: p.scheme === "dark" ? p.panel : p.bg, borderColor: p.border }]}>
                                {rows.map((r, i) => (
                                    <View key={r.key} style={[s.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border }]}>
                                        <View style={{ flex: 1 }}>
                                            <Text style={[s.title, { color: p.fg }]}>{r.title}</Text>
                                            {/* Which device: the fix is a click THERE, never here. */}
                                            <Text style={[s.where, { color: tone(r.level) }]}>on {r.runtimeName}</Text>
                                            <Text style={[s.detail, { color: p.fgDim }]}>{r.detail}</Text>
                                        </View>
                                        {r.level === "suggests" ? (
                                            <Pressable accessibilityRole="button" accessibilityLabel={`Put away: ${r.title}`} hitSlop={12} onPress={() => dismiss(r.key)}>
                                                <X size={18} color={p.fgFaint} />
                                            </Pressable>
                                        ) : null}
                                    </View>
                                ))}
                            </View>
                        </View>
                    );
                })}
                <Text style={[s.foot, { color: p.fgFaint }]}>Each of these is fixed on the device it names, in its browser or its Settings. This list updates when it is.</Text>
            </ScrollView>
        </View>
    );
}

const s = StyleSheet.create({
    // The screen, under the status bar.
    screen: { flex: 1 },
    // A level's heading above its card, in that level's colour.
    group: { fontSize: 13, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", paddingHorizontal: SIZE.gutter + 12, paddingTop: 22, paddingBottom: 8 },
    // The rounded card holding a level's items.
    card: { marginHorizontal: SIZE.gutter, borderRadius: SIZE.radius, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
    // One item: its words, and a put-away button for a suggestion.
    row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
    // What is wrong, in a line.
    title: { fontSize: SIZE.text, fontWeight: "600" },
    // Which device it is on.
    where: { fontSize: 13, fontWeight: "600", marginTop: 2 },
    // What it costs and how it is fixed.
    detail: { fontSize: 14, lineHeight: 20, marginTop: 6 },
    // Nothing to show.
    empty: { padding: SIZE.gutter + 4, fontSize: SIZE.text, lineHeight: 22 },
    // Where fixes happen, under everything.
    foot: { fontSize: 12.5, lineHeight: 18, paddingHorizontal: SIZE.gutter + 12, paddingTop: 18 },
});
