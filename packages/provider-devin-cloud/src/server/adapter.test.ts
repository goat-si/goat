import { assert, it } from "@effect/vitest";
import { ProviderTurnId, RunId, RunAttemptId } from "@goat/contracts";
import * as Adapter from "@goat/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Cli from "./cli.ts";
import * as Relay from "./relay.ts";
import { makeAdapter } from "./adapter.ts";
import {
  instanceId,
  launch,
  opened,
  relay,
  repoOptions,
  selectedRepoOptions,
  taskInput,
  textUpdate,
  thread,
  turnInput,
  sessionMeta,
  sessionUrl,
} from "./testing/fixtures.ts";

const open = (
  remote: Relay.CloudRelay,
  captureUpdate?: (
    update: (notice: import("effect-acp/compat").SessionNotification) => Effect.Effect<void>,
  ) => void,
  selection = opened,
) =>
  makeAdapter(instanceId, "sibling-fixture").pipe(
    Effect.provideService(
      Cli.DevinCloudCli,
      Cli.DevinCloudCli.of({
        resolve: () => Effect.succeed(launch),
        probe: () => Effect.succeed({ version: "3000.11.3", email: undefined }),
      }),
    ),
    Effect.provideService(
      Relay.DevinCloudRelay,
      Relay.DevinCloudRelay.of({
        open: (_launch, onUpdate) =>
          Effect.sync(() => {
            captureUpdate?.(onUpdate);
            return remote;
          }),
      }),
    ),
    Effect.flatMap((adapter) => adapter.openSession(selection)),
  );
it.effect("selected Devin version and platform reach setup; failed setup sends no prompt", () =>
  Effect.gen(function* () {
    for (const reason of [
      "offered",
      "unoffered version",
      "unoffered platform",
      "setter mismatch",
      "final mismatch",
    ] as const) {
      const selected = {
        ...opened,
        modelSelection: {
          ...opened.modelSelection,
          model: "devin-ultra",
          options: [{ id: "platform", value: "macos" }],
        },
      };
      let prompts = 0;
      let creates = 0;
      let observedSelection: { readonly model: string; readonly platform: string } | undefined;
      const completed = yield* Deferred.make<void>();
      const runtime = yield* open(
        relay({
          create: Effect.sync(() => {
            creates++;
            return { sessionId: "devin-fixture-session", configOptions: repoOptions };
          }),
          configureSource: (_id, _source, selection) => {
            observedSelection = selection;
            return reason === "offered"
              ? Effect.void
              : Effect.fail(
                  new Cli.DevinCloudCliError({
                    stage: "relay",
                    detail: `Devin ${reason}; no prompt was sent.`,
                  }),
                );
          },
          prompt: () =>
            Effect.sync(() => {
              prompts++;
              return { stopReason: "end_turn" as const };
            }),
        }),
        undefined,
        selected,
      );
      if (reason === "offered")
        yield* Stream.runForEach(runtime.events, (event) =>
          event.type === "turn.terminal" ? Deferred.succeed(completed, undefined) : Effect.void,
        ).pipe(Effect.forkScoped);
      const started = yield* Effect.result(
        runtime.startTurn({
          ...turnInput,
          providerThread: { ...thread, nativeThreadRef: null },
        }),
      );
      assert.deepEqual(observedSelection, { model: "devin-ultra", platform: "macos" });
      assert.equal(creates, 1);
      if (reason === "offered") {
        assert.isTrue(Result.isSuccess(started));
        yield* Deferred.await(completed);
        assert.equal(prompts, 1);
      } else {
        assert.isTrue(Result.isFailure(started));
        assert.equal(prompts, 0);
      }
    }
  }),
);

