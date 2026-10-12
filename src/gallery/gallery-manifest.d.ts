// gallery-manifest.d.ts — the virtual module scripts/gallery.mjs hands the gallery bundle: the generated manifest, and a
// loader per component module and per custom entry module, so one module that fails to import breaks only its entries.
declare module "gallery:manifest" {
    import type { GalleryEntry, ManifestComponent } from "./gallery-entry";
    export const components: ManifestComponent[];
    export const loaders: Record<string, () => Promise<Record<string, unknown>>>;
    export const custom: Record<string, () => Promise<{ gallery: GalleryEntry[] }>>;
}
