// ListScreen.tsx — THE SESSION LIST, the app's home: every runtime this device can see, each with its recent sessions,
// newest first, and what is waiting on you badged. The chat page's phone list (src/chat/chat-app.tsx `SessionList`)
// drawn as a native list: a large title, round buttons for a new chat and settings, a section per runtime, rows you tap
// (and long-press for a session's actions, session-actions.tsx).

import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Bot, Inbox, Search, Settings, SquarePen } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import type { SessionSummary } from "../../../src/session-host";
import type { SessionChrome } from "../../../src/native/bridge";
import { useEmbed } from "../embed";
import { ago, approvalsPending, needsYou, sections, STATUS_LABEL, STATUS_TONE } from "../format";
import { useSessionLayer } from "../layer";
import { SIZE, usePalette } from "../theme";
import { Badge, Dot, IconButton } from "../ui";
import type { Routes } from "../routes";
import { SessionActions, type SessionActionsHandle } from "../session-actions";

// The list reaches back a month; everything older is on the search screen, which the footer row under each runtime
// opens with nothing typed. That row used to be plain text, which named what you could not get to.
/** The home screen. */
export function ListScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const nav = useNavigation<NativeStackNavigationProp<Routes>>();
    const e = useEmbed();
    const layer = useSessionLayer();
    const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
    const [refreshing, setRefreshing] = useState(false);
    // What waits on you is pinned above the runtimes, and LEAVES its own section while it is up there: the same row
    // twice within a screen reads as a bug, and the pinned row names the machine it is on.
    const data = useMemo(() => {
        const mine = needsYou(e.sessions);
        const pinned = new Set(mine.map((x) => `${x.id.runtime}:${x.id.hash}`));
        const byRuntime = sections(e.runtimes, e.sessions).map((x) => ({
            id: x.runtime.id, runtime: x.runtime, older: x.older,
            data: folded.has(x.runtime.id) ? [] : x.data.filter((y) => !pinned.has(`${y.id.runtime}:${y.id.hash}`)),
        }));
        return mine.length ? [{ id: "needs-you", runtime: null, older: 0, data: mine }, ...byRuntime] : byRuntime;
    }, [e.runtimes, e.sessions, folded]);
    const names = useMemo(() => new Map(e.runtimes.map((r) => [r.id, r.name])), [e.runtimes]);
    const refresh = useCallback(() => { setRefreshing(true); e.resume(); setTimeout(() => setRefreshing(false), 700); }, [e]);
    // A long press shows the session's actions without opening it, as the page words them for that session.
    const actions = useRef<SessionActionsHandle>(null);
    const [acting, setActing] = useState<{ chrome: SessionChrome; approval: boolean } | null>(null);
    const actOn = async (key: string, approval: boolean) => {
        const chrome = await e.chromeFor(key);
        if (!chrome) return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setActing({ chrome, approval });
        actions.current?.present();
    };
    const status = e.status.state === "online" ? null : e.status.state === "connecting" ? "Connecting…" : "Offline, retrying";

    return (
        <View style={[s.screen, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <View style={s.bar}>
                <Text style={[s.title, { color: p.fg }]} accessibilityRole="header">Sessions</Text>
                <View style={{ flex: 1 }} />
                {/* The inbox: there only when a runtime reports something, and a number only for problems, never for the
                    suggestions, so a set-up account shows no badge (the page's rule, attention.ts). */}
                {e.attention.items.length ? (
                    <View>
                        <IconButton label={e.attention.count ? `${e.attention.count} things need attention` : "Suggestions"} icon={(c) => <Inbox size={22} color={c} />} onPress={() => nav.navigate("Attention")} />
                        {e.attention.count ? <View pointerEvents="none" style={s.inboxBadge}><Badge n={e.attention.count} label={`${e.attention.count} need attention`} /></View> : null}
                    </View>
                ) : null}
                <IconButton label="Search sessions" icon={(c) => <Search size={22} color={c} />} onPress={() => nav.navigate("Search")} />
                <IconButton label="New session" icon={(c) => <SquarePen size={22} color={c} />} onPress={() => nav.navigate("NewChat")} />
                <IconButton label="Settings" icon={(c) => <Settings size={22} color={c} />} onPress={() => nav.navigate("Settings")} />
            </View>
            <SectionList
                sections={data}
                keyExtractor={(x, i) => `${x.id.runtime}:${x.id.hash}:${i}`}
                stickySectionHeadersEnabled={false}
                contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.fgFaint} />}
                ListHeaderComponent={
                    <View style={s.head}>
                        <View style={s.headMeta}>
                            {status ? <Text style={{ color: p.fgDim, fontSize: SIZE.small }}>{status}</Text> : null}
                            {e.demo ? <Text style={{ color: p.fgFaint, fontSize: SIZE.small }}>Demo data</Text> : null}
                        </View>
                    </View>
                }
                renderSectionHeader={({ section }) => section.runtime === null ? (
                    <View style={[s.section, s.needsHead]}>
                        <Text style={[s.sectionName, { color: p.notice }]}>Needs you</Text>
                    </View>
                ) : (
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded: !folded.has(section.runtime.id) }}
                        onPress={() => setFolded((f) => { const n = new Set(f); n.has(section.runtime!.id) ? n.delete(section.runtime!.id) : n.add(section.runtime!.id); return n; })}
                        style={s.section}>
                        <Dot tone={section.runtime.online ? "ok" : "off"} />
                        <Text style={[s.sectionName, { color: p.fgDim }]}>{section.runtime.name}</Text>
                        {section.runtime.grants.every((g) => g.scope === "view") ? <Text style={[s.tag, { color: p.fgFaint, borderColor: p.border }]}>view only</Text> : null}
                        {!section.runtime.online ? <Text style={{ color: p.fgFaint, fontSize: 12.5 }}>offline</Text> : null}
                    </Pressable>
                )}
                renderSectionFooter={({ section }) => section.runtime && section.older && !folded.has(section.runtime.id) ? (
                    <Pressable accessibilityRole="button" onPress={() => nav.navigate("Search")}
                        style={({ pressed }) => [pressed && { backgroundColor: p.panel }]}>
                        <Text style={[s.older, { color: p.fgDim }]}>{section.older} older on this runtime</Text>
                    </Pressable>
                ) : null}
                renderItem={({ item, section }) => (
                    // A pinned row opens ON its approval: that is what it is pinned for. It also names its runtime,
                    // since up here it is out of its machine's section.
                    <Row s={item} runtimeName={section.runtime === null ? names.get(item.id.runtime) : undefined}
                        onPress={() => layer.open(`${item.id.runtime}:${item.id.hash}`, section.runtime === null)}
                        onLongPress={() => void actOn(`${item.id.runtime}:${item.id.hash}`, section.runtime === null)} />
                )}
                ListEmptyComponent={e.ready ? <Text style={[s.empty, { color: p.fgDim }]}>No runtimes yet. Pair a browser from Settings to see its sessions here.</Text> : null}
            />
            <SessionActions ref={actions} chrome={acting?.chrome ?? null} onOpen={acting ? () => layer.open(acting.chrome.key, acting.approval) : undefined} />
        </View>
    );
}

