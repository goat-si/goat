import * as M from "@goat/contracts";
import { resolveMemoryModelSelection } from "@goat/shared/serverSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Settings from "../serverSettings.ts";
import * as MemoryService from "./MemoryService.ts";
import * as Sync from "./MemorySyncService.ts";

type Permit = Effect.Effect<void, MemoryService.MemoryAccessError>;

export class MemorySettingsService extends Context.Service<
  MemorySettingsService,
  {
    readonly get: (permit: Permit) => Effect.Effect<M.MemorySettingsView, Error>;
    readonly update: (
      input: M.MemorySettingsUpdateInput,
      permit: Permit,
    ) => Effect.Effect<M.MemorySettingsView, Error>;
  }
>()("goat/memory/MemorySettingsService") {}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const sync = yield* Sync.MemorySyncService;
  const view = settings.getSettings.pipe(
    Effect.map((current): M.MemorySettingsView => ({
      enabled: current.memoryEnabled,
      hub: { mode: current.memoryHub.mode, version: current.memoryHubVersion },
      model: {
        selection: resolveMemoryModelSelection(current, undefined),
        automatic: current.memoryModelSelection === null,
      },
    })),
  );
  return MemorySettingsService.of({
    get: (permit) => permit.pipe(Effect.andThen(view)),
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
        return yield* view;
      }),
  });
});

export const layer = Layer.effect(MemorySettingsService, make);
