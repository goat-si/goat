/**
 * The stdio MCP server every thread's provider runs instead of the raw `cua-driver mcp`. It
 * forwards to the driver while the thread's control is live and acts on its own when it ends or
 * pauses, whether or not the agent makes another call:
 *
 * - every tools/call waits for the server to confirm the control, then checks the deadline and
 *   the apps the control allows;
 * - the deadline is a timer here, and the server pushes Stop, the kill switch and revocation
 *   over a streamed response;
 * - on an end or a lost connection it refuses new calls, sends MCP cancellation for every
 *   outstanding request, kills its `cua-driver mcp` child, answers the provider, and only
 *   then revokes the driver sessions the agent named, in the background;
 * - on a pause (a person's input or takeover) it does the same without ending, refuses calls
 *   while paused, and starts a fresh driver child when the server hands control back.
 *
 * Killing the child is what stops nested work. Against the pinned 0.37.0 driver, MCP
 * cancellation and `cua-driver revoke --session` both leave a running run_script going, while
 * closing its transport stops it after the action already dispatched (ADR-0020). The rest is
 * protocol hygiene and covers drivers that honour them. A refused call is never replayed: the
 * agent observes again.
 *
 * @module ComputerUseLeaseProxy
 */
// JSON-RPC lines pass through unchanged; only the fields the proxy acts on are read.
// @effect-diagnostics preferSchemaOverJson:off
import {
  type ComputerUseControlEnd,
  ComputerUseLeaseUpdate,
  type ComputerUsePauseReason,
  type ComputerUseRefusalDetail,
  computerUseRefusalReason,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

import { approvedApps, learnApps, type ListedApp, scopeVerdict } from "./ComputerUseScope.ts";

export type LeaseEnd = ComputerUseControlEnd | "lost";

const REQUEST = goatCallText("computer_use.request");

export const LEASE_END_MESSAGES: Readonly<Record<LeaseEnd, string>> = {
  expired: `Computer use for this thread reached its time limit. A later turn gets it back while the thread is still admitted; otherwise ask again with ${REQUEST}.`,
  revoked: "A person ended computer use for this thread.",
  replaced: "A newer turn of this thread took over computer use; this connection is closed.",
  disabled: "Computer use was turned off on this host.",
  unauthorized:
    "GOAT could not confirm this thread's computer use approval, so computer use stopped.",
  stopped: "A person pressed Stop on this thread. Do not continue on the screen in this turn.",
  stopped_all: "A person stopped computer use for every thread on this host.",
  lost: "GOAT could not confirm this thread's computer use approval, so computer use stopped.",
};

export const PAUSE_MESSAGES: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input:
    "A person is using this computer, so computer use is paused and your call did not run. Do not retry now: end your turn or wait for them to hand control back, then observe the screen again before acting.",
  takeover:
    "A person took over the screen, so computer use is paused and your call did not run. Do not retry now: end your turn or wait for them to hand control back, then observe the screen again before acting.",
  private:
    "A password or other secret field has focus on this computer, so computer use is paused and your call did not run. Do not retry now; observe the screen again after the person leaves it.",
};

const scopeMessage = (
  reason: "app_not_approved" | "desktop_not_approved",
  app?: string,
  opaque?: boolean,
) =>
  reason === "app_not_approved"
    ? `${app ?? "This app"} is not approved for this thread, so the call did not run. Ask with ${REQUEST} and args {purpose, apps:[${JSON.stringify(app ?? "<bundle_id from list_apps>")}]}, then end your turn.`
    : opaque
      ? "This thread may control only its approved apps, and a script or batch cannot be checked against them, so it did not run. Make the calls one at a time, each with the pid and window_id of an approved app's window."
      : `This call would act on the whole desktop, and this thread may control only its approved apps, so it did not run. Target an approved app's window with its pid and window_id, or ask for the whole screen with ${REQUEST} without apps.`;

export interface LeaseProxyDriver {
  readonly send: (line: string) => Effect.Effect<void>;
  readonly lines: Stream.Stream<string>;
  readonly kill: Effect.Effect<void>;
}

