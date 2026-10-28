import { expect, it } from "@effect/vitest";
import {
  OrchestratorMcpFailure,
  EnvironmentAuthorizationError,
  EnvironmentId,
  Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UsageDay,
  UsageReadError,
  type UsageSummary,
  type ResourceTelemetryHistory,
  type ServerProcessResourceHistoryResult,
  type ReviewDiffPreviewResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Processes from "../diagnostics/ProcessResourceMonitor.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Telemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as Review from "../review/ReviewService.ts";
import * as Usage from "../usage/UsageService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as Reads from "./ScopedReadMcp.ts";
import * as ReadSchemas from "./scopedReadSchemas.ts";

const decodeProject = Schema.decodeSync(Project);
const encodeUsage = Schema.encodeSync(Schema.toCodecJson(ReadSchemas.UsageResult));
const encodePreview = Schema.encodeSync(Schema.toCodecJson(ReadSchemas.DiffPreviewResult));
const encodeProcesses = Schema.encodeSync(Schema.toCodecJson(ReadSchemas.ProcessHistoryResult));
const encodeResources = Schema.encodeSync(Schema.toCodecJson(ReadSchemas.ResourceHistoryResult));

const day = UsageDay.make("2026-01-01");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const projectId = ProjectId.make("project:test");
const threadId = ThreadId.make("thread:test");
const usageInput = { sinceDay: day, untilDay: day, timeZone: "UTC" };
const historyInput = { windowMs: 60000, bucketMs: 1000 };
const previewInput = { projectId, scope: "working-tree" as const };
const fileInput = {
  projectId,
  sourceKind: "working-tree" as const,
  changeType: "change" as const,
  baseRef: null,
  oldPath: "a.ts",
  newPath: "a.ts",
};
const client = (): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:test"),
  requestNamespace: "test",
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree"]),
  thread: undefined,
  client: { sessionId: "client:test", label: "test", access: "read-only" },
  grantedScopes: ["diagnostics:read", "filesystem:read"],
  reauthorize: () => Effect.void,
});

