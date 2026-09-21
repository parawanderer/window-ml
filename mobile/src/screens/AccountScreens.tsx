// AccountScreens.tsx — BEFORE AN ACCOUNT: what the app is (Welcome), joining an account (Join: this phone shows a code,
// its fingerprint and a QR code, and waits for a device that may pair to confirm it) and creating one (Create: this
// phone then holds the account's root). The chat page's account panel (src/pairing/pairing-ui.tsx) as phone screens; the
// pairing itself runs in the page (src/native/pairing-bridge.ts), which starts over as the new identity once it is done.

import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ChevronLeft } from "lucide-react-native";
import { groupFour, type Membership } from "../../../src/pairing/api";
import { useEmbed } from "../embed";
import { Qr } from "../Qr";
import type { Routes } from "../routes";
import { SIZE, usePalette } from "../theme";
import { Button, Card, Field, IconButton } from "../ui";

/** The first screen with no account: what this app is, and the two ways into an account. */
export function WelcomeScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const nav = useNavigation<NativeStackNavigationProp<Routes>>();
    const info = useEmbed().pairingInfo;
    return (
        <View style={[s.screen, { backgroundColor: p.bg, paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]}>
            <Text style={[s.brand, { color: p.fg }]} accessibilityRole="header">window.ml</Text>
            <Text style={[s.lede, { color: p.fgDim }]}>A remote for your browsers: their sessions, their runs, their approvals, from here. Nothing runs on this device.</Text>
            <View style={{ flex: 1 }} />
            <Card>
                <Text style={[s.cardTitle, { color: p.fg }]}>This phone is in no account</Text>
                <Text style={[s.body, { color: p.fgDim }]}>An account is how your devices reach each other through a hub: this phone driving your browser, your browser watching a box.</Text>
                <Button primary title="Join an account" onPress={() => nav.navigate("Join")} disabled={!info} />
                {info?.canCreate ? <Button title="Create an account" onPress={() => nav.navigate("Create")} /> : null}
            </Card>
        </View>
    );
}

/** The bar at the top of a screen pushed from another: back, and the screen's name. */
export function Bar({ title }: { title: string }) {
    const p = usePalette();
    const nav = useNavigation();
    return (
        <View style={s.bar}>
            <IconButton label="Back" icon={(c) => <ChevronLeft size={26} color={c} />} onPress={() => nav.goBack()} />
            <Text style={[s.barTitle, { color: p.fg }]} accessibilityRole="header">{title}</Text>
        </View>
    );
}

/** What an offer shows while it waits: the code to type, the fingerprint to compare, and the QR code to scan instead. */
interface Offer { offer: string; code: string; fingerprint: string; qr: string | null; expiresAt: number }

