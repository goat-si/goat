import type {
  AutomationHold as AutomationHoldState,
  EditorId,
  FileManagerRevealKind,
  ServerConfig as ClientServerConfig,
  ServerConfigStreamEvent,
  ServerWorktreeCheckoutHealth,
} from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as ExternalLauncher from "./process/externalLauncher.ts";

/** Config the server learns after a client's first snapshot, folded back into later snapshots. */
const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);

const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

export const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

type EditorDiscovery = Pick<
  ExternalLauncher.ExternalLauncher["Service"],
  "resolveAvailableEditors" | "resolveFileManagerRevealKind"
>;

export const resolveEditorConfig = Effect.fn("ws.resolveEditorConfig")(function* <E, R>(
  availableEditors: ReadonlyArray<EditorId>,
  revealKind: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) {
  const fileManagerRevealKind = availableEditors.includes("file-manager")
    ? yield* revealKind
    : undefined;
  return {
    availableEditors,
    ...(fileManagerRevealKind === undefined
      ? {}
      : {
          shellRevealInFileManager: true,
          shellRevealInFileManagerKind: fileManagerRevealKind,
        }),
  };
});

export const withLateEditorConfig = <E, R>(
  config: ClientServerConfig,
  liveUpdates: Stream.Stream<ServerConfigStreamEvent, E, R>,
  launcher: EditorDiscovery,
  /** Defender probe results that land after the snapshot; Windows servers only. */
  checkoutHealthChanges: Stream.Stream<ServerWorktreeCheckoutHealth> = Stream.empty,
  /** The automation hold's current state first, then each change; see AutomationHold. */
  automationHoldChanges: Stream.Stream<AutomationHoldState | null> = Stream.empty,
) => {
  const lateEditorConfig = Stream.fromEffect(launcher.resolveAvailableEditors()).pipe(
    Stream.filter(
      (editors) =>
        editors.join() !== config.availableEditors.join() ||
        (editors.includes("file-manager") && config.shellRevealInFileManagerKind === undefined),
    ),
    // Unbounded, unlike the snapshot: the reveal-kind probe is not shared, so
    // a timeout here would cancel a probe that outlasts it every time.
    Stream.mapEffect((editors) =>
      resolveEditorConfig(editors, launcher.resolveFileManagerRevealKind()),
    ),
    Stream.filter(
      (editorConfig) =>
        editorConfig.availableEditors.join() !== config.availableEditors.join() ||
        editorConfig.shellRevealInFileManagerKind !== config.shellRevealInFileManagerKind,
    ),
    Stream.map((editorConfig) => ({ type: "editorsResolved" as const, editorConfig })),
  );
  const lateCheckoutHealth = checkoutHealthChanges.pipe(
    Stream.map((health) => ({ type: "checkoutHealthResolved" as const, health })),
  );
  const lateAutomationHold = automationHoldChanges.pipe(
    Stream.map((hold) => ({ type: "automationHoldResolved" as const, hold })),
  );

  return Stream.merge(
    liveUpdates,
    Stream.merge(lateEditorConfig, Stream.merge(lateCheckoutHealth, lateAutomationHold)),
  ).pipe(
    Stream.mapAccum(
      (): ClientServerConfig => config,
      (current, event): readonly [ClientServerConfig, ReadonlyArray<ServerConfigStreamEvent>] => {
        switch (event.type) {
          case "automationHoldResolved": {
            // A snapshot, so clients built before the field still apply it without a new event.
            if ((current.automationHold ?? null) === event.hold) return [current, []];
            const next = { ...current, automationHold: event.hold };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "checkoutHealthResolved": {
            // Every client applies a snapshot, so this reaches ones built before the field.
            const same =
              current.worktreeCheckoutHealth?.defender === event.health.defender &&
              current.worktreeCheckoutHealth?.worktreesDirectory ===
                event.health.worktreesDirectory;
            if (same) return [current, []];
            const next = { ...current, worktreeCheckoutHealth: event.health };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "editorsResolved": {
            const {
              availableEditors: _editors,
              shellRevealInFileManager: _reveal,
              shellRevealInFileManagerKind: _revealKind,
              ...rest
            } = current;
            const next = { ...rest, ...event.editorConfig };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "keybindingsUpdated":
            return [{ ...current, ...event.payload }, [event]];
          case "providerStatuses":
            return [{ ...current, providers: event.payload.providers }, [event]];
          case "settingsUpdated":
            return [{ ...current, settings: event.payload.settings }, [event]];
          // Themes and usage-limit sources never ride in a snapshot; clients
          // carry their projected values across one.
          default:
            return [current, [event]];
        }
      },
    ),
  );
};
