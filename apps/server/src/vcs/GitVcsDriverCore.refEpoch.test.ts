// @effect-diagnostics nodeBuiltinImport:off - resolves native real paths for the subprocess fixture.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerServerConfig, makeTmpDir, initRepoWithCommit } from "./testing/gitFixture.ts";

it.effect("superseded ref snapshots of one repository do not evict another's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const quietRepo = yield* makeTmpDir();
      const quietRepoRealPath = NodeFS.realpathSync.native(quietRepo);
      const quietRepoScans = yield* Ref.make(0);
      const countingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (
            ChildProcess.isStandardCommand(command) &&
            command.args.includes("for-each-ref") &&
            command.args.includes("refs/remotes") &&
            NodeFS.realpathSync.native(String(command.options.cwd)).startsWith(quietRepoRealPath)
          ) {
            yield* Ref.update(quietRepoScans, (count) => count + 1);
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
      );
      const busyRepo = yield* makeTmpDir();
      yield* initRepoWithCommit(quietRepo).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );
      yield* initRepoWithCommit(busyRepo).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      yield* driver.listRefs({ cwd: quietRepo });
      // More epochs than the snapshot cache holds.
      for (let index = 0; index < 70; index++) {
        yield* driver.invalidateRefs(busyRepo);
        yield* driver.listRefs({ cwd: busyRepo });
      }
      yield* driver.listRefs({ cwd: quietRepo });

      assert.equal(yield* Ref.get(quietRepoScans), 1);
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
