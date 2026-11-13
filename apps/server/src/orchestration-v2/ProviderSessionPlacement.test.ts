import { assert, it } from "@effect/vitest";
import {
  type CodexAppServerIsolation,
  CODEX_APP_SERVER_ISOLATION_DEFAULT,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { CODEX_TRANSPORT_ENV } from "../provider/CodexDetachedAppServerLive.ts";
import { keptProviderSessionId, makeProviderSessionPlacement } from "./ProviderSessionPlacement.ts";

const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const otherInstanceId = ProviderInstanceId.make("codex-work");
const exclusive: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};
const sharedId = IdAllocator.derive.providerSession({ providerInstanceId: instanceId });
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const adapterWith = (capabilities: OrchestrationV2ProviderCapabilities, driver = codex) =>
  ({ driver, getCapabilities: () => Effect.succeed(capabilities) }) as Pick<
    ProviderAdapter.ProviderAdapterV2["Service"],
    "driver" | "getCapabilities"
  >;

const place = (settings: { readonly codexAppServerIsolation: CodexAppServerIsolation }) =>
  IdAllocator.IdAllocatorV2.pipe(
    Effect.flatMap((idAllocator) =>
      makeProviderSessionPlacement({ idAllocator, settings: Effect.succeed(settings) }),
    ),
    Effect.provide(IdAllocator.layer),
  );

const providerThread = (providerSessionId: ProviderSessionId | null) =>
  ({
    id: ProviderThreadId.make("provider-thread-a"),
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadA,
    createdAt: DateTime.makeUnsafe(0),
  }) as OrchestrationV2ProviderThread;

it.effect.each([
  { name: "Windows", platform: "win32", environment: {}, expected: sharedId },
  {
    name: "forced stdio",
    platform: "linux",
    environment: { [CODEX_TRANSPORT_ENV]: "stdio" },
    expected: sharedId,
  },
  ...(["darwin", "linux"] as const).map((platform) => ({
    name: `${platform} auto`,
    platform,
    environment: {},
    expected: IdAllocator.derive.providerSession({
      providerInstanceId: instanceId,
      threadId: threadA,
    }),
  })),
] as const)(
  "thread isolation uses the available placement on $name",
  ({ platform, environment, expected }) =>
    Effect.gen(function* () {
      const { providerSessionIdFor } = yield* place({ codexAppServerIsolation: "thread" });
      assert.strictEqual(
        yield* providerSessionIdFor({
          adapter: adapterWith(CodexProviderCapabilitiesV2) as never,
          providerInstanceId: instanceId,
          threadId: threadA,
        }),
        expected,
      );
    }).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Environment, environment),
    ),
);

it.effect("thread isolation gives each new root thread its own deterministic session", () =>
  Effect.gen(function* () {
    const { providerSessionIdFor } = yield* place({ codexAppServerIsolation: "thread" });
    const adapter = adapterWith(CodexProviderCapabilitiesV2);
    const a = yield* providerSessionIdFor({
      adapter: adapter as never,
      providerInstanceId: instanceId,
      threadId: threadA,
    });
    const again = yield* providerSessionIdFor({
      adapter: adapter as never,
      providerInstanceId: instanceId,
      threadId: threadA,
    });
    const b = yield* providerSessionIdFor({
      adapter: adapter as never,
      providerInstanceId: instanceId,
      threadId: threadB,
    });
    assert.strictEqual(a, "provider-session:provider-instance:codex:thread:thread-a");
    assert.strictEqual(again, a);
    assert.notStrictEqual(b, a);
  }),
);

it.effect(
  "shared isolation, the shipped default, keeps every thread on the instance's shared session",
  () =>
    Effect.gen(function* () {
      assert.strictEqual(CODEX_APP_SERVER_ISOLATION_DEFAULT, "shared");
      const { providerSessionIdFor } = yield* place({ codexAppServerIsolation: "shared" });
      const adapter = adapterWith(CodexProviderCapabilitiesV2);
      assert.strictEqual(
        yield* providerSessionIdFor({
          adapter: adapter as never,
          providerInstanceId: instanceId,
          threadId: threadA,
        }),
        sharedId,
      );
      assert.strictEqual(
        yield* providerSessionIdFor({
          adapter: adapter as never,
          providerInstanceId: instanceId,
          threadId: threadB,
        }),
        sharedId,
      );
    }),
);

