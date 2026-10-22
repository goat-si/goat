import * as HomeRoute from "./OpenCodexRoute.ts";
import * as FileSystem from "effect/FileSystem";
/**
 * The server's provider diagnosis: refreshes a targeted instance's readiness
 * through the registry, then runs the read-only checks in ProviderDiagnosis.
 * Backs `goat_provider_diagnose`; the CLI runs the same checks in-process.
 *
 * @module provider/ProviderDiagnosisService
 */
import {
  resolveProjectProviderInstanceEnabled,
  type ProviderDiagnosisCheck,
  type ProviderDiagnoseInput,
  type ProviderDiagnoseResult,
  type ServerSettingsError,
} from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { DevinCloudCli } from "@goat/provider-devin-cloud/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { LIVE_DIAGNOSIS_DRIVERS, diagnoseProviders } from "./ProviderDiagnosis.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

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
  const projects = yield* ProjectStore.ProjectStoreV2;
  const host = yield* ProviderHost.ProviderHost;
  const path = yield* Path.Path;
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
      const result = yield* diagnoseProviders({ input, snapshots, checkedBy: "server" }).pipe(
        Effect.provideContext(context),
      );
      if (input.cwd === undefined) return result;
      const project = yield* projects
        .findActiveByWorkspaceRoot(path.resolve(input.cwd))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const settings = yield* host.settings.get;
      return {
        ...result,
        diagnoses: result.diagnoses.map((diagnosis) => {
          const permitted =
            Option.isSome(project) &&
            resolveProjectProviderInstanceEnabled(
              settings,
              project.value.projectId,
              diagnosis.instanceId,
            );
          const policy: ProviderDiagnosisCheck = {
            id: "project_provider",
            status: Option.isNone(project) ? "unknown" : permitted ? "pass" : "fail",
            summary: Option.isNone(project)
              ? "Project permission could not be verified."
              : permitted
                ? "Provider is enabled for this project."
                : "Provider is disabled for this project.",
            ...(permitted
              ? {}
              : {
                  reason: Option.isNone(project) ? ("not_checked" as const) : ("disabled" as const),
                }),
          };
          return {
            ...diagnosis,
            ready: diagnosis.ready && policy.status !== "fail",
            checks: [...diagnosis.checks, policy],
          };
        }),
      };
    }),
  });
});

export const layer = Layer.effect(ProviderDiagnosisService, make).pipe(
  Layer.provide(DevinCloudCli.layer),
);
