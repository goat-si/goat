import { ClientCapabilities } from "@goat/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  sshPreparationFailure,
} from "@goat/client-runtime/connection";
import type {
  DesktopBridge,
  DesktopPenMembersState,
  DesktopSshEnvironmentTarget,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** The bearer desktop main issues for this computer on a Pen member; the token is its only output. */
export const issuePenBearer = Effect.fn("web.connectionPlatform.pen.issueBearer")(function* (
  bridge: DesktopBridge,
  target: DesktopSshEnvironmentTarget,
  penNodeId: string,
) {
  const issue = bridge.issuePenMemberSession;
  if (issue === undefined)
    return yield* new ConnectionBlockedError({
      reason: "unsupported",
      detail: "This desktop build cannot sign in to Pen machines.",
    });
  const session = yield* Effect.tryPromise({
    try: () => issue(target, penNodeId),
    catch: penPreparationFailure,
  });
  return session.accessToken;
});

export function penPreparationFailure(cause: unknown) {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const message = raw
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^(?:(?:Ssh[A-Za-z]*Error|Error):\s*)+/u, "")
    .trim();
  if (/^.+ has no GOAT this app can attach to without installing one\.$/u.test(message))
    return new ConnectionBlockedError({
      reason: "configuration",
      existingRuntimeRequired: true,
      detail: message,
    });
  if (/^GOAT on .+ cannot issue Pen member sessions\.$/u.test(message))
    return new ConnectionBlockedError({
      reason: "unsupported",
      serverUpdateRequired: true,
      detail: message,
    });
  return sshPreparationFailure(cause);
}

export function penMembersGateway(
  bridge: DesktopBridge | undefined,
): (typeof ClientCapabilities.PenMembersGateway)["Service"] {
  if (bridge?.getPenMembers === undefined)
    return { desktop: Stream.never, enabled: Stream.succeed(false) };
  const desktop = Stream.callback<DesktopPenMembersState>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let active = true;
        let seq = -1;
        const emit = (state: DesktopPenMembersState) => {
          if (active && state.seq > seq) {
            seq = state.seq;
            Queue.offerUnsafe(queue, state);
          }
        };
        const unsubscribe = bridge.onPenMembersChanged?.(emit);
        void bridge
          .getPenMembers?.()
          .then(emit, () => emit({ kind: "unavailable", seq: 0, reason: "stale" }));
        return () => {
          active = false;
          unsubscribe?.();
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );
  const enabled = Stream.unwrap(
    Effect.promise(() => import("../hooks/useSettings")).pipe(Effect.map(penEnabledStream)),
  );
  return { desktop, enabled };
}

type SettingsSource = {
  readonly getClientSettingsHydratedSnapshot: () => boolean;
  readonly getClientSettingsSnapshot: () => { readonly showPenMachines: boolean };
  readonly subscribeClientSettings: (listener: () => void) => () => void;
  readonly subscribeClientSettingsHydration: (listener: () => void) => () => void;
};
export function penEnabledStream(source: SettingsSource): Stream.Stream<boolean> {
  return Stream.callback<boolean>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let previous: boolean | undefined;
        const emit = () => {
          if (!source.getClientSettingsHydratedSnapshot()) return;
          const value = source.getClientSettingsSnapshot().showPenMachines;
          if (value !== previous) {
            previous = value;
            Queue.offerUnsafe(queue, value);
          }
        };
        const a = source.subscribeClientSettings(emit);
        const b = source.subscribeClientSettingsHydration(emit);
        emit();
        return () => {
          a();
          b();
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );
}

export function sshRuntimePendingError(pending: {
  readonly reason: "busy" | "unknown" | "contended";
  readonly detail?: "recovery-stale";
  readonly refreshCause?: "drain_unavailable";
  readonly replacement: "older" | "legacy" | "incompatible" | "capability";
  readonly liveVersion: string;
  readonly requestedVersion: string;
}) {
  const waiting =
    pending.replacement === "capability"
      ? `Remote runtime GOAT ${pending.liveVersion} cannot grant memory access to tasks, so it will be replaced with GOAT ${pending.requestedVersion} when its work finishes.`
      : "Remote runtime will be replaced when its work finishes.";
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail:
      pending.detail === "recovery-stale"
        ? "Remote recovery is locked. Remove ~/.goat/ssh-launch/replacement.recovery on the remote host after checking that no GOAT client is replacing this runtime."
        : pending.refreshCause === "drain_unavailable"
          ? `Remote runtime GOAT ${pending.liveVersion} can't hand over to GOAT ${pending.requestedVersion} right now. GOAT retries every 10 minutes.`
          : pending.reason === "contended"
            ? "Another client is replacing the remote runtime."
            : pending.reason === "unknown"
              ? `${waiting} Waiting for a verified idle response.`
              : waiting,
  });
}
