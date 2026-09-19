// qr-scan.tsx — READING A PAIRING QR CODE with the device's camera, on the device that pairs (the phone, the desktop
// app). The browser's own reader (`BarcodeDetector`: Chrome, Android) where there is one, and jsQR (pure JavaScript)
// where there is not, which includes every WebKit, so the iPhone app and Safari scan too.
//
// It hands back TEXT and decides nothing: whether that text is a pairing code, and whether its keys match, is
// `lookupScanned`'s to say (pair-flow.ts), where the check is.

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "preact/hooks";

/** How often a frame is looked at: often enough to feel instant, rarely enough to leave a phone's CPU alone. */
const EVERY_MS = 150;

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };

/** The browser's QR reader, or null where it has none (or cannot read QR codes). */
async function nativeDetector(): Promise<Detector | null> {
    const BD = (globalThis as { BarcodeDetector?: { new(o: { formats: string[] }): Detector; getSupportedFormats?(): Promise<string[]> } }).BarcodeDetector;
    if (!BD) return null;
    try {
        const formats = await BD.getSupportedFormats?.();
        return formats && !formats.includes("qr_code") ? null : new BD({ formats: ["qr_code"] });
    } catch { return null; }
}

/** Why the camera could not be used, in words, with what to do instead. */
function cameraProblem(err: unknown): string {
    const name = (err as { name?: string } | null)?.name;
    if (name === "NotAllowedError") return "The camera was not allowed. Allow it for this app (or site) in the device's settings, or type the code instead.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "There is no camera here. Type the code instead.";
    return "The camera could not be started. Type the code instead.";
}

/** Can this device try to scan at all? (It may still be refused when it asks.) */
export function canScan(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/** The camera's view, read until it finds a QR code; `onText` gets the first one, once. */
export function QrScanner({ onText, onCancel }: { onText: (text: string) => void; onCancel: () => void }) {
    const video = useRef<HTMLVideoElement>(null);
    const [problem, setProblem] = useState("");
    useEffect(() => {
        let stream: MediaStream | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let done = false;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        void (async () => {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
            } catch (err) { setProblem(cameraProblem(err)); return; }
            if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
            const v = video.current!;
            v.srcObject = stream;
            await v.play().catch(() => {});
            const native = await nativeDetector();
            const look = async () => {
                if (done) return;
                let text: string | null = null;
                if (v.videoWidth) {
                    if (native) {
                        text = (await native.detect(v).catch(() => []))[0]?.rawValue ?? null;
                    } else if (ctx) {
                        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
                        ctx.drawImage(v, 0, 0);
                        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                        text = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
                    }
                }
                if (text && !done) { done = true; onText(text); return; }
                timer = setTimeout(look, EVERY_MS);
            };
            void look();
        })();
        // The camera is released the moment the scanner goes: a light left on after the screen moved on is a leak
        // anyone can see.
        return () => { done = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
    }, []);
    return (
        <div class="pair-scan" role="group" aria-label="Scan the QR code">
            {problem ? <p class="pair-problem" role="alert">{problem}</p>
                : <video ref={video} class="pair-scan-view" muted playsInline aria-label="Camera: point it at the QR code on the new device" />}
            <p class="pair-hint">Point the camera at the QR code on the new device's screen.</p>
            <div class="pair-actions"><button class="btn" onClick={onCancel}>Type the code instead</button></div>
        </div>
    );
}
