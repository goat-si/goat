/**
 * PreviewSessions - one list of what agents drive on this host, browser tabs and the desktop
 * alike (D6, #1135), and the controls a person uses on them. Browser sessions come from the
 * server browser's tabs; desktop sessions from computer use controls. Both carry the same
 * owner, status and control names, so every client renders one panel.
 *
 * Browser takeover and hand back of a person's own control stay on the tab's viewer stream,
 * which already serializes them with input; this service stops agents and hands back after it.
 *
 * @module PreviewSessions
 */
import {
  type AuthSessionId,
  WS_METHODS,
  type ComputerUseRefusalReason,
  type CuaAgentBlock,
  cuaAgentBlockLists,
  type PreviewSession,
  type PreviewSessionControl,
  type PreviewSessionControlInput,
  type PreviewSessionControlResult,
  type PreviewSessionFramesInput,
  type PreviewSessionPlatform,
  type PreviewSessionsSnapshot,
  ThreadId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import { makeComputerUseRpcHandlers, stopAllComputerUse } from "../cua/ComputerUseRpcHandlers.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as DesktopFrames from "./DesktopFrames.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import type { ServerBrowserSessionView } from "./ServerBrowserSessions.ts";

export class PreviewSessions extends Context.Service<
  PreviewSessions,
  {
    readonly snapshot: Effect.Effect<PreviewSessionsSnapshot>;
    /** The current list, then a new one after every change. */
    readonly changes: Stream.Stream<PreviewSessionsSnapshot>;
    readonly control: (
      input: PreviewSessionControlInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<PreviewSessionControlResult>;
    /** One viewer's live picture of a desktop session (#1370). */
    readonly frames: DesktopFrames.DesktopFrames["Service"]["frames"];
  }
>()("goat/preview/PreviewSessions") {}

const platformOf = (platform: string): PreviewSessionPlatform =>
  platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";

const browserId = (threadId: string, tabId: string) =>
  `browser:${encodeURIComponent(threadId)}:${encodeURIComponent(tabId)}`;
const DESKTOP_PREFIX = "desktop:";

const parseBrowserId = (id: string) => {
  const [kind, threadId, tabId, ...rest] = id.split(":");
  if (kind !== "browser" || threadId === undefined || tabId === undefined || rest.length > 0)
    return undefined;
  return { threadId: decodeURIComponent(threadId), tabId: decodeURIComponent(tabId) };
};

type Base = Pick<PreviewSession, "environmentId" | "host" | "platform">;

/**
 * A running turn the desktop gave no driver for want of a grant (#1399). It holds no control, so
 * there is nothing to stop or take over; the tile says which grant a person must allow.
 */
export const blockedSession = (
  base: Base,
  threadId: ThreadId,
  block: CuaAgentBlock,
): PreviewSession => ({
  id: `${DESKTOP_PREFIX}blocked:${threadId}`,
  kind: "desktop",
  ...base,
  threadId,
  target: {
    kind: "desktop",
    title: `Allow ${block.holder === "helper" ? "GOAT Computer Use" : "GOAT"} in ${cuaAgentBlockLists(block)}`,
  },
  owner: "agent",
  status: "permission-needed",
  reason: "permissionsNotGranted",
  capabilities: { controls: [], frames: false, privateMode: false, humanInput: false },
});

/** An agent's browser tab as a session; a person's own tab is not one. */
export const browserSession = (
  base: Base,
  tab: ServerBrowserSessionView,
): PreviewSession | undefined => {
  if (tab.agentId === null) return undefined;
  const status =
    tab.private || tab.humanControls ? "paused" : tab.agentStopped ? "stopped" : "acting";
  const controls: ReadonlyArray<PreviewSessionControl> = tab.agentStopped
    ? ["handBack", "stopAll"]
    : tab.humanControls
      ? ["handBack", "stop", "stopAll"]
      : ["takeover", "stop", "stopAll"];
  return {
    id: browserId(tab.threadId, tab.tabId),
    kind: "browser",
    ...base,
    threadId: tab.threadId,
    target: { kind: "browser", tabId: tab.tabId, url: tab.url, title: tab.title },
    owner: tab.private ? "private" : tab.humanControls ? "human" : "agent",
    status,
    ...(tab.agentStopped ? { reason: "userStoppedSession" as const } : {}),
    capabilities: { controls, frames: true, privateMode: true, humanInput: true },
  };
};

/**
 * A thread's computer use control as a session, while one of its turns is live or a person
 * stopped it. Between turns no agent acts on the screen, so it is left out (#1360).
 */
export const desktopSession = (
  base: Base,
  control: ComputerUseLeases.ComputerUseControl,
  state: ComputerUseLeases.ComputerUseControlState,
  detection: ComputerUseLeases.ComputerUseDetection,
): PreviewSession | undefined => {
  if (state._tag === "ended" && state.reason !== "stopped" && state.reason !== "stopped_all")
    return undefined;
  if (state._tag !== "ended" && control.idle === true) return undefined;
  const reason: ComputerUseRefusalReason | undefined =
    state._tag === "ended"
      ? "userStoppedSession"
      : state._tag === "paused"
        ? "userIntervened"
        : undefined;
  // A paused or stopped control keeps the apps it last held; unknown when it never ran.
  const scope = state._tag === "active" ? { apps: state.apps } : control.scope;
  const apps = scope?.apps;
  return {
    id: `${DESKTOP_PREFIX}${control.controlId}`,
    kind: "desktop",
    ...base,
    threadId: control.threadId,
    target: {
      kind: "desktop",
      ...(control.target === undefined
        ? {}
        : { pid: control.target.pid, windowId: control.target.windowId }),
      title:
        scope === undefined
          ? "Computer use"
          : apps === undefined
            ? "Whole screen"
            : apps.length === 0
              ? "No apps approved"
              : apps.join(", "),
    },
    owner:
      state._tag !== "paused"
        ? "agent"
        : state.reason === "private"
          ? "private"
          : state.reason === "takeover"
            ? "human"
            : "agent",
    status:
      state._tag === "ended"
        ? "stopped"
        : state._tag === "paused"
          ? state.reason === "human_input"
            ? "waiting-for-human"
            : "paused"
          : "acting",
    ...(reason === undefined ? {} : { reason }),
    lease: {
      threadId: control.threadId,
      expiresAt: DateTime.formatIso(control.expiresAt),
      ...(apps === undefined ? {} : { scope: apps }),
    },
    capabilities: {
      controls:
        state._tag === "ended"
          ? ["stopAll"]
          : state._tag === "paused"
            ? ["handBack", "stop", "stopAll"]
            : ["takeover", "stop", "stopAll"],
      frames: detection.frames,
      privateMode: detection.privateMode,
      humanInput: detection.humanInput,
    },
  };
};

const make = Effect.gen(function* () {
  const browser = yield* Effect.serviceOption(ServerBrowser.ServerBrowser);
  const leases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);
  const desktopFrames = yield* DesktopFrames.DesktopFrames;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const handoffs = yield* Handoffs.Handoffs;
  const host = yield* HostProcess.Hostname;
  const platform = platformOf(yield* HostProcess.Platform);

  const snapshot = Effect.gen(function* () {
    const base: Base = { environmentId: yield* environment.getEnvironmentId, host, platform };
    const sessions: Array<PreviewSession> = [];
    if (Option.isSome(browser))
      for (const tab of yield* browser.value.sessions) {
        const session = browserSession(base, tab);
        if (session) sessions.push(session);
      }
    if (Option.isSome(leases)) {
      const detection = yield* leases.value.detection;
      for (const { control, state } of yield* leases.value.sessions) {
        const session = desktopSession(base, control, state, detection);
        if (session) sessions.push(session);
      }
      for (const { threadId, block } of yield* leases.value.blockedTurns)
        sessions.push(blockedSession(base, threadId, block));
    }
    return { sessions };
  }).pipe(Effect.withSpan("PreviewSessions.snapshot"));

  const changes = Stream.unwrap(
    Effect.gen(function* () {
      const wake = yield* PubSub.sliding<void>(1);
      if (Option.isSome(browser))
        yield* browser.value.sessionChanges.pipe(
          Stream.runForEach(() => PubSub.publish(wake, undefined)),
          Effect.forkScoped,
        );
      if (Option.isSome(leases)) {
        const subscription = yield* leases.value.subscribe;
        yield* PubSub.take(subscription).pipe(
          Effect.andThen(PubSub.publish(wake, undefined)),
          Effect.forever,
          Effect.forkScoped,
        );
      }
      return Stream.concat(Stream.make(undefined), Stream.fromPubSub(wake)).pipe(
        Stream.mapEffect(() => snapshot),
      );
    }),
  );

  const control = Effect.fn("PreviewSessions.control")(function* (
    input: PreviewSessionControlInput,
    sessionId: AuthSessionId,
  ) {
    if (input.control === "stopAll") {
      // Control first, and nothing a stuck page could hold up: no titles or URLs are read.
      if (Option.isSome(browser)) yield* browser.value.stopAllAgents;
      yield* stopAllComputerUse(leases, handoffs, sessionId);
      return { applied: true };
    }
    if (input.control === "requestHandoff")
      return { applied: false, reason: "not_allowed" } as const;
    const id = input.sessionId ?? "";
    const tab = parseBrowserId(id);
    if (tab !== undefined) {
      if (Option.isNone(browser)) return { applied: false, reason: "not_found" } as const;
      if (input.control === "takeover") return { applied: false, reason: "unsupported" } as const;
      const applied = yield* browser.value.controlSession({
        ...tab,
        control: input.control === "stop" ? "stop" : "handBack",
      });
      return applied ? { applied } : ({ applied, reason: "not_found" } as const);
    }
    if (!id.startsWith(DESKTOP_PREFIX) || Option.isNone(leases))
      return { applied: false, reason: "not_found" } as const;
    const controlId = id.slice(DESKTOP_PREFIX.length);
    const live = (yield* leases.value.sessions).find(
      ({ control }) => control.controlId === controlId,
    );
    if (live === undefined) return { applied: false, reason: "not_found" } as const;
    // The pause is the host's: a person on the desktop holds every agent there.
    if (input.control === "takeover") yield* leases.value.pause("takeover");
    else if (input.control === "handBack") yield* leases.value.resume;
    else yield* leases.value.stop(ThreadId.make(live.control.threadId));
    return { applied: true };
  });

  return PreviewSessions.of({ snapshot, changes, control, frames: desktopFrames.frames });
});

export const layer = Layer.effect(PreviewSessions, make).pipe(Layer.provide(DesktopFrames.layer));

/** The preview session RPCs, with the computer use controls they build on. */
export const makePreviewSessionRpcHandlers = Effect.fn("PreviewSessions.rpcHandlers")(function* (
  sessionId: AuthSessionId,
) {
  const sessions = yield* PreviewSessions;
  return {
    ...(yield* makeComputerUseRpcHandlers(sessionId)),
    [WS_METHODS.previewSessionsSubscribe]: (_input: {}) => sessions.changes,
    [WS_METHODS.previewSessionsControl]: (input: PreviewSessionControlInput) =>
      sessions.control(input, sessionId),
    [WS_METHODS.previewSessionsFrames]: (input: PreviewSessionFramesInput) =>
      sessions.frames(input),
  } as const;
});
