import type {
  ComputerUseLeaseThreadUpdate,
  ComputerUsePrimitiveRequest,
  ComputerUsePrimitiveCancel,
  AgentCursorLeaseUpdate,
  ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as BrowserOriginGrants from "../preview/BrowserOriginGrantsLayer.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PER_SIGNAL_READ } from "./ComputerUseLeaseQueries.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { watchClaimChanges } from "./ComputerUseLeaseClaimChanges.ts";

/** The person's strict-guards choice; an unreadable setting keeps the guards. */
export const readStrictGuards = (settings: ServerSettings.ServerSettingsService["Service"]) =>
  settings.getSettings.pipe(
    Effect.map((value) => value.cuaStrictInputGuards === true),
    Effect.orElseSucceed(() => true),
  );

export const threadLeaseUpdates = (input: {
  readonly threadId: ThreadId;
  readonly token: string;
}) =>
  Stream.callback<
    ComputerUseLeaseThreadUpdate,
    never,
    | ComputerUseLeases.ComputerUseLeases
    | ServerSettings.ServerSettingsService
    | McpSessionRegistry.McpSessionRegistry
  >(
    Effect.fn("ComputerUseLeaseThreadStream.follow")(function* (queue) {
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const settings = yield* ServerSettings.ServerSettingsService;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const grants = yield* Effect.serviceOption(BrowserOriginGrants.BrowserOriginGrants);
      const wake = yield* Queue.sliding<void>(1);
      if (Option.isSome(grants)) yield* watchClaimChanges(grants.value.changes, wake);
      // Acquire every subscription before reading authority, including while no control exists.
      const controls = yield* leases.subscribe;
      const credentials = yield* registry.subscribeChanges;
      const settingsChanges = yield* settings.subscribeChanges;
      // The proxy reading this exited, crashed or lost its connection: every control it followed
      // releases its app leases, and the calls they had out hold their apps only briefly (D17).
      const followed = new Set<string>();
      yield* Effect.addFinalizer(() =>
        Effect.forEach(followed, (id) => leases.releaseApps(input.threadId, id), {
          discard: true,
        }),
      );
      for (const subscription of [controls, credentials]) {
        yield* PubSub.take(subscription).pipe(
          Effect.andThen(Queue.offer(wake, undefined)),
          Effect.forever,
          Effect.forkScoped,
        );
      }
      yield* settingsChanges.pipe(
        Stream.runForEach(() => Queue.offer(wake, undefined)),
        Effect.forkScoped,
      );
      let previous: string | undefined;
      // A control this stream ended is never advertised again, even when a later read of it
      // succeeds: the proxy has already ended it for good.
      const fenced = new Set<string>();
      let waiting = false;
      // inspect, unlike resolve, never renews the credential: watching is not using it.
      const authorized = Effect.map(registry.inspect(input.token), (credential) =>
        credential?.threadId === input.threadId ? credential : undefined,
      ).pipe(Effect.withSpan("ComputerUseLeaseThreadStream.authorized", PER_SIGNAL_READ));
      // Credential expiry publishes nothing, so a quiet stream wakes for it on its own.
      const until = (at: number) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.sleep(Math.max(0, at - now))));
      for (;;) {
        const credential = yield* authorized;
        if (credential === undefined) {
          yield* Queue.offer(queue, { state: "ended", reason: "unauthorized" });
          return yield* Queue.end(queue);
        }
        const readEnabled = settings.getSettings.pipe(
          Effect.map((value) => value.enableCua),
          Effect.orElseSucceed(() => false),
        );
        const enabled = yield* readEnabled;
        const strictGuards = yield* readStrictGuards(settings);
        const current = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
        const value = !enabled
          ? { _tag: "ended" as const, reason: "disabled" as const }
          : current === undefined
            ? undefined
            : yield* leases.controlState(input.threadId, current.controlId).pipe(
                // A failed authority read fences this control; a later control can recover.
                Effect.orElseSucceed(() => ({
                  _tag: "ended" as const,
                  reason: "revoked" as const,
                })),
              );
        // controlState can suspend on grant reads. A revocation during that read must win.
        if ((yield* authorized) === undefined) {
          yield* Queue.offer(queue, { state: "ended", reason: "unauthorized" });
          return yield* Queue.end(queue);
        }
        const latest = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
        // A reuse meanwhile moved the expiry: read it again rather than send the old one.
        if (
          current?.controlId !== latest?.controlId ||
          current?.ended !== latest?.ended ||
          current?.expiresAt !== latest?.expiresAt
        )
          continue;
        // A disable during that read must win too.
        if (enabled && !(yield* readEnabled)) continue;
        if (previous !== undefined && previous !== current?.controlId) {
          yield* Queue.offer(queue, {
            state: "control-ended",
            controlId: previous,
            reason: !enabled ? "disabled" : current === undefined ? "revoked" : "replaced",
          });
          fenced.add(previous);
          previous = undefined;
        }
        if (
          current === undefined ||
          value === undefined ||
          value._tag === "ended" ||
          fenced.has(current.controlId)
        ) {
          if (current !== undefined && value?._tag === "ended" && !fenced.has(current.controlId)) {
            yield* Queue.offer(queue, {
              state: "control-ended",
              controlId: current.controlId,
              reason: value.reason,
            });
            fenced.add(current.controlId);
          }
          previous = undefined;
          if (!waiting) yield* Queue.offer(queue, { state: "waiting" });
          waiting = true;
          yield* Effect.raceFirst(Queue.take(wake), until(credential.recheckAt));
          continue;
        }
        previous = current.controlId;
        if (!followed.has(current.controlId)) {
          followed.add(current.controlId);
          yield* leases.streamOpened(current.controlId);
        }
        waiting = false;
        const identity = {
          controlId: current.controlId,
          expiresAt: DateTime.formatIso(current.expiresAt),
        };
        const snapshot = Option.isSome(grants)
          ? yield* grants.value.snapshotFor(input.threadId)
          : undefined;
        const browserClaimVersion = snapshot?.revision ?? 0;
        const browserClaimBindings = snapshot?.bindings ?? [];
        const browserClaims = snapshot?.claims ?? [];
        const claimedBrowserPids = snapshot?.pids ?? [];
        yield* Queue.offer(
          queue,
          value._tag === "paused"
            ? { state: "paused", ...identity, reason: value.reason }
            : value.idle === true
              ? { state: "idle", ...identity }
              : {
                  state: "active",
                  ...identity,
                  ...(value.apps === undefined ? {} : { apps: value.apps }),
                  ...(value.idleEpoch === undefined ? {} : { idleEpoch: value.idleEpoch }),
                  ...(value.identityEpoch === undefined
                    ? {}
                    : { identityEpoch: value.identityEpoch }),
                  ...(value.foreground === undefined ? {} : { foreground: value.foreground }),
                  ...(value.interruptions.count === 0
                    ? {}
                    : { interruptions: value.interruptions }),
                  ...(value.shared === true ? { shared: true } : {}),
                  ...(strictGuards ? {} : { strictInputGuards: false as const }),
                  ...(browserClaimVersion === 0 ? {} : { browserClaimVersion }),
                  ...(browserClaimBindings.length === 0 ? {} : { browserClaimBindings }),
                  ...(browserClaims.length === 0 ? {} : { browserClaims }),
                  ...(claimedBrowserPids.length === 0 ? {} : { claimedBrowserPids }),
                },
        );
        const deadline = DateTime.toEpochMillis(current.expiresAt);
        const wakeAt = Math.min(
          value._tag === "active" ? Math.min(deadline, value.wakeAt) : deadline,
          credential.recheckAt,
        );
        yield* Effect.raceFirst(Queue.take(wake), until(wakeAt));
      }
    }),
  );