function fixture(large = false, wide = false) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const record = <A>(operation: string, input: unknown, result: A) =>
    Effect.sync(() => {
      calls.push({ operation, input });
      return result;
    });
  const count = large ? 300 : 1;
  const command = large ? "😀".repeat(600) : "node agent";
  const bucket = {
    startedAt: now,
    endedAt: now,
    avgCpuPercent: 2,
    maxCpuPercent: 4,
    maxRssBytes: 1024,
    maxProcessCount: 1,
  };
  const processRow = {
    processKey: "123:0",
    pid: 123,
    ppid: 1,
    command,
    depth: 1,
    isServerRoot: false,
    firstSeenAt: now,
    lastSeenAt: now,
    currentCpuPercent: 2,
    avgCpuPercent: 2,
    maxCpuPercent: 4,
    cpuSecondsApprox: 1,
    currentRssBytes: 1024,
    maxRssBytes: 1024,
    sampleCount: 1,
  };
  const processHistory: ServerProcessResourceHistoryResult = {
    readAt: now,
    ...historyInput,
    sampleIntervalMs: 1000,
    retainedSampleCount: 1,
    totalCpuSecondsApprox: 1,
    buckets: Array.from({ length: count }, () => bucket),
    topProcesses: Array.from({ length: count }, () => processRow),
    error: Option.none(),
  };
  const resourceHistory: ResourceTelemetryHistory = {
    readAt: now,
    ...historyInput,
    sampleIntervalMs: 1000,
    retainedSampleCount: 1,
    buckets: Array.from({ length: count }, () => ({ ...bucket, ioReadBytes: 0, ioWriteBytes: 0 })),
    topProcesses: Array.from({ length: count }, () => ({
      identity: { pid: 123, startTimeMs: 0 },
      ppid: 1,
      depth: 1,
      name: command,
      command,
      category: "server",
      firstSeenAt: now,
      lastSeenAt: now,
      currentCpuPercent: 2,
      avgCpuPercent: 2,
      maxCpuPercent: 4,
      cpuTimeMs: 1,
      currentRssBytes: 1024,
      peakRssBytes: 1024,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      ioSemantics: "storage",
      sampleCount: 1,
    })),
    health: {
      native: { status: "healthy", lastSampleAt: Option.none(), lastError: Option.none() },
      desktop: { status: "healthy", lastSampleAt: Option.none(), lastError: Option.none() },
      sidecarVersion: Option.none(),
      sidecarPid: Option.none(),
      restartCount: 0,
      collectionDurationMicros: 0,
      scannedProcessCount: 1,
      retainedProcessCount: 1,
      inaccessibleProcessCount: 0,
    },
  };
  const summary: UsageSummary = {
    contractVersion: 6,
    readAt: "2026-01-01T00:00:00Z",
    timeZone: "UTC",
    sinceDay: day,
    untilDay: day,
    buckets: Array.from({ length: count }, () => ({
      day,
      provider: "codex",
      model: wide ? "m".repeat(8000) : "test",
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      },
      costUsd: 0.01,
      cacheSavingsUsd: 0,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    })),
    sources: Array.from({ length: large ? 40 : 1 }, () => ({
      fingerprint: {
        hostId: "test",
        provider: "codex",
        resolvedHomePath: "/home/test",
        volumeId: "1:2",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    })),
    pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 0,
  };
  const preview: ReviewDiffPreviewResult = {
    cwd: "/repo",
    generatedAt: now,
    sources: [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Working tree",
        baseRef: null,
        headRef: null,
        diff: large ? "한".repeat(70000) : "+ok\n",
        diffHash: "abc",
        truncated: false,
        files: Array.from({ length: count }, (_, i) => ({
          path: `file-${i}.ts`,
          previousPath: null,
          additions: 1,
          deletions: 0,
        })),
      },
    ],
  };
  const project = decodeProject({
    id: projectId,
    title: "test",
    workspaceRoot: "/repo",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    deletedAt: null,
  });
  const layer = Layer.mergeAll(
    Layer.mock(Usage.UsageService)({ readSummary: (input) => record("usage", input, summary) }),
    Layer.mock(Processes.ProcessResourceMonitor)({
      readHistory: (input) => record("process", input, processHistory),
    }),
    Layer.mock(Telemetry.ResourceTelemetry)({
      readHistory: (input) => record("resource", input, resourceHistory),
    }),
    Layer.mock(Review.ReviewService)({
      getDiffPreview: (input) => record("preview", input, preview),
      getDiffFileContents: (input) =>
        record("file", input, {
          oldContents: large ? "a".repeat(262143) + "😀tail" : "old",
          newContents: large ? "한".repeat(100000) : "new",
        }),
    }),
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        record("project", id, id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        record(
          "thread",
          id,
          id === threadId
            ? { ...liveThreadShell(id), projectId, worktreePath: "/repo-worktree" }
            : null,
        ),
    }),
  );
  return { calls, layer, summary, processHistory, resourceHistory, preview };
}
type ReadValue =
  | typeof ReadSchemas.UsageResult.Type
  | typeof ReadSchemas.ProcessHistoryResult.Type
  | typeof ReadSchemas.ResourceHistoryResult.Type
  | typeof ReadSchemas.DiffPreviewResult.Type
  | typeof ReadSchemas.DiffFileResult.Type;
