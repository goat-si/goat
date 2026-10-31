// @effect-diagnostics nodeBuiltinImport:off -- timingSafeEqual compares a credential in constant time.
import * as NodeCrypto from "node:crypto";

import type {
  ComputerUsePrimitiveReply,
  ComputerUsePrimitiveRequest,
  ComputerUsePrimitiveCancel,
  AgentCursorLeaseUpdate,
  AgentCursorEvent,
  ScreenRunError,
  ThreadId,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { driverCallDeadline, MIN_CALL_MS, seconds } from "./ComputerUseCallCaps.ts";
import { cutOff, refusal } from "./ComputerUseLeaseResponses.ts";
import { LEASE_END_MESSAGES, PAUSE_MESSAGES } from "./ComputerUseLeaseMessages.ts";
import {
  terminalFailure,
  mergeTerminal,
  terminalReason,
  terminalReplyReason,
  type ComputerUseTerminalReason,
} from "./ComputerUseTerminal.ts";

const resultOf = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Json }));

/**
 * No live control means waiting cannot help: the agent asks again, and GOAT restarts and checks
 * its helper by itself. A control without a bound driver is one GOAT is starting again.
 */
const desktopNotReady = (control: "none" | "unbound"): ScreenRunError => ({
  code: "unavailable",
  reason: "desktop_not_ready",
  effectStarted: false,
  nextStep:
    control === "none"
      ? `This thread has no live desktop control, so nothing was sent. Unless the person paused or stopped computer use, ask again with ${goatCallText("computer_use.request")}, then observe again; GOAT restarts and checks its helper by itself.`
      : `Desktop control is starting again. Observe again; if this answer repeats, ask again with ${goatCallText("computer_use.request")}.`,
});

interface Pending {
  readonly request: ComputerUsePrimitiveRequest;
  readonly answer: Deferred.Deferred<ComputerUsePrimitiveReply>;
  sent: boolean;
  terminal?: ComputerUseTerminalReason;
  /** When its answer reached the server; a loaded server may resume the caller later. */
  answeredAt?: number;
}

/** How long a call waits for a restarting driver to bind, inside its own deadline. */
export const DRIVER_BIND_WAIT_MS = 10_000;
/**
 * Past a call's deadline, how long its proxy has to say it never sent it; until it does, a call
 * the proxy took counts as one the driver may be running. Within CELL_RESERVE_MS.
 */
export const PROXY_ANSWER_GRACE_MS = 1_000;

interface Control {
  terminal?: "stopped_by_person" | "screen_locked";
  epoch: { reason?: ComputerUseTerminalReason };
  maxAcceptedGeneration: number;
  maxCutoffGeneration: number;
  binding: { readonly connectionId: string; readonly generation: number } | undefined;
  readonly pending: Map<string, Pending>;
  /** Calls the driver had at their deadline; their cell's end cancels them, so it replaces it. */
  readonly abandoned: Map<string, Pending>;
}

interface Registration {
  readonly id: string;
  readonly instanceId: string;
  readonly kind: "control" | "thread";
  readonly controlId?: string;
  readonly queue: Queue.Queue<ComputerUsePrimitiveRequest | AgentCursorLeaseUpdate>;
  readonly cancellations: Queue.Queue<ComputerUsePrimitiveCancel>;
  readonly cursors: Queue.Queue<AgentCursorLeaseUpdate>;
  readonly controls: Map<string, Control>;
}

interface Attachment {
  readonly generation: string;
  readonly token: string;
  readonly expiresAt: number;
  readonly controlId?: string;
  registration: Registration | undefined;
}

interface Authority {
  readonly threadId: ThreadId;
  readonly attachmentGeneration: string;
  readonly proxyChannelToken: string;
}

interface Report extends Authority {
  readonly registrationId: string;
  readonly controlId: string;
  readonly connectionId: string;
  readonly driverGeneration: number;
}

