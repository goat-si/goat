import type { ComputerUseControlEnd, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import type * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { appsOf } from "./computerUseGrants.ts";
import { type ComputerUseControl, rememberScope } from "./ComputerUseControl.ts";
import type { ComputerUseLease, ComputerUseLeaseError } from "./ComputerUseLeases.ts";
import type * as CuaDriver from "./CuaDriver.ts";
import type * as LinuxHelperHost from "./linuxHelperHost/LinuxHelperHost.ts";

const WATCH_RETRY_MS = 1_000;

interface WatchedControl extends ComputerUseControl {
  readonly ended?: ComputerUseControlEnd;
  readonly everyApp?: unknown;
  readonly named?: ReadonlyArray<string>;
}

/**
 * The helper watches for secret fields and a person's input only while an agent controls this
 * host (D7): from the first live control until the last one ends or expires. The desktop's
 * helper hears it over the control pipe; the server's own Linux helper directly.
 */
export const startHelperWatch = Effect.fn("ComputerUseLeases.startHelperWatch")(function* <
  C extends WatchedControl,
>(input: {
  readonly controls: Map<ThreadId, C>;
  readonly acting: (record: C) => boolean;
  readonly grantState: (
    threadId: ThreadId,
    handoffId: string,
  ) => Effect.Effect<
    { readonly _tag: string; readonly reason?: ComputerUseControlEnd },
    ComputerUseLeaseError
  >;
  readonly end: (threadId: ThreadId, reason: ComputerUseControlEnd) => boolean;
  readonly signals: PubSub.PubSub<void>;
  readonly watchKick: PubSub.PubSub<void>;
  readonly live: Effect.Effect<ReadonlyArray<ComputerUseLease>, ComputerUseLeaseError>;
  readonly receiver:
    | Pick<DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"], "setCuaWatch">
    | undefined;
  readonly linuxHelper: Option.Option<Pick<LinuxHelperHost.LinuxHelperHost["Service"], "setWatch">>;
  readonly driver: Option.Option<CuaDriver.CuaDriver["Service"]>;
}) {
  const { controls, receiver, linuxHelper, driver } = input;
  const kicks = yield* PubSub.subscribe(input.watchKick);
  yield* Effect.gen(function* () {
    // What the desktop last heard; it starts out not watching. After a failed write it may
    // have heard either value, so the current one goes out until a write succeeds.
    let delivered = false;
    let deliveredApps: ReadonlyArray<string> = [];
    let unsure = false;
    for (;;) {
      // A grant cancelled or expired under a control ends it, though nothing here ended it.
      let endedAny = false;
      for (const record of Array.from(controls.values())) {
        if (record.ended !== undefined || record.handoffId === undefined) continue;
        const grant = yield* input
          .grantState(record.threadId, record.handoffId)
          .pipe(Effect.option);
        // The lookup yields: a newer control for the thread is not judged by this grant.
        if (
          Option.isSome(grant) &&
          grant.value._tag === "ended" &&
          grant.value.reason !== undefined &&
          controls.get(record.threadId)?.controlId === record.controlId
        )
          endedAny = input.end(record.threadId, grant.value.reason) || endedAny;
      }
      // Proxies waiting on a pause hear their control ended.
      if (endedAny) yield* PubSub.publish(input.signals, undefined);
      // Read approvals independently of pause state: a paused helper must keep watching. A
      // failed read never holds back whether the desktop watches for secret fields: the
      // apps it last heard stand, and the read is tried again.
      const listed = yield* input.live.pipe(Effect.option);
      const grants = Option.getOrElse(listed, (): ReadonlyArray<ComputerUseLease> => []);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const current = [...controls.values()].filter(
        (record) => input.acting(record) && DateTime.toEpochMillis(record.expiresAt) > now,
      );
      const expiries = current.map((record) => DateTime.toEpochMillis(record.expiresAt));
      const approved = new Set<string>();
      for (const record of current) {
        if (record.everyApp !== undefined) {
          for (const app of record.named ?? []) approved.add(app);
          continue;
        }
        const held = grants.filter(
          (grant) =>
            grant.threadId === record.threadId &&
            (record.handoffId === undefined || grant.handoffId === record.handoffId),
        );
        for (const grant of held) expiries.push(DateTime.toEpochMillis(grant.expiresAt));
        for (const app of rememberScope(controls, record, appsOf(held)) ?? []) approved.add(app);
      }
      const apps = Option.isSome(listed) ? [...approved].sort() : deliveredApps;
      const appsChanged =
        apps.length !== deliveredApps.length ||
        apps.some((app, index) => app !== deliveredApps[index]);
      // Only a driver this server runs itself offers a refresh; a desktop host refreshes its own.
      const refresh = Option.isSome(driver) ? driver.value.refreshManifest : undefined;
      if (appsChanged && refresh)
        yield* refresh(apps).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
      const active = current.length > 0;
      let retry = false;
      // The server's own helper takes the wanted state as is, so it cannot fall behind.
      if (Option.isSome(linuxHelper)) yield* linuxHelper.value.setWatch(active);
      if (active !== delivered || appsChanged || unsure) {
        const sent =
          receiver === undefined
            ? true
            : yield* receiver.setCuaWatch(active, apps).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
        if (sent) {
          delivered = active;
          deliveredApps = apps;
          unsure = false;
        } else {
          unsure = true;
          retry = true;
        }
      }
      const waits = [
        ...(active ? [Math.min(...expiries) - now] : []),
        // A failed write is tried again: the desktop may not reconnect to hear it otherwise.
        // So is a failed approval read.
        ...(retry || Option.isNone(listed) ? [WATCH_RETRY_MS] : []),
      ];
      const woken = PubSub.take(kicks);
      yield* waits.length > 0 ? Effect.race(woken, Effect.sleep(Math.min(...waits))) : woken;
    }
  }).pipe(Effect.forkScoped);
});
