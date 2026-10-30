import noteEditorAsset from "@goat/mobile-note-editor/note-editor.html";
import { Asset } from "expo-asset";
import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Platform, View, useWindowDimensions } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { resolveNativeMarkdownTypography } from "../../../lib/appearancePreferences";
import {
  parseNoteEditorMessage,
  type NoteEditorCommand,
  type NoteEditorConfig,
  type NoteEditorInbound,
  type NoteEditorTheme,
  type NoteLineBreak,
} from "./note-editor-protocol";
import { NoteEditorBridge } from "./note-editor-bridge";

const READY_TIMEOUT_MS = 10_000;
let editorUri: Promise<string> | null = null;
/** Copies the bundled editor page to a readable file the first time a note opens. */
function loadEditorUri() {
  editorUri ??= Asset.fromModule(noteEditorAsset)
    .downloadAsync()
    .then((asset) => asset.localUri ?? asset.uri)
    .catch((error: unknown) => {
      editorUri = null;
      throw error;
    });
  return editorUri;
}

export function useNoteEditorTheme(): NoteEditorTheme {
  const { appearance, themeVariables: theme, themeAppearance } = useAppearancePreferences();
  // WebViews ignore the system text size, so apply it here.
  const { fontScale } = useWindowDimensions();
  const typography = resolveNativeMarkdownTypography(appearance.baseFontSize);
  const scale = (size: number) => Math.round(size * fontScale * 10) / 10;
  return {
    background: theme["--color-sheet"],
    text: theme["--color-md-body"],
    strong: theme["--color-md-strong"],
    muted: theme["--color-foreground-muted"],
    link: theme["--color-md-link"],
    accent: theme["--color-primary"],
    codeBackground: theme["--color-md-code-bg"],
    codeText: theme["--color-md-code-text"],
    quoteBorder: theme["--color-md-blockquote-border"],
    rule: theme["--color-md-hr"],
    dark: themeAppearance === "dark",
    fontSize: scale(typography.fontSize),
    lineHeight: scale(typography.lineHeight),
    headingSizes: typography.headingFontSizes.map(scale),
  };
}

export interface NoteLiveEditorHandle {
  readonly command: (command: NoteEditorCommand) => void;
}

interface NoteLiveEditorProps {
  readonly ref?: Ref<NoteLiveEditorHandle>;
  readonly value: string;
  readonly lineBreak: NoteLineBreak;
  readonly config: NoteEditorConfig;
  readonly autoFocus?: boolean;
  readonly onChange: (value: string, checkbox: boolean) => void;
  readonly onFocusChange: (focused: boolean) => void;
  readonly onSourceChange: (source: boolean) => void;
  readonly onLink: (href: string) => void;
  /** The editor page could not load; the screen shows markdown source instead. */
  readonly onUnavailable: (reason: string) => void;
}

export function NoteLiveEditor({ ref, ...props }: NoteLiveEditorProps) {
  const [uri, setUri] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const page = useRef<NoteLiveEditorHandle>(null);
  useImperativeHandle(ref, () => ({ command: (command) => page.current?.command(command) }), []);
  const unavailable = useEffectEvent(() =>
    props.onUnavailable("The live editor could not load, so this note opens as markdown source."),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- loads the editor asset only when a note opens
  useEffect(() => {
    let active = true;
    loadEditorUri().then(
      (next) => active && setUri(next),
      () => active && unavailable(),
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <View className="flex-1" style={{ backgroundColor: props.config.theme.background }}>
      {uri ? (
        <NoteEditorPage
          key={attempt}
          ref={page}
          uri={uri}
          {...props}
          // The OS can end a WebView's process under memory pressure; start a fresh page.
          onTerminated={() => {
            // The fresh page starts unfocused; the screen must not keep editing chrome for it.
            props.onFocusChange(false);
            setAttempt((value) => value + 1);
          }}
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator />
        </View>
      )}
    </View>
  );
}

function NoteEditorPage({
  ref,
  uri,
  onTerminated,
  ...props
}: NoteLiveEditorProps & { readonly uri: string; readonly onTerminated: () => void }) {
  const webView = useRef<WebView<object>>(null);
  const [ready, setReady] = useState(false);
  const [bridge] = useState(() => new NoteEditorBridge(props.value));
  const sentConfig = useRef(JSON.stringify(props.config));
  const [openedAt] = useState(() => performance.now());
  const [boot] = useState(
    () =>
      "window.__goatNoteEditor=" +
      JSON.stringify({
        doc: props.value,
        generation: 0,
        lineBreak: props.lineBreak,
        config: props.config,
      }) +
      ";true;",
  );
  const send = (message: NoteEditorInbound) =>
    webView.current?.postMessage(JSON.stringify(message));
  const fail = (detail: string) => {
    if (__DEV__) console.warn("[notes] live editor unavailable:", detail);
    props.onUnavailable("The live editor could not start, so this note opens as markdown source.");
  };
  useImperativeHandle(
    ref,
    () => ({ command: (command) => send({ type: "command", command }) }),
    [],
  );
  const giveUp = useEffectEvent(() => fail("no ready signal"));
  // oxlint-disable-next-line goat/react-effect-budget -- a page that never boots must fall back to source
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(giveUp, READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  // oxlint-disable-next-line goat/react-effect-budget -- pushes hub updates and theme changes into the WebView
  useEffect(() => {
    if (!ready) return;
    const replacement = bridge.sync(props.value);
    if (replacement) send(replacement);
    const config = JSON.stringify(props.config);
    if (config !== sentConfig.current) {
      sentConfig.current = config;
      send({ type: "config", config: props.config });
    }
  });
  const onMessage = (event: WebViewMessageEvent) => {
    const message = parseNoteEditorMessage(event.nativeEvent.data);
    if (!message) return;
    switch (message.type) {
      case "ready":
        setReady(true);
        if (__DEV__)
          console.info(
            "[notes] live editor ready in " +
              Math.round(performance.now() - openedAt) +
              " ms (page " +
              message.bootMs +
              " ms)",
          );
        if (props.autoFocus) send({ type: "command", command: "focus" });
        return;
      case "change":
      case "doc": {
        const receipt = bridge.receive(message);
        if (receipt.value) props.onChange(receipt.value.text, receipt.value.checkbox);
        if (receipt.send) send(receipt.send);
        return;
      }
      case "focus":
        props.onFocusChange(message.focused);
        return;
      case "source":
        props.onSourceChange(message.source);
        return;
      case "link":
        props.onLink(message.href);
        return;
      case "error":
        if (!ready) fail(message.message);
        else if (__DEV__) console.warn("[notes] live editor error:", message.message);
        return;
    }
  };
  return (
    <WebView<object>
      ref={webView}
      source={{ uri }}
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(request) => request.url === uri}
      allowFileAccess
      allowingReadAccessToURL={uri.slice(0, uri.lastIndexOf("/") + 1)}
      injectedJavaScriptBeforeContentLoaded={boot}
      onMessage={onMessage}
      onError={(event) => fail(event.nativeEvent.description)}
      onHttpError={(event) => fail("HTTP " + event.nativeEvent.statusCode)}
      hideKeyboardAccessoryView
      keyboardDisplayRequiresUserAction={false}
      scrollEnabled={false}
      bounces={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      textZoom={100}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      webviewDebuggingEnabled={__DEV__}
      onContentProcessDidTerminate={onTerminated}
      onRenderProcessGone={onTerminated}
      style={{ flex: 1, backgroundColor: "transparent", opacity: ready ? 1 : 0 }}
      containerStyle={Platform.OS === "android" ? { overflow: "hidden" } : undefined}
    />
  );
}