it.effect("an existing Devin cloud session rejects model or platform changes", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(instanceId, "sibling-fixture").pipe(
      Effect.provideService(
        Cli.DevinCloudCli,
        Cli.DevinCloudCli.of({
          resolve: () => Effect.succeed(launch),
          probe: () => Effect.succeed({ version: "3000.11.3", email: undefined }),
        }),
      ),
      Effect.provideService(
        Relay.DevinCloudRelay,
        Relay.DevinCloudRelay.of({
          open: () => Effect.succeed(relay()),
        }),
      ),
    );
    for (const target of [
      { ...opened.modelSelection, model: "devin-ultra" },
      { ...opened.modelSelection, options: [{ id: "platform", value: "macos" }] },
    ]) {
      const plan = yield* adapter.planSelectionTransition({
        current: opened.modelSelection,
        target,
        sessionCapabilities: yield* adapter.getCapabilities(),
      });
      assert.equal(plan.type, "reject");
    }
    const reordered = yield* adapter.planSelectionTransition({
      current: {
        ...opened.modelSelection,
        options: [
          { id: "platform", value: "macos" },
          { id: "extra", value: "kept" },
        ],
      },
      target: {
        ...opened.modelSelection,
        options: [
          { id: "extra", value: "kept" },
          { id: "platform", value: "macos" },
        ],
      },
      sessionCapabilities: yield* adapter.getCapabilities(),
    });
    assert.equal(reordered.type, "apply_on_next_turn");
  }),
);
it.effect(
  "open/ensure do not create before base intent; identity commit precedes repos and prompt",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const done = yield* Deferred.make<void>();
      let latest = thread;
      const runtime = yield* open(
        relay({
          create: Effect.sync(() => {
            calls.push("new");
            return { sessionId: "devin-fixture-session", configOptions: repoOptions };
          }),
          configureSource: (id, source) =>
            Effect.sync(() => {
              assert.equal(calls.at(-1), "accept:0");
              assert.equal(id, "devin-fixture-session");
              assert.equal(source.repository, thread.cloudTask!.source.repository);
              calls.push("repos");
            }),
          prompt: (id) =>
            Effect.sync(() => {
              assert.equal(id, "devin-fixture-session");
              calls.push("prompt");
              return { stopReason: "end_turn" as const };
            }),
        }),
      );
      const provisional = {
        ...thread,
        nativeThreadRef: null,
        cloudTask: { ...thread.cloudTask!, taskId: taskInput.runId },
      };
      const ensured = yield* Effect.result(
        runtime.ensureThread({
          threadId: taskInput.threadId,
          modelSelection: opened.modelSelection,
          runtimePolicy: opened.runtimePolicy,
          existingProviderThread: provisional,
        }),
      );
      assert.isTrue(Result.isFailure(ensured));
      assert.deepEqual(calls, []);
      yield* Stream.runForEach(runtime.events, (event) =>
        Effect.gen(function* () {
          if (event.type === "provider_thread.updated") latest = event.providerThread;
          if (event.type === "turn.terminal") yield* Deferred.succeed(done, undefined);
        }),
      ).pipe(Effect.forkScoped);
      yield* runtime.startTurn({
        ...turnInput,
        providerThread: provisional,
        commitCloudTask: (task, refs) =>
          Effect.sync(() => {
            assert.equal(task.taskId, "devin-fixture-session");
            assert.equal(task.status, task.summary ? "succeeded" : "submitting");
            assert.equal(refs?.nativeThreadRef?.nativeId, task.taskId);
            calls.push(`accept:${refs?.nativeThreadRef?.ordinal}`);
          }),
      });
      yield* Deferred.await(done);
      assert.deepEqual(calls, ["new", "accept:0", "repos", "prompt", "accept:1"]);
      assert.equal(latest.nativeThreadRef?.fingerprint, launch.binding);
      const resumed = yield* runtime.resumeThread({ providerThread: latest });
      assert.equal(resumed.nativeThreadRef?.nativeId, "devin-fixture-session");
    }),
);

