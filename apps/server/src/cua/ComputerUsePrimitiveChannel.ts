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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const desktopNotReady = (): ScreenRunError => ({
  code: "unavailable",
  reason: "desktop_not_ready",
  effectStarted: false,
  nextStep: "Wait for desktop control to reconnect, then observe again.",
});

interface Pending {
  readonly request: ComputerUsePrimitiveRequest;
  readonly answer: Deferred.Deferred<ComputerUsePrimitiveReply>;
  sent: boolean;
}

interface Control {
  maxAcceptedGeneration: number;
  maxCutoffGeneration: number;
  binding: { readonly connectionId: string; readonly generation: number } | undefined;
  readonly pending: Map<string, Pending>;
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
  readonly args: ComputerUsePrimitiveRequest["args"];
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
    readonly reportControlCutoff: (input: Report) => Effect.Effect<boolean>;
    readonly request: (
      input: PrimitiveChannelRequest,
    ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
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
  const threadTokens = new Map<ThreadId, string>();
  const settle = (pending: Pending) =>
    Deferred.doneUnsafe(
      pending.answer,
      Exit.succeed({
        ...pending.request,
        status: pending.sent ? "unknown_outcome" : "not_started",
      }),
    );
  const cancelDelivered = (registration: Registration, pending: Pending) => {
    if (pending.sent)
      Queue.offerUnsafe(registration.cancellations, {
        state: "primitive-cancel",
        requestId: pending.request.requestId,
      });
  };
  const clear = (registration: Registration, control: Control) => {
    control.binding = undefined;
    for (const [id, pending] of control.pending) {
      control.pending.delete(id);
      cancelDelivered(registration, pending);
      settle(pending);
    }
  };
  const close = (attachment: Attachment) => {
    const registration = attachment.registration;
    if (registration === undefined) return;
    attachment.registration = undefined;
    for (const control of registration.controls.values()) {
      control.binding = undefined;
      for (const pending of control.pending.values()) {
        cancelDelivered(registration, pending);
        settle(pending);
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
  const attachment = (input: Authority, now: number) => {
    const value = attachments.get(input.threadId);
    return value?.generation === input.attachmentGeneration &&
      value.expiresAt > now &&
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
        maxAcceptedGeneration: -1,
        maxCutoffGeneration: -1,
        binding: undefined,
        pending: new Map(),
      };
      value.controls.set(controlId, record);
    }
    return record;
  };
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
            : { _tag: "ended" as const };
        if (state._tag !== "ended" && !(state._tag === "active" && state.idle === true)) continue;
        const record = registered?.controls.get(current.controlId);
        if (registered?.kind === "thread" && keepsRegistration(state)) {
          if (record !== undefined) clear(registered, record);
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
            settle(pending);
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
            value.expiresAt > now &&
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
        record.maxAcceptedGeneration = input.driverGeneration;
        record.binding = { connectionId: input.connectionId, generation: input.driverGeneration };
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
        record.maxCutoffGeneration = input.driverGeneration;
        if (record.binding !== undefined && record.binding.generation <= input.driverGeneration)
          clear(registered, record);
        return true;
      },
    ),
    request: Effect.fn("ComputerUsePrimitiveChannel.request")(function* (input) {
      const current = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
      if (current === undefined || !(yield* active(input.threadId, current.controlId)))
        return yield* Effect.fail(desktopNotReady());
      const now = yield* Clock.currentTimeMillis;
      const value = attachments.get(input.threadId);
      const registered = value?.registration;
      const record = registered?.controls.get(current.controlId);
      const binding = record?.binding;
      if (
        value === undefined ||
        value.expiresAt <= now ||
        registered === undefined ||
        record === undefined ||
        binding === undefined
      )
        return yield* Effect.fail(desktopNotReady());
      if (
        input.expectedConnectionGeneration !== undefined &&
        input.expectedConnectionGeneration !== binding.connectionId
      )
        return yield* Effect.fail({
          code: "stale_reference" as const,
          effectStarted: false,
          nextStep: "Bind the desktop app again after the driver reconnects.",
        });
      const answer = yield* Deferred.make<ComputerUsePrimitiveReply>();
      const request: ComputerUsePrimitiveRequest = {
        state: "primitive-request",
        requestId: NodeCrypto.randomUUID(),
        registrationId: registered.id,
        controlId: current.controlId,
        connectionGeneration: binding.connectionId,
        runId: input.runId,
        turnId: input.turnId,
        callId: input.callId,
        deadlineMillis: input.deadlineMillis,
        tool: input.tool,
        args: input.args,
      };
      const pending: Pending = { request, answer, sent: false };
      record.pending.set(request.requestId, pending);
      const offered = yield* Queue.offer(registered.queue, request);
      if (!offered) {
        record.pending.delete(request.requestId);
        return yield* Effect.fail(desktopNotReady());
      }
      return yield* Deferred.await(answer).pipe(
        Effect.timeoutOrElse({
          duration: Math.max(0, input.deadlineMillis - now),
          orElse: () =>
            Effect.fail({
              code: "deadline" as const,
              effectStarted: pending.sent,
              nextStep: "Observe the desktop before any later action.",
            }),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (record.pending.has(request.requestId)) cancelDelivered(registered, pending);
            record.pending.delete(request.requestId);
          }),
        ),
      );
    }),
    reply: Effect.fn("ComputerUsePrimitiveChannel.reply")((input) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const registered = registration(input, now);
          const record = registered?.controls.get(input.reply.controlId);
          const pending = record?.pending.get(input.reply.requestId);
          if (pending === undefined || registered === undefined || record === undefined)
            return false;
          const original = pending.request;
          if (
            original.registrationId !== input.reply.registrationId ||
            original.controlId !== input.reply.controlId ||
            original.connectionGeneration !== input.reply.connectionGeneration ||
            original.runId !== input.reply.runId ||
            original.turnId !== input.reply.turnId ||
            original.callId !== input.reply.callId
          )
            return false;
          record.pending.delete(original.requestId);
          Deferred.doneUnsafe(pending.answer, Exit.succeed(input.reply));
          return true;
        }),
      ),
    ),
    cancel: Effect.fn("ComputerUsePrimitiveChannel.cancel")((runId, turnId) =>
      Effect.sync(() => {
        for (const value of attachments.values())
          for (const record of value.registration?.controls.values() ?? [])
            for (const [id, pending] of record.pending)
              if (pending.request.runId === runId && pending.request.turnId === turnId) {
                record.pending.delete(id);
                if (value.registration) cancelDelivered(value.registration, pending);
                settle(pending);
              }
      }),
    ),
  });
});

export const layer = Layer.effect(ComputerUsePrimitiveChannel, make);