/** Joining: name this phone and say which hub, then show the code until a device that may pair confirms it. */
export function JoinScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const e = useEmbed();
    const info = e.pairingInfo;
    const [label, setLabel] = useState(info?.defaultLabel ?? "Phone");
    const [hubUrl, setHubUrl] = useState(info?.defaultHubUrl ?? "");
    const [offer, setOffer] = useState<Offer | null>(null);
    const [state, setState] = useState<"idle" | "busy" | "paired">("idle");
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(Date.now());
    const current = useRef<string | null>(null);

    useEffect(() => e.onPairingDone((d) => {
        if (d.offer !== current.current) return;
        if (d.ok) setState("paired");
        else { setOffer(null); setState("idle"); setError(d.error ?? "It did not complete. Try again."); }
    }), [e]);
    useEffect(() => {
        if (!offer) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [offer]);
    // Leaving the screen while waiting withdraws the offer: a code nobody is showing should not stay answerable.
    useEffect(() => () => { if (current.current && state !== "paired") void e.pairing("cancelOffer", { offer: current.current }); }, []);

    const start = async () => {
        setError(null);
        setState("busy");
        const r = await e.pairing<Offer>("beginOffer", { hubUrl: hubUrl.trim(), label: label.trim() });
        if (!r.ok) { setState("idle"); setError(r.error); return; }
        current.current = r.value.offer;
        setOffer(r.value);
        setState("idle");
    };
    const cancel = () => {
        if (current.current) void e.pairing("cancelOffer", { offer: current.current });
        current.current = null;
        setOffer(null);
    };
    const left = offer ? Math.max(0, Math.round((offer.expiresAt - now) / 1000)) : 0;

    return (
        <KeyboardAvoidingView behavior="padding" style={[s.flex, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <Bar title="Join an account" />
            <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
                {state === "paired" ? (
                    <Card>
                        <Text style={[s.cardTitle, { color: p.fg }]}>Paired</Text>
                        <Text style={[s.body, { color: p.fgDim }]}>This phone is in the account now. Connecting…</Text>
                    </Card>
                ) : offer ? (
                    <Card>
                        <Text style={[s.body, { color: p.fgDim }]}>On a device already in the account (the one that created it, or one allowed to pair), open Settings → Devices → Pair a device, and scan this code or type it.</Text>
                        {offer.qr ? <View style={s.qr}><Qr text={offer.qr} size={220} /></View> : null}
                        <View style={s.pairRow}>
                            <Text style={[s.small, { color: p.fgDim }]}>Code</Text>
                            <Text selectable style={[s.code, { color: p.fg }]}>{groupFour(offer.code)}</Text>
                        </View>
                        <View style={s.pairRow}>
                            <Text style={[s.small, { color: p.fgDim }]}>This phone's fingerprint</Text>
                            <Text selectable style={[s.fp, { color: p.fg }]}>{groupFour(offer.fingerprint)}</Text>
                            <Text style={[s.hint, { color: p.fgFaint }]}>The other device shows a fingerprint too: pair only if the two match.</Text>
                        </View>
                        <Text style={[s.hint, { color: p.fgFaint }]}>{left > 0 ? `Waiting for the other device. The code lasts ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more.` : "The code has expired."}</Text>
                        <Button title="Cancel" onPress={cancel} />
                    </Card>
                ) : (
                    <Card>
                        <Field label="Call this phone" value={label} onChangeText={setLabel} placeholder="Phone" hint="What the other devices in the account will see it as." />
                        <Field label="Hub" value={hubUrl} onChangeText={setHubUrl} placeholder="wss://hub.example" autoCapitalize="none" keyboardType="url" mono
                            hint="The hub the account uses: the address the other device shows under Devices." />
                        {error ? <Text style={[s.error, { color: p.err }]}>{error}</Text> : null}
                        <Button primary title="Show my code" busy={state === "busy"} disabled={!label.trim() || !hubUrl.trim()} onPress={start} />
                    </Card>
                )}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

/** Creating an account: this phone becomes its root, which is said plainly before anyone relies on it. */
export function CreateScreen() {
    const p = usePalette();
    const insets = useSafeAreaInsets();
    const e = useEmbed();
    const info = e.pairingInfo;
    const [label, setLabel] = useState(info?.defaultLabel ?? "Phone");
    const [hubUrl, setHubUrl] = useState(info?.defaultHubUrl ?? "");
    const [invite, setInvite] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [made, setMade] = useState<Membership | null>(null);
    const create = async () => {
        setError(null);
        setBusy(true);
        const r = await e.pairing<Membership>("createAccount", { hubUrl: hubUrl.trim(), label: label.trim(), ...(invite.trim() ? { invite: invite.trim() } : {}) });
        setBusy(false);
        if (r.ok) setMade(r.value); else setError(r.error);
    };
    return (
        <KeyboardAvoidingView behavior="padding" style={[s.flex, { backgroundColor: p.bg, paddingTop: insets.top }]}>
            <Bar title="Create an account" />
            <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
                {made ? (
                    <Card>
                        <Text style={[s.cardTitle, { color: p.fg }]}>The account is made</Text>
                        <Text style={[s.body, { color: p.fgDim }]}>This phone holds its root. Next, pair your browser from Settings → Devices. Connecting…</Text>
                    </Card>
                ) : (
                    <Card>
                        <View style={[s.warn, { backgroundColor: p.scheme === "dark" ? "#2a2410" : "#fef9c3" }]}>
                            <Text style={[s.body, { color: p.fg }]}>This phone will hold the account's root key, kept in {info?.rootKeptIn ?? "this app's storage"}. Uninstalling the app or clearing its data loses the root for good, and with it the power to pair new devices.</Text>
                        </View>
                        <Field label="Call this phone" value={label} onChangeText={setLabel} placeholder="Phone" />
                        <Field label="Hub" value={hubUrl} onChangeText={setHubUrl} placeholder="wss://hub.example" autoCapitalize="none" keyboardType="url" mono />
                        <Field label="Invite (if the hub asks for one)" value={invite} onChangeText={setInvite} autoCapitalize="none" mono />
                        {error ? <Text style={[s.error, { color: p.err }]}>{error}</Text> : null}
                        <Button primary title="Create the account" busy={busy} disabled={!label.trim() || !hubUrl.trim()} onPress={create} />
                    </Card>
                )}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const s = StyleSheet.create({
    // A screen that fills what it is given.
    flex: { flex: 1 },
    // The welcome screen: the name at the top, the card at the bottom within reach of a thumb.
    screen: { flex: 1, paddingHorizontal: SIZE.gutter + 4 },
    // "window.ml", large.
    brand: { fontSize: 34, fontWeight: "700", letterSpacing: -0.5 },
    // What the app is, under the name.
    lede: { fontSize: 17, lineHeight: 25, marginTop: 12 },
    // Back and the screen's name.
    bar: { flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 6, height: 52 },
    // The screen's name in the bar.
    barTitle: { fontSize: SIZE.heading, fontWeight: "600" },
    // A pushed screen's scrolling body, the card inset from the edges.
    content: { padding: SIZE.gutter },
    // A card's heading.
    cardTitle: { fontSize: SIZE.heading, fontWeight: "700" },
    // A card's running text.
    body: { fontSize: 15, lineHeight: 22 },
    // A small label over a value.
    small: { fontSize: 13, fontWeight: "600" },
    // What to do or when, small and faint.
    hint: { fontSize: 12.5, lineHeight: 18 },
    // The QR code, centred in the card.
    qr: { alignItems: "center", paddingVertical: 4 },
    // A label with its value under it.
    pairRow: { gap: 4 },
    // The code, large, in groups of four.
    code: { fontSize: 30, fontWeight: "700", letterSpacing: 2, fontVariant: ["tabular-nums"] },
    // The fingerprint, in groups of four, in the code face.
    fp: { fontSize: 20, fontWeight: "600", letterSpacing: 1, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
    // Why it failed, in the error colour.
    error: { fontSize: 14, lineHeight: 20 },
    // The root warning: a tinted box above the fields.
    warn: { borderRadius: 12, padding: 12 },
});
