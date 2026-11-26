import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Settings from "../serverSettings.ts";
import { issueConversationMemoryPermit } from "./MemoryAccess.ts";

it.effect("pausing and resuming conversation memory preserves the configured preferences", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const policy = yield* Settings.MemoryProviderCommittedPolicy;
    const original = yield* policy.read;
    const permit = yield* issueConversationMemoryPermit(policy.read);
    expect(permit).toBeDefined();
    yield* settings.updateSettings({ conversationMemoryEnabled: false });
    const paused = yield* settings.getSettings;
    expect(paused.enableAgentMemoryAccess).toBe(true);
    expect(paused.memoryEnabled).toBe(false);
    expect((yield* policy.read).enableAgentMemoryAccess).toBe(false);
    expect(yield* issueConversationMemoryPermit(policy.read)).toBeUndefined();
    yield* settings.updateSettings({ conversationMemoryEnabled: true });
    const resumed = yield* settings.getSettings;
    expect(resumed.enableAgentMemoryAccess).toBe(true);
    expect(resumed.memoryEnabled).toBe(false);
    expect(yield* policy.read).toEqual({ ...original, epoch: original.epoch + 2 });
    expect((yield* Effect.result(permit!))._tag).toBe("Failure");
    const fresh = yield* issueConversationMemoryPermit(policy.read);
    expect((yield* Effect.result(fresh!))._tag).toBe("Success");
  }).pipe(Effect.provide(Settings.layerTest({ memoryEnabled: false }, "memoryHub"))),
);

it.effect("resuming keeps a disabled provider grant disabled", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const policy = yield* Settings.MemoryProviderCommittedPolicy;
    yield* settings.updateSettings({ conversationMemoryEnabled: false });
    const paused = yield* policy.read;
    yield* settings.updateSettings({ enableAgentMemoryAccess: false });
    yield* settings.updateSettings({ conversationMemoryEnabled: true });
    expect((yield* settings.getSettings).enableAgentMemoryAccess).toBe(false);
    expect(yield* policy.read).toEqual(paused);
  }).pipe(Effect.provide(Settings.layerTest({}, "memoryHub"))),
);
