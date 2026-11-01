/** How a lease proxy holds calls while its lease stream reconnects (ComputerUseLeaseStreamFollower). */
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import {
  type Interruption,
  RECONNECT_CUT_OFF,
  TRANSPORT_SAFE_TOOLS,
} from "./ComputerUseLeaseMessages.ts";

/** The proxy's own probes: app lookup, display proof and input read-back. */
const PROBES = ["apps:", "windows:", "verify:"];

/** True when this call may not go out: the stream is reconnecting and it is no safe read. */
export const heldByTransport = (
  held: (() => boolean) | undefined,
  method: string | undefined,
  tool: unknown,
) => held?.() === true && method === "tools/call" && !TRANSPORT_SAFE_TOOLS.has(String(tool));

/**
 * Cuts off the driver's work when a call it has acts on or reads the screen. The state is read
 * through getters, so the returned effect judges the moment it runs and can run again.
 */
export const dropTransport = Effect.fn("ComputerUseLeaseProxy.dropTransport")(function* <E>(input: {
  readonly running: () => boolean;
  readonly calls: () => Iterable<{ readonly method: string; readonly tool?: string | undefined }>;
  readonly interrupt: (cause: Interruption) => Effect.Effect<number>;
  readonly start: (token: number) => Effect.Effect<void, E>;
}) {
  if (!input.running()) return;
  const exposed = [...input.calls()].some(
    (call) => call.method === "tools/call" && !TRANSPORT_SAFE_TOOLS.has(call.tool ?? ""),
  );
  if (!exposed) return;
  const token = yield* input.interrupt({
    _tag: "other",
    detail: "reconnecting",
    message: RECONNECT_CUT_OFF,
  });
  yield* input.start(token);
});

/**
 * The drop hook: ends the waits of the proxy's own window, app and read-back probes as
 * unanswered, then runs `dropped`. A call waiting on a probe reaches the transport hold at once,
 * which also answers it before any probe result can shape a refusal; probes themselves go out
 * only through the same hold. A late driver answer then finds no waiter.
 */
export const settlingProbes =
  <A>(answers: Map<string, Deferred.Deferred<A | undefined>>, ownId: string, dropped: () => void) =>
  () => {
    for (const [id, answered] of answers)
      if (PROBES.some((kind) => id.startsWith(ownId + kind))) {
        answers.delete(id);
        Deferred.doneUnsafe(answered, Exit.succeed(undefined));
      }
    dropped();
  };

/** A driver line that may not go out while held: a call of a tool that is no transport-safe read. */
const heldLine = (line: string) => {
  try {
    const message = JSON.parse(line) as { method?: unknown; params?: { name?: unknown } };
    return (
      message.method === "tools/call" && !TRANSPORT_SAFE_TOOLS.has(String(message.params?.name))
    );
  } catch {
    return false;
  }
};

/**
 * The one door to the driver while the lease stream reconnects: a held call is not sent, judged by
 * its own tool, so a probe never borrows the exemption of the read it serves. A held probe's wait
 * ends unanswered at once (`refused`), the way a drop settles it.
 */
export const guardDriver = <
  D extends { readonly send: (line: string) => Effect.Effect<void> },
  E,
  R,
>(
  start: Effect.Effect<D, E, R>,
  held: (() => boolean) | undefined,
  refused: (line: string) => void,
): Effect.Effect<D, E, R> =>
  held === undefined
    ? start
    : Effect.map(start, (driver) => ({
        ...driver,
        send: (line: string) =>
          Effect.suspend(() => {
            if (!held() || !heldLine(line)) return driver.send(line);
            refused(line);
            return Effect.void;
          }),
      }));

/** Settles the wait of one of the proxy's own probes whose line the guard held back. */
export const settleProbe =
  <A>(answers: Map<string, Deferred.Deferred<A | undefined>>, ownId: string) =>
  (line: string) => {
    const id = (JSON.parse(line) as { id?: unknown }).id;
    if (typeof id !== "string" || !PROBES.some((kind) => id.startsWith(ownId + kind))) return;
    const answered = answers.get(id);
    answers.delete(id);
    if (answered !== undefined) Deferred.doneUnsafe(answered, Exit.succeed(undefined));
  };
