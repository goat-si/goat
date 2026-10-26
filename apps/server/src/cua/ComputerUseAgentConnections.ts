/**
 * Whether agent computer use connections on this host work, as their lease proxies report it.
 *
 * Readiness checks start the helper from the desktop app, while agents reach it through the
 * lease proxy. When only the agent route fails (exit 77 from the helper's parent check, a
 * capture crash, a driver that will not start), readiness stays green and goat_describe kept
 * calling computer use available through a night of failures. Each proxy now reports when its
 * driver ends on its own, and when one answers the handshake. A run of endings with no working
 * connection between them is a host condition, not one thread's bad luck, so agents and Settings
 * are told the honest reason after FAILING_AFTER of them; one working connection clears it, as a
 * circuit breaker's closed state resets its failure count on success.
 *
 * @module ComputerUseAgentConnections
 */
import type { ComputerUseDriverEndReason, CuaHostStatus } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

/**
 * Endings in a row before computer use reads unavailable. One ending can be a person's Stop
 * racing a restart or an update swapping the helper; three with nothing working between them
 * is the host.
 */
export const FAILING_AFTER = 3;

export interface ConnectionFailure {
  readonly failing: number;
  readonly reason: ComputerUseDriverEndReason;
  readonly message: string;
}

const MESSAGES: Readonly<Record<ComputerUseDriverEndReason, string>> = {
  helper_refused:
    "GOAT Computer Use refused the agent connections on this host: it did not trust the process that launched it. Restarting the agent session will not fix it; GOAT needs an update.",
  helper_unsupported:
    "GOAT Computer Use cannot start for agent connections on this host. Restarting the agent session will not fix it; reinstall or update GOAT.",
  helper_restarted:
    "GOAT Computer Use keeps stopping before agent connections work on this host. Check Settings → Computer use, then try again.",
};

/** The host's record after one more report: an ending counts, a working connection clears it. */
export const nextFailure = (
  current: ConnectionFailure | undefined,
  report: { readonly reason: ComputerUseDriverEndReason } | false,
): ConnectionFailure | undefined =>
  report === false
    ? undefined
    : {
        failing: (current?.failing ?? 0) + 1,
        reason: report.reason,
        message: MESSAGES[report.reason],
      };

/** The failure agents and Settings are told about, once enough endings came in a row. */
export const reportedFailure = (current: ConnectionFailure | undefined) =>
  current !== undefined && current.failing >= FAILING_AFTER ? current : undefined;

export class ComputerUseAgentConnections extends Context.Service<
  ComputerUseAgentConnections,
  {
    /** Records a proxy's report: its driver ended on its own, or (false) it answered. */
    readonly report: (
      report: { readonly reason: ComputerUseDriverEndReason } | false,
    ) => Effect.Effect<void>;
    /** The run of endings agents and Settings should hear about; undefined while it works. */
    readonly failure: Effect.Effect<ConnectionFailure | undefined>;
    /** Wakes when the reported failure appears, changes reason or clears. */
    readonly changes: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("goat/cua/ComputerUseAgentConnections") {}

export const make = Effect.gen(function* () {
  const changes = yield* PubSub.sliding<void>(1);
  let current: ConnectionFailure | undefined;
  const key = (failure: ConnectionFailure | undefined) =>
    failure === undefined ? "" : failure.reason;
  return ComputerUseAgentConnections.of({
    report: (report) =>
      Effect.suspend(() => {
        const before = key(reportedFailure(current));
        current = nextFailure(current, report);
        return key(reportedFailure(current)) === before
          ? Effect.void
          : PubSub.publish(changes, undefined).pipe(Effect.asVoid);
      }),
    failure: Effect.sync(() => reportedFailure(current)),
    changes: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(ComputerUseAgentConnections, make);

/**
 * The host status clients read, with a failing agent route stated: tools unavailable, the reason
 * as the failure every client already shows as blocked, and the typed record beside it. A start
 * failure the driver reported keeps its own sentence first.
 */
export const withAgentConnections = (
  status: CuaHostStatus,
  failure: ConnectionFailure | undefined,
): CuaHostStatus =>
  failure === undefined || status.tools === "off"
    ? status
    : {
        ...status,
        tools: "unavailable",
        failure: status.failure === undefined ? failure.message : status.failure,
        agentConnections: failure,
      };