it.effect("adapters with one thread per session still get a fresh random session", () =>
  Effect.gen(function* () {
    const { providerSessionIdFor } = yield* place({ codexAppServerIsolation: "thread" });
    const adapter = adapterWith(exclusive, ProviderDriverKind.make("claudeAgent"));
    const first = yield* providerSessionIdFor({
      adapter: adapter as never,
      providerInstanceId: instanceId,
      threadId: threadA,
    });
    const second = yield* providerSessionIdFor({
      adapter: adapter as never,
      providerInstanceId: instanceId,
      threadId: threadA,
    });
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first, sharedId);
  }),
);

it.effect("thread isolation does not split sessions of a non-Codex shared-session adapter", () =>
  Effect.gen(function* () {
    const { providerSessionIdFor } = yield* place({ codexAppServerIsolation: "thread" });
    const adapter = adapterWith(CodexProviderCapabilitiesV2, ProviderDriverKind.make("opencode"));
    assert.strictEqual(
      yield* providerSessionIdFor({
        adapter: adapter as never,
        providerInstanceId: instanceId,
        threadId: threadA,
      }),
      sharedId,
    );
  }),
);

const restartAndResume = (stored: ProviderSessionId) => ({
  providerThread: providerThread(stored),
  providerInstanceId: instanceId,
  canResumeAcrossInstances: false,
  // A restart_and_resume releases the session the thread was on.
  releaseProviderSessionIds: [stored],
  capabilities: CodexProviderCapabilitiesV2,
});

it("under thread isolation, a :shared thread whose session cwd no longer matches keeps :shared after a model change", () => {
  assert.strictEqual(keptProviderSessionId(restartAndResume(sharedId)), sharedId);
});

it("under shared isolation, a per-thread session survives a worktree handoff plus a model change", () => {
  const perThread = IdAllocator.derive.providerSession({
    providerInstanceId: instanceId,
    threadId: threadA,
  });
  assert.strictEqual(keptProviderSessionId(restartAndResume(perThread)), perThread);
});

it("a thread derives a new session only without a stored one or after its instance changes", () => {
  assert.isNull(
    keptProviderSessionId({ ...restartAndResume(sharedId), providerThread: providerThread(null) }),
  );
  assert.isNull(
    keptProviderSessionId({ ...restartAndResume(sharedId), canResumeAcrossInstances: true }),
  );
  assert.isNull(
    keptProviderSessionId({ ...restartAndResume(sharedId), providerInstanceId: otherInstanceId }),
  );
});

it("adapters with one thread per session still replace a released session", () => {
  const stored = ProviderSessionId.make("provider-session:random");
  assert.isNull(keptProviderSessionId({ ...restartAndResume(stored), capabilities: exclusive }));
  assert.strictEqual(
    keptProviderSessionId({
      ...restartAndResume(stored),
      capabilities: exclusive,
      releaseProviderSessionIds: [],
    }),
    stored,
  );
});
it.effect(
  "a new thread on a model the shared Codex process predates or holds outdated opens its own process",
  () =>
    Effect.gen(function* () {
      const addedModel = "combo/deepseek-flash-pool";
      const changedModel = "morph/morph-dsv41flash-1017";
      const threadC = ThreadId.make("thread-c");
      const { providerSessionIdFor } = yield* IdAllocator.IdAllocatorV2.pipe(
        Effect.flatMap((idAllocator) =>
          makeProviderSessionPlacement({
            idAllocator,
            settings: Effect.succeed({ codexAppServerIsolation: "shared" }),
            // The shared process started before the model was added to Codex's catalog.
            sessions: {
              get: (id) =>
                Effect.succeed(
                  id === sharedId
                    ? Option.some({
                        // Placement runs on the serial dispatch path, so it may only read memory.
                        modelStatus: (model, options) =>
                          options?.cachedOnly === true
                            ? Effect.succeed(
                                model === addedModel
                                  ? "predated"
                                  : model === changedModel
                                    ? "outdated"
                                    : "ready",
                              )
                            : Effect.die("placement asked the process"),
                      })
                    : Option.none(),
                ),
            },
          }),
        ),
        Effect.provide(IdAllocator.layer),
      );
      const placeOn = (threadId: ThreadId, model: string) =>
        providerSessionIdFor({
          adapter: adapterWith(CodexProviderCapabilitiesV2) as never,
          providerInstanceId: instanceId,
          threadId,
          model,
        });
      assert.strictEqual(
        yield* placeOn(threadA, addedModel),
        IdAllocator.derive.providerSession({ providerInstanceId: instanceId, threadId: threadA }),
      );
      // Its catalog entry changed after the shared process started, so a new one reads the change.
      assert.strictEqual(
        yield* placeOn(threadC, changedModel),
        IdAllocator.derive.providerSession({ providerInstanceId: instanceId, threadId: threadC }),
      );
      assert.strictEqual(yield* placeOn(threadB, "gpt-5.4"), sharedId);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, {}),
    ),
);
