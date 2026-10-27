// @effect-diagnostics preferSchemaOverJson:off -- JSON-RPC driver line keeps opaque fields.
import type { ComputerUseForegroundGrant } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Scheduler from "effect/Scheduler";

import { requiresForeground } from "./ComputerUseCallReservations.ts";
import { sendsAppleEvents } from "./ComputerUseAutomationRefusal.ts";
import { TOKEN_FIRST_MESSAGE } from "./ComputerUseTokenFirst.ts";
import { takesScreen, scopeVerdict, type ListedApp } from "./ComputerUseScope.ts";
import { type Envelope, replyPlacement } from "./ComputerUseLeaseProtocol.ts";
import type { Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import type { WindowPlacement, NamedWindow } from "./x11WindowPlacement.ts";
import {
  DESKTOP_CAPTURE_OFF,
  FOREGROUND_NOT_APPROVED,
  LEASE_END_MESSAGES,
  PAUSE_MESSAGES,
  scopeMessage,
  SCREEN_SHARED,
  type LeaseEnd,
} from "./ComputerUseLeaseMessages.ts";
import { pausedDetail, refusal, type JsonRpcId } from "./ComputerUseLeaseResponses.ts";

/** Proves the currently selected child is on the expected display before a desktop effect. */
export const proveProxyDisplay = Effect.fn("ComputerUseLeaseProxy.proveDisplay")(function* (input: {
  readonly current: () => Running | undefined;
  readonly proven: () => Running | undefined;
  readonly setProven: (current: Running) => void;
  readonly nextId: () => string;
  readonly ownAnswers: Map<string, Deferred.Deferred<Envelope | undefined>>;
  readonly ended: Deferred.Deferred<LeaseEnd>;
  readonly finished: () => LeaseEnd | undefined;
  readonly placement?: (windows: ReadonlyArray<NamedWindow>) => Effect.Effect<WindowPlacement>;
  readonly end: (reason: LeaseEnd) => Effect.Effect<void>;
  readonly canSend?: Effect.Effect<boolean>;
}) {
  const current = input.current();
  if (current === undefined || input.proven() === current) return;
  const id = input.nextId();
  const answered = yield* Deferred.make<Envelope | undefined>();
  input.ownAnswers.set(id, answered);
  const sent = yield* Effect.gen(function* () {
    if (input.canSend && !(yield* input.canSend)) return false;
    yield* current.driver.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_windows", arguments: {} },
      }),
    );
    return true;
  }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));
  if (!sent) {
    input.ownAnswers.delete(id);
    return;
  }
  const answer = yield* Effect.raceFirst(
    Deferred.await(answered),
    Deferred.await(input.ended).pipe(Effect.as(undefined)),
  );
  if (answer === undefined || input.finished() !== undefined || input.current() !== current) return;
  const verdict = yield* replyPlacement(input.placement, answer, "list_windows", true);
  if (input.finished() !== undefined || input.current() !== current) return;
  if (verdict === "other") return yield* input.end("wrong_display");
  if (verdict === "proof") input.setProven(current);
});

/** Shared admission decision for provider and reverse-channel calls. */
export const refuseProxyCall = Effect.fn("ComputerUseLeaseProxy.refuseCall")(function* (input: {
  readonly id: JsonRpcId;
  readonly message: Envelope;
  readonly finished: () => LeaseEnd | undefined;
  readonly paused: () => "human_input" | "takeover" | "private" | undefined;
  readonly idle: () => boolean;
  readonly apps: () => ReadonlySet<string> | undefined;
  readonly listed: ReadonlyMap<number, ListedApp>;
  readonly bundleIds: boolean;
  readonly shared: () => boolean;
  /** Refuses arguments that would write a capture to a file. */
  readonly toFile: () => string | undefined;
  readonly tokenFirstRefuses: () => boolean;
  readonly foreground: () => ReadonlyArray<ComputerUseForegroundGrant>;
  readonly listApps: Effect.Effect<void>;
  /** macOS: an Apple Events route's refusal names its app, so its pid is listed before it runs. */
  readonly automationTargets?: boolean;
}) {
  const judge = () =>
    scopeVerdict({
      name: input.message.params?.name,
      args: input.message.params?.arguments,
      apps: input.apps(),
      appOf: (pid) => input.listed.get(pid),
      bundleIds: input.bundleIds,
    });
  let verdict = judge();
  if (
    verdict._tag === "resolve" &&
    input.finished() === undefined &&
    input.paused() === undefined
  ) {
    yield* input.listApps;
    verdict = judge();
  }
  if (
    input.automationTargets === true &&
    sendsAppleEvents(input.message.params?.name, input.message.params?.arguments, input.listed) &&
    input.finished() === undefined &&
    input.paused() === undefined
  )
    yield* input.listApps;
  const finished = input.finished();
  const paused = input.paused();
  if (finished !== undefined)
    return refusal(input.id, input.message.method, finished, LEASE_END_MESSAGES[finished]);
  if (paused !== undefined)
    return refusal(input.id, input.message.method, pausedDetail(paused), PAUSE_MESSAGES[paused]);
  if (input.idle())
    return refusal(
      input.id,
      input.message.method,
      "control_idle",
      "This thread's turn has ended. Computer use is idle until its next turn.",
    );
  if (input.message.params?.name === "get_desktop_state")
    return refusal(input.id, input.message.method, "desktop_capture_off", DESKTOP_CAPTURE_OFF);
  const toFile = input.toFile();
  if (toFile !== undefined)
    return refusal(input.id, input.message.method, "desktop_capture_off", toFile);
  if (verdict._tag === "resolve")
    return refusal(
      input.id,
      input.message.method,
      "app_not_approved",
      scopeMessage(
        "app_not_approved",
        input.listed.get(verdict.pid)?.id ?? `the app with pid ${verdict.pid}`,
      ),
    );
  if (verdict._tag === "refuse")
    return refusal(
      input.id,
      input.message.method,
      verdict.reason,
      scopeMessage(verdict.reason, verdict.app, verdict.opaque, verdict.launch),
      verdict.app,
    );
  if (input.shared() && takesScreen(input.message.params?.name, input.message.params?.arguments))
    return refusal(input.id, input.message.method, "screen_shared", SCREEN_SHARED);
  if (input.tokenFirstRefuses())
    return refusal(input.id, input.message.method, "token_first", TOKEN_FIRST_MESSAGE);
  const now = yield* Clock.currentTimeMillis;
  if (
    requiresForeground({
      name: typeof input.message.params?.name === "string" ? input.message.params.name : "unknown",
      args: input.message.params?.arguments,
    }) &&
    !input.foreground().some((grant) => grant.expiresAtMillis > now)
  )
    return refusal(
      input.id,
      input.message.method,
      "foreground_not_approved",
      FOREGROUND_NOT_APPROVED,
    );
  return undefined;
});
