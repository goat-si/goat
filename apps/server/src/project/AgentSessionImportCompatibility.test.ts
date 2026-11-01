import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AgentSessionImportInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const decodeImport = Schema.decodeUnknownEffect(AgentSessionImportInput);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

const testLayer = persistence.pipe(Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = DateTime.makeUnsafe("2026-09-01T12:00:00.000Z");
  const nowMs = DateTime.toEpochMillis(now);
  yield* TestClock.setTime(nowMs);
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-import-compatibility-" });
  const workspace = path.join(root, "workspace");
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const piHome = path.join(root, "pi");
  yield* fs.makeDirectory(workspace);
  const write = Effect.fn("ImportCompatibility.write")(function* (
    file: string,
    records: ReadonlyArray<unknown>,
    mtime: number,
  ) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(
      file,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    yield* fs.utimes(file, mtime / 1000, mtime / 1000);
  });
  const claudeId = "020e7f00-dce6-406b-8ec6-ed90498945d6";
  const timestamp = DateTime.formatIso(now);
  yield* write(
    path.join(claudeHome, "projects", "shared", `${claudeId}.jsonl`),
    [
      {
        type: "user",
        cwd: workspace,
        sessionId: claudeId,
        timestamp,
        message: { role: "user", content: "Claude history" },
      },
    ],
    nowMs - 20_000,
  );
  yield* write(
    path.join(codexHome, "sessions", "2026", "09", "01", "rollout-codex.jsonl"),
    [
      { type: "session_meta", payload: { id: "codex-history", cwd: workspace } },
      { type: "event_msg", timestamp, payload: { type: "user_message", message: "Codex history" } },
    ],
    nowMs - 30_000,
  );
  // Every Pi file is newer; including these would exhaust the 100-transcript budget first.
  for (let index = 0; index < 100; index += 1) {
    yield* write(
      path.join(piHome, "sessions", "shared", `pi-${index}.jsonl`),
      [
        { type: "session", version: 3, id: `pi-${index}`, cwd: workspace },
        {
          type: "message",
          id: "m1",
          parentId: null,
          timestamp,
          message: { role: "user", content: "Pi history" },
        },
      ],
      nowMs - index - 1,
    );
  }
  const scannerContext = yield* Layer.build(
    AgentSessionScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(root, path.join(root, "config")),
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          ServerSettings.layerTest({
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: claudeHome },
              },
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                config: { homePath: codexHome },
              },
              [ProviderInstanceId.make("pi")]: {
                driver: ProviderDriverKind.make("pi"),
                enabled: true,
                config: {},
                environment: [
                  { name: "PI_CODING_AGENT_DIR", value: piHome, sensitive: false },
                  { name: "PI_CODING_AGENT_SESSION_DIR", value: "", sensitive: false },
                ],
              },
            },
          }),
        ),
      ),
    ),
  );
  const scanner = yield* AgentSessionScanner.AgentSessionScanner.pipe(
    Effect.provide(scannerContext),
  );
  const projectId = ProjectId.make("compatibility-project");
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const importerContext = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Project",
                workspaceRoot: workspace,
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const importer = yield* AgentSessionImporter.AgentSessionImporter.pipe(
    Effect.provide(importerContext),
  );
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  return { scanner, importer, runtimes, workspace, projectId };
});

it.effect.each([
  { name: "omitted", request: {} },
  { name: "false", request: { includePi: false } },
])("legacy import keeps its history budget when includePi is $name", ({ request }) =>
  Effect.gen(function* () {
    const { scanner, importer, runtimes, workspace, projectId } = yield* fixture;
    yield* scanner.scan({ includePi: true });
    const legacy = yield* scanner.scan(request);
    expect(legacy.candidates).toMatchObject([
      { sources: ["claudeAgent", "codex"], threadCount: 2 },
    ]);
    // A different client can replace the last scan without changing this import's source selection.
    yield* scanner.scan({ includePi: true });
    const legacyInput = yield* decodeImport({
      projectId,
      expectedWorkspaceRoot: workspace,
      ...request,
    });
    const result = yield* importer.importRecentAgentThreads(legacyInput);
    expect(result).toEqual({ importedCount: 2, skippedCount: 0 });
    expect((yield* runtimes.list()).map((row) => row.providerInstanceId).sort()).toEqual([
      "claudeAgent",
      "codex",
    ]);

    yield* scanner.scan({});
    const modern = yield* importer.importRecentAgentThreads(
      yield* decodeImport({
        projectId,
        expectedWorkspaceRoot: workspace,
        includePi: true,
      }),
    );
    expect(modern).toEqual({ importedCount: 102, skippedCount: 0 });
    const imported = yield* runtimes.list();
    expect(imported.filter((row) => row.providerInstanceId === "pi")).toHaveLength(100);
    expect(imported).toHaveLength(102);
    expect(yield* importer.importRecentAgentThreads(legacyInput)).toEqual({
      importedCount: 2,
      skippedCount: 0,
    });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
