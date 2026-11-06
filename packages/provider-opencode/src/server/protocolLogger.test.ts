import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
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
