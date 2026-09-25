// routes.ts — THE APP'S SCREENS, as the navigation stack knows them. The open session is not one of them: it is a layer
// over the stack (layer.tsx), so its WebView is never remounted.

/** Each screen's parameters. */
export type Routes = {
    List: undefined;
    /** `runtime`: the device to arrive with already chosen, where the start began at one (a runtime's `+` in the
     *  list). Absent starts where the screen would have anyway. */
    NewChat: { runtime?: string } | undefined;
    Search: undefined;
    Attention: undefined;
    Settings: undefined;
    /** One runtime: what it is, the models it offers, what it keeps. */
    Runtime: { id: string };
    Devices: undefined;
    Pair: undefined;
    Welcome: undefined;
    Join: undefined;
    Create: undefined;
};
