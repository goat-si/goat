// @effect-diagnostics nodeBuiltinImport:off - The fixture builds a read-only Codex state database.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { readCodexProjectState, resolveCodexProjectCwd } from "./CodexStateDatabase.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";

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
  readonly codexShadowHomePath?: string;
  readonly piAgentDir: string;
}) =>
  AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
        }),
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: input.claudeHomePath },
            },
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                homePath: input.codexHomePath,
                ...(input.codexShadowHomePath === undefined
                  ? {}
                  : { shadowHomePath: input.codexShadowHomePath }),
              },
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
        ServerConfig.layerTest(input.claudeHomePath, { prefix: "goat-scanner-codex-" }),
        layerProjectStore([]),
      ),
    ),
  );

const makeTempDir = Effect.fn("AgentSessionScannerCodex.test.makeTempDir")(function* (
  prefix: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTranscript = Effect.fn("AgentSessionScannerCodex.test.writeTranscript")(
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

const runScan = (input: {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly codexShadowHomePath?: string;
  readonly piAgentDir: string;
}) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.scan({ includePi: true });
  }).pipe(Effect.provide(layerScannerTest(input)));

const writeCodexState = Effect.fn("AgentSessionScannerCodex.test.writeCodexState")(
  function* (input: {
    readonly homePath: string;
    readonly projectRoot: string;
    readonly threads: ReadonlyArray<{
      id: string;
      cwd: string;
      updatedAtMs: number;
      archived?: boolean;
      source?: string;
    }>;
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
      const insertThread = database.prepare(
        "INSERT INTO threads (id, cwd, updated_at, archived, source) VALUES (?, ?, ?, ?, ?)",
      );
      for (const thread of input.threads) {
        insertThread.run(
          thread.id,
          thread.cwd,
          Math.floor(thread.updatedAtMs / 1000),
          thread.archived === true ? 1 : 0,
          thread.source ?? "vscode",
        );
      }
    } finally {
      database.close();
    }
  },
);

const runRecentThreads = (input: {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly codexShadowHomePath?: string;
  readonly piAgentDir: string;
  readonly workspaceRoot: string;
}) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    const outcomes = yield* scanner
      .recentThreads(input.workspaceRoot, [], { includePi: true })
      .pipe(
        Stream.runCollect,
        Effect.map((values) => Array.from(values)),
      );
    return outcomes.flatMap((outcome) => (outcome._tag === "Importable" ? [outcome.thread] : []));
  }).pipe(Effect.provide(layerScannerTest(input)));

