// index.ts — the app's entry: registers the root component (App.tsx) with Expo, for both the Expo Go loader and a
// native build.

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