it.effect(
  "response-only session metadata survives setup failure and follow-up observation loss",
  () =>
    Effect.gen(function* () {
      for (const mode of ["create", "load-mismatch", "prompt-loss"] as const)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const ended = yield* Deferred.make<void>();
            const failedSnapshot = yield* Deferred.make<void>();
            let prompts = 0;
            let acceptedUrl: string | undefined;
            let latest = thread;
            const runtime = yield* open(
              relay({
                create: Effect.succeed({
                  sessionId: "devin-fixture-session",
                  configOptions: repoOptions,
                  _meta: sessionMeta(),
                }),
                attach: () =>
                  Effect.succeed({
                    configOptions: mode === "load-mismatch" ? repoOptions : selectedRepoOptions,
                    _meta: sessionMeta(),
                  }),
                configureSource: () =>
                  Effect.fail(
                    new Cli.DevinCloudCliError({
                      stage: "relay",
                      detail: "Repository configuration failed",
                    }),
                  ),
                prompt: () =>
                  Effect.sync(() => {
                    prompts++;
                  }).pipe(
                    Effect.andThen(Effect.fail(new Cli.DevinCloudCliError({ stage: "relay" }))),
                  ),
              }),
            );
            yield* Stream.runForEach(runtime.events, (event) =>
              Effect.gen(function* () {
                if (event.type === "provider_thread.updated") {
                  latest = event.providerThread;
                  if (latest.cloudTask?.status === "failed")
                    yield* Deferred.succeed(failedSnapshot, undefined);
                }
                if (event.type === "turn.terminal") yield* Deferred.succeed(ended, undefined);
              }),
            ).pipe(Effect.forkScoped);
            const result = yield* Effect.result(
              runtime.startTurn({
                ...turnInput,
                providerThread: {
                  ...thread,
                  nativeThreadRef: mode === "create" ? null : thread.nativeThreadRef,
                },
                commitCloudTask: (task) =>
                  Effect.sync(() => {
                    acceptedUrl = task.url;
                  }),
              }),
            );
            if (mode === "prompt-loss") {
              assert.isTrue(Result.isSuccess(result));
              yield* Deferred.await(ended);
              assert.equal(latest.cloudTask?.status, "unknown");
            } else {
              assert.isTrue(Result.isFailure(result));
              yield* Deferred.await(failedSnapshot);
            }
            assert.equal(acceptedUrl, sessionUrl);
            assert.equal(latest.cloudTask?.url, sessionUrl);
            assert.equal(prompts, mode === "prompt-loss" ? 1 : 0);
          }),
        );
    }),
);
it.effect(
  "a never-prompted session reruns setup unless its load confirms the requested version and platform",
  () =>
    Effect.gen(function* () {
      const selected = {
        ...opened,
        modelSelection: {
          ...opened.modelSelection,
          model: "devin-ultra",
          options: [{ id: "platform", value: "macos" }],
        },
      };
      const choice = (id: string, value: string) => ({
        id,
        name: id,
        type: "select" as const,
        currentValue: value,
        options: [
          { name: "Requested", value: id === "platform" ? "macos" : "devin-ultra" },
          { name: "Other", value: "other" },
        ],
      });
      const unprompted = {
        ...thread,
        nativeThreadRef: { ...thread.nativeThreadRef!, ordinal: 0 },
        cloudTask: { ...thread.cloudTask!, status: "submitting" as const },
      };
      for (const [loaded, expected] of [
        // A refused setup left the repository selected but Devin's own version.
        [
          [...selectedRepoOptions, choice("devin_version", "other"), choice("platform", "macos")],
          ["load", "configure", "prompt"],
        ],
        // A restart after a confirmed setup keeps it.
        [
          [
            ...selectedRepoOptions,
            choice("devin_version", "devin-ultra"),
            choice("platform", "macos"),
          ],
          ["load", "prompt"],
        ],
      ] as const) {
        const calls: string[] = [];
        const completed = yield* Deferred.make<void>();
        const runtime = yield* open(
          relay({
            create: Effect.die("A saved session is never recreated"),
            attach: () =>
              Effect.sync(() => {
                calls.push("load");
                return { configOptions: loaded };
              }),
            configureSource: (_id, _source, selection) =>
              Effect.sync(() => {
                assert.deepEqual(selection, { model: "devin-ultra", platform: "macos" });
                calls.push("configure");
              }),
            prompt: () =>
              Effect.sync(() => {
                calls.push("prompt");
                return { stopReason: "end_turn" as const };
              }),
          }),
          undefined,
          selected,
        );
        yield* Stream.runForEach(runtime.events, (event) =>
          event.type === "turn.terminal" ? Deferred.succeed(completed, undefined) : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* runtime.startTurn({
          ...turnInput,
          providerThread: unprompted,
          commitCloudTask: () => Effect.void,
        });
        yield* Deferred.await(completed);
        assert.deepEqual(calls, [...expected]);
      }
    }),
);
it.effect("same-session follow-up retains source/ID and never resets repos", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const firstDone = yield* Deferred.make<void>();
    const secondDone = yield* Deferred.make<void>();
    let ended = 0;
    let latest = thread;
    const runtime = yield* open(
      relay({
        create: Effect.die("Accepted conversation must not be recreated"),
        configureSource: () => Effect.die("Accepted repos must not be reset"),
        attach: (id) =>
          Effect.sync(() => {
            calls.push(`load:${id}`);
            return { configOptions: selectedRepoOptions };
          }),
        prompt: (id, prompt) =>
          Effect.sync(() => {
            assert.equal(calls.at(-1), `commit:${id}`);
            assert.notInclude(prompt, "Verify the checkout");
            calls.push(`prompt:${id}`);
            return { stopReason: "end_turn" as const };
          }),
      }),
    );
    yield* Stream.runForEach(runtime.events, (event) =>
      Effect.gen(function* () {
        if (event.type === "provider_thread.updated") latest = event.providerThread;
        if (event.type === "turn.terminal")
          yield* Deferred.succeed(++ended === 1 ? firstDone : secondDone, undefined);
      }),
    ).pipe(Effect.forkScoped);
    const commitCloudTask: NonNullable<Adapter.ProviderAdapterV2TurnInput["commitCloudTask"]> = (
      task,
      refs,
    ) =>
      Effect.sync(() => {
        assert.deepEqual(task.source, thread.cloudTask!.source);
        assert.equal(refs?.nativeThreadRef?.nativeId, "devin-fixture-session");
        calls.push(`${task.status === "submitting" ? "commit" : "response"}:${task.taskId}`);
      });
    yield* runtime.startTurn({ ...turnInput, commitCloudTask });
    yield* Deferred.await(firstDone);
    yield* runtime.startTurn({
      ...turnInput,
      runId: RunId.make("run-second"),
      attemptId: RunAttemptId.make("attempt-second"),
      runOrdinal: 2,
      providerTurnOrdinal: 2,
      providerThread: { ...latest, cloudTask: { ...latest.cloudTask!, status: "submitting" } },
      commitCloudTask,
    });
    yield* Deferred.await(secondDone);
    assert.deepEqual(calls, [
      "load:devin-fixture-session",
      "commit:devin-fixture-session",
      "prompt:devin-fixture-session",
      "response:devin-fixture-session",
      "commit:devin-fixture-session",
      "prompt:devin-fixture-session",
      "response:devin-fixture-session",
    ]);
  }),
);
it.effect("a clean published source starts without a local-changes warning flag", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    let prompts = 0;
    const runtime = yield* open(
      relay({
        prompt: () =>
          Effect.sync(() => {
            prompts++;
            return { stopReason: "end_turn" as const };
          }),
      }),
    );
    yield* Stream.runForEach(runtime.events, (event) =>
      event.type === "turn.terminal"
        ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
        : Effect.void,
    ).pipe(Effect.forkScoped);
    yield* runtime.startTurn({
      ...turnInput,
      providerThread: {
        ...thread,
        cloudTask: { ...thread.cloudTask!, localChangesExcluded: false },
      },
      commitCloudTask: (task) =>
        Effect.sync(() => {
          assert.isFalse(task.localChangesExcluded);
        }),
    });
    yield* Deferred.await(completed);
    assert.equal(prompts, 1);
  }),
);
it.effect("failed identity commit/config sends no prompt and never retries creation", () =>
  Effect.gen(function* () {
    for (const mode of ["commit", "config"] as const) {
      let creates = 0;
      let prompts = 0;
      let configs = 0;
      const runtime = yield* open(
        relay({
          create: Effect.sync(() => {
            creates++;
            return { sessionId: "devin-fixture-session", configOptions: repoOptions };
          }),
          configureSource: () =>
            Effect.sync(() => {
              configs++;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new Cli.DevinCloudCliError({ stage: "relay", detail: "Repository unavailable" }),
                ),
              ),
            ),
          prompt: () =>
            Effect.sync(() => {
              prompts++;
              return { stopReason: "end_turn" as const };
            }),
        }),
      );
      const input = {
        ...turnInput,
        providerThread: { ...thread, nativeThreadRef: null },
        commitCloudTask: () =>
          mode === "commit"
            ? Effect.fail(
                new Adapter.ProviderAdapterProtocolError({
                  driver: thread.driver,
                  detail: "Lost run ownership",
                }),
              )
            : Effect.void,
      };
      const result = yield* Effect.result(runtime.startTurn(input));
      assert.isTrue(Result.isFailure(result));
      const retry = yield* Effect.result(runtime.startTurn(input));
      assert.isTrue(Result.isFailure(retry));
      assert.equal(creates, 1);
      assert.equal(prompts, 0);
      assert.equal(configs, mode === "config" ? 1 : 0);
    }
  }),
);
it.effect("binding/missing identity reject load instead of creating a replacement", () =>
  Effect.gen(function* () {
    const runtime = yield* open(relay({ create: Effect.die("No replacement") }));
    for (const nativeThreadRef of [
      null,
      { ...thread.nativeThreadRef!, fingerprint: "different-profile" },
    ]) {
      const result = yield* Effect.result(
        runtime.resumeThread({ providerThread: { ...thread, nativeThreadRef } }),
      );
      assert.isTrue(Result.isFailure(result));
    }
  }),
);
it.effect("closing an active Deferred prompt detaches without cancel or unknown terminal", () =>
  Effect.gen(function* () {
    let cancels = 0;
    let unknown = 0;
    let terminals = 0;
    const entered = yield* Deferred.make<void>();
    const pending = yield* Deferred.make<import("effect-acp/compat").PromptResponse>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* open(
          relay({
            prompt: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(pending))),
            cancel: () =>
              Effect.sync(() => {
                cancels++;
              }),
          }),
        );
        yield* Stream.runForEach(runtime.events, (event) =>
          Effect.sync(() => {
            if (event.type === "turn.terminal") terminals++;
            if (
              event.type === "provider_thread.updated" &&
              event.providerThread.cloudTask?.status === "unknown"
            )
              unknown++;
          }),
        ).pipe(Effect.forkScoped);
        yield* runtime.startTurn({ ...turnInput, commitCloudTask: () => Effect.void });
        yield* Deferred.await(entered);
      }),
    );
    assert.equal(cancels, 0);
    assert.equal(unknown, 0);
    assert.equal(terminals, 0);
  }),
);