const paths: ReadonlyArray<{
  path: string;
  scope: "diagnostics:read" | "filesystem:read";
  call: (
    scope: McpInvocationScope,
  ) => Effect.Effect<
    ReadValue,
    OrchestratorMcpFailure,
    Layer.Success<ReturnType<typeof fixture>["layer"]>
  >;
}> = [
  {
    path: "environment.usage",
    scope: "diagnostics:read",
    call: (s: McpInvocationScope) => Reads.usage(s, usageInput),
  },
  {
    path: "host.process_history",
    scope: "diagnostics:read",
    call: (s: McpInvocationScope) => Reads.processHistory(s, historyInput),
  },
  {
    path: "host.resource_history",
    scope: "diagnostics:read",
    call: (s: McpInvocationScope) => Reads.resourceHistory(s, historyInput),
  },
  {
    path: "worktree.diff_preview",
    scope: "filesystem:read",
    call: (s: McpInvocationScope) => Reads.diffPreview(s, previewInput),
  },
  {
    path: "worktree.diff_file",
    scope: "filesystem:read",
    call: (s: McpInvocationScope) => Reads.diffFile(s, fileInput),
  },
];
it.effect.each(paths)("$path refuses thread callers even with explicit grants", (path) =>
  Effect.gen(function* () {
    const f = fixture();
    const result = yield* path
      .call({
        ...client(),
        client: undefined,
        thread: {
          threadId,
          providerSessionId: "test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      })
      .pipe(Effect.result, Effect.provide(f.layer));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "capability_denied", message: expect.stringContaining(path.scope) },
    });
    expect(f.calls).toEqual([]);
  }),
);
it.effect.each(paths)(
  "$path refuses outside clients missing the scope regardless of full access",
  (path) =>
    Effect.gen(function* () {
      const f = fixture();
      const result = yield* path
        .call({
          ...client(),
          grantedScopes: [],
          client: { sessionId: "test", label: "test", access: "full-access" },
        })
        .pipe(Effect.result, Effect.provide(f.layer));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "capability_denied", message: expect.stringContaining(path.scope) },
      });
      expect(f.calls).toEqual([]);
    }),
);
it.effect.each(paths)(
  "$path refuses missing or revoked live reauthorization before reading data",
  (path) =>
    Effect.gen(function* () {
      for (const reauthorize of [
        undefined,
        () =>
          Effect.fail(
            new EnvironmentAuthorizationError({
              message: "revoked",
              requiredScope: path.scope,
            }),
          ),
      ]) {
        const f = fixture();
        const { reauthorize: _previous, ...base } = client();
        const result = yield* path
          .call({ ...base, ...(reauthorize === undefined ? {} : { reauthorize }) })
          .pipe(Effect.result, Effect.provide(f.layer));
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { code: "capability_denied", message: expect.stringContaining(path.scope) },
        });
        expect(f.calls).toEqual([]);
      }
    }),
);
it.effect.each(paths)("$path returns data only after the exact scope is reauthorized", (path) =>
  Effect.gen(function* () {
    const f = fixture();
    const result = yield* path
      .call({
        ...client(),
        reauthorize: (scopes) =>
          Effect.sync(() => {
            expect(scopes).toEqual([path.scope]);
            expect(f.calls).toEqual([]);
          }),
      })
      .pipe(Effect.provide(f.layer));
    expect(result.truncated).toBe(false);
    expect(f.calls.length).toBeGreaterThan(0);
    if ("buckets" in result) expect(result.buckets).toHaveLength(1);
    if ("sources" in result) expect(result.sources).toHaveLength(1);
    if ("oldContents" in result)
      expect(result).toMatchObject({ oldContents: "old", newContents: "new" });
  }),
);
it.effect("bounds usage rows and bytes and refuses windows beyond 31 inclusive days", () =>
  Effect.gen(function* () {
    const f = fixture(true);
    const result = yield* Reads.usage(client(), {
      ...usageInput,
      untilDay: UsageDay.make("2026-01-31"),
    }).pipe(Effect.provide(f.layer));
    expect(result.buckets).toHaveLength(256);
    expect(result.sources).toHaveLength(32);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(encodeUsage(result)))).toBeLessThanOrEqual(262144);
    const before = f.calls.length;
    for (const untilDay of ["2026-02-01", "2026-02-30", "2025-12-31"]) {
      const rejected = yield* Reads.usage(client(), {
        ...usageInput,
        untilDay: UsageDay.make(untilDay),
      }).pipe(Effect.result, Effect.provide(f.layer));
      expect(rejected).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } });
    }
    expect(f.calls).toHaveLength(before);
  }),
);
it.effect("bounds process and resource points, process counts and UTF-8 command strings", () =>
  Effect.gen(function* () {
    const f = fixture(true);
    const results = yield* Effect.all([
      Reads.processHistory(client(), { windowMs: 1e12, bucketMs: 0 }),
      Reads.resourceHistory(client(), { windowMs: 1e12, bucketMs: 0 }),
    ]).pipe(Effect.provide(f.layer));
    expect(Buffer.byteLength(JSON.stringify(encodeProcesses(results[0])))).toBeLessThanOrEqual(
      262144,
    );
    expect(Buffer.byteLength(JSON.stringify(encodeResources(results[1])))).toBeLessThanOrEqual(
      262144,
    );
    for (const result of results) {
      expect(result.buckets).toHaveLength(240);
      expect(result.topProcesses).toHaveLength(64);
      expect(result.truncated).toBe(true);
      for (const row of result.topProcesses) {
        expect(Buffer.byteLength(row.command)).toBeLessThanOrEqual(1024);
        expect(row.command).not.toContain("�");
      }
    }
    for (const call of f.calls) expect(call.input).toEqual({ windowMs: 3600000, bucketMs: 15000 });
  }),
);
it.effect("bounds diff preview files and patches with a truncation flag", () =>
  Effect.gen(function* () {
    const f = fixture(true);
    const result = yield* Reads.diffPreview(client(), previewInput).pipe(Effect.provide(f.layer));
    expect(result.truncated).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.files).toHaveLength(256);
    expect(Buffer.byteLength(result.sources[0]?.diff ?? "")).toBeLessThanOrEqual(131072);
    expect(result.sources[0]?.diff).not.toContain("�");
    expect(Buffer.byteLength(JSON.stringify(encodePreview(result)))).toBeLessThanOrEqual(262144);
  }),
);
it.effect("caps each diff file side at 256 KiB on a UTF-8 boundary and reports each cut", () =>
  Effect.gen(function* () {
    const f = fixture(true);
    const result = yield* Reads.diffFile(client(), fileInput).pipe(Effect.provide(f.layer));
    expect(result).toMatchObject({ oldTruncated: true, newTruncated: true, truncated: true });
    expect(result.oldContents).toBe("a".repeat(262143));
    expect(result.newContents).toBe("한".repeat(87381));
    // The new side is always the working tree or index, so no head revision is passed on.
    expect(f.calls.find((call) => call.operation === "file")?.input).toMatchObject({
      headRef: null,
    });
  }),
);
it.effect("returns the usage service's window refusal as invalid_request", () =>
  Effect.gen(function* () {
    const refused = yield* Reads.usage(client(), {
      ...usageInput,
      resolution: "hour",
    }).pipe(
      Effect.result,
      Effect.provide(
        Layer.mock(Usage.UsageService)({
          readSummary: () =>
            Effect.fail(
              new UsageReadError({ reason: "invalidWindow", detail: "sinceTime is required." }),
            ),
        }),
      ),
    );
    expect(refused).toMatchObject({
      _tag: "Failure",
      failure: { code: "invalid_request", message: "sinceTime is required." },
    });
  }),
);
it.effect(
  "resolves known project and thread checkouts and refuses missing, ambiguous and unknown targets",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const injectedPreview = { ...previewInput, cwd: "/unregistered" };
      yield* Reads.diffPreview(client(), injectedPreview).pipe(Effect.provide(f.layer));
      const { projectId: _project, ...threadFileInput } = fileInput;
      const injectedFile = { ...threadFileInput, threadId, cwd: "/unregistered" };
      yield* Reads.diffFile(client(), injectedFile).pipe(Effect.provide(f.layer));
      expect(
        f.calls
          .filter((call) => ["preview", "file"].includes(call.operation))
          .map((call) => call.input),
      ).toMatchObject([{ cwd: "/repo" }, { cwd: "/repo-worktree" }]);
      for (const target of [
        {},
        { cwd: "/unregistered" },
        { projectId, threadId },
        { projectId: ProjectId.make("unknown") },
        { threadId: ThreadId.make("unknown") },
      ]) {
        const result = yield* Reads.diffPreview(client(), target).pipe(
          Effect.result,
          Effect.provide(f.layer),
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } });
      }
      expect(f.calls.filter((call) => ["preview", "file"].includes(call.operation))).toHaveLength(
        2,
      );
    }),
);

it.effect("stops usage rows at the total byte budget before the count limit", () =>
  Effect.gen(function* () {
    const f = fixture(true, true);
    const result = yield* Reads.usage(client(), usageInput).pipe(Effect.provide(f.layer));
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.buckets.length).toBeLessThan(256);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(encodeUsage(result)))).toBeLessThanOrEqual(262144);
  }),
);
