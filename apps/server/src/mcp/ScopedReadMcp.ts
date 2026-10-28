import {
  OrchestratorMcpFailure,
  type ResourceTelemetryHistoryInput,
  type ServerProcessResourceHistoryInput,
  type UsageSummaryInput,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Processes from "../diagnostics/ProcessResourceMonitor.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Telemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import { normalizeResourceTelemetryHistoryInput } from "../resourceTelemetry/ResourceTelemetryHistory.ts";
import * as Review from "../review/ReviewService.ts";
import * as Usage from "../usage/UsageService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ReadSchemas from "./scopedReadSchemas.ts";
import { unavailable } from "./threadAccess.ts";

const RESPONSE_BYTES = 256 * 1024;
const STRING_BYTES = 1024;
const HISTORY_POINTS = 240;
const PROCESS_ROWS = 64;
const DAY_MS = 86_400_000;
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const authorize = Effect.fn("ScopedReadMcp.authorize")(function* (
  scope: McpInvocationScope,
  required: "diagnostics:read" | "filesystem:read",
) {
  const denied = () =>
    new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `This read requires an explicit ${required} grant and live client reauthorization.`,
    });
  if (
    scope.thread !== undefined ||
    scope.client === undefined ||
    !scope.grantedScopes?.includes(required) ||
    scope.reauthorize === undefined
  )
    return yield* denied();
  yield* scope.reauthorize([required]).pipe(Effect.mapError(denied));
});

function budget() {
  let truncated = false;
  let remaining = RESPONSE_BYTES - 32 * 1024;
  const text = (value: string, max = STRING_BYTES) => {
    const bytes = Buffer.from(value);
    if (bytes.length <= max) return value;
    truncated = true;
    let end = max;
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
  };
  const rows = <A>(values: ReadonlyArray<A>, max: number) => {
    const result: A[] = [];
    for (const value of values) {
      const size = Buffer.byteLength(JSON.stringify(value)) + 1;
      if (result.length === max || size > remaining) {
        truncated = true;
        break;
      }
      remaining -= size;
      result.push(value);
    }
    return result;
  };
  return {
    text,
    rows,
    get truncated() {
      return truncated;
    },
  };
}

const encodeUsage = Schema.encodeSync(Schema.toCodecJson(ReadSchemas.UsageResult));
const encodeProcesses = Schema.encodeSync(Schema.toCodecJson(ReadSchemas.ProcessHistoryResult));
const encodeResources = Schema.encodeSync(Schema.toCodecJson(ReadSchemas.ResourceHistoryResult));
const encodePreview = Schema.encodeSync(Schema.toCodecJson(ReadSchemas.DiffPreviewResult));
// Measure the wire encoding, including Option/DateTime codecs and JSON escaping.
const withinBudget = <A>(encode: (value: A) => unknown, value: A) =>
  Buffer.byteLength(JSON.stringify(encode(value))) <= RESPONSE_BYTES;

export const usage = Effect.fn("ScopedReadMcp.usage")(function* (
  scope: McpInvocationScope,
  input: UsageSummaryInput,
) {
  yield* authorize(scope, "diagnostics:read");
  const since = DateTime.make(`${input.sinceDay}T00:00:00Z`);
  const until = DateTime.make(`${input.untilDay}T00:00:00Z`);
  if (Option.isNone(since) || Option.isNone(until))
    return yield* invalid("Usage requires valid calendar days.");
  const span = DateTime.toEpochMillis(until.value) - DateTime.toEpochMillis(since.value);
  if (
    span < 0 ||
    span >= 31 * DAY_MS ||
    DateTime.formatIso(since.value).slice(0, 10) !== input.sinceDay ||
    DateTime.formatIso(until.value).slice(0, 10) !== input.untilDay
  )
    return yield* invalid("Usage requires a valid inclusive window of at most 31 days.");
  const service = yield* Usage.UsageService;
  const data = yield* service.readSummary(input).pipe(Effect.mapError(unavailable));
  const b = budget();
  const result = {
    ...data,
    readAt: b.text(data.readAt),
    timeZone: b.text(data.timeZone),
    pricing: {
      ...data.pricing,
      source: b.text(data.pricing.source),
      fetchedAt: data.pricing.fetchedAt === null ? null : b.text(data.pricing.fetchedAt),
    },
    buckets: b.rows(data.buckets, 256),
    sources: b.rows(data.sources, 32),
    truncated: false,
  };
  result.truncated = b.truncated;
  if (!withinBudget(encodeUsage, result)) return yield* unavailable();
  return result;
});

function historyWindow(input: ServerProcessResourceHistoryInput) {
  const normalized = normalizeResourceTelemetryHistoryInput(input);
  return {
    ...normalized,
    bucketMs: Math.max(normalized.bucketMs, Math.ceil(normalized.windowMs / HISTORY_POINTS)),
  };
}

