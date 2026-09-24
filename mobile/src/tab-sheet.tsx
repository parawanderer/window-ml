// tab-sheet.tsx — WHERE AN AGENT RUNS, picked from the runtime's own tabs: "A new tab" first, then the tabs as the browser
// shows them, window by window, each group's tabs under its coloured name (the page's order, src/chat/tab-tree.ts, so the
// phone and the laptop list them alike), each with the icon the RUNTIME sent, else the site's first letter. The page's
// tab picker (src/chat/tab-picker.tsx) as a bottom sheet, with a filter once the list is long.

import { forwardRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { Check, Plus } from "lucide-react-native";
import type { TabGroupInfo, TabInfo } from "../../src/session-host";
import { faviconSrc, tabHost, tabMatches, tabTree } from "../../src/chat/tab-tree";
import { SIZE, usePalette } from "./theme";
import { Sheet, SheetFilter } from "./ui";

/** Chromium's group colours (the browser's own palette), for a group's dot. */
const GROUP_COLOR: Record<string, string> = {
    grey: "#9aa0a6", blue: "#1a73e8", red: "#d93025", yellow: "#f9ab00", green: "#1e8e3e",
    pink: "#d01884", purple: "#9334e6", cyan: "#007b83", orange: "#fa903e",
};

/** What is picked: a tab by id, or a new tab. */
export type TabChoice = number | "blank";

/** What the sheet shows: the runtime's tabs (null while asking, and `error` when it would not say). */
export interface TabList { tabs: TabInfo[] | null; groups: TabGroupInfo[]; withheld: number; error?: string }

/** The sheet. `onPick` gets the choice; the caller closes it. `title` and `lede` word it for another use (a resume). */
export const TabSheet = forwardRef<BottomSheetModal, { list: TabList; value: TabChoice | null; onPick: (c: TabChoice) => void; title?: string; lede?: string; blankDetail?: string;
    /** why a NEW tab cannot be opened on this runtime (blank-start.ts). The row is then unpressable and says this
     *  instead of its usual detail — a picker that takes a choice it cannot honour is worse than one that says so. */
    blankBlocked?: string }>(
    function TabSheet({ list, value, onPick, title = "Where the agent runs", lede, blankDetail = "At a page you name, or the runtime's start page", blankBlocked }, ref) {
        const p = usePalette();
        const [q, setQ] = useState("");
        const tabs = list.tabs ?? [];
        const long = tabs.length > 8;
        const items = tabTree(tabs.filter((t) => tabMatches(t, q.trim())), list.groups);
        // The colour of the group the list is currently inside, carried down its rows (see the map below).
        let rail: string | null = null;
        return (
            <Sheet ref={ref} title={title} tall={long}
                note={list.withheld ? `${list.withheld} tab${list.withheld > 1 ? "s are" : " is"} not listed: the browser gives this runtime no access to ${list.withheld > 1 ? "their sites" : "its site"}.` : undefined}
                header={long ? <SheetFilter value={q} onChangeText={setQ} placeholder="Filter tabs" /> : undefined}>
                {lede ? <Text style={[s.note, { color: p.fgDim }]}>{lede}</Text> : null}
                <Row chosen={value === "blank"} disabled={!!blankBlocked} onPress={() => onPick("blank")} title="A new tab"
                    detail={blankBlocked ?? blankDetail}
                    icon={<View style={[s.icon, s.letter, { backgroundColor: p.panel2 }]}><Plus size={16} color={blankBlocked ? p.fgFaint : p.fg} /></View>} />
                <View style={[s.rule, { backgroundColor: p.border }]} />
                {list.tabs === null ? <Text style={[s.note, { color: p.fgDim }]}>{list.error ? `The runtime did not list its tabs: ${list.error}` : "Asking for its tabs…"}</Text>
                    : !tabs.length ? <Text style={[s.note, { color: p.fgDim }]}>No tabs are open there.</Text>
                    : !items.length ? <Text style={[s.note, { color: p.fgDim }]}>{`No tab matches “${q.trim()}”.`}</Text>
                    : items.map((it) => {
                        // THE GROUP'S COLOUR RUNS DOWN ITS TABS, as the page draws it (`.tp-grp`): a dot beside the
                        // name says which colour the group is, and a line beside the rows says which rows are IN it,
                        // which is the question a list of indented titles leaves open. `tabTree` is flat and a group
                        // always precedes its own members, so the colour is carried forward from the heading.
                        if (it.kind === "window") { rail = null; return <Text key={`w${it.windowId}`} style={[s.head, { color: p.fgFaint }]}>{`Window · ${it.count} tab${it.count > 1 ? "s" : ""}`}</Text>; }
                        if (it.kind === "group") {
                            rail = GROUP_COLOR[it.group.color ?? ""] ?? p.fgFaint;
                            return (
                                <View key={`g${it.group.id}`} style={s.group}>
                                    <View style={[s.groupDot, { backgroundColor: rail }]} />
                                    <Text style={[s.head, s.groupName, { color: p.fgDim }]} numberOfLines={1}>{it.described ? it.group.title || "Unnamed group" : "A tab group"}</Text>
                                </View>
                            );
                        }
                        const t = it.tab;
                        const host = tabHost(t.url);
                        // An SVG icon is shown as the letter: React Native's Image draws no SVG.
                        const src = faviconSrc(t);
                        const icon = src && !src.startsWith("data:image/svg")
                            ? <Image source={{ uri: src }} style={s.icon} />
                            : <View style={[s.icon, s.letter, { backgroundColor: p.panel2 }]}><Text style={[s.letterText, { color: p.fgDim }]}>{(host[0] ?? "?").toUpperCase()}</Text></View>;
                        return (
                            <Row key={t.tabId} indent={it.indent} rail={it.indent ? rail : null} chosen={value === t.tabId} onPress={() => onPick(t.tabId)} icon={icon}
                                title={t.title || t.url} detail={t.active ? `${host} · in front` : host} />
                        );
                    })}
            </Sheet>
        );
    },
);

/** One choice: its icon, its title, the line under it, and a check when chosen. */
function Row({ title, detail, icon, chosen, indent, rail, disabled, onPress }: { title: string; detail: string; icon: React.ReactNode; chosen: boolean; indent?: boolean;
    /** the colour of the group this row is in, drawn as a line down its left edge; null when it is in none */
    rail?: string | null; disabled?: boolean; onPress: () => void }) {
    const p = usePalette();
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled}
            accessibilityState={{ selected: chosen, disabled: !!disabled }}
            style={({ pressed }) => [s.row, indent && s.indent, rail ? { borderLeftWidth: 2, borderLeftColor: rail } : null, disabled && { opacity: 0.55 }, pressed && !disabled && { backgroundColor: p.panel }]}
            onPress={onPress}>
            {icon}
            <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[s.title, { color: p.fg }]}>{title}</Text>
                <Text numberOfLines={1} style={[s.detail, { color: p.fgDim }]}>{detail}</Text>
            </View>
            {chosen ? <Check size={20} color={p.accent} /> : null}
        </Pressable>
    );
}