/** Lease state owns the next slot; primitive traffic cannot delay Stop behind its burst. */
export const withPrimitiveRequests = <A, R>(
  states: Stream.Stream<A, never, R>,
  primitives:
    | Stream.Stream<
        ComputerUsePrimitiveRequest | ComputerUsePrimitiveCancel | AgentCursorLeaseUpdate
      >
    | undefined,
): Stream.Stream<
  A | ComputerUsePrimitiveRequest | ComputerUsePrimitiveCancel | AgentCursorLeaseUpdate,
  never,
  R
> =>
  primitives === undefined
    ? states
    : Stream.callback<
        A | ComputerUsePrimitiveRequest | ComputerUsePrimitiveCancel | AgentCursorLeaseUpdate,
        never,
        R
      >(
        (output) =>
          Effect.gen(function* () {
            type State = { readonly kind: "state"; readonly value: A } | { readonly kind: "end" };
            const stateQueue = yield* Queue.bounded<State>(16);
            const primitiveQueue = yield* Queue.unbounded<
              ComputerUsePrimitiveRequest | ComputerUsePrimitiveCancel | AgentCursorLeaseUpdate
            >();
            const cursorQueue = yield* Queue.sliding<AgentCursorLeaseUpdate>(1);
            yield* states.pipe(
              Stream.runForEach((value) => Queue.offer(stateQueue, { kind: "state", value })),
              Effect.ensuring(Queue.offer(stateQueue, { kind: "end" })),
              Effect.forkScoped,
            );
            yield* primitives.pipe(
              Stream.runForEach((request) =>
                request.state === "cursor-state" && request.event.op !== "hide"
                  ? Queue.offer(cursorQueue, request)
                  : Queue.offer(primitiveQueue, request),
              ),
              Effect.forkScoped,
            );
            let firstState = true;
            let latestRevision = -1;
            let activeState = false;
            const waitingBinds: Array<ComputerUsePrimitiveRequest> = [];
            const sendState = Effect.fn("ComputerUseLeaseThreadStream.sendState")(function* (
              value: A,
            ) {
              if (typeof value === "object" && value !== null && "state" in value) {
                activeState = value.state === "active";
                // An active state without a version carries claim revision 0.
                if (activeState)
                  latestRevision =
                    "browserClaimVersion" in value && typeof value.browserClaimVersion === "number"
                      ? value.browserClaimVersion
                      : 0;
              }
              yield* Queue.offer(output, value);
            });
            const holdBind = (
              value:
                | ComputerUsePrimitiveRequest
                | ComputerUsePrimitiveCancel
                | AgentCursorLeaseUpdate,
            ) =>
              value.state === "primitive-request" &&
              value.authority === "claimBind" &&
              value.bindingVersion !== undefined &&
              activeState &&
              value.bindingVersion > latestRevision;
            const forwardPrimitive = Effect.fn("ComputerUseLeaseThreadStream.forwardPrimitive")(
              function* (
                value:
                  | ComputerUsePrimitiveRequest
                  | ComputerUsePrimitiveCancel
                  | AgentCursorLeaseUpdate,
              ) {
                if (value.state === "primitive-cancel") {
                  const index = waitingBinds.findIndex(
                    (waiting) => waiting.requestId === value.requestId,
                  );
                  if (index >= 0) waitingBinds.splice(index, 1);
                }
                if (holdBind(value) && value.state === "primitive-request")
                  waitingBinds.push(value);
                else yield* Queue.offer(output, value);
              },
            );
            let pendingPrimitive:
              | ComputerUsePrimitiveRequest
              | ComputerUsePrimitiveCancel
              | AgentCursorLeaseUpdate
              | undefined;
            for (;;) {
              const readyState = Option.getOrUndefined(yield* Queue.poll(stateQueue));
              if (readyState !== undefined) {
                if (readyState.kind === "end") return yield* Queue.end(output);
                yield* sendState(readyState.value);
                firstState = false;
                continue;
              }
              const readyBind = waitingBinds.findIndex((value) => !holdBind(value));
              if (readyBind >= 0) {
                const [binding] = waitingBinds.splice(readyBind, 1);
                if (binding !== undefined) yield* Queue.offer(output, binding);
                continue;
              }
              if (pendingPrimitive !== undefined) {
                yield* forwardPrimitive(pendingPrimitive);
                pendingPrimitive = undefined;
                continue;
              }
              if (firstState) {
                const first = yield* Queue.take(stateQueue);
                if (first.kind === "end") return yield* Queue.end(output);
                yield* sendState(first.value);
                firstState = false;
                continue;
              }
              const critical = Option.getOrUndefined(yield* Queue.poll(primitiveQueue));
              if (critical !== undefined) {
                yield* forwardPrimitive(critical);
                continue;
              }
              const cursor = Option.getOrUndefined(yield* Queue.poll(cursorQueue));
              if (cursor !== undefined) {
                yield* Queue.offer(output, cursor);
                continue;
              }
              const selected = yield* Effect.raceFirst(
                Queue.take(stateQueue).pipe(
                  Effect.map((value) => ({ kind: "state" as const, value })),
                ),
                Effect.raceFirst(Queue.take(primitiveQueue), Queue.take(cursorQueue)).pipe(
                  Effect.map((value) => ({ kind: "primitive" as const, value })),
                ),
              );
              if (selected.kind === "state") {
                if (selected.value.kind === "end") return yield* Queue.end(output);
                yield* sendState(selected.value.value);
                continue;
              }
              const overtakingState = Option.getOrUndefined(yield* Queue.poll(stateQueue));
              if (overtakingState !== undefined) {
                pendingPrimitive = selected.value;
                if (overtakingState.kind === "end") return yield* Queue.end(output);
                yield* sendState(overtakingState.value);
              } else yield* forwardPrimitive(selected.value);
            }
          }),
        { bufferSize: 1, strategy: "suspend" },
      );
