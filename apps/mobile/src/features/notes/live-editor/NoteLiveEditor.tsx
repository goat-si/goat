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
// How often to ask again for the page's text while React Native's copy may be stale.
const RESYNC_RETRY_MS = 1_000;
const SYNC_TIMEOUT_MS = 5_000;
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
  /**
   * Resolves true once React Native holds the page's whole current text (after any composing
   * syllable settles), and false if the page does not answer; a save waits for this.
   */
  readonly sync: () => Promise<boolean>;
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
  /** True while React Native's copy may lag the page; saving and leaving must wait. */
  readonly onPendingChange: (pending: boolean) => void;
  /** The page ended while it held text React Native had not received; that text is gone. */
  readonly onRecoveryLost: () => void;
}

export function NoteLiveEditor({ ref, ...props }: NoteLiveEditorProps) {
  const [uri, setUri] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const page = useRef<NoteLiveEditorHandle>(null);
  const pending = useRef(false);
  // True while the page may hold edits React Native never received: it had focus, or a re-sync
  // is outstanding, and no snapshot has confirmed the copy since.
  const uncertain = useRef(false);
  useImperativeHandle(
    ref,
    () => ({
      command: (command) => page.current?.command(command),
      sync: () => page.current?.sync() ?? Promise.resolve(false),
    }),
    [],
  );
  const unavailable = useEffectEvent(() =>
    props.onUnavailable("The live editor could not load, so this note opens as markdown source."),
  );
  const ended = () => {
    if (pending.current || uncertain.current) props.onRecoveryLost();
    pending.current = false;
    uncertain.current = false;
  };
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
          uncertain={uncertain}
          onUnavailable={(reason) => {
            ended();
            props.onUnavailable(reason);
          }}
          onPendingChange={(value) => {
            pending.current = value;
            props.onPendingChange(value);
          }}
          // The OS can end a WebView's process under memory pressure; start a fresh page.
          onTerminated={() => {
            ended();
            // The fresh page starts unfocused; the screen must not keep editing chrome for it.
            props.onFocusChange(false);
            props.onPendingChange(false);
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
}: NoteLiveEditorProps & {
  readonly uri: string;
  readonly onTerminated: () => void;
  readonly uncertain: { current: boolean };
}) {
  const webView = useRef<WebView<object>>(null);
  const [ready, setReady] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const focused = useRef(false);
  const waiters = useRef<Array<(synced: boolean) => void>>([]);
  const notePending = () => {
    if (!bridge.pending) {
      if (!focused.current) props.uncertain.current = false;
      for (const resolve of waiters.current.splice(0)) resolve(true);
    } else props.uncertain.current = true;
    if (bridge.pending === resyncing) return;
    setResyncing(bridge.pending);
    props.onPendingChange(bridge.pending);
  };
  const barrier = () => {
    send(bridge.barrier());
    notePending();
  };
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
    () => ({
      command: (command) => send({ type: "command", command }),
      sync: () =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            waiters.current = waiters.current.filter((waiter) => waiter !== done);
            resolve(false);
          }, SYNC_TIMEOUT_MS);
          const done = (synced: boolean) => {
            clearTimeout(timer);
            resolve(synced);
          };
          waiters.current.push(done);
          barrier();
        }),
    }),
    [],
  );
  const giveUp = useEffectEvent(() => fail("no ready signal"));
  const askAgain = useEffectEvent(() => {
    const request = bridge.retry();
    if (request) send(request);
  });
  // oxlint-disable-next-line goat/react-effect-budget -- a lost snapshot reply must not wait for more typing
  useEffect(() => {
    if (!resyncing) return;
    const timer = setInterval(askAgain, RESYNC_RETRY_MS);
    return () => clearInterval(timer);
  }, [resyncing]);
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
    // A replacement ends any resync; the next snapshot reply clears the pending state.
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
        notePending();
        return;
      }
      case "focus":
        focused.current = message.focused;
        if (message.focused) props.uncertain.current = true;
        // Leaving the editor confirms the copy, so a later crash need not warn.
        else barrier();
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
      onContentProcessDidTerminate={() => {
        for (const resolve of waiters.current.splice(0)) resolve(false);
        onTerminated();
      }}
      onRenderProcessGone={() => {
        for (const resolve of waiters.current.splice(0)) resolve(false);
        onTerminated();
      }}
      style={{ flex: 1, backgroundColor: "transparent", opacity: ready ? 1 : 0 }}
      containerStyle={Platform.OS === "android" ? { overflow: "hidden" } : undefined}
    />
  );
}
