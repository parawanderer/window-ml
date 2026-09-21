// metro.config.js — the app's bundler, told about the one folder outside mobile/ it reads: the repo's src/native/
// (the bridge's message types and checks, shared with the page). Nothing else of src/ is bundled into the app.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "..", "src", "native")];
module.exports = config;
