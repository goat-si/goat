import { assert, it } from "@effect/vitest";
import type { ProviderReplayEntry } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { toolOutputImages } from "@goat/shared/toolOutput";
import {
  CHILD,
  PROMPT_ID,
  SESSION,
  WORK,
  backgroundLaunch,
  event,
  out,
  promptAccepted,
  reconnected,
  reply,
  resumed,
  turnInput,
  withLineage,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 image jobs", (it) => {
  it.effect.each(["completed", "error", "cancelled"] as const)(
    "retains native image job %s after its launch returns",
    (outcome) =>
      Effect.gen(function* () {
        const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-image" };
        const notice = (sessionID: string) =>
          event("session.inbox.enqueued", {
            sessionID,
            inboxID: `msg_image_${sessionID}`,
            item: {
              type: "synthetic",
              delivery: "steer",
              payload: {
                description: "Image generation",
                text:
                  outcome === "completed"
                    ? "Image outcome retained. Saved image: /work/opencode2/image.png (test/image)."
                    : "Image outcome retained",
                metadata: {
                  source: "experimental_image_generate",
                  jobID: "image_test",
                  state: outcome,
                  path: "/work/opencode2/image",
                },
              },
            },
          });
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.tool.input.started", { ...tool, name: "experimental_image_generate" }),
            event("session.tool.called", { ...tool, input: { prompt: "A tree" }, executed: false }),
            event(
              "session.tool.success",
              {
                ...tool,
                content: [{ type: "text", text: "Job launched" }],
                metadata: {
                  jobID: "image_test",
                  path: "/work/opencode2/image",
                  model: "test/image",
                },
                executed: false,
              },
              undefined,
              2,
            ),
            event("session.execution.succeeded", { sessionID: SESSION }),
            notice("ses_other"),
            notice(SESSION),
            ...(outcome === "completed"
              ? [
                  out("image.read", {
                    path: "/api/fs/read/image.png",
                    "location[directory]": WORK,
                  }),
                  reply("image.read", { imageBase64: "iVBORw0KGgo=" }),
                ]
              : []),
          ],
          { external: true },
        );
        let launched = false;
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => {
            if (e.type !== "provider_thread.updated") return false;
            if (
              e.providerThread.pendingBackgroundTasks?.some((task) => task.taskId === "image_test")
            )
              launched = true;
            return launched && e.pendingBackgroundWork === false;
          }),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        const collected = yield* Fiber.join(events);
        const items = collected.flatMap((e) =>
          e.type === "turn_item.updated" && e.turnItem.nativeItemRef?.nativeId === "call-image"
            ? [e.turnItem]
            : [],
        );
        assert.deepEqual(
          items.map((item) => item.status),
          [
            "running",
            "running",
            "running",
            outcome === "error" ? "failed" : outcome === "cancelled" ? "interrupted" : "completed",
          ],
        );
        assert.include(JSON.stringify(items.at(-1)), "Image outcome retained");
        if (outcome === "completed") {
          const item = items.at(-1);
          assert.deepEqual(item?.type === "dynamic_tool" ? toolOutputImages(item.output) : [], [
            { mimeType: "image/png", data: "iVBORw0KGgo=" },
          ]);
        }
        const rosters = collected.flatMap((e) =>
          e.type === "provider_thread.updated"
            ? [e.providerThread.pendingBackgroundTasks ?? []]
            : [],
        );
        assert.isTrue(rosters.some((tasks) => tasks.some((task) => task.taskId === "image_test")));
        assert.deepEqual(rosters.at(-1), []);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["history", "list", "late-preview"] as const)(
    "recovers native image job outcomes from %s after reconnect",
    (source) =>
      Effect.gen(function* () {
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            ...(() => {
              const frames: Array<ProviderReplayEntry> = reconnected({}, "succeeded", {
                content: [
                  {
                    type: "tool",
                    id: "call-image-gap",
                    name: "experimental_image_generate",
                    executed: false,
                    state: {
                      status: "completed",
                      input: { prompt: "A tree" },
                      content: [{ type: "text", text: "Job launched" }],
                      metadata: { jobID: "image_gap", path: "/tmp/image", model: "test/image" },
                    },
                    time: { created: 2, ran: 2, completed: 2 },
                  },
                ],
              });
              if (source !== "history")
                frames.splice(
                  2,
                  0,
                  out("rpc.call", "<any>"),
                  reply("rpc.call", { output: null }),
                  out("job.list", { kind: "shell" }),
                  reply("job.list", { data: [] }),
                );
              return frames;
            })(),
            out("message.list", { sessionID: SESSION, type: "synthetic", limit: "100" }),
            reply("message.list", {
              data:
                source !== "history"
                  ? []
                  : [
                      {
                        id: "msg_image_gap",
                        time: { created: 3 },
                        type: "synthetic",
                        text: "Recovered image failure",
                        description: "Image generation",
                        metadata: {
                          source: "experimental_image_generate",
                          jobID: "image_gap",
                          state: "error",
                          path: "/tmp/image",
                        },
                      },
                    ],
              cursor: {},
            }),
            ...(source !== "history"
              ? [
                  out("imageJobs", { sessionID: SESSION, kind: "image" }),
                  reply("imageJobs", {
                    data: [
                      {
                        kind: "image",
                        id: "image_gap",
                        sessionID: SESSION,
                        status: source === "late-preview" ? "completed" : "error",
                        path: "/tmp/image",
                        model: "test/image",
                        time: { started: 2, completed: 3 },
                      },
                    ],
                  }),
                ]
              : []),
            ...(source === "late-preview"
              ? [
                  event("session.inbox.enqueued", {
                    sessionID: SESSION,
                    inboxID: "msg_image_late",
                    item: {
                      type: "synthetic",
                      delivery: "steer",
                      payload: {
                        description: "Image generation",
                        text: "Image request finished. Saved image: /tmp/image.png (test/image).",
                        metadata: {
                          source: "experimental_image_generate",
                          jobID: "image_gap",
                          state: "completed",
                          path: "/tmp/image",
                        },
                      },
                    },
                  }),
                  out("image.read", {
                    path: "/api/fs/read/image.png",
                    "location[directory]": "/tmp",
                  }),
                  reply("image.read", { imageBase64: "iVBORw0KGgo=" }),
                ]
              : []),
          ],
          { ...(source !== "history" ? { version: "2.2.6" as const } : {}), external: true },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.nativeItemRef?.nativeId === "call-image-gap" &&
              (source === "late-preview"
                ? e.turnItem.type === "dynamic_tool" &&
                  toolOutputImages(e.turnItem.output).length > 0
                : e.turnItem.status === "failed"),
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        const collected = yield* Fiber.join(events);
        assert.include(
          JSON.stringify(collected.at(-1)),
          source === "late-preview"
            ? "Saved image: /tmp/image.png"
            : source !== "history"
              ? "Image generation error"
              : "Recovered image failure",
        );
        assert.isTrue(
          collected.some(
            (e) =>
              e.type === "provider_thread.updated" &&
              e.providerThread.pendingBackgroundTasks?.some((task) => task.taskId === "image_gap"),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("settles a recovered image outcome when preview I/O is interrupted", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const fs = yield* FileSystem.FileSystem;
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          ...reconnected({}, "succeeded", {
            content: [
              {
                type: "tool",
                id: "call-image-slow",
                name: "experimental_image_generate",
                executed: false,
                state: {
                  status: "completed",
                  input: { prompt: "A tree" },
                  content: [{ type: "text", text: "Launched" }],
                  metadata: { jobID: "image_slow", path: "/tmp/image", model: "test/image" },
                },
                time: { created: 2, ran: 2, completed: 2 },
              },
            ],
          }),
          out("message.list", { sessionID: SESSION, type: "synthetic", limit: "100" }),
          reply("message.list", {
            data: [
              {
                id: "msg_image_slow",
                type: "synthetic",
                time: { created: 3 },
                text: "Image request finished. Saved image: /tmp/image.png (test/image).",
                description: "Image generation",
                metadata: {
                  source: "experimental_image_generate",
                  jobID: "image_slow",
                  state: "completed",
                  path: "/tmp/image",
                },
              },
            ],
            cursor: {},
          }),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { providerID: "opencode", id: "big-pickle", variant: "recovery-observed" },
          }),
        ],
        {
          fileSystem: {
            ...fs,
            stat: (path) =>
              path === "/tmp/image.png"
                ? Deferred.succeed(reading, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                  )
                : fs.stat(path),
          },
        },
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil(
          (e) =>
            e.type === "provider_thread.updated" &&
            e.providerThread.nativeMetadata?.modelSelection?.options?.some(
              (option) => option.value === "recovery-observed",
            ) === true,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* Deferred.await(reading);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(interrupted);
      const collected = yield* Fiber.join(events);
      assert.isTrue(
        collected.some(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.nativeItemRef?.nativeId === "call-image-slow" &&
            e.turnItem.status === "completed",
        ),
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["root", "child"] as const)(
    "settles %s native image tasks when reconnect attempts fail",
    (owner) =>
      Effect.gen(function* () {
        const attempts = yield* Effect.forEach([0, 1, 2, 3, 4], () => Deferred.make<void>());
        let count = 0;
        let failures = 0;
        const borrowers = {
          get current() {
            return count;
          },
          set current(next: number) {
            if (next < count && count === 2) {
              const attempt = attempts[failures++];
              if (attempt !== undefined) Deferred.doneUnsafe(attempt, Effect.void);
            }
            count = next;
          },
        };
        const tool = {
          sessionID: owner === "root" ? SESSION : CHILD,
          assistantMessageID: "msg_assistant",
          id: "call-image-lost",
        };
        const { runtime, thread } = yield* resumed(
          [
            ...(owner === "root"
              ? [out("session.prompt", { sessionID: SESSION, text: "<any>" }), promptAccepted]
              : [
                  ...backgroundLaunch(CHILD),
                  event("session.execution.started", { sessionID: CHILD }),
                ]),
            event("session.tool.input.started", { ...tool, name: "experimental_image_generate" }),
            event(
              "session.tool.success",
              {
                ...tool,
                content: [{ type: "text", text: "Launched" }],
                metadata: { jobID: "image_lost", path: "/tmp/image", model: "test/image" },
                executed: false,
              },
              undefined,
              2,
            ),
            ...(owner === "child"
              ? [event("session.execution.succeeded", { sessionID: CHILD })]
              : []),
            event("session.execution.succeeded", { sessionID: SESSION }),
            { type: "runtime_exit", status: "success" },
          ],
          { borrowers },
        );
        const events = yield* runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
        yield* runtime.startTurn(withLineage(thread));
        yield* Deferred.await(attempts[0]!);
        for (const attempt of attempts.slice(1)) {
          yield* TestClock.adjust("2 seconds");
          yield* Deferred.await(attempt);
        }
        const collected = yield* Fiber.join(events);
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
        assert.isTrue(
          collected.some(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.nativeItemRef?.nativeId ===
                (owner === "root" ? tool.id : `${CHILD}:${tool.id}`) &&
              e.turnItem.status === "failed",
          ),
        );
        const rootSnapshots = collected.flatMap((e) =>
          e.type === "provider_thread.updated" && e.providerThread.id === thread.id ? [e] : [],
        );
        assert.isFalse(rootSnapshots.at(-1)?.pendingBackgroundWork);
        assert.deepEqual(rootSnapshots.at(-1)?.providerThread.pendingBackgroundTasks, []);
        assert.isTrue(
          rootSnapshots.some((e) =>
            e.providerThread.pendingBackgroundTasks?.some((task) => task.taskId === "image_lost"),
          ),
        );
      }).pipe(Effect.scoped),
  );
});