it.effect(
  "configuration failure persists ordinal zero; restart with confirmed repo still sends original branch/SHA",
  () =>
    Effect.gen(function* () {
      let saved = thread;
      const calls: string[] = [];
      const failed = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* open(
            relay({
              create: Effect.sync(() => {
                calls.push("create");
                return { sessionId: "devin-fixture-session", configOptions: repoOptions };
              }),
              configureSource: () =>
                Effect.fail(
                  new Cli.DevinCloudCliError({
                    stage: "relay",
                    detail: "Repository configuration failed",
                  }),
                ),
              prompt: () => Effect.die("Configuration failure cannot submit a prompt"),
            }),
          );
          yield* Stream.runForEach(runtime.events, (event) =>
            Effect.gen(function* () {
              if (event.type === "provider_thread.updated") {
                saved = event.providerThread;
                if (saved.cloudTask?.status === "failed")
                  yield* Deferred.succeed(failed, undefined);
              }
            }),
          ).pipe(Effect.forkScoped);
          const result = yield* Effect.result(
            runtime.startTurn({
              ...turnInput,
              providerThread: { ...thread, nativeThreadRef: null },
              commitCloudTask: (task, refs) =>
                Effect.sync(() => {
                  assert.equal(refs?.nativeThreadRef?.ordinal, 0);
                  saved = { ...thread, ...refs, cloudTask: task };
                }),
            }),
          );
          assert.isTrue(Result.isFailure(result));
          yield* Deferred.await(failed);
        }),
      );
      assert.equal(saved.nativeThreadRef?.ordinal, 0);
      const completed = yield* Deferred.make<void>();
      const runtime = yield* open(
        relay({
          create: Effect.die("Restart uses the exact saved ID"),
          configureSource: () => Effect.die("Restart cannot reset repositories"),
          attach: (id) =>
            Effect.sync(() => {
              calls.push(`load:${id}`);
              return { configOptions: selectedRepoOptions };
            }),
          prompt: (id, prompt) =>
            Effect.sync(() => {
              calls.push(`prompt:${id}`);
              assert.include(prompt, "Verify the checkout");
              assert.include(prompt, "branch published");
              assert.include(prompt, "commit " + "a".repeat(40));
              return { stopReason: "end_turn" as const };
            }),
        }),
      );
      yield* Stream.runForEach(runtime.events, (event) =>
        Effect.gen(function* () {
          if (event.type === "provider_thread.updated") saved = event.providerThread;
          if (event.type === "turn.terminal") yield* Deferred.succeed(completed, undefined);
        }),
      ).pipe(Effect.forkScoped);
      yield* runtime.startTurn({
        ...turnInput,
        providerThread: { ...saved, cloudTask: { ...saved.cloudTask!, status: "submitting" } },
        commitCloudTask: () => Effect.void,
      });
      yield* Deferred.await(completed);
      assert.equal(saved.nativeThreadRef?.ordinal, 1);
      assert.deepEqual(calls, [
        "create",
        "load:devin-fixture-session",
        "prompt:devin-fixture-session",
      ]);
    }),
);

