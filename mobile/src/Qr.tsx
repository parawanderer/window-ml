// Qr.tsx — A QR CODE, drawn: the pairing code a new device shows for the other device to scan (`WMLPAIR:1:<code>:<hex>`).
// Encoded with uqr, the same encoder and settings the page's `PairingQr` uses (src/pairing/pairing-ui.tsx), and drawn
// as ONE svg path rather than a view per module: a code is over a thousand modules.

import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { encode } from "uqr";

/** The code for `text`, `size` points square, dark modules on white whatever the theme: a scanner reads contrast. */
export function Qr({ text, size }: { text: string; size: number }) {
    const { n, d } = useMemo(() => {
        const q = encode(text, { ecc: "M", border: 2 });
        let path = "";
        q.data.forEach((row, y) => row.forEach((on, x) => { if (on) path += `M${x} ${y}h1v1h-1z`; }));
        return { n: q.size, d: path };
    }, [text]);
    return (
        <View accessibilityRole="image" accessibilityLabel="Pairing QR code" style={{ width: size, height: size, borderRadius: 12, overflow: "hidden" }}>
            <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`}>
                <Rect width={n} height={n} fill="#ffffff" />
                <Path d={d} fill="#000000" />
            </Svg>
        </View>
    );
}
