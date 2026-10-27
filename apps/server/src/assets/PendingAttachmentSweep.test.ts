import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AttachmentFileLeases from "./AttachmentFileLeases.ts";
import { issueAttachmentUploadUrl } from "./AttachmentUpload.ts";
import * as PendingAttachmentSweep from "./PendingAttachmentSweep.ts";
import { nodeSweepFileSystem, type SweepFileSystem } from "./PendingAttachmentSweepCursor.ts";

const testLayer = (fileSystem: SweepFileSystem) =>
  Layer.merge(PendingAttachmentSweep.layerWithFileSystem(fileSystem), ServerSecretStore.layer).pipe(
    Layer.provideMerge(AttachmentFileLeases.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-sweep-owner-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect(
  "URL issuance settles during held enumeration and burst requests coalesce behind the interval",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const secondPass = yield* Deferred.make<void>();
      const release = Promise.withResolvers<void>();
      let opens = 0;
      let closes = 0;
      yield* Effect.gen(function* () {
        const owner = yield* PendingAttachmentSweep.PendingAttachmentSweep;
        yield* Deferred.await(started);
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const signingKey = yield* secrets.getOrCreateRandom("asset-access-signing-key", 32);
        const issued = yield* Deferred.make<void>();
        const url = yield* issueAttachmentUploadUrl({
          name: "x.png",
          mimeType: "image/png",
          sizeBytes: 6,
        }).pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, {
            ...secrets,
            getOrCreateRandom: () => Effect.succeed(signingKey),
          }),
          Effect.tap(() => Deferred.succeed(issued, undefined)),
          Effect.forkScoped,
        );
        for (let n = 0; n < 1000; n++) yield* owner.request;
        yield* TestClock.adjust(0);
        const settledBeforeRelease = yield* Deferred.isDone(issued);
        release.resolve();
        yield* Deferred.await(finished);
        yield* Fiber.join(url);
        yield* TestClock.adjust(0);
        expect(settledBeforeRelease).toBe(true);
        expect({ opens, closes }).toEqual({ opens: 1, closes: 1 });
        yield* TestClock.adjust(15 * 60_000);
        yield* Deferred.await(secondPass);
        expect(opens).toBe(2);
      }).pipe(
        Effect.provide(
          testLayer({
            ...nodeSweepFileSystem,
            open: async () => {
              opens++;
              if (opens === 1) {
                Deferred.doneUnsafe(started, Effect.void);
                await release.promise;
              }
              return {
                read: async () => null,
                close: async () => {
                  closes++;
                  Deferred.doneUnsafe(closes === 1 ? finished : secondPass, Effect.void);
                },
              };
            },
          }),
        ),
        Effect.ensuring(Effect.sync(() => release.resolve())),
      );
    }),
);

it.effect("scope shutdown waits for an admitted directory receipt and closes the only handle", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = Promise.withResolvers<void>();
    let opens = 0;
    let closes = 0;
    const owner = yield* Effect.gen(function* () {
      yield* PendingAttachmentSweep.PendingAttachmentSweep;
      yield* Effect.never;
    }).pipe(
      Effect.provide(
        testLayer({
          ...nodeSweepFileSystem,
          open: async () => {
            opens++;
            Deferred.doneUnsafe(started, Effect.void);
            await release.promise;
            return {
              read: async () => null,
              close: async () => {
                closes++;
              },
            };
          },
        }),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    const stopped = yield* Deferred.make<void>();
    const stopping = yield* Fiber.interrupt(owner).pipe(
      Effect.andThen(Deferred.succeed(stopped, undefined)),
      Effect.forkScoped,
    );
    yield* TestClock.adjust(0);
    const stoppedBeforeReceipt = yield* Deferred.isDone(stopped);
    release.resolve();
    yield* Fiber.join(stopping);
    expect(stoppedBeforeReceipt).toBe(false);
    expect({ opens, closes }).toEqual({ opens: 1, closes: 1 });
  }),
);