export interface LeaseProxyOptions<EU, ED> {
  readonly controlId: string;
  readonly expiresAt: DateTime.Utc;
  /** Lines the provider writes. The proxy stops when this ends. */
  readonly input: Stream.Stream<string>;
  readonly output: (line: string) => Effect.Effect<void>;
  /** The server's view of this thread's control, newest last. Ending or failing ends it. */
  readonly leaseUpdates: Stream.Stream<ComputerUseLeaseUpdate, EU>;
  /** Starts one driver child; run again after a pause, each time in its own scope. */
  readonly startDriver: Effect.Effect<LeaseProxyDriver, ED, Scope.Scope>;
  /** Deny-only revocation of the driver sessions this connection named. */
  readonly revokeSessions: (sessions: ReadonlyArray<string>) => Effect.Effect<void>;
}

type JsonRpcId = string | number;
interface Envelope {
  readonly id?: JsonRpcId | null;
  readonly method?: string;
  readonly params?: {
    readonly name?: unknown;
    readonly arguments?: { readonly session?: unknown };
  };
  readonly result?: { readonly structuredContent?: { readonly session?: unknown } };
  readonly error?: unknown;
}

const parse = (line: string): Envelope | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Envelope)
      : undefined;
  } catch {
    return undefined;
  }
};

const decodeUpdate = Schema.decodeUnknownOption(ComputerUseLeaseUpdate);

/** Ids of the proxy's own requests to the driver; their answers never reach the provider. */
const OWN_ID = "goat-proxy:";

const refusal = (
  id: JsonRpcId,
  method: string | undefined,
  detail: ComputerUseRefusalDetail,
  message: string,
  app?: string,
) => {
  const refused = { refused: computerUseRefusalReason(detail), detail };
  return JSON.stringify(
    method === "tools/call"
      ? {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            structuredContent: { ...refused, ...(app === undefined ? {} : { app }) },
            isError: true,
          },
        }
      : { jsonrpc: "2.0", id, error: { code: -32000, message, data: refused } },
  );
};

interface Running {
  readonly driver: LeaseProxyDriver;
  readonly scope: Scope.Closeable;
}

