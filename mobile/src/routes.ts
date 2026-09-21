// routes.ts — THE APP'S SCREENS, as the navigation stack knows them. The open session is not one of them: it is a layer
// over the stack (layer.tsx), so its WebView is never remounted.

/** Each screen's parameters. */
export type Routes = {
    List: undefined;
    NewChat: undefined;
    Search: undefined;
    Attention: undefined;
    Settings: undefined;
    Devices: undefined;
    Pair: undefined;
    Welcome: undefined;
    Join: undefined;
    Create: undefined;
};