export interface PrimitiveChannelRequest {
  readonly threadId: ThreadId;
  readonly expectedConnectionGeneration?: string;
  readonly runId: string;
  readonly turnId: string;
  readonly callId: number;
  readonly deadlineMillis: number;
  readonly tool: string;
  readonly authority?: "claimBind";
  readonly bindingVersion?: number;
  readonly args: ComputerUsePrimitiveRequest["args"];
  readonly cursor?: ComputerUsePrimitiveRequest["cursor"];
}

export class ComputerUsePrimitiveChannel extends Context.Service<
  ComputerUsePrimitiveChannel,
  {
    /**
     * One secret per thread for this server's life. The proxy descriptor carries it, so Stop and a
     * new approval leave the harness's MCP config unchanged; the attachment generation still fences.
     */
    readonly tokenFor: (threadId: ThreadId) => Effect.Effect<string>;
    readonly issue: (
      input: Authority & { readonly expiresAt: number; readonly controlId?: string },
    ) => Effect.Effect<void>;
    readonly revoke: (input: {
      readonly threadId: ThreadId;
      readonly attachmentGeneration?: string;
      readonly proxyChannelToken?: string;
    }) => Effect.Effect<void>;
    readonly authenticate: (input: {
      readonly threadId: ThreadId;
      readonly proxyChannelToken: string;
    }) => Effect.Effect<string | undefined>;
    readonly registerStream: (
      input: Authority & {
        readonly proxyInstanceId: string;
        readonly kind: "control" | "thread";
        readonly controlId?: string;
      },
    ) => Effect.Effect<
      | { readonly status: "unauthorized" | "conflict" }
      | {
          readonly status: "registered";
          readonly registrationId: string;
          readonly requests: Stream.Stream<
            ComputerUsePrimitiveRequest | ComputerUsePrimitiveCancel | AgentCursorLeaseUpdate
          >;
        }
    >;
    readonly closeStream: (input: {
      readonly threadId: ThreadId;
      readonly registrationId: string;
    }) => Effect.Effect<void>;
    readonly reportControlReady: (input: Report) => Effect.Effect<boolean>;
    readonly reportControlCutoff: (
      input: Report & { readonly terminal?: "stopped_by_person" | "screen_locked" },
    ) => Effect.Effect<boolean>;
    readonly request: (
      input: PrimitiveChannelRequest,
    ) => Effect.Effect<
      ComputerUsePrimitiveReply & { readonly driverGeneration?: number },
      ScreenRunError
    >;
    readonly reply: (
      input: Authority & {
        readonly registrationId: string;
        readonly reply: ComputerUsePrimitiveReply;
      },
    ) => Effect.Effect<boolean>;
    readonly cancel: (runId: string, turnId: string) => Effect.Effect<void>;
    readonly cursor: (input: {
      readonly threadId: ThreadId;
      readonly event: AgentCursorEvent;
    }) => Effect.Effect<boolean>;
  }
>()("goat/cua/ComputerUsePrimitiveChannel") {}