export const runLeaseProxy = Effect.fn("ComputerUseLeaseProxy.run")(function* <EU, ED>(
  options: LeaseProxyOptions<EU, ED>,
) {
  const scope = yield* Effect.scope;
  const confirmed = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<LeaseEnd>();
  let deadline = DateTime.toEpochMillis(options.expiresAt);
  let finished: LeaseEnd | undefined;
  let paused: ComputerUsePauseReason | undefined;
  let apps: ReadonlySet<string> | undefined;
  let running: Running | undefined;
  let ownRequests = 0;
  const handshake: Array<string> = [];
  const outstanding = new Map<string, { readonly id: JsonRpcId; readonly method: string }>();
  const ownAnswers = new Map<string, Deferred.Deferred<void>>();
  const listed = new Map<number, ListedApp>();
  const sessions = new Set<string>();

  /** Cancels and answers every outstanding call, then kills the child. */
  const interrupt = Effect.fn("ComputerUseLeaseProxy.interrupt")(function* (
    reason: ComputerUseRefusalDetail,
    message: string,
  ) {
    const current = running;
    running = undefined;
    const pending = [...outstanding.values()];
    outstanding.clear();
    if (current !== undefined) {
      for (const request of pending)
        yield* current.driver.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: request.id, reason: message },
          }),
        );
      // The transport kill is what stops nested work, so nothing runs before it that could wait.
      yield* current.driver.kill;
      yield* Scope.close(current.scope, Exit.void);
    }
    for (const waiter of ownAnswers.values()) yield* Deferred.succeed(waiter, undefined);
    ownAnswers.clear();
    for (const request of pending)
      yield* options.output(refusal(request.id, request.method, reason, message));
  });

  const end = Effect.fn("ComputerUseLeaseProxy.end")(function* (reason: LeaseEnd) {
    if (finished !== undefined) return;
    finished = reason;
    yield* Deferred.succeed(ended, reason);
    yield* interrupt(reason, LEASE_END_MESSAGES[reason]);
    // Best effort and deny-only; a slow or stuck revoke cannot hold anything up.
    if (sessions.size > 0)
      yield* options.revokeSessions([...sessions]).pipe(Effect.ignoreCause, Effect.forkIn(scope));
  }, Effect.uninterruptible);

  const readLines = (current: Running) =>
    current.driver.lines.pipe(
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          if (finished !== undefined || running !== current) return;
          const message = parse(line);
          if (message?.id !== undefined && message.id !== null && message.method === undefined) {
            learnApps(message.result, listed);
            if (typeof message.id === "string" && message.id.startsWith(OWN_ID)) {
              const waiter = ownAnswers.get(message.id);
              ownAnswers.delete(message.id);
              if (waiter !== undefined) yield* Deferred.succeed(waiter, undefined);
              return;
            }
            const request = outstanding.get(JSON.stringify(message.id));
            outstanding.delete(JSON.stringify(message.id));
            const session = message.result?.structuredContent?.session;
            if (request?.method === "tools/call" && typeof session === "string")
              sessions.add(session);
          }
          yield* options.output(line);
        }),
      ),
      // A driver that exits on its own cannot be trusted with the rest of the control.
      Effect.andThen(Effect.suspend(() => (running === current ? end("lost") : Effect.void))),
    );

  const start = Effect.fn("ComputerUseLeaseProxy.startDriver")(function* () {
    const child = yield* Scope.fork(scope);
    const driver = yield* options.startDriver.pipe(Scope.provide(child));
    const current: Running = { driver, scope: child };
    running = current;
    // A fresh child after a pause hears the provider's handshake again; its answers are dropped.
    for (const line of handshake) {
      const message = parse(line);
      yield* driver.send(
        message?.id === undefined || message.id === null
          ? line
          : JSON.stringify({ ...message, id: `${OWN_ID}init:${ownRequests++}` }),
      );
    }
    yield* readLines(current).pipe(Effect.forkIn(scope));
  });

  const pausedDetail = (reason: ComputerUsePauseReason) =>
    reason === "private" ? ("private_mode" as const) : ("waiting_for_human" as const);

  const pause = Effect.fn("ComputerUseLeaseProxy.pause")(function* (
    reason: ComputerUsePauseReason,
  ) {
    if (finished !== undefined) return;
    if (paused === undefined) yield* interrupt(pausedDetail(reason), PAUSE_MESSAGES[reason]);
    paused = reason;
    // A proxy told it is paused before it was ever active refuses its waiting calls now.
    yield* Deferred.succeed(confirmed, undefined);
  }, Effect.uninterruptible);

  const activate = Effect.fn("ComputerUseLeaseProxy.activate")(function* (
    update: Extract<ComputerUseLeaseUpdate, { readonly state: "active" }>,
  ) {
    const expiresAt = DateTime.make(update.expiresAt);
    if (Option.isSome(expiresAt))
      deadline = Math.min(deadline, DateTime.toEpochMillis(expiresAt.value));
    const next = approvedApps(update.apps);
    // Fewer apps than before: work already running may be in one of them, so it ends now and
    // anything it still answers is dropped with the old child.
    const narrowed =
      (yield* Deferred.isDone(confirmed)) &&
      next !== undefined &&
      (apps === undefined || [...apps].some((app) => !next.has(app)));
    apps = next;
    if (paused !== undefined) {
      paused = undefined;
      if (finished === undefined) yield* start();
    } else if (narrowed && finished === undefined && running !== undefined) {
      yield* interrupt(
        "app_not_approved",
        "An app this call used is no longer approved for this thread, so it was stopped. Observe again before acting.",
      );
      yield* start();
    }
    yield* Deferred.succeed(confirmed, undefined);
  }, Effect.uninterruptible);

  yield* start();

  // The server is the authority: the first word for this control confirms it, anything else ends.
  yield* options.leaseUpdates.pipe(
    Stream.runForEach((update) =>
      update.state !== "ended" && update.controlId !== options.controlId
        ? end("lost")
        : update.state === "active"
          ? activate(update)
          : update.state === "paused"
            ? pause(update.reason)
            : end(update.reason === "unauthorized" ? "lost" : update.reason),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.andThen(end("lost")),
    Effect.forkScoped,
  );

  // Held here, not in the agent's calls: expiry acts while a call is outstanding or none comes.
  yield* Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadline) {
        yield* end("expired");
        return;
      }
      yield* Effect.sleep(deadline - now);
    }
  }).pipe(Effect.forkScoped);

  /** Asks the driver which apps run, so a pid it has not named yet can be judged. */
  const listApps = Effect.fn("ComputerUseLeaseProxy.listApps")(function* () {
    if (running === undefined) return;
    const id = `${OWN_ID}apps:${ownRequests++}`;
    const answered = yield* Deferred.make<void>();
    ownAnswers.set(id, answered);
    yield* running.driver.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_apps", arguments: {} },
      }),
    );
    yield* Effect.raceFirst(Deferred.await(answered), Deferred.await(ended).pipe(Effect.asVoid));
  });

  /** The refusal line for a confirmed tools/call that cannot run now; undefined forwards it. */
  const refuseCall = Effect.fn("ComputerUseLeaseProxy.refuseCall")(function* (
    id: JsonRpcId,
    message: Envelope,
  ) {
    if (finished === undefined && (yield* Clock.currentTimeMillis) >= deadline)
      yield* end("expired");
    const judge = () =>
      scopeVerdict({
        name: message.params?.name,
        args: message.params?.arguments,
        apps,
        appOf: (pid) => listed.get(pid),
      });
    let verdict = judge();
    if (verdict._tag === "resolve" && finished === undefined && paused === undefined) {
      yield* listApps();
      verdict = judge();
    }
    if (finished !== undefined)
      return refusal(id, message.method, finished, LEASE_END_MESSAGES[finished]);
    if (paused !== undefined)
      return refusal(id, message.method, pausedDetail(paused), PAUSE_MESSAGES[paused]);
    if (verdict._tag === "resolve")
      return refusal(
        id,
        message.method,
        "app_not_approved",
        scopeMessage("app_not_approved", `the app with pid ${verdict.pid}`),
      );
    if (verdict._tag === "refuse")
      return refusal(
        id,
        message.method,
        verdict.reason,
        scopeMessage(verdict.reason, verdict.app, verdict.opaque),
        verdict.app,
      );
    return undefined;
  });

  const handle = Effect.fn("ComputerUseLeaseProxy.forward")(function* (line: string) {
    const message = parse(line);
    const id = message?.id;
    const isRequest = id !== undefined && id !== null && message?.method !== undefined;
    if (message?.method === "initialize" || message?.method === "notifications/initialized")
      handshake.push(line);
    if (finished !== undefined) {
      if (isRequest)
        yield* options.output(refusal(id, message?.method, finished, LEASE_END_MESSAGES[finished]));
      return;
    }
    if (isRequest && message?.method === "tools/call") {
      yield* Effect.raceFirst(Deferred.await(confirmed), Deferred.await(ended).pipe(Effect.asVoid));
      const refused = yield* refuseCall(id, message);
      if (refused !== undefined) return yield* options.output(refused);
      const session = message.params?.arguments?.session;
      if (typeof session === "string" && session.length > 0) sessions.add(session);
    }
    // Paused: there is no driver until the server hands control back.
    if (running === undefined) {
      if (isRequest)
        yield* options.output(
          refusal(
            id,
            message?.method,
            "waiting_for_human",
            PAUSE_MESSAGES[paused ?? "human_input"],
          ),
        );
      return;
    }
    if (isRequest) outstanding.set(JSON.stringify(id), { id, method: message!.method! });
    yield* running.driver.send(line);
  });

  yield* options.input.pipe(Stream.runForEach(handle));
  // The provider closed its end: nothing more to serve, and the driver child goes with it.
  if (finished === undefined) {
    finished = "lost";
    if (running !== undefined) yield* running.driver.kill;
  }
  return finished;
});

/** Parses one NDJSON chunk stream from the lease route into updates, dropping unknown lines. */
export const leaseUpdateLines = <E>(lines: Stream.Stream<string, E>) =>
  lines.pipe(
    Stream.filter((line) => line.trim().length > 0),
    Stream.map((line) => {
      const parsed = parse(line);
      return parsed === undefined ? Option.none() : decodeUpdate(parsed);
    }),
    Stream.filter(Option.isSome),
    Stream.map((update) => update.value),
  );
