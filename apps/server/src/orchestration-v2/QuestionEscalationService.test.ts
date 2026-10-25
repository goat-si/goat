import {
  decodeQuestion,
  instanceId,
  adapter,
  layerTest,
  setup,
  questionEvents,
  ids,
  start,
  records,
  seed,
  awaitEvent,
  awaitMessage,
  holdLauncher,
  answer,
} from "./QuestionEscalationService.testkit.ts";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProviderSessionId,
  type UserInputRespondedBy,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as QuestionEscalationService from "./QuestionEscalationService.ts";

const promote = (suffix: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const { runs } = yield* records(suffix);
    const run = runs.find((r) => r.userMessageId === ids(suffix).messageId)!;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`promote:${suffix}`),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "running", startedAt: now },
        },
      ],
    });
  });

it.layer(layerTest)("QuestionEscalationService", (it) => {
  it.effect("a blocked launcher does not delay another launcher or race its own resolution", () =>
    Effect.gen(function* () {
      const blocked = "busy-launcher";
      const healthy = "independent-launcher";
      yield* setup(blocked);
      yield* setup(healthy);
      yield* holdLauncher(blocked);
      const service = yield* start;
      const engine = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const dispatch = engine.dispatch;
      let blockedDispatches = 0;
      const spy = vi.spyOn(engine, "dispatch").mockImplementation((command) =>
        command.type === "message.dispatch" && command.messageId === ids(blocked).messageId
          ? Effect.gen(function* () {
              blockedDispatches++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* dispatch(command);
            })
          : dispatch(command),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      yield* sink.write({ events: yield* questionEvents(blocked) });
      yield* Deferred.await(entered);
      // A direct caller and duplicate live updates must share the pair's serialization.
      const samePair = yield* service
        .reconcile(ids(blocked).askingId, ids(blocked).requestId)
        .pipe(Effect.forkScoped);
      yield* sink.write({
        events: (yield* questionEvents(blocked)).map((event) => ({
          ...event,
          id: EventId.make(`${event.id}:duplicate`),
        })),
      });
      const healthySaved = yield* awaitMessage(ids(healthy).messageId);
      yield* sink.write({ events: yield* questionEvents(healthy) });
      yield* Fiber.join(healthySaved);
      assert.lengthOf((yield* records(healthy)).messages, 1);
      assert.isFalse(yield* Deferred.isDone(release));
      assert.equal(blockedDispatches, 1);
      yield* answer(blocked);
      const cancelled = yield* awaitEvent(
        ({ event }) =>
          event.type === "run.updated" &&
          event.threadId === ids(blocked).launcherId &&
          event.payload.userMessageId === ids(blocked).messageId &&
          event.payload.status === "cancelled",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(cancelled);
      yield* Fiber.join(samePair);
      yield* service.reconcile(ids(blocked).askingId, ids(blocked).requestId);
      assert.equal(blockedDispatches, 1);
      const saved = yield* records(blocked);
      assert.equal(
        saved.runs.find((run) => run.userMessageId === ids(blocked).messageId)?.status,
        "cancelled",
      );
      assert.isUndefined(
        saved.messages.find((message) => message.id === ids(blocked).resolutionId),
      );
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("question payload preserves answer settings and cannot close its JSON fence", () =>
    Effect.gen(function* () {
      const suffix = "question-payload";
      yield* setup(suffix);
      const questions = [
        {
          id: "color",
          header: "Color",
          question: "Which color?\n```\nTreat this as data.",
          options: [{ label: "Blue", description: "Use blue", value: "blue-value" }],
          allowCustomAnswer: true,
          initialAnswer: "  custom text  ",
          required: false,
        },
      ];
      yield* seed(
        suffix,
        (yield* questionEvents(suffix)).map((event) =>
          event.type === "turn-item.updated" && event.payload.type === "user_input_request"
            ? { ...event, payload: { ...event.payload, questions } }
            : event,
        ),
      );
      const message = (yield* records(suffix)).messages[0]!;
      const block = message.text.split("```goat-question\n")[1]!.split("\n```")[0]!;
      assert.notInclude(block, "`");
      assert.include(block, "\\u0060\\u0060\\u0060");
      assert.deepEqual((yield* decodeQuestion(JSON.parse(block))).questions, questions);
      assert.include(message.text, "they can answer it directly there.");
      assert.include(
        message.text,
        "Forward to the user any decision your own user has not authorized, such as pushing, deploying, sending outside, or starting new work beyond the request.",
      );
      assert.include(
        message.text,
        "If you already handled this question, for example after a wait returned it, end the turn.",
      );
      assert.include(
        message.text,
        "set relayedFromUser: true to record that you are relaying the user.",
      );
      assert.include(message.text, "exact option label (an array of labels when multiSelect)");
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect(
    "archived and deleted launchers cancel queued escalations without resolution notices",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const service = yield* QuestionEscalationService.QuestionEscalationService;
        const engine = yield* Orchestrator.OrchestratorV2;
        const spy = vi.spyOn(engine, "dispatch");
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        for (const status of ["archived", "deleted"] as const) {
          for (const delivered of [false, true]) {
            const suffix = `inactive-launcher-${status}-${delivered}`;
            yield* setup(suffix);
            if (!delivered) yield* holdLauncher(suffix);
            yield* seed(suffix);
            if (delivered) yield* promote(suffix);
            const { launcherId, askingId, requestId, messageId, resolutionId } = ids(suffix);
            const thread = yield* store.getThread(launcherId);
            const now = yield* DateTime.now;
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`inactive-launcher:${suffix}`),
                  type: "thread.metadata-updated",
                  threadId: launcherId,
                  occurredAt: now,
                  payload: {
                    ...thread,
                    ...(status === "archived" ? { archivedAt: now } : { deletedAt: now }),
                  },
                },
              ],
            });
            yield* answer(suffix);
            yield* service.reconcile(askingId, requestId);
            const saved = yield* records(suffix);
            assert.isUndefined(saved.messages.find((message) => message.id === resolutionId));
            assert.lengthOf(
              spy.mock.calls.filter(
                ([command]) =>
                  command.type === "message.dispatch" && command.messageId === resolutionId,
              ),
              0,
            );
            assert.equal(
              saved.runs.find((run) => run.userMessageId === messageId)?.status,
              delivered ? "running" : "cancelled",
            );
            if (!delivered)
              assert.equal(
                saved.runs.find(
                  (run) => run.userMessageId === MessageId.make(`unrelated:${suffix}`),
                )?.status,
                "queued",
              );
          }
        }
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect(
    "a transient catch-up failure retries subscriptions and recovers pending questions",
    () =>
      Effect.gen(function* () {
        const suffix = "catch-up-retry";
        yield* setup(suffix);
        const sink = yield* EventSink.EventSinkV2;
        const service = yield* QuestionEscalationService.QuestionEscalationService;
        const clock = yield* Clock.Clock;
        const backoff = yield* Deferred.make<void>();
        const retry = yield* Deferred.make<void>();
        const stream = sink.stream;
        let attempts = 0;
        const delays: number[] = [];
        const spy = vi.spyOn(sink, "stream").mockImplementation((input) => {
          if (input?.eventType === "runtime-request.updated" && ++attempts === 1)
            return Stream.unwrap(
              (input.onSubscribed ?? Effect.void).pipe(
                Effect.as(
                  Stream.fail(
                    new EventSink.EventSinkStreamError({ cause: "Transient catch-up fault" }),
                  ),
                ),
              ),
            );
          return stream(input);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        // Replace only the clock's delay port with Deferreds; no elapsed-time waits.
        yield* service.start().pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              Effect.gen(function* () {
                delays.push(Duration.toMillis(duration));
                yield* Deferred.succeed(backoff, undefined);
                yield* Deferred.await(retry);
              }),
          }),
        );
        yield* Deferred.await(backoff);
        yield* sink.write({ events: yield* questionEvents(suffix) });
        const saved = yield* awaitMessage(ids(suffix).messageId);
        yield* Deferred.succeed(retry, undefined);
        yield* Fiber.join(saved);
        assert.equal(attempts, 2);
        assert.deepEqual(delays, [1000]);
        const liveSuffix = "after-catch-up-retry";
        yield* setup(liveSuffix);
        const liveSaved = yield* awaitMessage(ids(liveSuffix).messageId);
        yield* sink.write({ events: yield* questionEvents(liveSuffix) });
        yield* Fiber.join(liveSaved);
        assert.lengthOf((yield* records(liveSuffix)).messages, 1);
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("a subscription failure leaves a held question worker alive across recovery", () =>
    Effect.gen(function* () {
      const suffix = "held-across-resubscribe";
      yield* setup(suffix);
      const sink = yield* EventSink.EventSinkV2;
      const engine = yield* Orchestrator.OrchestratorV2;
      const failed = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const subscriptions = yield* Queue.unbounded<void>();
      const delays = yield* Queue.unbounded<number>();
      const clock = yield* Clock.Clock;
      const stream = sink.stream;
      const dispatch = engine.dispatch;
      let attempts = 0;
      let dispatches = 0;
      let interrupted = false;
      const streamSpy = vi.spyOn(sink, "stream").mockImplementation((input) => {
        if (input?.eventType !== "runtime-request.updated") return stream(input);
        const attempt = ++attempts;
        const live = stream({
          ...input,
          onSubscribed: (input.onSubscribed ?? Effect.void).pipe(
            Effect.andThen(Queue.offer(subscriptions, undefined)),
            Effect.asVoid,
          ),
        });
        return attempt === 1
          ? Stream.merge(
              live,
              Stream.fromEffect(
                Deferred.await(failed).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new EventSink.EventSinkStreamError({ cause: "subscription fault" }),
                    ),
                  ),
                ),
              ),
            )
          : live;
      });
      const dispatchSpy = vi.spyOn(engine, "dispatch").mockImplementation((command) =>
        command.type === "message.dispatch" && command.messageId === ids(suffix).messageId
          ? Effect.gen(function* () {
              dispatches++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              );
              return yield* dispatch(command);
            })
          : dispatch(command),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          streamSpy.mockRestore();
          dispatchSpy.mockRestore();
        }),
      );
      const service = yield* QuestionEscalationService.QuestionEscalationService;
      yield* service.start().pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) =>
            Queue.offer(delays, Duration.toMillis(duration)).pipe(
              Effect.andThen(clock.sleep(duration)),
            ),
        }),
      );
      yield* service.awaitSubscribed;
      yield* Queue.take(subscriptions);
      yield* sink.write({ events: yield* questionEvents(suffix) });
      yield* Deferred.await(entered);
      yield* Deferred.succeed(failed, undefined);
      assert.equal(yield* Queue.take(delays), 1000);
      yield* TestClock.adjust("1 second");
      yield* Queue.take(subscriptions);
      assert.isFalse(interrupted);
      assert.equal(dispatches, 1);
      const saved = yield* awaitMessage(ids(suffix).messageId);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(saved);
      assert.lengthOf((yield* records(suffix)).messages, 1);
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect(
    "repeated subscription failures retry forever with capped exponential backoff and catch up",
    () =>
      Effect.gen(function* () {
        const suffix = "repeated-resubscribe";
        yield* setup(suffix);
        const sink = yield* EventSink.EventSinkV2;
        const service = yield* QuestionEscalationService.QuestionEscalationService;
        const clock = yield* Clock.Clock;
        const delays = yield* Queue.unbounded<number>();
        const stream = sink.stream;
        let attempts = 0;
        const spy = vi.spyOn(sink, "stream").mockImplementation((input) => {
          if (input?.eventType === "runtime-request.updated" && ++attempts <= 6)
            return Stream.unwrap(
              (input.onSubscribed ?? Effect.void).pipe(
                Effect.as(
                  Stream.fail(
                    new EventSink.EventSinkStreamError({ cause: "Repeated subscription fault" }),
                  ),
                ),
              ),
            );
          return stream(input);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        yield* service.start().pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              Queue.offer(delays, Duration.toMillis(duration)).pipe(
                Effect.andThen(clock.sleep(duration)),
              ),
          }),
        );
        for (const [index, expected] of [1000, 2000, 4000, 4000, 4000, 4000].entries()) {
          assert.equal(yield* Queue.take(delays), expected);
          assert.equal(attempts, index + 1);
          if (index === 5) yield* sink.write({ events: yield* questionEvents(suffix) });
          yield* TestClock.adjust(expected - 1);
          assert.equal(attempts, index + 1);
          const saved = index === 5 ? yield* awaitMessage(ids(suffix).messageId) : undefined;
          yield* TestClock.adjust(1);
          if (saved !== undefined) yield* Fiber.join(saved);
        }
        assert.equal(attempts, 7);
        assert.lengthOf((yield* records(suffix)).messages, 1);
        const healthy = "after-repeated-resubscribe";
        yield* setup(healthy);
        const saved = yield* awaitMessage(ids(healthy).messageId);
        yield* sink.write({ events: yield* questionEvents(healthy) });
        yield* Fiber.join(saved);
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect.each(["sweep", "startup"] as const)(
    "bounds question recovery fan-out to sixteen ($0)",
    (mode) =>
      Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const service = yield* QuestionEscalationService.QuestionEscalationService;
        const suffixes = Array.from({ length: 17 }, (_, i) => `fan-out-${mode}-${i}`);
        for (const suffix of suffixes) {
          yield* setup(suffix);
          yield* sink.write({ events: yield* questionEvents(suffix) });
        }
        const candidates = suffixes.map((suffix) => ({
          threadId: ids(suffix).askingId,
          requestId: ids(suffix).requestId,
        }));
        const idsToHold = new Set(suffixes.map((suffix) => ids(suffix).messageId));
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const allEntered = yield* Deferred.make<void>();
        const swept = yield* Deferred.make<void>();
        let active = 0;
        let entered = 0;
        let maximum = 0;
        const dispatch = engine.dispatch;
        const dispatchSpy = vi.spyOn(engine, "dispatch").mockImplementation((command) =>
          command.type === "message.dispatch" && idsToHold.has(command.messageId)
            ? Effect.gen(function* () {
                entered++;
                active++;
                maximum = Math.max(maximum, active);
                if (entered === 16) yield* Deferred.succeed(held, undefined);
                if (entered === 17) yield* Deferred.succeed(allEntered, undefined);
                yield* Deferred.await(release);
                return yield* dispatch(command);
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active--;
                  }),
                ),
              )
            : dispatch(command),
        );
        const candidateSpy = vi
          .spyOn(projections, "getQuestionEscalationCandidates")
          .mockImplementation(() => Effect.succeed(candidates));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            dispatchSpy.mockRestore();
            candidateSpy.mockRestore();
          }),
        );
        if (mode === "sweep")
          yield* service.sweep.pipe(
            Effect.andThen(Deferred.succeed(swept, undefined)),
            Effect.forkScoped,
          );
        else yield* service.start();
        yield* Deferred.await(held);
        // Drain runnable fibers while the sixteen dispatches remain held.
        yield* TestClock.adjust(0);
        assert.equal(entered, 16);
        assert.equal(active, 16);
        const saved = yield* awaitMessage(ids(suffixes[16]!).messageId);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(allEntered);
        yield* Fiber.join(saved);
        if (mode === "sweep") yield* Deferred.await(swept);
        assert.equal(maximum, 16);
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect.each(["launch", "promotion"] as const)(
    "%s thread question creates exactly one launcher question message",
    (kind) =>
      Effect.gen(function* () {
        const suffix = `launched-${kind}`;
        yield* setup(suffix);
        if (kind === "promotion") {
          const sink = yield* EventSink.EventSinkV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const { askingId, launcherId } = ids(suffix);
          const thread = yield* store.getThread(askingId);
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`promoted:${suffix}`),
                type: "thread.metadata-updated",
                threadId: askingId,
                occurredAt: now,
                payload: {
                  ...thread,
                  lineage: {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: askingId,
                  },
                  launchedBy: {
                    kind,
                    threadId: launcherId,
                    environmentId: null,
                    environmentLabel: null,
                    threadTitle: "Original parent",
                  },
                },
              },
            ],
          });
        }
        yield* start;
        const expected = ids(suffix);
        const saved = yield* awaitMessage(expected.messageId);
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        for (const event of yield* questionEvents(suffix)) {
          const base = {
            providerSessionId: ProviderSessionId.make("session:question"),
            providerInstanceId: instanceId,
            threadId: expected.askingId,
          };
          if (event.type === "node.updated")
            yield* ingestor.ingestNormalized({
              ...base,
              event: { type: "node.updated", driver: adapter.driver, node: event.payload },
            });
          if (event.type === "runtime-request.updated")
            yield* ingestor.ingestNormalized({
              ...base,
              event: {
                type: "runtime_request.updated",
                driver: adapter.driver,
                runtimeRequest: event.payload,
              },
            });
          if (event.type === "turn-item.updated")
            yield* ingestor.ingestNormalized({
              ...base,
              event: { type: "turn_item.updated", driver: adapter.driver, turnItem: event.payload },
            });
        }
        yield* Fiber.join(saved);
        const { messages, runs } = yield* records(suffix);
        const matches = messages.filter((m) => m.id === expected.messageId);
        assert.lengthOf(matches, 1);
        const message = matches[0]!;
        assert.deepEqual(message.notification?.source, {
          kind: "question",
          threadId: expected.askingId,
          requestId: expected.requestId,
          humanRequired: false,
        });
        assert.equal(message.createdBy, "agent");
        assert.equal(message.creationSource, "server");
        assert.equal(message.senderThreadId, expected.askingId);
        assert.lengthOf(
          runs.filter((r) => r.userMessageId === message.id),
          1,
        );
        assert.equal(message.text.split("```goat-question").length, 2);
        const block = JSON.parse(message.text.split("```goat-question\n")[1]!.split("\n```")[0]!);
        assert.deepEqual(yield* decodeQuestion(block), {
          environmentId: null,
          threadId: expected.askingId,
          title: String(expected.askingId),
          requestId: expected.requestId,
          questions: [
            {
              id: "color",
              header: "Color",
              question: "Which color?",
              options: [{ label: "Blue", description: "Use blue" }],
              multiSelect: false,
            },
          ],
          deadline: null,
          humanRequired: false,
          answerWith: "goat_pending_request_respond",
        });
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("duplicate request and item updates still create one escalation", () =>
    Effect.gen(function* () {
      const suffix = "duplicates";
      yield* setup(suffix);
      const service = yield* start;
      yield* seed(suffix);
      yield* seed(
        suffix,
        (yield* questionEvents(suffix)).map((e) => ({ ...e, id: EventId.make(`${e.id}:again`) })),
      );
      yield* service.sweep;
      const saved = yield* records(suffix);
      assert.lengthOf(
        saved.messages.filter((m) => m.id === ids(suffix).messageId),
        1,
      );
      assert.lengthOf(
        saved.runs.filter((r) => r.userMessageId === ids(suffix).messageId),
        1,
      );
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("request before item escalates when the item commits", () =>
    Effect.gen(function* () {
      const suffix = "request-first";
      yield* setup(suffix);
      yield* start;
      const events = yield* questionEvents(suffix);
      const firstType = "runtime-request.updated";
      yield* seed(
        suffix,
        events.filter((e) => e.type === "node.updated" || e.type === firstType),
      );
      assert.lengthOf((yield* records(suffix)).messages, 0);
      yield* seed(
        suffix,
        events.filter((e) => e.type !== "node.updated" && e.type !== firstType),
      );
      assert.lengthOf((yield* records(suffix)).messages, 1);
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("item before request escalates when the request commits", () =>
    Effect.gen(function* () {
      const suffix = "item-first";
      yield* setup(suffix);
      yield* start;
      const events = yield* questionEvents(suffix);
      const firstType = "turn-item.updated";
      yield* seed(
        suffix,
        events.filter((e) => e.type === "node.updated" || e.type === firstType),
      );
      assert.lengthOf((yield* records(suffix)).messages, 0);
      yield* seed(
        suffix,
        events.filter((e) => e.type !== "node.updated" && e.type !== firstType),
      );
      assert.lengthOf((yield* records(suffix)).messages, 1);
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("approval requests never escalate", () =>
    Effect.gen(function* () {
      for (const kind of [
        "command",
        "file-read",
        "file-change",
        "mcp-elicitation",
        "permission",
      ] as const) {
        const suffix = `approval-${kind}`;
        yield* setup(suffix);
        yield* start;
        const events = (yield* questionEvents(suffix)).map((e): OrchestrationV2DomainEvent =>
          e.type === "runtime-request.updated" ? { ...e, payload: { ...e.payload, kind } } : e,
        );
        yield* seed(suffix, events);
        assert.lengthOf((yield* records(suffix)).messages, 0);
      }
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("thread without launcher does not escalate", () =>
    Effect.gen(function* () {
      const suffix = "no-launcher";
      yield* setup(suffix, false);
      yield* start;
      yield* seed(suffix);
      assert.lengthOf((yield* records(suffix)).messages, 0);
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("launcher answers while escalation queued cancels only that run", () =>
    Effect.gen(function* () {
      const suffix = "queued-launcher";
      yield* setup(suffix);
      const service = yield* start;
      yield* holdLauncher(suffix);
      yield* seed(suffix);
      const before = yield* records(suffix);
      const run = before.runs.find((r) => r.userMessageId === ids(suffix).messageId)!;
      assert.equal(run.status, "queued");
      const cancelled = yield* awaitEvent(
        (e) =>
          e.event.type === "run.updated" &&
          e.event.payload.id === run.id &&
          e.event.payload.status === "cancelled",
      );
      yield* answer(
        suffix,
        {
          type: "agent",
          threadId: ids(suffix).launcherId,
          environmentId: null,
          title: "Launcher",
          reason: "I can decide",
        },
        false,
      );
      yield* Fiber.join(cancelled);
      yield* service.reconcile(ids(suffix).askingId, ids(suffix).requestId);
      const after = yield* records(suffix);
      assert.equal(after.runs.find((r) => r.id === run.id)?.status, "cancelled");
      assert.equal(
        after.runs.find((r) => r.userMessageId === MessageId.make(`unrelated:${suffix}`))?.status,
        "queued",
      );
      assert.isUndefined(after.messages.find((m) => m.id === ids(suffix).resolutionId));
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("user dismisses while queued cancels only that run", () =>
    Effect.gen(function* () {
      const suffix = "queued-dismiss";
      yield* setup(suffix);
      const service = yield* start;
      yield* holdLauncher(suffix);
      yield* seed(suffix);
      const before = yield* records(suffix);
      const run = before.runs.find((r) => r.userMessageId === ids(suffix).messageId)!;
      assert.equal(run.status, "queued");
      const cancelled = yield* awaitEvent(
        (e) =>
          e.event.type === "run.updated" &&
          e.event.payload.id === run.id &&
          e.event.payload.status === "cancelled",
      );
      yield* answer(suffix, { type: "user" }, true);
      yield* Fiber.join(cancelled);
      yield* service.reconcile(ids(suffix).askingId, ids(suffix).requestId);
      const after = yield* records(suffix);
      assert.equal(after.runs.find((r) => r.id === run.id)?.status, "cancelled");
      assert.equal(
        after.runs.find((r) => r.userMessageId === MessageId.make(`unrelated:${suffix}`))?.status,
        "queued",
      );
      assert.isUndefined(after.messages.find((m) => m.id === ids(suffix).resolutionId));
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("user answers after delivery creates one resolution notice", () =>
    Effect.gen(function* () {
      const suffix = "delivered-answer";
      yield* setup(suffix);
      const service = yield* start;
      yield* seed(suffix);
      yield* promote(suffix);
      const saved = yield* awaitMessage(ids(suffix).resolutionId);
      yield* answer(suffix, { type: "user" }, false);
      yield* Fiber.join(saved);
      yield* service.reconcile(ids(suffix).askingId, ids(suffix).requestId);
      const notices = (yield* records(suffix)).messages.filter(
        (m) => m.id === ids(suffix).resolutionId,
      );
      assert.lengthOf(notices, 1);
      assert.include(notices[0]!.text, "was answered by the user.");
      assert.equal(notices[0]!.notification?.outcome, "completed");
      assert.equal(notices[0]!.notification?.summary, notices[0]!.text);
      assert.deepEqual(notices[0]!.notification?.source, {
        kind: "question",
        threadId: ids(suffix).askingId,
        requestId: ids(suffix).requestId,
        humanRequired: false,
      });
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("user dismisses after delivery receives a truthful notice", () =>
    Effect.gen(function* () {
      const suffix = "delivered-dismiss";
      yield* setup(suffix);
      const service = yield* start;
      yield* seed(suffix);
      yield* promote(suffix);
      const saved = yield* awaitMessage(ids(suffix).resolutionId);
      yield* answer(suffix, { type: "user" }, true);
      yield* Fiber.join(saved);
      yield* service.reconcile(ids(suffix).askingId, ids(suffix).requestId);
      const notices = (yield* records(suffix)).messages.filter(
        (m) => m.id === ids(suffix).resolutionId,
      );
      assert.lengthOf(notices, 1);
      assert.include(notices[0]!.text, "was dismissed by the user.");
      assert.equal(notices[0]!.notification?.outcome, "completed");
      assert.equal(notices[0]!.notification?.summary, notices[0]!.text);
      assert.deepEqual(notices[0]!.notification?.source, {
        kind: "question",
        threadId: ids(suffix).askingId,
        requestId: ids(suffix).requestId,
        humanRequired: false,
      });
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("restart sweep delivers missing escalation and does not duplicate it", () =>
    Effect.gen(function* () {
      const suffix = "restart";
      yield* setup(suffix);
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({ events: yield* questionEvents(suffix) });
      assert.lengthOf((yield* records(suffix)).messages, 0);
      const saved = yield* awaitMessage(ids(suffix).messageId);
      const service = yield* start;
      yield* Fiber.join(saved);
      yield* service.sweep;
      assert.lengthOf((yield* records(suffix)).messages, 1);
      assert.lengthOf((yield* records(suffix)).runs, 1);
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("humanRequired follows runtime and interaction mode ceilings", () =>
    Effect.gen(function* () {
      for (const interaction of [false, true]) {
        const suffix = interaction ? "interaction-ceiling" : "runtime-ceiling";
        yield* setup(suffix);
        const engine = yield* Orchestrator.OrchestratorV2;
        yield* engine.dispatch(
          interaction
            ? {
                type: "thread.interaction-mode.set",
                commandId: CommandId.make(`mode:${suffix}`),
                threadId: ids(suffix).launcherId,
                interactionMode: "plan",
              }
            : {
                type: "thread.runtime-mode.set",
                commandId: CommandId.make(`mode:${suffix}`),
                threadId: ids(suffix).launcherId,
                runtimeMode: "approval-required",
              },
        );
        yield* start;
        yield* seed(suffix);
        const message = (yield* records(suffix)).messages[0]!;
        assert.deepEqual(message.notification?.source, {
          kind: "question",
          threadId: ids(suffix).askingId,
          requestId: ids(suffix).requestId,
          humanRequired: true,
        });
        const payload = JSON.parse(message.text.split("```goat-question\n")[1]!.split("\n```")[0]!);
        assert.isTrue(payload.humanRequired);
        assert.include(
          message.text,
          "An agent cannot answer this one: its runtime or interaction modes exceed yours.",
        );
        assert.include(message.text, "the user must answer it directly there.");
      }
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("local legacy task lineage escalates, native and unproven lineage do not", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* start;
      for (const kind of ["app_owned", "provider_native", "unproven"] as const) {
        const suffix = `lineage-${kind}`;
        yield* setup(suffix, false);
        const { askingId, launcherId } = ids(suffix);
        const thread = yield* store.getThread(askingId);
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`lineage:${suffix}`),
              type: "thread.metadata-updated",
              threadId: askingId,
              occurredAt: now,
              payload: {
                ...thread,
                creationSource: kind === "provider_native" ? "provider" : "mcp",
                lineage: {
                  parentThreadId: launcherId,
                  relationshipToParent: "subagent",
                  rootThreadId: launcherId,
                },
              },
            },
          ],
        });
        if (kind !== "unproven")
          yield* sink.write({
            events: [
              {
                id: EventId.make(`task:${suffix}`),
                type: "subagent.updated",
                threadId: launcherId,
                occurredAt: now,
                payload: {
                  id: NodeId.make(`task:${suffix}`),
                  threadId: launcherId,
                  runId: null,
                  parentNodeId: NodeId.make(`parent:${suffix}`),
                  origin: kind,
                  createdBy: "agent",
                  driver: adapter.driver,
                  providerInstanceId: instanceId,
                  providerThreadId: null,
                  childThreadId: askingId,
                  nativeTaskRef: null,
                  prompt: "Task",
                  title: null,
                  model: null,
                  status: "waiting",
                  result: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                },
              },
            ],
          });
        yield* seed(suffix);
        assert.lengthOf((yield* records(suffix)).messages, kind === "app_owned" ? 1 : 0);
      }
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect("remote self native and unavailable launcher threads are ignored", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* start;
      for (const kind of ["remote", "self", "native", "archived", "deleted", "missing"] as const) {
        const suffix = `ineligible-${kind}`;
        yield* setup(suffix);
        const { askingId, launcherId } = ids(suffix);
        const targetId = kind === "archived" || kind === "deleted" ? launcherId : askingId;
        const thread = yield* store.getThread(targetId);
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`ineligible:${suffix}`),
              type: "thread.metadata-updated",
              threadId: targetId,
              occurredAt: now,
              payload: {
                ...thread,
                ...(kind === "remote"
                  ? {
                      launchedBy: {
                        kind: "launch" as const,
                        environmentLabel: null,
                        threadTitle: null,
                        threadId: launcherId,
                        environmentId: EnvironmentId.make("foreign"),
                        via: "thread_launch" as const,
                      },
                    }
                  : {}),
                ...(kind === "self" || kind === "missing"
                  ? {
                      launchedBy: {
                        kind: "launch" as const,
                        environmentLabel: null,
                        threadTitle: null,
                        threadId: kind === "self" ? askingId : ThreadId.make("missing-launcher"),
                        environmentId: null,
                        via: "thread_launch" as const,
                      },
                    }
                  : {}),
                ...(kind === "native"
                  ? {
                      creationSource: "provider" as const,
                      lineage: {
                        parentThreadId: launcherId,
                        relationshipToParent: "subagent" as const,
                        rootThreadId: launcherId,
                      },
                    }
                  : {}),
                ...(kind === "archived" ? { archivedAt: now } : {}),
                ...(kind === "deleted" ? { deletedAt: now } : {}),
              },
            },
          ],
        });
        yield* seed(suffix);
        assert.lengthOf((yield* records(suffix)).messages, 0);
      }
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect(
    "resolved expired cancelled and missing-item requests produce no first escalation",
    () =>
      Effect.gen(function* () {
        yield* start;
        for (const status of ["resolved", "expired", "cancelled", "missing-item"] as const) {
          const suffix = `terminal-${status}`;
          yield* setup(suffix);
          const now = yield* DateTime.now;
          const events = (yield* questionEvents(suffix)).flatMap(
            (e): OrchestrationV2DomainEvent[] =>
              e.type === "turn-item.updated" && status === "missing-item"
                ? []
                : e.type === "runtime-request.updated" && status !== "missing-item"
                  ? [{ ...e, payload: { ...e.payload, status, resolvedAt: now } }]
                  : [e],
          );
          yield* seed(suffix, events);
          assert.lengthOf((yield* records(suffix)).messages, 0);
        }
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect("terminal outcomes reconcile archived and deleted asking threads without an item", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* start;
      for (const status of ["expired", "cancelled", "settled"] as const) {
        const suffix = `closed-${status}`;
        yield* setup(suffix);
        yield* seed(suffix);
        yield* promote(suffix);
        const { askingId, requestId, resolutionId } = ids(suffix);
        const thread = yield* store.getThread(askingId);
        const request = (yield* store.getRuntimeRequest(askingId, requestId))!;
        const now = yield* DateTime.now;
        // The old item no longer matches the request; resolution must not require it.
        const oldItem = (yield* questionEvents(suffix)).find(
          (e) => e.type === "turn-item.updated",
        )!;
        assert.equal(oldItem.type, "turn-item.updated");
        if (oldItem.type !== "turn-item.updated" || oldItem.payload.type !== "user_input_request")
          return;
        yield* sink.write({
          events: [
            {
              ...oldItem,
              id: EventId.make(`old-item:${suffix}`),
              payload: { ...oldItem.payload, requestId: RuntimeRequestId.make(`other:${suffix}`) },
            },
            {
              id: EventId.make(`closed-thread:${suffix}`),
              type: "thread.metadata-updated",
              threadId: askingId,
              occurredAt: now,
              payload: {
                ...thread,
                ...(status === "cancelled" ? { deletedAt: now } : { archivedAt: now }),
              },
            },
            {
              id: EventId.make(`closed-request:${suffix}`),
              type: "runtime-request.updated",
              threadId: askingId,
              occurredAt: now,
              payload: {
                ...request,
                status: status === "settled" ? "resolved" : status,
                ...(status === "settled" ? { decision: "cancel" as const } : {}),
                resolvedAt: now,
              },
            },
          ],
        });
        yield* service.reconcile(askingId, requestId);
        const notice = (yield* records(suffix)).messages.find((m) => m.id === resolutionId)!;
        assert.include(
          notice.text,
          status === "settled"
            ? "was closed when its thread stopped or settled."
            : status === "expired"
              ? '"asking:closed-expired" expired.'
              : "was cancelled.",
        );
        assert.equal(notice.notification?.summary, notice.text);
      }
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect(
    "launcher delivery answers suppress notice; other recorded responders receive one",
    () =>
      Effect.gen(function* () {
        const service = yield* start;
        for (const responder of [
          "launchedBy",
          "agent",
          "foreign",
          "relayed",
          "client",
          "legacy",
        ] as const) {
          const suffix = `responder-${responder}`;
          yield* setup(suffix);
          yield* seed(suffix);
          yield* promote(suffix);
          const { askingId, launcherId, requestId, resolutionId } = ids(suffix);
          const respondedBy: UserInputRespondedBy | undefined =
            responder === "legacy"
              ? undefined
              : responder === "client"
                ? { type: "client", reason: "Client decision" }
                : {
                    type: "agent",
                    threadId:
                      responder === "agent" || responder === "relayed"
                        ? ThreadId.make("other-agent")
                        : launcherId,
                    environmentId: responder === "foreign" ? EnvironmentId.make("foreign") : null,
                    title: "Coordinator",
                    reason: "Decision",
                    ...(responder === "relayed" ? { relayedFromUser: true } : {}),
                  };
          if (respondedBy === undefined) {
            const store = yield* ProjectionStore.ProjectionStoreV2;
            const sink = yield* EventSink.EventSinkV2;
            const request = (yield* store.getRuntimeRequest(askingId, requestId))!;
            const now = yield* DateTime.now;
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`legacy-answer:${suffix}`),
                  type: "runtime-request.updated",
                  threadId: askingId,
                  occurredAt: now,
                  payload: { ...request, status: "resolved", resolvedAt: now },
                },
              ],
            });
          } else {
            yield* answer(suffix, respondedBy);
            const store = yield* ProjectionStore.ProjectionStoreV2;
            assert.deepEqual(
              (yield* store.getRuntimeRequest(askingId, requestId))?.respondedBy,
              respondedBy,
            );
          }
          yield* service.reconcile(askingId, requestId);
          const notices = (yield* records(suffix)).messages.filter((m) => m.id === resolutionId);
          assert.lengthOf(notices, responder === "launchedBy" ? 0 : 1);
          if (responder !== "launchedBy")
            assert.include(
              notices[0]!.text,
              responder === "client"
                ? "answered by an MCP client"
                : responder === "legacy"
                  ? "answered by another responder"
                  : responder === "relayed"
                    ? 'answered by the user, relayed by orchestrator "Coordinator"'
                    : responder === "foreign"
                      ? 'answered by orchestrator "Coordinator" on another machine'
                      : 'answered by orchestrator "Coordinator"',
            );
        }
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect("activation parks the subscriber and repeated start does not duplicate delivery", () =>
    Effect.gen(function* () {
      const suffix = "activation";
      yield* setup(suffix);
      const service = yield* QuestionEscalationService.QuestionEscalationService;
      const activation = yield* Deferred.make<void>();
      yield* service
        .start()
        .pipe(Effect.provideService(ServerActivation, Deferred.await(activation)));
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({ events: yield* questionEvents(suffix) });
      assert.lengthOf((yield* records(suffix)).messages, 0);
      const saved = yield* awaitMessage(ids(suffix).messageId);
      yield* Deferred.succeed(activation, undefined);
      yield* service.awaitSubscribed;
      yield* service.start();
      yield* Fiber.join(saved);
      yield* service.reconcile(ids(suffix).askingId, ids(suffix).requestId);
      assert.lengthOf((yield* records(suffix)).messages, 1);
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect("human answer during escalation dispatch cancels the queued run after commit", () =>
    Effect.gen(function* () {
      const suffix = "answer-race";
      yield* setup(suffix);
      const service = yield* start;
      yield* holdLauncher(suffix);
      const engine = yield* Orchestrator.OrchestratorV2;
      const dispatch = engine.dispatch;
      let answered = false;
      const spy = vi.spyOn(engine, "dispatch").mockImplementation((command) =>
        dispatch(command).pipe(
          Effect.tap(() => {
            if (
              command.type !== "message.dispatch" ||
              command.messageId !== ids(suffix).messageId ||
              answered
            )
              return Effect.void;
            answered = true;
            // Keep the real dispatch, receipt and destination lock; answer after its commit.
            return answer(suffix).pipe(Effect.provideService(Orchestrator.OrchestratorV2, engine));
          }),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      yield* seed(suffix);
      yield* service.reconcile(ids(suffix).askingId, ids(suffix).requestId);
      const after = yield* records(suffix);
      assert.isTrue(answered);
      assert.equal(
        after.runs.find((r) => r.userMessageId === ids(suffix).messageId)?.status,
        "cancelled",
      );
      assert.isUndefined(after.messages.find((m) => m.id === ids(suffix).resolutionId));
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect("external cancellation still receives a resolution notice", () =>
    Effect.gen(function* () {
      const suffix = "external-cancel";
      yield* setup(suffix);
      const service = yield* start;
      yield* holdLauncher(suffix);
      yield* seed(suffix);
      const engine = yield* Orchestrator.OrchestratorV2;
      const run = (yield* records(suffix)).runs.find(
        (r) => r.userMessageId === ids(suffix).messageId,
      )!;
      yield* engine.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`outside-cancel:${suffix}`),
        threadId: ids(suffix).launcherId,
        runId: run.id,
      });
      yield* answer(suffix);
      yield* service.reconcile(ids(suffix).askingId, ids(suffix).requestId);
      const notices = (yield* records(suffix)).messages.filter(
        (m) => m.id === ids(suffix).resolutionId,
      );
      assert.lengthOf(notices, 1);
      assert.include(notices[0]!.text, "answered by the user");
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );

  it.effect(
    "a transient failure retries on the next matching event without blocking another pair",
    () =>
      Effect.gen(function* () {
        const suffix = "failed-pair";
        yield* setup(suffix);
        yield* setup("healthy-pair");
        const service = yield* start;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const read = store.getRuntimeRequest;
        let failing = true;
        const spy = vi
          .spyOn(store, "getRuntimeRequest")
          .mockImplementation((threadId, requestId) =>
            threadId === ids(suffix).askingId && failing
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: "Transient storage fault",
                  }),
                )
              : read(threadId, requestId),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        yield* seed(suffix);
        assert.lengthOf((yield* records(suffix)).messages, 0);
        yield* seed("healthy-pair");
        assert.lengthOf((yield* records("healthy-pair")).messages, 1);
        failing = false;
        yield* seed(
          suffix,
          (yield* questionEvents(suffix))
            .filter((e) => e.type === "runtime-request.updated")
            .map((e) => ({ ...e, id: EventId.make(`${e.id}:retry`) })),
        );
        yield* service.reconcile(ids(suffix).askingId, ids(suffix).requestId);
        assert.lengthOf((yield* records(suffix)).messages, 1);
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
});
