import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@goat/contracts";
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

const layerScannerTest = (input: {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly piAgentDir: string;
}) =>
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
            [ProviderInstanceId.make("pi")]: {
              driver: ProviderDriverKind.make("pi"),
              enabled: true,
              environment: [
                { name: "PI_CODING_AGENT_DIR", value: input.piAgentDir, sensitive: false },
                { name: "PI_CODING_AGENT_SESSION_DIR", value: "", sensitive: false },
              ],
              config: {},
            },
          },
        }),
        ServerConfig.layerTest(input.claudeHomePath, { prefix: "goat-scanner-window-" }),
        layerProjectStore([]),
      ),
    ),
  );

const makeTempDir = Effect.fn("AgentSessionScannerWindow.test.makeTempDir")(function* (
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTranscript = Effect.fn("AgentSessionScannerWindow.test.writeTranscript")(
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

const runRecentThreads = (input: {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly piAgentDir: string;
  readonly workspaceRoot: string;
  readonly windowDays?: number;
}) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    const outcomes = yield* scanner
      .recentThreads(input.workspaceRoot, [], {
        includePi: true,
        ...(input.windowDays === undefined ? {} : { windowDays: input.windowDays }),
      })
      .pipe(
        Stream.runCollect,
        Effect.map((values) => Array.from(values)),
      );
    return outcomes.flatMap((outcome) => (outcome._tag === "Importable" ? [outcome.thread] : []));
  }).pipe(Effect.provide(layerScannerTest(input)));

const runScan = (input: {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly piAgentDir: string;
  readonly windowDays?: number;
}) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.scan({
      includePi: true,
      ...(input.windowDays === undefined ? {} : { windowDays: input.windowDays }),
    });
  }).pipe(Effect.provide(layerScannerTest(input)));

const transcript = (workspace: string, sessionId: string) =>
  `${JSON.stringify({
    type: "user",
    cwd: workspace,
    sessionId,
    timestamp: "2026-08-23T12:00:00.000Z",
    message: { role: "user", content: "Fix the project" },
  })}\n${JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: "2026-08-23T12:01:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
  })}\n`;

it.layer(NodeServices.layer)("AgentSessionScanner import window", (it) => {
  it.effect("includes conversations inside the requested window", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");

      yield* writeTranscript({
        filePath: path.join(claudeHomePath, "projects", "-selected", "claude-recent.jsonl"),
        contents: transcript(workspace, "claude-recent"),
        mtimeMs: nowMs - 24 * 60 * 60 * 1000,
      });
      yield* writeTranscript({
        filePath: path.join(claudeHomePath, "projects", "-selected", "claude-old.jsonl"),
        contents: transcript(workspace, "claude-old"),
        mtimeMs: nowMs - 45 * 24 * 60 * 60 * 1000,
      });

      const defaultWindow = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
      });
      expect(defaultWindow.map((thread) => thread.providerSessionId)).toEqual(["claude-recent"]);

      const widerWindow = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
        windowDays: 60,
      });
      expect(widerWindow.map((thread) => thread.providerSessionId)).toEqual([
        "claude-recent",
        "claude-old",
      ]);
    }),
  );

  it.effect("reports project counts for the selected window", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");

      yield* writeTranscript({
        filePath: path.join(claudeHomePath, "projects", "-selected", "claude-recent.jsonl"),
        contents: transcript(workspace, "claude-recent"),
        mtimeMs: nowMs - 24 * 60 * 60 * 1000,
      });
      yield* writeTranscript({
        filePath: path.join(claudeHomePath, "projects", "-selected", "claude-old.jsonl"),
        contents: transcript(workspace, "claude-old"),
        mtimeMs: nowMs - 45 * 24 * 60 * 60 * 1000,
      });

      const defaultWindow = yield* runScan({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        windowDays: 30,
      });
      expect(defaultWindow.candidates[0]?.threadCount).toBe(1);

      const widerWindow = yield* runScan({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        windowDays: 60,
      });
      expect(widerWindow.candidates[0]?.threadCount).toBe(2);

      const omittedWindow = yield* runScan({ claudeHomePath, codexHomePath, piAgentDir });
      expect(omittedWindow.candidates[0]?.threadCount).toBe(1);
    }),
  );
});
