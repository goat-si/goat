import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as MemoryAccess from "../../../memory/MemoryAccess.ts";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
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

const decodeSearch = Schema.decodeUnknownEffect(M.MemorySearchInput);
const decodeList = Schema.decodeUnknownEffect(M.MemoryListInput);
const decodeReadSource = Schema.decodeUnknownEffect(M.MemoryReadSourceInput);
const decodeRead = Schema.decodeUnknownEffect(M.MemoryReadInput);
const decodeHistory = Schema.decodeUnknownEffect(M.MemoryHistoryInput);
const decodeSyncStatus = Schema.decodeUnknownEffect(M.MemorySyncStatusInput);
const decodeUpsert = Schema.decodeUnknownEffect(M.MemoryUpsertInput);
const decodeForget = Schema.decodeUnknownEffect(M.MemoryForgetInput);
const decodeRevertResolution = Schema.decodeUnknownEffect(M.MemoryRevertResolutionInput);
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
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.list(
        yield* decodeList(input),
        yield* invocationPermit("read"),
        yield* callerThread,
      );
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.read(
        yield* decodeRead(input),
        yield* invocationPermit("read"),
        yield* callerThread,
      );
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_read_source: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.readSource(
        yield* decodeReadSource(input),
        yield* invocationPermit("source"),
        yield* callerThread,
      );
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_history: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      return yield* service.history(
        yield* decodeHistory(input),
        yield* invocationPermit("read"),
        yield* callerThread,
      );
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_sync_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemorySyncService.MemorySyncService;
      // Agents read the JSON directly, so they always get the generation hold.
      return yield* service.syncStatus(
        { ...(yield* decodeSyncStatus(input)), includeGenerationHold: true },
        yield* invocationPermit("read"),
      );
    }).pipe(Effect.mapError(memoryError)),
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
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_forget: McpToolAccess.destructive(
    McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const service = yield* MemoryService.MemoryService;
        return yield* service
          .forget(yield* decodeForget(input), yield* invocationPermit("write"))
          .pipe(Effect.flatMap((stored) => receipt(stored.receipt)));
      }).pipe(Effect.mapError(memoryError)),
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
      }).pipe(Effect.mapError(memoryError)),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof MemoryToolkit.tools>;
export const layer = McpToolAccess.toLayer(MemoryToolkit, handlers);
