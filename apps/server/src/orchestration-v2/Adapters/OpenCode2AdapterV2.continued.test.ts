import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
  type ProviderReplayEntry,
} from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  CHILD,
  SESSION,
  backgroundLaunch,
  continuationTurn,
  event,
  out,
  providerTurnId,
  reply,
  replyData,
  resumed,
  sessionInfo,
  withLineage,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 continuations", (it) => {
  const continued = (after: ReadonlyArray<ProviderReplayEntry>, external?: string) =>
    Effect.gen(function* () {
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        ...(external === undefined
          ? []
          : [
              event("session.inbox.enqueued", {
                inboxID: external,
                sessionID: SESSION,
                item: { type: "user", payload: { text: "qwe!", files: [] }, delivery: "steer" },
              }),
            ]),
        event("session.inbox.enqueued", {
          inboxID: "msg_report",
          sessionID: SESSION,
          item: {
            type: "synthetic",
            payload: {
              text: CONTINUED_REPORT,
              description: "Sleep",
              metadata: {
                source: "subagent",
                childID: CHILD,
                agent: "General",
                state: "completed",
              },
            },
            delivery: "steer",
          },
        }),
        event("session.execution.started", { sessionID: SESSION }),
        ...(external === undefined
          ? []
          : [event("session.inbox.delivered", { sessionID: SESSION, inboxID: external })]),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report" }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_followup",
          ordinal: 0,
          text: "CHILD_OK",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        ...after,
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.sync(() => void offers.push(request)).pipe(
              Effect.andThen(Deferred.succeed(offered, undefined)),
              Effect.asVoid,
            ),
          take: Effect.never,
        }),
      );
      const turns: Array<OrchestrationV2ProviderTurn> = [];
      const bothEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "provider_turn.updated" && event.providerTurn.status !== "running") {
              turns.push(event.providerTurn);
              if (turns.length === 2) yield* Deferred.succeed(bothEnded, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(offered);
      yield* runtime.startTurn(continuationTurn(thread, offers[0]!));
      yield* Deferred.await(bothEnded);
      const [first, second] = turns;
      return { runtime, thread, first: first!, second: second! };
    });
  const CONTINUED_PROMPT = `msg_t3_turn_${SESSION}:attempt:attempt:opencode2-adapter`;
  const CONTINUED_REPORT = `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\nCHILD_OK\n</subagent>`;
  const continuedHistory = {
    data: [
      { id: "msg_report", time: { created: 2 }, text: CONTINUED_REPORT, type: "synthetic" },
      { id: CONTINUED_PROMPT, time: { created: 1 }, text: "hi", type: "user" },
    ],
    cursor: {},
  };

  it.effect("forks before a continuation's report, so the fork leaves out its answer", () =>
    Effect.gen(function* () {
      const FORK = "ses_f1484db83ffeLGtrRCFimo1H0e";
      const { runtime, thread, first, second } = yield* continued([
        out("message.list", { sessionID: SESSION, limit: "100", type: "user" }),
        reply("message.list", { data: [continuedHistory.data[1]], cursor: {} }),
        out("message.list", { sessionID: SESSION, limit: "100", type: "synthetic" }),
        reply("message.list", {
          data: [
            { id: "msg_later_report", time: { created: 3 }, text: "later", type: "synthetic" },
          ],
          cursor: { next: "synthetic-page-2" },
        }),
        out("message.list", {
          sessionID: SESSION,
          limit: "100",
          type: "synthetic",
          cursor: "synthetic-page-2",
        }),
        reply("message.list", { data: [continuedHistory.data[0]], cursor: {} }),
        out("session.fork", { sessionID: SESSION, before: "msg_report" }),
        replyData("session.fork", sessionInfo({ id: FORK })),
        out("session.update", { sessionID: FORK, permissions: "<any>" }),
        reply("session.update", null),
      ]);
      const forked = yield* runtime.forkThread({
        sourceProviderThread: thread,
        targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
        providerTurnId: first.id,
        sourceProviderTurns: [first, second],
      });
      assert.equal(forked.nativeThreadRef?.nativeId, FORK);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reverts OpenCode at another client's prompt queued before a continuation's report",
    () =>
      Effect.gen(function* () {
        const { runtime, thread, first, second } = yield* continued(
          [
            out("message.list", "<any>"),
            reply("message.list", {
              data: [
                {
                  id: "msg_report",
                  time: { created: 3 },
                  text: CONTINUED_REPORT,
                  type: "synthetic",
                },
                { id: "msg_external", time: { created: 2 }, text: "qwe!", type: "user" },
                { id: CONTINUED_PROMPT, time: { created: 1 }, text: "hi", type: "user" },
              ],
              cursor: {},
            }),
            out("session.revert.stage", {
              sessionID: SESSION,
              messageID: "msg_external",
              files: false,
            }),
            replyData("session.revert.stage", { messageID: "msg_external", files: [] }),
            out("session.revert.commit", { sessionID: SESSION }),
            reply("session.revert.commit", null),
            out("message.list", "<any>"),
            reply("message.list", {
              data: [{ id: CONTINUED_PROMPT, time: { created: 1 }, text: "hi", type: "user" }],
              cursor: {},
            }),
          ],
          "msg_external",
        );
        const snapshot = yield* runtime.rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:first"),
            appRunOrdinal: 1,
            providerTurn: first,
          },
          providerThreadTurns: [first, second],
        });
        assert.deepEqual(
          snapshot.providerTurns.map((turn) => turn.id),
          [first.id],
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "reverts a report's continuation at its report after a Stop dropped another client's prompt",
    () =>
      Effect.gen(function* () {
        const kept = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter`;
        const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
        const reportOffered = yield* Deferred.make<void>();
        const { runtime, thread } = yield* resumed([
          event("session.inbox.enqueued", {
            inboxID: "msg_stale",
            sessionID: SESSION,
            item: { type: "user", payload: { text: "qwe!", files: [] }, delivery: "steer" },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_stale" }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { id: "buffered", providerID: "opencode" },
          }),
          out("session.switchModel", { sessionID: SESSION, model: "<any>" }),
          reply("session.switchModel", null),
          ...backgroundLaunch(CHILD),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: CHILD }),
          event("session.inbox.enqueued", {
            inboxID: "msg_report",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: CONTINUED_REPORT,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: CHILD,
                  agent: "General",
                  state: "completed",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report" }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("message.list", "<any>"),
          reply("message.list", {
            data: [
              { id: "msg_report", time: { created: 3 }, text: CONTINUED_REPORT, type: "synthetic" },
              { id: kept, time: { created: 2 }, text: "hi", type: "user" },
              { id: "msg_stale", time: { created: 1 }, text: "qwe!", type: "user" },
            ],
            cursor: {},
          }),
          out("session.revert.stage", {
            sessionID: SESSION,
            messageID: "msg_report",
            files: false,
          }),
          replyData("session.revert.stage", { messageID: "msg_report", files: [] }),
          out("session.revert.commit", { sessionID: SESSION }),
          reply("session.revert.commit", null),
          out("message.list", "<any>"),
          reply("message.list", {
            data: [
              { id: kept, time: { created: 2 }, text: "hi", type: "user" },
              { id: "msg_stale", time: { created: 1 }, text: "qwe!", type: "user" },
            ],
            cursor: {},
          }),
        ]).pipe(
          Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
            offer: (request) =>
              Effect.sync(() => void offers.push(request)).pipe(
                Effect.andThen(() =>
                  offers.length === 2 ? Deferred.succeed(reportOffered, undefined) : Effect.void,
                ),
                Effect.asVoid,
              ),
            take: Effect.never,
          }),
        );
        const turns: Array<OrchestrationV2ProviderTurn> = [];
        const buffered = yield* Deferred.make<void>();
        const bothEnded = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.nativeMetadata?.modelSelection?.model === "opencode/buffered"
              ) {
                yield* Deferred.succeed(buffered, undefined);
              }
              if (
                event.type === "provider_turn.updated" &&
                event.providerTurn.status !== "running"
              ) {
                turns.push(event.providerTurn);
                if (turns.length === 2) yield* Deferred.succeed(bothEnded, undefined);
              }
            }),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.await(buffered);
        yield* runtime.interruptTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
          requestRuntimeRestart: true,
        });
        yield* runtime.startTurn(withLineage(thread));
        yield* Deferred.await(reportOffered);
        yield* runtime.startTurn(continuationTurn(thread, offers[1]!));
        yield* Deferred.await(bothEnded);
        const [first, continuation] = turns;
        const snapshot = yield* runtime.rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:first"),
            appRunOrdinal: 1,
            providerTurn: first!,
          },
          providerThreadTurns: [first!, continuation!],
        });
        assert.deepEqual(
          snapshot.providerTurns.map((turn) => turn.id),
          [first!.id],
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "reverts a report's continuation at its report after a reconnect lost another client's prompt start",
    () =>
      Effect.gen(function* () {
        const kept = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter`;
        const offered =
          yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
        const { runtime, thread } = yield* resumed([
          event("session.inbox.enqueued", {
            inboxID: "msg_stale",
            sessionID: SESSION,
            item: { type: "user", payload: { text: "qwe!", files: [] }, delivery: "steer" },
          }),
          { type: "runtime_exit", status: "success" } as const,
          out("event.subscribe"),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { id: "buffered", providerID: "opencode" },
          }),
          out("session.switchModel", { sessionID: SESSION, model: "<any>" }),
          reply("session.switchModel", null),
          ...backgroundLaunch(CHILD),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: CHILD }),
          event("session.inbox.enqueued", {
            inboxID: "msg_report",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: CONTINUED_REPORT,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: CHILD,
                  agent: "General",
                  state: "completed",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report" }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("message.list", "<any>"),
          reply("message.list", {
            data: [
              { id: "msg_report", time: { created: 3 }, text: CONTINUED_REPORT, type: "synthetic" },
              { id: kept, time: { created: 2 }, text: "hi", type: "user" },
              { id: "msg_stale", time: { created: 1 }, text: "qwe!", type: "user" },
            ],
            cursor: {},
          }),
          out("session.revert.stage", {
            sessionID: SESSION,
            messageID: "msg_report",
            files: false,
          }),
          replyData("session.revert.stage", { messageID: "msg_report", files: [] }),
          out("session.revert.commit", { sessionID: SESSION }),
          reply("session.revert.commit", null),
          out("message.list", "<any>"),
          reply("message.list", {
            data: [
              { id: kept, time: { created: 2 }, text: "hi", type: "user" },
              { id: "msg_stale", time: { created: 1 }, text: "qwe!", type: "user" },
            ],
            cursor: {},
          }),
        ]).pipe(
          Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
            offer: (request) => Deferred.succeed(offered, request).pipe(Effect.asVoid),
            take: Effect.never,
          }),
        );
        const turns: Array<OrchestrationV2ProviderTurn> = [];
        const reconnected = yield* Deferred.make<void>();
        const bothEnded = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.nativeMetadata?.modelSelection?.model === "opencode/buffered"
              ) {
                yield* Deferred.succeed(reconnected, undefined);
              }
              if (
                event.type === "provider_turn.updated" &&
                event.providerTurn.status !== "running"
              ) {
                turns.push(event.providerTurn);
                if (turns.length === 2) yield* Deferred.succeed(bothEnded, undefined);
              }
            }),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.await(reconnected);
        yield* runtime.startTurn(withLineage(thread));
        yield* runtime.startTurn(continuationTurn(thread, yield* Deferred.await(offered)));
        yield* Deferred.await(bothEnded);
        const [first, continuation] = turns;
        const snapshot = yield* runtime.rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:first"),
            appRunOrdinal: 1,
            providerTurn: first!,
          },
          providerThreadTurns: [first!, continuation!],
        });
        assert.deepEqual(
          snapshot.providerTurns.map((turn) => turn.id),
          [first!.id],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("shows a second prompt another client sent while its continuation was pending", () =>
    Effect.gen(function* () {
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const prompt = (inboxID: string, text: string) =>
        event("session.inbox.enqueued", {
          inboxID,
          sessionID: SESSION,
          item: { type: "user", payload: { text, files: [] }, delivery: "steer" },
        });
      // GOAT's own prompt can be admitted after a failed submit ended its turn.
      const late = `msg_t3_turn_${SESSION}:attempt:late`;
      const { runtime, thread } = yield* resumed([
        prompt(late, "mine"),
        prompt("msg_external_a", "first?"),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: late }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_external_a" }),
        prompt("msg_external_b", "second?"),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_external_b" }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_external_reply",
          ordinal: 0,
          text: "Both!",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        // Handled only after the wake above has buffered everything before it.
        event("session.model.selected", {
          sessionID: SESSION,
          model: { id: "buffered", providerID: "opencode" },
        }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Effect.sync(() => void offers.push(request)),
          take: Effect.never,
        }),
      );
      const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const buffered = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            collected.push(event);
            if (
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeMetadata?.modelSelection?.model === "opencode/buffered"
            ) {
              yield* Deferred.succeed(buffered, undefined);
            }
            if (event.type === "turn.terminal") yield* Deferred.succeed(ended, undefined);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Deferred.await(buffered);
      yield* runtime.startTurn(continuationTurn(thread, offers[0]!));
      yield* Deferred.await(ended);
      assert.deepEqual(
        collected.flatMap((event) =>
          event.type === "turn_item.updated" &&
          (event.turnItem.type === "user_message" || event.turnItem.type === "assistant_message")
            ? [`${event.turnItem.type}: ${event.turnItem.text}`]
            : [],
        ),
        ["user_message: first?", "user_message: second?", "assistant_message: Both!"],
      );
      assert.deepEqual(
        [
          ...new Set(
            collected.flatMap((event) =>
              event.type === "message.updated"
                ? [`${event.message.role}: ${event.message.text}`]
                : [],
            ),
          ),
        ],
        ["user: first?", "user: second?", "assistant: Both!"],
      );
    }).pipe(Effect.scoped),
  );
});
