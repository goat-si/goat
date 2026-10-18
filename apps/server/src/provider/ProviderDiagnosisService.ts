import * as HomeRoute from "./OpenCodexRoute.ts";
import * as FileSystem from "effect/FileSystem";
/**
 * The server's provider diagnosis: refreshes a targeted instance's readiness
 * through the registry, then runs the read-only checks in ProviderDiagnosis.
 * Backs `goat_provider_diagnose`; the CLI runs the same checks in-process.
 *
 * @module provider/ProviderDiagnosisService
 */
import type {
  ProviderDiagnoseInput,
  ProviderDiagnoseResult,
  ServerSettingsError,
} from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { DevinCloudCli } from "@goat/provider-devin-cloud/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { LIVE_DIAGNOSIS_DRIVERS, diagnoseProviders } from "./ProviderDiagnosis.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

export class ProviderDiagnosisService extends Context.Service<
  ProviderDiagnosisService,
  {
    readonly diagnose: (
      input: ProviderDiagnoseInput,
    ) => Effect.Effect<ProviderDiagnoseResult, ServerSettingsError>;
  }
>()("goat/provider/ProviderDiagnosisService") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const context = yield* Effect.context<
    | HomeRoute.OpenCodexRoute
    | FileSystem.FileSystem
    | ProviderHost.ProviderHost
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
    | DevinCloudCli.DevinCloudCli
  >();
  return ProviderDiagnosisService.of({
    diagnose: Effect.fn("ProviderDiagnosisService.diagnose")(function* (input) {
      let snapshots = yield* registry.getProviders;
      const targeted =
        input.instanceId === undefined
          ? undefined
          : snapshots.find((snapshot) => snapshot.instanceId === input.instanceId);
      // Cloud drivers are probed live by the diagnosis itself; refresh only the others.
      if (targeted && !LIVE_DIAGNOSIS_DRIVERS.has(targeted.driver)) {
        snapshots = yield* registry.refreshInstance(targeted.instanceId);
      }
      return yield* diagnoseProviders({ input, snapshots, checkedBy: "server" }).pipe(
        Effect.provideContext(context),
      );
    }),
  });
});

export const layer = Layer.effect(ProviderDiagnosisService, make).pipe(
  Layer.provide(DevinCloudCli.layer),
);
