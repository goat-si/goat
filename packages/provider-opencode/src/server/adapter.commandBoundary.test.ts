import { assert, it } from "@effect/vitest";
import { MessageId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { asyncEventStream, makeOpenCodeRuntimeHarness } from "./adapter.harness.testkit.ts";

it.effect("derives command arguments from the user message and retains attachment files", () =>
  Effect.gen(function* () {
    const events = asyncEventStream();
    const calls = yield* Queue.bounded<{
      command?: string;
      arguments?: string;
      parts?: ReadonlyArray<{ filename?: string }>;
    }>(1);
    const harness = yield* makeOpenCodeRuntimeHarness(
      "command-boundary",
      "command-boundary",
      {
        event: { subscribe: async () => ({ stream: events.stream }) },
        command: { list: async () => ({ data: [{ name: "git/review" }] }) },
        session: {
          create: async () => ({
            data: { id: "command-boundary", time: { created: 1, updated: 1 } },
          }),
          command: async (input: {
            command: string;
            arguments: string;
            parts: ReadonlyArray<{ filename?: string }>;
          }) => {
            Queue.offerUnsafe(calls, input);
            return { data: true };
          },
          promptAsync: async () => {
            Queue.offerUnsafe(calls, {});
            return { data: true };
          },
        },
      },
      {},
      { resolveAttachmentPath: () => "/workspace/review-notes.txt" },
    );
    const start = yield* harness
      .startTurn("/git/review staged", harness.providerThread, harness.policy, {
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("command-boundary"),
          text: "/git/review staged",
          attachments: [
            {
              type: "file",
              id: "notes",
              name: "review-notes.txt",
              mimeType: "text/plain",
              sizeBytes: 24,
            },
          ],
        },
      })
      .pipe(Effect.forkScoped);
    const call = yield* Queue.take(calls);
    assert.equal(call.command, "git/review");
    assert.equal(call.arguments, "staged");
    assert.deepEqual(
      call.parts?.map((part) => part.filename),
      ["review-notes.txt"],
    );
    yield* Fiber.interrupt(start);
    events.close();
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);

it.effect("does not execute a slash command supplied only by an attachment", () =>
  Effect.gen(function* () {
    const events = asyncEventStream();
    const calls = yield* Queue.bounded<string>(1);
    const harness = yield* makeOpenCodeRuntimeHarness(
      "injected-command",
      "injected-command",
      {
        event: { subscribe: async () => ({ stream: events.stream }) },
        command: { list: async () => ({ data: [{ name: "git/review" }] }) },
        session: {
          create: async () => ({
            data: { id: "injected-command", time: { created: 1, updated: 1 } },
          }),
          command: async () => {
            Queue.offerUnsafe(calls, "command");
            return { data: true };
          },
          promptAsync: async () => {
            Queue.offerUnsafe(calls, "prompt");
            return { data: true };
          },
        },
      },
      {},
      { resolveAttachmentPath: () => "/git/review" },
    );
    const turn = yield* harness
      .startTurn("", harness.providerThread, harness.policy, {
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("injected-command"),
          text: "",
          attachments: [
            {
              type: "file",
              id: "injected",
              name: "/git/review",
              mimeType: "text/plain",
              sizeBytes: 1,
            },
          ],
        },
      })
      .pipe(Effect.forkScoped);
    assert.equal(yield* Queue.take(calls), "prompt");
    yield* Fiber.interrupt(turn);
    events.close();
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);