it.effect(
  "missing/null/mismatched load repo selection permits no prompt, creation, setter or cancellation",
  () =>
    Effect.gen(function* () {
      for (const configOptions of [
        undefined,
        null,
        repoOptions,
        selectedRepoOptions.map((option) =>
          option.id === "repos" && option.type === "select"
            ? { ...option, currentValue: "acme/other" }
            : option,
        ),
      ]) {
        const calls: string[] = [];
        const runtime = yield* open(
          relay({
            create: Effect.die("No replacement"),
            configureSource: () => Effect.die("No resetting loaded repository"),
            prompt: () => Effect.die("No unconfirmed prompt"),
            cancel: () => Effect.die("No unconfirmed cancellation"),
            attach: (id) =>
              Effect.sync(() => {
                calls.push(id);
                return configOptions === undefined ? {} : { configOptions };
              }),
          }),
        );
        const result = yield* Effect.result(runtime.startTurn(turnInput));
        assert.isTrue(Result.isFailure(result));
        yield* runtime.interruptTurn({
          providerThread: thread,
          providerTurnId: ProviderTurnId.make("unstarted-turn"),
        });
        assert.deepEqual(calls, ["devin-fixture-session"]);
      }
    }),
);

it.effect("existing marker absence and changed source fail before load, creation or prompt", () =>
  Effect.gen(function* () {
    const runtime = yield* open(
      relay({
        create: Effect.die("No replacement"),
        attach: () => Effect.die("No load before source/marker checks"),
        configureSource: () => Effect.die("No setter"),
        prompt: () => Effect.die("No prompt"),
      }),
    );
    const { ordinal: _ordinal, ...unmarked } = thread.nativeThreadRef!;
    for (const input of [
      { ...turnInput, providerThread: { ...thread, nativeThreadRef: unmarked } },
      { ...turnInput, cloudSource: { ...turnInput.cloudSource!, sha: "b".repeat(40) } },
      {
        ...turnInput,
        providerThread: {
          ...thread,
          cloudTask: { ...thread.cloudTask!, status: "running" as const },
        },
      },
    ]) {
      assert.isTrue(Result.isFailure(yield* Effect.result(runtime.startTurn(input))));
    }
  }),
);

