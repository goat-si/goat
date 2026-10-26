import type { KeepRule, PathRule, TextRule } from "./engine.ts";

/**
 * Mobile native modules and their JS bindings use GOAT names (plan 261026 wp6). Native names change only with a
 * native rebuild; the fingerprint runtime policy keeps OTA updates with the new names off older binaries. Names that
 * installed builds stored (Android prefs and notification tags, the push key) keep their spelling on lines marked
 * "goat-rename: legacy".
 */
const MODULES =
  "agent-notifications|composer-editor|native-controls|review-diff|source-text|subscription-widget|terminal|widget-expiry";
const PACKAGES =
  "agentnotifications|composereditor|nativecontrols|reviewdiff|terminal|widgetexpiry";
const CLASS_NAMES = [
  "SourceText",
  "ComposerEditor",
  "ComposerClipboard",
  "NativeControls",
  "NativeControlIcons",
  "KeyboardCommands",
  "FoldPosture",
  "WorkspaceNavigation",
  "WorkspaceOrientation",
  "MenuDismissTouchGate",
  "ReviewDiff",
  "Terminal",
  "WidgetExpiry",
  "AgentNotifications",
  "ChipIcons",
  "ContextChip",
  "SegmentedControl",
  "SidebarTabBar",
  "FrostedCutout",
  "LayoutMetrics",
  "NativeFilePresentation",
  "NativeVideoPresentation",
  "NativeVideo",
  "NativePresentation",
  "PresentationSource",
  "ContextSheetSize",
  "SelectableMarkdownText",
  "MarkdownText",
  "Mark",
  "Showcase",
  "Demo",
  "DeviceStream",
  "PreviewStream",
].join("|");

const OUTSIDE = new Set([
  "knip.jsonc",
  "vite.config.ts",
  "pnpm-workspace.yaml",
  "scripts/release-smoke.ts",
  "third-party-licenses.config.json",
  "scripts/export-goat-brand-icons.ts",
  "scripts/export-goat-brand-icons.test.ts",
  "scripts/mobile-native-static-check.ts",
  "docs/internals/mobile-navigation.md",
  "docs/operations/android-notifications.md",
]);

const inMobile = (path: string): boolean =>
  (path.startsWith("apps/mobile/") && !path.startsWith("apps/mobile/deps/")) ||
  path.startsWith("scripts/mobile-showcase") ||
  OUTSIDE.has(path);

const rule = (id: string, find: RegExp, replace: string): TextRule => ({
  id: "mobile:" + id,
  category: "mobile",
  find,
  replace,
  scope: inMobile,
});

export const MOBILE_TEXT_RULES: readonly TextRule[] = [
  rule("module-dirs", new RegExp("\\bt3-(?=(?:" + MODULES + ")\\b)", "g"), "goat-"),
  // JNI symbols (Java_expo_modules_t3terminal_), Kotlin packages and the CMake/loadLibrary target.
  rule("packages", new RegExp("(?<![A-Za-z0-9])t3(?=(?:" + PACKAGES + ")(?![a-z]))", "g"), "goat"),
  // Swift/Kotlin/ObjC classes, Expo module names, Fabric components and their RCT codegen classes.
  rule("classes", new RegExp("(?<![A-Za-z0-9])(RCT)?T3(?=(?:" + CLASS_NAMES + "))", "g"), "$1Goat"),
  rule("stream-globals", /T3(?=\$\{name\}Stream)/g, "Goat"),
  rule(
    "resources",
    /(?<![A-Za-z0-9])t3_(?=chats|menu|new_thread|pull_requests|settings|usage|subscription_widget_enabled|terminal)/g,
    "goat_",
  ),
  rule("first-responder", /\bt3FirstResponder\b/g, "goatFirstResponder"),
  rule("showcase-files", /\bt3-showcase-/g, "goat-showcase-"),
];

const inMobilePath = (path: string): boolean => path.startsWith("apps/mobile/");

export const MOBILE_PATH_RULES: readonly PathRule[] = [
  {
    id: "mobile:module-dirs",
    category: "mobile",
    find: new RegExp("^apps/mobile/modules/t3-(" + MODULES + ")/", "g"),
    replace: "apps/mobile/modules/goat-$1/",
  },
  {
    id: "mobile:java-packages",
    category: "mobile",
    find: new RegExp("(?<=/java/expo/modules/)t3(?=(?:" + PACKAGES + ")/)", "g"),
    replace: "goat",
    scope: inMobilePath,
  },
  {
    id: "mobile:class-files",
    category: "mobile",
    find: /(?<=\/)T3(?=[A-Z][^/]*$)/g,
    replace: "Goat",
    scope: (path) => /^apps\/mobile\/(?:modules|src\/native|assets\/widget)\//.test(path),
  },
  {
    id: "mobile:resource-files",
    category: "mobile",
    find: /(?<=\/)t3_(?=(?:terminal_jni\.cpp|chats|menu|new_thread|pull_requests|settings|usage)[^/]*$)/g,
    replace: "goat_",
    scope: inMobilePath,
  },
];

export const MOBILE_KEEP_RULES: readonly KeepRule[] = [
  {
    id: "mobile:stored-names",
    pattern:
      /t3-agent-(?:activity|alerts?|notifications)|expo\.modules\.t3widgetexpiry\.DEADLINES|\bt3_kind\b/g,
    scope: (path) =>
      /^apps\/mobile\/modules\/(?:t3|goat)-(?:agent-notifications|widget-expiry)\//.test(path),
    reason:
      "Installed builds stored these preference, tag and push-key names; they keep their spelling.",
  },
  {
    id: "mobile:vendor-tarballs",
    pattern:
      /react-native-(?:enriched-markdown|screens)-[\d.]+-t3\.\d+|fork\/t3-mobile|t3chat-markdown-parity-v2|t3-fork\.json|pack-t3\.mjs/g,
    scope: (path) =>
      path === "apps/mobile/package.json" ||
      path.startsWith("apps/mobile/deps/") ||
      path === "pnpm-workspace.yaml",
    reason:
      "Upstream fork tarballs keep their versioned file names (lockfile and allowBuilds identities).",
  },
];
