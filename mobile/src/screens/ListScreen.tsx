// ListScreen.tsx — THE SESSION LIST, the app's home: every runtime this device can see, each with its recent sessions,
// newest first, and what is waiting on you badged. The chat page's phone list (src/chat/chat-app.tsx `SessionList`)
// drawn as a native list: a large title, round buttons for a new chat and settings, a section per runtime, rows you tap.

import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Bot, Settings, SquarePen } from "lucide-react-native";
import type { SessionSummary } from "../../../src/session-host";
import { useEmbed } from "../embed";
import { ago, sections, STATUS_LABEL, STATUS_TONE } from "../format";
import { useSessionLayer } from "../layer";
import { SIZE, usePalette } from "../theme";
import { Badge, Dot, IconButton } from "../ui";
import type { Routes } from "../routes";

/** The home screen. */
export function ListScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const nav = useNavigation<NativeStackNavigationProp<Routes>>();
    const e = useEmbed();
    const layer = useSessionLayer();
    const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
    const [refreshing, setRefreshing] = useState(false);
    const data = useMemo(() => sections(e.runtimes, e.sessions).map((s) => ({ ...s, data: folded.has(s.runtime.id) ? [] : s.data })), [e.runtimes, e.sessions, folded]);
    const waiting = e.sessions.reduce((n, s) => n + s.pendingApprovals, 0);
    const refresh = useCallback(() => { setRefreshing(true); e.resume(); setTimeout(() => setRefreshing(false), 700); }, [e]);
    const status = e.status.state === "online" ? null : e.status.state === "connecting" ? "Connecting…" : "Offline, retrying";

    return (
        <View style={[s.screen, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <View style={s.bar}>
                <Text style={[s.title, { color: p.fg }]} accessibilityRole="header">Sessions</Text>
                <View style={{ flex: 1 }} />
                <IconButton label="New chat" icon={(c) => <SquarePen size={22} color={c} />} onPress={() => nav.navigate("NewChat")} />
                <IconButton label="Settings" icon={(c) => <Settings size={22} color={c} />} onPress={() => nav.navigate("Settings")} />
            </View>
            <SectionList
                sections={data}
                keyExtractor={(x) => `${x.id.runtime}:${x.id.hash}`}
                stickySectionHeadersEnabled={false}
                contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.fgFaint} />}
                ListHeaderComponent={
                    <View style={s.head}>
                        <View style={s.headMeta}>
                            {status ? <Text style={{ color: p.fgDim, fontSize: SIZE.small }}>{status}</Text> : null}
                            {waiting ? <Text style={{ color: p.notice, fontSize: SIZE.small, fontWeight: "600" }}>{waiting} waiting on you</Text> : null}
                            {e.demo ? <Text style={{ color: p.fgFaint, fontSize: SIZE.small }}>Demo data</Text> : null}
                        </View>
                    </View>
                }
                renderSectionHeader={({ section }) => (
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded: !folded.has(section.runtime.id) }}
                        onPress={() => setFolded((f) => { const n = new Set(f); n.has(section.runtime.id) ? n.delete(section.runtime.id) : n.add(section.runtime.id); return n; })}
                        style={s.section}>
                        <Dot tone={section.runtime.online ? "ok" : "off"} />
                        <Text style={[s.sectionName, { color: p.fgDim }]}>{section.runtime.name}</Text>
                        {section.runtime.grants.every((g) => g.scope === "view") ? <Text style={[s.tag, { color: p.fgFaint, borderColor: p.border }]}>view only</Text> : null}
                        {!section.runtime.online ? <Text style={{ color: p.fgFaint, fontSize: 12.5 }}>offline</Text> : null}
                    </Pressable>
                )}
                renderSectionFooter={({ section }) => section.older && !folded.has(section.runtime.id)
                    ? <Text style={[s.older, { color: p.fgFaint }]}>{section.older} older on this runtime</Text> : null}
                renderItem={({ item }) => <Row s={item} onPress={() => layer.open(`${item.id.runtime}:${item.id.hash}`)} />}
                ListEmptyComponent={e.ready ? <Text style={[s.empty, { color: p.fgDim }]}>No runtimes yet. Pair a browser from Settings to see its sessions here.</Text> : null}
            />
        </View>
    );
}

