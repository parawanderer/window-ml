// The phone app's camera declarations, added to the native projects cap generates (scripts/mobile-permissions.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMERA_REASON, withAndroidCamera, withIosCamera } from "../scripts/mobile-permissions.mjs";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application />\n    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>\n`;
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>App</string>\n</dict>\n</plist>\n`;

test("Android: the CAMERA permission is declared once, inside the manifest", () => {
    const once = withAndroidCamera(MANIFEST);
    assert.match(once, /<uses-permission android:name="android.permission.CAMERA" \/>\n<\/manifest>\n$/);
    assert.equal(withAndroidCamera(once), once, "a second sync adds nothing");
});

test("iOS: the camera's reason is declared once, inside the plist's dict, in words the prompt can show", () => {
    const once = withIosCamera(PLIST);
    assert.match(once, /<key>NSCameraUsageDescription<\/key>\n\t<string>[^<]+<\/string>\n<\/dict>\n<\/plist>\n$/);
    assert.ok(once.includes(CAMERA_REASON));
    assert.equal(withIosCamera(once), once, "a second sync adds nothing");
});
