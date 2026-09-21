// attach.ts — IMAGES FOR THE COMPOSER: a photo from the library or the camera, shrunk until it fits a hub message, as the
// data URL `session.send` carries (src/session-host.ts). A phone photo is 3-5 MB and a sealed hub command is at most
// 1 MiB (src/hub/seal.ts `MAX_SEALED_BYTES`) with the text, the JSON and base64's third on top, so every image is
// resized on the phone and ALL of a message's images together are held to `IMAGE_BUDGET`. An image that cannot be made
// to fit is refused with a sentence, never sent to fail at the hub.
//
// Attachments are kept in memory per session, not in the drafts' storage: a failed send puts them back in the box, a
// send the app died during brings back its text only.

import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { fitEdge, MAX_IMAGES, shareFor, SHRINK_STEPS } from "./image-budget";

export { MAX_IMAGES } from "./image-budget";

/** Shrink one image until it is at most `limit` characters as a data URL; null when even the last step is too big. */
async function shrink(uri: string, width: number, height: number, limit: number): Promise<string | null> {
    for (const step of SHRINK_STEPS) {
        const ctx = ImageManipulator.manipulate(uri);
        const size = fitEdge(width, height, step.edge);
        if (size.width !== width || size.height !== height) ctx.resize(size);
        const out = await (await ctx.renderAsync()).saveAsync({ format: SaveFormat.JPEG, compress: step.quality, base64: true });
        const url = `data:image/jpeg;base64,${out.base64 ?? ""}`;
        if (out.base64 && url.length <= limit) return url;
    }
    return null;
}

/** What picking gave: the images to add, and a sentence for any that were not. */
export interface Picked { images: string[]; problem?: string }

/**
 * Pick images from the library (several) or take one with the camera, shrunk to fit beside `current`. Asks for the
 * permission it needs; a refusal is a sentence, since the platform will not ask twice.
 */
export async function pickImages(from: "library" | "camera", current: readonly string[]): Promise<Picked> {
    const slots = MAX_IMAGES - current.length;
    if (slots <= 0) return { images: [], problem: `A message carries at most ${MAX_IMAGES} images.` };
    const perm = from === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
        return { images: [], problem: from === "camera" ? "The camera is off for this app. Turn it on in the system Settings." : "Photos are off for this app. Turn them on in the system Settings." };
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, exif: false };
    const r = from === "camera" ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync({ ...opts, allowsMultipleSelection: slots > 1, selectionLimit: slots });
    if (r.canceled) return { images: [] };
    const got: string[] = [];
    let skipped = 0;
    const assets = r.assets.slice(0, slots);
    for (let i = 0; i < assets.length; i++) {
        const a = assets[i];
        const url = await shrink(a.uri, a.width, a.height, shareFor([...current, ...got], assets.length - i)).catch(() => null);
        if (url) got.push(url); else skipped++;
    }
    return {
        images: got,
        ...(skipped ? { problem: skipped === 1 ? "One image is too large to send over the hub, even made smaller." : `${skipped} images are too large to send over the hub, even made smaller.` } : {}),
    };
}
