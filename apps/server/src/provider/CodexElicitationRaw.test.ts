import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { autoApproveRawMcpElicitation } from "./CodexMcpElicitation.ts";

it("cancels if raw request parameters are unavailable", () => {
  assert.deepEqual(
    autoApproveRawMcpElicitation(
      { mode: "form", requestedSchema: { type: "object", properties: {}, required: [] } },
      undefined,
    ),
    { action: "cancel" },
  );
});

it.effect("uses the unmodified wire schema for full-access auto approval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
      const output = yield* Queue.unbounded<string>();
      const decoder = new TextDecoder();
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(input),
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Queue.offer(output, typeof chunk === "string" ? chunk : decoder.decode(chunk)),
          ),
        stderr: () => Sink.drain,
      });
      const client = yield* CodexClient.make(stdio);
      yield* client.handleServerRequest("mcpServer/elicitation/request", (payload, rawParams) =>
        Effect.succeed(autoApproveRawMcpElicitation(payload, rawParams)),
      );
      const schema = {
        type: "object",
        properties: { approval: { type: "string", enum: ["once", "always"] } },
        required: ["approval"],
      };
      const variants = [
        {
          schema: {
            ...schema,
            properties: {
              approval: {
                ...schema.properties.approval,
                enumNames: ["Always allow", "Allow once"],
              },
            },
          },
          action: "cancel",
        },
        { schema: { ...schema, unknown_annotation: "changed" }, action: "cancel" },
        { schema, action: "accept" },
      ];
      for (const [index, variant] of variants.entries()) {
        const request = {
          id: index + 1,
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread",
            turnId: "turn",
            serverName: "browser",
            mode: "form",
            message: "Allow access?",
            requestedSchema: variant.schema,
          },
        };
        yield* Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(request)}\n`));
        const response: unknown = JSON.parse(yield* Queue.take(output));
        assert.deepEqual(response, {
          id: index + 1,
          result:
            variant.action === "accept"
              ? { action: "accept", content: { approval: "once" } }
              : { action: "cancel" },
        });
      }
    }),
  ),
);