const s = StyleSheet.create({
    // One choice, a comfortable thumb's height.
    row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
    // A tab in a group, set in under the group's name.
    indent: { paddingLeft: 28 },
    // The tab's title.
    title: { fontSize: SIZE.text },
    // Its host, and whether it is the tab in front.
    detail: { fontSize: SIZE.small, marginTop: 1 },
    // The tab's icon, or the box its letter sits in.
    icon: { width: 24, height: 24, borderRadius: 6 },
    // The letter's box, centring it.
    letter: { alignItems: "center", justifyContent: "center" },
    // The site's first letter, where it sent no icon.
    letterText: { fontSize: 13, fontWeight: "700" },
    // The rule between "A new tab" and the open ones.
    rule: { height: StyleSheet.hairlineWidth, marginVertical: 6, marginHorizontal: 12 },
    // A window's or a group's heading.
    head: { fontSize: 12.5, fontWeight: "600", letterSpacing: 0.4, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
    // A group's heading: its colour, then its name.
    group: { flexDirection: "row", alignItems: "center", paddingLeft: 12 },
    // The group's colour, as the browser draws it.
    groupDot: { width: 10, height: 10, borderRadius: 5, marginTop: 8 },
    // The group's name, after its dot.
    groupName: { paddingLeft: 8, flexShrink: 1 },
    // Asking, an error, or nothing there.
    note: { fontSize: SIZE.small, lineHeight: 19, paddingHorizontal: 12, paddingVertical: 10 },
});