it.effect(
  "recovery loads exact saved ID, suppresses history and Stop, preserves summary and accepts late metadata",
  () =>
    Effect.gen(function* () {
      const events: Adapter.ProviderAdapterV2Event[] = [];
      const patches: Adapter.ProviderAdapterV2CloudTaskMetadata[] = [];
      const done = yield* Deferred.make<void>();
      let update:
        | ((notice: import("effect-acp/compat").SessionNotification) => Effect.Effect<void>)
        | undefined;
      const runtime = yield* open(
        relay({
          create: Effect.die("Recovery cannot create"),
          configureSource: () => Effect.die("Recovery cannot configure"),
          prompt: () => Effect.die("Recovery cannot submit"),
          cancel: () => Effect.die("Recovery cannot cancel"),
          attach: (id) =>
            Effect.gen(function* () {
              assert.equal(id, "devin-fixture-session");
              yield* update!(textUpdate("Historical replay"));
              yield* update!({
                sessionId: id,
                update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
              });
              return { configOptions: selectedRepoOptions };
            }),
        }),
        (onUpdate) => {
          update = onUpdate;
        },
      );
      yield* Stream.runForEach(runtime.events, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.terminal") yield* Deferred.succeed(done, undefined);
        }),
      ).pipe(Effect.forkScoped);
      const savedTask = {
        ...thread.cloudTask!,
        status: "running" as const,
        summary: "Original persisted summary",
        url: "https://app.devin.ai/sessions/fixture-session",
      };
      yield* runtime.resumeTurn!({
        ...turnInput,
        cloudTask: savedTask,
        providerThread: { ...thread, cloudTask: savedTask },
        commitCloudTaskMetadata: (_id, patch) =>
          Effect.sync(() => {
            patches.push(patch);
          }),
      });
      yield* Deferred.await(done);
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: ProviderTurnId.make("recovered-turn"),
      });
      yield* update!({
        sessionId: "devin-fixture-session",
        update: { sessionUpdate: "session_info_update", title: "Late title" },
      });
      const latest = events.findLast(
        (event) => event.type === "provider_thread.updated",
      )?.providerThread;
      assert.equal(latest?.cloudTask?.summary, "Original persisted summary");
      assert.equal(latest?.cloudTask?.status, "unknown");
      assert.equal(latest?.nativeThreadRef?.ordinal, 1);
      assert.equal(latest?.cloudTask?.url, "https://app.devin.ai/sessions/fixture-session");
      assert.equal(events.filter((event) => event.type === "message.updated").length, 0);
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
      assert.equal(patches.length, 1);
      assert.equal(patches[0]?.title, "Late title");
    }),
);

