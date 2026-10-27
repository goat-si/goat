import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Journal from "./ChildReadyJournal.ts";

const home = EnvironmentId.make("home-env");
const operation: Journal.ChildReadyOperation = {
  operationId: "op-1",
  homeEnvironmentId: home,
  destinationEnvironmentId: EnvironmentId.make("child-env"),
  setup: {
    version: 1,
    operationId: "op-1",
    destinationEnvironmentId: EnvironmentId.make("child-env"),
    homeEnvironmentId: home,
    instanceId: ProviderInstanceId.make("goat_ocx_0123456789abcdef01234567"),
    revision: { epoch: "e", sequence: 1 },
    steps: [],
    readiness: "verifying",
    attribution: "unproven",
    nextAction: "none",
  },
};

/** Builds a journal over one state directory, so a second build reads what the first wrote. */
const journalAt = Effect.fn("ChildReadyJournal.test.journalAt")(function* (stateDir: string) {
  const config = yield* ServerConfig.ServerConfig;
  return yield* Journal.make.pipe(
    Effect.provideService(ServerConfig.ServerConfig, { ...config, stateDir }),
  );
});
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "goat-child-journal-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("ChildReadyJournal", (it) => {
  it.effect("publishes an operation only after its file is durably written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "child-journal-" });
      const first = yield* journalAt(dir);
      yield* first.put(home, operation);
      const reopened = yield* journalAt(dir);
      expect(yield* reopened.read(home)).toEqual(operation);
    }),
  );

  it.effect("retains a corrupt journal and reports storage failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "child-journal-" });
      const file = path.join(dir, "opencodex-child-ready.json");
      yield* fs.writeFileString(file, "{ not json");
      const journal = yield* journalAt(dir);
      expect((yield* journal.read(home).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* journal.put(home, operation).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* fs.readFileString(file)).toBe("{ not json");
    }),
  );

  it.effect("marks an interrupted operation unverified after restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "child-journal-" });
      yield* (yield* journalAt(dir)).put(home, { ...operation, running: "inference_verified" });
      const restarted = yield* (yield* journalAt(dir)).read(home);
      expect(restarted?.running).toBeUndefined();
      expect(restarted?.setup).toMatchObject({
        readiness: "invalid",
        failure: { code: "interrupted", step: "inference_verified" },
        nextAction: "retry",
      });
    }),
  );
});
