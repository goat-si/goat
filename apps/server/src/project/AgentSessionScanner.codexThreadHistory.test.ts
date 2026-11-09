// @effect-diagnostics nodeBuiltinImport:off - The fixtures build read-only Codex state and history databases.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import {
  type AgentSessionImportSource,
  type OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
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
        ServerConfig.layerTest(input.claudeHomePath, { prefix: "goat-scanner-history-" }),
        layerProjectStore([]),
      ),
    ),
  );

const makeTempDir = Effect.fn("AgentSessionScannerCodexHistory.test.makeTempDir")(function* (
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTranscript = Effect.fn("AgentSessionScannerCodexHistory.test.writeTranscript")(
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

interface HistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAtMs: number;
}

const writeCodexState = Effect.fn("AgentSessionScannerCodexHistory.test.writeCodexState")(
  function* (input: {
    readonly homePath: string;
    readonly projectRoot: string;
    readonly threads: ReadonlyArray<{
      id: string;
      updatedAtMs: number;
      title: string;
      model?: string;
    }>;
  }) {
    const path = yield* Path.Path;
    const database = new NodeSqlite.DatabaseSync(path.join(input.homePath, "state_5.sqlite"));
    try {
      database.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
        CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position));
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          model TEXT
        );
      `);
      database
        .prepare("INSERT INTO projects (id, name, updated_at_ms) VALUES (?, ?, ?)")
        .run("project-1", "Project", 1_790_000_000_000);
      database
        .prepare("INSERT INTO project_roots (project_id, position, path) VALUES (?, ?, ?)")
        .run("project-1", 0, input.projectRoot);
      const insertThread = database.prepare(
        "INSERT INTO threads (id, cwd, created_at, updated_at, archived, source, title, model) VALUES (?, ?, ?, ?, 0, 'vscode', ?, ?)",
      );
      for (const thread of input.threads) {
        insertThread.run(
          thread.id,
          input.projectRoot,
          Math.floor((thread.updatedAtMs - 60 * 60 * 1000) / 1000),
          Math.floor(thread.updatedAtMs / 1000),
          thread.title,
          thread.model ?? null,
        );
      }
    } finally {
      database.close();
    }
  },
);

const writeLegacyCodexState = Effect.fn(
  "AgentSessionScannerCodexHistory.test.writeLegacyCodexState",
)(function* (input: {
  readonly homePath: string;
  readonly projectRoot: string;
  readonly threadId: string;
  readonly updatedAtMs: number;
}) {
  const path = yield* Path.Path;
  const database = new NodeSqlite.DatabaseSync(path.join(input.homePath, "state_5.sqlite"));
  try {
    database.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position));
      CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '');
    `);
    database
      .prepare("INSERT INTO projects (id, name, updated_at_ms) VALUES (?, ?, ?)")
      .run("project-1", "Project", 1_790_000_000_000);
    database
      .prepare("INSERT INTO project_roots (project_id, position, path) VALUES (?, ?, ?)")
      .run("project-1", 0, input.projectRoot);
    database
      .prepare(
        "INSERT INTO threads (id, cwd, updated_at, archived, source) VALUES (?, ?, ?, 0, 'vscode')",
      )
      .run(input.threadId, input.projectRoot, Math.floor(input.updatedAtMs / 1000));
  } finally {
    database.close();
  }
});

const writeCodexHistory = Effect.fn("AgentSessionScannerCodexHistory.test.writeCodexHistory")(
  function* (input: {
    readonly homePath: string;
    readonly threads: ReadonlyArray<{
      readonly id: string;
      readonly messages: ReadonlyArray<HistoryMessage>;
    }>;
  }) {
    const path = yield* Path.Path;
    const database = new NodeSqlite.DatabaseSync(
      path.join(input.homePath, "thread_history_1.sqlite"),
    );
    try {
      database.exec(`
        CREATE TABLE thread_items (
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          rollout_ordinal INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          item_json TEXT NOT NULL,
          item_type TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (thread_id, turn_id, item_id)
        );
        CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id, rollout_ordinal);
      `);
      const insert = database.prepare(
        "INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const thread of input.threads) {
        thread.messages.forEach((message, index) => {
          const item =
            message.role === "user"
              ? {
                  type: "userMessage",
                  id: `item-${index}`,
                  content: [{ type: "text", text: message.text }],
                }
              : { type: "agentMessage", id: `item-${index}`, text: message.text };
          insert.run(
            thread.id,
            `turn-${index}`,
            `item-${index}`,
            index,
            message.createdAtMs,
            JSON.stringify(item),
            item.type,
          );
        });
      }
    } finally {
      database.close();
    }
  },
);

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

