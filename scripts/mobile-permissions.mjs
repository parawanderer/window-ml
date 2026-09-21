// mobile-permissions.mjs — what the phone app must DECLARE to use the camera (scanning a pairing QR code), written into
// the native projects `cap add` generates. They are not checked in (capacitor.config.ts says why), so the declarations
// are added after each scaffold, idempotently, by `scripts/mobile.mjs`. Pure text edits, tested in
// tests/mobile-permissions.test.mjs.

/** Why the app asks for the camera, in the words iOS shows in its prompt. */
export const CAMERA_REASON = "To scan the QR code another device shows when you pair it with your account.";

/** AndroidManifest.xml with the CAMERA permission (Capacitor's web view then grants getUserMedia on request). */
export function withAndroidCamera(manifest) {
    if (manifest.includes("android.permission.CAMERA")) return manifest;
    return manifest.replace(/<\/manifest>\s*$/, `    <uses-permission android:name="android.permission.CAMERA" />\n</manifest>\n`);
}

/** Info.plist with NSCameraUsageDescription: iOS refuses the camera outright, and may reject the app, without it. */
export function withIosCamera(plist) {
    if (plist.includes("NSCameraUsageDescription")) return plist;
    return plist.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>NSCameraUsageDescription</key>\n\t<string>${CAMERA_REASON}</string>\n</dict>\n</plist>\n`);
}