it.layer(NodeServices.layer)("AgentSessionScanner Codex projects", (it) => {
  it.effect("maps Codex threads to their project root from the state database", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const otherWorkspace = yield* makeTempDir("goat-workspace-other-");
      const threadId = "11111111-1111-4111-8111-111111111111";
      const continuationId = "33333333-3333-4333-8333-333333333333";
      const databaseOnlyThreadId = "22222222-2222-4222-8222-222222222222";
      const archivedThreadId = "44444444-4444-4444-8444-444444444444";

      yield* writeTranscript({
        filePath: path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "24",
          `rollout-2026-08-24T10-00-00-${threadId}_${continuationId}.jsonl`,
        ),
        contents: [
          JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: otherWorkspace } }),
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
        mtimeMs: nowMs - 60 * 60 * 1000,
      });
      yield* writeTranscript({
        filePath: path.join(
          codexHomePath,
          "sessions",
          "2026",
          "08",
          "24",
          `rollout-2026-08-24T09-00-00-${threadId}_${continuationId}.jsonl`,
        ),
        contents: [
          JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: otherWorkspace } }),
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
        threads: [
          { id: threadId, cwd: workspace, updatedAtMs: nowMs - 60 * 60 * 1000 },
          {
            id: databaseOnlyThreadId,
            cwd: workspace,
            updatedAtMs: nowMs - 30 * 60 * 1000,
          },
          {
            id: archivedThreadId,
            cwd: workspace,
            updatedAtMs: nowMs,
            archived: true,
          },
        ],
      });

      const { scan, threads } = yield* Effect.gen(function* () {
        const scanner = yield* AgentSessionScanner.AgentSessionScanner;
        const scan = yield* scanner.scan({ includePi: true });
        const outcomes = yield* scanner.recentThreads(workspace, [], { includePi: true }).pipe(
          Stream.runCollect,
          Effect.map((values) => Array.from(values)),
        );
        return {
          scan,
          threads: outcomes.flatMap((outcome) =>
            outcome._tag === "Importable" ? [outcome.thread] : [],
          ),
        };
      }).pipe(Effect.provide(layerScannerTest({ claudeHomePath, codexHomePath, piAgentDir })));
      expect(scan.candidates).toHaveLength(1);
      expect(scan.candidates[0]?.title).toBe(path.basename(workspace));
      expect(scan.candidates[0]?.threadCount).toBe(1);
      expect(scan.candidates[0]?.lastActiveAt).toBe(
        DateTime.formatIso(DateTime.makeUnsafe(nowMs - 30 * 60 * 1000)),
      );
      expect(threads.map((thread) => thread.providerSessionId)).toEqual([threadId]);

      const freshThreads = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
      });
      expect(freshThreads.map((thread) => thread.providerSessionId)).toEqual([threadId]);
    }),
  );

  it.effect("skips Codex subagents even when the state database maps their cwd", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const otherWorkspace = yield* makeTempDir("goat-workspace-other-");
      const threadId = "55555555-5555-4555-8555-555555555555";
      const stateOnlyThreadId = "77777777-7777-4777-8777-777777777777";
      const stateOnlyAlternateThreadId = "88888888-8888-4888-8888-888888888888";

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
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: threadId,
              cwd: otherWorkspace,
              source: { subagent: { thread_spawn: { parent_thread_id: threadId } } },
            },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: "Review this" },
          }),
        ].join("\n"),
        mtimeMs: nowMs - 60 * 60 * 1000,
      });
      yield* writeCodexState({
        homePath: codexHomePath,
        projectRoot: workspace,
        threads: [
          {
            id: threadId,
            cwd: workspace,
            updatedAtMs: nowMs - 60 * 60 * 1000,
            source: '{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}',
          },
          {
            id: stateOnlyThreadId,
            cwd: workspace,
            updatedAtMs: nowMs,
            source: '{"subAgent":{"compact":true}}',
          },
          {
            id: stateOnlyAlternateThreadId,
            cwd: workspace,
            updatedAtMs: nowMs,
            source: '{"subagent":{"compact":true}}',
          },
        ],
      });

      const scan = yield* runScan({ claudeHomePath, codexHomePath, piAgentDir });
      expect(scan.candidates[0]?.threadCount).toBe(0);
      expect(scan.candidates[0]?.lastActiveAt).toBeNull();
      const threads = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: workspace,
      });
      expect(threads).toEqual([]);
    }),
  );

  it("resolves Windows project roots", () => {
    expect(resolveCodexProjectCwd("C:\\Work\\Repo\\src", ["C:\\work\\repo"])).toBe(
      "C:\\work\\repo",
    );
    expect(resolveCodexProjectCwd("C:\\work\\other", ["C:\\work\\repo"])).toBe("C:\\work\\other");
    expect(resolveCodexProjectCwd("\\\\server\\share\\repo\\src", ["//server/share/repo"])).toBe(
      "//server/share/repo",
    );
  });

  it("picks the most specific root from many candidates", () => {
    const roots = Array.from({ length: 2_000 }, (_, index) => `/repo-${index}`);
    roots.push("/repo-0/nested");

    expect(resolveCodexProjectCwd("/repo-0/nested/pkg", roots)).toBe("/repo-0/nested");
    expect(resolveCodexProjectCwd("/repo-0/pkg", roots)).toBe("/repo-0");

    const uncRoots = ["\\\\server\\share", "\\\\server\\share\\repo"];
    expect(resolveCodexProjectCwd("\\\\server\\share\\repo\\src", uncRoots)).toBe(
      "\\\\server\\share\\repo",
    );
    expect(resolveCodexProjectCwd("\\\\server\\share\\other", uncRoots)).toBe("\\\\server\\share");
  });

  it.effect("reads the Codex state database from a shadow home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const codexShadowHomePath = yield* makeTempDir("goat-codex-shadow-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const otherWorkspace = yield* makeTempDir("goat-workspace-other-");
      const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
          JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: otherWorkspace } }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: "Fix it" },
          }),
        ].join("\n"),
        mtimeMs: nowMs - 60 * 60 * 1000,
      });
      yield* writeCodexState({
        homePath: codexShadowHomePath,
        projectRoot: workspace,
        threads: [{ id: threadId, cwd: workspace, updatedAtMs: nowMs - 60 * 60 * 1000 }],
      });

      const scan = yield* runScan({
        claudeHomePath,
        codexHomePath,
        codexShadowHomePath,
        piAgentDir,
      });
      expect(scan.candidates).toHaveLength(1);
      expect(scan.candidates[0]?.title).toBe(path.basename(workspace));
      expect(scan.candidates[0]?.threadCount).toBe(1);
    }),
  );

  it.effect("keeps rollout discovery when the state database is unreadable", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const fileSystem = yield* FileSystem.FileSystem;
      const threadId = "66666666-6666-4666-8666-666666666666";

      yield* fileSystem.writeFileString(path.join(codexHomePath, "state_5.sqlite"), "broken");
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

      const scan = yield* runScan({ claudeHomePath, codexHomePath, piAgentDir });
      expect(scan.candidates).toHaveLength(1);
      expect(scan.truncated).toBe(true);
    }),
  );

  it.effect("marks the state snapshot incomplete when project roots exceed the cap", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const database = new NodeSqlite.DatabaseSync(path.join(codexHomePath, "state_5.sqlite"));
      try {
        database.exec(`
          CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
          CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position));
          CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '');
        `);
        database
          .prepare("INSERT INTO projects (id, name, updated_at_ms) VALUES (?, ?, ?)")
          .run("project-1", "Project", 1_790_000_000_000);
        database.exec(`
          WITH RECURSIVE roots(position) AS (
            SELECT 0 UNION ALL SELECT position + 1 FROM roots WHERE position < 20000
          )
          INSERT INTO project_roots (project_id, position, path)
          SELECT 'project-1', position, '/repo/root-' || position FROM roots;
        `);
      } finally {
        database.close();
      }

      const state = yield* readCodexProjectState([
        {
          homePath: codexHomePath,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      ]);
      expect(state.complete).toBe(false);
      expect(state.stateByHome.get(codexHomePath)?.projectRoots).toHaveLength(20_000);
    }),
  );
  it.effect("keeps Codex rollout cwds when the Codex state database is unreadable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // GOAT counts threads inside its activity window, so the clock sits just after the rollout.
      yield* TestClock.setTime(Date.parse("2026-05-03T00:01:00.000Z"));
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const workspace = yield* makeTempDir("goat-workspace-");
      yield* writeTranscript({
        filePath: path.join(
          codexHomePath,
          "sessions",
          "2026",
          "05",
          "03",
          "rollout-2026-05-03T00-00-00-019a5f00-0000-7000-8000-00000000000a.jsonl",
        ),
        contents: `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "r1", cwd: workspace } })}\n`,
        mtimeMs: Date.parse("2026-05-03T00:00:00.000Z"),
      });
      yield* fileSystem.writeFileString(
        path.join(codexHomePath, "state_5.sqlite"),
        "not a database",
      );

      const result = yield* runScan({ claudeHomePath, codexHomePath, piAgentDir });

      expect(result.candidates.map(({ path, threadCount }) => ({ path, threadCount }))).toEqual([
        { path: workspace, threadCount: 1 },
      ]);
    }),
  );

  it.effect("imports Codex chats moved from a scratch folder into a Codex project", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-11-08T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const piAgentDir = yield* makeTempDir("goat-pi-agent-");
      const homeDir = yield* makeTempDir("goat-home-");
      const projectDir = path.join(homeDir, "code", "my-project");
      const scratchDir = path.join(homeDir, "Documents", "Codex", "2026-11-08", "new-chat");
      const otherDir = path.join(homeDir, "code", "other-project");
      yield* fileSystem.makeDirectory(projectDir, { recursive: true });
      yield* fileSystem.makeDirectory(scratchDir, { recursive: true });
      yield* fileSystem.makeDirectory(otherDir, { recursive: true });

      const projectId = "019a5f00-0000-7000-8000-000000000001";
      const chats = [
        {
          id: "019a5f00-0000-7000-8000-00000000000a",
          cwd: scratchDir,
          message: "Started with no project",
        },
        {
          id: "019a5f00-0000-7000-8000-00000000000b",
          cwd: projectDir,
          message: "Started in the project",
        },
        {
          id: "019a5f00-0000-7000-8000-00000000000c",
          cwd: otherDir,
          message: "Started in another folder",
        },
        {
          id: "019a5f00-0000-7000-8000-00000000000d",
          rolloutId: "019a5f00-0000-7000-8000-0000000000d1",
          cwd: scratchDir,
          message: "Rewound with no project",
        },
      ];
      const rolloutPaths: Array<string> = [];
      for (const [index, chat] of chats.entries()) {
        const filePath = path.join(
          codexHomePath,
          "sessions",
          "2026",
          "11",
          "08",
          `rollout-2026-11-08T08-0${index}-00-${"rolloutId" in chat ? `${chat.id}_${chat.rolloutId}` : chat.id}.jsonl`,
        );
        rolloutPaths.push(filePath);
        yield* writeTranscript({
          filePath,
          contents: [
            JSON.stringify({ type: "session_meta", payload: { id: chat.id, cwd: chat.cwd } }),
            JSON.stringify({ type: "turn_context", payload: { cwd: chat.cwd } }),
            JSON.stringify({
              type: "event_msg",
              payload: { type: "user_message", message: chat.message },
            }),
          ].join("\n"),
          mtimeMs: nowMs - 60_000 + index,
        });
      }
      // Codex records a chat's project only in its state DB; the rollout keeps the original cwd.
      // GOAT also reads updated_at, archived and source, which Codex's threads table carries.
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(path.join(codexHomePath, "state_5.sqlite"));
        try {
          db.exec(`
            CREATE TABLE projects (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              metadata TEXT NOT NULL DEFAULT '{}',
              position INTEGER NOT NULL,
              created_at_ms INTEGER NOT NULL,
              updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE project_roots (
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              position INTEGER NOT NULL,
              path TEXT NOT NULL,
              PRIMARY KEY (project_id, position)
            );
            CREATE TABLE threads (
              id TEXT PRIMARY KEY,
              rollout_path TEXT NOT NULL,
              cwd TEXT NOT NULL,
              project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
              updated_at INTEGER NOT NULL,
              archived INTEGER NOT NULL DEFAULT 0,
              source TEXT NOT NULL DEFAULT 'vscode'
            );
          `);
          db.prepare("INSERT INTO projects VALUES (?, ?, '{}', 0, ?, ?)").run(
            projectId,
            "my-project",
            nowMs,
            nowMs,
          );
          db.prepare("INSERT INTO project_roots VALUES (?, 0, ?)").run(projectId, projectDir);
          const insertThread = db.prepare(
            "INSERT INTO threads (id, rollout_path, cwd, project_id, updated_at) VALUES (?, ?, ?, ?, ?)",
          );
          for (const [index, chat] of chats.entries()) {
            insertThread.run(
              chat.id,
              rolloutPaths[index]!,
              chat.cwd,
              projectId,
              Math.floor((nowMs - 60_000 + index) / 1000),
            );
          }
        } finally {
          db.close();
        }
      });

      const threads = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        piAgentDir,
        workspaceRoot: projectDir,
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, homeDir));
      expect(threads.map((thread) => thread.title).toSorted()).toEqual([
        "Rewound with no project",
        "Started in the project",
        "Started with no project",
      ]);

      const result = yield* runScan({ claudeHomePath, codexHomePath, piAgentDir }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, homeDir),
      );
      expect(
        result.candidates
          .map(({ path, threadCount }) => ({ path, threadCount }))
          .toSorted((left, right) => left.path.localeCompare(right.path)),
      ).toEqual([
        { path: projectDir, threadCount: 3 },
        { path: otherDir, threadCount: 1 },
      ]);
    }),
  );
});
