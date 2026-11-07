// @effect-diagnostics nodeBuiltinImport:off -- record fixtures use isolated temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Detached from "./CodexDetachedAppServerLive.ts";
import { makeDetachedAppServers } from "./CodexDetachedAppServer.ts";
import * as Survivors from "./CodexSurvivors.ts";

it.effect("lists every loaded goal block for only the selected Codex instance", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-goal-list-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const dir = NodePath.join(directory, "codex-app-servers");
    yield* Effect.promise(() => NodeFSP.mkdir(dir));
    for (const [instanceId, suffix] of [
      ["codex-a", "aaaaaa"],
      ["codex-a", "bbbbbb"],
      ["codex-b", "cccccc"],
    ] as const) {
      const name = `${instanceId}-${suffix}`;
      const record = {
        version: 1,
        name,
        instanceId,
        socketPath: `/tmp/${name}.sock`,
        pgid: 4321,
        bootId: "boot",
        state: "running",
        createdAt: "2026-01-01T00:00:00Z",
        goalBlocks: [
          { threadId: ThreadId.make(`thread-${suffix}`), nativeThreadId: `native-${suffix}` },
        ],
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, `${name}.json`), JSON.stringify(record)),
      );
    }
    const detached = yield* makeDetachedAppServers({
      stateDir: directory,
      bootId: Effect.succeed("boot"),
      processTable: {
        groupMembers: () => Effect.succeed([]),
        ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
      },
      socketAccepts: () => Effect.succeed(false),
      signalGroup: () => Effect.void,
    });
    yield* detached.loadRecords;
    yield* Effect.gen(function* () {
      const service = yield* Survivors.CodexSurvivors;
      const blocks = yield* service.listGoalBlocksByInstance(ProviderInstanceId.make("codex-a"));
      assert.deepEqual(
        blocks.map((item) => item.record.recordName),
        ["codex-a-aaaaaa", "codex-a-bbbbbb"],
      );
      assert.deepEqual(
        blocks.map((item) => item.block.threadId),
        [ThreadId.make("thread-aaaaaa"), ThreadId.make("thread-bbbbbb")],
      );
      assert.deepEqual(
        yield* service.listGoalBlocksByInstance(ProviderInstanceId.make("missing")),
        [],
      );
    }).pipe(
      Effect.provide(
        Survivors.layer.pipe(
          Layer.provide(
            Layer.succeed(Detached.CodexDetachedAppServers, {
              ...detached,
              socketTransportEnabled: true,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