it.effect("runtime Stop A after B starts leaves B pending and uncancelled", () =>
  Effect.gen(function* () {
    const events: Adapter.ProviderAdapterV2Event[] = [];
    const finishedA = yield* Deferred.make<void>();
    const enteredB = yield* Deferred.make<void>();
    const finishedB = yield* Deferred.make<void>();
    const responseB = yield* Deferred.make<import("effect-acp/compat").PromptResponse>();
    let prompts = 0;
    let cancels = 0;
    let latest = thread;
    const runtime = yield* open(
      relay({
        prompt: () =>
          Effect.gen(function* () {
            if (++prompts === 1) return { stopReason: "end_turn" as const };
            yield* Deferred.succeed(enteredB, undefined);
            return yield* Deferred.await(responseB);
          }),
        cancel: () =>
          Effect.sync(() => {
            cancels++;
          }),
      }),
    );
    yield* Stream.runForEach(runtime.events, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "provider_thread.updated") latest = event.providerThread;
        if (event.type === "turn.terminal")
          yield* Deferred.succeed(event.runOrdinal === 1 ? finishedA : finishedB, undefined);
      }),
    ).pipe(Effect.forkScoped);
    yield* runtime.startTurn(turnInput);
    yield* Deferred.await(finishedA);
    const turnA = events.find((event) => event.type === "turn.terminal");
    if (turnA?.type !== "turn.terminal") return;
    yield* runtime.startTurn({
      ...turnInput,
      runId: RunId.make("runtime-run-B"),
      attemptId: RunAttemptId.make("runtime-attempt-B"),
      runOrdinal: 2,
      providerTurnOrdinal: 2,
      providerThread: { ...latest, cloudTask: { ...latest.cloudTask!, status: "submitting" } },
    });
    yield* Deferred.await(enteredB);
    const before = latest.cloudTask?.progress;
    yield* runtime.interruptTurn({ providerThread: latest, providerTurnId: turnA.providerTurnId });
    assert.equal(cancels, 0);
    assert.equal(latest.cloudTask?.progress, before);
    assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
    yield* Deferred.succeed(responseB, { stopReason: "end_turn" });
    yield* Deferred.await(finishedB);
    assert.equal(events.filter((event) => event.type === "turn.terminal").length, 2);
    assert.equal(latest.nativeThreadRef?.ordinal, 3);
  }),
);
