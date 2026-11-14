import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type ServerSettings as ContractServerSettings,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const makeProjectShell = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make("project-1"),
  title: "Imported",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const layerProjectStore = (importedWorkspaceRoots: ReadonlyArray<string>) =>
  Layer.mock(ProjectStore.ProjectStoreV2)({
    listShells: () =>
      Effect.succeed(
        importedWorkspaceRoots.map((workspaceRoot) => makeProjectShell(workspaceRoot)),
      ),
  });

interface ScannerTestInput {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly piAgentDir?: string;
  readonly importedWorkspaceRoots?: ReadonlyArray<string>;
  readonly configBaseDir?: string;
  readonly providerInstances?: ContractServerSettings["providerInstances"];
}

export const layerScannerTest = (input: ScannerTestInput) =>
  AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: input.claudeHomePath },
            },
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: input.codexHomePath },
            },
            // Keeps the default Pi instance off the developer's real ~/.pi.
            [ProviderInstanceId.make("pi")]: {
              driver: ProviderDriverKind.make("pi"),
              enabled: true,
              environment: [
                {
                  name: "PI_CODING_AGENT_DIR",
                  value: input.piAgentDir ?? `${input.claudeHomePath}/pi-agent`,
                  sensitive: false,
                },
                { name: "PI_CODING_AGENT_SESSION_DIR", value: "", sensitive: false },
              ],
              config: {},
            },
            ...input.providerInstances,
          },
        }),
        ServerConfig.layerTest(
          input.claudeHomePath,
          input.configBaseDir ?? { prefix: "goat-scanner-config-" },
        ),
        layerProjectStore(input.importedWorkspaceRoots ?? []),
      ),
    ),
  );
export const runScan = (input: ScannerTestInput & { readonly windowDays?: number }) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* TestClock.setTime(nowMs === 0 ? Date.parse("2026-12-31T12:00:00.000Z") : nowMs);
    return yield* scanner.scan({ includePi: true, windowDays: input.windowDays ?? 3650 });
  }).pipe(Effect.provide(layerScannerTest(input)));
export const runRecentThreadOutcomes = (
  input: ScannerTestInput & { readonly workspaceRoot: string },
) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.recentThreads(input.workspaceRoot, [], { includePi: true }).pipe(
      Stream.runCollect,
      Effect.map((outcomes) => Array.from(outcomes)),
    );
  }).pipe(Effect.provide(layerScannerTest(input)));
export const runRecentThreads = (input: ScannerTestInput & { readonly workspaceRoot: string }) =>
  runRecentThreadOutcomes(input).pipe(
    Effect.map((outcomes) =>
      outcomes.flatMap((outcome) => (outcome._tag === "Importable" ? [outcome.thread] : [])),
    ),
  );

export const makeTempDir = Effect.fn("AgentSessionScanner.test.makeTempDir")(function* (
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

export const writeTranscript = Effect.fn("AgentSessionScanner.test.writeTranscript")(
  function* (input: {
    readonly filePath: string;
    readonly contents: string;
    readonly mtimeMs: number;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
    yield* fileSystem.writeFileString(input.filePath, input.contents);
    const seconds = input.mtimeMs / 1000;
    yield* fileSystem.utimes(input.filePath, seconds, seconds);
  },
);
