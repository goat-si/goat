import * as M from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { configuredMemoryModelSelection } from "@goat/shared/serverSettings";
import * as Settings from "../serverSettings.ts";
import * as MemoryService from "./MemoryService.ts";
import * as Hold from "./MemoryGenerationHold.ts";
import * as Sync from "./MemorySyncService.ts";

type Permit = Effect.Effect<void, MemoryService.MemoryAccessError>;

export class MemorySettingsService extends Context.Service<
  MemorySettingsService,
  {
    readonly get: (
      permit: Permit,
      includeModelAvailability?: boolean,
    ) => Effect.Effect<M.MemorySettingsViewWithAvailability, Error>;
    readonly update: (
      input: M.MemorySettingsUpdateInput,
      permit: Permit,
    ) => Effect.Effect<M.MemorySettingsView, Error>;
  }
>()("goat/memory/MemorySettingsService") {}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const sync = yield* Sync.MemorySyncService;
  const hold = yield* Hold.shared;
  const view = (includeModelAvailability = false) =>
    settings.getSettings.pipe(
      Effect.flatMap((current) =>
        hold.resolveModel(current).pipe(
          Effect.map((selection): M.MemorySettingsViewWithAvailability => ({
            enabled: current.memoryEnabled,
            hub: { mode: current.memoryHub.mode, version: current.memoryHubVersion },
            model: {
              selection: selection ?? configuredMemoryModelSelection(current),
              automatic: current.memoryModelSelection === null,
            },
            ...(includeModelAvailability ? { modelAvailable: selection !== null } : {}),
          })),
        ),
      ),
    );
  return MemorySettingsService.of({
    get: (permit, includeModelAvailability) =>
      permit.pipe(Effect.andThen(view(includeModelAvailability))),
    update: (input, permit) =>
      Effect.gen(function* () {
        yield* permit;
        const current = yield* settings.getSettings;
        if (input.hubSync !== undefined) {
          if (input.hubSync.enabled && current.memoryHub.mode === "member")
            return yield* new M.MemoryRpcError({ code: "unsupported_operation" });
          const alreadyRequested = input.hubSync.enabled
            ? current.memoryHub.mode === "hub"
            : current.memoryHub.mode === "disabled";
          if (!alreadyRequested) {
            yield* sync.updateHubSettings(
              {
                requestId: input.requestId,
                expectedVersion: input.hubSync.expectedVersion,
                action: "configure",
                settings: input.hubSync.enabled
                  ? { mode: "hub", memorySpaceId: null }
                  : { mode: "disabled" },
              },
              permit,
            );
          }
        }
        if (input.enabled !== undefined || input.modelSelection !== undefined)
          yield* settings.updateSettings({
            ...(input.enabled === undefined ? {} : { memoryEnabled: input.enabled }),
            ...(input.modelSelection === undefined
              ? {}
              : { memoryModelSelection: input.modelSelection }),
          });
        return yield* view();
      }),
  });
});

export const layer = Layer.effect(MemorySettingsService, make);