/** One session in the list: its title, where it stands, and when it last moved. `runtimeName` for a row out of its
 *  runtime's section (the pinned "needs you" group). */
function Row({ s: x, runtimeName, onPress, onLongPress }: { s: SessionSummary; runtimeName?: string; onPress: () => void; onLongPress: () => void }) {
    const p = usePalette();
    const title = x.title || x.task || "(untitled)";
    const label = STATUS_LABEL[x.status];
    const tone = STATUS_TONE[x.status];
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint="Long press for this session's actions" onPress={onPress} onLongPress={onLongPress}
            accessibilityActions={[{ name: "longpress", label: "Session actions" }]} onAccessibilityAction={(ev) => { if (ev.nativeEvent.actionName === "longpress") onLongPress(); }}
            style={({ pressed }) => [s.row, pressed && { backgroundColor: p.panel }]}>
            <View style={[s.rowDot, { backgroundColor: tone === "busy" ? p.notice : tone === "err" ? p.err : tone === "stopped" ? p.warn : "transparent" }]} />
            <View style={s.rowBody}>
                <Text numberOfLines={1} style={[s.rowTitle, { color: p.fg }]}>{title}</Text>
                {/* WHERE IT STANDS COMES FIRST on this line, so it is in the same place on every row: a status that
                    trails a page host of any length is one the eye has to find again each time. It never shrinks;
                    the host does. */}
                <View style={s.rowMeta}>
                    {/* ONE THING, NOT TWO. "waiting on you" here beside a count at the row's end is the same fact in
                        two voices, so where there is a count the BADGE is the status: it says how many, and it is
                        the notice colour, which is what the word was doing. The web list reads the same. */}
                    {x.pendingApprovals > 0
                        ? <Badge n={x.pendingApprovals} text={approvalsPending(x.pendingApprovals)} />
                        : label ? <Text style={[s.rowState, { color: tone === "err" ? p.err : tone === "stopped" ? p.warn : p.fgDim }]}>{label}</Text> : null}
                    {x.kind === "agent" ? <View style={s.kind}><Bot size={13} color={p.fgFaint} /><Text style={[s.metaText, { color: p.fgFaint }]}>agent</Text></View> : null}
                    {/* Out of its runtime's section, the machine is what the row is missing; the page host is what
                        it can spare, since the transcript says that on the next tap. */}
                    {runtimeName
                        ? <Text numberOfLines={1} style={[s.metaText, { color: p.fgFaint, flexShrink: 1 }]}>{runtimeName}</Text>
                        : x.page ? <Text numberOfLines={1} style={[s.metaText, { color: p.fgFaint, flexShrink: 1 }]}>{hostOf(x.page.url)}</Text> : null}
                </View>
            </View>
            <View style={s.rowEnd}>
                <Text style={[s.metaText, { color: p.fgFaint }]}>{ago(x.lastTs)}</Text>
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
    // The inbox's count, over the corner of its button.
    inboxBadge: { position: "absolute", top: 2, right: 0 },
    // "Sessions", large.
    title: { fontSize: SIZE.title, fontWeight: "700", letterSpacing: -0.3 },
    // Connection, waiting count and the demo note, in a line under the title.
    headMeta: { flexDirection: "row", gap: 12, minHeight: 18 },
    // The pinned group's heading, which folds nothing and so has no dot to tap.
    needsHead: { paddingTop: 14 },
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
    // The session's title, one line, the heaviest thing in the row.
    rowTitle: { fontSize: SIZE.text, fontWeight: "600" },
    // Where the session stands, first on the meta line and never shrunk: the row's one fixed landmark.
    rowState: { fontSize: 13, fontWeight: "600" },
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
