import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as MemoryAccess from "../../../memory/MemoryAccess.ts";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { schemaIssueSummary } from "../../../memory/memoryDiagnostics.ts";
import { listedToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import { MemoryToolkit } from "./tools.ts";

const isMemoryError = Schema.is(M.MemoryRpcError);
const isCapacityDimension = Schema.is(M.MemoryCapacityDimension);
const isCapacity = Schema.is(M.MemoryCapacityExceeded);
const isFailureCode = Schema.is(M.MemoryFailureCode);

/** Only safe typed fields cross MCP; optional fields are absent, never undefined. */
export const memoryError = (error: unknown): M.MemoryRpcError => {
  if (isMemoryError(error)) return error;
  if (typeof error !== "object" || error === null)
    return new M.MemoryRpcError({ code: "storage_failed" });
  if (
    "_tag" in error &&
    (error._tag === "MemoryHubForbiddenError" || error._tag === "MemoryHubUnauthorizedError")
  )
    return new M.MemoryRpcError({ code: "unavailable" });
  if ("capacity" in error && isCapacity(error.capacity))
    return new M.MemoryRpcError({ code: "capacity_exceeded", capacity: error.capacity });
  if ("_tag" in error && error._tag === "SchemaError")
    return new M.MemoryRpcError({ code: "invalid_output" });
  if (
    "_tag" in error &&
    error._tag === "MemoryCapacityError" &&
    "dimension" in error &&
    isCapacityDimension(error.dimension) &&
    "current" in error &&
    typeof error.current === "number" &&
    "limit" in error &&
    typeof error.limit === "number"
  ) {
    const capacity = {
      code: "capacity_exceeded" as const,
      dimension: error.dimension,
      current: error.current,
      limit: error.limit,
      reclaimable: "reclaimable" in error ? error.reclaimable : 0,
    };
    return isCapacity(capacity)
      ? new M.MemoryRpcError({ code: "capacity_exceeded", capacity })
      : new M.MemoryRpcError({ code: "storage_failed" });
  }
  if ("code" in error && isFailureCode(error.code) && error.code !== "capacity_exceeded")
    return new M.MemoryRpcError({
      code: error.code,
      ...(error.code === "thread_lineage_incomplete"
        ? {
            guidance:
              "This conversation has incomplete memory provenance and cannot save new memories. Start a new conversation to save this memory." as const,
          }
        : {}),
    });
  return new M.MemoryRpcError({ code: "storage_failed" });
};

export const invocationPermit = (requirement: MemoryAccess.MemoryAccessRequirement | "settings") =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const deny = () => new MemoryService.MemoryAccessError({ code: "unavailable" });
    if (requirement === "settings")
      return Effect.suspend(() => {
        if (
          scope.readOnly ||
          scope.client?.access === "read-only" ||
          !scope.grantedScopes?.includes("settings:write") ||
          !scope.reauthorize
        )
          return Effect.fail(deny());
        return scope.reauthorize(["settings:write"]).pipe(Effect.mapError(deny));
      });
    return MemoryAccess.memoryAccessPermit(
      {
        ...(scope.grantedScopes === undefined ? {} : { grantedScopes: scope.grantedScopes }),
        ...(scope.reauthorize === undefined
          ? {}
          : {
              reauthorize: (required) => scope.reauthorize!(required).pipe(Effect.mapError(deny)),
            }),
        readOnly: scope.readOnly === true || scope.client?.access === "read-only",
        liveCaller: scope.capabilities.has("memory") ? Effect.void : Effect.fail(deny()),
      },
      requirement,
    );
  });

const isRefusal = Schema.is(M.OrchestratorMcpFailure);

/**
 * A malformed call is the caller's to fix, so it is refused as invalid_request before anything
 * runs. The message names fields, never their values: arguments can carry personal memory text.
 */
