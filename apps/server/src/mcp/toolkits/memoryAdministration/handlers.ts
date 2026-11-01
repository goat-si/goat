import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as MemoryService from "../../../memory/MemoryService.ts";
import * as MemorySyncService from "../../../memory/MemorySyncService.ts";
import * as MemorySettingsService from "../../../memory/MemorySettingsService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { invocationPermit, memoryError, memoryFailure } from "../memory/handlers.ts";
import { loadCaller } from "../../threadAccess.ts";
import { MemoryAdministrationToolkit } from "./tools.ts";
const decode = Schema.decodeUnknownEffect(M.MemoryHubDisableInput);
const disabled = Schema.decodeUnknownEffect(M.MemoryHubDisableResult);
const decodeSettingsUpdate = Schema.decodeUnknownEffect(M.MemorySettingsUpdateInput);
const decodeBindingRead = Schema.decodeUnknownEffect(M.MemoryProjectBindingGetInput);
const decodeDiagnostics = Schema.decodeUnknownEffect(M.MemorySyncStatusInput);
const decodeReconcile = Schema.decodeUnknownEffect(M.MemoryHubReconcileInput);
const decodeReportReset = Schema.decodeUnknownEffect(M.MemoryResetReportAttemptsInput);
const requireNotPlan = Effect.gen(function* () {
  const caller = yield* loadCaller();
  if (caller.limits.interactionMode === "plan")
    return yield* new M.OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Memory administration writes are unavailable in plan mode.",
    });
});
const writePermit = Effect.fn("MemoryAdministration.writePermit")(function* () {
  const context = yield* Effect.context<Effect.Services<typeof requireNotPlan>>();
  const permit = yield* invocationPermit("settings");
  const readPermit = yield* invocationPermit("read");
  return permit.pipe(
    Effect.andThen(readPermit),
    Effect.andThen(
      requireNotPlan.pipe(
        Effect.provideContext(context),
        Effect.mapError(() => new MemoryService.MemoryAccessError({ code: "unavailable" })),
      ),
    ),
  );
});
export const layer = McpToolAccess.toLayer(MemoryAdministrationToolkit, {
  goat_memory_binding_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      const value = yield* decodeBindingRead(input, {
        onExcessProperty: "error",
      });
      return {
        binding: yield* service.peekProjectBinding(value, yield* invocationPermit("binding-read")),
      };
    }).pipe(Effect.mapError(memoryError)),
  ),
  goat_memory_hub_diagnostics: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* MemorySyncService.MemorySyncService;
      const value = yield* decodeDiagnostics(input, {
        onExcessProperty: "error",
      });
      return yield* service.hubDiagnostics(value, yield* invocationPermit("read"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  goat_memory_hub_reconcile: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      yield* requireNotPlan;
      const value = yield* decodeReconcile(input, {
        onExcessProperty: "error",
      });
      const permit = yield* writePermit();
      yield* permit;
      const service = yield* MemorySyncService.MemorySyncService;
      return yield* service.reconcileHub(value, permit);
    }).pipe(Effect.catch(memoryFailure("goat_memory_hub_reconcile"))),
  ),
  goat_memory_report_attempts_reset: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      yield* requireNotPlan;
      const value = yield* decodeReportReset(input, {
        onExcessProperty: "error",
      });
      const permit = yield* writePermit();
      yield* permit;
      const service = yield* MemoryService.MemoryService;
      return yield* service.resetReportAttempts(value, permit);
    }).pipe(Effect.catch(memoryFailure("goat_memory_report_attempts_reset"))),
  ),
  memory_settings_get: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const service = yield* MemorySettingsService.MemorySettingsService;
      return yield* service.get(yield* invocationPermit("read"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_settings_update: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const value = yield* decodeSettingsUpdate(input);
      const service = yield* MemorySettingsService.MemorySettingsService;
      return yield* service.update(value, yield* invocationPermit("settings"));
    }).pipe(Effect.mapError(memoryError)),
  ),
  memory_hub_disable: McpToolAccess.destructive(
    McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const value = yield* decode(input);
        const service = yield* MemorySyncService.MemorySyncService;
        return yield* service
          .updateHubSettings(
            { ...value, action: "configure", settings: { mode: "disabled" } },
            yield* invocationPermit("settings"),
          )
          .pipe(
            Effect.flatMap((result) =>
              disabled({ settings: result.view.settings, version: result.view.version }),
            ),
          );
      }).pipe(Effect.mapError(memoryError)),
    ),
  ),
});