const runRecentThreads = (input: {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly piAgentDir: string;
  readonly workspaceRoot: string;
  readonly windowDays?: number;
  readonly completedSources?: ReadonlyArray<AgentSessionImportSource>;
}) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    const outcomes = yield* scanner
      .recentThreads(input.workspaceRoot, input.completedSources ?? [], {
        includePi: true,
        ...(input.windowDays === undefined ? {} : { windowDays: input.windowDays }),
      })
      .pipe(
        Stream.runCollect,
        Effect.map((values) => Array.from(values)),
      );
    return outcomes;
  }).pipe(Effect.provide(layerScannerTest(input)));

it.layer(NodeServices.layer)("AgentSessionScanner Codex thread history", (it) => {
  it.effect("imports Codex threads that only exist in the history database", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const rolloutThreadId = "11111111-1111-4111-8111-111111111111";
      const historyThreadId = "22222222-2222-4222-8222-222222222222";
      const oldThreadId = "33333333-3333-4333-8333-333333333333";

      yield* writeTranscript({
        filePath: path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "24",
          `rollout-2026-08-24T10-00-00-${rolloutThreadId}.jsonl`,
        ),
        contents: [
          JSON.stringify({
            type: "session_meta",
            payload: { id: rolloutThreadId, cwd: workspace },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: "Fix it" },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done" }],
            },
          }),
        ].join("\n"),
        mtimeMs: nowMs - 2 * 60 * 60 * 1000,
      });
      const stateThreads = [
        {
          id: rolloutThreadId,
          updatedAtMs: nowMs - 2 * 60 * 60 * 1000,
          title: "Rollout thread",
        },
        {
          id: historyThreadId,
          updatedAtMs: nowMs - 60 * 60 * 1000,
          title: "Pruned thread",
          model: "gpt-5.6-luna",
        },
        {
          id: oldThreadId,
          updatedAtMs: nowMs - 40 * 24 * 60 * 60 * 1000,
          title: "Old thread",
        },
      ];
      yield* writeCodexState({
        homePath: codexHomePath,
        projectRoot: workspace,
        threads: stateThreads,
      });
      yield* writeCodexHistory({
        homePath: codexHomePath,
        threads: [
          {
            id: historyThreadId,
            messages: [
              { role: "user", text: "Recovered question", createdAtMs: nowMs - 70 * 60 * 1000 },
              { role: "assistant", text: "Recovered answer", createdAtMs: nowMs - 69 * 60 * 1000 },
            ],
          },
          {
            id: oldThreadId,
            messages: [
              { role: "user", text: "Old question", createdAtMs: nowMs - 40 * 24 * 60 * 60 * 1000 },
              {
                role: "assistant",
                text: "Old answer",
                createdAtMs: nowMs - 40 * 24 * 60 * 60 * 1000 + 60_000,
              },
            ],
          },
        ],
      });

      const scan = yield* runScan({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        windowDays: 30,
      });
      expect(scan.candidates[0]?.threadCount).toBe(2);

      const outcomes = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
        windowDays: 30,
      });
      const importable = outcomes.flatMap((outcome) =>
        outcome._tag === "Importable" ? [outcome] : [],
      );
      expect(importable.map((outcome) => outcome.thread.providerSessionId)).toEqual([
        historyThreadId,
        rolloutThreadId,
      ]);
      const history = importable[0]!;
      expect(history.thread.title).toBe("Pruned thread");
      expect(history.thread.model).toBe("gpt-5.6-luna");
      expect(history.thread.messages.map((message) => message.text)).toEqual([
        "Recovered question",
        "Recovered answer",
      ]);
      expect(history.thread.createdAt).toBe(
        DateTime.formatIso(DateTime.makeUnsafe(nowMs - 70 * 60 * 1000)),
      );
      expect(history.source).toMatchObject({
        provider: "codex",
        providerSessionId: historyThreadId,
        filePath: `codex-history://${historyThreadId}`,
        size: 0,
        mtimeMs: null,
      });

      const widerScan = yield* runScan({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        windowDays: 90,
      });
      expect(widerScan.candidates[0]?.threadCount).toBe(3);
      const wider = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
        windowDays: 90,
      });
      expect(
        wider.flatMap((outcome) =>
          outcome._tag === "Importable" ? [outcome.thread.providerSessionId] : [],
        ),
      ).toEqual([historyThreadId, rolloutThreadId, oldThreadId]);

      const rerun = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
        windowDays: 30,
        completedSources: [history.source],
      });
      const rerunHistory = rerun.find(
        (outcome) =>
          outcome._tag !== "Skipped" && outcome.source.providerSessionId === historyThreadId,
      );
      expect(rerunHistory?._tag).toBe("AlreadyImported");
      expect(
        rerun.flatMap((outcome) =>
          outcome._tag === "Importable" ? [outcome.thread.providerSessionId] : [],
        ),
      ).toEqual([rolloutThreadId]);
    }),
  );

  it.effect("does not import a history copy of a thread that still has a rollout", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const threadId = "44444444-4444-4444-8444-444444444444";

      yield* writeTranscript({
        filePath: path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "24",
          `rollout-2026-08-24T10-00-00-${threadId}.jsonl`,
        ),
        contents: [
          JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: workspace } }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: "Fix it" },
          }),
        ].join("\n"),
        mtimeMs: nowMs - 2 * 60 * 60 * 1000,
      });
      yield* writeCodexState({
        homePath: codexHomePath,
        projectRoot: workspace,
        threads: [{ id: threadId, updatedAtMs: nowMs - 60 * 60 * 1000, title: "Thread" }],
      });
      yield* writeCodexHistory({
        homePath: codexHomePath,
        threads: [
          {
            id: threadId,
            messages: [
              { role: "user", text: "History question", createdAtMs: nowMs - 70 * 60 * 1000 },
            ],
          },
        ],
      });

      const scan = yield* runScan({ claudeHomePath, codexHomePath, piAgentDir, windowDays: 30 });
      expect(scan.candidates[0]?.threadCount).toBe(1);
      const outcomes = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
        windowDays: 30,
      });
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?._tag).toBe("Importable");
      if (outcomes[0]?._tag === "Importable") {
        expect(outcomes[0].thread.title).toBe("Fix it");
        expect(outcomes[0].source.filePath).not.toContain("codex-history://");
      }
    }),
  );

  it.effect("keeps scanning a state database without title, model or created_at columns", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const threadId = "55555555-5555-4555-8555-555555555555";

      yield* writeTranscript({
        filePath: path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "24",
          `rollout-2026-08-24T10-00-00-${threadId}.jsonl`,
        ),
        contents: [
          JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: workspace } }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: "Fix it" },
          }),
        ].join("\n"),
        mtimeMs: nowMs - 60 * 60 * 1000,
      });
      yield* writeLegacyCodexState({
        homePath: codexHomePath,
        projectRoot: workspace,
        threadId,
        updatedAtMs: nowMs - 60 * 60 * 1000,
      });

      const scan = yield* runScan({ claudeHomePath, codexHomePath, piAgentDir, windowDays: 30 });
      expect(scan.candidates).toHaveLength(1);
      expect(scan.candidates[0]?.path).toBe(workspace);
      expect(scan.candidates[0]?.threadCount).toBe(1);
    }),
  );

  it.effect("counts only state threads with importable history", () =>
    Effect.gen(function* () {
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const withHistory = "66666666-6666-4666-8666-666666666666";
      const empty = "77777777-7777-4777-8777-777777777777";

      yield* writeCodexState({
        homePath: codexHomePath,
        projectRoot: workspace,
        threads: [
          { id: withHistory, updatedAtMs: nowMs - 60 * 60 * 1000, title: "With history" },
          { id: empty, updatedAtMs: nowMs, title: "Empty" },
        ],
      });
      yield* writeCodexHistory({
        homePath: codexHomePath,
        threads: [
          {
            id: withHistory,
            messages: [
              { role: "user", text: "Question", createdAtMs: nowMs - 70 * 60 * 1000 },
              { role: "assistant", text: "Answer", createdAtMs: nowMs - 69 * 60 * 1000 },
            ],
          },
        ],
      });

      const scan = yield* runScan({ claudeHomePath, codexHomePath, piAgentDir, windowDays: 30 });
      expect(scan.candidates[0]?.threadCount).toBe(1);
      const outcomes = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
        windowDays: 30,
      });
      expect(
        outcomes.flatMap((outcome) =>
          outcome._tag === "Importable" ? [outcome.thread.providerSessionId] : [],
        ),
      ).toEqual([withHistory]);
    }),
  );

  it.effect("ignores an unreadable Codex history database", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const fileSystem = yield* FileSystem.FileSystem;

      yield* writeCodexState({
        homePath: codexHomePath,
        projectRoot: workspace,
        threads: [
          {
            id: "88888888-8888-4888-8888-888888888888",
            updatedAtMs: nowMs,
            title: "Broken history",
          },
        ],
      });
      yield* fileSystem.writeFileString(
        path.join(codexHomePath, "thread_history_1.sqlite"),
        "not a database",
      );

      const scan = yield* runScan({ claudeHomePath, codexHomePath, piAgentDir, windowDays: 30 });
      expect(scan.candidates[0]?.threadCount).toBe(0);
      const outcomes = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
        windowDays: 30,
      });
      expect(outcomes).toEqual([]);
    }),
  );
});
