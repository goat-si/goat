import * as HomeRequests from "../../../provider/CodexHomeRequests.ts";
import {
  type EnvironmentAuthorizationError,
  OrchestratorMcpFailure,
  type ProviderHostSyncError,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as CloudAgents from "../../../cloudAgents/CloudAgentService.ts";
import * as Routing from "../../../provider/ProviderDiagnosisRouting.ts";
import * as HostSync from "../../../provider/ProviderHostSync.ts";
import * as Onboarding from "../../../provider/ProviderOnboarding.ts";
import * as ProviderSettings from "../../../provider/ProviderSettings.ts";
import { dispatchFacts } from "../../hostFailure.ts";
import * as McpInvocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProviderToolkit } from "./tools.ts";

const LEGACY_SYNC_CODES: Partial<
  Record<ProviderHostSyncError["code"], OrchestratorMcpFailure["code"]>
> = {
  not_found: "invalid_request",
  invalid_request: "invalid_request",
  declined: "conflict",
  expired: "conflict",
  cancelled: "conflict",
};

const toMcpFailure = (error: ProviderHostSyncError | EnvironmentAuthorizationError) =>
  error._tag === "EnvironmentAuthorizationError"
    ? new OrchestratorMcpFailure({ code: "capability_denied", message: error.message })
    : new OrchestratorMcpFailure({
        code: LEGACY_SYNC_CODES[error.code] ?? "orchestration_error",
        message: error.message,
        reason: error.code,
      });

const withHostSync = <A>(
  run: (
    service: HostSync.ProviderHostSync["Service"],
    caller: { readonly kind: "mcp"; readonly scope: McpInvocation.McpInvocationScope },
  ) => Effect.Effect<A, ProviderHostSyncError | EnvironmentAuthorizationError>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocation.McpInvocationContext;
    const service = yield* HostSync.ProviderHostSync;
    return yield* run(service, { kind: "mcp", scope }).pipe(Effect.mapError(toMcpFailure));
  });

const onboarding = <A>(
  run: (
    service: Onboarding.ProviderOnboarding["Service"],
    scope: McpInvocation.McpInvocationScope,
  ) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocation.McpInvocationContext;
    return yield* run(yield* Onboarding.ProviderOnboarding, scope);
  });

const cloud = <A>(
  run: (
    service: CloudAgents.CloudAgentServiceShape,
    scope: McpInvocation.McpInvocationScope,
  ) => Effect.Effect<A, OrchestratorMcpFailure>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocation.McpInvocationContext;
    return yield* run(yield* CloudAgents.CloudAgentService, scope);
  });

const manage = (request: ProviderSettings.ProviderSettingsRequest) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocation.McpInvocationContext;
    return yield* (yield* ProviderSettings.ProviderSettings).manage(request, scope);
  });

/**
 * Holder probing and the registration lock can wait, and the caller's modes can drop meanwhile,
 * so the full-access check runs again right before a thread starts, with the modes it finds.
 */
const modesAfter = <R>(
  check: Effect.Effect<{ readonly limits: CloudAgents.StartModes }, OrchestratorMcpFailure, R>,
) =>
  Effect.map(Effect.context<R>(), (context) =>
    check.pipe(
      Effect.map((caller) => caller.limits),
      Effect.provideContext(context),
    ),
  );

export const layer = McpToolAccess.toLayer(ProviderToolkit, {
  goat_provider_host_matrix: McpToolAccess.readsOrReachesHost(
    (input) => input.localOnly !== true,
    (input) => withHostSync((service, caller) => service.matrix(input, caller)),
  ),
  goat_provider_sync: McpToolAccess.writes((input) =>
    withHostSync((service, caller) => service.sync(input, caller)),
  ),
  goat_provider_sync_status: McpToolAccess.reads((input) =>
    withHostSync((service, caller) => service.status(input, caller)),
  ),
  goat_provider_sync_cancel: McpToolAccess.writes((input) =>
    withHostSync((service, caller) => service.cancel(input, caller)),
  ),
  goat_provider_addable_list: McpToolAccess.reads(() => onboarding((service) => service.list)),
  goat_provider_setup_open: McpToolAccess.writes((input) =>
    onboarding((service, scope) => service.setupOpen(input, scope)),
  ),
  goat_provider_login_start: McpToolAccess.writes((input) =>
    onboarding((service, scope) => service.loginStart(input, scope)),
  ),
  goat_provider_login_status: McpToolAccess.reads((input) =>
    onboarding((service, scope) => service.loginStatus(input, scope)),
  ),
  goat_provider_login_cancel: McpToolAccess.writes((input) =>
    onboarding((service, scope) => service.loginCancel(input, scope)),
  ),
  // The service decides between applying and asking a person, so these need no thread control.
  goat_provider_update: McpToolAccess.writesWithCapability((input) =>
    manage({ action: "update", input }),
  ),
  goat_provider_add: McpToolAccess.writesWithCapability((input) =>
    manage({ action: "add", input }),
  ),
  goat_provider_link: McpToolAccess.writesWithCapability((input) =>
    manage({ action: "link", input }),
  ),
  goat_provider_remove: McpToolAccess.destructive(
    McpToolAccess.writesWithCapability((input) => manage({ action: "remove", input })),
  ),
  goat_cloud_holders: McpToolAccess.readsOrReachesHost(
    (input) => input.local !== true,
    (input) => cloud((service, scope) => service.holders(scope, input)),
  ),
  goat_cloud_launch: McpToolAccess.writesEnvironment((input, check) =>
    Effect.flatMap(modesAfter(check), (modes) =>
      cloud((service, scope) => service.launch(scope, input, modes)),
    ),
  ),
  goat_cloud_run_register: McpToolAccess.writesEnvironment((input, check) =>
    Effect.flatMap(modesAfter(check), (modes) =>
      cloud((service, scope) => service.register(scope, input, modes)),
    ),
  ),
  goat_cloud_run_list: McpToolAccess.reads((input) => cloud((service) => service.list(input))),
  goat_cloud_run_forget: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input) => cloud((service) => service.forget(input))),
  ),
  goat_provider_home_request: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocation.McpInvocationContext;
      const requests = yield* HomeRequests.CodexHomeRequests;
      return yield* requests.request(input, scope);
    }),
  ),
  goat_provider_diagnose: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocation.McpInvocationContext;
      const routing = yield* Routing.ProviderDiagnosisRouting;
      const settings = yield* ProviderSettings.ProviderSettings;
      const result = yield* routing.diagnose(input, { kind: "mcp", scope }).pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestratorMcpFailure"
            ? error
            : error._tag === "EnvironmentAuthorizationError"
              ? new OrchestratorMcpFailure({ code: "capability_denied", message: error.message })
              : new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                  ...dispatchFacts(error),
                }),
        ),
      );
      return yield* settings.presentDiagnosis(result, scope);
    }),
  ),
});
