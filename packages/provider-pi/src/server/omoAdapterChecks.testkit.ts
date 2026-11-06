import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { OMO_PROFILE } from "./profile.ts";
import type * as Fixture from "./adapter.test.ts";

export function registerOmoAdapterChecks({
  makeFakePi,
  openRuntime,
  THREAD_ID,
  SESSION_ID,
  modelSelection,
  runtimePolicy,
  layerTest,
}: {
  makeFakePi: typeof Fixture.makeFakePi;
  openRuntime: typeof Fixture.openRuntime;
  THREAD_ID: typeof Fixture.THREAD_ID;
  SESSION_ID: typeof Fixture.SESSION_ID;
  modelSelection: typeof Fixture.modelSelection;
  runtimePolicy: typeof Fixture.runtimePolicy;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect("rejects an invalid OmO history page during resume", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        OMO_PROFILE,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueEntries({ entries: [], leafId: null, hasMore: true });
      const error = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.match(String(error.cause), /Page cannot advance/);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("disables OmO computer control when starting and switching sessions", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        OMO_PROFILE,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* runtime.resumeThread({ providerThread });
      fake.vetoNextSwitch();
      yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: { ...providerThread, nativeThreadRef: null },
      });
      const requests = fake.allRequests();
      const commands = requests.flatMap((request, index) =>
        request.type === "prompt" && request.message === "/computer off" ? [index] : [],
      );
      assert.lengthOf(commands, 3);
      for (const type of ["switch_session", "new_session"]) {
        const index = requests.findIndex((request) => request.type === type);
        assert.equal(requests[index + 1]?.message, "/computer off");
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
