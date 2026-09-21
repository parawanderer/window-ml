// scanner.tsx — READING A PAIRING QR CODE with the camera, full screen: the code a new device shows under Join an account,
// read on a device already in the account (Settings → Devices → Pair a device). The text it reads goes to the page's
// `lookupScanned` unchanged, which checks the keys against the fingerprint the code carries; this file only reads.
//
// The first QR code seen is handed over once, and the camera is closed, so a code held in view is not looked up again
// and again. Without the camera permission it says so, and where to turn it on, since the platform will not ask twice.

import { useEffect, useRef } from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { X } from "lucide-react-native";

/** The scanner, over everything while `open`. `onScanned` gets the first QR code's text; the caller closes it. */
export function QrScanner({ open, onScanned, onClose }: { open: boolean; onScanned: (text: string) => void; onClose: () => void }) {
    const insets = useSafeAreaInsets();
    const [perm, ask] = useCameraPermissions();
    const handed = useRef(false);
    useEffect(() => {
        if (!open) return;
        handed.current = false;
        if (perm && !perm.granted && perm.canAskAgain) void ask();
    }, [open, perm?.granted]);

    return (
        <Modal visible={open} animationType="slide" statusBarTranslucent onRequestClose={onClose} presentationStyle="fullScreen">
            <View style={s.root}>
                {perm?.granted ? (
                    <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                        onBarcodeScanned={(r) => { if (handed.current || !r.data) return; handed.current = true; onScanned(r.data); }} />
                ) : perm && !perm.canAskAgain ? (
                    <View style={s.denied}>
                        <Text style={s.deniedText}>The camera is off for this app. Turn it on in the system Settings to scan a code, or type the code instead.</Text>
                        <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} style={({ pressed }) => [s.settings, pressed && { opacity: 0.6 }]}>
                            <Text style={s.settingsText}>Open Settings</Text>
                        </Pressable>
                    </View>
                ) : null}
                {/* Where to hold the code: a square in the middle, the rest dimmed by nothing but the frame itself. */}
                {perm?.granted ? <View pointerEvents="none" style={s.frameWrap}><View style={s.frame} /></View> : null}
                <View style={[s.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
                    <Pressable accessibilityRole="button" accessibilityLabel="Close the scanner" hitSlop={10} onPress={onClose} style={({ pressed }) => [s.btn, pressed && { opacity: 0.6 }]}>
                        <X size={22} color="#fff" />
                    </Pressable>
                </View>
                <Text style={[s.caption, { bottom: insets.bottom + 40 }]}>Point at the code the new device shows.</Text>
            </View>
        </Modal>
    );
}

const s = StyleSheet.create({
    // Black, as a camera view is, whatever the theme.
    root: { flex: 1, backgroundColor: "#000" },
    // The close button's row, under the status bar.
    top: { position: "absolute", left: 12, right: 12, top: 0, flexDirection: "row" },
    // A round button that stays legible over the picture.
    btn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.5)" },
    // Centres the frame.
    frameWrap: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
    // The square to hold the code in.
    frame: { width: 240, height: 240, borderRadius: 24, borderWidth: 3, borderColor: "rgba(255,255,255,0.9)" },
    // What to do, under the frame.
    caption: { position: "absolute", left: 24, right: 24, textAlign: "center", color: "#fff", fontSize: 16, fontWeight: "600" },
    // No camera: why, and the way to Settings.
    denied: { flex: 1, justifyContent: "center", padding: 32, gap: 16 },
    // Its sentence.
    deniedText: { color: "#fff", fontSize: 16, lineHeight: 23, textAlign: "center" },
    // "Open Settings", outlined in white on the black.
    settings: { alignSelf: "center", paddingHorizontal: 22, paddingVertical: 12, borderRadius: 22, borderWidth: 1, borderColor: "#fff" },
    // Its word.
    settingsText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
