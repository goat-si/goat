import { MemoryHubError } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type {
  HubTransitionMarker,
  MemoryHubAdminSettings,
  MemoryHubSettingsTransitions,
  ServerSettingsService,
} from "./serverSettings.ts";

const HubSettingsLock = Context.Reference<boolean>("goat/serverSettings/HubSettingsLock", {
  defaultValue: () => false,
});

export const hubAdministrationSettings = (
  readUnlocked: ServerSettingsService["Service"]["getSettings"],
  readLocked: ServerSettingsService["Service"]["getSettings"],
  withLock: MemoryHubAdminSettings["Service"]["withLock"],
  marker: Effect.Effect<HubTransitionMarker | null>,
  applyLocked: MemoryHubSettingsTransitions["Service"]["applyMemoryHubTransition"],
  readPublication: MemoryHubAdminSettings["Service"]["readPublication"],
): MemoryHubAdminSettings["Service"] => {
  // Inside withLock a cache miss must load on this fiber; the cache lookup would wait on our permit.
  const read = Effect.gen(function* () {
    return yield* (yield* HubSettingsLock) ? readLocked : readUnlocked;
  });
  return {
    withLock: (effect) => withLock(effect.pipe(Effect.provideService(HubSettingsLock, true))),
    readPublication,
    read: read.pipe(
      Effect.map((current) => ({
        settings: current.memoryHub,
        version: current.memoryHubVersion,
        provenance: current.memoryHubProvenance ?? null,
      })),
      Effect.mapError(() => new MemoryHubError({ code: "storage_failed" })),
    ),
    readPreviousHubRequestId: Effect.map(marker, (saved) => saved?.requestId ?? null),
    readPreviousHubSpace: read.pipe(
      Effect.flatMap((current) =>
        current.memoryHub.mode === "hub" && current.memoryHub.memorySpaceId !== null
          ? Effect.succeed(current.memoryHub.memorySpaceId)
          : Effect.map(marker, (saved) => saved?.previousHubSpace ?? null),
      ),
      Effect.mapError(() => new MemoryHubError({ code: "storage_failed" })),
    ),
    apply: Effect.fn("MemoryHubAdminSettings.apply")(function* (
      record: Parameters<MemoryHubAdminSettings["Service"]["apply"]>[0],
      permit: Parameters<MemoryHubAdminSettings["Service"]["apply"]>[1],
    ) {
      if (!(yield* HubSettingsLock)) return yield* new MemoryHubError({ code: "storage_failed" });
      yield* permit;
      const current = yield* read.pipe(
        Effect.mapError(() => new MemoryHubError({ code: "storage_failed" })),
      );
      if (record.stage !== "activated")
        return yield* new MemoryHubError({ code: "bootstrap_required" });
      const action = record.action;
      let settings = current.memoryHub;
      if (action.action === "configure") {
        settings = action.settings;
        // The administrator supplies the space only after SQL publication commits.
        if (settings.mode === "hub" && settings.memorySpaceId === null)
          return yield* new MemoryHubError({ code: "bootstrap_required" });
      } else if (action.action === "installCredential") {
        if (!record.secretName) return yield* new MemoryHubError({ code: "bootstrap_required" });
        settings = {
          mode: "member",
          hubEnvironmentId: action.hubEnvironmentId,
          endpoint: action.endpoint,
          memorySpaceId: action.memorySpaceId,
          secretName: record.secretName,
        };
      }
      const view = yield* applyLocked(
        {
          requestId: record.requestId,
          expectedVersion: record.expectedVersion,
          settings,
          provenance:
            record.initialization === "auto-initialized" &&
            settings.mode === "hub" &&
            settings.memorySpaceId !== null
              ? { source: "auto-initialized", memorySpaceId: settings.memorySpaceId }
              : action.action === "configure" || action.action === "installCredential"
                ? null
                : (current.memoryHubProvenance ?? null),
        },
        permit,
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "ServerSettingsError"
            ? new MemoryHubError({ code: "storage_failed" })
            : error,
        ),
      );
      return { view };
    }),
  };
};
