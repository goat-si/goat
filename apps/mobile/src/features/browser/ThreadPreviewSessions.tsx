import { useAtomValue } from "@effect/atom-react";
import {
  orderPreviewSessions,
  previewSessionDetail,
  previewSessionControlUsesBrowser,
} from "@goat/client-runtime/state/preview-sessions";
import {
  previewSessionChip,
  type PreviewSession,
  type PreviewSessionControl,
  type PreviewSessionControlInput,
  type PreviewSessionNoPicture,
} from "@goat/contracts";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import {
  AppState,
  FlatList,
  Image,
  Keyboard,
  Pressable,
  View,
  type ListViewToken,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import {
  previewSessionsEnvironment,
  useDesktopSessionFrame,
  usePreviewSessions,
} from "../../state/previewSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadShell } from "../../state/entities";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { PreviewStreamWebView } from "./PreviewStreamWebView";
import { ThreadBrowserFloat } from "./ThreadBrowserFloat";

export function ThreadPreviewSessions(props: ComponentProps<typeof ThreadBrowserFloat>) {
  const query = usePreviewSessions(props.environmentId);
  const sessions = orderPreviewSessions(query.data?.sessions ?? []);
  const focused = useIsFocused();
  const [open, setOpen] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(new Set());
  const pendingBrowser = useRef<PreviewSession | null>(null);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const control = useAtomCommand(previewSessionsEnvironment.control);
  const canControl = useAtomValue(
    previewSessionsEnvironment.control.permissionAtom(props.environmentId),
  );
  const [viewabilityConfig] = useState(() => ({ itemVisiblePercentThreshold: 50 }));
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ListViewToken[] }) => {
      setVisibleIds(
        new Set(viewableItems.filter((item) => item.isViewable).map((item) => item.key)),
      );
    },
    [],
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    // Navigate after the inline native sheet has unmounted.
    const browser = pendingBrowser.current;
    if (
      open ||
      browser === null ||
      browser.target.kind !== "browser" ||
      browser.threadId === undefined
    )
      return;
    pendingBrowser.current = null;
    navigation.navigate("ThreadBrowserPreview", {
      environmentId: browser.environmentId,
      threadId: browser.threadId,
      tabId: browser.target.tabId,
    });
  }, [open, navigation]);
  const send = async (input: PreviewSessionControlInput) => {
    if (busy || !canControl) return;
    setBusy(true);
    setError(null);
    try {
      const result = await control({ environmentId: props.environmentId, input });
      if (result._tag === "Failure") setError("Could not change this preview session. Try again.");
      else if (!result.value.applied)
        setError(
          result.value.reason === "not_found"
            ? "This session is no longer available."
            : "This session does not allow that control.",
        );
    } finally {
      setBusy(false);
    }
  };
  const act = (session: PreviewSession, next: PreviewSessionControl) =>
    void send({ sessionId: session.id, control: next });
  const close = () => {
    setOpen(false);
    setVisibleIds(new Set());
  };
  return (
    <>
      <ThreadBrowserFloat {...props} top={props.top + (sessions.length > 0 ? 52 : 0)} />
      {sessions.length > 0 && focused ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${sessions.length} agents on screen`}
          accessibilityState={{ expanded: open }}
          onPress={() => {
            Keyboard.dismiss();
            setOpen(true);
          }}
          className="absolute right-3 z-30 min-h-11 justify-center rounded-full border border-border bg-sheet-solid px-4"
          style={{ top: props.top }}
        >
          <AppText className="text-xs font-goat-medium text-foreground">
            {sessions.length} agents on screen
          </AppText>
        </Pressable>
      ) : null}
      {open && focused ? (
        <Sheet title="Agents on screen" onClose={close}>
          <FlatList
            data={sessions}
            keyExtractor={(session) => session.id}
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 12 }}
            initialNumToRender={2}
            windowSize={3}
            viewabilityConfig={viewabilityConfig}
            onViewableItemsChanged={onViewableItemsChanged}
            ListHeaderComponent={
              <View className="gap-2 bg-sheet pb-2">
                <View className="flex-row items-center justify-between gap-2">
                  <AppText className="text-sm text-foreground-secondary">
                    {sessions.length} sessions
                  </AppText>
                  <Button
                    label="Stop all"
                    tone="danger"
                    disabled={!canControl || busy || sessions.length === 0}
                    onPress={() => void send({ control: "stopAll" })}
                  />
                </View>
                {query.error || error ? (
                  <AppText accessibilityRole="alert" className="text-sm text-danger">
                    {error ?? query.error}
                  </AppText>
                ) : null}
                {query.error ? <Button label="Retry" onPress={query.refresh} /> : null}
              </View>
            }
            stickyHeaderIndices={[0]}
            ListEmptyComponent={
              <AppText className="text-foreground-muted">No agents on screen</AppText>
            }
            renderItem={({ item }) => (
              <PreviewSessionTile
                session={item}
                live={
                  open && foreground && focused && query.error === null && visibleIds.has(item.id)
                }
                canControl={canControl && query.error === null}
                busy={busy}
                onControl={act}
                onOpen={(session) => {
                  close();
                  pendingBrowser.current = session;
                }}
              />
            )}
          />
        </Sheet>
      ) : null}
    </>
  );
}

function PreviewSessionTile(props: {
  readonly session: PreviewSession;
  readonly live: boolean;
  readonly canControl: boolean;
  readonly busy: boolean;
  readonly onOpen: (session: PreviewSession) => void;
  readonly onControl: (session: PreviewSession, control: PreviewSessionControl) => void;
}) {
  const { session } = props;
  const thread = useThreadShell(
    session.threadId === undefined
      ? null
      : { environmentId: session.environmentId, threadId: session.threadId },
  );
  const canOpen = session.target.kind === "browser" && session.threadId !== undefined;
  const act = (control: "takeover" | "handBack") => {
    if (previewSessionControlUsesBrowser(session, control)) props.onOpen(session);
    else props.onControl(session, control);
  };
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-3">
      <View className="gap-1">
        <AppText numberOfLines={2} className="font-goat-bold text-foreground">
          {session.target.title || previewSessionDetail(session)}
        </AppText>
        <AppText numberOfLines={1} className="text-xs text-foreground-secondary">
          {previewSessionDetail(session)}
          {thread ? ` · ${thread.title}` : ""}
        </AppText>
        <AppText className="text-xs text-primary-text">{previewSessionChip(session)}</AppText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open the full browser preview"
        disabled={!canOpen || props.busy}
        onPress={() => props.onOpen(session)}
        className="overflow-hidden rounded-xl bg-sheet-solid"
        style={{ aspectRatio: 16 / 10 }}
      >
        <View pointerEvents="none" className="flex-1">
          <SessionThumbnail session={session} live={props.live} />
        </View>
      </Pressable>
      <View className="flex-row flex-wrap gap-2">
        {session.capabilities.controls.flatMap((control) =>
          control === "takeover" || control === "handBack" ? (
            <Button
              key={control}
              label={control === "takeover" ? "Take over" : "Hand back"}
              disabled={
                !props.canControl ||
                props.busy ||
                (session.kind === "browser" &&
                  !canOpen &&
                  !(control === "handBack" && session.status === "stopped"))
              }
              onPress={() => act(control)}
            />
          ) : (
            []
          ),
        )}
        {session.capabilities.controls.includes("stop") ? (
          <Button
            label="Stop"
            tone="danger"
            disabled={!props.canControl || props.busy}
            onPress={() => props.onControl(session, "stop")}
          />
        ) : null}
      </View>
    </View>
  );
}

function SessionThumbnail({
  session,
  live,
}: {
  readonly session: PreviewSession;
  readonly live: boolean;
}) {
  const { themeVariables } = useAppearancePreferences();
  if (session.owner === "private") return <Placeholder text="Private (paused)" />;
  // A person who took over works in their own view; other viewers' cards do not watch them.
  if (session.owner === "human") return <Placeholder text="A person is in control" />;
  // A turn the desktop gave no driver: say what a person must do, as web does (#1399, #1516).
  if (session.status === "permission-needed")
    return (
      <Placeholder
        text={`No computer use yet. ${session.target.kind === "desktop" ? session.target.title : "Allow it"}${session.reason === "permissionsNotGranted" || session.reason === undefined ? " (System Settings > Privacy & Security)" : ""}.`}
      />
    );
  if (session.target.kind === "desktop")
    return (
      <DesktopThumbnail session={session} live={live} stopped={session.status === "stopped"} />
    );
  if (
    session.target.kind === "browser" &&
    session.capabilities.frames &&
    session.threadId !== undefined
  ) {
    if (!live) return <Placeholder text="Preview paused" />;
    return (
      <PreviewStreamWebView
        environmentId={session.environmentId}
        threadId={session.threadId}
        tabId={session.target.tabId}
        interactive={false}
        paused={!live}
        thumbnail
        compact
        background={themeVariables["--color-sheet-solid"]}
      />
    );
  }
  return (
    <Placeholder text={session.status === "stopped" ? "Stopped" : "No live picture available"} />
  );
}

/** Why a desktop window shows no picture, said only when a person can do something about it. */
const NO_PICTURE: Partial<Record<PreviewSessionNoPicture, string>> = {
  screenRecordingNotGranted: "Allow Screen Recording for GOAT Computer Use",
  appNotApproved: "This app is not approved for the agent",
  windowGone: "The window is closed",
};

/**
 * The agent's window through the shared frames subscription web uses (#1576). Frames stream only
 * while the card shows; a stopped session keeps its last frame, dimmed, and a private one keeps
 * nothing.
 */
function DesktopThumbnail(props: {
  readonly session: PreviewSession;
  readonly live: boolean;
  readonly stopped: boolean;
}) {
  const { session } = props;
  const watching = props.live && !props.stopped && session.capabilities.frames;
  const { event } = useDesktopSessionFrame(session.environmentId, watching ? session.id : null);
  const [last, setLast] = useState<string | null>(null);
  const frame = event?.type === "frame" ? `data:${event.mime};base64,${event.data}` : null;
  const reason = event?.type === "unavailable" ? event.reason : undefined;
  // Kept for a stopped session; adjusted while rendering, as the last event decides it.
  const kept = frame ?? (reason === "private" ? null : last);
  if (kept !== last) setLast(kept);
  const shown = frame ?? (props.stopped ? last : null);
  if (shown !== null)
    return (
      <Image
        source={{ uri: shown }}
        resizeMode="contain"
        // Android fades every new source in for 300ms by default; at 2fps that is constant repaint.
        fadeDuration={0}
        style={[{ flex: 1 }, props.stopped && { opacity: 0.5 }]}
      />
    );
  if (reason === "private") return <Placeholder text="Private" />;
  if (props.stopped) return <Placeholder text="Stopped" />;
  if (!session.capabilities.frames)
    return (
      <Placeholder text="No live picture: this computer's helper does not send window frames yet" />
    );
  if (!props.live) return <Placeholder text="Preview paused" />;
  return <Placeholder text={(reason && NO_PICTURE[reason]) ?? "No preview"} />;
}

function Placeholder({ text }: { readonly text: string }) {
  return (
    <View className="flex-1 items-center justify-center px-3">
      <AppText className="text-center text-xs text-foreground-muted">{text}</AppText>
    </View>
  );
}
