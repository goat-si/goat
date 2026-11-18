import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { shell } from "../../storageCleanup.testFixtures.ts";
import { WorktreeSnapshotStore } from "../../worktreeSnapshots/WorktreeSnapshotStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { layerRealGit } from "../ProviderTurnStartService.testkit.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import { makePrepareTurnWorkspace } from "./prepareTurnWorkspace.ts";
import * as ThreadWorkspace from "./ThreadWorkspaceService.ts";

const threadId = ThreadId.make("thread-scratch");

// A No project thread whose folder a person deleted from Settings → Storage.
const reopen = (via: "turn" | "terminal", where: "scratch" | "nested" | "elsewhere") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const base = yield* fs.realPath(config.baseDir);
    const scratch = path.join(base, "scratch");
    yield* fs.makeDirectory(scratch, { recursive: true });
    const folder =
      where === "scratch"
        ? path.join(scratch, "2026-11-01-notes")
        : where === "nested"
          ? path.join(scratch, "group", "2026-11-01-notes")
          : path.join(base, "elsewhere", "2026-11-01-notes");
    yield* fs.makeDirectory(path.dirname(folder), { recursive: true });
    const thread = shell({ id: threadId, branch: null, worktreePath: folder });
    const fakes = Layer.mergeAll(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getThreadShell: () => Effect.succeed(thread),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Layer.succeed(ProjectService.ProjectService, {
        getById: () => Effect.succeedSome({ id: "scratch" as ProjectId, workspaceRoot: scratch }),
      } as unknown as ProjectService.ProjectService["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        dispatch: () => Effect.void,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(WorktreeSnapshotStore, {
        capture: () => Effect.die("unused"),
        latestForThread: () => Effect.succeed(null),
        markRestored: () => Effect.void,
        deleteForThread: () => Effect.succeed(0),
        purgeDeletedThreads: () => Effect.succeed(0),
        expire: () => Effect.succeed(0),
      }),
      Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      }),
    );
    let ready = true;
    if (via === "turn") {
      const prepare = yield* makePrepareTurnWorkspace.pipe(Effect.provide(fakes));
      ready = (yield* prepare({ ...thread, worktreePath: folder, branch: null }))._tag === "Ready";
    } else {
      const service = yield* ThreadWorkspace.ThreadWorkspaceService.pipe(
        Effect.provide(ThreadWorkspace.layer.pipe(Layer.provide(fakes))),
      );
      yield* service.prepareTerminal({ threadId, cwd: folder });
    }
    const present = yield* fs.exists(folder);
    return { ready, present, entries: present ? yield* fs.readDirectory(folder) : null };
  }).pipe(
    Effect.provide(
      layerRealGit.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettings.layerTest(),
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-scratch-reopen-" }),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );

it.effect.each(["turn", "terminal"] as const)(
  "a No project thread's next %s starts in an empty folder in place of the deleted one",
  (via) =>
    Effect.gen(function* () {
      const { ready, present, entries } = yield* reopen(via, "scratch");
      assert.isTrue(ready);
      assert.isTrue(present);
      assert.deepEqual(entries, []);
    }),
);

it.effect.each(["nested", "elsewhere"] as const)(
  "a missing folder %s, not directly in the scratch folder, is not made",
  (where) =>
    Effect.gen(function* () {
      const { present } = yield* reopen("turn", where);
      assert.isFalse(present);
    }),
);