const argumentsOf =
  <S extends Schema.Top>(tool: string, schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input, { errors: "all" }).pipe(
      Effect.mapError((error) => {
        const entry = resolveAgentSurfaceEntry(tool);
        const problems = schemaIssueSummary(error.issue);
        const space = problems.includes("memorySpaceId")
          ? " Read memorySpaceId from goat_memory_sync_status."
          : "";
        return new M.OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${entry === undefined ? tool : listedToolName(entry)} got invalid arguments (${problems}), so nothing ran.${space}`,
        });
      }),
    );

const failureShape = (error: unknown) => {
  if (typeof error !== "object" || error === null) return { errorTag: typeof error };
  const cause = "cause" in error ? error.cause : undefined;
  const schema = Schema.isSchemaError(error)
    ? error
    : Schema.isSchemaError(cause)
      ? cause
      : undefined;
  return {
    errorTag: "_tag" in error ? String(error._tag) : "unknown",
    ...("stage" in error && typeof error.stage === "string" ? { stage: error.stage } : {}),
    ...(typeof cause === "object" && cause !== null && "_tag" in cause
      ? { causeTag: String(cause._tag) }
      : {}),
    ...(schema ? { issues: schemaIssueSummary(schema.issue) } : {}),
  };
};

/** Failures the caller cannot act on are logged by shape so they are never silent. */
const memoryFailure = (tool: string) => (error: unknown) => {
  if (isRefusal(error)) return Effect.fail(error);
  const mapped = memoryError(error);
  return mapped.code === "invalid_output" || mapped.code === "storage_failed"
    ? Effect.logWarning("memory tool failed", {
        tool,
        code: mapped.code,
        ...failureShape(error),
      }).pipe(Effect.andThen(Effect.fail(mapped)))
    : Effect.fail(mapped);
};

const decodeSearch = argumentsOf("memory_search", M.MemorySearchInput);
const decodeList = argumentsOf("memory_list", M.MemoryListInput);
const decodeReadSource = argumentsOf("memory_read_source", M.MemoryReadSourceInput);
const decodeRead = argumentsOf("memory_read", M.MemoryReadInput);
const decodeHistory = argumentsOf("memory_history", M.MemoryHistoryInput);
const decodeSyncStatus = argumentsOf("memory_sync_status", M.MemorySyncStatusInput);
const decodeUpsert = argumentsOf("memory_upsert", M.MemoryUpsertInput);
const decodeForget = argumentsOf("memory_forget", M.MemoryForgetInput);
const decodeRevertResolution = argumentsOf(
  "memory_revert_resolution",
  M.MemoryRevertResolutionInput,
);
const receipt = Schema.decodeUnknownEffect(M.MemoryMutationReceipt);
const callerThread = Effect.gen(function* () {
  const caller = yield* McpInvocationContext.McpInvocationContext;
  return caller.thread
    ? { environmentId: caller.environmentId, threadId: caller.thread.threadId }
    : undefined;
});
const handlers = {
  memory_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.search(
        yield* decodeSearch(input),
        yield* invocationPermit("read"),
        yield* callerThread,
      );
    }).pipe(Effect.catch(memoryFailure("memory_search"))),
  ),
  memory_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.list(
        yield* decodeList(input),
        yield* invocationPermit("read"),
        yield* callerThread,
      );
    }).pipe(Effect.catch(memoryFailure("memory_list"))),
  ),
  memory_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.read(
        yield* decodeRead(input),
        yield* invocationPermit("read"),
        yield* callerThread,
      );
    }).pipe(Effect.catch(memoryFailure("memory_read"))),
  ),
  memory_read_source: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.readSource(
        yield* decodeReadSource(input),
        yield* invocationPermit("source"),
        yield* callerThread,
      );
    }).pipe(Effect.catch(memoryFailure("memory_read_source"))),
  ),
  memory_history: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.history(
        yield* decodeHistory(input),
        yield* invocationPermit("read"),
        yield* callerThread,
      );
    }).pipe(Effect.catch(memoryFailure("memory_history"))),
  ),
  memory_sync_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemorySyncService.MemorySyncService;
      // Agents read the JSON directly, so they always get the generation hold.
      return yield* service.syncStatus(
        { ...(yield* decodeSyncStatus(input)), includeGenerationHold: true },
        yield* invocationPermit("read"),
      );
    }).pipe(Effect.catch(memoryFailure("memory_sync_status"))),
  ),
  memory_upsert: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      const caller = yield* McpInvocationContext.McpInvocationContext;
      return yield* service
        .upsert(
          yield* decodeUpsert(input),
          yield* invocationPermit("write"),
          caller.thread
            ? { environmentId: caller.environmentId, threadId: caller.thread.threadId }
            : undefined,
        )
        .pipe(Effect.flatMap((stored) => receipt(stored.receipt)));
    }).pipe(Effect.catch(memoryFailure("memory_upsert"))),
  ),
  memory_forget: McpToolAccess.destructive(
    McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const service = yield* MemoryService.MemoryService;
        return yield* service
          .forget(yield* decodeForget(input), yield* invocationPermit("write"))
          .pipe(Effect.flatMap((stored) => receipt(stored.receipt)));
      }).pipe(Effect.catch(memoryFailure("memory_forget"))),
    ),
  ),
  memory_revert_resolution: McpToolAccess.destructive(
    McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const service = yield* MemoryService.MemoryService;
        return yield* service.revertResolution(
          yield* decodeRevertResolution(input),
          yield* invocationPermit("write"),
          yield* callerThread,
        );
      }).pipe(Effect.catch(memoryFailure("memory_revert_resolution"))),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof MemoryToolkit.tools>;
export const layer = McpToolAccess.toLayer(MemoryToolkit, handlers);
