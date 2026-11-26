import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  asyncEventStream,
  makeOpenCodeRuntimeHarness,
  wp4Snapshot,
} from "./adapter.harness.testkit.ts";
import { makeOpenCodeProtocolLogger } from "./adapter.ts";

it.effect("logs bounded structural protocol diagnostics without native payload values", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const records: Array<unknown> = [];
    const nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger = {
      filePath: "/tmp/provider-native.ndjson",
      write: (event) => Effect.sync(() => void records.push(event)),
      close: () => Effect.void,
    };
    const logProtocolEvent = makeOpenCodeProtocolLogger({
      nativeEventLogger,
      idAllocator,
      providerInstanceId: ProviderInstanceId.make("opencode-test"),
      providerSessionId: ProviderSessionId.make("provider-session-opencode-test"),
      threadId: ThreadId.make("thread-opencode-test"),
    });
    const secret = "secret-opencode-prompt";

    yield* logProtocolEvent({
      direction: "outgoing",
      messageKind: "request",
      method: "session.prompt",
      payload: { prompt: secret, nested: { token: secret } },
    });
    yield* logProtocolEvent({
      direction: "incoming",
      messageKind: "notification",
      method: "message.part.delta",
      payload: { type: "message.part.delta", properties: { delta: secret } },
    });

    assert.lengthOf(records, 1);
    const serialized = JSON.stringify(records);
    assert.notInclude(serialized, secret);
    assert.include(serialized, '"protocol":"opencode-sdk.sse"');
    assert.include(serialized, '"method":"session.prompt"');
    assert.include(serialized, '"fieldCount":2');
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("omits memory revoked while the outgoing request log is written", () =>
  Effect.gen(function* () {
    const sessionID = "log-flush";
    const session = { id: sessionID, time: { created: 1, updated: 1 } };
    const snapshot = wp4Snapshot();
    let enabled = true;
    const sent: string[] = [];
    const harness = yield* makeOpenCodeRuntimeHarness(
      "log-flush",
      sessionID,
      {
        event: { subscribe: async () => ({ stream: asyncEventStream().stream }) },
        session: {
          create: async () => ({ data: session }),
          get: async () => ({ data: session }),
          children: async () => ({ data: [] }),
          promptAsync: async (request: { system?: string }) => {
            sent.push(request.system ?? "");
            return { data: true };
          },
        },
      },
      {
        memory: {
          memoryContext: snapshot,
          refreshMemoryContext: () => Effect.succeed(enabled ? snapshot : undefined),
        },
        nativeEventLogger: {
          filePath: "fixture-native.ndjson",
          write: (entry) =>
            Effect.sync(() => {
              if (JSON.stringify(entry).includes('"method":"session.promptAsync"')) enabled = false;
            }),
          close: () => Effect.void,
        },
      },
    );
    yield* harness.startTurn();
    assert.isFalse(enabled);
    assert.lengthOf(sent, 1);
    assert.notInclude(sent[0]!, "external_goat_memory");
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);
