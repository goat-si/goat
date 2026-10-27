import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as AttachmentFileLeases from "./AttachmentFileLeases.ts";

const id = "pending-00000000-0000-4000-8000-000000000001";
const layer = AttachmentFileLeases.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-file-leases-" })),
);

it.effect("excludes every alias while a writer is active without blocking another attachment", () =>
  Effect.gen(function* () {
    const leases = yield* AttachmentFileLeases.AttachmentFileLeases;
    const config = yield* ServerConfig.ServerConfig;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const writer = yield* leases
      .withAttachment(
        id,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    let deleted = 0;
    const remove = Effect.sync(() => {
      deleted++;
      return "deleted" as const;
    });
    for (const suffix of [
      ".png",
      ".png.txt",
      ".png.00000000-0000-4000-8000-000000000003.part",
      ".ipynb.txt.part",
    ]) {
      expect(
        yield* leases.withInactiveFile(`${config.attachmentsDir}/${id}${suffix}`, remove),
      ).toBe("kept");
    }
    expect(
      yield* leases.withAttachment(
        "pending-00000000-0000-4000-8000-000000000002",
        Effect.succeed("independent"),
      ),
    ).toBe("independent");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(writer);
    expect(yield* leases.withInactiveFile(`${config.attachmentsDir}/${id}.png`, remove)).toBe(
      "deleted",
    );
    expect(yield* leases.withInactiveFile(`${config.attachmentsDir}/unknown.part`, remove)).toBe(
      "unknown",
    );
    expect(yield* leases.withInactiveFile(`/elsewhere/${id}.png`, remove)).toBe("unknown");
    expect(yield* leases.withInactiveFile(`${config.attachmentsDir}/${id}.part`, remove)).toBe(
      "unknown",
    );
    for (const extension of ["mp4", "webm"]) {
      expect(
        yield* leases.withInactiveFile(
          `${config.attachmentsDir}/${id}-${extension}.${extension}`,
          remove,
        ),
      ).toBe("unknown");
    }
    expect(deleted).toBe(1);
  }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("holds a deletion lease through its IO receipt and then admits a waiting writer", () =>
  Effect.gen(function* () {
    const leases = yield* AttachmentFileLeases.AttachmentFileLeases;
    const config = yield* ServerConfig.ServerConfig;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const events: string[] = [];
    const deletion = yield* leases
      .withInactiveFile(
        `${config.attachmentsDir}/${id}.png`,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          events.push("receipt");
          return "deleted" as const;
        }),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const writer = yield* leases
      .withAttachment(
        id,
        Effect.sync(() => events.push("writer")),
      )
      .pipe(Effect.forkScoped);
    const interruption = yield* Fiber.interrupt(deletion).pipe(Effect.forkScoped);
    expect(events).toEqual([]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interruption);
    yield* Fiber.join(writer);
    expect(events).toEqual(["receipt", "writer"]);
  }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