export const make = Effect.gen(function* () {
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const attachments = new Map<ThreadId, Attachment>();
  const waitingEpochs = new Map<string, Map<Control["epoch"], number>>();
  const waitingKey = (threadId: ThreadId, controlId: string) =>
    JSON.stringify([threadId, controlId]);
  const threadTokens = new Map<ThreadId, string>();
  // Completed and replaced whenever a binding, a registration or a control changes, so a call
  // waiting for a driver re-checks at once, including when its proxy goes away.
  let changed = Deferred.makeUnsafe<void>();
  const wake = () => {
    const waiting = changed;
    changed = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(waiting, Exit.void);
  };
  const settle = (pending: Pending, terminal?: Control["terminal"]) => {
    pending.terminal = mergeTerminal({ reason: pending.terminal }, { reason: terminal }).reason;
    terminal = terminalReason(pending.terminal);
    return Deferred.doneUnsafe(
      pending.answer,
      Exit.succeed({
        ...pending.request,
        status: pending.sent ? "unknown_outcome" : "not_started",
        ...(terminal === undefined
          ? {}
          : {
              result: resultOf(
                JSON.parse(
                  pending.sent
                    ? cutOff(
                        pending.request.callId,
                        pending.request.tool,
                        terminal === "screen_locked"
                          ? { _tag: "pause", reason: "screen_locked" }
                          : { _tag: "end", reason: "stopped_all" },
                        pending.request.args,
                      )
                    : refusal(
                        pending.request.callId,
                        "tools/call",
                        terminal === "screen_locked" ? "screen_locked" : "stopped",
                        terminal === "screen_locked"
                          ? PAUSE_MESSAGES.screen_locked
                          : LEASE_END_MESSAGES.stopped,
                      ),
                ),
              ).result,
            }),
      }),
    );
  };
  const cancelDelivered = (registration: Registration, pending: Pending) => {
    if (pending.sent)
      Queue.offerUnsafe(registration.cancellations, {
        state: "primitive-cancel",
        requestId: pending.request.requestId,
      });
  };
  const clear = (registration: Registration, control: Control) => {
    control.binding = undefined;
    control.abandoned.clear();
    for (const [id, pending] of control.pending) {
      control.pending.delete(id);
      cancelDelivered(registration, pending);
      settle(pending, control.terminal);
    }
  };
  const close = (attachment: Attachment) => {
    const registration = attachment.registration;
    if (registration === undefined) return;
    attachment.registration = undefined;
    wake();
    for (const control of registration.controls.values()) {
      control.binding = undefined;
      control.abandoned.clear();
      for (const pending of control.pending.values()) {
        cancelDelivered(registration, pending);
        settle(pending, control.terminal);
      }
      control.pending.clear();
    }
    return Effect.all([
      Queue.shutdown(registration.queue),
      Queue.shutdown(registration.cancellations),
      Queue.shutdown(registration.cursors),
    ]).pipe(Effect.asVoid);
  };
  const tokenMatches = (expected: string, given: string) => {
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
  };
  // A thread proxy registers once and never reconnects, so its control's expiry must not
  // unauthorize it: the next turn reissues the attachment under the same registration.
  const live = (value: Attachment, now: number) =>
    value.expiresAt > now || value.registration?.kind === "thread";
  const attachment = (input: Authority, now: number) => {
    const value = attachments.get(input.threadId);
    return value?.generation === input.attachmentGeneration &&
      live(value, now) &&
      tokenMatches(value.token, input.proxyChannelToken)
      ? value
      : undefined;
  };
  const registration = (input: Authority & { readonly registrationId: string }, now: number) => {
    const live = attachment(input, now)?.registration;
    return live?.id === input.registrationId ? live : undefined;
  };
  const control = (value: Registration, controlId: string) => {
    let record = value.controls.get(controlId);
    if (record === undefined) {
      record = {
        epoch: {},
        maxAcceptedGeneration: -1,
        maxCutoffGeneration: -1,
        binding: undefined,
        pending: new Map(),
        abandoned: new Map(),
      };
      value.controls.set(controlId, record);
    }
    return record;
  };
  const latch = (record: Control, reason: ComputerUseTerminalReason) => {
    record.terminal = mergeTerminal({ reason: record.terminal }, { reason }).reason;
    record.epoch.reason = mergeTerminal(record.epoch, { reason }).reason;
  };
  const unsubscribe = leases.onAuthorityChange?.((change) => {
    if (change.terminal === undefined) return;
    for (const epoch of waitingEpochs.get(waitingKey(change.threadId, change.controlId))?.keys() ??
      [])
      epoch.reason = mergeTerminal(epoch, { reason: change.terminal }).reason;
    const registered = attachments.get(change.threadId)?.registration;
    if (registered !== undefined) latch(control(registered, change.controlId), change.terminal);
    wake();
  });
  if (unsubscribe !== undefined) yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  const active = (threadId: ThreadId, controlId: string) =>
    leases.controlState(threadId, controlId).pipe(
      Effect.map((state) => state._tag === "active" && state.idle !== true),
      Effect.orElseSucceed(() => false),
    );
  // A thread proxy lives as long as its provider conversation and registers once. A turn end,
  // expiry, successor or Stop ends only the control; revocation and turning computer use off
  // close the registration, as does an explicit revoke when the thread's session goes.
  const keepsRegistration = (state: { readonly _tag: string; readonly reason?: string }) =>
    state._tag !== "ended" ||
    state.reason === "expired" ||
    state.reason === "replaced" ||
    state.reason === "stopped" ||
    state.reason === "stopped_all";
  const revokeEndedControls = Effect.fn("ComputerUsePrimitiveChannel.revokeEndedControls")(
    function* () {
      wake();
      for (const [threadId, attachment] of attachments) {
        const current = Option.getOrUndefined(yield* leases.currentControl(threadId));
        const registered = attachment.registration;
        for (const [controlId, record] of registered?.controls ?? [])
          if (controlId !== current?.controlId) {
            if (registered) clear(registered, record);
            registered?.controls.delete(controlId);
          }
        if (attachment.controlId === undefined) continue;
        if (current === undefined) continue;
        const state =
          current.ended === undefined
            ? yield* leases
                .controlState(threadId, current.controlId)
                .pipe(Effect.orElseSucceed(() => ({ _tag: "ended" as const })))
            : { _tag: "ended" as const, reason: current.ended };
        const record = registered?.controls.get(current.controlId);
        if (
          record !== undefined &&
          state._tag === "ended" &&
          "reason" in state &&
          (state.reason === "stopped" || state.reason === "stopped_all")
        )
          latch(record, "stopped_by_person");
        if (record !== undefined && state._tag === "paused" && state.reason === "screen_locked")
          latch(record, "screen_locked");
        if (state._tag !== "ended" && !(state._tag === "active" && state.idle === true)) continue;
        // A proxy still starting registers as a thread proxy, so its attachment waits for it.
        if (registered?.kind !== "control" && keepsRegistration(state)) {
          if (registered !== undefined && record !== undefined) clear(registered, record);
          continue;
        }
        yield* close(attachment) ?? Effect.void;
        if (attachments.get(threadId) === attachment) attachments.delete(threadId);
      }
    },
  );
  const changes = yield* leases.subscribe;
  yield* PubSub.take(changes).pipe(
    Effect.andThen(revokeEndedControls()),
    Effect.forever,
    Effect.forkScoped,
  );
  // Runs inside request's span; a span of its own would only repeat it.
  const send = Effect.fnUntraced(function* (
    input: PrimitiveChannelRequest,
    controlId: string,
    registered: Registration,
    record: Control,
    binding: NonNullable<Control["binding"]>,
    now: number,
    deadlineMillis: number,
  ) {
    if (
      input.expectedConnectionGeneration !== undefined &&
      input.expectedConnectionGeneration !== binding.connectionId
    )
      return yield* Effect.fail(
        terminalFailure(terminalReason(record.terminal), input.tool, input.args) ?? {
          code: "stale_reference" as const,
          effectStarted: false,
          nextStep: "Bind the desktop app again after the driver reconnects.",
        },
      );
    const answer = yield* Deferred.make<ComputerUsePrimitiveReply>();
    const request: ComputerUsePrimitiveRequest = {
      state: "primitive-request",
      requestId: NodeCrypto.randomUUID(),
      registrationId: registered.id,
      controlId,
      connectionGeneration: binding.connectionId,
      runId: input.runId,
      turnId: input.turnId,
      callId: input.callId,
      deadlineMillis,
      tool: input.tool,
      ...(input.authority === undefined ? {} : { authority: input.authority }),
      ...(input.bindingVersion === undefined ? {} : { bindingVersion: input.bindingVersion }),
      args: input.args,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    };
    const pending: Pending = { request, answer, sent: false };
    record.pending.set(request.requestId, pending);
    const offered = yield* Queue.offer(registered.queue, request);
    if (!offered) {
      record.pending.delete(request.requestId);
      return yield* Effect.fail(
        terminalFailure(terminalReason(record.terminal), input.tool, input.args) ??
          desktopNotReady("unbound"),
      );
    }
    let timedOut = false;
    const deadlineFailure = () =>
      terminalFailure(terminalReason(record.terminal), input.tool, input.args, pending.sent) ?? {
        code: "deadline" as const,
        effectStarted: pending.sent,
        nextStep: pending.sent
          ? `The driver did not answer within ${seconds(deadlineMillis - now)} and may still be working on it. Observe before acting again; do not resend input.`
          : `The driver did not take this call within ${seconds(deadlineMillis - now)}; nothing was sent. Try it again.`,
      };
    return yield* Deferred.await(answer).pipe(
      Effect.timeoutOrElse({
        duration: Math.max(0, deadlineMillis - now) + PROXY_ANSWER_GRACE_MS,
        orElse: () => {
          timedOut = true;
          return Effect.fail(deadlineFailure());
        },
      }),
      // The grace is only for the proxy to say it never sent the call; an answer the driver
      // gave past the deadline is still a call that missed it.
      // GOAT's own settlement (a cutoff, a cancel) records no arrival; it counts when seen.
      Effect.flatMap((answered) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((resumed) => ({ answered, at: pending.answeredAt ?? resumed })),
        ),
      ),
      Effect.filterOrFail(
        ({ answered, at }) =>
          terminalReason(pending.terminal) !== undefined ||
          at <= deadlineMillis ||
          answered.status === "not_started",
        deadlineFailure,
      ),
      Effect.map(({ answered }) =>
        input.authority === "claimBind"
          ? { ...answered, driverGeneration: binding.generation + 1 }
          : answered,
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (!record.pending.delete(request.requestId)) return;
          if (timedOut && pending.sent) record.abandoned.set(request.requestId, pending);
          else cancelDelivered(registered, pending);
        }),
      ),
    );
  });
  return ComputerUsePrimitiveChannel.of({
    tokenFor: Effect.fn("ComputerUsePrimitiveChannel.tokenFor")(function* (threadId) {
      const existing = threadTokens.get(threadId);
      if (existing !== undefined) return existing;
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      if (threadTokens.size >= 4096) {
        const oldest = threadTokens.keys().next().value;
        if (oldest !== undefined) threadTokens.delete(oldest);
      }
      threadTokens.set(threadId, token);
      return token;
    }),
    issue: Effect.fn("ComputerUsePrimitiveChannel.issue")(function* (input) {
      const previous = attachments.get(input.threadId);
      const kept =
        previous?.registration?.kind === "thread" &&
        tokenMatches(previous.token, input.proxyChannelToken)
          ? previous.registration
          : undefined;
      if (kept !== undefined)
        for (const record of kept.controls.values())
          for (const [id, pending] of record.pending) {
            record.pending.delete(id);
            cancelDelivered(kept, pending);
            settle(pending, record.terminal);
          }
      else if (previous !== undefined) yield* close(previous) ?? Effect.void;
      attachments.set(input.threadId, {
        generation: input.attachmentGeneration,
        token: input.proxyChannelToken,
        expiresAt: input.expiresAt,
        ...(input.controlId === undefined ? {} : { controlId: input.controlId }),
        registration: kept,
      });
    }),
    revoke: Effect.fn("ComputerUsePrimitiveChannel.revoke")(function* (input) {
      const previous = attachments.get(input.threadId);
      if (
        previous === undefined ||
        (input.attachmentGeneration !== undefined &&
          previous.generation !== input.attachmentGeneration) ||
        (input.proxyChannelToken !== undefined &&
          !tokenMatches(previous.token, input.proxyChannelToken))
      )
        return;
      yield* close(previous) ?? Effect.void;
      attachments.delete(input.threadId);
    }),
    authenticate: Effect.fn("ComputerUsePrimitiveChannel.authenticate")((input) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const value = attachments.get(input.threadId);
          return value !== undefined &&
            live(value, now) &&
            tokenMatches(value.token, input.proxyChannelToken)
            ? value.generation
            : undefined;
        }),
      ),
    ),
    registerStream: Effect.fn("ComputerUsePrimitiveChannel.registerStream")(function* (input) {
      if (
        input.kind === "control" &&
        (input.controlId === undefined || !(yield* active(input.threadId, input.controlId)))
      )
        return { status: "conflict" as const };
      const now = yield* Clock.currentTimeMillis;
      const queue = yield* Queue.dropping<ComputerUsePrimitiveRequest | AgentCursorLeaseUpdate>(16);
      const cancellations = yield* Queue.unbounded<ComputerUsePrimitiveCancel>();
      const cursors = yield* Queue.sliding<AgentCursorLeaseUpdate>(1);
      const value = attachment(input, now);
      if (value === undefined) return { status: "unauthorized" as const };
      if (value.registration !== undefined) return { status: "conflict" as const };
      const id = NodeCrypto.randomUUID();
      const registered: Registration = {
        id,
        instanceId: input.proxyInstanceId,
        kind: input.kind,
        ...(input.controlId === undefined ? {} : { controlId: input.controlId }),
        queue,
        cancellations,
        cursors,
        controls: new Map(),
      };
      value.registration = registered;
      const current = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
      if (current !== undefined) {
        const state = yield* leases
          .controlState(input.threadId, current.controlId)
          .pipe(Effect.option);
        const terminal =
          terminalReason(undefined, Option.getOrUndefined(state)) ??
          terminalReason(
            undefined,
            current.ended === undefined ? undefined : { _tag: "ended", reason: current.ended },
          );
        if (terminal !== undefined) latch(control(registered, current.controlId), terminal);
      }
      const requests = Stream.merge(
        Stream.merge(Stream.fromQueue(queue), Stream.fromQueue(cancellations)),
        Stream.fromQueue(cursors),
      ).pipe(
        Stream.filter((request) => {
          if (request.state === "primitive-cancel") return true;
          if (request.state === "cursor-state")
            return (
              registered.controls.get(request.controlId)?.binding?.connectionId ===
              request.connectionGeneration
            );
          const pending = registered.controls
            .get(request.controlId)
            ?.pending.get(request.requestId);
          if (
            pending === undefined ||
            registered.controls.get(request.controlId)?.binding?.connectionId !==
              request.connectionGeneration
          )
            return false;
          pending.sent = true;
          return true;
        }),
      );
      return { status: "registered" as const, registrationId: id, requests };
    }),
    closeStream: Effect.fn("ComputerUsePrimitiveChannel.closeStream")(function* (input) {
      const value = attachments.get(input.threadId);
      if (value?.registration?.id === input.registrationId) yield* close(value) ?? Effect.void;
    }),
    cursor: Effect.fn("ComputerUsePrimitiveChannel.cursor")(function* (input) {
      const current = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
      if (current === undefined || !(yield* active(input.threadId, current.controlId)))
        return false;
      const attachment = attachments.get(input.threadId);
      const registered = attachment?.registration;
      const binding = registered?.controls.get(current.controlId)?.binding;
      if (!registered || !binding) return false;
      const update: AgentCursorLeaseUpdate = {
        state: "cursor-state",
        controlId: current.controlId,
        connectionGeneration: binding.connectionId,
        event: input.event,
      };
      const offered = yield* Queue.offer(
        input.event.op === "hide" ? registered.queue : registered.cursors,
        update,
      );
      // A dropped terminal marker would leave the helper showing an old owner. Closing the
      // stream cuts off that proxy and removes its helper overlay instead.
      if (!offered && input.event.op === "hide" && attachment)
        yield* close(attachment) ?? Effect.void;
      return offered;
    }),
    reportControlReady: Effect.fn("ComputerUsePrimitiveChannel.reportControlReady")(
      function* (input) {
        if (!(yield* active(input.threadId, input.controlId))) return false;
        const now = yield* Clock.currentTimeMillis;
        const registered = registration(input, now);
        if (
          registered === undefined ||
          (registered.kind === "control" && registered.controlId !== input.controlId)
        )
          return false;
        const record = control(registered, input.controlId);
        if (
          input.driverGeneration <=
          Math.max(record.maxAcceptedGeneration, record.maxCutoffGeneration)
        )
          return false;
        clear(registered, record);
        if (record.terminal === "screen_locked") delete record.terminal;
        record.epoch = record.terminal === undefined ? {} : { reason: record.terminal };
        record.maxAcceptedGeneration = input.driverGeneration;
        record.binding = { connectionId: input.connectionId, generation: input.driverGeneration };
        wake();
        return true;
      },
    ),
    reportControlCutoff: Effect.fn("ComputerUsePrimitiveChannel.reportControlCutoff")(
      function* (input) {
        const current = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
        if (current?.controlId !== input.controlId) return false;
        const now = yield* Clock.currentTimeMillis;
        const registered = registration(input, now);
        if (
          registered === undefined ||
          (registered.kind === "control" && registered.controlId !== input.controlId)
        )
          return false;
        const record = control(registered, input.controlId);
        if (input.driverGeneration <= record.maxCutoffGeneration) return true;
        if (
          record.binding?.generation === input.driverGeneration &&
          record.binding.connectionId !== input.connectionId
        )
          return false;
        if (input.terminal !== undefined && input.driverGeneration >= record.maxAcceptedGeneration)
          latch(record, input.terminal);
        record.maxCutoffGeneration = input.driverGeneration;
        if (record.binding !== undefined && record.binding.generation <= input.driverGeneration)
          clear(registered, record);
        return true;
      },
    ),
    request: Effect.fn("ComputerUsePrimitiveChannel.request")(function* (input) {
      const started = yield* Clock.currentTimeMillis;
      // One deadline from the start covers waiting for a driver too; the proxy waits on it as
      // well, so a driver that never answers is replaced after it.
      const deadlineMillis = driverCallDeadline(
        input.tool,
        input.args,
        input.deadlineMillis,
        started,
      );
      const waitUntil = Math.min(deadlineMillis, started + DRIVER_BIND_WAIT_MS);
      let now = started;
      // The call belongs to the control it began under; a successor never inherits it.
      let began: string | undefined;
      let beganEpoch: Control["epoch"] | undefined;
      let retainedKey: string | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (retainedKey === undefined || beganEpoch === undefined) return;
          const waiters = waitingEpochs.get(retainedKey);
          const count = waiters?.get(beganEpoch) ?? 0;
          if (count > 1) waiters?.set(beganEpoch, count - 1);
          else waiters?.delete(beganEpoch);
          if (waiters?.size === 0) waitingEpochs.delete(retainedKey);
        }),
      );
      // A driver GOAT is starting again (a new turn, a replaced child) binds within moments, so
      // the call waits for it inside its own budget instead of failing or hanging to its deadline.
      for (;;) {
        const previousFailure = terminalFailure(
          terminalReason(beganEpoch?.reason),
          input.tool,
          input.args,
        );
        if (previousFailure !== undefined) return yield* Effect.fail(previousFailure);
        const current = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
        if (current !== undefined) {
          const record = attachments
            .get(input.threadId)
            ?.registration?.controls.get(current.controlId);
          const state = yield* leases
            .controlState(input.threadId, current.controlId)
            .pipe(Effect.option);
          const terminal = mergeTerminal(
            { reason: terminalReason(record?.terminal, Option.getOrUndefined(state)) },
            {
              reason: terminalReason(
                undefined,
                current.ended === undefined ? undefined : { _tag: "ended", reason: current.ended },
              ),
            },
          ).reason;
          const failure = terminalFailure(terminal, input.tool, input.args);
          if (failure !== undefined) return yield* Effect.fail(failure);
        }
        if (current === undefined || !(yield* active(input.threadId, current.controlId)))
          return yield* Effect.fail(
            terminalFailure(terminalReason(beganEpoch?.reason), input.tool, input.args) ??
              desktopNotReady("none"),
          );
        began ??= current.controlId;
        if (current.controlId !== began)
          return yield* Effect.fail(
            terminalFailure(terminalReason(beganEpoch?.reason), input.tool, input.args) ??
              desktopNotReady("unbound"),
          );
        const value = attachments.get(input.threadId);
        const registered = value?.registration;
        const record =
          registered === undefined ? undefined : control(registered, current.controlId);
        if (beganEpoch === undefined && record !== undefined) {
          beganEpoch = record.epoch;
          retainedKey = waitingKey(input.threadId, current.controlId);
          let waiters = waitingEpochs.get(retainedKey);
          if (waiters === undefined) {
            waiters = new Map();
            waitingEpochs.set(retainedKey, waiters);
          }
          waiters.set(beganEpoch, (waiters.get(beganEpoch) ?? 0) + 1);
        }
        const capturedFailure = terminalFailure(
          terminalReason(beganEpoch?.reason),
          input.tool,
          input.args,
        );
        if (capturedFailure !== undefined) return yield* Effect.fail(capturedFailure);
        const binding = record?.binding;
        if (registered !== undefined && record !== undefined && binding !== undefined) {
          if (deadlineMillis - now < MIN_CALL_MS)
            return yield* Effect.fail(
              terminalFailure(terminalReason(record.terminal), input.tool, input.args) ?? {
                code: "deadline" as const,
                effectStarted: false,
                nextStep: "This cell has too little time left for this call; run it in a new cell.",
              },
            );
          return yield* send(
            input,
            current.controlId,
            registered,
            record,
            binding,
            now,
            deadlineMillis,
          );
        }
        // Only a registered proxy starts drivers; without one nothing will bind.
        if (
          value === undefined ||
          !live(value, now) ||
          registered === undefined ||
          now >= waitUntil
        )
          return yield* Effect.fail(
            terminalFailure(
              mergeTerminal({ reason: record?.terminal }, { reason: beganEpoch?.reason }).reason,
              input.tool,
              input.args,
            ) ?? desktopNotReady("unbound"),
          );
        yield* Deferred.await(changed).pipe(Effect.timeoutOption(waitUntil - now));
        now = yield* Clock.currentTimeMillis;
      }
    }, Effect.scoped),
    reply: Effect.fn("ComputerUsePrimitiveChannel.reply")((input) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const registered = registration(input, now);
          const record = registered?.controls.get(input.reply.controlId);
          const answers = (original: ComputerUsePrimitiveRequest) =>
            original.registrationId === input.reply.registrationId &&
            original.controlId === input.reply.controlId &&
            original.connectionGeneration === input.reply.connectionGeneration &&
            original.runId === input.reply.runId &&
            original.turnId === input.reply.turnId &&
            original.callId === input.reply.callId;
          // A late answer to a call its cell gave up on: the driver is free again.
          const abandoned = record?.abandoned.get(input.reply.requestId);
          if (abandoned !== undefined && record !== undefined)
            return answers(abandoned.request) && record.abandoned.delete(input.reply.requestId);
          const pending = record?.pending.get(input.reply.requestId);
          if (pending === undefined || registered === undefined || record === undefined)
            return false;
          const original = pending.request;
          if (!answers(original)) return false;
          record.pending.delete(original.requestId);
          const replyTerminal = terminalReplyReason(input.reply.result);
          if (replyTerminal !== undefined) latch(record, replyTerminal);
          if (replyTerminal !== undefined && replyTerminal === record.terminal) {
            pending.terminal = mergeTerminal(
              { reason: pending.terminal },
              { reason: replyTerminal },
            ).reason;
            pending.answeredAt = now;
            Deferred.doneUnsafe(pending.answer, Exit.succeed(input.reply));
            return true;
          }
          if (record.terminal !== undefined) {
            settle(pending, record.terminal);
            return true;
          }
          pending.answeredAt = now;
          Deferred.doneUnsafe(pending.answer, Exit.succeed(input.reply));
          return true;
        }),
      ),
    ),
    cancel: Effect.fn("ComputerUsePrimitiveChannel.cancel")((runId, turnId) =>
      Effect.sync(() => {
        for (const value of attachments.values())
          for (const record of value.registration?.controls.values() ?? []) {
            for (const [id, pending] of record.abandoned)
              if (pending.request.runId === runId && pending.request.turnId === turnId) {
                record.abandoned.delete(id);
                if (value.registration) cancelDelivered(value.registration, pending);
              }
            for (const [id, pending] of record.pending)
              if (pending.request.runId === runId && pending.request.turnId === turnId) {
                record.pending.delete(id);
                if (value.registration) cancelDelivered(value.registration, pending);
                settle(pending, record.terminal);
              }
          }
      }),
    ),
  });
});

export const layer = Layer.effect(ComputerUsePrimitiveChannel, make);
