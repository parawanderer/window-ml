// App.tsx — THE PHONE APP'S ROOT (docs/spec/NATIVE_SHELL.md): the providers, the navigation stack (the list, new chat,
// settings), the session layer above it (which holds the one WebView), and the toast. It loads the drafts and the theme
// choice before the first frame, and tells the page the theme whenever it changes.

import { useEffect, useMemo, useState } from "react";
import { StatusBar, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { loadDrafts } from "./src/drafts";
import { EmbedProvider, useEmbed } from "./src/embed";
import { SessionLayer, SessionLayerProvider } from "./src/layer";
import type { Routes } from "./src/routes";
import { ListScreen } from "./src/screens/ListScreen";
import { NewChatScreen } from "./src/screens/NewChatScreen";
import { SearchScreen } from "./src/screens/SearchScreen";
import { AttentionScreen } from "./src/screens/AttentionScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { CreateScreen, JoinScreen, WelcomeScreen } from "./src/screens/AccountScreens";
import { DevicesScreen, PairScreen } from "./src/screens/DeviceScreens";
import { RuntimeScreen } from "./src/screens/RuntimeScreen";
import { ThemeChoiceContext, usePalette, type ThemeChoice } from "./src/theme";
import { Toast } from "./src/ui";
import { ImageViewer } from "./src/viewer";

const Stack = createNativeStackNavigator<Routes>();
const THEME_KEY = "wml-theme";

/** The app: waits for the drafts and the theme choice, then draws. */
export default function App() {
    const [loaded, setLoaded] = useState(false);
    const [choice, setChoiceState] = useState<ThemeChoice>("system");
    useEffect(() => {
        void Promise.all([loadDrafts(), AsyncStorage.getItem(THEME_KEY)]).then(([, t]) => {
            if (t === "light" || t === "dark" || t === "system") setChoiceState(t);
            setLoaded(true);
        });
    }, []);
    const theme = useMemo(() => ({ choice, setChoice: (c: ThemeChoice) => { setChoiceState(c); void AsyncStorage.setItem(THEME_KEY, c); } }), [choice]);
    if (!loaded) return null;
    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <SafeAreaProvider>
                <KeyboardProvider>
                    <ThemeChoiceContext.Provider value={theme}>
                        <EmbedProvider>
                            <SessionLayerProvider>
                                <BottomSheetModalProvider>
                                    <Shell />
                                </BottomSheetModalProvider>
                            </SessionLayerProvider>
                        </EmbedProvider>
                    </ThemeChoiceContext.Provider>
                </KeyboardProvider>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
}

/** Everything under the providers: the stack, the layer over it, the toast over both. */
function Shell() {
    const p = usePalette();
    const e = useEmbed();
    const insets = useSafeAreaInsets();
    useEffect(() => {
        e.theme({ scheme: p.scheme, fontScale: 1, insets: { top: 0, bottom: 0, left: insets.left, right: insets.right }, reducedMotion: false });
    }, [p.scheme, insets.left, insets.right]);
    const nav = p.scheme === "dark" ? DarkTheme : DefaultTheme;
    const firstRun = e.account === null && !e.demo;
    return (
        <View style={{ flex: 1, backgroundColor: p.bg }}>
            <StatusBar barStyle={p.scheme === "dark" ? "light-content" : "dark-content"} />
            <NavigationContainer theme={{ ...nav, colors: { ...nav.colors, background: p.bg, card: p.bg, text: p.fg, border: p.border, primary: p.accent } }}>
                {/* Before an account, only the ways into one; once the page reports an account, the app. Switching the set
                    of screens (not navigating) is what makes a join land on the list with no way back to "Join". */}
                <Stack.Navigator screenOptions={{ headerShown: false, animation: "default" }}>
                    {firstRun ? <>
                        <Stack.Screen name="Welcome" component={WelcomeScreen} />
                        <Stack.Screen name="Join" component={JoinScreen} />
                        <Stack.Screen name="Create" component={CreateScreen} />
                    </> : <>
                        <Stack.Screen name="List" component={ListScreen} />
                        <Stack.Screen name="NewChat" component={NewChatScreen} />
                        <Stack.Screen name="Search" component={SearchScreen} />
                        <Stack.Screen name="Attention" component={AttentionScreen} />
                        <Stack.Screen name="Settings" component={SettingsScreen} />
                        <Stack.Screen name="Devices" component={DevicesScreen} />
                        <Stack.Screen name="Runtime" component={RuntimeScreen} />
                        <Stack.Screen name="Pair" component={PairScreen} />
                    </>}
                </Stack.Navigator>
            </NavigationContainer>
            <SessionLayer />
            <Toast notice={e.notice} bottom={insets.bottom + 90} />
            <ImageViewer src={e.image} onClose={e.closeImage} />
        </View>
    );
}
