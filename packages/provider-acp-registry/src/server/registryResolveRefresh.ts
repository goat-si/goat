import * as Effect from "effect/Effect";
import type {
  AcpRegistryCatalog,
  AcpRegistryError,
  AcpRegistryIndex,
  ResolvedAcpRegistryAgent,
} from "./AcpRegistrySupport.ts";
import type { AcpRegistrySettings } from "../settings.ts";

type Options = { readonly allowInstall?: boolean; readonly spawnEnvironment?: NodeJS.ProcessEnv };
export const makeRegistryResolveWithRefresh = (input: {
  readonly loadRegistry: () => Effect.Effect<AcpRegistryIndex, AcpRegistryError>;
  readonly refreshRegistry: () => Effect.Effect<AcpRegistryIndex, AcpRegistryError>;
  readonly resolveOnce: (
    settings: AcpRegistrySettings,
    cwd: string,
    environment?: NodeJS.ProcessEnv,
    options?: Options,
    registry?: AcpRegistryIndex,
  ) => Effect.Effect<ResolvedAcpRegistryAgent, AcpRegistryError>;
}): AcpRegistryCatalog["Service"]["resolve"] =>
  Effect.fn("AcpRegistryCatalog.resolve")(function* (settings, cwd, environment, options) {
    if (settings.source === "local" || options?.allowInstall === false)
      return yield* input.resolveOnce(settings, cwd, environment, options);
    const registry = yield* input.loadRegistry();
    return yield* input.resolveOnce(settings, cwd, environment, options, registry).pipe(
      Effect.catchIf(
        (error) => error.reason === "download_failed",
        (error) =>
          Effect.gen(function* () {
            const latest = yield* input.refreshRegistry().pipe(Effect.mapError(() => error));
            const id = settings.agentId.trim();
            if (
              latest.agents.find((agent) => agent.id === id)?.version ===
              registry.agents.find((agent) => agent.id === id)?.version
            )
              return yield* error;
            return yield* input.resolveOnce(settings, cwd, environment, options, latest);
          }),
      ),
    );
  });