export const processHistory = Effect.fn("ScopedReadMcp.processHistory")(function* (
  scope: McpInvocationScope,
  input: ServerProcessResourceHistoryInput,
) {
  yield* authorize(scope, "diagnostics:read");
  const window = historyWindow(input);
  const data = yield* (yield* Processes.ProcessResourceMonitor).readHistory(window);
  const b = budget();
  const result = {
    ...data,
    buckets: b.rows(data.buckets, HISTORY_POINTS),
    topProcesses: b.rows(
      data.topProcesses.slice(0, PROCESS_ROWS).map((row) => ({
        ...row,
        command: b.text(row.command),
        processKey: b.text(row.processKey),
      })),
      PROCESS_ROWS,
    ),
    error: Option.map(data.error, (error) => ({ ...error, message: b.text(error.message) })),
    truncated: false,
  };
  result.truncated =
    b.truncated ||
    data.topProcesses.length > PROCESS_ROWS ||
    input.windowMs !== window.windowMs ||
    input.bucketMs !== window.bucketMs;
  if (!withinBudget(encodeProcesses, result)) return yield* unavailable();
  return result;
});

export const resourceHistory = Effect.fn("ScopedReadMcp.resourceHistory")(function* (
  scope: McpInvocationScope,
  input: ResourceTelemetryHistoryInput,
) {
  yield* authorize(scope, "diagnostics:read");
  const window = historyWindow(input);
  const raw = yield* (yield* Telemetry.ResourceTelemetry).readHistory(window);
  const { legacyBackendBuckets: _legacy, ...data } = raw;
  const b = budget();
  const result = {
    ...data,
    buckets: b.rows(data.buckets, HISTORY_POINTS),
    topProcesses: b.rows(
      data.topProcesses.slice(0, PROCESS_ROWS).map((row) => ({
        ...row,
        command: b.text(row.command),
        name: b.text(row.name),
      })),
      PROCESS_ROWS,
    ),
    health: {
      ...data.health,
      native: {
        ...data.health.native,
        lastError: Option.map(data.health.native.lastError, b.text),
      },
      desktop: {
        ...data.health.desktop,
        lastError: Option.map(data.health.desktop.lastError, b.text),
      },
      sidecarVersion: Option.map(data.health.sidecarVersion, b.text),
    },
    truncated: false,
  };
  result.truncated =
    b.truncated ||
    data.topProcesses.length > PROCESS_ROWS ||
    input.windowMs !== window.windowMs ||
    input.bucketMs !== window.bucketMs;
  if (!withinBudget(encodeResources, result)) return yield* unavailable();
  return result;
});

const checkout = Effect.fn("ScopedReadMcp.checkout")(function* (input: {
  readonly projectId?: ReadSchemas.DiffPreviewInput["projectId"];
  readonly threadId?: ReadSchemas.DiffPreviewInput["threadId"];
}) {
  if ((input.projectId === undefined) === (input.threadId === undefined))
    return yield* invalid("Supply exactly one projectId or threadId for a known GOAT checkout.");
  const thread =
    input.threadId === undefined
      ? undefined
      : yield* (yield* Threads.ThreadManagementService)
          .getThreadShell(input.threadId)
          .pipe(Effect.mapError(unavailable));
  if (thread === null || thread?.deletedAt != null)
    return yield* invalid("The thread was not found.");
  const projectId = thread?.projectId ?? input.projectId;
  if (projectId === undefined) return yield* invalid("The project was not found.");
  const project = yield* (yield* Projects.ProjectService)
    .getById(projectId)
    .pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) return yield* invalid("The project was not found.");
  return thread?.worktreePath ?? project.value.workspaceRoot;
});

export const diffPreview = Effect.fn("ScopedReadMcp.diffPreview")(function* (
  scope: McpInvocationScope,
  input: ReadSchemas.DiffPreviewInput,
) {
  yield* authorize(scope, "filesystem:read");
  const cwd = yield* checkout(input);
  const { projectId: _project, threadId: _thread, ...request } = input;
  const data = yield* (yield* Review.ReviewService)
    .getDiffPreview({ ...request, cwd })
    .pipe(Effect.mapError(unavailable));
  const b = budget();
  const sources = b.rows(
    data.sources.slice(0, 4).map((source) => {
      const diff = b.text(source.diff, 128 * 1024);
      const files = source.files === undefined ? undefined : b.rows(source.files, 256);
      return {
        ...source,
        diff,
        ...(files === undefined ? {} : { files }),
        truncated:
          source.truncated || diff !== source.diff || files?.length !== source.files?.length,
      };
    }),
    4,
  );
  const result = {
    ...data,
    sources,
    truncated: b.truncated || data.sources.length > 4 || sources.some((source) => source.truncated),
  };
  if (!withinBudget(encodePreview, result)) return yield* unavailable();
  return result;
});

export const diffFile = Effect.fn("ScopedReadMcp.diffFile")(function* (
  scope: McpInvocationScope,
  input: ReadSchemas.DiffFileInput,
) {
  yield* authorize(scope, "filesystem:read");
  const cwd = yield* checkout(input);
  const { projectId: _project, threadId: _thread, ...request } = input;
  const data = yield* (yield* Review.ReviewService)
    .getDiffFileContents({ ...request, cwd })
    .pipe(Effect.mapError(unavailable));
  const b = budget();
  const oldContents = b.text(data.oldContents, RESPONSE_BYTES);
  const newContents = b.text(data.newContents, RESPONSE_BYTES);
  return {
    oldContents,
    newContents,
    oldTruncated: oldContents !== data.oldContents,
    newTruncated: newContents !== data.newContents,
    truncated: b.truncated,
  };
});
