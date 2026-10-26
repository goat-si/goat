import { assert, it } from "@effect/vitest";
import { ProviderTurnId, RunId, RunAttemptId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Acp from "effect-acp/compat";
import { AcpRequestError } from "effect-acp/errors";
import * as Adapter from "@goat/provider-core/server/ProviderAdapter";
import { DevinCloudCliError } from "./cli.ts";
import { makeTaskObserver, matchingPr, sourcePrompt } from "./task.ts";
import {
  relay,
  taskInput,
  textUpdate,
  thread,
  sessionMeta,
  sessionUrl,
} from "./testing/fixtures.ts";

it("links only the source repository and never infers an output branch", () => {
  assert.equal(
    matchingPr("https://github.com/example/project/pull/12", thread.cloudTask!.source.repository),
    "https://github.com/example/project/pull/12",
  );
  assert.isUndefined(
    matchingPr("https://github.com/other/project/pull/12", thread.cloudTask!.source.repository),
  );
  assert.isUndefined(
    matchingPr("https://github.com/example/project/issues/12", thread.cloudTask!.source.repository),
  );
  assert.isUndefined(
    matchingPr(
      "https://github.com.evil.test/example/project/pull/12",
      thread.cloudTask!.source.repository,
    ),
  );
  assert.isUndefined(
    matchingPr(
      "https://github.com/example/project/pull/12",
      "https://user:password@github.com/example/project",
    ),
  );
  const first = sourcePrompt(thread, "change function", true);
  assert.include(first, thread.cloudTask!.source.sha!);
  assert.include(first, "Local changes are not included");
  assert.notInclude(sourcePrompt(thread, "follow up", false), "Verify the checkout");
});
it.effect(
  "streams bounded progress and commits the deduplicated task summary before terminal",
  () =>
    Effect.gen(function* () {
      const events: Adapter.ProviderAdapterV2Event[] = [];
      const observer = yield* makeTaskObserver(
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        () => Effect.void,
      );
      yield* observer.bind(taskInput, false);
      const text = "Done\nhttps://github.com/example/project/pull/12";
      yield* observer.run(
        relay({
          prompt: () =>
            Effect.gen(function* () {
              yield* observer.update(textUpdate(text));
              yield* observer.update({
                sessionId: "devin-fixture-session",
                update: {
                  sessionUpdate: "agent_message",
                  messageId: "message-1",
                  content: [{ type: "text", text }],
                },
              });
              return { stopReason: "end_turn" as const, _meta: sessionMeta() };
            }),
        }),
        "task",
      );
      const resultIndex = events.findIndex(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.cloudTask?.summary === text,
      );
      assert.isAtLeast(resultIndex, 0);
      assert.isBelow(
        resultIndex,
        events.findIndex((event) => event.type === "turn.terminal"),
      );
      assert.equal(events.filter((event) => event.type === "message.updated").length, 0);
      const updates = events.filter((event) => event.type === "provider_thread.updated");
      assert.equal(updates.at(-1)?.providerThread.cloudTask?.status, "succeeded");
      assert.isUndefined(updates.at(-1)?.providerThread.cloudTask?.branch);
      assert.equal(updates.at(-1)?.providerThread.cloudTask?.url, sessionUrl);
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
    }),
);
it.effect("the live access-block fixture never becomes succeeded", () =>
  Effect.gen(function* () {
    const events: Adapter.ProviderAdapterV2Event[] = [];
    const observer = yield* makeTaskObserver(
      (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      () => Effect.void,
    );
    yield* observer.bind(taskInput, false);
    yield* observer.run(
      relay({
        prompt: () =>
          Effect.gen(function* () {
            yield* observer.update(
              textUpdate("On it.Blocked: no repos are cloned here, and this org has no access."),
            );
            return { stopReason: "end_turn" as const };
          }),
      }),
      "task",
    );
    const updates = events.filter((event) => event.type === "provider_thread.updated");
    assert.equal(updates.at(-1)?.providerThread.cloudTask?.status, "failed");
    assert.include(updates.at(-1)?.providerThread.cloudTask?.summary ?? "", "Blocked:");
    assert.equal(events.filter((event) => event.type === "message.updated").length, 0);
  }),
);
it.effect(
  "cancel notification waits for confirmed cancellation; success wins the terminal race",
  () =>
    Effect.gen(function* () {
      for (const stopReason of ["cancelled", "end_turn"] as const) {
        const events: Adapter.ProviderAdapterV2Event[] = [];
        const entered = yield* Deferred.make<void>();
        const complete = yield* Deferred.make<Acp.PromptResponse>();
        let cancels = 0;
        const observer = yield* makeTaskObserver(
          (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          () => Effect.void,
        );
        const remote = relay({
          prompt: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(complete))),
          cancel: () =>
            Effect.sync(() => {
              cancels++;
            }),
        });
        yield* observer.bind(taskInput, false);
        const running = yield* observer.run(remote, "task").pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const active = events.find((event) => event.type === "provider_turn.updated")!;
        assert.equal(active.type, "provider_turn.updated");
        if (active.type !== "provider_turn.updated") return;
        yield* observer.cancel(remote, active.providerTurn.id);
        assert.equal(cancels, 1);
        assert.equal(events.filter((event) => event.type === "turn.terminal").length, 0);
        yield* Deferred.succeed(complete, { stopReason });
        yield* Fiber.join(running);
        const terminal = events.find((event) => event.type === "turn.terminal");
        assert.equal(
          terminal?.type === "turn.terminal" ? terminal.status : "",
          stopReason === "cancelled" ? "interrupted" : "completed",
        );
      }
    }),
);
it.effect(
  "disconnect keeps remote unknown, records partial response and fails only the observation",
  () =>
    Effect.gen(function* () {
      const events: Adapter.ProviderAdapterV2Event[] = [];
      const reasons: string[] = [];
      const observer = yield* makeTaskObserver(
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        (reason) =>
          Effect.sync(() => {
            reasons.push(reason);
          }),
      );
      yield* observer.bind(taskInput, false);
      yield* observer.run(
        relay({
          prompt: () =>
            Effect.gen(function* () {
              yield* observer.update({
                sessionId: "devin-fixture-session",
                update: { sessionUpdate: "session_info_update", _meta: sessionMeta() },
              });
              yield* observer.update(textUpdate("working so far"));
              return yield* new DevinCloudCliError({ stage: "relay" });
            }),
        }),
        "task",
      );
      const updates = events.filter((event) => event.type === "provider_thread.updated");
      assert.equal(updates.at(-1)?.providerThread.cloudTask?.status, "unknown");
      assert.equal(updates.at(-1)?.providerThread.cloudTask?.summary, "working so far");
      assert.equal(updates.at(-1)?.providerThread.cloudTask?.url, sessionUrl);
      const observation = events.find((event) => event.type === "turn.terminal");
      assert.equal(observation?.type === "turn.terminal" ? observation.status : "", "failed");
      assert.equal(reasons.length, 1);
    }),
);
// Transport-level assertions only; the real persistence cases below remain mandatory.
it.effect("a sign-in refusal of the prompt stays unknown and tells the user to sign in again", () =>
  Effect.gen(function* () {
    const events: Adapter.ProviderAdapterV2Event[] = [];
    let prompts = 0;
    const observer = yield* makeTaskObserver(
      (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      () => Effect.void,
    );
    yield* observer.bind(taskInput, false);
    yield* observer.run(
      relay({
        prompt: () =>
          Effect.suspend(() => {
            prompts += 1;
            return Effect.fail(
              new DevinCloudCliError({
                stage: "relay",
                cause: AcpRequestError.fromProtocolError(
                  { code: -32000, message: "Authentication required" },
                  { method: "session/prompt" },
                ),
              }),
            );
          }),
      }),
      "task",
    );
    const updated = events.findLast((event) => event.type === "provider_thread.updated");
    const task =
      updated?.type === "provider_thread.updated" ? updated.providerThread.cloudTask : undefined;
    assert.equal(task?.status, "unknown");
    assert.equal(
      task?.error,
      "Devin asked you to sign in again (run `devin auth login`). GOAT could not confirm whether this prompt reached Devin, so it was not resent.",
    );
    const terminal = events.find((event) => event.type === "turn.terminal");
    assert.equal(terminal?.type === "turn.terminal" ? terminal.status : "", "failed");
    assert.equal(terminal?.type === "turn.terminal" ? terminal.threadDisposition : "", "broken");
    assert.equal(prompts, 1);
  }),
);
it.effect("retains early metadata and sends late blocked metadata through the base port", () =>
  Effect.gen(function* () {
    const events: Adapter.ProviderAdapterV2Event[] = [];
    const patches: Array<{
      nativeId: string;
      metadata: Adapter.ProviderAdapterV2CloudTaskMetadata;
    }> = [];
    const observer = yield* makeTaskObserver(
      (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      () => Effect.void,
    );
    // Shape of the available_commands_update delivered before session/new's reply.
    yield* observer.update({
      sessionId: "devin-fixture-session",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
        _meta: sessionMeta(),
      },
    });
    yield* observer.update({
      sessionId: "foreign-session",
      update: {
        sessionUpdate: "session_info_update",
        title: "Foreign",
        _meta: sessionMeta(),
      },
    });
    yield* observer.bind(
      {
        ...taskInput,
        commitCloudTaskMetadata: (nativeId, metadata) =>
          Effect.sync(() => {
            patches.push({ nativeId, metadata });
          }),
      },
      false,
    );
    yield* observer.update({
      sessionId: "devin-fixture-session",
      update: {
        sessionUpdate: "session_info_update",
        title: "Task title",
        _meta: {
          "cognition.ai/eventType": "status_update",
          "cognition.ai/statusEnum": "working",
          "cognition.ai/statusMessage": "Reading README",
        },
      },
    });
    yield* observer.run(
      relay({ prompt: () => Effect.succeed({ stopReason: "end_turn", _meta: sessionMeta() }) }),
      "task",
    );
    yield* observer.update({
      sessionId: "devin-fixture-session",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          "cognition.ai/eventType": "status_update",
          "cognition.ai/statusEnum": "blocked",
          "cognition.ai/statusMessage": "Provide instructions",
        },
      },
    });
    yield* observer.update(textUpdate("foreign text", "foreign-session"));
    const task = events.findLast((event) => event.type === "provider_thread.updated")
      ?.providerThread.cloudTask;
    assert.equal(task?.url, sessionUrl);
    assert.equal(task?.title, "Task title");
    assert.equal(task?.status, "succeeded");
    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.nativeId, "devin-fixture-session");
    assert.include(patches[0]?.metadata.progress ?? "", "Waiting for input");
    assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
    assert.equal(events.filter((event) => event.type === "message.updated").length, 0);
  }),
);
it.effect(
  "load replay dedupes against persisted summary and uses load metadata, never a historical idle",
  () =>
    Effect.gen(function* () {
      for (const status of ["submitting", "running"] as const) {
        const events: Adapter.ProviderAdapterV2Event[] = [];
        const calls: string[] = [];
        const patches: Adapter.ProviderAdapterV2CloudTaskMetadata[] = [];
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const observer = yield* makeTaskObserver(
          (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          () => Effect.void,
        );
        const existing = {
          ...taskInput,
          providerThread: {
            ...thread,
            cloudTask: {
              ...thread.cloudTask!,
              status,
              summary: "Persisted summary",
              url: sessionUrl,
            },
          },
        };
        yield* observer.bind(
          {
            ...existing,
            commitCloudTaskMetadata: (_nativeId, metadata) =>
              Effect.sync(() => {
                patches.push(metadata);
              }),
          },
          true,
        );
        const loading = yield* observer
          .attach(
            relay({
              create: Effect.die("No replacement session"),
              configureSource: () => Effect.die("No source reset"),
              prompt: () => Effect.die("No prompt resend"),
              cancel: () => Effect.die("No cancellation"),
              attach: (id) =>
                Effect.gen(function* () {
                  calls.push(`load:${id}`);
                  yield* observer.update(textUpdate("Persisted summary"));
                  yield* observer.update(textUpdate("Persisted summary"));
                  yield* observer.update({
                    sessionId: id,
                    update: {
                      sessionUpdate: "state_update",
                      state: "idle",
                      stopReason: "end_turn",
                    },
                  });
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return { _meta: sessionMeta("blocked") };
                }),
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        assert.equal(events.filter((event) => event.type === "turn.terminal").length, 0);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(loading);
        // This checks the post-settlement port; SQLite persistence is covered by integrated CI.
        yield* observer.update({
          sessionId: "devin-fixture-session",
          update: {
            sessionUpdate: "session_info_update",
            title: "Loaded task",
            _meta: {
              "cognition.ai/statusEnum": "blocked",
              "cognition.ai/statusMessage": "Provide instructions",
            },
          },
        });
        assert.deepEqual(calls, ["load:devin-fixture-session"]);
        const task = events.findLast((event) => event.type === "provider_thread.updated")
          ?.providerThread.cloudTask;
        assert.equal(task?.summary, "Persisted summary");
        assert.equal(task?.url, sessionUrl);
        assert.equal(task?.status, "unknown");
        assert.equal(patches.length, 1);
        assert.equal(patches[0]?.title, "Loaded task");
        assert.include(task?.progress ?? "", "Waiting for input");
        assert.isUndefined(patches[0]?.progress);
        assert.equal(events.filter((event) => event.type === "message.updated").length, 0);
        assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
      }
    }),
);
it.effect(
  "unavailable load keeps identity and URL without a replacement or fabricated outcome",
  () =>
    Effect.gen(function* () {
      const events: Adapter.ProviderAdapterV2Event[] = [];
      const observer = yield* makeTaskObserver(
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        () => Effect.void,
      );
      yield* observer.bind(
        {
          ...taskInput,
          providerThread: { ...thread, cloudTask: { ...thread.cloudTask!, url: sessionUrl } },
        },
        true,
      );
      yield* observer.attach(
        relay({ attach: () => Effect.fail(new DevinCloudCliError({ stage: "relay" })) }),
      );
      const task = events.findLast((event) => event.type === "provider_thread.updated")
        ?.providerThread.cloudTask;
      assert.equal(task?.taskId, "devin-fixture-session");
      assert.equal(task?.url, sessionUrl);
      assert.equal(task?.status, "unknown");
    }),
);

it.effect(
  "response marker and summary wait for durable ACK; duplicate completion advances once",
  () =>
    Effect.gen(function* () {
      const events: Adapter.ProviderAdapterV2Event[] = [];
      const committing = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<void>();
      let commits = 0;
      let prompts = 0;
      const observer = yield* makeTaskObserver(
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        () => Effect.void,
      );
      yield* observer.bind(
        {
          ...taskInput,
          commitCloudTask: (task, refs) =>
            Effect.gen(function* () {
              commits++;
              assert.equal(refs?.nativeThreadRef?.ordinal, 2);
              assert.equal(task.summary, "Confirmed response");
              yield* Deferred.succeed(committing, undefined);
              yield* Deferred.await(accepted);
            }),
        },
        false,
      );
      const remote = relay({
        prompt: () =>
          Effect.gen(function* () {
            prompts++;
            yield* observer.update(textUpdate("Confirmed response"));
            return { stopReason: "end_turn" as const };
          }),
      });
      const running = yield* observer.run(remote, "task").pipe(Effect.forkScoped);
      yield* Deferred.await(committing);
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 0);
      assert.equal(
        events.filter(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.nativeThreadRef?.ordinal === 2,
        ).length,
        0,
      );
      yield* Deferred.succeed(accepted, undefined);
      yield* Fiber.join(running);
      yield* observer.run(remote, "duplicate dispatch");
      yield* observer.update({
        sessionId: "devin-fixture-session",
        update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      });
      assert.equal(commits, 1);
      assert.equal(prompts, 1);
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
      const snapshots = events.filter((event) => event.type === "provider_thread.updated");
      assert.equal(snapshots.at(-1)?.providerThread.nativeThreadRef?.ordinal, 2);
    }),
);

it.effect(
  "failed response-marker ACK leaves observation unknown without advancing or resending",
  () =>
    Effect.gen(function* () {
      const events: Adapter.ProviderAdapterV2Event[] = [];
      let prompts = 0;
      const observer = yield* makeTaskObserver(
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        () => Effect.void,
      );
      yield* observer.bind(
        {
          ...taskInput,
          commitCloudTask: () =>
            Effect.fail(
              new Adapter.ProviderAdapterProtocolError({
                driver: thread.driver,
                detail: "Acceptance ownership lost",
              }),
            ),
        },
        false,
      );
      yield* observer.run(
        relay({
          prompt: () =>
            Effect.gen(function* () {
              prompts++;
              yield* observer.update(textUpdate("Returned response"));
              return { stopReason: "end_turn" as const };
            }),
        }),
        "task",
      );
      const latest = events.findLast(
        (event) => event.type === "provider_thread.updated",
      )?.providerThread;
      assert.equal(latest?.cloudTask?.status, "unknown");
      assert.equal(latest?.cloudTask?.summary, "Returned response");
      assert.equal(latest?.nativeThreadRef?.ordinal, 1);
      assert.equal(prompts, 1);
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
    }),
);

it.effect(
  "A completes then B binds; Stop A changes neither B progress nor remote cancellation",
  () =>
    Effect.gen(function* () {
      const events: Adapter.ProviderAdapterV2Event[] = [];
      const entered = yield* Deferred.make<void>();
      const completeB = yield* Deferred.make<Acp.PromptResponse>();
      let cancels = 0;
      const observer = yield* makeTaskObserver(
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        () => Effect.void,
      );
      yield* observer.bind(taskInput, false);
      yield* observer.run(relay(), "A");
      const turnA = events.find((event) => event.type === "provider_turn.updated");
      assert.equal(turnA?.type, "provider_turn.updated");
      if (turnA?.type !== "provider_turn.updated") return;
      const latest = events.findLast(
        (event) => event.type === "provider_thread.updated",
      )!.providerThread;
      yield* observer.bind(
        {
          ...taskInput,
          runId: RunId.make("run-B"),
          attemptId: RunAttemptId.make("attempt-B"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          providerThread: latest,
        },
        false,
      );
      const remote = relay({
        prompt: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(completeB))),
        cancel: () =>
          Effect.sync(() => {
            cancels++;
          }),
      });
      const running = yield* observer.run(remote, "B").pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const before = events.length;
      yield* observer.cancel(remote, turnA.providerTurn.id);
      yield* observer.cancel(remote, ProviderTurnId.make("foreign-turn"));
      assert.equal(events.length, before);
      assert.equal(cancels, 0);
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
      yield* Deferred.succeed(completeB, { stopReason: "end_turn" });
      yield* Fiber.join(running);
      const turnB = events.findLast((event) => event.type === "provider_turn.updated")!;
      yield* observer.cancel(remote, turnB.providerTurn.id);
      assert.equal(cancels, 0);
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 2);
    }),
);

it.effect("Stop dispatch holds the same gate until its ACK; normal completion still wins", () =>
  Effect.gen(function* () {
    const events: Adapter.ProviderAdapterV2Event[] = [];
    const promptEntered = yield* Deferred.make<void>();
    const promptResponse = yield* Deferred.make<Acp.PromptResponse>();
    const cancelEntered = yield* Deferred.make<void>();
    const cancelAck = yield* Deferred.make<void>();
    const observer = yield* makeTaskObserver(
      (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      () => Effect.void,
    );
    yield* observer.bind(taskInput, false);
    const remote = relay({
      prompt: () =>
        Deferred.succeed(promptEntered, undefined).pipe(
          Effect.andThen(Deferred.await(promptResponse)),
        ),
      cancel: () =>
        Deferred.succeed(cancelEntered, undefined).pipe(Effect.andThen(Deferred.await(cancelAck))),
    });
    const running = yield* observer.run(remote, "task").pipe(Effect.forkScoped);
    yield* Deferred.await(promptEntered);
    const turn = events.find((event) => event.type === "provider_turn.updated")!;
    if (turn.type !== "provider_turn.updated") return;
    const cancelling = yield* observer.cancel(remote, turn.providerTurn.id).pipe(Effect.forkScoped);
    yield* Deferred.await(cancelEntered);
    yield* Deferred.succeed(promptResponse, { stopReason: "end_turn" });
    assert.equal(events.filter((event) => event.type === "turn.terminal").length, 0);
    yield* Deferred.succeed(cancelAck, undefined);
    yield* Fiber.join(cancelling);
    yield* Fiber.join(running);
    const terminal = events.find((event) => event.type === "turn.terminal");
    assert.equal(terminal?.type === "turn.terminal" ? terminal.status : "", "completed");
  }),
);

it.effect(
  "bounded early metadata, response and late duplicate metadata coalesce without stale snapshots",
  () =>
    Effect.gen(function* () {
      const events: Adapter.ProviderAdapterV2Event[] = [];
      const patches: Adapter.ProviderAdapterV2CloudTaskMetadata[] = [];
      const observer = yield* makeTaskObserver(
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        () => Effect.void,
      );
      yield* observer.update({
        sessionId: "devin-fixture-session",
        update: { sessionUpdate: "session_info_update", title: "Evicted early title" },
      });
      for (let i = 0; i < 8; i++)
        yield* observer.update({
          sessionId: `devin-foreign-${i}`,
          update: {
            sessionUpdate: "session_info_update",
            title: `Foreign ${i}`,
          },
        });
      yield* observer.bind(
        {
          ...taskInput,
          commitCloudTaskMetadata: (_id, patch) =>
            Effect.sync(() => {
              patches.push(patch);
            }),
        },
        false,
      );
      yield* observer.run(
        relay({
          prompt: () =>
            Effect.gen(function* () {
              for (let i = 0; i < 70; i++)
                yield* observer.update(
                  textUpdate("x".repeat(2000), "devin-fixture-session", `response-${i}`),
                );
              return { stopReason: "end_turn" as const };
            }),
        }),
        "task",
      );
      const latest = events.findLast((event) => event.type === "provider_thread.updated")
        ?.providerThread.cloudTask;
      assert.isUndefined(latest?.title);
      assert.equal(latest?.summary?.length, 64_000);
      assert.isAtMost(latest?.progress?.length ?? 0, 2000);
      const before = events.length;
      const notice: Acp.SessionNotification = {
        sessionId: "devin-fixture-session",
        update: {
          sessionUpdate: "session_info_update",
          title: "T".repeat(1000),
          _meta: {
            "cognition.ai/statusEnum": "blocked",
            "cognition.ai/statusMessage": "P".repeat(4000),
          },
        },
      };
      yield* observer.update(notice);
      yield* observer.update(notice);
      assert.equal(events.length, before);
      assert.equal(patches.length, 1);
      assert.equal(patches[0]?.title?.length, 512);
      assert.equal(patches[0]?.progress?.length, 2000);
    }),
);