/** One session in the list: its title, what kind it is and where it stands, and when it last moved. */
function Row({ s: x, onPress }: { s: SessionSummary; onPress: () => void }) {
    const p = usePalette();
    const title = x.title || x.task || "(untitled)";
    const label = STATUS_LABEL[x.status];
    const tone = STATUS_TONE[x.status];
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress}
            style={({ pressed }) => [s.row, pressed && { backgroundColor: p.panel }]}>
            <View style={[s.rowDot, { backgroundColor: tone === "busy" ? p.notice : tone === "err" ? p.err : "transparent" }]} />
            <View style={s.rowBody}>
                <Text numberOfLines={1} style={[s.rowTitle, { color: p.fg }]}>{title}</Text>
                <View style={s.rowMeta}>
                    {x.kind === "agent" ? <View style={s.kind}><Bot size={13} color={p.fgFaint} /><Text style={[s.metaText, { color: p.fgFaint }]}>agent</Text></View> : null}
                    {x.page ? <Text numberOfLines={1} style={[s.metaText, { color: p.fgFaint, flexShrink: 1 }]}>{hostOf(x.page.url)}</Text> : null}
                    {label ? <Text style={[s.metaText, { color: x.status === "waiting" ? p.notice : tone === "err" ? p.err : p.fgFaint }]}>{label}</Text> : null}
                </View>
            </View>
            <View style={s.rowEnd}>
                <Text style={[s.metaText, { color: p.fgFaint }]}>{ago(x.lastTs)}</Text>
                <Badge n={x.pendingApprovals} label={`${x.pendingApprovals} approvals waiting`} />
            </View>
        </Pressable>
    );
}

/** A page's host, for a row's meta line. */
function hostOf(url: string): string {
    try { return new URL(url).host; } catch { return url; }
}

const s = StyleSheet.create({
    // The whole screen, under the status bar.
    screen: { flex: 1 },
    // The top bar: the large title at the left, the buttons at the right.
    bar: { flexDirection: "row", alignItems: "center", paddingLeft: SIZE.gutter, paddingRight: 8, height: 56 },
    // What is worth knowing at a glance, under the bar: the connection, what waits on you, demo data.
    head: { paddingHorizontal: SIZE.gutter, paddingBottom: 8 },
    // "Sessions", large.
    title: { fontSize: SIZE.title, fontWeight: "700", letterSpacing: -0.3 },
    // Connection, waiting count and the demo note, in a line under the title.
    headMeta: { flexDirection: "row", gap: 12, minHeight: 18 },
    // A runtime's heading: its dot, name and tags; tapping folds it.
    section: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: SIZE.gutter, paddingTop: 22, paddingBottom: 8 },
    // The runtime's name, as a small uppercase label.
    sectionName: { fontSize: 13, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase" },
    // "view only": a runtime this device may watch, not drive.
    tag: { fontSize: 11.5, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden" },
    // "N older on this runtime", under a section.
    older: { fontSize: 12.5, paddingHorizontal: SIZE.gutter + 18, paddingTop: 4 },
    // A session row: 64pt, a status mark, the body, the time and badge at the end.
    row: { flexDirection: "row", alignItems: "center", minHeight: 64, paddingVertical: 10, paddingLeft: SIZE.gutter - 8, paddingRight: SIZE.gutter, marginHorizontal: 8, borderRadius: SIZE.radius },
    // A small mark at the row's start for a session that is busy or stopped short; nothing for a finished one.
    rowDot: { width: 6, height: 6, borderRadius: 3, marginRight: 10 },
    // Title and meta, taking the row's width.
    rowBody: { flex: 1, minWidth: 0 },
    // The session's title, one line.
    rowTitle: { fontSize: SIZE.text, fontWeight: "500" },
    // Kind, page, status: the second line.
    rowMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 },
    // "agent", with its icon.
    kind: { flexDirection: "row", alignItems: "center", gap: 3 },
    // Every small grey word in a row.
    metaText: { fontSize: 13 },
    // The time over the approvals badge, at the row's end.
    rowEnd: { alignItems: "flex-end", gap: 5, marginLeft: 10 },
    // No runtimes: what to do about it.
    empty: { padding: SIZE.gutter, fontSize: SIZE.text, lineHeight: 22 },
});
