import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { asyncEventStream, makeOpenCodeRuntimeHarness } from "./adapter.harness.testkit.ts";

describe("OpenCode resumed task subagents", () => {
  // After a restart the adapter no longer holds the child, so its earlier turns come from OpenCode.
  it.effect.each([
    { case: "in memory", restarted: false },
    { case: "after a restart", restarted: true },
  ])("appends a resumed task child's turn after its earlier turns ($case)", ({ restarted }) =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
      const root = "ses_root";
      const child = "ses_child";
      let promptId = "";
      const harness = yield* makeOpenCodeRuntimeHarness("resumed-child", root, {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
          get: async () => ({
            data: { id: child, parentID: root, permission: [], time: { created: 2, updated: 2 } },
          }),
          update: async () => ({ data: { id: child, parentID: root } }),
          promptAsync: async (input: { messageID: string }) => {
            promptId = input.messageID;
            return { data: true };
          },
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
          // OpenCode may have stored the resume prompt before its event reaches the adapter.
          messages: async () => ({
            data: [
              { info: { id: "msg_child_first", role: "user" }, parts: [] },
              { info: { id: "msg_child_resume", role: "user" }, parts: [] },
            ],
          }),
        },
      });
      yield* harness.startTurn();
      const childTurns = yield* harness.runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.status === "running" &&
            event.providerTurn.providerThreadId.includes(child),
        ),
        Stream.take(restarted ? 1 : 2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const taskPart = (partId: string, status: "running" | "completed", taskId?: string) => ({
        type: "message.part.updated",
        properties: {
          sessionID: root,
          part: {
            id: partId,
            sessionID: root,
            messageID: "msg_root_assistant",
            type: "tool",
            tool: "task",
            callID: `call_${partId}`,
            state: {
              status,
              input: {
                description: "Explore",
                prompt: "look around",
                subagent_type: "general",
                ...(taskId === undefined ? {} : { task_id: taskId }),
              },
              title: "Explore",
              metadata: { parentSessionId: root, sessionId: child },
              time: { start: 3, ...(status === "completed" ? { end: 4 } : {}) },
              ...(status === "completed" ? { output: "done" } : {}),
            },
          },
        },
      });
      const childPrompt = (id: string, created: number) => ({
        type: "message.updated",
        properties: {
          sessionID: child,
          info: { id, sessionID: child, role: "user", time: { created } },
        },
      });
      const status = (sessionID: string, type: "busy" | "idle") => ({
        type: "session.status",
        properties: { sessionID, status: { type } },
      });

      yield* push({
        type: "message.updated",
        properties: {
          sessionID: root,
          info: { id: promptId, sessionID: root, role: "user", time: { created: 1 } },
        },
      });
      yield* push(status(root, "busy"));
      if (!restarted) {
        yield* push(taskPart("prt_task_first", "running"));
        yield* push(childPrompt("msg_child_first", 3));
        yield* push(status(child, "busy"));
        yield* push(status(child, "idle"));
        yield* push({ type: "session.idle", properties: { sessionID: child } });
        yield* push(taskPart("prt_task_first", "completed"));
      }
      // The lead resumes the same child session by passing its task_id.
      yield* push(taskPart("prt_task_resume", "running", child));
      yield* push(childPrompt("msg_child_resume", 5));
      yield* push(status(child, "busy"));

      const turns = Array.from(yield* Fiber.join(childTurns)).flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn] : [],
      );
      assert.equal(new Set(turns.map((turn) => turn.providerThreadId)).size, 1);
      assert.deepEqual(
        turns.map((turn) => turn.ordinal),
        restarted ? [2] : [1, 2],
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});
